# PortOS API and MCP Unified Tool Contract

Status: current implementation audit
Date: 2026-08-28

This document is the implementation-facing bridge between PortOS's exhaustive
HTTP inventory, the governed semantic registry, Persistent Mind, and Agent
Tools (MCP). It records what is shipped and separates it from the long-running
job and confirmation extensions retained in the [unified design spec](./superpowers/specs/2026-08-27-unified-cos-tool-calling-interface.md).

## Audit result

The current source contains:

- 146 mounted HTTP prefixes, 2,138 deduplicated HTTP operations, and 2,141
  route declarations in `server/lib/apiRouteCatalog.generated.json`.
- A Socket.IO inventory derived from server and client call sites on first use,
  then cached for the lifetime of the server process.
- 22 provider-neutral semantic tools: one `cos.create-task` tool and 21
  semantic adapters inherited from the voice registry.
- Five read-only context tools on the Agent Tools MCP transport. The MCP
  transport may additionally advertise the 21 semantic adapters when its
  separate read/write grants are enabled.

The generated route catalog is the exhaustive HTTP map. Socket.IO events are
derived directly from their source declarations, so there is no second checked-in
event manifest to regenerate. The in-app API Explorer and the following endpoints
expose both inventories at runtime:

| Surface | Endpoint | Contract |
|---|---|---|
| HTTP inventory | `GET /api/api-docs/catalog.json` | Searchable route metadata, domains, access classification, side-effect classification, and modeled/generated status. |
| Internal HTTP spec | `GET /api/api-docs/internal/openapi.json` | OpenAPI 3.0.3 for every mounted HTTP operation. Generated operations have path parameters and a default response; modeled operations add richer contracts. |
| Public HTTP spec | `GET /api/api-docs/openapi.json` | OpenAPI 3.0.3 for only APIs exposed through Settings → API Access. |
| Socket.IO inventory | `GET /api/api-docs/events.json` | Searchable event names, direction, and payload-contract status. |
| Socket.IO spec | `GET /api/api-docs/asyncapi.json` | AsyncAPI 3 document for the Socket.IO transport. |
| HTTP tool resource | `GET /api/api-docs/tools.min.json` | Minimized provider-neutral records for the operations annotated `x-portos-tool`, with an HTTP binding and declared failure codes. Schemas are JSON Schema, sized for an agent to read whole. |

Run `npm run generate:api-docs` after HTTP route declarations change. Socket.IO
event declarations require no regeneration; the server derives and caches their
inventory from source.

## Endpoint map

### Governed semantic registry

| Method | Endpoint | Request and response behavior |
|---|---|---|
| `GET` | `/api/cos/tools` | Query: `scope=all\|agent\|mind\|ui\|voice`, optional `intent` (trimmed, ≤500 characters), and `format=portos\|openai\|anthropic\|mcp`. Returns a catalog with an `ETag`; `If-None-Match` returns `304`. |
| `POST` | `/api/cos/tools/call` | Body is a strict `portos_tool_call`. Optional `Idempotency-Key` must equal `requestId`. Authority is derived as the HTTP `ui` principal from the server auth context. |
| `GET` | `/api/cos/tools/calls/:requestId` | Returns the retained normalized result for a process-local call, or `404 TOOL_CALL_NOT_FOUND`. Retention is in memory, so callers must not treat this as durable job history. |

The semantic registry is not a route proxy. A caller supplies a catalog tool
name and typed arguments; it cannot supply a URL, route, shell command, SQL
query, or adapter name. The registry resolves the tool, validates its closed
input schema, checks scope and capabilities, then invokes a named adapter.

### Agent Tools MCP

| Method | Endpoint | Request and response behavior |
|---|---|---|
| `GET` | `/api/agent-context/manifest` | Loopback/origin-checked manifest. It remains readable when the feature is disabled and reports `enabled`, profile, scopes, grants, limits, exclusions, and advertised tool schemas. |
| `POST` | `/api/agent-context/mcp` | Stateless MCP Streamable HTTP. Requires `Accept: application/json, text/event-stream`; supports `initialize`, `ping`, `tools/list`, and `tools/call`. Notifications receive `202`; unsupported GET/DELETE receive `405`. |

The transport accepts loopback socket addresses only and rejects a non-loopback
`Origin`. The normal PortOS authentication gate still applies when an instance
password is configured. Context tools remain read-only. Semantic actions are a
separate default-off grant and are executed through the same registry as the
HTTP and Persistent Mind paths.

### Persistent Mind authority inventory

`GET /api/cos/mind/tools` remains a separate authority view. It reports the
Persistent Mind capability schema, boundaries, task catalog, and grant state;
it is not the generic semantic catalog. Persistent Mind execution uses the
same registry internally and has a five-call semantic/tool budget plus a
five-task-per-turn budget. No new authority is implied by the broader HTTP
inventory.

## Canonical registry entry

The runtime shape is defined by `server/services/cosToolRegistry.js` and
`server/lib/cosToolContracts.js`:

```json
{
  "type": "portos_tool",
  "name": "brain.search",
  "version": 1,
  "providerName": "brain_search",
  "aliases": ["brain_search"],
  "description": "Search the user's brain inbox.",
  "input_schema": {
    "type": "object",
    "required": ["query"],
    "properties": {
      "query": {"type": "string"},
      "limit": {"type": "integer"}
    },
    "additionalProperties": false
  },
  "output_schema": {"type": "object", "additionalProperties": true},
  "policy": {
    "scopes": ["agent", "mind", "ui", "voice"],
    "requiredCapabilities": ["readPortos"],
    "sideEffect": "read",
    "idempotent": true,
    "async": false,
    "confirmation": "none"
  }
}
```

The runtime currently uses `write` and `read` as semantic side-effect values;
the broader design spec's future `local-write`, `external-write`, and
`process-control` taxonomy is not yet the shipped registry vocabulary.
`adapter` is an internal field and is not exposed in public catalog responses.

## Shipped semantic tool definitions

The canonical name is stable; the provider name and legacy alias preserve the
existing voice-tool contract. `readPortos` and `writePortos` are independent
grants. The input details below summarize the source schemas; the live catalog
is authoritative for descriptions and JSON Schema.

| Canonical name | Provider/legacy name | Arguments | Side effect |
|---|---|---|---|
| `brain.capture` | `brain_capture` | `text`; required | write |
| `brain.search` | `brain_search` | `query`; optional `limit` | read |
| `brain.recent` | `brain_list_recent` | optional `limit` | read |
| `health.log.drink` | `meatspace_log_drink` | `name`; optional `count`, `oz`, `abv` | write |
| `health.log.nicotine` | `meatspace_log_nicotine` | `product`; optional `count`, `mgPerUnit` | write |
| `health.today` | `meatspace_summary_today` | none | read |
| `health.log.weight` | `meatspace_log_weight` | `weight`; optional `unit`, `date` | write |
| `health.log.workout` | `meatspace_log_workout` | `type`; optional `durationMinutes`, `intensity`, `notes`, `date` | write |
| `goals.list` | `goal_list` | optional `limit` | read |
| `goals.update-progress` | `goal_update_progress` | `goalQuery`; `progress` | write |
| `goals.log-note` | `goal_log_note` | `goalQuery`; `note`; optional `durationMinutes` | write |
| `system.processes.status` | `pm2_status` | none | read |
| `feeds.digest` | `feeds_digest` | optional `limit` | read |
| `feeds.mark-read` | `feeds_mark_read` | optional `query`, `all`, `feedQuery` | write |
| `journal.append` | `daily_log_append` | `text`; optional `date` | write |
| `journal.read` | `daily_log_read` | optional `date` | read |
| `time.now` | `time_now` | none | read |
| `calendar.today` | `calendar_today` | optional `limit` | read |
| `calendar.next` | `calendar_next` | none | read |
| `weather.now` | `weather_now` | optional `lat`, `lon` | read |
| `cos.agents.status` | `code_agent_status` | none | read |
| `catalog.search` | `catalog_lookup` | `query`; optional `type`, `limit` | read |

All 21 entries are scope-eligible for `agent`, `ui`, and `voice`; the
Persistent Mind `mind` scope additionally includes `cos.create-task`. The
task tool is not in the Agent MCP catalog. It is a Persistent Mind-only
capability and validates its app, provider, model, effort, mode, required
checks, tracker, readiness, and landing policy before queueing.

## MCP context tool definitions

These five tools are advertised from `server/lib/agentContextValidation.js`
and executed by `server/services/agentContextMcp.js`:

| Tool | Input | Output and requirement |
|---|---|---|
| `context_profile` | `{}` | Active profile, enabled scopes, semantic grants, limits, and exclusions. |
| `search_context` | `{ query: string (1–200), scopes?: unique scope[], limit?: 1–25 }` | Bounded items, `total`, `truncated`, `sourceTruncated`, and `sourceStatus`. |
| `get_context` | `{ ref: string (1–180) }` | One item or `null`, plus source truncation/status. An unavailable scope returns `item: null`. |
| `list_context` | `{ scope, cursor?: integer ≥0, limit?: 1–25 }` | Bounded page, `total`, nullable `nextCursor`, truncation, and source status. |
| `resolve_navigation` | `{ query: string (1–200) }` | A navigation match or `null`; requires the `navigation` scope. |

Context items are limited to Navigation, Workspaces, Brain projections, and
Identity-export sections. Profiles are `metadata` and `summary`; summaries
apply high-confidence redaction but are not an anonymization guarantee. The
transport excludes privacy-vault data, credentials, federation/network and
machine identity, repository paths and branches, browser/message history,
health records, and raw personal exports.

## Canonical call and result

The strict call envelope is:

```json
{
  "type": "portos_tool_call",
  "requestId": "example-call-01",
  "name": "brain.search",
  "version": 1,
  "arguments": {"query": "example", "limit": 5}
}
```

`requestId` is required, trimmed, limited to 200 characters, and restricted to
letters, numbers, `.`, `_`, `:`, and `-`. `name` is similarly constrained and
must resolve to a canonical name, provider name, or legacy alias. Unknown
fields are rejected. `type` and `version` default to the current values when
omitted; a future version must be rejected until its compatibility path is
implemented.

A normalized outcome is shaped as follows:

```json
{
  "type": "portos_tool_result",
  "requestId": "example-call-01",
  "name": "brain.search",
  "version": 1,
  "state": "completed",
  "duplicate": false,
  "result": {"ok": true, "count": 0, "hits": [], "summary": "No matches."}
}
```

Adapter failures use `state: "failed"` and a bounded `error` string. A
replayed request with the same canonical tool and normalized arguments returns
the retained result with `duplicate: true`; a reused request ID with different
content returns `409 TOOL_IDEMPOTENCY_CONFLICT`. Results and fingerprints are
process-local and retained only for bounded in-memory windows.

Provider translations are mechanical projections of the same entry:

- OpenAI uses `{ type: "function", function: { name: providerName,
  description, parameters: input_schema } }`.
- Anthropic uses `{ name: providerName, description, input_schema }`.
- MCP uses `name`, `description`, `inputSchema`, `outputSchema`, and standard
  read-only/destructive/idempotent/open-world annotations.

## Authority and bridge

```text
Persistent Mind ─┐
Authenticated UI ─┼─> portos_tool_call -> resolve -> validate -> authorize -> adapter
Agent MCP ───────┘             │
                               └─> portos_tool_result

Agent MCP context tools ───────> read-only context handlers (separate path)
REST/OpenAPI route inventory ──> discovery only; raw routes are never tools
```

| Caller | Server-derived authority | Default | Allowed mutation path |
|---|---|---|---|
| Persistent Mind | `scope: mind`, persisted capability grant | off | `cos.create-task`, semantic writes when separately granted |
| Agent MCP | `scope: agent`, Agent Tools action grant | off | semantic writes when separately granted |
| HTTP registry | `scope: ui`, PortOS auth context | reads may be anonymous on a passwordless install | writes require an authenticated PortOS session |
| Voice adapter | existing voice pipeline context | existing voice policy | existing voice-side confirmation/pipeline controls |

The request body cannot claim a scope, principal, or capability. Catalog
`scope` is a filter, not proof of authority; an `intent` filter only reduces
the advertised voice subset and never authorizes a call. The public API
registry remains separate: CoS tools and Agent MCP do not become externally
exposable merely because they appear in the internal OpenAPI inventory.

## Findings and follow-up boundary

1. **Resolved documentation drift.** The prior unified spec said 2,066 HTTP
   operations, 23 Persistent Mind tools, 22 semantic tools, and a `cursor`
   catalog query. The current generated inventory is 2,069 operations; the
   runtime registry is 22 tools total (21 semantic plus `cos.create-task`),
   and the implemented catalog query is `scope`, `intent`, and `format`.
   The point-in-time spec's implemented-foundation text is corrected in this
   PR.
2. **OpenAPI completeness is intentionally staged.** The internal document is
   exhaustive as an operation inventory, but most operations are marked
   `generated` and expose only path parameters plus a default response. It
   must not be used as if every route already had a stable request/response
   schema. Rich contracts belong in `server/lib/apiOperationContracts.js` and
   must reuse route Zod schemas.
3. **Long-running job semantics are not shipped in the registry yet.** The
   current `cos.create-task` adapter returns a completed tool call whose nested
   result says `state: "queued"`; there is no `/jobs/:jobId/events`, cancel,
   confirm, or durable result endpoint. Those routes remain proposed design
   backlog and must not be advertised by a client generated from this current
   contract.
4. **The five-call budget is a Persistent Mind budget.** It is enforced by the
   Persistent Mind adapter across its bounded turn loop. It is not a generic
   HTTP/MCP rate limit; callers using those transports must rely on grants,
   typed adapters, idempotency, and the deployment trust boundary.
5. **Disabled MCP manifest nuance.** The MCP execution route is blocked while
   the feature is disabled, but a previously saved semantic action grant can
   still appear in the readable manifest because advertised semantic tools are
   derived from action grants independently of `enabled`. This is a discovery
   inconsistency, not an execution bypass; a follow-up should either suppress
   semantic advertisements while disabled or document the intentionally
   inspectable grant state more prominently.

Evidence anchors for these findings are the generated manifest `stats`,
`VOICE_ADAPTERS` in `server/services/cosToolRegistry.js`, the catalog query
schema in `server/lib/cosToolContracts.js`, the async task policy and normalized
result path in `server/services/cosToolRegistry.js`, and
`semanticToolsForConfig`/`getManifest` in `server/services/agentContextMcp.js`.

## Validation

- `node scripts/generate-api-route-catalog.js` — regenerated deterministic
  HTTP manifest: 2,138 operations / 2,141 declarations / 146 mounts.
- `server/lib/socketEventInventory.test.js` — source-derived Socket.IO inventory,
  representative-event coverage, direction normalization, and runner-tree exclusion.
- Focused Vitest execution was attempted but this isolated worktree has no
  installed `server/node_modules` (`vitest: command not found`). No live
  database, provider, MCP client, or personal records were used.
