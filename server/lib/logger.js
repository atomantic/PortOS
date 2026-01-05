/**
 * Simple logger with timestamps
 * Replaces console.log/error with timestamped versions
 */

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

console.log = (...args) => {
  originalLog(`[${getTimestamp()}]`, ...args);
};

console.error = (...args) => {
  originalError(`[${getTimestamp()}]`, ...args);
};

console.warn = (...args) => {
  originalWarn(`[${getTimestamp()}]`, ...args);
};

export { getTimestamp };
