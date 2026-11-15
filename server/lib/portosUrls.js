// The origins PortOS prints into prompts and links, resolved from the
// environment at module load.
//
// `PORTOS_UI_URL` / `PORTOS_API_URL` — the origins PortOS interpolates into prompts and links,
// resolved from `PORTOS_*` / `PORT` at module load. `PORTOS_API_URL_TOKEN` is the `{portosApiUrl}`
// placeholder agent prompts embed instead of `PORTOS_API_URL`; `buildAgentPrompt` expands it at spawn
// time to `localApiBaseUrl()` (the loopback mirror on HTTPS installs). Split out of `ports.js` so that
// module stays free of module-scope `process.env` reads and can be re-exported to the client.
//
// Split out of `ports.js` so that module stays a pure leaf the browser bundle
// can import through `client/src/lib/ports.js`: a module-scope `process.env`
// read throws `process is not defined` in the client build.
import { PORTS } from './ports.js';

export const PORTOS_UI_URL = process.env.PORTOS_UI_URL
  || `http://${process.env.PORTOS_HOST || 'localhost'}:${PORTS.UI}`;
export const PORTOS_API_URL = process.env.PORTOS_API_URL
  || `http://${process.env.PORTOS_HOST || 'localhost'}:${process.env.PORT || PORTS.API}`;

// `PORTOS_API_URL` is the origin advertised to clients (OAuth redirects). It is
// fixed at module load and knows nothing about HTTPS, so on an install with
// TLS on `:5555` it is the wrong target for an agent's curl. Agent prompts embed
// this token instead; `buildAgentPrompt` expands it at spawn time on the machine
// running the agent to `localApiBaseUrl()` (#12405).
export const PORTOS_API_URL_TOKEN = '{portosApiUrl}';
