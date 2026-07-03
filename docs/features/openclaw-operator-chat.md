# OpenClaw Operator Chat

A generic, first-party operator chat surface inside PortOS for talking to a local or privately reachable [OpenClaw](https://github.com/openclaw/openclaw) runtime — without routing sensitive operator conversations through third-party messaging providers like Telegram.

## Why this exists

PortOS is reachable over Tailscale and is intended to be a secure, self-hosted operating surface. For sensitive operator work, routing chat through Telegram or another third-party messaging network adds avoidable privacy and security exposure. Operator Chat keeps assistant conversations first-party: chat with your assistant directly inside PortOS, inspect session state without leaving the app, and keep machine/admin context off third-party transports.

## Product constraints

PortOS is a public open-source project used by many people, so this feature is:

- **Generic** — no assistant identity, persona, or relationship model is baked into product code.
- **Optional** — PortOS works cleanly without OpenClaw; the page degrades gracefully when unconfigured.
- **Instance-configurable** — identity, endpoints, tokens, and machine topology live in local, git-ignored config (`data/openclaw/config.json`) or environment variables, never in committed defaults.

## Architecture

PortOS talks to the OpenClaw runtime through a thin adapter — it does not reimplement assistant logic:

- **Integration module** — `server/integrations/openclaw/api.js` is the entire runtime client: config loading, auth headers, upstream calls, session/message/status normalization, and error translation. It reaches the runtime through two upstream paths: a tool-invoke endpoint (`/tools/invoke`, for `sessions_list` / `sessions_history`) and an OpenAI-Responses-style endpoint (`/v1/responses`, for send + stream with `model: openclaw:<agentId>`).
- **Routes** — `server/routes/openclaw.js`, mounted at `/api/openclaw`.
- **Client service** — `client/src/services/apiOpenClaw.js` (status, sessions, messages, non-streaming send, SSE streaming send).
- **Page** — `client/src/pages/OpenClaw.jsx` at `/openclaw` (registered in `App.jsx` and in `NAV_COMMANDS` under the Brain section, so it is reachable from ⌘K and voice nav).

Responsibility split: PortOS owns the operator UI, session list, message history, attachment/context UX, and runtime connection status. OpenClaw owns the session runtime, message handling, tool execution, orchestration, response generation, and runtime-side policy enforcement.

## API surface

| Route | Description |
|-------|-------------|
| `GET /api/openclaw/status` | Configured? Reachable (live `sessions_list` probe)? Default session, label, runtime info (allowlisted fields only — never the raw upstream payload) |
| `GET /api/openclaw/sessions` | List sessions discovered from the runtime |
| `GET /api/openclaw/sessions/:id/messages` | Message history (`?limit=`, default 50, max 200) |
| `POST /api/openclaw/sessions/:id/messages` | Send a message (non-streaming) |
| `POST /api/openclaw/sessions/:id/messages/stream` | Send a message, stream the reply as SSE |

Both send routes validate with a shared Zod schema: a required non-empty `message`, an optional `context` object (`appName`, `repoPath`, `directoryPath`, `extraInstructions` — flattened into prose server-side and prepended to the input), and optional `attachments` (max 8, image/file, base64 or URL, ~10 MB per attachment and 50 MB combined). Send routes return 503 `OPENCLAW_UNCONFIGURED` when not configured; the history route soft-fails to `{ configured: false, reachable: false, messages: [] }` instead.

**Proposed but not built** (kept here as an honest record of the original proposal's larger surface): `POST /api/openclaw/sessions` (create/bind a session — sessions are discovery-only today; the client injects a synthetic "default" session but cannot create one), `GET /api/openclaw/jobs`, `GET /api/openclaw/subagents`, and `POST /api/openclaw/context/compose` (context is composed inline on the send payload instead of via a separate endpoint).

## UI

Two-column layout on `/openclaw`:

- **Left sidebar** — runtime status panel (label, configured, reachable, default session), session list with a "Show older chats" partition, and a refresh action.
- **Main panel** — role-tagged message timeline with timestamps and per-message attachment chips, a streaming placeholder while the assistant replies, and a composer (⌘↵ to send, Stop button for in-flight streams).

Context and attachments are explicit and user-controlled, not silently leaked: an app/repo picker (`AppContextPicker`), a directory-context input, an extra-instructions input, and file/image attachments via drag-and-drop, paste, or file picker (`useOpenClawAttachments`; streaming via `useOpenClawStream`).

## Configuration

Config resolves in two layers — environment variables override the file:

- **File**: `data/openclaw/config.json` (git-ignored; reference template at `data.reference/openclaw/config.json` ships with `enabled: false`). Fields: `enabled`, `baseUrl`, `authToken`, `authHeader`, `authScheme`, `defaultSession`, `defaultAgentId`, `timeoutMs`, `label`, `paths` (upstream path overrides) — the file accepts the same keys the env vars override.
- **Env**: `OPENCLAW_ENABLED`, `OPENCLAW_BASE_URL`, `OPENCLAW_AUTH_TOKEN`, `OPENCLAW_AUTH_HEADER` (default `Authorization`), `OPENCLAW_AUTH_SCHEME` (default `Bearer`; empty string = token-only), `OPENCLAW_LABEL`, `OPENCLAW_DEFAULT_SESSION`, `OPENCLAW_DEFAULT_AGENT_ID` (default `main`), `OPENCLAW_TIMEOUT_MS` (default 15000).

"Configured" requires `enabled` not false AND a well-formed `http:`/`https:` `baseUrl` (other schemes are rejected). There is no settings-page UI for this — it is deliberately file/env-only, keeping private topology out of synced app state.

## Graceful degradation

- Unconfigured: the page stays visible with an "Unconfigured" badge, an empty-state prompt to add local config, a disabled composer, and no noisy errors elsewhere in the app.
- Unreachable: status shows "Unavailable" with the probe's error message; `getRuntimeStatus`/`listSessions` return structured `{ configured, reachable, ... }` payloads rather than throwing.
- The status endpoint's runtime info is allowlisted so upstream payloads and tokens never leak to the client.

## Relationship to other surfaces

- **Chief of Staff** — CoS remains the autonomous/managed agent surface; Operator Chat is a direct conversation surface. They are separate domains.
- **Messages** — the Messages page manages external communications/accounts; Operator Chat is an internal/local console. The distinction is deliberate.

## Tests

- `server/routes/openclaw.test.js` — route coverage: status/sessions configured + unconfigured, history limits and clamping, send validation (missing message, attachment count/size caps), 503 guards, SSE content-type and event streaming.
- `server/integrations/openclaw/api.test.js` — `getRuntimeStatus` field allowlisting, unreachable → `runtime: null`, unconfigured → no fetch.
