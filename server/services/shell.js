import * as pty from 'node-pty';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

// Store active shell sessions
const shellSessions = new Map();

const MAX_SESSIONS_PER_SOCKET = 3;

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
  const existing = getSessionsForSocket(socket);
  if (existing.length >= MAX_SESSIONS_PER_SOCKET) {
    console.warn(`🐚 Socket ${socket.id} exceeded max sessions (${MAX_SESSIONS_PER_SOCKET})`);
    socket.emit('shell:error', { error: `Max ${MAX_SESSIONS_PER_SOCKET} shell sessions per connection` });
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
        ...buildSafeEnv(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    });
  } catch (err) {
    console.error(`❌ Failed to spawn PTY: ${err.message}`);
    socket.emit('shell:error', { error: `Failed to spawn shell: ${err.message}` });
    return null;
  }

  // Store session info
  shellSessions.set(sessionId, {
    pty: ptyProcess,
    socket,
    createdAt: Date.now()
  });

  // Handle pty output
  ptyProcess.onData((data) => {
    socket.emit('shell:output', { sessionId, data });
  });

  // Handle pty exit
  ptyProcess.onExit(({ exitCode }) => {
    console.log(`🐚 Shell session ${sessionId.slice(0, 8)} exited (code: ${exitCode})`);
    shellSessions.delete(sessionId);
    socket.emit('shell:exit', { sessionId, code: exitCode });
  });

  return sessionId;
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
    return true;
  }
  return false;
}

/**
 * Get all active sessions for a socket
 */
export function getSessionsForSocket(socket) {
  const sessions = [];
  for (const [sessionId, session] of shellSessions.entries()) {
    if (session.socket === socket) {
      sessions.push(sessionId);
    }
  }
  return sessions;
}

/**
 * Clean up all sessions for a socket (on disconnect)
 */
export function cleanupSocketSessions(socket) {
  const sessions = getSessionsForSocket(socket);
  for (const sessionId of sessions) {
    killSession(sessionId);
  }
  return sessions.length;
}

/**
 * Get session count
 */
export function getSessionCount() {
  return shellSessions.size;
}
