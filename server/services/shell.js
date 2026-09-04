import * as pty from 'node-pty';
import os from 'os';
import { basename } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { scheduleSubmitEnters, SUBMIT_KEY } from '../lib/tuiHandshake.js';
import { buildCdCommand } from '../lib/shellCd.js';
import { resolveInteractiveShell } from '../lib/interactiveShellResolver.js';
import { buildRunThenExitCommand } from '../lib/shellExit.js';
import { buildReadinessProbe } from '../lib/shellReadinessProbe.js';
import { prepareCliSpawn } from '../lib/bufferedSpawn.js';
import { findCommandOnPath } from '../lib/processEnv.js';

// Store active shell sessions (persist across socket reconnects)
const shellSessions = new Map();

// Soft ceiling on concurrent user-spawned interactive shells. Each session is a
// single idle PTY (a few MB, one OS process), and the deployment is single-user
// on a private network — so this is a sanity bound against runaway tab-spamming,
// not a resource/abuse defense. External views (TUI runs) don't count.
const MAX_TOTAL_SESSIONS = 20;

// Re-exported so a session caller reaches the Enter byte without importing the
// TUI-handshake module directly. See lib/tuiHandshake.js for why it is CR.
export { SUBMIT_KEY };

// PTY event handlers run outside the Express middleware chain — uncaught throws here
// crash the Node process instead of bubbling to res.next. try/catch is therefore
// justified in this one spot despite the project-wide "no try/catch" convention.
// Async hooks are serialized per-session via hookQueue so interleaved awaits (e.g.
// agentTuiSpawning's handleData mutating module-level buffers) don't race.
function runHook(label, session, fn, arg) {
  if (!fn) return;
  session.hookQueue = session.hookQueue.then(() => {
    try {
      return Promise.resolve(fn(arg));
    } catch (err) {
      console.error(`🐚 ${label} sync error in ${session._id}: ${err.message}`);
    }
  }).catch(err => console.error(`🐚 ${label} async error in ${session._id}: ${err.message}`));
}

// Allowlist of safe environment variable prefixes to pass to PTY sessions
// Prevents leaking secrets (API keys, tokens) to the shell
const SAFE_ENV_PREFIXES = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_', 'TERM',
  'COLORTERM', 'EDITOR', 'VISUAL', 'HOSTNAME', 'PWD', 'OLDPWD', 'TMPDIR',
  'XDG_', 'SSH_AUTH_SOCK', 'DISPLAY', 'HOMEBREW_', 'NVM_', 'FNM_', 'NODE_',
  'NPM_', 'VOLTA_', 'GOPATH', 'GOROOT', 'CARGO_', 'RUSTUP_', 'PYENV_',
  'VIRTUAL_ENV', 'CONDA_', 'JAVA_HOME', 'ANDROID_', 'DOCKER_', 'COMPOSE_',
  'KUBECONFIG', 'LESS', 'PAGER', 'MANPATH', 'INFOPATH', 'ZDOTDIR', 'STARSHIP_'
];

// Windows-only additions, matched as EXACT names rather than prefixes. The list
// above is POSIX-shaped: on Windows it drops variables the OS itself needs to
// create a working process, so a PTY session started from it launches into a
// crippled shell (no DLL search root, no temp dir, no per-user app data — which
// is where `claude`/`codex` keep their credentials and config).
//
// Exact-match is load-bearing, not a style choice: these are individual OS
// variables, not grouped families like `NPM_`/`XDG_`, so prefix-matching them
// would admit anything merely STARTING with one — `APPDATA_TOKEN`,
// `TEMP_SECRET`, and (worst, since it is two characters) `OS_API_KEY` would all
// be handed to an attachable agent shell by a filter whose entire job is
// withholding credentials.
//
// PATHEXT / USERPROFILE / HOMEDRIVE / HOMEPATH are deliberately absent: the
// POSIX PATH / USER / HOME prefixes already cover them.
const SAFE_ENV_NAMES_WIN32 = new Set([
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'PROGRAMDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'TEMP', 'TMP',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PSMODULEPATH',
  // Windows spellings of variables the POSIX prefixes above cover only on
  // POSIX. They are listed here — rather than case-folding the POSIX prefix
  // list on Windows — because folding a PREFIX list widens it: `NPM_` would
  // then match npm's lower-case `npm_config__authToken` (a registry credential)
  // and hand it to an attachable agent shell. An exact-name Set can be matched
  // case-insensitively with no such reach.
  'PATH', 'PATHEXT',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE',
  'HOMEDRIVE', 'HOMEPATH'
]);

/**
 * Filter `process.env` down to the allowlist above.
 *
 * Two matching rules, deliberately different:
 *
 *   - `SAFE_ENV_PREFIXES` is matched **case-sensitively on both platforms**.
 *     These are grouped families, and folding case widens a prefix rather than
 *     preserving it: upper-casing keys would push npm's lower-case
 *     `npm_config_*` / `npm_package_*` vars — `npm_config__authToken` among
 *     them — through the `NPM_` prefix into an attachable shell. PortOS starts
 *     under `npm run`, so those variables are always present.
 *   - `SAFE_ENV_NAMES_WIN32` is matched **case-insensitively, on Windows only,
 *     as exact names**. Windows env names are case-insensitive and arrive in
 *     mixed case (the real variable is `Path`, not `PATH`), and an exact-name
 *     Set can be folded safely because it has no prefix reach.
 *
 * Before this split, `Path` was dropped entirely on Windows by the
 * case-sensitive `startsWith('PATH')` — the agent shell then couldn't resolve
 * any CLI provider — while the coincidentally-upper-case `PATHEXT` survived.
 *
 * Exported for tests; `platform` is injectable so the Windows branch is
 * testable from any host.
 *
 * @param {NodeJS.ProcessEnv} [env] - source environment; defaults to `process.env`
 * @param {string} [platform] - `process.platform` value; defaults to the real one
 * @returns {Record<string, string>} filtered environment
 */
export function buildSafeEnv(env = process.env, platform = process.platform) {
  const isWin32 = platform === 'win32';
  const safeEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const allowed = SAFE_ENV_PREFIXES.some(prefix => key.startsWith(prefix))
      || (isWin32 && SAFE_ENV_NAMES_WIN32.has(key.toUpperCase()));
    if (allowed) safeEnv[key] = value;
  }
  return safeEnv;
}

/**
 * The shell a session runs when the caller doesn't name one.
 */
function getDefaultShell() {
  return resolveInteractiveShell();
}

/**
 * True — and warns — when the service already holds its ceiling of PTYs it
 * spawned itself. Only ever called in the refusal position, so the log lives
 * here rather than being spelled out at each spawn entry point.
 *
 * Only sessions this service spawned count. External views (one-shot TUI runs
 * registered via registerExternalSession) are governed by their own runner and
 * must not consume a slot.
 */
function refusedForSessionCap() {
  let owned = 0;
  for (const session of shellSessions.values()) {
    if (!session.external) owned += 1;
  }
  if (owned < MAX_TOTAL_SESSIONS) return false;
  console.warn(`🐚 Max total sessions reached (${MAX_TOTAL_SESSIONS})`);
  return true;
}

// Every PTY this service opens is a 256-color terminal.
const TERM_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };

/**
 * The non-env half of the `pty.spawn` options both entry points use, so the
 * terminal name and the geometry defaults are stated once.
 *
 * `env` is deliberately NOT assembled here. Each caller wraps its own env in
 * `withSpawnCwdEnv` at its own `pty.spawn` call, which keeps the #3193 PWD pin
 * visible at every spawn site — and keeps `lib/spawnCwd.test.js` counting pins
 * one-for-one against spawns, instead of one shared pin covering both.
 */
function ptyTerminalOptions({ cwd, cols, rows }) {
  return {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd
  };
}

/**
 * Put a PTY in the session registry and wire its output (and, for a PTY this
 * service owns, its exit) — so every attachable session, however it was
 * started, has the same record shape and the same 50KB re-attach ring buffer.
 *
 * Three callers, differing only in the process behind the PTY:
 *   - `createShellSession` — an interactive login shell
 *   - `spawnCommandSession` — the launched command itself
 *   - `registerExternalSession` — a PTY spawned elsewhere (`external: true`)
 *
 * `shell` is the hosting shell binary, or `null` when the PTY *is* the launched
 * command. Everything that injects a command line into a session reads it (see
 * `changeSessionDirectory`), so a null value is the load-bearing signal that
 * there is no shell to type at.
 *
 * `external` sessions skip the exit wiring: their lifecycle belongs to whoever
 * spawned them, which ends the session through `unregisterExternalSession`.
 */
function adoptPtySession(sessionId, ptyProcess, options = {}) {
  // Buffer recent output for re-attach (last 50KB)
  const outputBuffer = [];
  let bufferSize = 0;
  const MAX_BUFFER = 50 * 1024;

  // Store session info
  shellSessions.set(sessionId, {
    _id: sessionId.slice(0, 8),
    hookQueue: Promise.resolve(),
    pty: ptyProcess,
    socket: options.socket || null,
    cwd: options.cwd || null,
    // The spawned shell binary — kept so cd-style commands injected later can be
    // written in the dialect this session actually speaks (see changeSessionDirectory).
    // Null for a direct command session: there is no shell reading those lines.
    shell: options.shell || null,
    createdAt: Date.now(),
    label: options.label || null,
    kind: options.kind || 'shell',
    agentId: options.agentId || null,
    command: options.command || null,
    onData: options.onData || null,
    onExit: options.onExit || null,
    // Keeps the session out of the interactive cap count and out of Shell's
    // auto-attach — you opt into watching a run by clicking its tab.
    ...(options.external ? { external: true } : {}),
    outputBuffer,
    bufferSize: () => bufferSize
  });

  // Handle pty output
  ptyProcess.onData((data) => {
    // Buffer output for re-attach
    outputBuffer.push(data);
    bufferSize += data.length;
    while (bufferSize > MAX_BUFFER && outputBuffer.length > 1) {
      bufferSize -= outputBuffer.shift().length;
    }
    const session = shellSessions.get(sessionId);
    session?.socket?.emit('shell:output', { sessionId, data });
    if (session) runHook('onData', session, session.onData, data);
  });

  // An external PTY's lifecycle belongs to whoever spawned it — it ends the
  // session through unregisterExternalSession — so registering an exit listener
  // here would delete the record out from under that owner.
  if (options.external) return;

  // Handle pty exit
  //
  // `signal` is forwarded, not discarded: on POSIX a shell killed by a signal
  // reports the wait-status exit code (0 for a plain SIGTERM/SIGHUP) with the
  // signal number in the separate `signal` field. Dropping it made a
  // pm2-treekilled agent shell indistinguishable from one that exited cleanly —
  // which is how an agent whose PTY was torn down got recorded as a successful
  // run (#3202). Consumers that care (the TUI spawner's onExit) MUST treat a
  // non-null `signal` as an abnormal end regardless of `exitCode`.
  ptyProcess.onExit(({ exitCode, signal }) => {
    console.log(`🐚 Shell session ${sessionId.slice(0, 8)} exited (code: ${exitCode}${signal ? `, signal: ${signal}` : ''})`);
    const session = shellSessions.get(sessionId);
    shellSessions.delete(sessionId);
    session?.socket?.emit('shell:exit', { sessionId, code: exitCode });
    if (session) runHook('onExit', session, session.onExit, { exitCode, signal: signal ?? null });
    broadcastSessionList();
  });
}

/**
 * Create a new shell session
 */
export function createShellSession(socket, options = {}) {
  if (refusedForSessionCap()) {
    socket?.emit?.('shell:error', { error: `Max ${MAX_TOTAL_SESSIONS} shell sessions. Kill an existing session first.` });
    return null;
  }

  const sessionId = uuidv4();
  const shell = options.shell || getDefaultShell();
  const cwd = options.cwd || os.homedir();

  console.log(`🐚 Creating shell session ${sessionId.slice(0, 8)} (${shell})`);

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      ...ptyTerminalOptions({ cwd, cols: options.cols, rows: options.rows }),
      // Pin PWD to the spawn cwd — see withSpawnCwdEnv (#3193). An interactive
      // login shell rewrites PWD itself at startup, but a non-login shell may
      // not, and an agent-TUI session injects its CLI command into this shell.
      env: withSpawnCwdEnv({
        // `options.env` is a DELTA here — this base is always unioned underneath
        // it. A caller that has already narrowed its environment to a strict
        // allowlist must use `spawnCommandSession` instead, which unions nothing
        // (and gets no rc file either — see its docstring).
        ...buildSafeEnv(), // filters process.env to prevent leaking inherited secrets (e.g. shell-inherited API keys)
        // options.env is the caller's explicit opt-in env (e.g. TUI provider API keys for codex/claude).
        // Callers are responsible for not passing vars they don't want visible inside attachable shells.
        // Single-user/single-instance deployment (Tailscale-only) makes this acceptable.
        ...(options.env || {}),
        ...TERM_ENV
      }, cwd)
    });
  } catch (err) {
    console.error(`❌ Failed to spawn PTY: ${err.message}`);
    socket?.emit?.('shell:error', { error: `Failed to spawn shell: ${err.message}` });
    return null;
  }

  adoptPtySession(sessionId, ptyProcess, { ...options, socket, cwd, shell });

  // Starting a fresh shell means the user moved on from whatever they were
  // viewing — release any TUI-run views they held so those runs resume normal
  // completion instead of staying paused for a tab they've left.
  releaseExternalViews(socket, sessionId);
  broadcastSessionList();
  if (options.initialCommand) {
    // `exitWithCommand` wraps the command so the shell dies with it, carrying its
    // status out (an agent-TUI shell exists only to host one CLI). Rendered HERE
    // rather than by the caller because only this function knows which shell the
    // session actually got, and the wrapper is dialect-specific — see
    // lib/shellExit.js. Same reason changeSessionDirectory renders its own `cd`.
    const initialCommand = options.exitWithCommand
      ? buildRunThenExitCommand(options.initialCommand, shell)
      : options.initialCommand;
    // onInitialCommandSent fires at the exact moment the command is injected,
    // regardless of which branch sent it. The agent-TUI spawner uses this to
    // start observing claude's input-readiness ONLY after the real command is
    // in flight — so the readiness probe's own shell activity (below) can't
    // prematurely satisfy its bracketed-paste gate.
    //
    // For the waitForPromptReady path, `sendInitial` runs from the probe's
    // `ptyProcess.onData` listener (below), registered AFTER the main output
    // listener above that dispatches `session.onData` via `runHook`/
    // `session.hookQueue`. node-pty invokes same-event listeners in
    // registration order, but `runHook` only QUEUES the caller's onData
    // handler as a microtask — it doesn't run it inline. So calling
    // `options.onInitialCommandSent?.()` synchronously here would fire it
    // BEFORE the caller's onData handler has actually processed the very
    // chunk that proved the probe round-tripped, even though that handler was
    // enqueued first. A consumer gating output on "has the command been
    // injected yet" (see agentTuiSpawning.js's commandInjected) would then
    // misread the probe's own echoed marker as post-injection output. Routing
    // this callback through the SAME `session.hookQueue` guarantees it runs
    // only after that chunk's onData handler has finished — while the actual
    // PTY write below stays synchronous/immediate, unaffected.
    const sendInitial = () => {
      const session = shellSessions.get(sessionId);
      if (session && options.onInitialCommandSent) {
        runHook('onInitialCommandSent', session, options.onInitialCommandSent);
      } else {
        options.onInitialCommandSent?.();
      }
      submitToSession(sessionId, initialCommand);
    };
    if (options.waitForPromptReady) {
      // Inject the command only once the shell can ACTUALLY run commands. A fixed
      // delay races a heavy interactive shell; a prompt-marker / settle-on-quiet
      // watch is fooled by powerlevel10k's *instant prompt*, which renders (and
      // enables bracketed-paste mode) BEFORE `.zshrc`/plugins/nvm finish — and a
      // slow mid-load quiet gap (nvm/plugins) trips a settle timer just as
      // easily, sending the command into a half-loaded shell where it's swallowed
      // when the real prompt redraws (the command sits echoed but unexecuted —
      // exactly the wedged `claude …` at a bare prompt users hit). Instead, PROVE
      // the shell is executing commands with a round-trip probe: print a unique
      // nonce and wait until we SEE it in the OUTPUT. The nonce is split in the
      // probe source (see buildReadinessProbe) so the command ECHO never contains
      // the assembled string — only the executed output matches, so a single
      // sighting is unambiguous. Instant-prompt keystroke buffering replays the
      // probe into the real shell, so this is theme-agnostic. A bounded fallback
      // still injects the command if the probe never round-trips (or the dialect
      // has none — cmd.exe, see buildReadinessProbe).
      let sent = false;
      let sub = null;
      let exitSub = null;
      const nonce = uuidv4().replace(/-/g, '').slice(0, 12);
      const marker = `PORTOSRDY${nonce}`;
      const probe = buildReadinessProbe(nonce, shell);
      let seen = '';
      // Tear down every pending timer + listener. Called both on success
      // (fire) and when the PTY exits before the probe round-trips, so no
      // timer survives to fire into a dead session.
      const stop = () => {
        clearTimeout(probeTimer);
        clearTimeout(fallback);
        sub?.dispose?.();
        exitSub?.dispose?.();
      };
      const fire = () => {
        if (sent) return;
        sent = true;
        stop();
        sendInitial();
      };
      // No probe for this dialect (cmd.exe, probe === null) — the guard inside
      // each callback below is a no-op and the fallback timer alone injects the
      // command, same as a probe that never round-trips.
      sub = ptyProcess.onData((chunk) => {
        if (!probe) return;
        seen += chunk;
        if (seen.length > 8192) seen = seen.slice(-8192);
        if (seen.includes(marker)) fire();
      });
      // If the shell dies before the probe round-trips, cancel the pending
      // writes/timers — sent stays true so the fallback can't resurrect a
      // send into the gone session.
      exitSub = ptyProcess.onExit(() => { sent = true; stop(); });
      // Give the freshly-spawned PTY a tick to come up, then send the probe.
      // Writing earlier is harmless (zsh's line editor / p10k instant-prompt
      // buffer holds it until the prompt is live and replays it), but a small
      // delay avoids racing node-pty's own spawn handshake.
      const probeTimer = setTimeout(() => { if (probe && !sent) submitToSession(sessionId, probe); }, 50);
      const fallback = setTimeout(fire, options.initialCommandDelayMs ?? 8000);
    } else {
      setTimeout(sendInitial, options.initialCommandDelayMs ?? 200);
    }
  }
  return sessionId;
}

/**
 * Spawn `command` AS the PTY — no hosting shell — and register it as an
 * ordinary attachable session.
 *
 * Why this exists next to `createShellSession`: that function's PTY is an
 * interactive login shell into which a command is later typed, so the
 * operator's own rc file (`.zshrc`, `.bash_profile`, …) runs BEFORE the command
 * and can re-export anything it likes. For a public-content review stage whose
 * whole posture is a strict environment allowlist, that rc file is a hole no
 * allowlist can close (#6159). Here the launched binary is the PTY's own
 * process, so `env` is exactly what the child gets.
 *
 * `env` is the COMPLETE environment, not a delta: nothing is unioned underneath
 * it (`buildSafeEnv` is deliberately not consulted), because the callers that
 * need this have already narrowed the environment themselves.
 *
 * Ordinary agent TUI sessions keep the login shell — the operator's rc file is
 * a feature there, not a leak — so this is not a drop-in replacement for
 * `createShellSession`.
 *
 * Unlike `createShellSession`, every failure here THROWS rather than returning
 * null. The caller is a spawner that records a cause on the agent record, and a
 * bare null would make "the binary isn't installed" and "the session cap is
 * full" indistinguishable — both then get filed as a generic host problem.
 *
 * @param {string} command - the binary to run (bare name or path)
 * @param {string[]} [args]
 * @param {object} [options] - { cwd, env, cols, rows, label, kind, agentId, command, onData, onExit }
 * @returns {string} sessionId
 * @throws when the session cap is reached, the command is not on the child's
 *   PATH, or the PTY will not open
 */
export function spawnCommandSession(command, args = [], options = {}) {
  if (refusedForSessionCap()) {
    throw new Error(`Max ${MAX_TOTAL_SESSIONS} shell sessions are already open; kill one before starting another`);
  }

  const sessionId = uuidv4();
  const cwd = options.cwd || os.homedir();
  // No buildSafeEnv union — see the docstring. The caller owns this env whole.
  // PWD is still pinned to the spawn cwd (#3193): a directly-launched CLI reads
  // it (OpenCode resolves its project root from it) and no shell will fix it up.
  const childEnv = withSpawnCwdEnv({ ...(options.env || {}), ...TERM_ENV }, cwd);

  // Resolve the executable BEFORE spawning. A PTY has no shell to print
  // "command not found": on POSIX node-pty forks and `execvp` fails in the
  // child, which exits 1 with an EMPTY screen, so an output-driven probe can
  // never see it and the run finalizes as a bare exit-1 with no cause. Resolve
  // against the CHILD's PATH — a caller's env may replace PATH with only the
  // provider's own bin dir. Same pre-flight `tuiPromptRunner` and the CoS
  // runner's `/spawn-tui` do; `basename` keeps the resolved path, which can
  // embed the local account name, out of the message.
  const executable = findCommandOnPath(command, { env: childEnv, cwd });
  if (!executable) {
    throw new Error(`Command executable unavailable: ${basename(command)} is not on the PATH for this session. Install it or update the configured command.`);
  }
  // Launch the path the pre-flight actually RESOLVED, not the bare name — the
  // CoS runner's /spawn-tui does the same, and for the same reason. The two
  // resolvers do not agree on Windows: `findCommandOnPath` unquotes a PATH
  // entry, maps an empty one to cwd, resolves relative entries, and searches
  // all of PATHEXT, while `prepareCliSpawn`'s own lookup does none of that. Re-
  // resolving the bare name could therefore fall through to a bare
  // extensionless `claude`, which ConPTY cannot launch — a blank PTY and a bare
  // exit-1, the exact failure this pre-flight exists to prevent.
  //
  // prepareCliSpawn still runs: a resolved `.cmd`/`.bat` shim must launch
  // through cmd.exe (never the user's shell — that wrapper runs no profile),
  // and it owns the shared argument-escaping contract. On POSIX it is a no-op
  // and the binary is spawned directly.
  const { command: ptyCommand, args: ptyArgs } = prepareCliSpawn(executable, args, childEnv);

  console.log(`🐚 Creating command session ${sessionId.slice(0, 8)} (${basename(command)})`);
  const ptyProcess = pty.spawn(ptyCommand, ptyArgs, {
    ...ptyTerminalOptions({ cwd, cols: options.cols, rows: options.rows }),
    env: childEnv
  });

  adoptPtySession(sessionId, ptyProcess, { ...options, cwd, shell: null });
  broadcastSessionList();
  return sessionId;
}

/**
 * A socket can stay bound to multiple sessions (the registry allows it), but a
 * user views one at a time. `isExternalSessionAttached` keys off socket binding,
 * so without this a TUI run stays "watched" (and its completion stays paused)
 * after the user switches to another tab. When a socket starts viewing a
 * different session, drop its binding to any OTHER external (TUI-run) view so
 * that run resumes normal completion handling. Interactive shells keep their
 * lingering binding (the registry's one-socket-many-shells model is unchanged).
 */
function releaseExternalViews(socket, exceptId = null) {
  if (!socket) return;
  for (const [id, session] of shellSessions.entries()) {
    if (session.external && session.socket === socket && id !== exceptId) {
      session.socket = null;
    }
  }
}

/**
 * Register a PTY spawned OUTSIDE this service (one-shot TUI runs in
 * `lib/tuiPromptRunner.js`) as an attachable session so it shows up in the Shell
 * UI where the user can watch its live output AND interact with it — type
 * corrections, answer questions the model is waiting on, or interrupt it.
 *
 * Why this exists separately from createShellSession:
 *   - The TUI runner deliberately spawns its own PTY (it bypasses the session
 *     cap and the login-shell wrapper — see tuiPromptRunner.js's header). This
 *     helper only *surfaces* that already-running PTY; it does not spawn one.
 *   - `external: true` keeps it out of the interactive-session cap count and out
 *     of Shell's auto-attach (you opt into watching a run by clicking its tab).
 *
 * Input and resize are NOT blocked — these views are fully interactive. To keep
 * a run from being killed out from under an engaged human, the runner pauses its
 * idle-completion and hard-timeout while a viewer is attached (see
 * `isExternalSessionAttached` + tuiPromptRunner's completion watch).
 *
 * node-pty fans `onData` out to every registered listener, so the listener we
 * add here streams to the Shell viewer without disturbing the runner's own
 * output capture. Lifecycle is owned by the runner: it calls
 * unregisterExternalSession from its single finish() funnel when the run ends.
 *
 * @param {string} sessionId — typically the runId, so the Shell view correlates
 *   with the /runs record.
 * @param {object} ptyProcess — the live node-pty IPty.
 * @param {object} [options] — { label, command, cwd, kind, agentId }.
 * @returns {string} sessionId (idempotent — returns the id if already registered).
 */
export function registerExternalSession(sessionId, ptyProcess, options = {}) {
  if (shellSessions.has(sessionId)) return sessionId;

  // Same record and same 50KB re-attach ring buffer every other session gets, so
  // a viewer who opens the run mid-stream sees the recent screen state — the
  // only differences are `external` and that the exit wiring stays with the
  // owner (see adoptPtySession).
  adoptPtySession(sessionId, ptyProcess, {
    ...options,
    kind: options.kind || 'tui-run',
    external: true,
    // The PTY is not ours to type a command line into, and its hooks belong to
    // the process that spawned it.
    shell: null,
    onData: null,
    onExit: null
  });

  console.log(`🐚 Registered external TUI session ${sessionId.slice(0, 8)} (${options.label || options.command || 'tui'})`);
  broadcastSessionList();
  return sessionId;
}

/**
 * Remove an external session from the registry and notify any attached viewer
 * that the run finished. Idempotent and external-only — a no-op if the id is
 * unknown or belongs to an interactive shell (those clean up via PTY onExit).
 */
export function unregisterExternalSession(sessionId, { exitCode = 0 } = {}) {
  const session = shellSessions.get(sessionId);
  if (!session || !session.external) return false;
  shellSessions.delete(sessionId);
  session.socket?.emit('shell:exit', { sessionId, code: exitCode });
  broadcastSessionList();
  return true;
}

/**
 * True when an external (TUI-run) session exists and a Shell viewer is currently
 * attached to it. The runner consults this to pause auto-completion/timeout while
 * a human is watching, so the run isn't killed mid-interaction.
 */
export function isExternalSessionAttached(sessionId) {
  const session = shellSessions.get(sessionId);
  return !!(session && session.external && session.socket);
}

/**
 * Public "stopped viewing" signal — the client emits this when it leaves the
 * Shell page (the SocketProvider socket persists across navigations, so a plain
 * disconnect doesn't fire). Releases every external (TUI-run) view bound to this
 * socket so those runs resume normal idle completion instead of staying paused
 * for a page the user has navigated away from. Tab-switching already releases via
 * attach/create; this covers navigating away from /shell entirely.
 */
export function releaseExternalViewsForSocket(socket) {
  if (!socket) return;
  const held = [...shellSessions.values()].some(s => s.external && s.socket === socket);
  releaseExternalViews(socket);
  if (held) broadcastSessionList();
}

/**
 * Attach an existing session to a new socket
 *
 * A shell session has a single attached socket — PTY output is fanned to that one
 * socket only (see ptyProcess.onData). When a deep link is opened in a second tab,
 * the new socket takes over and the previous tab would otherwise sit "Connected"
 * with no output. Emit shell:detached on the prior socket so it can clear its
 * local state instead of silently losing the stream.
 *
 * `claim` — when true, the attach refuses to displace a different socket. Used by
 * client-side auto-pick paths so concurrent broadcasts to two idle tabs don't
 * end up with both tabs racing to attach the same survivor (and one tab's win
 * displacing the other via shell:detached). User-initiated attaches default to
 * claim=false (takeover semantics — explicit intent wins).
 */
export function attachSession(sessionId, socket, { claim = false } = {}) {
  const session = shellSessions.get(sessionId);
  if (!session) return null;
  const prevSocket = session.socket;
  if (claim && prevSocket && prevSocket !== socket) {
    // Auto-pick lost the race to a different socket. Caller can fall back to
    // another survivor or give up and stay at /shell.
    return { claimRejected: true };
  }
  if (prevSocket && prevSocket !== socket) {
    prevSocket.emit('shell:detached', { sessionId, reason: 'attached-elsewhere' });
  }
  session.socket = socket;
  // Switching view releases any TUI-run this socket was watching, so that run
  // resumes normal completion rather than staying paused for a tab left behind.
  releaseExternalViews(socket, sessionId);
  console.log(`🐚 Attached session ${sessionId.slice(0, 8)} to socket ${socket.id}`);
  // Broadcast so other clients pick up the new `attached: true` state and skip
  // this session in their auto-pick flow.
  broadcastSessionList();
  return {
    sessionId,
    bufferedOutput: session.outputBuffer.join('')
  };
}

// Subscribers for session list broadcasts
const sessionListSubscribers = new Set();

export function subscribeSessionList(socket) {
  sessionListSubscribers.add(socket);
}

export function unsubscribeSessionList(socket) {
  sessionListSubscribers.delete(socket);
}

function broadcastSessionList() {
  // Each subscriber gets a recipient-relative list so `attached` reflects "attached
  // to a different tab" from that subscriber's POV. See listAllSessions().
  for (const sock of sessionListSubscribers) {
    sock.emit('shell:sessions', listAllSessions(sock));
  }
}

/**
 * List all active sessions with metadata
 *
 * When `forSocket` is provided, `attached` is recipient-relative: TRUE only if the
 * session is bound to a DIFFERENT socket than the recipient. Sessions bound to the
 * recipient's own socket — or unbound — report `attached: false`. This lets clients
 * use `attached` as a "don't auto-pick this, it belongs to someone else" signal
 * without accidentally filtering out their own live sessions when they return to
 * the page (the SocketProvider singleton keeps the socket alive across navigations,
 * so sessions opened earlier in this tab stay bound to it).
 *
 * Omitting `forSocket` returns the globally-attached view (used only by callers
 * that don't have a recipient context — currently none in PortOS).
 */
export function listAllSessions(forSocket = null) {
  const sessions = [];
  for (const [sessionId, session] of shellSessions.entries()) {
    sessions.push({
      sessionId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      label: session.label,
      kind: session.kind,
      agentId: session.agentId,
      command: session.command,
      external: !!session.external,
      attached: forSocket
        ? (!!session.socket && session.socket !== forSocket)
        : !!session.socket
    });
  }
  return sessions;
}

export function getSession(sessionId) {
  return shellSessions.get(sessionId) || null;
}

export function getSessionProcess(sessionId) {
  return shellSessions.get(sessionId)?.pty || null;
}

/**
 * Write input to a shell session
 */
export function writeToSession(sessionId, data) {
  const session = shellSessions.get(sessionId);
  if (session) {
    session.lastInputAt = Date.now();
    session.inputRevision = (session.inputRevision || 0) + 1;
    session.pty.write(data);
    return true;
  }
  return false;
}

/**
 * Type a command line into a session and press Enter.
 *
 * Every "inject a command the user didn't type" path goes through here so the
 * terminator is decided once — see SUBMIT_KEY for why it isn't a newline.
 *
 * @param {string} sessionId
 * @param {string} line - command line, WITHOUT a trailing terminator
 * @returns {boolean} false when the session is unknown
 */
export function submitToSession(sessionId, line) {
  return writeToSession(sessionId, `${line}${SUBMIT_KEY}`);
}

/**
 * Change a session's working directory.
 *
 * Goes through the service rather than the client emitting its own `cd` string,
 * because only the server knows which shell this PTY is running — and the command
 * differs per shell. See lib/shellCd.js for why.
 *
 * Updates `session.cwd` on success — see the body for why that is optimistic.
 *
 * @param {string} sessionId
 * @param {string} dirPath
 * @returns {boolean} false when the session is unknown, or has no hosting shell
 */
export function changeSessionDirectory(sessionId, dirPath) {
  const session = shellSessions.get(sessionId);
  if (!session) return false;
  // A session with no hosting shell — an external (TUI-run) view, or a direct
  // `spawnCommandSession` PTY — has nothing reading that line: the bytes land in
  // the agent as typed text and the trailing Enter posts them as a message. Refuse
  // rather than type into someone else's run — socket.js turns this into an error the
  // Shell page shows. Its `cwd` also stays pinned to the repo the RUN was spawned in,
  // which is what workspaceContext groups runs by.
  if (session.external || !session.shell) return false;
  if (!submitToSession(sessionId, buildCdCommand(dirPath, session.shell))) return false;
  // Track the cd optimistically so the Shell tab label and the Workspace Contexts
  // widget follow the session instead of staying pinned to its spawn directory.
  // `cwd` is display-only after spawn — nothing functional reads it — and the paths
  // come from the managed-apps list, so they exist. Asking the PTY for its REAL cwd
  // would need a per-platform probe plus a round-trip, which is not worth it for a
  // label; a rejected path just leaves the label wrong until the next cd.
  session.cwd = dirPath;
  broadcastSessionList();
  return true;
}

/**
 * Deliver `text` to a session as a SINGLE bracketed-paste event, then submit it.
 *
 * This is how you hand a message to a live agent TUI rather than to a shell:
 * Claude Code reads `ESC[200~…ESC[201~` as one paste, so a multi-line message
 * lands as one input event instead of N submits.
 *
 * The returned interval handle lets lifecycle-aware callers cancel pending
 * submission retries. The helper self-cancels when the session disappears,
 * newer input arrives, or its attempt budget is spent.
 *
 * @param {string} sessionId
 * @param {string} text - paste payload (no trailing newline; the Enter submits it)
 * @param {object} [opts]
 * @param {string} [opts.label='paste'] - log label for the submit-Enter failure path
 * @returns {ReturnType<typeof setInterval>|false} false when the session is unknown
 */
export function pasteToSession(sessionId, text, { label = 'paste' } = {}) {
  if (!writeToSession(sessionId, `\x1b[200~${text}\x1b[201~`)) return false;
  const session = shellSessions.get(sessionId);
  let expectedInputRevision = session.inputRevision;
  const writeEnter = () => {
    try {
      writeToSession(sessionId, SUBMIT_KEY);
      expectedInputRevision = session.inputRevision;
    } catch (err) {
      // Timer callbacks run outside the request lifecycle, and a write to a
      // live-but-broken PTY can throw.
      console.error(`🐚 ${label} submit Enter failed for ${sessionId.slice(0, 8)}: ${err.message}`);
    }
  };
  return scheduleSubmitEnters(
    writeEnter,
    () => !shellSessions.has(sessionId) || session.inputRevision !== expectedInputRevision,
  );
}

/**
 * When input was last written to this session (human paste/keystrokes via
 * `shell:input`, or an internal writer like the CoS agent's auto-paste) — or
 * `null` if none yet. Unlike a socket-attached check, this recency naturally
 * expires once nobody is actually interacting, so it can't get stuck forever
 * the way "is a socket bound" can for a regular (non-external) session whose
 * viewer navigated away without disconnecting.
 */
export function getLastInputAt(sessionId) {
  return shellSessions.get(sessionId)?.lastInputAt || null;
}

/**
 * Resize a shell session
 */
export function resizeSession(sessionId, cols, rows) {
  const session = shellSessions.get(sessionId);
  if (session) {
    session.pty.resize(cols, rows);
    return true;
  }
  return false;
}

/**
 * Kill a shell session
 */
export function killSession(sessionId) {
  const session = shellSessions.get(sessionId);
  if (session) {
    console.log(`🐚 Killing shell session ${sessionId.slice(0, 8)}`);
    session.pty.kill();
    shellSessions.delete(sessionId);
    runHook('onExit', session, session.onExit, { exitCode: null, killed: true });
    broadcastSessionList();
    return true;
  }
  return false;
}

/**
 * Detach all sessions from a socket (on disconnect) — sessions stay alive
 */
export function detachSocketSessions(socket) {
  let count = 0;
  for (const [, session] of shellSessions.entries()) {
    if (session.socket === socket) {
      session.socket = null;
      count++;
    }
  }
  unsubscribeSessionList(socket);
  // Broadcast so other tabs see the freed `attached: false` state and can adopt
  // these orphaned sessions in their auto-pick flow.
  if (count > 0) broadcastSessionList();
  return count;
}

/**
 * Get session count
 */
export function getSessionCount() {
  return shellSessions.size;
}
