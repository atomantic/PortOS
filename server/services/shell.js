import * as pty from 'node-pty';
import os from 'os';
import { v4 as uuidv4 } from '../lib/uuid.js';

// Store active shell sessions (persist across socket reconnects)
const shellSessions = new Map();

// Soft ceiling on concurrent user-spawned interactive shells. Each session is a
// single idle PTY (a few MB, one OS process), and the deployment is single-user
// on a private network — so this is a sanity bound against runaway tab-spamming,
// not a resource/abuse defense. External views (TUI runs) don't count.
const MAX_TOTAL_SESSIONS = 20;

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

function buildSafeEnv() {
  const safeEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_PREFIXES.some(prefix => key === prefix || key.startsWith(prefix))) {
      safeEnv[key] = value;
    }
  }
  return safeEnv;
}

/**
 * Get the default shell for the current OS
 */
function getDefaultShell() {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}

/**
 * Create a new shell session
 */
export function createShellSession(socket, options = {}) {
  // Only user-spawned interactive shells count toward the cap. External views
  // (one-shot TUI runs registered via registerExternalSession) are governed by
  // their own runner and must not consume a shell slot.
  const interactiveCount = [...shellSessions.values()].filter(s => !s.external).length;
  if (interactiveCount >= MAX_TOTAL_SESSIONS) {
    console.warn(`🐚 Max total sessions reached (${MAX_TOTAL_SESSIONS})`);
    socket?.emit?.('shell:error', { error: `Max ${MAX_TOTAL_SESSIONS} shell sessions. Kill an existing session first.` });
    return null;
  }

  const sessionId = uuidv4();
  const shell = options.shell || getDefaultShell();
  const cwd = options.cwd || os.homedir();
  const cols = options.cols || 80;
  const rows = options.rows || 24;

  console.log(`🐚 Creating shell session ${sessionId.slice(0, 8)} (${shell})`);

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...buildSafeEnv(), // filters process.env to prevent leaking inherited secrets (e.g. shell-inherited API keys)
        // options.env is the caller's explicit opt-in env (e.g. TUI provider API keys for codex/claude).
        // Callers are responsible for not passing vars they don't want visible inside attachable shells.
        // Single-user/single-instance deployment (Tailscale-only) makes this acceptable.
        ...(options.env || {}),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    });
  } catch (err) {
    console.error(`❌ Failed to spawn PTY: ${err.message}`);
    socket?.emit?.('shell:error', { error: `Failed to spawn shell: ${err.message}` });
    return null;
  }

  // Buffer recent output for re-attach (last 50KB)
  const outputBuffer = [];
  let bufferSize = 0;
  const MAX_BUFFER = 50 * 1024;

  // Store session info
  shellSessions.set(sessionId, {
    _id: sessionId.slice(0, 8),
    hookQueue: Promise.resolve(),
    pty: ptyProcess,
    socket,
    cwd,
    createdAt: Date.now(),
    label: options.label || null,
    kind: options.kind || 'shell',
    agentId: options.agentId || null,
    command: options.command || null,
    onData: options.onData || null,
    onExit: options.onExit || null,
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

  // Handle pty exit
  ptyProcess.onExit(({ exitCode }) => {
    console.log(`🐚 Shell session ${sessionId.slice(0, 8)} exited (code: ${exitCode})`);
    const session = shellSessions.get(sessionId);
    shellSessions.delete(sessionId);
    session?.socket?.emit('shell:exit', { sessionId, code: exitCode });
    if (session) runHook('onExit', session, session.onExit, { exitCode });
    broadcastSessionList();
  });

  // Starting a fresh shell means the user moved on from whatever they were
  // viewing — release any TUI-run views they held so those runs resume normal
  // completion instead of staying paused for a tab they've left.
  releaseExternalViews(socket, sessionId);
  broadcastSessionList();
  if (options.initialCommand) {
    // onInitialCommandSent fires at the exact moment the command is injected,
    // regardless of which branch sent it. The agent-TUI spawner uses this to
    // start observing claude's input-readiness ONLY after the real command is
    // in flight — so the readiness probe's own shell activity (below) can't
    // prematurely satisfy its bracketed-paste gate.
    const sendInitial = () => {
      options.onInitialCommandSent?.();
      writeToSession(sessionId, `${options.initialCommand}\n`);
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
      // probe source (`'PORTOSRDY' '<nonce>'`) so the command ECHO never contains
      // the assembled string — only the executed output matches, so a single
      // sighting is unambiguous. Instant-prompt keystroke buffering replays the
      // probe into the real shell, so this is theme- and shell-agnostic. A
      // bounded fallback still injects the command if the probe never round-trips.
      // NOTE: the probe is POSIX (`printf`). The only caller of waitForPromptReady
      // is the agent-TUI path, which is developer-machine (mac/linux) only; on a
      // Windows cmd.exe shell `printf` no-ops and the command simply injects on the
      // bounded fallback below (slower, never broken). A Windows port would need a
      // platform-aware probe.
      let sent = false;
      let sub = null;
      let exitSub = null;
      const nonce = uuidv4().replace(/-/g, '').slice(0, 12);
      const marker = `PORTOSRDY${nonce}`;
      const probe = `printf '%s\\n' 'PORTOSRDY''${nonce}'\n`;
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
      sub = ptyProcess.onData((chunk) => {
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
      const probeTimer = setTimeout(() => { if (!sent) writeToSession(sessionId, probe); }, 50);
      const fallback = setTimeout(fire, options.initialCommandDelayMs ?? 8000);
    } else {
      setTimeout(sendInitial, options.initialCommandDelayMs ?? 200);
    }
  }
  return sessionId;
}

/**
 * A socket can stay bound to multiple sessions (the registry allows it), but a
 * user views one at a time. `isExternalSessionAttached` keys off socket binding,
 * so without this a TUI run stays "watched" (and its completion stays paused)
 * after the user switches to another tab. When a socket starts viewing a
 * different session, drop its binding to any OTHER external (TUI-run) view so
 * that run resumes normal idle/timeout completion. Interactive shells keep their
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
 * @param {object} [options] — { label, command, cwd, kind }.
 * @returns {string} sessionId (idempotent — returns the id if already registered).
 */
export function registerExternalSession(sessionId, ptyProcess, options = {}) {
  if (shellSessions.has(sessionId)) return sessionId;

  // Mirror createShellSession's 50KB re-attach ring buffer so a viewer who
  // opens the run mid-stream still sees the recent screen state.
  const outputBuffer = [];
  let bufferSize = 0;
  const MAX_BUFFER = 50 * 1024;

  shellSessions.set(sessionId, {
    _id: sessionId.slice(0, 8),
    hookQueue: Promise.resolve(),
    pty: ptyProcess,
    socket: null,
    cwd: options.cwd || null,
    createdAt: Date.now(),
    label: options.label || null,
    kind: options.kind || 'tui-run',
    agentId: null,
    command: options.command || null,
    onData: null,
    onExit: null,
    external: true,
    outputBuffer,
    bufferSize: () => bufferSize
  });

  ptyProcess.onData((data) => {
    outputBuffer.push(data);
    bufferSize += data.length;
    while (bufferSize > MAX_BUFFER && outputBuffer.length > 1) {
      bufferSize -= outputBuffer.shift().length;
    }
    // Re-read the session each time — the attached socket changes as viewers
    // come and go; a null socket (no viewer) just drops the emit.
    shellSessions.get(sessionId)?.socket?.emit('shell:output', { sessionId, data });
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
 * True when ANY socket is currently attached to this session — an interactive
 * Shell viewer or an external TUI-run viewer. Broader than
 * `isExternalSessionAttached`, which only covers sessions registered via
 * `registerExternalSession` (the one-shot tuiPromptRunner path); this one also
 * covers regular sessions (agent-tui, plain interactive shells) viewed via
 * `attachSession`, which never sets `external`.
 */
export function isSessionViewed(sessionId) {
  const session = shellSessions.get(sessionId);
  return !!(session && session.socket);
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
    session.pty.write(data);
    return true;
  }
  return false;
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
