import * as pty from 'node-pty';
import os from 'os';
import { v4 as uuidv4 } from '../lib/uuid.js';

// Store active shell sessions (persist across socket reconnects)
const shellSessions = new Map();

const MAX_TOTAL_SESSIONS = 5;

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
  if (shellSessions.size >= MAX_TOTAL_SESSIONS) {
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

  broadcastSessionList();
  if (options.initialCommand) {
    setTimeout(() => writeToSession(sessionId, `${options.initialCommand}\n`), options.initialCommandDelayMs ?? 200);
  }
  return sessionId;
}

/**
 * Attach an existing session to a new socket
 */
export function attachSession(sessionId, socket) {
  const session = shellSessions.get(sessionId);
  if (!session) return null;
  // Detach from old socket
  session.socket = socket;
  console.log(`🐚 Attached session ${sessionId.slice(0, 8)} to socket ${socket.id}`);
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
  const list = listAllSessions();
  for (const sock of sessionListSubscribers) {
    sock.emit('shell:sessions', list);
  }
}

/**
 * List all active sessions with metadata
 */
export function listAllSessions() {
  const sessions = [];
  for (const [sessionId, session] of shellSessions.entries()) {
    sessions.push({
      sessionId,
      cwd: session.cwd,
      createdAt: session.createdAt,
      label: session.label,
      kind: session.kind,
      agentId: session.agentId,
      command: session.command
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
  return count;
}

/**
 * Get session count
 */
export function getSessionCount() {
  return shellSessions.size;
}
