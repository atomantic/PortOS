/**
 * Import-free Socket.IO handle and command-subscriber broadcast (#17619).
 *
 * `socket.js` is the composition root: it statically imports readiness,
 * autoFixer, apps, brain, instances, the media queue and every socket
 * handler. `vitest related` follows dynamic `import()` too, so callers that
 * only needed `getIo()` or a command broadcast pulled that root into a
 * 1,481-suite selection. This leaf holds the live server and the command
 * subscriber set. `initSocket` publishes the server with `setIo`. The leaf
 * imports nothing, including `socket.js`.
 */

let ioInstance = null;

/** @param {object | null} io Socket.IO server, or null to detach. */
export function setIo(io) {
  ioInstance = io;
}

/**
 * The module-level Socket.IO server (null before initSocket runs).
 * Services emit from unattended paths (cron handlers) that receive no `io`.
 */
export function getIo() {
  return ioInstance;
}

// Operator command-runner output (#12019). Never a global emit: the stream
// carries host command output, and a peer relay socket (restricted to
// `cos:subscribe`) must not receive it. `socket.js` registers subscribers
// into this same set.
export const commandSubscribers = new Set();

/** Emit a `command:<id>:*` frame to sockets that sent `command:subscribe`. */
export function broadcastToCommandSubscribers(event, data) {
  const disconnected = [];
  for (const socket of commandSubscribers) {
    if (!socket.connected) { disconnected.push(socket); continue; }
    socket.emit(event, data);
  }
  for (const socket of disconnected) commandSubscribers.delete(socket);
}
