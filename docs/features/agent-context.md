# Agent Tools (MCP)

PortOS can expose bounded context and governed semantic tools to CoS agents running on the same machine. The surface uses MCP Streamable HTTP, is disabled by default, and never initiates an LLM request. Context scopes, semantic reads, and semantic writes are independently granted.

## Enable it

Open **Settings → API Access → Agent Tools (MCP)** and enable **local MCP context**. The setting is stored machine-locally in the existing `settings.json` store; no context data is copied into a new store. Enabling the transport does not grant semantic reads or writes; both action grants default off.

The endpoint is:

```text
/api/agent-context/mcp
```

Use `http://127.0.0.1:5555` when PortOS is running over HTTP. When PortOS HTTPS is enabled, local scripts can use the loopback HTTP mirror on `http://127.0.0.1:5553`. The runtime manifest is available at `GET /api/agent-context/manifest` even while the MCP endpoint is disabled.

## Network and authentication boundary

The route checks the TCP socket address, not forwarding headers, and accepts only IPv4 or IPv6 loopback callers. A supplied `Origin` header must also identify a loopback origin. Tailnet, LAN, public, proxied, and federated callers are rejected.

The normal PortOS authentication gate runs before this route. If an instance password is enabled, the MCP client must also send a valid PortOS session, Bearer token, or Basic credential.

This first transport is intentionally stateless: it emits no MCP session identifier, accepts JSON responses to POST, and returns `405` for GET/DELETE on the MCP endpoint. It implements protocol version `2025-11-25` and recognizes the compatible `2025-03-26` and `2025-06-18` request headers.

## Disclosure profiles and scopes

The default profile is **Metadata only** with only **Navigation** and **Workspaces** enabled.

| Profile | Returned content |
|---|---|
| Metadata only | Generic record labels, bounded counts, routes, and opaque stable references. Private text can be used for matching but is not returned. |
| Redacted summaries | Selected source summaries after high-confidence secret, email, IP address, home-directory, phone, and explicit coordinate redaction. This is an additional opt-in, not an anonymization guarantee. |

Scopes are independently configurable:

| Scope | Source | Privacy behavior |
|---|---|---|
| Navigation | PortOS navigation manifest | Page labels, aliases, sections, and routes only. |
| Workspaces | Workspace context summaries | Task counts; repository paths, branches, shell sessions, and raw app identifiers are excluded. Workspace identifiers become opaque hashes. |
| Brain | Brain search projections | Opaque record references in metadata mode; redacted projected text only in summary mode. Only projected fields become context candidates; attachments, embeddings, and full records are never returned. |
| Identity | Legacy identity-export preview | Section labels and presence only. Raw export records and generated export files are never returned. |

Privacy Vault records, credentials, secrets, authentication material, federation peers, network topology, machine identity, command/browser/message history, health records, and raw personal exports are excluded from every profile.

## Context tools and budgets

All context tools carry MCP `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`. Their advertised JSON Schemas are generated from the same Zod schemas that validate runtime calls and outputs.

| Tool | Purpose |
|---|---|
| `context_profile` | Inspect active scopes, profile, exclusions, and budgets before querying. |
| `search_context` | Search one or more enabled scopes. |
| `get_context` | Resolve one stable opaque reference. |
| `list_context` | Page through one enabled scope. |
| `resolve_navigation` | Resolve a PortOS page alias when Navigation is enabled. |

Calls are capped at 25 returned items, 1,000 inspected source items per scope, 320 characters per summary, 200 characters per query, 20,000 serialized characters, and approximately 5,000 tokens per structured result. Source failures produce an MCP tool error rather than masquerading as an empty result. A capped scan sets `sourceTruncated: true`; search/list also set `truncated: true`, so partial coverage cannot look complete. Data-bearing results also expose `sourceStatus: "fresh" | "stale"`, so a retained snapshot cannot be mistaken for a live read.

## Semantic action grants

The same MCP endpoint can advertise the curated `portos_tool` catalog used by Persistent Mind and the authenticated HTTP tool adapter. It never turns the HTTP route catalog into callable functions.

| Grant | Default | Capability |
|---|---|---|
| Semantic PortOS reads | Off | Bounded Brain, goals, journal, calendar, health-summary, feed, catalog, time/weather, process-status, and CoS-status adapters. |
| Semantic PortOS updates | Off | Typed Brain capture, journal append, goal progress/notes, health logging, and feed-state actions. |

Every semantic tool has a stable namespaced ID, a provider-safe MCP name, a closed input schema, side-effect/idempotency annotations, and a normalized result. MCP `tools/list` includes only actions granted in Settings. Shell/filesystem access, raw HTTP, arbitrary URLs, SQL, browser control, process control, paid generation, external messaging, credentials, and Persistent Mind task creation are not part of the CoS-agent MCP catalog.

For retry-safe semantic writes, send an `Idempotency-Key` header with the MCP POST. PortOS binds it to the normalized tool call; a repeated key with different content fails rather than executing a different action.

## Context contract evaluation

The public manifest and tool-call contract have a fixture-backed black-box suite. It creates a fresh in-memory contract for every case, replaces every navigation/workspace/Brain/identity source with sanitized fake records, and never reads the running instance, a real workspace, the Privacy Vault, or an AI provider.

Run it from the repository root:

```bash
npm run --silent eval:agent-context -- --failure-threshold 0
```

The command writes one JSON report to stdout and exits non-zero when `fail + error` exceeds the threshold. Every case reports `pass`, `fail`, `error`, or `skip` plus its fixture source and tool pointer. Use `--fixture <path>` to evaluate another declarative suite with the same schema. The checked-in cases cover manifest/runtime parity, read-only annotations, search/list/get/navigation/profile calls, scope and privacy boundaries, result and approximate-token budgets, unknown records, source errors, and stale-source signaling.

## Protocol example

Initialize before listing or calling tools:

```bash
curl -sS http://127.0.0.1:5555/api/agent-context/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": { "name": "Example Client", "version": "1.0" }
    }
  }'
```

Then send `notifications/initialized` and use `tools/list` or `tools/call` on the same URL. Since the server is stateless, there is no session token to retain.
