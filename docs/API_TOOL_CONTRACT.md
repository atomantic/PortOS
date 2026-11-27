# PortOS API and MCP tools

Use the [API guide](API.md) and its generated OpenAPI, AsyncAPI and
catalog resources to discover live HTTP operations and Socket.IO events.
The HTTP inventory describes transport. Semantic tools are a governed
registry of named adapters with closed input schemas and server-derived
authority.

## Catalogs and callers

| Surface | Contract |
| --- | --- |
| `GET /api/cos/tools` | Scope filter (`all`, `agent`, `mind`, `ui`, `voice`), optional voice intent filter, and `portos`, `openai`, `anthropic` or `mcp` formats. Supports ETag revalidation. |
| `GET /api/cos/mind/tools` | Persistent Mind capability boundaries, grants, managed apps and available saved recipes |
| `GET /api/agent-context/manifest` | Agent Tools feature state, profile, scopes, grants, limits and advertised tool schemas |
| `POST /api/agent-context/mcp` | Stateless Streamable HTTP. Send `Accept: application/json, text/event-stream`. Supports `initialize`, `ping`, `tools/list` and `tools/call`. Notifications receive 202. |

Agent Tools accepts only loopback connections and loopback browser
origins. An enabled PortOS password gate still applies. The read-only
context handlers expose scoped Navigation, Workspaces, Brain projections
and Identity-export sections. The manifest supplies the exact schemas
for `context_profile`, `search_context`, `get_context`, `list_context`
and `resolve_navigation`. Profiles limit exposed fields and exclude
credentials, raw personal exports and sensitive local data.

Semantic writes require a caller's existing authority. UI calls use
the PortOS session and voice uses its existing pipeline controls.
Persistent Mind and Agent Tools have separate default-off grants.
A requested catalog scope filters the output and never grants that
scope. Clients supply a named tool and typed arguments. The server
derives scope and principal, resolves the adapter, validates arguments
and checks the active grants before invocation.

## Calls and results

The canonical envelope uses `type: "portos_tool_call"`,
`version: 1`, `requestId`, `name` and `arguments`. Type and version
default to the current values when omitted. The request ID is required,
trimmed, at most 200 characters, and accepts letters, digits,
`.`, `_`, `:` and `-`. The result echoes identifying fields with
`type: "portos_tool_result"`, `state`, `duplicate`, and either
`result` or a bounded error. While a process-local idempotency record
is retained, identical normalized requests replay the result and
a different request under the same ID returns
`409 TOOL_IDEMPOTENCY_CONFLICT`. Provider schemas are projections of
the same catalog.

## Forge issues and saved recipes

Persistent Mind requires its separate `fileIssues` grant and an allowed
managed app with a resolved GitHub or GitLab tracker for `issues.list` or
`issues.file`. Filing requires model and effort dispatch hints and a
successful tracker read. An incomplete list cannot establish that an
issue is absent. Check completeness and use paginated, all-state forge
search for duplicate checks beyond the bounded open-issue list.

Saved `recipe.*` entries expose their active revision, provenance,
invocation schema and availability. Agent Tools needs its own
`callToolRecipes` grant and all underlying agent-scope read grants.
Recipes cannot extend those grants. Each child rechecks live settings,
and agent recipes run at most five child calls. Persistent Mind separately
limits its semantic calls and task creation to five each per turn.
The live catalog and adapter schemas are authoritative.
