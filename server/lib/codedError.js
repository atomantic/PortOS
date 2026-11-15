// Dependency-free leaf: an Error carrying a machine-readable `code`.
//
// `codedError(message, code)` — dependency-free `Error` carrying a machine-readable `code`. The one
// shared form of the per-service `makeErr`: a service owns an `ERR_*` vocabulary, throws
// `codedError(msg, ERR_X)`, and the route maps `err.code` to a status via `createServiceErrorMapper`
// (`errorHandler.js`). Reach for `ServerError` instead when the throw site already knows the HTTP
// status. A leaf so a service can raise one without pulling `errorHandler.js` into its import closure.
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
