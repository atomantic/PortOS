import { prepareWindowsAgentLaunch, watchWindowsAgentProcess } from '../lib/windowsAgentProcess.js';
import * as pty from 'node-pty';
import os from 'os';
import { basename } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { scheduleSubmitEnters, SUBMIT_KEY } from '../lib/tuiHandshake.js';
import { buildCdCommand, detectShellFlavor } from '../lib/shellCd.js';
import { resolveInteractiveShell } from '../lib/interactiveShellResolver.js';
import { buildRunThenExitCommand } from '../lib/shellExit.js';
import { buildReadinessProbe } from '../lib/shellReadinessProbe.js';
import { prepareCliSpawn } from '../lib/bufferedSpawn.js';
import { createReplayBuffer } from '../lib/terminalReplay.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { MAX_TOTAL_SESSIONS } from '../lib/shellLimits.js';

// Store active shell sessions (persist across socket reconnects)
const shellSessions = new Map();

// Re-exported so a session caller reaches the Enter byte without importing the
// TUI-handshake module directly. See lib/tuiHandshake.js for why it is CR.
export { SUBMIT_KEY };

// PTY event handlers run outside the Express chain: an uncaught throw crashes Node, so
// try/catch is justified here despite the project-wide convention. Async hooks are
// serialized per session via hookQueue so interleaved awaits don't race on shared buffers.
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

// Allowlist of safe env var prefixes for PTY sessions; keeps secrets (API keys, tokens) out of the shell.
const SAFE_ENV_PREFIXES = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_', 'TERM',
  'COLORTERM', 'EDITOR', 'VISUAL', 'HOSTNAME', 'PWD', 'OLDPWD', 'TMPDIR',
  'XDG_', 'SSH_AUTH_SOCK', 'DISPLAY', 'HOMEBREW_', 'NVM_', 'FNM_', 'NODE_',
  'NPM_', 'VOLTA_', 'GOPATH', 'GOROOT', 'CARGO_', 'RUSTUP_', 'PYENV_',
  'VIRTUAL_ENV', 'CONDA_', 'JAVA_HOME', 'ANDROID_', 'DOCKER_', 'COMPOSE_',
  'KUBECONFIG', 'LESS', 'PAGER', 'MANPATH', 'INFOPATH', 'ZDOTDIR', 'STARSHIP_'
];

// Windows-only additions, matched as EXACT names, not prefixes. The POSIX list above drops
// variables Windows needs for a working process (DLL search root, temp dir, per-user app data
// where `claude`/`codex` keep credentials). Prefix-matching would admit `APPDATA_TOKEN`,
// `OS_API_KEY` and the like. PATHEXT / USERPROFILE / HOMEDRIVE / HOMEPATH are absent: the
// POSIX PATH / USER / HOME prefixes already cover them.
const SAFE_ENV_NAMES_WIN32 = new Set([
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC',
  'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432',
  'PROGRAMDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'TEMP', 'TMP',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'PSMODULEPATH',
  // Windows spellings of variables the POSIX prefixes cover only on POSIX. Kept as an exact-name
  // Set rather than case-folding the prefix list, which would widen `NPM_` to match npm's
  // lower-case `npm_config__authToken` registry credential.
  'PATH', 'PATHEXT',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'USERDOMAIN_ROAMINGPROFILE',
  'HOMEDRIVE', 'HOMEPATH'
]);

/**
 * Filter `process.env` down to the allowlist above.
 *
 *   - `SAFE_ENV_PREFIXES` is matched **case-sensitively on both platforms**:
 *     folding case widens a prefix (npm's lower-case `npm_config__authToken`
 *     would pass `NPM_`), and PortOS starts under `npm run`.
 *   - `SAFE_ENV_NAMES_WIN32` is matched **case-insensitively, on Windows only,
 *     as exact names**: Windows env names arrive in mixed case (`Path`), and an
 *     exact-name Set has no prefix reach.
 *
 * Exported for tests; `platform` is injectable so the Windows branch is testable anywhere.
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
 * spawned itself. Only called in the refusal position, so the log lives here.
 * External views (registerExternalSession) are governed by their own runner and
 * don't consume a slot.
 */
function refusedForSessionCap() {
  let owned = 0;
  for (const session of shellSessions.values()) {
    if (!session.external) owned += 1;
  }
  if (owned < MAX_TOTAL_SESSIONS) return false;
  console.log(`🐚 Max total sessions reached (${MAX_TOTAL_SESSIONS})`);
  return true;
}

// Every PTY this service opens is a 256-color terminal.
const TERM_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };

/**
 * The non-env half of the `pty.spawn` options both entry points use. `env` is NOT
 * assembled here: each caller wraps its own in `withSpawnCwdEnv` at its spawn call,
 * keeping the #3193 PWD pin visible and `server/test/guards/runtime/spawnCwd.test.js` counting pins
 * one-for-one against spawns.
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
 * service owns, its exit), so every attachable session has the same record shape
 * and 50KB re-attach ring buffer.
 *
 * Callers: `createShellSession` (interactive login shell), `spawnCommandSession`
 * (the launched command itself), `registerExternalSession` (`external: true`).
 *
 * `shell` is the hosting shell binary, or `null` when the PTY *is* the launched
 * command; a null value is the signal that there is no shell to type at (see
 * `changeSessionDirectory`). `external` sessions skip the exit wiring: their owner
 * ends them through `unregisterExternalSession`.
 */
function adoptPtySession(sessionId, ptyProcess, options = {}) {
  // Recent output replayed to a late attacher; see lib/terminalReplay.js.
  const replay = createReplayBuffer();

  // Store session info
  shellSessions.set(sessionId, {
    _id: sessionId.slice(0, 8),
    hookQueue: Promise.resolve(),
    pty: ptyProcess,
    socket: options.socket || null,
    cwd: options.cwd || null,
    // The hosting shell binary, so injected cd-style commands use its dialect; null for a direct command session.
    shell: options.shell || null,
    createdAt: Date.now(),
    label: options.label || null,
    kind: options.kind || 'shell',
    agentId: options.agentId || null,
    command: options.command || null,
    ...(options.executionOptions ? { executionOptions: options.executionOptions } : {}),
    onData: options.onData || null,
    onExit: options.onExit || null,
    // Out of the interactive cap count and Shell's auto-attach.
    ...(options.external ? { external: true } : {}),
    replay
  });

  // Handle pty output
  ptyProcess.onData((data) => {
    replay.push(data);
    const session = shellSessions.get(sessionId);
    session?.socket?.emit('shell:output', { sessionId, data });
    if (session) runHook('onData', session, session.onData, data);
  });

  // An external PTY's owner ends the session via unregisterExternalSession; an exit listener here would delete its record.
  if (options.external) return;

  // Handle pty exit. `signal` is forwarded: on POSIX a signal-killed shell reports exit code 0
  // with the signal in a separate field, so dropping it recorded a pm2-treekilled agent as a
  // successful run (#3202). Consumers (the TUI spawner's onExit) MUST treat a non-null
  // `signal` as an abnormal end regardless of `exitCode`.
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
  // Windows PowerShell can discard a bracketed startup cwd as a wildcard; honor it after profiles load.
  const shellArgs = options.cwd && detectShellFlavor(shell) === 'powershell'
    ? ['-NoExit', '-Command', buildCdCommand(cwd, shell)]
    : [];

  console.log(`🐚 Creating shell session ${sessionId.slice(0, 8)} (${shell})`);

  let ptyProcess;
  try {
    // Pin PWD to the spawn cwd; a non-login shell may not rewrite it.
    const childEnv = withSpawnCwdEnv({
      // `options.env` is a DELTA unioned over this base. A caller that narrowed its environment
      // to a strict allowlist must use `spawnCommandSession`, which unions nothing.
      ...buildSafeEnv(), // filters process.env to prevent leaking inherited secrets (e.g. shell-inherited API keys)
      // options.env is the caller's explicit opt-in env (e.g. TUI provider API keys); callers must not
      // pass vars they don't want visible in attachable shells. Acceptable for a Tailscale-only deployment.
      ...(options.env || {}),
      ...TERM_ENV
    }, cwd);
    const launch = prepareWindowsAgentLaunch(options.agentId, shell, shellArgs, { cwd, env: childEnv, pty: true });
    ptyProcess = pty.spawn(launch.command, launch.args, {
      ...ptyTerminalOptions({ cwd, cols: options.cols, rows: options.rows }),
      env: childEnv
    });
    watchWindowsAgentProcess(ptyProcess, launch);
  } catch (err) {
    console.error(`❌ Failed to spawn PTY: ${err.message}`);
    socket?.emit?.('shell:error', { error: `Failed to spawn shell: ${err.message}` });
    return null;
  }

  adoptPtySession(sessionId, ptyProcess, { ...options, socket, cwd, shell });

  // A fresh shell means the user moved on: release held TUI-run views so those runs resume completion.
  releaseExternalViews(socket, sessionId);
  broadcastSessionList();
  if (options.initialCommand) {
    // `exitWithCommand` wraps the command so the shell dies with it, carrying its status out.
    // Rendered here because only this function knows which shell the session got (lib/shellExit.js).
    const initialCommand = options.exitWithCommand
      ? buildRunThenExitCommand(options.initialCommand, shell)
      : options.initialCommand;
    // onInitialCommandSent fires when the command is injected, whichever branch sent it; the
    // agent-TUI spawner starts its input-readiness observation only then, so the probe's own
    // shell activity can't satisfy its bracketed-paste gate. On the waitForPromptReady path
    // `sendInitial` runs from the probe's listener, registered after the main output listener,
    // whose `runHook` only QUEUES the caller's onData. Calling the callback synchronously would
    // fire it before that handler processed the probe's own echoed chunk (agentTuiSpawning.js's
    // commandInjected would misread it), so it goes through the same `session.hookQueue`. The
    // PTY write itself stays synchronous.
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
      // Inject only once the shell can ACTUALLY run commands. A fixed delay races a heavy shell,
      // and prompt-marker / settle-on-quiet watches are fooled by powerlevel10k's instant prompt
      // (rendered BEFORE `.zshrc`/nvm finish) or a slow mid-load quiet gap: the command is
      // swallowed when the real prompt redraws. Instead PROVE execution with a round-trip probe:
      // print a unique nonce and wait to SEE it in the OUTPUT. The nonce is split in the probe
      // source (buildReadinessProbe) so the command ECHO never contains it. A bounded fallback
      // injects anyway if the probe never round-trips (or the dialect has none, e.g. cmd.exe).
      let sent = false;
      let sub = null;
      let exitSub = null;
      const nonce = uuidv4().replace(/-/g, '').slice(0, 12);
      const marker = `PORTOSRDY${nonce}`;
      const probe = buildReadinessProbe(nonce, shell);
      let seen = '';
      // Tear down every pending timer + listener on success and on PTY exit before the probe round-trips.
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
      // No probe for this dialect (cmd.exe): the fallback timer alone injects the command.
      sub = ptyProcess.onData((chunk) => {
        if (!probe) return;
        seen += chunk;
        if (seen.length > 8192) seen = seen.slice(-8192);
        if (seen.includes(marker)) fire();
      });
      // If the shell dies before the probe round-trips, cancel pending writes/timers; `sent` stays
      // true so the fallback can't send into the gone session.
      exitSub = ptyProcess.onExit(() => { sent = true; stop(); });
      // Give the PTY a tick to come up; writing earlier is harmless (the line editor buffers it)
      // but may race node-pty's spawn handshake.
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
 * `createShellSession`'s login shell runs the operator's rc file BEFORE the
 * command and can re-export anything, a hole no env allowlist closes for a
 * public-content review stage (#6159). Here the binary is the PTY's own process,
 * so `env` is exactly what the child gets: the COMPLETE environment, with nothing
 * unioned underneath (`buildSafeEnv` is not consulted). Ordinary agent TUI
 * sessions keep the login shell, so this is not a drop-in replacement.
 *
 * Every failure THROWS rather than returning null, so the spawner can record a
 * cause ("binary not installed" vs "session cap full") on the agent record.
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
  // The caller owns this env whole. PWD is still pinned (#3193): a directly-launched CLI reads it
  // (OpenCode resolves its project root from it) and no shell will fix it up.
  const childEnv = withSpawnCwdEnv({ ...(options.env || {}), ...TERM_ENV }, cwd);

  // Resolve the executable BEFORE spawning: with no shell to print "command not found", a failed
  // POSIX `execvp` exits 1 with an EMPTY screen and the run finalizes as a causeless exit-1.
  // Resolve against the CHILD's PATH (a caller's env may replace it), as `tuiPromptRunner` and
  // the CoS runner's `/spawn-tui` do; `basename` keeps the local account name out of the message.
  const executable = findCommandOnPath(command, { env: childEnv, cwd });
  if (!executable) {
    throw new Error(`Command executable unavailable: ${basename(command)} is not on the PATH for this session. Install it or update the configured command.`);
  }
  // Launch the path the pre-flight RESOLVED, not the bare name: on Windows the two resolvers
  // disagree (`findCommandOnPath` unquotes PATH entries, resolves relative ones, searches all of
  // PATHEXT; `prepareCliSpawn` does not), and re-resolving could land on an extensionless
  // `claude` ConPTY cannot launch. `prepareCliSpawn` still runs: a resolved `.cmd`/`.bat`
  // shim must launch through cmd.exe, and it owns the argument-escaping contract. On POSIX it
  // is a no-op.
  const { command: ptyCommand, args: ptyArgs } = prepareCliSpawn(executable, args, childEnv);

  console.log(`🐚 Creating command session ${sessionId.slice(0, 8)} (${basename(command)})`);
  const launch = prepareWindowsAgentLaunch(options.agentId, ptyCommand, ptyArgs, { cwd, env: childEnv, pty: true });
  const ptyProcess = pty.spawn(launch.command, launch.args, {
    ...ptyTerminalOptions({ cwd, cols: options.cols, rows: options.rows }),
    env: childEnv
  });
  watchWindowsAgentProcess(ptyProcess, launch);

  adoptPtySession(sessionId, ptyProcess, { ...options, cwd, shell: null });
  broadcastSessionList();
  return sessionId;
}

/**
 * A socket may stay bound to several sessions, but a user views one at a time.
 * `isExternalSessionAttached` keys off socket binding, so when a socket starts
 * viewing a different session, drop its binding to any OTHER external (TUI-run)
 * view so that run resumes normal completion. Interactive shells keep theirs.
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
 * `lib/tuiPromptRunner.js`) as an attachable session, so the Shell UI can show
 * its live output and the user can type corrections or interrupt it.
 *
 * The TUI runner deliberately spawns its own PTY (bypassing the session cap and
 * login-shell wrapper); this only *surfaces* it. `external: true` keeps it out of
 * the interactive cap count and auto-attach. Input and resize are NOT blocked;
 * the runner pauses idle-completion and hard-timeout while a viewer is attached
 * (`isExternalSessionAttached`). node-pty fans `onData` out to every listener,
 * so ours doesn't disturb the runner's capture. The runner calls
 * unregisterExternalSession from its finish() funnel.
 *
 * @param {string} sessionId — typically the runId, so the Shell view correlates
 *   with the /runs record.
 * @param {object} ptyProcess — the live node-pty IPty.
 * @param {object} [options] — { label, command, cwd, kind, agentId }.
 * @returns {string} sessionId (idempotent — returns the id if already registered).
 */
export function registerExternalSession(sessionId, ptyProcess, options = {}) {
  if (shellSessions.has(sessionId)) return sessionId;

  // Same record and re-attach ring buffer as every session; only `external` and the exit wiring differ (see adoptPtySession).
  adoptPtySession(sessionId, ptyProcess, {
    ...options,
    kind: options.kind || 'tui-run',
    external: true,
    // The PTY is not ours to type into, and its hooks belong to its spawner.
    shell: null,
    onData: null,
    onExit: null
  });

  console.log(`🐚 Registered external TUI session ${sessionId.slice(0, 8)} (${options.label || options.command || 'tui'})`);
  broadcastSessionList();
  return sessionId;
}

/**
 * Remove an external session from the registry and notify any attached viewer.
 * Idempotent and external-only: a no-op for an unknown id or an interactive shell.
 */
export function unregisterExternalSession(sessionId, { exitCode = 0 } = {}) {
  const session = shellSessions.get(sessionId);
  if (!session || !session.external) return false;
  shellSessions.delete(sessionId);
  session.socket?.emit('shell:exit', { sessionId, code: exitCode });
  broadcastSessionList();
  return true;
}

/** True when an external (TUI-run) session exists and a Shell viewer is attached; the runner pauses auto-completion/timeout while true. */
export function isExternalSessionAttached(sessionId) {
  const session = shellSessions.get(sessionId);
  return !!(session && session.external && session.socket);
}

/**
 * Public "stopped viewing" signal, emitted when the client leaves the Shell page
 * (the socket persists across navigations, so no disconnect fires). Releases every
 * external (TUI-run) view bound to this socket so those runs resume idle
 * completion; tab-switching already releases via attach/create.
 */
export function releaseExternalViewsForSocket(socket) {
  if (!socket) return;
  const held = [...shellSessions.values()].some(s => s.external && s.socket === socket);
  releaseExternalViews(socket);
  if (held) broadcastSessionList();
}

/**
 * Attach an existing session to a new socket.
 *
 * A session has one attached socket (PTY output fans to it only). A deep link in a
 * second tab takes over, and `shell:detached` is emitted on the prior socket so it
 * clears its state instead of silently losing the stream.
 *
 * `claim` — when true, refuses to displace a different socket, so client auto-pick
 * paths racing across idle tabs don't displace each other. User-initiated attaches
 * default to claim=false (explicit intent wins).
 */
export function attachSession(sessionId, socket, { claim = false } = {}) {
  const session = shellSessions.get(sessionId);
  if (!session) return null;
  const prevSocket = session.socket;
  if (claim && prevSocket && prevSocket !== socket) {
    // Auto-pick lost the race to a different socket; the caller can fall back.
    return { claimRejected: true };
  }
  if (prevSocket && prevSocket !== socket) {
    prevSocket.emit('shell:detached', { sessionId, reason: 'attached-elsewhere' });
  }
  session.socket = socket;
  // Switching view releases any TUI-run this socket was watching.
  releaseExternalViews(socket, sessionId);
  console.log(`🐚 Attached session ${sessionId.slice(0, 8)} to socket ${socket.id}`);
  // Broadcast so other clients see `attached: true` and skip this session in auto-pick.
  broadcastSessionList();
  return {
    sessionId,
    bufferedOutput: session.replay.render()
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
  // Each subscriber gets a recipient-relative list (see listAllSessions()).
  for (const sock of sessionListSubscribers) {
    sock.emit('shell:sessions', listAllSessions(sock));
  }
}

/**
 * List all active sessions with metadata.
 *
 * With `forSocket`, `attached` is recipient-relative: TRUE only if bound to a
 * DIFFERENT socket, so clients can use it as "don't auto-pick, it belongs to
 * someone else" without filtering out their own sessions (the socket persists
 * across navigations). Omitting it returns the globally-attached view.
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
      ...(session.executionOptions ? { executionOptions: session.executionOptions } : {}),
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

// Automatic xterm replies (focus in/out, CPR, DA1/DA2, DSR, OSC color answers) an attached
// viewer emits unprompted; not a person typing over a pasted prompt.
const TERMINAL_REPLY_RE = /^(?:\x1b\[[IO]|\x1b\[[?>]?[\d;]*[Rcn]|\x1b\][\s\S]*?(?:\x07|\x1b\\))+$/;

/**
 * Write input to a shell session
 */
export function writeToSession(sessionId, data, options) {
  const session = shellSessions.get(sessionId);
  if (session) {
    session.lastInputAt = Date.now();
    // pasteToSession cancels its Enter retries when this moves; a terminal protocol reply must
    // not, or the pasted prompt is silently stranded unsubmitted.
    if (!TERMINAL_REPLY_RE.test(data)) session.inputRevision = (session.inputRevision || 0) + 1;
    // Runner proxies carry submission evidence with the Enter; native node-pty keeps a one-argument write.
    if (session.external && options?.promptSubmission) session.pty.write(data, options);
    else session.pty.write(data);
    return true;
  }
  return false;
}

/**
 * Type a command line into a session and press Enter. Every "inject a command the
 * user didn't type" path goes through here so the terminator is decided once
 * (see SUBMIT_KEY for why it isn't a newline).
 *
 * @param {string} sessionId
 * @param {string} line - command line, WITHOUT a trailing terminator
 * @returns {boolean} false when the session is unknown
 */
export function submitToSession(sessionId, line) {
  return writeToSession(sessionId, `${line}${SUBMIT_KEY}`);
}

/**
 * Change a session's working directory through the service, because only the
 * server knows which shell the PTY runs and the command differs per shell
 * (lib/shellCd.js). Updates `session.cwd` optimistically on success.
 *
 * @param {string} sessionId
 * @param {string} dirPath
 * @returns {boolean} false when the session is unknown, or has no hosting shell
 */
export function changeSessionDirectory(sessionId, dirPath) {
  const session = shellSessions.get(sessionId);
  if (!session) return false;
  // No hosting shell (external view or direct `spawnCommandSession` PTY): the bytes would land in
  // the agent as typed text and Enter would post them as a message. Refuse; socket.js turns this
  // into an error. Its `cwd` stays pinned to the repo the RUN was spawned in (workspaceContext).
  if (session.external || !session.shell) return false;
  if (!submitToSession(sessionId, buildCdCommand(dirPath, session.shell))) return false;
  // Track the cd optimistically so the tab label and Workspace Contexts widget follow. `cwd` is
  // display-only and the paths come from the managed-apps list; probing the PTY's real cwd
  // isn't worth it for a label.
  session.cwd = dirPath;
  broadcastSessionList();
  return true;
}

/**
 * Deliver `text` to a live agent TUI as a SINGLE bracketed-paste event
 * (`ESC[200~…ESC[201~`), so a multi-line message lands as one input rather than
 * N submits, then submit it.
 *
 * The returned interval handle lets callers cancel pending submission retries;
 * the helper self-cancels when the session disappears, newer input arrives, or
 * its attempt budget is spent.
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
      // Timer callback: a write to a live-but-broken PTY can throw.
      console.error(`🐚 ${label} submit Enter failed for ${sessionId.slice(0, 8)}: ${err.message}`);
    }
  };
  return scheduleSubmitEnters(
    writeEnter,
    () => !shellSessions.has(sessionId) || session.inputRevision !== expectedInputRevision,
  );
}

/**
 * When input was last written to this session (human or internal writer), or
 * `null`. Unlike a socket-bound check, recency expires once nobody interacts.
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
    try {
      session.pty.resize(cols, rows);
      return true;
    } catch (err) {
      console.warn(`🐚 Failed to resize shell session ${sessionId}: ${err.message}`);
      return false;
    }
  }
  return false;
}

/**
 * Kill a shell session
 */
export function killSession(sessionId) {
  const session = shellSessions.get(sessionId);
  if (session) {
    console.log(`🐚 Killing shell session ${sessionId}`);
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
  // Broadcast so other tabs see `attached: false` and can adopt these sessions.
  if (count > 0) broadcastSessionList();
  return count;
}

/**
 * Get session count
 */
export function getSessionCount() {
  return shellSessions.size;
}
