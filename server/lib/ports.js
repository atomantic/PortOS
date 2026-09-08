// Importable mirror of the `PORTS` object in ecosystem.config.cjs (the source of
// truth — see docs/PORTS.md). ESM server code can't require() the CommonJS
// ecosystem config, so these literals are duplicated here and must stay in sync
// (`ports.test.js` fails when they drift).
//
// A pure leaf: `client/src/lib/ports.js` re-exports it, so this module must read
// no `process.env` at module scope and import nothing outside `server/lib`. The
// env-derived origins live in `portosUrls.js` for that reason.
//
// Frozen: the client re-exports this object, and a UI that could mutate a shared
// port map would change what every later reader resolves.
export const PORTS = Object.freeze({
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
  AUTOFIXER_UI: 5560, // Autofixer UI
  POSTGRES_DOCKER: 5561, // PostgreSQL Docker container (host port mapping)
  WHISPER: 5562,    // Loopback whisper.cpp speech-to-text server
  EIDOVERSE_HOST: 5563, // Optional HTTPS/WebSocket bridge to Eidoverse Worlds on :8940
  SLOTSTREAM: 5564,   // Loopback SSD-streaming MoE runtime (never 11434 — that collides with Ollama)
  LLAMA_SERVER: 5568, // Loopback llama.cpp speculative-decoding server
  FLEET_LLM: 18022, // Authenticated shared inference queue for dedicated hosts

  VLLM_QWEN: 18020, // Loopback vLLM Qwen3.8-27B (DFlash 2) container — opt-in dedicated host setup
  SGLANG_QWEN: 18021, // Loopback SGLang Qwen3.8-27B container (Hopper/Blackwell) — operator-started, never by PortOS
  TAILCAT_INGRESS: 5565, // Loopback remote ingress; excludes local-only API authority
  TAILCAT_FORWARD: 15555, // Loopback forward for tailcat peers (maps to remote ingress)
  POSTGRES_NATIVE: 5432  // System PostgreSQL (PGMODE=native)
});

// The ecosystem config resolves a single active `PORTS.POSTGRES` by reading
// PGMODE out of .env at load time. This module stays free of filesystem reads
// (it is imported by nearly every server module), so the mode-dependent value is
// a function instead of a constant — callers pass the mode they already know.
export const resolvePostgresPort = (pgMode) =>
  (pgMode === 'native' ? PORTS.POSTGRES_NATIVE : PORTS.POSTGRES_DOCKER);

export const DEFAULT_PEER_PORT = PORTS.API;
// Preferred local bind for `tailcat forward <tc> LOCAL:5565` (remote PortOS ingress).
export const DEFAULT_TAILCAT_LOCAL_PORT = PORTS.TAILCAT_FORWARD;
export const DEFAULT_TAILCAT_REMOTE_PORT = PORTS.TAILCAT_INGRESS;
