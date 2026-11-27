# API Reference

PortOS exposes a REST API on port 5555 and WebSocket events via Socket.IO.

## Base URL

```
http://localhost:5555/api
```

When a TLS cert is provisioned (`npm run setup:cert`), `:5555` serves HTTPS instead and a loopback-only HTTP mirror runs on `http://127.0.0.1:5553` for local scripts. See [PORTS.md](./PORTS.md).

Open **Dev Tools → API Explorer** on your PortOS instance to browse the live route inventory. These links use the default local HTTP origin. Use your instance's origin if you configured HTTPS or a different address.

- [API Explorer](http://localhost:5555/api-reference/catalog)
- [Internal OpenAPI](http://localhost:5555/api/api-docs/internal/openapi.json) for every mounted HTTP operation
- [Exposed OpenAPI](http://localhost:5555/api/api-docs/openapi.json) for APIs enabled in Settings

For the bridge between these HTTP/event inventories and model-facing tools,
see [API and MCP Unified Tool Contract](./API_TOOL_CONTRACT.md). It records
the shipped semantic registry, MCP context/action schemas, authority matrix,
and the current-vs-proposed boundary.

- `GET /api/api-docs/catalog.json` — searchable metadata for every mounted HTTP operation.
- `GET /api/api-docs/events.json` — searchable Socket.IO event inventory.
- `GET /api/api-docs/asyncapi.json` — AsyncAPI 3 for the Socket.IO transport.
- `GET /api/api-docs/tools.min.json` — the minimized semantic tool resource: only the operations annotated `x-portos-tool`, flattened to provider-neutral tool records with an HTTP binding. Sized for an agent to read whole, unlike the full internal document.

Inferred entries are marked `generated` until a runtime-backed payload contract exists; detailed entries are marked `modeled`. Both inventories are derived from source on first use (`server/lib/apiRouteGraph.js`, `server/lib/socketEventInventory.js`), so there is no checked-in manifest or regeneration step.

When adding an HTTP route, keep its request Zod schema in a reusable server library and register the detailed documentation in `server/lib/apiOperationContracts.js`; the route and OpenAPI consume the same schema object. Add an `x-portos-tool` annotation to that contract entry to publish the operation as an agent-callable tool in `tools.min.json`, and declare the codes its error responses really throw in `x-portos-error-codes` — the HTTP status alone does not identify the code, since `errorHandler` prefers an explicit `err.code` over the status map. Socket payload schemas follow the same pattern in `server/lib/socketEventContracts.js`. The live HTTP and Socket.IO source inventories guarantee coverage; these registries add richer contracts incrementally.

Building a native companion client? See [COMPANION_APP_API.md](./COMPANION_APP_API.md) — the stable, pre-auth-discoverable contract (discovery/identity, HTTP Basic auth vs. operator sessions, instance management, palette actions, daily-log, POST progress, and the iCloud-sync precedent) that the PortDeck app consumes. Basic auth alone does not grant peer management or host control — those need an operator session obtained via `POST /api/auth/login`, same as this section's [Security Model](#security-model) describes for host control below.

## Security Model

PortOS can execute host commands and read private files. Keep administration, APIs, sockets and sidecars on the owner’s private network. Public tunnels, proxies and forwarding are unsupported, including with a password or TLS.

Instance password authentication is off by default. When enabled it normally gates `/api/*`, `/data/*` and `/sdapi/*`. Sign in with `POST /api/auth/login` for an operator session. PortOS-spawned agents use their delegated `PORTOS_API_TOKEN` as a Bearer credential. An HTTP Basic or scoped peer credential does not grant operator authority.

Host-control operations include API writes, commands, sensitive reads declared by `HOST_CONTROL_GET_ROUTES` and corresponding Socket.IO events. They require an operator session or, with authentication off, a genuine local connection. Other callers receive `403 HOST_CONTROL_FORBIDDEN`. Public auth and health routes, peer federation, the managed visitor broker and opt-in exposed APIs have their own admission rules. For remote operator work over the private network, set an instance password and sign in. See the [host-control security model](../PRD.md#host-control-security-model).

## Federated peer-probe contract

PortOS peers running independently upgraded installs use the following existing
endpoints during the periodic reachability probe in
`server/services/instances.js`. They are a **frozen compatibility contract**:
keep their paths, request semantics, and listed response fields compatible.
Additive response fields are allowed. A breaking change needs a new, explicitly
versioned endpoint and a staged migration of the probe; `schemaVersions.js`
gates synchronized records, not these request/response contracts.

All three requests authenticate with the peer credential described in
[PEER_PUSH_AUTH.md](./PEER_PUSH_AUTH.md#peer-credentials-are-not-operator-authority):
the paired peer token, plus the configured HTTP Basic credential until the
remote confirms the token. They are not a general
cross-install data channel: probe results are stored only as the local peer's
health, app, and sync snapshots. Do not add personal records, peer lists,
credentials, local paths, or build identity to these responses.

| Method | Endpoint | Stable request and response contract |
|--------|----------|--------------------------------------|
| GET | `/system/health/details` | Returns an object containing `instanceId` and `version` (each may be `null`) for peer identity and compatibility display. Newer installs add `peerAuth: { version, accepted }`; `accepted` is true only when this request authenticated with the prober's pair token. A missing field means the prober keeps sending Basic. The health summary remains an object so an older prober can retain it as its last-known health snapshot. |
| GET | `/apps?view=probe` | The periodic probe requests `view=probe`; returns either the legacy app array or `{ apps: [...] }`. Each app entry used by peers retains `id`, `name`, `icon`, `overallStatus`, `uiPort`, `apiPort`, and `type`; fields may be absent or `null` when unknown. Older peers may ignore the query and return the legacy enriched list, which remains compatible with the same field mapping. |
| GET | `/instances/sync-status?forPeer=<instance-id>` | `forPeer` is optional and remains lenient: an unknown or legacy identifier, blank value, or omitted value must degrade to the unscoped status response rather than fail the probe. A recognized peer receives its `cursorForYou` alongside the normal sync status — with this install's own `lastSyncError` / `lastSyncSucceeded` stripped, since those carry local diagnostics and the endpoint is reachable by any tailnet machine. |

The separate `/federation/media/v1` surface is already versioned and has its
own wire contract in [FEDERATED_MEDIA_PROVIDERS.md](./FEDERATED_MEDIA_PROVIDERS.md).

## Error Responses

All errors return JSON with consistent structure:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "timestamp": 1704067200000,
  "context": {}
}
```

When a route throws without naming a `code`, it is derived from the HTTP status
(`ERROR_CODES_BY_STATUS` in `server/lib/errorHandler.js`, the same table the
agent-tool resource advertises):

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `BAD_REQUEST` | Malformed request |
| 401 | `UNAUTHORIZED` | Authentication missing/rejected |
| 403 | `FORBIDDEN` | Refused, including a shell command outside the allowlist |
| 404 | `NOT_FOUND` | Resource not found |
| 409 | `CONFLICT` | State conflict (duplicate, stale, or already running) |
| 412 | `PRECONDITION_FAILED` | A required setup step is missing |
| 422 | `VALIDATION_ERROR` | Understood but invalid |
| 429 | `RATE_LIMITED` | An action budget was reached |
| 500 | `INTERNAL_ERROR` | Server error (fallback for unlisted statuses) |
| 502 | `BAD_GATEWAY` | An upstream service failed |
| 503 | `SERVICE_UNAVAILABLE` | A dependency is not available |
| 504 | `GATEWAY_TIMEOUT` | A service PortOS called did not answer in time |

Zod request validation (`validateRequest`) answers `400` with
`VALIDATION_ERROR` and the field errors in `context.details`. Domain routes may
also set their own code (for example `MERGE_METHOD_NOT_ALLOWED`) on top of the
status — branch on the status first, and treat an unfamiliar `code` as a
refinement of it.
