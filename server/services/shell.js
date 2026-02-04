import * as pty from 'node-pty';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

// Store active shell sessions
const shellSessions = new Map();

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
        ...process.env,
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
