/**
 * `ownWrite(options)` adds this tab's socket id as `X-PortOS-Origin` to a request's options, so the change broadcast of a write the tab applies itself is not refetched.
 *
 * The server carries the header through the write (server/lib/writeOrigin.js) and names it on the
 * record's change event; the page's listener skips an event naming its own socket. A label only:
 * every tab still receives the event. Send it only for a write whose reply the caller applies in
 * full; a write that still needs a reload must leave it off, or the reload never happens.
 */

import socket from './socket.js';

export const ownWrite = (options = {}) => ({ silent: true, ...options, ...(socket.id ? { headers: { ...options.headers, 'X-PortOS-Origin': socket.id } } : {}) });
