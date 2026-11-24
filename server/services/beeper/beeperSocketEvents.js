import { EventEmitter } from 'events';

/**
 * Leaf event bus for the Beeper realtime transport (#33, decided on #12).
 *
 * A standalone module for the same reason `instanceEvents.js` and
 * `imageGenEvents.js` are: `socket.js` subscribes to it at boot, and importing
 * `beeperSocket.js` there instead would drag the whole ingestion stack (the DB
 * pool, settings, the HTTP client) into every module that touches Socket.IO.
 *
 * Two events, both INVALIDATION-ONLY (#12 decision 3):
 *   - `invalidate` — `{ kind, chatID, ids, seq, ts }`. Ids and kinds,
 *     never message bodies, display names or handles. The browser refetches
 *     from the PortOS mirror, which is the read path (#7).
 *   - `state` — `{ state, lastEventAt, lastPingAt, ... }`, the transport
 *     liveness snapshot the settings card's dot renders from.
 */
export const beeperSocketEvents = new EventEmitter();
