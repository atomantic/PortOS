/**
 * `PORTS` + `DEFAULT_PEER_PORT`, re-exported from the pure leaf `server/lib/ports.js` (which
 * `ports.test.js` pins against `ecosystem.config.cjs`, the source of truth — see docs/PORTS.md).
 *
 * Use these instead of re-hardcoding a port literal in a form default, a copy-paste help string, or a
 * cross-machine URL.
 */

/**
 * Re-export of the `PORTS` map and `DEFAULT_PEER_PORT` from the pure server leaf
 * `server/lib/ports.js`.
 *
 * `ecosystem.config.cjs` (top-level `PORTS`) remains the SOURCE OF TRUTH — see
 * docs/PORTS.md; `server/lib/ports.test.js` fails if the server map drifts from
 * it. Importing rather than copying means the UI cannot drift from the server on
 * top of that. Use these instead of re-hardcoding a port literal in a form
 * default, a copy-paste help string, or a cross-machine URL.
 */
export {
  PORTS,
  DEFAULT_PEER_PORT,
  DEFAULT_TAILCAT_LOCAL_PORT,
  DEFAULT_TAILCAT_REMOTE_PORT,
} from '../../../server/lib/ports.js';
