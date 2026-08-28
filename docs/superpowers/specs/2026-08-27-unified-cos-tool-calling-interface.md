# Unified CoS Tool-Calling Interface

Status: implemented foundation; future expansion sections retained as design backlog
Date: 2026-08-27
Audience: PortOS server, Persistent Mind, voice, palette, and future agent integrations

> **Verification legend:** **Verified in source** means the current repository
> contains the named route/service contract. **Proposed** means this document is
> defining a new interface. **[VERIFY]** marks a decision or integration detail
> that must be confirmed by the implementation audit before it becomes binding.

## 0. Implemented foundation

The initial production slice is implemented. This section supersedes proposal language elsewhere in the document when the two differ.

- The generated HTTP inventory contains 2,067 mounted operations and feeds `GET /api/api-docs/catalog.json` plus the complete OpenAPI 3.1 document at `/api/api-docs/internal/openapi.json`.
- A generated inventory of 253 Socket.IO events feeds `/api/api-docs/events.json` and the AsyncAPI 3 document at `/api/api-docs/asyncapi.json`.
- `/api/cos/tools` exposes 22 provider-neutral tools: one Persistent Mind task tool plus 21 semantic voice adapters. The `mind` scope can see all 22 when granted; the `agent`, `ui`, and `voice` scopes can see the 21 semantic adapters. OpenAI, Anthropic, and MCP translations derive from the same entries.
- `/api/cos/tools/call` and `/api/cos/tools/calls/:requestId` implement server-derived UI authority, schema validation, normalized results, and replay conflict detection. Raw routes are not callable.
- Persistent Mind has separate default-off read, write, and CoS-task grants and a bounded multi-round tool loop. `cos.create-task` reuses the existing scheduler, worktree, review, CI, and landing-policy path.
- The existing loopback-only Agent Context MCP transport now optionally advertises the same semantic registry under separate default-off CoS-agent read/write grants. Its original bounded context scopes and privacy behavior remain intact.
- The visible `/api-reference/:tab` Explorer provides HTTP catalog, rendered REST reference, event catalog, and agent-tool authority/format views. Navigation is registered in the shared manifest.
- Voice/TTS and A1111 request validation now share canonical Zod contracts with OpenAPI. The semantic grant shape is also shared between Persistent Mind and CoS-agent MCP settings.

The later provider-routing, quota fallback, confirmation-token, media-generation, and generic long-running-job sections remain design backlog. They are not required for the safe local semantic-tool foundation and must not be read as claims about current behavior.

## 1. Decision summary

PortOS should expose one capability-oriented tool interface to the Chief of Staff (CoS) mind. The interface should be a typed JSON HTTP API backed by a server-side adapter registry. Existing REST routes, Socket.IO events, SSE job streams, and the current voice-tool registry remain implementation details behind adapters.

The interface is not a generic HTTP proxy. A raw endpoint proxy would expose inconsistent payloads, leak implementation details into prompts, make destructive operations difficult to gate, and force every model to understand more than 2,000 route handlers. Each tool should represent one user-meaningful operation, declare its risk and lifecycle, and map to one or more existing PortOS services/routes.

### Proposed CoS HTTP surface

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/cos/tools` | Return the current, scope-filtered tool catalog and capability state. Supports `scope`, `intent`, `format`, and conditional `ETag` requests. |
| `POST` | `/api/cos/tools/call` | Execute one tool call synchronously or start its asynchronous job. Requires an idempotency key for mutations. |
| `GET` | `/api/cos/tools/calls/:requestId` | Read the normalized outcome of a prior call, including a job reference when work is still running. |
| `POST` | `/api/cos/tools/calls/:requestId/approve` | Record explicit approval from a separate trusted human/UI session for a pending confirmation. |
| `POST` | `/api/cos/tools/calls/:requestId/cancel` | Cancel a cancellable asynchronous call; delegates to the owning job/run adapter. |
| `POST` | `/api/cos/tools/calls/:requestId/confirm` | Consume a server-recorded human approval and execute a previously confirmation-gated call. |
| `GET` | `/api/cos/tools/jobs/:jobId/events` | Unified SSE progress stream for adapters that can expose progress. The adapter may still use an existing job-specific source internally. |

The exact route names are proposed; implementation should preserve the existing `/api/cos/mind/tools` route for the Persistent Mind authority inventory and should not silently broaden that route. `/api/cos/tools` is the broader CoS execution catalog.

### Preliminary `portos_tool` profile

`portos_tool` is the provider-neutral profile name for a PortOS catalog entry,
call, and result. It is not an additional transport and does not permit a model
to supply an arbitrary route. Provider-specific adapters translate this profile
to OpenAI/Responses, Anthropic, or MCP tool syntax and translate the provider's
tool call back to the canonical PortOS call envelope.

```json
{
  "type": "portos_tool",
  "name": "cos.create-task",
  "version": 1,
  "description": "Queue a supervised PortOS task.",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["mode", "appId", "prompt", "routing"],
    "properties": {
      "mode": {"enum": ["implement", "research-and-file-issue"]},
      "appId": {"type": "string"},
      "provider": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id"],
        "properties": {
          "id": {"type": "string"},
          "model": {"type": ["string", "null"]},
          "effort": {"type": ["string", "null"]}
        }
      },
      "routing": {"enum": ["automatic", "pinned"]},
      "prompt": {"type": "string"},
      "requiredValidation": {"type": "array", "items": {"type": "string"}},
      "prCompletion": {"enum": ["review-then-merge", "merge-on-green", "leave-open", null]}
    },
    "oneOf": [
      {
        "properties": {"routing": {"const": "automatic"}},
        "not": {"required": ["provider"]}
      },
      {
        "properties": {"routing": {"const": "pinned"}},
        "required": ["provider"]
      }
    ],
    "allOf": [
      {
        "if": {"properties": {"mode": {"const": "implement"}}, "required": ["mode"]},
        "then": {
          "required": ["prCompletion"],
          "properties": {"prCompletion": {"enum": ["review-then-merge", "merge-on-green", "leave-open"]}}
        },
        "else": {"properties": {"prCompletion": {"type": "null"}}}
      }
    ]
  },
  "output_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["taskId", "mode", "state", "duplicate"],
    "properties": {
      "taskId": {"type": "string"},
      "mode": {"enum": ["implement", "research-and-file-issue"]},
      "state": {"enum": ["queued", "running", "completed", "failed", "blocked"]},
      "duplicate": {"type": "boolean"},
      "artifact": {
        "oneOf": [
          {"type": "null"},
          {"type": "object", "additionalProperties": false, "required": ["kind", "url"], "properties": {"kind": {"enum": ["issue", "pull-request", "report"]}, "url": {"type": "string"}, "number": {"type": ["integer", "null"]}}}
        ]
      }
    }
  },
  "policy": {
    "scopes": ["mind"],
    "requiredCapabilities": ["cos.create-task"],
    "sideEffect": "supervised-write",
    "idempotent": true,
    "async": true,
    "confirmation": "capability-grant"
  }
}
```

The JSON spelling above is canonical for PortOS. Provider adapters may rename
`input_schema` to `parameters` or another provider field, but stored catalog
definitions, audit events, and validation use this shape. Schemas are closed by
default (`additionalProperties: false`), semantic absence is represented by
`null` or an omitted optional key rather than an empty string, and results must
validate before they are exposed to the model. `provider` is required when
`routing` is `pinned` and omitted when routing is automatic; the `oneOf` above
is the same discriminated union the registry's Zod schema must enforce.

**Proposed call contract:**

```json
{
  "type": "portos_tool_call",
  "requestId": "mind-turn-example-tool-01",
  "name": "cos.create-task",
  "version": 1,
  "arguments": {},
  "context": {"turnId": "turn-example", "source": "persistent-mind"}
}
```

`requestId` is the body representation of the HTTP `Idempotency-Key`.
`context` is correlation-only; the supervisor supplies authority out of band.
The normalized result is the envelope in section 5.3 plus
`type: "portos_tool_result"` and `version: 1`. Provider adapters never return a
raw provider tool-call object or a raw PortOS route response to the mind.

## 2. Audit method and scope

This audit was performed against the current source tree, without reading live personal records or making provider calls. It used:

- `server/index.js` for mounted API prefixes and aliases.
- `server/routes/**/*.js` for route declarations and validation behavior.
- `client/src/services/api*.js` for the client-facing endpoint contract.
- `server/services/voice/tools/*.js` for the existing direct function-tool registry.
- `server/lib/agentContextValidation.js` and `server/routes/agentContextMcp.js` for the existing MCP surface.
- `server/lib/persistentMindCapabilities.js`, `server/services/persistentMindTaskCapability.js`, and the Persistent Mind routes for the current authority boundary.
- `server/lib/apiRegistry.js` and `server/lib/openapiSpec.js` for the intentionally exposed external API subset.

The static inventory contains 146 `app.use` mounts, 214 non-test route modules, and 2,042 non-test route-handler declarations. These are declaration counts, not a claim that every route is independently safe or intended for model exposure. Nested routers, dynamic toolkit routes, aliases, binary responses, and Socket.IO/SSE transports are called out below.

## 3. Existing API surfaces

### 3.1 Authentication and exposure

All `/api/*` and `/data/*` requests pass through `authGate` when an instance password is configured. The always-public HTTP exceptions are authentication status/login/logout/whoami and `/api/system/health`. The external API registry currently re-opens only opt-in, read/compute-safe prefixes for Voice/TTS and A1111-compatible image generation; configuration and process-control routes remain gated.

The unified CoS interface must therefore:

1. Stay under `/api/cos` and use normal PortOS authentication.
2. Never assume that auth is enabled; the default install is passwordless.
3. Never become an accidental public API through `apiRegistry.js`.
4. Preserve CSRF and cross-origin behavior when auth is enabled.
5. Redact credentials, personal records, prompts containing PII, and provider responses from logs and errors.
6. Preserve Agent Tools MCP boundaries: it is loopback-only, origin-checked, and opt-in; its context tools remain read-only while separately granted semantic actions share the canonical registry.

The request body's `context`, including `source`, `mindId`, and `turnId`, is correlation metadata only. It cannot select authority. The server derives the caller and scope from one of these trusted paths: a process-local dispatch context created by the Persistent Mind supervisor; an authenticated, CSRF-checked PortOS UI/voice session; or a short-lived server-issued caller credential bound to a known scope and session. A peer credential derives only the federation scope. A passwordless install must reject direct HTTP mutations and privileged `mind`/`admin` claims unless the request carries such a server-issued credential; it must never treat a client-supplied scope as proof of identity. The catalog's optional scope filter may narrow the derived scope, never widen it.

### 3.2 Existing direct tool registry

`server/services/voice/tools.js` already provides OpenAI-shaped function definitions, intent filtering, metadata, and `dispatchTool`. It currently contains 42 tools:

| Domain | Existing tools | Main underlying capability |
|---|---|---|
| Brain | `brain_capture`, `brain_search`, `brain_list_recent` | Capture and search memory/brain entries. |
| MeatSpace | `meatspace_log_drink`, `meatspace_log_nicotine`, `meatspace_summary_today`, `meatspace_log_weight`, `meatspace_log_workout` | Record or summarize personal health activity. |
| Goals | `goal_list`, `goal_update_progress`, `goal_log_note` | Find goals and record progress. |
| System/feeds | `pm2_status`, `pm2_restart`, `feeds_digest`, `feeds_mark_read` | Inspect/restart PM2 and read/update feed state. `pm2_restart` is destructive. |
| Daily log | `daily_log_open`, `daily_log_start_dictation`, `daily_log_stop_dictation`, `daily_log_append`, `daily_log_read` | Open, dictate, append, and read the daily log. |
| UI | `ui_navigate`, `ui_list_interactables`, `ui_read`, `ui_click`, `ui_fill`, `ui_select`, `ui_check` | Operate the live browser DOM. These require a voice/UI context and are not server-only tools. |
| Ask | `ui_ask` | Ask/advise/draft through the existing ask pipeline. |
| Vision | `ui_describe_visually` | Request a browser screenshot and describe it. Requires a live screen-capture round trip. |
| Ambient | `time_now`, `calendar_today`, `calendar_next`, `weather_now` | Current time, calendar lookup, and weather. |
| Timer | `timer_set` | Schedule a local timer and return its identifier. |
| Media | `image_generate` | Start image generation through the configured backend. |
| Pipeline | `pipeline_next_stage`, `pipeline_prev_stage`, `pipeline_open_stage` | Navigate the current pipeline issue's stage in a live UI context. |
| Coding | `dispatch_code_agent`, `code_agent_status` | Queue a managed coding agent or inspect its status. |
| Catalog | `catalog_lookup` | Bounded search over catalog ingredients, including active custom types. |
| Workspace | `workspace_switch` | Save/restore workspace context without checking out branches or spawning shells. |

The registry is the best starting point for adapter reuse, but it is not yet a complete CoS API: names use voice-era snake_case, some results are prose-oriented, schemas are input-only, side effects are implicit, and UI tools require ephemeral client state. The unified catalog should preserve these names as aliases for compatibility while introducing stable namespaced IDs such as `brain.capture` and `media.image.generate`.

### 3.3 Agent Context MCP

`/api/agent-context` is a separate JSON-RPC/MCP transport:

| Endpoint | Capability |
|---|---|
| `GET /api/agent-context/manifest` | Report enabled state, profile, scopes, budgets, and advertised tools. |
| `POST /api/agent-context/mcp` | MCP `initialize`, `ping`, `tools/list`, and `tools/call`. Notifications/responses receive `202`. |

Its five context tools are `search_context`, `get_context`, `list_context`, `resolve_navigation` (only with the `navigation` scope), and `context_profile`. The surface is loopback-only, rejects non-loopback `Origin`, requires the feature to be enabled and configuration-valid, advertises those context tools as read-only/idempotent/non-destructive, and bounds input/output schemas. Separately granted semantic tools are advertised from the canonical registry and retain their own side-effect annotations; the context scopes themselves remain read-only.

### 3.4 Persistent Mind

The current Persistent Mind routes are:

| Endpoint | Capability |
|---|---|
| `GET /api/cos/mind` | Paginated trajectory/history plus public state, profile, capabilities, harness, and autonomy mode. |
| `GET /api/cos/mind/context` | Prompt, prepared context preview, memories, and rollups. |
| `GET /api/cos/mind/tools` | Persistent Mind capability grants, boundaries, and tool catalog. |
| `GET /api/cos/mind/runtime` | Runtime/provider/model inspection. |
| `POST /api/cos/mind/messages` | Queue a user message; returns `202`. Body is `{ id, text }`. |
| `POST /api/cos/mind/annotations` | Append an idempotent annotation; returns `202`. |
| `POST /api/cos/mind/start` / `pause` / `resume` / `stop` | Lifecycle control. |
| `POST /api/cos/mind/memories` | Create a durable memory. |
| `PUT /api/cos/mind/memories/:memoryId` | Update a memory. |
| `POST /api/cos/mind/events/:eventId/acknowledge` | Add an acknowledgement annotation. |
| `POST /api/cos/mind/events/:eventId/promote` | Promote an event to a durable memory with explicit approval. |

Persistent Mind currently has exactly one granted action capability: `cos.create-task`. It is default-off, limited to five requests per turn, validates configured runnable apps and CLI/TUI coding providers, and routes through the normal isolated-worktree, review, CI, budget, and PR gates. Its explicit boundaries are no arbitrary shell/filesystem access, no direct image/browser tools, and no provider credentials or hidden reasoning tokens. The new interface must not bypass or duplicate this grant; `cos.create-task` should call the same service and retain its replay/idempotency rules.

### 3.5 Public API registry and OpenAPI

The public, externally callable registry contains only:

| API | Opt-in public paths | Operations |
|---|---|---|
| Voice/TTS | `/api/voice/public/` | `POST /synthesize`, `GET /voices`, `GET /engines`. |
| A1111-compatible image generation | `/sdapi/` | `POST /v1/txt2img`, `GET /v1/sd-models`, `/v1/samplers`, `/v1/options`, `/v1/progress`. |

`GET /api/api-docs/openapi.json` documents only currently exposed registry entries and binds voice request schemas to the route contract. The proposed CoS catalog is an authenticated internal product surface and should not be included in the public API registry by default.

## 4. REST capability inventory

The following is the endpoint map used to design adapter domains. Paths are relative to the mount shown in the first column. Repeated CRUD operations are intentionally represented as route families where the parameterized form is obvious; the source route files remain the exhaustive implementation inventory.

### 4.1 Runtime, AI, agent, and developer operations

| Mount | Capability and endpoint families |
|---|---|
| `/api/system` | Health and runtime: `GET /processing`, `/build`, `/health`, `/health/details`; `PUT /health/thresholds`. |
| `/api/system/capabilities` | Local hardware/system selection context: `GET /`. |
| `/api/system-resources` | Resource reporting/triage: `POST /report`, `/triage`. |
| `/api/capabilities` | Connected-system capability map: `GET /`. |
| `/api/providers` | Provider CRUD/selection/status/readiness, runtime installation, vision health/tests, and TUI launch: `GET /`, `/active`, `/samples`, `/runtimes`, `/readiness`, `/status`, `/:id`, `/:id/status`, `/:id/vision-health`; `PUT /active`, `/:id`; `POST /`, `/readiness/setup`, `/readiness/serve-model`, `/runtimes/install`, `/opencode/install`, `/:id/status/recover`, `/:id/test-vision`, `/:id/vision-suite`. |
| `/api/runs` | AI run history, run creation/status/stop and streaming lifecycle from the vendored AI toolkit. Exact operations are generated by `createPortOSRunsRoutes(aiToolkit)`. |
| `/api/prompts` | Prompt/stage CRUD, variables, usage, preview, skills jobs, and reload: `GET /`, `/variables`, `/skills/jobs`, `/:stage`; `POST /`, `/variables`, `/skills/jobs/...`, `/:stage/preview`, `/reload`; `PUT /variables/:key`, `/skills/jobs/:name`, `/:stage`; `DELETE /variables/:key`, `/skills/jobs/:name`, `/:stage`. |
| `/api/local-llm` | Local backend/model catalog, installation, switching, loaded-model lifecycle, tests, comparisons, assessments, capability tests, llama-server and MTPLX lifecycle. Includes `/status`, `/catalog`, `/test`, `/compare`, `/assessments/*`, `/capability-tests/*`, `/llama-server/*`, and `/mtplx/*`. |
| `/api/lmstudio` | LM Studio status/models, load/unload, completion, embeddings, analysis, memory classification, config, thinking stats, and cache reset. |
| `/api/code-review` | Review defaults and local review execution: `GET /defaults`, `POST /local`. |
| `/api/agents` | Running-agent listing/status/deletion: `GET /`, `/:pid`; `DELETE /:pid`. |
| `/api/agents/personalities` | Agent personality CRUD, generation, and enable toggle. |
| `/api/agents/accounts` | External agent-account CRUD, test, and claim. |
| `/api/agents/schedules` | Automation schedule CRUD, stats, toggle, and manual run. |
| `/api/agents/activity` | Agent/activity timelines, stats, cleanup, run-event projections/reconciliation. |
| `/api/agents/tools` | Moltbook-style agent feed, preview generation, publishing, engagement, drafts, rate limits, and post checks. |
| `/api/agents/tools/moltworld` | Moltworld join/build/explore/think/say/status/balance/rate limits and queued work. |
| `/api/agents/tools/moltworld/ws` | Moltworld connection and movement/interactions over an HTTP control wrapper. |
| `/api/feature-agents` | Feature-agent CRUD, start/pause/resume/trigger/stop, runs, and output. |
| `/api/cos/gsd` | Managed-app GSD projects, concerns, phases, actions, and project documents. |
| `/api/cos` | CoS status/config, task CRUD/approval/challenge/spawn, schedules/jobs, reports/briefings, learning, workflow, templates, agent lifecycle, insights, and Persistent Mind routes listed above. |
| `/api/tools` | Registered tool CRUD plus enabled list and prompt summary. This is an administrative tool registry, not the new execution contract. |
| `/api/search` | Global search: `GET /`; adapter must require a bounded query and return source-qualified results. |
| `/api/palette` | Navigation/action manifest and palette-safe action dispatch: `GET /manifest`, `POST /action/:id`. The new registry supersedes this as the model-facing dispatch surface while preserving palette behavior. |
| `/api/commands` | Allowlisted command execution, stop, allowed commands, PM2 processes, and monitor status. High risk; never expose as a generic CoS tool. |
| `/api/shell` | Session image endpoint; interactive shell control is Socket.IO. Never expose arbitrary shell through the unified catalog. |
| `/api/git` | Repository status/diff/commits/stage/unstage/commit/branches/pull/push/merge/checkout/reset/cleanup/delete. High risk; expose only task-level, policy-bound operations. |
| `/api/github` | Repository sync/archive, secrets, and GitHub status. Secrets are never tool results. |
| `/api/update` | Update status/check/ignore, fork sync, and execute. `sync-fork` and `execute` require an explicit administrative capability. |
| `/api/apps` | App CRUD/archive, lifecycle start/stop/restart/update/build/logs/status, native launch, editor/folder/Xcode/Claude launch, documents, issues, pull requests, task types, work items, layered intelligence, TLS checks, icons, agents, and sprite bindings. |
| `/api/apps/:appId/reference-repos` | Reference-repository CRUD, check, and mark-reviewed. |
| `/api/workspace-contexts` | List/read/save/restore/delete app workspace snapshots. |
| `/api/ports` | Scan/check/allocate ports. |
| `/api/detect` | Detect repository, port, PM2, and AI characteristics. |
| `/api/scaffold` | List directories/templates and create scaffold/template projects. |
| `/api/logs` | Process/app logs. |
| `/api/history` | Action history/stats and deletion. |
| `/api/usage` | Usage, subscriptions, provider/Claude reports, raw/backfill, session/message/token recording, and clear. |
| `/api/quota-burn` | Quota-burn config/catalog/run/rearm. Any run must be explicit and consented. |

### 4.2 Brain, memory, personal context, and communication

| Mount | Capability and endpoint families |
|---|---|
| `/api/brain` | Brain capture/inbox/review/fix, people/projects/ideas/admin/memories CRUD, daily log, digests/reviews, links/buckets, graph, settings/summary, sync/reconcile/embeddings, songbook, and YouTube ingest. |
| `/api/brain/import` | ChatGPT/import sources, preview, JSON/ZIP import, and archive retrieval. Import is PII-bearing and remains explicit. |
| `/api/memory` | Memory list/stats/categories/tags/timeline/graph/backend status, search/create/update/delete, consolidate/link/decay/expiry, approval/rejection, sync, and embeddings. |
| `/api/catalog` | Scrap ingest/extraction/commit, ingredient/custom-type CRUD, revisions/restore, tags/facets/refs/relations/media, bulk import/export/sync, embeddings backfill, migration rerun, and stats. |
| `/api/notes` | Vault CRUD, scan, note CRUD, bounded search/tags/folders/graph. |
| `/api/ask` | Ask-record list/read/create/delete and promote to memory. |
| `/api/calendar` | Account CRUD, event reads, sync/status/discovery/push, Google auth, review history, and debug token helpers. Debug routes must never be model-exposed. |
| `/api/messages` | Message accounts, sync/inbox/triage, draft CRUD/generation/approval/send, launch, provider selectors, thread/message reads/actions, and token debug. Sending is confirmation-gated. |
| `/api/contacts` | Setup/status/sync/search/resolve, enrich/suggest/import to Tribe. |
| `/api/tribe` | People/care/outreach, touchpoints, and person-memory CRUD. |
| `/api/imessage` | Setup/status/sync, conversations/events, blocklist, stats, and deletion. |
| `/api/signal` | Setup/status/sync. |
| `/api/spotify` | Status, OAuth credentials/url/callback/clear, and sync. |
| `/api/youtube` | Setup/status/sync. |
| `/api/telegram` | Status, method/config, test, forwarding types, bridge reload. Sending/config mutation is confirmation-gated. |
| `/api/notifications` | List/count/read/read-all/delete. |
| `/api/review` | Review items/counts/briefing/queue, resolve/promote/todo, item update/complete/dismiss/bulk-status/delete. Human-review state is not silently mutated by the mind. |
| `/api/timeline` | Day/events and imports from Spotify, Takeout, Discord, WhatsApp, browser, YouTube, and Gmail. Imports are asynchronous or potentially PII-bearing. |
| `/api/feeds` | Feed/item listing/stats/create/refresh/read/delete. |
| `/api/stacker-news` | Accounts, territories, items, analysis, action drafts/reviews/execution, and event streams. External publishing is confirmation-gated. |
| `/api/x` | X accounts/capabilities/posts/drafts, sync/open, draft review/open. External publishing is confirmation-gated. |

### 4.3 Health, identity, privacy, and lifestyle

| Mount | Capability and endpoint families |
|---|---|
| `/api/meatspace` | Core config/lifestyle/death clock, alcohol, nicotine, health measurements, calendar/activities/life events, POST training/drills/cache, and export. Personal data; scope and redaction required. |
| `/api/meatspace/genome` | Genome upload/scan/search/markers, ClinVar, epigenetic records/recommendations/compliance. Highly sensitive; never default-expose. |
| `/api/health` | Apple Health ingest, available/latest/range/correlation metric reads, XML import. Highly sensitive. |
| `/api/digital-twin` | Status/settings, documents, personas, taste, identity traits/confidence/gaps, evidence, enrichment, feedback, snapshots, tests, import/export, avatar biography. Highly sensitive and mostly user-controlled. |
| `/api/digital-twin/identity` | Identity/chronotype/longevity/goals, milestones/progress/activities/todos/calendars, scheduling and derived insights. Highly sensitive. |
| `/api/digital-twin/autobiography` | Autobiography config/themes/prompts/stories, follow-ups/chain/weave, trigger. Highly sensitive. |
| `/api/digital-twin/social-accounts` | Social account CRUD and platform stats. Credentials are never returned to tools. |
| `/api/insights` | Genome health, themes/narrative refresh, goal scorecard and rules/settings. Reads may be exposed by explicit scope; refresh/compute is a mutation. |
| `/api/privacy` | Privacy subjects/consents/status, vault/secret reveal, organizations/holdings, changes, brokers/cases, scans, opt-out and schedule. This is a hard deny by default for model tools; reveal is never a tool. |
| `/api/character` | Character/status, XP/damage/rest/event and Jira/task sync/reset. Mutating game-state operations need an explicit capability. |
| `/api/mortalloom` | Status/app-store/import. Health-document import is sensitive and should remain UI-only until a consented adapter exists. |

### 4.4 Creative, media, and production pipelines

| Mount | Capability and endpoint families |
|---|---|
| `/api/media` | Capture-device status/start/stop and audio/video reads. Device control is explicit and confirmation-gated. |
| `/api/media/collections` | Collection/item CRUD and bulk item mutation. |
| `/api/media/annotations` | Annotation list and keyed patch. |
| `/api/media/sketches` | Sketch create/read PNG/update. |
| `/api/media-jobs` | Job list/read/cancel/retry/delete/run-now, prompt refinement, prompt-from-media, cancel queued. |
| `/api/image-gen` | Styles/status/active/models/LoRAs/gallery, generation/avatar/upload, model lifecycle, job events/cancel, image visibility/prompt/cleanup/watermark/regeneration. Generation is async and provider-spend-bearing. |
| `/api/video-gen` | Runtime/model/encoder setup, generation, active/history/upload, events/cancel, last-frame/upscale/stitch, and model/encoder repair/download. Generation and downloads are spend/resource-bearing. |
| `/api/sdapi/v1` | A1111 compatibility: options, model/sampler/video catalogs, progress, txt2img. |
| `/api/image-video/models` | Image/video model registry/search/install/custom/delete. |
| `/api/loras` | LoRA list/search/suggestions/auth/install/effect/update/delete and character lookup. |
| `/api/lora-datasets` | Dataset/image CRUD, generation/import/caption/slicing/stripping and caption-run events. |
| `/api/lora-training` | Training run status/create/list/read/events/cancel/resume/delete/checkpoints/samples/promote. Long-running and resource-heavy. |
| `/api/image-clean` | Image cleaning operations; route definitions are dynamic and must be wrapped by an explicit adapter rather than proxied. |
| `/api/image-to-3d` | Targets/install/model CRUD/assets/generation. Generation/download is resource-heavy. |
| `/api/threejs-models` | Model CRUD/families/source/generation. |
| `/api/sprites` | Sprite CRUD, references, animation tracks/providers, generation/approval/reopen/locking, walk/atlas compile/publish and assets. |
| `/api/music` | Engines/runtime/models, describe/lyrics/generate. Generation is provider/resource-bearing. |
| `/api/tracks` | Track/library/import/audio/chiptune/render/publish/render-selection lifecycle. |
| `/api/albums` | Album CRUD. |
| `/api/artists` | Artist CRUD. |
| `/api/music-video` | Music-video CRUD/clone/analyze/plan/scenes, MIDI transcription, render and events/cancel. |
| `/api/video-timeline` | Timeline project CRUD/render/events/cancel. |
| `/api/creative-director` | Project CRUD, tools, auto-cast, treatment/plan/directive/replan, scene updates and start/pause/resume/stop/smoke-test. The creative tool catalog is a separate nested capability source. |
| `/api/creative-commission` | Commission CRUD, run, feedback, delete. |
| `/api/mood-boards` | Mood-board/item CRUD, style synthesis, Pinterest sync. |
| `/api/games` | Game CRUD/integrity, sprite/music/artwork bindings/publish, compile, feedback. |
| `/api/fableloom` | Interactive-fiction CRUD, episodes/nodes/transitions, weave/branch/review/play/reformat. |
| `/api/writers-room` | Folder/work/exercise CRUD, drafts/versions, analysis/polish, previews, CD bridge, synced review, characters/places/objects and scene images. |
| `/api/universe-builder` | Universe CRUD/styles/runs, expansion/variations/prompts, render/export, canon/characters, vision/reference sheets/style references, merge and locking. |
| `/api/pipeline` | Series/issues/seasons, stage generation/restoration/visuals, storyboards/comic pages/video, audio/cover, canon, manuscript/reverse outline, editorial checks/review/fix, autopilot, and many progress/status/cancel streams. |
| `/api/story-builder` | Story CRUD/steps/locks/generation/refinement/issues/sync/reconcile. |
| `/api/rounds` | Round CRUD, reference-audio import/transcribe, generate/evaluate/derive parts. |
| `/api/conflict-journal` | Conflict list/read/resolve/delete. |
| `/api/rapid-reader` | Accelerando read operation. |
| `/api/browser` | Browser config/launch/stop/restart/navigate/health/process/pages/version/logs/downloads/delete. Browser control is UI/admin-only by default. |
| `/api/remote-desktop` | Status and remote-desktop session creation. UI-only and confirmation-gated. |
| `/api/screenshots` | Upload/read screenshots. |
| `/api/uploads` | Upload/list/read/delete. Binary data needs an asset-reference contract. |
| `/api/attachments` | Upload/list/read/delete attachments. |
| `/api/backup` | Status/run/list/download/restore/restore-db. Destructive and never an autonomous default tool. |
| `/api/data` | Data categories/list/backups/archive/delete. Administrative/destructive. |
| `/api/database` | Database status/switch/sync/start/stop/destroy/setup/export/fix. Hard deny to model tools. |
| `/api/openworld` and `/api/city` | Snapshot capture/list, introspection, config; `/api/city` is a backward-compatible alias. |
| `/api/legacy-export` | Preview/export. |
| `/api/standardize` | Analyze/apply/template/backup. Applying changes is confirmation-gated. |
| `/api/importer` | Config/classify/analyze/retry/commit. Imports may contain PII and should be explicit. |
| `/api/authors` | Author CRUD. |
| `/api/sync` | Data-sync tombstone status/sweep, category checksum/snapshot/apply, and sync listing. Federation/version gates apply. |
| `/api/loops` | Loop CRUD, provider list, stop/resume/trigger/delete. Autonomous execution requires an explicit schedule/authority. |

### 4.5 Cross-cutting, UI, and administrative mounts

| Mount | Capability and endpoint families |
|---|---|
| `/api/auth` | Auth status/whoami/login/logout/password set/delete. Authentication operations are infrastructure, not CoS tools. |
| `/api/alerts` | Proactive alert list and summary: `GET /`, `/summary`. |
| `/api/avatar` | GLB avatar `HEAD/GET /model.glb`. Binary asset read only. |
| `/api/network-exposure` | Network exposure status: `GET /status`. |
| `/api/dashboard/layouts` | Dashboard layout list/active/update/delete. |
| `/api/dashboard/daily-actions` | Dashboard daily-action list: `GET /`. |
| `/api/daily-driver` | Daily-driver state read and handled marker: `GET /`, `POST /handled`. The GET records a visit and is not a pure read. |
| `/api/client-errors` | Redacted client-error ingestion: `POST /`, returns `202`; never expose as a model tool. |
| `/api/autofix` | Auto-fix metrics: `GET /metrics`. |
| `/api/model-personality` | Explicit provider/model personality test, history delete, and scorer settings. Only `POST /run` calls an LLM and requires a named provider/model. |
| `/api/voice` | Authenticated voice config/status/voices, Piper fetch, TTS test/speak, Kokoro status/unload, and Whisper start/stop. `/api/voice/public` is the separate opt-in external TTS surface. |
| `/api/api-docs` | Authenticated catalogs and specifications: exposed/public and complete/internal OpenAPI 3.1, generated HTTP metadata, generated Socket.IO metadata, and AsyncAPI 3. |
| `/api/openclaw` | OpenClaw status/session/message reads and message send/stream. External agent messaging; stream/send require explicit policy and confirmation. |
| `/api/midi-runtime` | SSE installer: `GET /install`; multi-GB runtime setup, not a model tool. |
| `/api/devtools/video-download` | Video download/list/delete, progress SSE, cancel. Download starts external network and disk work; confirmation-gated if ever exposed. |
| `/api/settings` | Settings read/features/AI assignments and polymorphic settings update. Secrets are stripped from reads; generic settings mutation is admin-only. |
| `/remote-desktop` | Viewer/static VNC surface outside `/api`; the session API is under `/api/remote-desktop`. Never expose viewer control to the model. |

### 4.6 Federation and integrations

| Mount | Capability and endpoint families |
|---|---|
| `/api/instances` | Local/assignable instances, self and peer CRUD, announce/connect/probe/sync/query/coverage. Peer credentials never enter tool results. |
| `/api/peer-sync` | Record/category/manifest/integrity push/pull/sync operations. Machine-local record privacy and version gates remain mandatory. |
| `/api/sharing` | Sharing buckets/subscriptions/inbox/activity and promote/dismiss/export. PII and external fan-out require explicit scope. |
| `/api/federation/media/v1` | Federated media status/assets/jobs/results/cancel. Submitted conditioning may cross only an allowlisted peer under the existing media-input rules; weights and chain state do not. |
| `/api/jira` | Instance/project/ticket CRUD, comments/labels/transitions, boards/sprints/epics, and reports. Ticket writes are external mutations and confirmation-gated unless the task capability explicitly authorizes them. |
| `/api/datadog` | Datadog instance CRUD, test, and error search. Secrets are write-only/config-only. |
| `/api/spotify`, `/api/youtube`, `/api/x`, `/api/telegram`, `/api/signal`, `/api/imessage` | External account/auth/sync/publish surfaces as described above. OAuth callbacks and debug token endpoints are never tools. |

## 5. Unified tool model

### 5.1 Catalog response

`GET /api/cos/tools` returns a stable envelope:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-27T12:00:00.000Z",
  "scope": "mind",
  "capabilities": {
    "brain.read": true,
    "brain.write": true,
    "cos.create-task": false,
    "media.generate": false
  },
  "tools": [
    {
      "id": "brain.capture",
      "aliases": ["brain_capture"],
      "version": 1,
      "title": "Capture to Brain",
      "description": "Store a durable brain entry from user-provided text.",
      "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
      "outputSchema": {"type": "object", "required": ["ok", "entry"]},
      "annotations": {
        "readOnlyHint": false,
        "destructiveHint": false,
        "idempotentHint": true,
        "async": false,
        "requiresConfirmation": false,
        "privacyClass": "personal"
      },
      "requiredCapabilities": ["brain.write"],
      "transport": "direct",
      "source": {"kind": "service", "module": "server/services/voice/tools/brain.js"}
    }
  ],
  "nextCursor": null
}
```

The catalog must contain input and output JSON Schemas, not only prose. Schemas should be derived from the same Zod definitions used at the route/service boundary wherever possible. Catalog entries are filtered by the caller's scope and current feature/provider/account readiness; unavailable tools remain discoverable only when useful for explaining setup, with `available: false` and a machine-readable `unavailableReason`.

### 5.2 Call request

```json
{
  "name": "brain.capture",
  "arguments": {"text": "A fictional example entry."},
  "requestId": "mind-turn-01-tool-01",
  "context": {
    "mindId": "persistent",
    "turnId": "turn-example-01",
    "source": "persistent-mind"
  }
}
```

`Idempotency-Key` is the preferred HTTP header and `requestId` is retained in the JSON body for model/tool protocols that cannot set headers. The server rejects a missing key for mutations, normalizes the request, computes a canonical argument digest, and returns the stored result for an identical replay. A reused key with a different tool or digest returns `409 IDEMPOTENCY_KEY_REUSED`.

`context` is accepted for correlation but is not an authority input; the server ignores any client attempt to set `actor` or `scope`. For a model-facing call, the server derives `actor.kind: persistent-mind` and `scope: mind` only from the process-local supervisor or its server-issued caller credential. A UI or voice pipeline receives its corresponding derived scope from its trusted session/context.

The adapter receives a normalized context:

```js
{
  requestId,
  argumentDigest,
  actor: { kind: 'persistent-mind' | 'voice' | 'palette' | 'user' },
  scope: 'mind' | 'voice' | 'admin',
  turnId: string | null,
  signal,
  approval: { tokenId, confirmedAt } | null
}
```

The client-supplied actor is an audit hint, not an authorization grant. Authorization is resolved server-side from the authenticated session, feature settings, Persistent Mind capability grants, provider/account readiness, and tool policy.

### 5.3 Normalized call result

Every successful HTTP response uses the same shape:

```json
{
  "ok": true,
  "requestId": "mind-turn-01-tool-01",
  "tool": "brain.capture",
  "status": "completed",
  "result": {"entry": {"id": "example-entry-01"}},
  "summary": "Captured the entry to Brain.",
  "job": null,
  "warnings": []
}
```

Asynchronous work returns `202` with `status: "accepted"` and a stable `job` object:

```json
{
  "ok": true,
  "requestId": "example-request-02",
  "tool": "media.image.generate",
  "status": "accepted",
  "result": null,
  "summary": "Image generation started.",
  "job": {"id": "example-job-02", "status": "queued", "eventsUrl": "/api/cos/tools/jobs/example-job-02/events", "cancelable": true},
  "warnings": []
}
```

The final result at `GET /api/cos/tools/calls/:requestId` uses the same envelope with `status` equal to `completed`, `failed`, `cancelled`, or `expired`. `result` is always schema-valid when `ok: true`; a failed call uses `ok: false` and the error shape below.

### 5.4 Confirmation

Tools annotated `requiresConfirmation: true` never perform their side effect on the first call. They return `200` with a structured tool outcome:

```json
{
  "ok": false,
  "requestId": "example-request-03",
  "tool": "messages.send",
  "status": "confirmation_required",
  "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "This will send a message to the selected recipient."
  },
  "confirmation": {
    "reference": "opaque-pending-confirmation-reference",
    "expiresAt": "2026-08-27T12:05:00.000Z",
    "digest": "sha256:example",
    "summary": "Send the drafted message to the selected recipient."
  }
}
```

The response contains only a non-authorizing pending reference. It contains no usable approval token, and the model-facing caller cannot approve its own external send, process control, or provider-spend request. The reference is bound to the actor, tool, normalized arguments, request ID, and digest and expires quickly.

Confirmation is an explicit idempotency state transition, not a second invocation of the adapter:

1. The initial call atomically creates an idempotency record in `preflight_confirmation` with the normalized-argument digest, actor, tool, confirmation-reference digest, expiry, and the complete `confirmation_required` envelope. It performs no side effect. A replay with the same key returns that envelope, including while it is pending.
2. A separate trusted human/UI session presents the summary and calls `POST /api/cos/tools/calls/:requestId/approve`. The server verifies the session or server-issued UI approval credential, CSRF/origin rules, request digest, and expiry, then records one approval bound to that request and approving session. The approval record is not returned to the model caller and cannot be created by the model-facing dispatch path.
3. The UI session calls `POST /api/cos/tools/calls/:requestId/confirm` with `{ "approvalId": "..." }`. The server validates the one-shot, server-recorded approval and atomically compare-and-swaps `preflight_confirmation` to `accepted`. Only the winner may enqueue or execute the adapter. A different actor, digest, expired approval, or already-consumed approval returns `409 CONFIRMATION_INVALID` and does not invoke the adapter.
4. The winner stores the normal `accepted`/`running` record before dispatch and transitions it to one terminal result: `completed`, `failed`, `cancelled`, or `expired`. The original request and later confirmation retries return the stored terminal envelope with `replayed: true`; they never run the adapter again. A confirmation retry while execution is still active returns the stored `accepted`/`running` state and job reference.

The approval endpoint accepts only the pending confirmation reference and no replacement tool arguments. It returns an approval ID only to the approving UI session; the model-facing result and trajectory contain the summary and pending reference, never the approval ID. On a passwordless install, the UI approval credential is a server-issued, short-lived, same-origin browser context; a bare HTTP client cannot manufacture it or self-approve.

The approval consume, compare-and-swap, and terminal-result write are serialized by the same request record. Approval IDs and references are stored only as digests, and the record is retained for the normal idempotency retention period so a retry cannot create a duplicate external effect. Destructive operations, external sends/publishes, process/database controls, provider-spend operations, and privacy-sensitive reveals are confirmation-gated or denied outright.

### 5.5 Errors

Transport and validation errors retain the standard PortOS envelope:

```json
{
  "error": "Validation failed: text: Required",
  "code": "VALIDATION_ERROR",
  "timestamp": 1788000000000,
  "context": {"field": "text"}
}
```

The interface adds stable codes without exposing stack traces or secrets:

| Code | HTTP status | Meaning and model behavior |
|---|---:|---|
| `TOOL_NOT_FOUND` | 404 | Refresh catalog; do not retry unchanged. |
| `TOOL_UNAVAILABLE` | 409 | Tool exists but feature/provider/account is not ready; report setup reason. |
| `TOOL_SCOPE_DENIED` | 403 | The current mind/actor lacks the declared capability; do not retry. |
| `VALIDATION_ERROR` | 400 | Arguments do not satisfy the input schema; correct arguments. |
| `CONFIRMATION_REQUIRED` | 200 tool result | Side effect was not performed; ask the supervising UI/user to confirm. |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key was used with another call; generate a new request ID only when the operation was not actually replayed. |
| `CONFLICT` / `INVALID_STATE` | 409 | Current record/job lifecycle prevents the operation; re-read state. |
| `NOT_FOUND` | 404 | Target record/job does not exist. |
| `RATE_LIMITED` | 429 | Honor `Retry-After`; do not spin. |
| `PROVIDER_UNAVAILABLE` / `SERVICE_UNAVAILABLE` | 503 | Retry only if the catalog says the operation is retryable and with backoff. |
| `UPSTREAM_ERROR` / `BAD_GATEWAY` | 502 | External dependency failed; preserve a safe upstream summary. |
| `CANCELLED` | 200 final result | Work stopped intentionally; no automatic retry. |
| `INTERNAL_ERROR` | 500 | Stop and surface the request ID for diagnostics; never expose internals. |

The adapter boundary must map service errors to these codes using the existing `ServerError`/`asyncHandler` conventions. It must never convert a valid empty result into an error or a failed fetch into an empty success; use explicit status/sentinel fields.

## 6. Adapter and routing design

### 6.1 Registry structure

Add a server-side registry, for example `server/services/cosToolRegistry.js`, with one definition per tool and an adapter implementation per operation:

```js
{
  id: 'brain.capture',
  aliases: ['brain_capture'],
  scopes: ['mind', 'voice', 'palette'],
  capabilities: ['brain.write'],
  inputSchema,
  outputSchema,
  annotations: { readOnly: false, destructive: false, idempotent: true, async: false, confirmation: false },
  execute: (args, context) => ...,
}
```

The registry should be pure metadata plus adapters. It should not import browser state, credentials, raw request objects, or provider-specific UI code. Existing `dispatchTool` entries can be wrapped first; route-backed adapters should call domain services where available, not loop back through HTTP.

### 6.2 Mapping rules

1. Prefer a domain service over an internal HTTP request.
2. Reuse route Zod schemas or extract shared schemas; do not create a looser tool-only validator.
3. Keep tool arguments semantic (`goalQuery`, `workspace`, `prompt`) while route IDs and pagination stay inside the adapter when the operation is user-facing.
4. Return stable IDs, typed records, counts, state, and job references. Put spoken prose only in `summary`.
5. Preserve absent versus intentionally empty values through every adapter merge.
6. For APIs that already return a job ID plus events/cancel endpoints, register one async tool and normalize its `eventsUrl`, cancellation, and terminal state.
7. For Socket.IO-only features, expose a tool only if the server can perform the action without a live browser/socket context. Otherwise expose a UI intent tool in the voice-only scope, not a server CoS tool.
8. For raw binary/download responses, return an opaque asset reference with media type, byte size, checksum, and an authenticated `/data` URL; never embed unbounded base64 in an LLM result.
9. For paginated reads, require bounded defaults and return `nextCursor`; do not hand the model an unbounded collection.
10. Keep aliases stable but emit canonical IDs in new prompts and results.

### 6.3 First adapter wave

The first implementation should migrate the existing semantic tools and a small number of safe, high-value reads:

| Canonical tool | Source | Initial policy |
|---|---|---|
| `brain.capture`, `brain.search`, `brain.recent` | Existing Brain voice tools and `/api/brain` services | Enabled for `voice`/`palette`; personal-data scope. `mind` requires the explicit capability below. |
| `memory.search`, `memory.get` | `/api/memory/search`, `/api/memory/:id` | Read-only, bounded, redacted. |
| `goal.list`, `goal.update-progress`, `goal.log-note` | Existing goal voice tools and Digital Twin goal services | Reads may be exposed to `mind`; writes are initially `voice`/`palette` and idempotent by request ID. |
| `calendar.today`, `calendar.next` | Existing ambient voice tools and calendar services | Read-only; account selection stays server-side. |
| `health.summary-today`, `health.log-weight`, `health.log-workout` | Existing MeatSpace voice tools | Summary may be exposed to `mind`; writes are initially `voice`/`palette` and require an explicit personal-health capability. |
| `catalog.lookup` | Existing catalog voice tool | Bounded result; custom type enum from current registry. |
| `feeds.digest`, `feeds.mark-read` | Existing feeds voice tools | Read and low-risk mutation. |
| `time.now`, `weather.now` | Existing ambient voice tools | Read-only. |
| `cos.create-task` | Persistent Mind task capability service | Default-off; never bypass task catalog, provider validation, or PR gates. |
| `ui.navigate` | Existing `ui_navigate` | Only in a live UI/voice scope; not executable by headless Persistent Mind. |
| `media.image.generate` | Existing `image_generate` plus image-gen job services | Default-off; provider/model and spend disclosure; async. |
| `code-agent.status` | Existing `code_agent_status` | Read-only status. |

Do not include `pm2.restart`, generic `/api/commands/execute`, shell, database, backup restore, privacy vault reveal, OAuth/debug token routes, or outbound send/publish tools in the first wave.

### 6.4 Persistent Mind compatibility gate

The current Persistent Mind capability schema is strict and grants only the default-off `createTasks` capability. This proposal does not silently widen authority for existing conversation-only installs. Until the capability work is shipped, the first-wave write tools above are registered for `voice` and `palette` only; `mind` receives read-only tools that are already covered by its context contract.

To add a typed action to `mind`, the implementation must add a named default-off capability (for example `brainWrite`, `goalsWrite`, or `healthWrite`) to the canonical Persistent Mind schema and catalog, persist it through a migration in `scripts/migrations/` with its seed in `data.reference/`, and expose its grant/revoke control in the Persistent Mind UI. Existing records must retain their prior effective authority after migration. The call path revalidates the stored grant, actor, tool, and scope at execution time; a generic `mind` scope or global default never implies a write grant. The tool manifest must advertise the capability requirement and the call must return `CAPABILITY_REQUIRED` when it is absent.

### 6.5 Verified endpoint-to-tool mappings

The following mappings are the preliminary bridge from current PortOS entry
points to `portos_tool`. “Adapter” means an in-process service call; none of
these tools may proxy arbitrary HTTP.

| Canonical tool or supervisor operation | Current source | Normalized input | Normalized output | Status |
|---|---|---|---|---|
| `cos.create-task` | `GET /api/cos/mind/tools`, `persistentMindTaskCapability.js`, `POST /api/cos/tasks` | app/provider/model/effort, prompt, mode, validation, PR policy | task ID, queue state, duplicate flag, eventual artifact | **Verified in source**; canonical wrapper proposed. |
| `cos.research.file-issue` | Same capability with `planOnly: true`; `plan-task` workflow | app, research question, acceptance criteria, provider preference | task ID, then GitHub/GitLab issue URL/number | **Verified in source** for plan-and-file; result projection **[VERIFY]**. |
| `provider.usage.read` | `GET /api/usage/providers`; `providerUsage.js` | optional family and freshness | family cards with limits, remaining %, reset, age, approximation/error/pending | **Verified in source**; mind exposure proposed as supervisor-only metadata. |
| `provider.status.read` | `/api/providers/status`; `providerStatus.js` | optional provider ID | availability, reason, recovery time | **Verified in source**; combined visibility projection proposed. |
| `provider.route.preview` | provider catalog/readiness + the routing policy in section 9.1 | task requirements; no prompt body | selected candidate, ordered fallbacks, safe reason codes | **Proposed**; must make zero LLM calls. |
| `code-agent.status` | CoS task reads and existing voice `code_agent_status` | task ID | normalized task/job state and artifact reference | **Verified in source**; output parity **[VERIFY]**. |

The route audit must confirm the final task artifact projection before
implementation; the status and usage routes above are mounted in the current
source, while the projection from completed task metadata to a normalized
artifact remains deliberately preliminary.

## 7. Scope and capability policy

Scopes are audience and context constraints, not a replacement for authorization:

| Scope | Intended caller | Allowed baseline |
|---|---|---|
| `mind` | Persistent Mind supervisor | Read context and explicitly granted typed actions. No browser DOM, arbitrary code, shell, or external sends. |
| `voice` | Authenticated voice pipeline | Existing voice semantic tools plus UI tools when a live UI context exists. |
| `palette` | Command palette | Palette-safe subset; no DOM/screenshot/dictation-only operations. |
| `agent-context` | Local MCP client | Existing five read-only local context tools only. |
| `admin` | Authenticated human/admin UI | Explicitly enabled operational tools, still confirmation-gated for destructive actions. |

Each tool should declare a privacy class (`public`, `internal`, `personal`, `health`, `credential`, `federation`) and a side-effect class (`read`, `local-write`, `external-write`, `process-control`, `destructive`). The catalog filters tools by both. Personal records and status/capability payloads must remain machine-local and must not travel through federation; only the documented allowlisted submitted media-conditioning job body is an exception.

Feature readiness should be reported from the existing capability map and feature registry. A tool should be unavailable when its backing integration is absent, but a catalog read must not cold-start a provider, load a model, or call an LLM. Explicitly requested generation may start a provider-backed job after validating the selected provider/model.

## 8. Lifecycle and concurrency contract

### Synchronous tools

- Validate the whole request before calling the adapter.
- Enforce capability/risk policy before side effects.
- Execute under the owning service's existing serialization rules.
- Persist the idempotency record before returning the terminal result.
- Return a bounded, schema-valid result.

### Asynchronous tools

- Return `202` quickly with a stable request ID and job ID.
- Reuse existing job stores and progress streams where present.
- Expose one normalized SSE event shape: `{ sequence, at, phase, progress, message, result?, error? }`.
- Make `GET` status safe for polling and keep mutation on `POST`/`DELETE` cancel endpoints.
- Map queue/running/completed/failed/cancelled states without treating a missing job as queued.
- Drain any buffered output before final persistence and do not emit duplicate terminal events.
- Cancellation is best-effort and reports whether the job was already terminal.

### Idempotency and replay

Canonicalize `{tool, arguments, actor scope, target}` with the repository's canonical stringify helper. Bind replay to canonical validated content, not array position, wake position, or a mutable prompt. A duplicate identical request returns the original result with `replayed: true`; a duplicate operation that the underlying service already identifies as a duplicate returns a normalized `DUPLICATE`/`CONFLICT` result rather than creating a second record.

## 9. Model integration

The catalog should be convertible to the existing OpenAI function-tool shape:

```json
{
  "type": "function",
  "function": {
    "name": "brain.capture",
    "description": "Store a durable brain entry from user-provided text.",
    "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}
  }
}
```

The Persistent Mind prompt should receive only the scope-filtered catalog, not the full REST inventory. It should receive `taskRequests` only for `cos.create-task`, matching the current response contract. Other actions should be represented as validated tool calls handled by the supervisor, with every request/outcome recorded as a capability event. The model must be told whether an operation is pending, confirmation-gated, unavailable, or complete; it must never infer success from a natural-language plan.

Small models should continue to receive intent-filtered subsets. `GET /api/cos/tools?intent=...` may support server-side filtering, but the server must not trust a client-provided intent as authorization. The existing voice `TOOL_GROUPS`/intent regexes can seed groups, while canonical registry metadata becomes the source of truth for names, schemas, and risk annotations.

### 9.1 Preliminary provider-routing policy

For Persistent Mind tool-planning and research tasks, the proposed default
candidate order is:

1. **Codex Luna Max** — the enabled Codex-family CLI/TUI provider, model
   `gpt-5.6-luna`, effort `max`.
2. **Claude** — the enabled Claude Code CLI/TUI provider, using its configured
   default (or heavy) model and the highest effort that provider/model advertises.
3. The task's explicit configured fallback, then the existing system-priority
   fallback list, filtered by tool-use, context, image, readiness, and scope
   requirements.

“Codex Luna Max” is a routing label for the model/effort pair, not a new
provider record. A user-pinned provider/model remains first unless the request
sets `routing: "automatic"`; the Persistent Mind default is automatic. The
selection is resolved from enabled provider configuration and readiness rather
than assuming the seed IDs still exist on every install.

This ordering is **Proposed [VERIFY]**. The audit must confirm that Luna remains
selectable with `max` effort in the current Codex CLI and that the chosen Claude
model has the required tool-use/context capabilities. If either combination is
not advertised, it is excluded rather than invoked optimistically.

#### Pre-dispatch decision

The supervisor obtains a quota/status snapshot before creating a provider run:

```text
candidates = configured order filtered by readiness and task capabilities
for candidate in candidates:
  visibility = family quota card + provider availability status
  if visibility is unavailable because of a known usage/rate limit: skip
  if any current limiting window is at or below reserve: skip
  if visibility is pending, stale, unsupported, or approximate: keep candidate,
    mark the uncertainty, and rely on execution-time fallback
  select candidate
```

The preliminary reserve is **15% remaining in the narrowest/limiting window**
and **5% remaining in the broadest/target window**. The two-window rule prevents
a nearly exhausted five-hour allowance from starting a long task while also
preserving the remainder of a nearly exhausted weekly allowance. These values,
the definition of a “long task,” and the maximum acceptable reading age are
**[VERIFY]** and must become settings rather than hidden constants if retained.

A missing, pending, approximate, or unsupported reading is not the same as zero
quota. It must be surfaced as `confidence: "unknown"` and must not permanently
bench a provider. A positively observed provider refusal still flows through
the existing provider-status service: usage-limit errors use the parsed reset,
rate limits use their shorter cooldown, and the runner selects the next eligible
fallback. At most one automatic provider switch occurs per logical tool-planning
step **[VERIFY]**; the same `request_id` and canonical argument digest survive
the switch so a retry cannot duplicate a side effect.

Provider fallback is allowed only before a side effect or for a provider-only
planning/generation phase proven idempotent. Once an adapter has accepted a
mutation or asynchronous job, the supervisor polls that operation; it never
replays it against another provider.

### 9.2 Usage visibility layer

The visibility layer is a supervisor projection over existing local services,
not a new provider call:

```json
{
  "schemaVersion": 1,
  "observedAt": "2026-08-27T12:00:00.000Z",
  "providers": [
    {
      "providerId": "codex",
      "family": "codex",
      "available": true,
      "confidence": "approximate",
      "source": "local-telemetry",
      "pending": false,
      "stale": false,
      "limits": [
        {"scope": "session", "percentRemaining": 42, "resetsAt": "2026-08-27T15:00:00.000Z", "role": "limiting"},
        {"scope": "week", "percentRemaining": 58, "resetsAt": "2026-09-01T00:00:00.000Z", "role": "target"}
      ],
      "routing": {"eligible": true, "reasonCodes": []}
    }
  ]
}
```

- `GET /api/usage/providers` remains the source of subscription-family cards.
  A normal read serves cached data immediately and revalidates in the
  background; `refresh=1` explicitly waits for a bounded fresh read.
- Provider status supplies known unavailability, failure category, and recovery
  time. The projection joins status by configured provider and quota by
  subscription family; it never conflates a provider ID with a family ID.
- Codex quota comes from bounded local rollout telemetry. Claude quota comes
  from the zero-token local `/usage` reader. Both may be approximate and must
  expose `fetchedAt`/age. Catalog and visibility reads never call an LLM.
- `pending`, `error`, `supported: false`, no limits, and a legitimate 0% reading
  remain distinct states. The router may skip only on an explicit threshold or
  known status denial, never on truthiness or an empty list.
- The UI subscribes to a proposed `provider-visibility:changed` Socket.IO event
  and reconciles with the HTTP snapshot. **[VERIFY]** the event name and whether
  the current provider-status event can be safely extended rather than adding a
  second stream.
- Persistent Mind receives only the selected provider, fallback reason codes,
  remaining percentages, and reset times needed to explain routing. It does not
  receive credentials, raw session logs, usage-panel text, provider responses,
  or other machines' quota. Visibility is machine-local and never federated.

Real-time means that a user-requested refresh and provider status changes become
visible without reloading the page; it does not mean scraping every provider on
every call. The implementation should retain the current single-flight,
stale-while-revalidate behavior to avoid spawning duplicate PTY readers.

### 9.3 Research-heavy GitHub issue filing mode

`cos.research.file-issue` is the canonical convenience tool for the existing
Persistent Mind `cos.create-task` capability with
`mode: "research-and-file-issue"` (stored as `planOnly: true`). It is intended
for work whose durable deliverable is a decision-complete tracker issue rather
than a code diff.

The supervisor must:

1. Resolve the managed app and verify it has a repository path and a GitHub or
   GitLab tracker. This is already enforced by the current task capability.
2. Route the research agent through section 9.1, retaining the requested
   provider preference and recording any automatic fallback reason.
3. Require repository inspection, relevant source references, constraints,
   implementation steps, acceptance criteria, validation, rollout/compatibility
   risks, and explicit **[VERIFY]** items in the issue body.
4. Search open tracker items for semantic/exact duplicates before filing. A
   failed duplicate search is a blocking uncertainty, not proof that no
   duplicate exists **[VERIFY]** against the `plan-task` workflow.
5. File exactly one issue using the repository's resolved forge workflow; do
   not edit code, open a PR, or write the target app's research into PortOS.
6. Return a typed `artifact: { kind: "issue", url, number }`. Until the queued
   task completes, return `artifact: null` and the task status reference; never
   claim an issue was filed from a natural-language plan.

Issue filing is an authorized consequence of the default-off
`cos.create-task` capability and the explicit research mode. It does not use the
generic human-confirmation token for each issue, but it remains subject to the
five-requests-per-turn limit, tracker gate, workspace preflight, task budget,
and canonical replay protection. Direct issue creation outside this supervised
mode remains an external write and requires its own explicit capability.

## 10. Observability and privacy

Every call gets a request ID, tool ID, outcome status, duration, and redacted error code. Logs use the existing emoji-prefixed, single-line format and contain no full arguments, personal records, prompts, tokens, credentials, file paths, hostnames, or provider responses. Metrics should include counts and latency by tool ID, status, provider class, and scope, with cardinality bounds.

Trajectory events may record the tool ID, request ID, argument digest, status, and a safe display summary. They must not store raw sensitive arguments by default. Job events should follow the existing event-log and Socket.IO/SSE privacy boundaries. A tool result that contains a personal record must declare its privacy class and be retained only in the local mind trajectory under the existing retention policy.

## 11. Compatibility and rollout

1. Introduce the registry and catalog as a read-only feature behind a default-off `cos.toolCalling` capability.
2. Add adapter parity tests for each migrated voice tool: catalog schema, validation, success, missing target, unavailable provider, duplicate replay, and cancellation where applicable.
3. Keep `dispatchTool`, `/api/palette/action/:id`, and voice pipeline behavior unchanged; implement them through registry aliases after parity is proven.
4. Add the Persistent Mind adapter for `cos.create-task` without changing its default-off capability or five-per-turn limit.
5. Add safe read tools, then low-risk local writes, then provider-backed generation with explicit provider/model disclosure.
6. Add confirmation tokens and audit events before any external write or process control is considered.
7. Generate `/api/cos/tools` schemas from the registry and add a fail-fast test for duplicate IDs, alias collisions, missing schemas, missing capability declarations, and adapters without lifecycle annotations.
8. Add a route-to-adapter coverage report. It should identify every intentionally unmapped route family and prevent accidental raw-route exposure when a new endpoint is added.
9. Bump a tool-catalog schema version when a tool's input/output contract changes. Preserve aliases and old response interpretation for at least one compatibility window.
10. Add OpenAPI documentation for the new authenticated interface separately from the opt-in external `API_REGISTRY`; do not make it public by adding it to the current public registry.

## 12. Acceptance criteria

- A Persistent Mind turn can discover a bounded, scope-correct catalog and call a typed tool without knowing a PortOS route.
- Catalog entries, calls, and results round-trip through the versioned `portos_tool`, `portos_tool_call`, and `portos_tool_result` profiles with closed input/output schemas.
- Existing voice tools and palette actions continue to pass their current tests through compatible aliases.
- Every tool has input/output schemas, risk/privacy/lifecycle annotations, and a declared capability.
- Invalid arguments, missing capabilities, unavailable integrations, duplicate replays, confirmation requirements, provider failures, and cancellations have stable machine-readable outcomes.
- Long-running image, video, pipeline, training, import, and agent operations return one normalized job contract and do not require the model to learn multiple polling conventions.
- UI-only operations cannot be invoked by a headless Persistent Mind.
- No raw shell, database, backup restore, secret reveal, credential, or arbitrary HTTP proxy is exposed.
- No catalog or capability read makes a cold-bootstrap LLM/provider call.
- Automatic routing selects an eligible Codex Luna Max candidate before Claude, explains quota/status-driven fallback with safe reason codes, and preserves one logical request ID across a provider switch.
- A pending, stale, unsupported, failed, empty, and genuinely exhausted quota reading remain distinguishable; only a known status denial or verified reserve threshold makes a provider ineligible.
- Usage visibility updates from local quota/status sources without exposing credentials, raw telemetry, prompts, or quota through federation.
- Research-and-file mode validates a GitHub/GitLab tracker, files at most one duplicate-checked issue, creates no code/PR, and reports the issue only after a typed artifact is observed.
- Personal data remains local and redacted from logs/trajectory summaries by default.
- A generated route/adapter coverage report and focused tests make drift fail fast.

## Appendix A: canonical naming examples

| Existing name/route | Canonical tool ID |
|---|---|
| `brain_capture`, `POST /api/brain/capture` | `brain.capture` |
| `brain_search`, `POST /api/memory/search` | `brain.search` |
| `goal_update_progress` | `goals.update-progress` |
| `calendar_today`, `GET /api/calendar/events` | `calendar.today` |
| `meatspace_summary_today` | `health.summary-today` |
| `catalog_lookup`, `GET/POST /api/catalog/ingredients` family | `catalog.lookup` |
| `image_generate`, `POST /api/image-gen/generate` | `media.image.generate` |
| `dispatch_code_agent`, `POST /api/cos/tasks`/spawn lifecycle | `cos.create-task` |
| `ui_navigate`, `GET /api/agent-context` navigation resolver | `ui.navigate` / `context.resolve-navigation` depending on caller |
| `POST /api/cos/mind/messages` | `mind.enqueue-message` (transport helper, not an LLM tool) |

## Appendix B: intentionally rejected designs

- **Expose every REST endpoint as a function:** rejected because it creates a 2,000-plus-function prompt, leaks route/storage details, and lacks uniform risk/lifecycle semantics.
- **Use MCP as the only transport:** rejected because browser/voice clients already use REST, the Persistent Mind is local to PortOS, and long-running PortOS jobs need first-class authenticated HTTP/SSE semantics. MCP remains the local CoS-agent transport for read-only context plus separately granted semantic actions.
- **Use the existing Persistent Mind `tools` route for all CoS tools:** rejected because that route intentionally describes a much smaller authority inventory and its default-off boundary is a security contract.
- **Have the model call raw HTTP itself:** rejected because authorization, idempotency, request serialization, privacy, error mapping, and confirmation must be enforced server-side.
- **Return prose-only tool results:** rejected because the supervisor needs typed terminal state, replay behavior, job references, and safe machine-readable error handling.
