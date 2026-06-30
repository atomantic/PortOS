// Importable mirror of the `PORTS` object in ecosystem.config.cjs (the source of
// truth — see docs/PORTS.md). ESM server code can't require() the CommonJS
// ecosystem config, so these literals are duplicated here and must stay in sync.
export const PORTS = {
  API: 5555,        // HTTPS API (or HTTP if cert not configured)
  API_LOCAL: 5553,  // Loopback-only HTTP mirror — only binds when HTTPS is active on API.
                    //   Tailscale cert covers <machine>.<tailnet>.ts.net only, so
                    //   https://localhost:5555 trips a warning; this sibling port
                    //   serves the same app over plain HTTP for local dev.
                    //   Overridable via PORTOS_HTTP_PORT.
  UI: 5554,         // Vite dev server
  CDP: 5556,        // Chrome DevTools Protocol (browser automation)
  CDP_HEALTH: 5557, // Browser health check endpoint
  COS: 5558,        // Chief of Staff agent runner (portos-cos)
  AUTOFIXER: 5559,  // Autofixer API
  AUTOFIXER_UI: 5560 // Autofixer UI
};
export const DEFAULT_PEER_PORT = PORTS.API;
export const PORTOS_UI_URL = process.env.PORTOS_UI_URL
  || `http://${process.env.PORTOS_HOST || 'localhost'}:${process.env.PORT_UI || PORTS.UI}`;
export const PORTOS_API_URL = process.env.PORTOS_API_URL
  || `http://${process.env.PORTOS_HOST || 'localhost'}:${process.env.PORT || PORTS.API}`;
