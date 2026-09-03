// Client mirror of the small subset of `PORTS` the UI needs.
//
// `ecosystem.config.cjs` (top-level `PORTS` object) is the SOURCE OF TRUTH — see
// docs/PORTS.md. `server/lib/ports.js` is the server-side mirror. This file
// exists because the browser bundle can't import either one: the ecosystem
// config is CommonJS living outside the client Vite root, and the server mirror
// is server ESM. `ports.parity.test.js` fails if these drift from the config.
//
// Decision: mirror rather than fetch from an endpoint — these values are needed
// synchronously at module scope for form defaults and static help text, before
// any API round-trip could resolve.
export const PORTS = Object.freeze({
  API: 5555,       // Express API server (HTTPS when a Tailscale cert is active)
  API_LOCAL: 5553, // Loopback-only HTTP mirror of API — binds only when HTTPS is on
  UI: 5554,        // Vite dev server (client)
});

// The port a newly-added federation peer is assumed to serve its API on.
// Mirrors `DEFAULT_PEER_PORT` in server/lib/ports.js.
export const DEFAULT_PEER_PORT = PORTS.API;
