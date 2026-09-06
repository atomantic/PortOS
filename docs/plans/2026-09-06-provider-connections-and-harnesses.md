# Provider connections, harnesses, and executable routes

Status: proposed implementation decision for #6359; this PR changes documentation only.

## Decision and scope

Introduce durable, machine-local connection and harness-binding IDs for management,
while retaining executable provider records and their IDs as the execution and saved
selection contract. A binding joins one harness to one connection; each binding has
explicit CLI/TUI routes. A direct API route binds a connection with no harness.
Never resolve a saved route by a display name or silently substitute another mode.

This is the next stage after matching CLI/TUI management cards. It does not authorize
merging different harnesses in that existing implementation. The implementation
issues below deliver the proposed architecture separately from this planning PR.

| Option | Benefit | Cost and failure mode |
| --- | --- | --- |
| Keep only executable records; derive management groups on read | Small change, easiest downgrade, no new authority | No durable explicit cross-harness links; endpoint/catalog edits still duplicate; inferred identity breaks on custom configuration |
| Replace selections with connection + harness + mode IDs everywhere | Fully normalized execution graph | Rewrites schedules, CoS, fallbacks, profiles and peer consumers together; older clients cannot address selections; large migration blast radius |
| **Durable management identities + stable executable route projection (chosen)** | Shared connection setup with incremental adoption and old route selections intact | Requires reconciliation between DB connection records and legacy provider file; explicit ownership and downgrade checks are mandatory |

The chosen cost is justified by avoiding a fleet-wide selection rewrite. New tasks
also save `providerId` and model, not management IDs. Route IDs are never reused.
The provider record remains authoritative for execution-mode settings; connection-owned
fields are materialized into it so old runners can still execute it without DB lookups.

## Inventory at the planning baseline

The following are source contracts, not values sampled from a running install.

| Consumer / source | Existing selection or behavior | Future ownership / compatibility |
| --- | --- | --- |
| `server/lib/aiToolkit/providers.js` | `providers[id]`, `activeProvider`, explicit `createProvider` fields, spread updates | Preserve ID, type and active route; extend create and update together |
| `server/lib/aiToolkit/internal/providerModes.js` | Conventional CLI/TUI sibling IDs, same command and equal endpoint/apiKey/envVars; OR-enabled and unioned models | Preserve current pairing; do not equate different harnesses based on this test |
| `server/routes/providers.js` | Flat provider list, sanitized credentials, `executionModes` management metadata | Old response stays usable; new management graph is a separate versioned response |
| `client/src/components/ProviderModelSelector.jsx`, `client/src/utils/providers.js` | `selectedProviderId`, effective active route, model/effort, `selectionPolicy`; disabled/stale pins remain visible | Continue separate CLI/TUI options; apply route/model eligibility to each option |
| `server/services/taskSchedule.js` | Task-level `providerId`, `model`; defaults can be null | Leave every saved value unchanged, including null inheritance |
| `server/services/cosTaskGenerator.js`, `server/services/agentModelSelection.js` | Task metadata `provider` and `providerId`, app/task pins, tier models | Preserve aliases and precedence; never convert a task pin to a binding ID |
| `server/lib/orchestrationProfile.js`, `server/services/orchestrationProfiles.js` | Architect/implementer/reviewer role `provider`, `model`, `effort` | Retain role-specific route selection and inheritance |
| `server/lib/aiToolkit/providerStatus.js` | Route status, configured `fallbackProvider`/`fallbackModel`, fallback candidates | Keep references and status scoped to route; enforce caller mode policy on every candidate |
| `server/routes/capabilities.js`, `server/lib/capabilityMap.js` | Local setup capabilities/readiness built from executable providers | Preserve setup readiness by executable route |
| `server/services/sharing/peerCosSync.js`, `server/lib/schemaVersions.js` | Versioned CoS task/history transfers | Preserve existing payloads and selection strings; graph, credentials and connection identity never federate |
| `client/src/pages/AIProviders.jsx`, `client/src/App.jsx`, `server/lib/navManifest.js` | `/ai`, `/ai/new`, `/ai/edit/:providerId`; Shell launch through provider routes | Preserve URLs; add graph navigation through registered route parameters |
| `server/services/localLlm.js`, toolkit model refresh methods | Batched backend refresh; failed/missing vs updated result | Refresh shared connection catalog once; never turn list failure into empty catalog |
| `server/services/runner.js`, `server/lib/tuiShellLaunch.js`, toolkit `runner.js` | Host CLI/TUI overrides, argv/environment, Shell launch and lifecycle | Project exact original mode settings; no new runner or command permission implied |

Settings ownership is explicit:

- **Connection:** backend kind, endpoint/protocol variants, credential material,
  shared catalog and catalog capability evidence. Runtime location is installation
  configuration, never a vendor-wide singleton.
- **Harness definition:** stable kind such as Claude/OpenCode/Codex, supported
  protocols, model-name adapter, available modes and prerequisite recipe. Definitions
  are code, not user commands fetched from a server.
- **Binding:** connection + harness, enabled state, selected shared model subset,
  harness-specific transport configuration that cannot be expressed by the connection.
- **Executable mode/route:** command, args, headlessArgs, envVars not consumed by the
  connection adapter, secretEnvVars, timeout, tuiPromptDelayMs, effort, defaultModel,
  light/medium/heavy pins, generation defaults, fallback references, execution consent
  and text-transport risk acknowledgement. Unknown custom fields remain intact.
- **Task/role selection:** exact route, optional model/effort and caller eligibility
  requirements. A blank value continues to mean inheritance, not a reset.

## Proposed storage and wire contracts

New graph records are **db-primary**, under the storage checklist in `docs/STORAGE.md`:
these are app-owned relational identities, not externally edited files. Use normalized
`ai_connections`, `ai_harness_bindings`, and `ai_route_bindings` tables, with primary
keys and foreign keys, plus bounded JSONB for extensible transport/capability fields.
No full-text/vector search or binary assets are involved. Include these tables in the
normal Postgres backup. They have no sync sequence or tombstones because they never
federate. Hard deletion is refused while referenced by a binding; unlink first.

Keep existing `data/providers.json` as the legacy execution compatibility artifact;
this proposal does not classify a new relational JSON store as file-primary. A toolkit
adapter is injected from the host so the vendored toolkit stays self-contained.
Route ownership and recovery metadata live in `ai_route_bindings`, not in a parallel
set of ad hoc JSON stores. Opaque IDs below are invented examples; production uses UUIDs.

Connection record (JSON representation of one row):

```json
{
  "id": "conn-example-local",
  "revision": 1,
  "kind": "ollama",
  "name": "Example local Ollama",
  "transports": {
    "ollama": {"baseUrl": "http://127.0.0.1:11434"},
    "anthropic": {"baseUrl": "http://127.0.0.1:11434"},
    "openai": {"baseUrl": "http://127.0.0.1:11434/v1"}
  },
  "credentials": {},
  "catalog": {
    "state": "known",
    "models": [{"id": "example-model", "capabilities": {"text": true, "tools": null, "vision": false}, "contextWindow": null}]
  }
}
```

`credentials` is server-only material keyed by transport, with the same private
storage/access boundary as existing provider secrets. Do not publish it, its hashes,
or raw secret environment values. Keep it in backups under the existing private
backup policy. Credential storage encryption changes are outside this proposal.
`catalog.state` is `unknown|known|failed`; known with `models: []` is a successful empty
result. Failed refresh retains the last catalog and adds a sanitized error; unknown
capability values are null and cannot satisfy a required positive capability.

Binding and route mapping (rows represented together for readability):

```json
{
  "binding": {"id": "binding-example-claude", "connectionId": "conn-example-local", "harnessId": "claude", "enabled": true, "selectedModels": ["example-model"]},
  "routes": [
    {"providerId": "claude-ollama", "bindingId": "binding-example-claude", "mode": "cli", "modelMap": {"example-model": "example-model"}},
    {"providerId": "claude-ollama-tui", "bindingId": "binding-example-claude", "mode": "tui", "modelMap": {"example-model": "example-model"}}
  ]
}
```

`ai_route_bindings.provider_id` is unique, `binding_id` references the binding row,
mode is `cli|tui|api`, and binding `harness_id` is nullable only for direct API.
Store the last projected connection-owned field snapshot and pending projection
revision with each route. Secret-bearing snapshots are private too. Unknown provider
IDs remain valid legacy routes even when no graph mapping exists. Unknown harnesses
stay unlinked legacy records, with an editable legacy management view.

`modelMap` maps canonical backend names to executable harness names (for example an
OpenCode route may require `ollama/example-model`). Never rewrite existing saved model
strings by stripping a prefix heuristically. Import exact existing strings as aliases;
ambiguous aliases remain visible as unresolved pins and cannot be auto-selected.

Add a proposed local endpoint `GET /api/providers/management` returning
`{schemaVersion:1, connections:[], bindings:[], routes:[], activeProvider:null}`.
Connection DTOs substitute `hasCredentials` booleans for credentials and omit snapshots.
Route DTOs include mode, providerId, effective model catalog, prerequisite readiness,
and explicit eligibility; no credential comparison is performed by the browser.
Keep `GET /api/providers` and existing mutation payloads backward compatible.
A new client talking to a server without management support falls back to the flat
list on an explicit unsupported/404 response, not on arbitrary request failures.

Proposed mutations, all Zod-validated and local-only:

| Request | Contract |
| --- | --- |
| `POST /api/providers/connections` | kind, name, transports, optional credentials; returns sanitized connection; no generation or discovery |
| `POST /api/providers/bindings` | connectionId, harnessId (nullable for API), requested modes; create fresh route IDs and disabled routes without changing activeProvider |
| `PATCH /api/providers/connections/:id` | expectedRevision + explicit changed fields; omitted credentials preserve, explicit clear removes; return 409 on stale edits |
| `POST /api/providers/bindings/:id/link` | targetConnectionId + expectedRevision + explicit conflict choices; return affected route preview before applying confirmation |
| `POST /api/providers/bindings/:id/unlink` | clone connection/catalog/credentials to new identity, retain all route IDs and settings |
| `PATCH /api/providers/:id` | existing mode editor remains valid; connection-owned legacy edits detach that binding before changing them |
| `POST /api/providers/connections/:id/refresh-models` | explicit discovery request only; never prompt generation; retain data on failure |

Link preview is a read-only request using the same validation shape; applying requires
the preview revisions and explicit user confirmation in the product. These are future
product flows, not an approval requirement for this planning task. No endpoint is
implemented or added to the route catalog by this PR.

## Identity, linking, and model eligibility

An endpoint string alone is not identity. Equal vendor names, catalogs, display names,
redacted secrets, or equal `hasCredentials` flags never establish equivalence. Scheme,
host, port, path, protocol adapter, authentication and execution environment matter.
Do not equate localhost with a remote DNS name, strip arbitrary URL paths, or resolve
DNS to decide identity. Compare secret material only inside the server, never in logs.

Automatic import sharing is limited to the already-proven same-harness sibling groups
from `providerModeGroups`, and only when the transport adapter can fully understand the
configuration. Dynamic environment references, external harness config files, unknown
flags or mismatched endpoints/credentials remain isolated. Matching Claude and OpenCode
Ollama connections are suggestions requiring explicit linking, even on one machine.
Recognized protocol suffix conversion is an adapter operation, not generic URL trimming.

Linking previews endpoint/authentication/catalog differences, affected route IDs and
pins without revealing secrets. The user selects the target transport/auth configuration;
there is no last-writer credential merge. Union model catalogs by canonical identity,
keep aliases and model pins, and preserve conflicting capability observations as unknown
until refreshed. Disabling one binding does not disable another harness. Initial sibling
binding enablement uses OR; a newly added harness starts disabled. Mode consent flags
never participate in OR enablement and are never granted by linking.

Unlink clones the shared connection before redirecting only that binding's graph edge.
The executable route IDs, activeProvider, tasks and fallback references do not change.
Deleting a route used by defaults/tasks/fallbacks is refused with references; no silent
replacement. Linking a connection does not validate custom commands or expand allowlists.

Eligibility is an intersection of caller allowed modes, route enabled/consent state,
harness support, model capabilities and current prerequisite/readiness policy. Extend
the shared routing policy at the server boundary; client filtering is only presentation.
Apply the same predicate to every fallback candidate. CLI/API-only contexts cannot get
TUI through activeProvider inheritance or fallback. A missing CLI runtime disables that
route with a reason while the same connection's direct API route may remain available.
Unknown readiness follows existing prerequisites policy; unknown required model capability
does not become true. A mode failure is route-scoped; only a verified shared backend
failure can affect all attached routes. Existing pins that cannot execute remain visible
with their original value and reason; any configured fallback is explicit and policy-safe.

## Mock management flows

1. **Claude + local Ollama:** Harnesses → Claude → Connections → Example local Ollama
   → Models. Show separate CLI and TUI mode rows, their defaults/timeouts/consent, and
   catalog shared within the connection. Save configuration without making generation calls.
2. **OpenCode + that same local Ollama:** Harnesses → OpenCode → Add existing connection
   → Example local Ollama. Preview protocol mapping and executable model names. Save creates
   an independent disabled binding; enabling it does not enable new consent. Existing
   OpenCode routes can link after reviewing differences, preserving their IDs and model pins.
3. **Separate remote Ollama API:** Direct API → New connection → Ollama →
   `https://ollama.example.com` plus credentials. Create a distinct UUID and API route even
   when the model names match local Ollama. No automatic link or local-runtime launch.
4. **Shared model selection:** Connection → Models → choose catalog subset. Show affected
   harnesses. Existing pins absent from the new subset remain recorded and visibly stale;
   refreshing a catalog never repicks a default. Mode model menus apply modelMap + policy.
5. **Mode overrides and system default:** Open mode row → edit args/timeout/model/effort.
   “Use as system default” names the exact CLI/TUI/API route and writes activeProvider.
   Preview incompatible consumers; their runtime policy still refuses an ineligible mode.
6. **TUI in Shell:** TUI row → Launch in Shell names the saved model and route. Use existing
   launch validation/lifecycle path; require an explicit click, save pending edits first,
   and display missing-runtime errors next to that mode. Never launch from enable/save/boot.

Keep `/ai/edit/:providerId` opening the corresponding route editor, including unmapped
custom routes; keep `/ai/new` for legacy links. Proposed nested management URLs use
`/ai/harnesses/:harnessId/connections/:connectionId` and
`/ai/connections/:connectionId`; route selection is in the URL, with palette/voice
entries and navigation parity guards. Use the shared Drawer for mode overrides,
label/id pairing, keyboard-operable selects, focus restoration, announced save/errors,
and stacked mobile navigation. Never hide a saved pin merely because it is unavailable.

## Upgrade, projection, and downgrade ordering

1. Add the graph schema and pure adapters behind read-only import preview. No change to
   runner selections, catalogs, active route or provider writes; this slice can ship alone.
2. Add a numbered `scripts/migrations/` migration gated on the presence of the existing
   provider INPUT and validated DB readiness, never on output absence. Preserve a private
   recovery copy of the input; migration-applied tracking provides rerun safety. There is
   no derived reference seed. If a later implementation derives a file, declare its path
   in `scripts/lib/migrationOwnedPaths.js` and prove setup-before-migration ordering.
3. Import every provider, including disabled/custom routes and unknown fields. Only proven
   siblings share a binding; OR enabled and stable union catalogs, preserving all mode
   pins, arguments, secrets, consent, fallbacks and activeProvider exactly. Do not repair
   removed model pins by substituting a first model. Record input/output counts and opaque
   unresolved references in a private report; logs contain only aggregate counts.
4. Activate graph management after import verification. Serialize host projection writes
   with legacy provider writes; no multi-human locking is needed. Commit graph revision
   and pending projection snapshot in one DB transaction, write providers through the
   existing store, then acknowledge revision. A crash before acknowledgement is recoverable:
   compare actual provider fields with both old and pending snapshots before retrying.
   Never overwrite a third, externally changed value. Until repaired, reject graph mutations
   for affected bindings and keep last valid executable records readable. Boot recovery
   performs local I/O only, never probes or generation.
5. Old local clients remain supported. A legacy PATCH that changes a connection-owned field
   clones/detaches the affected binding first; mode-only edits do not touch graph ownership.
   The shared-mode policy still applies to proven sibling records. Expose the detach result
   to new clients; old clients receive their usual provider response.
6. Downgrading runs the fully materialized provider file; DB graph tables are left intact.
   Old versions may edit that file without updating the graph. On re-upgrade, compare it
   to the last projected snapshots BEFORE any write. Changed bindings detach/import their
   actual connection values; new provider IDs import independently; deleted records are
   not resurrected. If sibling values diverge, split their bindings. Unchanged edges retain
   UUIDs. An unrecognized/malformed configuration is preserved as a legacy route for repair.
   This reconciliation runs on every graph-aware startup, not only the one-shot migration.
7. Restoring only one half of backup requires the same reconciliation; missing graph DB
   records rebuild isolated mappings from the execution file and flag lost link metadata.
   A consistent DB+file backup is required to retain management identities across restore.
   No automatic cross-harness relinking repairs a partial restore.

This retains executable behavior on downgrade, not the new management UI. Downgrade
support must be proven against an actual prior release parser/writer fixture. If that
release rejects the materialized fields, rollout is blocked until the adapter supports
it; do not declare compatibility from additive JSON alone.

## Peer/client boundary

This stage makes no peer wire change, so no schema bump is justified. Keep connection
UUIDs, endpoints, credentials, environment and linking graph machine-local. A transferred task retains its existing selection string and receiver resolution
policy, never a local connection ID. A sender's local UUID cannot identify a receiver's
backend; an unresolved route must not be redirected by matching vendor or model name. Test capability/status responses for accidental graph or secret leakage.
If implementation truly requires new eligibility fields on the peer wire, make that a
separate negotiated capability change through `server/lib/schemaVersions.js` and the
capability publisher: old peers receive the existing shape, unsupported routes remain
ineligible, and no receiver silently drops a new constraint and executes anyway.

## Validation and release gates

| Boundary test | Regression uniquely caught |
| --- | --- |
| Existing-install setup + import + restart with disabled/enabled siblings | Seed ordering, lost disabled routes, non-idempotent import; OR applies only to binding enabled |
| Claude + OpenCode local, distinct remote API, different auth/path/env | Accidental vendor-based identity merge or credential overwrite |
| Import/export with distinct CLI/TUI pins, args, secrets, consent and unknown fields | Loss of executable settings during projection |
| Catalog refresh success-empty, failed, unknown, conflicting capabilities | Empty/failure conflation, dropped pins, false tool/vision eligibility |
| Selector rendered with stale/disabled pins and per-mode policy | Hidden saved values or collapsed CLI/TUI IDs |
| Schedule/CoS/profile workflow with active TUI and CLI-only fallback requirement | TUI leaking through inheritance or fallback; role precedence regression |
| Crash at each projection boundary, legacy PATCH, downgrade-edit-reupgrade | Stale DB overwrites newer file edits or resurrects deletions |
| Missing Claude runtime with healthy direct API; isolated TUI failure | Harness failure poisoning unrelated API execution |
| Old client/server and older peer fixtures | New management format forced on old consumers; graph/secrets on peer wire |
| Boot, enable, link, save and catalog display with generation transports forbidden | Unconsented AI calls or TUI launch during configuration |
| Keyboard/mobile deep-link editor and explicit Shell launch | Lost routing, inaccessible nested controls or launching unsaved state |

Use public workflow/route tests for these boundaries; focused adapter tests are justified
for transport identity and cross-version serialization. DB-backed tests run only through
`npm run test:db` against `portos_test`. This documentation PR validates references,
JSON examples and whitespace; it does not run live providers or mutate real configuration.

## Implementation slices

Four implementation issues track this decision. Dependencies are explicit;
this planning issue closes when the design and backlog ship, not when implementation ends.

1. **Read-only graph preview:** schemas, transport adapters, identity and import preview;
   no new persistence or execution changes. Independently useful for inspecting proposed links.
2. **Durable graph and compatibility projection:** DB records, migration, legacy writes,
   crash recovery and downgrade reconciliation; preserve flat API and route IDs. Depends on 1.
3. **Mode-safe routing and selectors:** central caller eligibility intersection for active,
   pinned and fallback routes; preserve distinct selector options and stale pins. Can ship
   independently using current executable records, before the graph is persisted.
4. **Connection management and explicit linking:** accessible/deep-linked flows, shared
   model editing, mode overrides and Shell launch; depends on 2 and 3.

Tracker: #6366, #6367, #6368, #6369. Dependencies are recorded on each blocked issue.
