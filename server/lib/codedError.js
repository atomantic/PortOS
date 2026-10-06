// Dependency-free leaf: an Error carrying a machine-readable `code`.
//
// Domain services throw these and the route layer maps `err.code` to an HTTP
// status through `createServiceErrorMapper` (lib/errorHandler.js) — so a caller
// branches on the code, never on `err.message`. Kept out of errorHandler.js on
// purpose: that module drags the Socket.IO/express closure into every service
// that only wants to raise an error (see `importScoping.test.js`).
//
// Use `ServerError` (errorHandler.js) when the throw site already knows the
// HTTP status; use this when the service owns a code vocabulary (`ERR_*`) and
// the route owns the status table.
export const codedError = (message, code) => Object.assign(new Error(message), { code });
