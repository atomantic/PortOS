# API Reference

PortOS exposes a REST API on port 5555 and WebSocket events via Socket.IO.

## Base URL

```
http://localhost:5555/api
```

When a TLS cert is provisioned (`npm run setup:cert`), `:5555` serves HTTPS instead and a loopback-only HTTP mirror runs on `http://127.0.0.1:5553` for local scripts. See [PORTS.md](./PORTS.md).

This document holds the cross-cutting API conventions plus a [route-domain index](#route-domain-index). It deliberately has no per-endpoint tables: the endpoint reference is the in-app **API Explorer** at `/api-reference/catalog` and the OpenAPI documents it serves, both generated from the mounted routers so they cannot go stale or miss a route:

For the bridge between these HTTP/event inventories and model-facing tools,
see [API and MCP Unified Tool Contract](./API_TOOL_CONTRACT.md). It records
the shipped semantic registry, MCP context/action schemas, authority matrix,
and the current-vs-proposed boundary.

- `GET /api/api-docs/catalog.json` — searchable metadata for every mounted HTTP operation.
- `GET /api/api-docs/internal/openapi.json` — OpenAPI 3.0.3 for the complete internal HTTP surface.
- `GET /api/api-docs/openapi.json` — OpenAPI 3.0.3 for only the external APIs currently exposed in Settings.
- `GET /api/api-docs/events.json` — searchable Socket.IO event inventory.
- `GET /api/api-docs/asyncapi.json` — AsyncAPI 3 for the Socket.IO transport.
- `GET /api/api-docs/tools.min.json` — the minimized semantic tool resource: only the operations annotated `x-portos-tool`, flattened to provider-neutral tool records with an HTTP binding. Sized for an agent to read whole, unlike the full internal document.

Inferred entries are marked `generated` until a runtime-backed payload contract exists; detailed entries are marked `modeled`. Both inventories are derived from source on first use (`server/lib/apiRouteGraph.js`, `server/lib/socketEventInventory.js`), so there is no checked-in manifest or regeneration step.

When adding an HTTP route, keep its request Zod schema in a reusable server library and register the detailed documentation in `server/lib/apiOperationContracts.js`; the route and OpenAPI should consume the same schema object. Add an `x-portos-tool` annotation to that contract entry to also publish the operation as an agent-callable tool in `tools.min.json`, and declare the codes its error responses really throw in `x-portos-error-codes` — the HTTP status alone does not identify the code, since `errorHandler` prefers an explicit `err.code` over the status map. Socket payload schemas follow the same pattern in `server/lib/socketEventContracts.js`. The live HTTP and Socket.IO source inventories guarantee coverage, while these small registries make richer contracts incremental without maintaining a second handwritten list of paths or events.

Building a native companion client? See [COMPANION_APP_API.md](./COMPANION_APP_API.md) — the stable, pre-auth-discoverable contract (discovery/identity, HTTP Basic auth vs. operator sessions, instance management, palette actions, daily-log, POST progress, and the iCloud-sync precedent) that the PortDeck app consumes. Basic auth alone does not grant peer management or host control — those need an operator session obtained via `POST /api/auth/login`, same as this section's [Security Model](#security-model) describes for host control below.

### Partial settings saves

`PATCH /api/settings/slice` accepts `{ slicePath, partial }`. It shallow-merges
the supplied keys at the selected slice inside the settings write queue, keeping
sibling settings and concurrent independent edits. Supplied objects and arrays
replace that key; explicit null/empty values clear fields where their schema allows.
Unreadable/malformed persisted settings and failed writes return errors.

Supported paths are `localLlm.ollama`, `localLlm.lmstudio`, `localLlm.llama`,
`localLlm.mtplx`, `localLlm.slotstream`, `imageGen`, `imageGen.external`,
`imageGen.local`, `imageGen.codex`, `imageGen.grok`, `imageGen.agy`,
`imageGen.fal`, `imageGen.expose`, `renderDefaults`, `videoGen`, `pipeline`,
`writersRoom`, `seriesAutopilot`, `pipelineEditorialChecks`, `autoUpdate`,
`music.chiptune` and `music.designer`. The Media settings drawer, Chiptune panel and Music Designer each save only the fields the user changed, one slice per request, so a stale snapshot never overwrites a sibling panel's value. A `loraTraining` slice stored by an older install is retired: it is not validated or patchable, but it is read and preserved. A `renderDefaults` target sent
as `null` clears that surface's pin.
Only the current controls' fields are accepted; credential/auth paths and
prototype-related keys are rejected. Execution-policy and changed executable
fields retain the same operator authority checks as `PUT /api/settings`,
including authorized local agents. Legacy PUT keeps its top-level replacement
semantics.

## Security Model

PortOS can execute host commands and access private files. It must remain on the user's private network; a reachable LAN or tailnet peer is not automatically trustworthy. It implements the following security measures:

- **Network isolation**: By default, access should be restricted to trusted networks (e.g., Tailscale VPN, localhost)
- **Command policies**: Execution follows each surface's operator/unattended policy and agent execution profile (see `server/lib/commandSecurity.js`); these controls do not sandbox the entire application
- **Input validation**: All API inputs are validated using Zod schemas
- **Opt-in authentication**: Off by default (trusting private network/Tailscale), PortOS supports opt-in instance password authentication (enforced by `server/services/authGate.js`) gating `/api/*`, `/data/*`, and `/sdapi/*` via session cookies, Bearer tokens, or HTTP Basic credentials
- **Host-control authority**: every `/api/*` write (any method but GET, HEAD and OPTIONS), `/api/commands/*`, a short list of sensitive reads (`HOST_CONTROL_GET_ROUTES` in `server/lib/hostControlRoutes.js`: raw backup archives, the host directory picker, managed-browser pages and downloads, live capture feeds and per-request ffmpeg decodes), and the matching Socket.IO events need an operator session (a signed-in human or a PortOS-spawned agent's `PORTOS_API_TOKEN`), or a local connection when no password is set. The exceptions keep their own admission: the public auth routes, the peer federation surface (`PEER_API_SURFACE`) and its pair-secret bootstrap, the managed-app visitor broker and the opt-in public API prefixes. A remote LAN/tailnet caller on a password-free install, and any peer or Basic credential, gets `403 HOST_CONTROL_FORBIDDEN`: reads stay open to them, writes do not (#16018). Set an instance password and sign in to use PortOS remotely

Never publish PortOS administration, APIs, sockets, sidecars, or host controls through public tunnels, reverse proxies, or forwarding. A password or TLS does not make public deployment supported. For private deployments, consider:
- Binding to `127.0.0.1` instead of `0.0.0.0`
- Enabling instance password authentication in Settings → Security
- Using Tailscale or similar VPN for remote access

Password-free installs warn the operator until they set a password or explicitly accept the risk. See the [host-control security model](../PRD.md#host-control-security-model) for the full contract.

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


## Route Domain Index

Every mounted API prefix (see `server/index.js` for the authoritative list). Each prefix corresponds to a router in `server/routes/`; list its operations in the API Explorer or `GET /api/api-docs/catalog.json`.

| Prefix | Domain |
|--------|--------|
| `/api/auth` | Optional password gate |
| `/api/apps` | Managed app registry and lifecycle |
| `/api/providers` | AI provider configuration and model catalogs |
| `/api/agents/tools` | Agent tool routes |
| `/api/digital-twin` | Digital-twin core routes |
| `/api/alerts` | System alerts |
| `/api/avatar` | Avatar rendering/config |
| `/api/system` | System health metrics |
| `/api/system/capabilities` | Local hardware capabilities for model/provider selection |
| `/api/system-resources` | System storage report, the tracked downloaded-model manifest, and AI-assisted cleanup triage |
| `/api/remote-desktop`, `/remote-desktop` | PortDeck remote desktop session broker and viewer |
| `/api/capabilities` | Feature capability flags |
| `/api/agent-context` | Opt-in, loopback-only MCP context plus separately granted semantic PortOS actions |
| `/api/workspace-contexts` | Workspace context management |
| `/api/apps/:appId/reference-repos` | Per-app reference repos (create, a PATCH that names `repoUrl` or `branch`, and `check` are host control: the path names a host directory the scheduled reference-watch runs git in) |
| `/api/managed-visitor-admin` | Owner-only provisioning and revocation of scoped managed-app visitor credentials; [contract](features/managed-visitors.md) |
| `/api/managed-visitors/v1` | Loopback managed visitor admission, observation, bounded actions and confirmed cleanup; requires a separate scoped app credential even when the instance password is off; [contract](features/managed-visitors.md) |
| `/api/network-exposure` | Network exposure checks |
| `/api/history` | User/system action history log |
| `/api/commands` | Allowlisted command execution |
| `/api/git` | Git operations for managed apps |
| `/api/screenshots` | Screenshot capture |
| `/api/search` | Global search |
| `/api/rapid-reader` | Rapid reader library and Accelerando source cache |
| `/api/palette` | ⌘K command palette manifest + actions |
| `/api/dashboard/layouts` | Dashboard widget layouts |
| `/api/dashboard/daily-actions` | Dashboard daily action tracking |
| `/api/media/collections`, `/api/media/annotations`, `/api/media/sketches` | Media library collections/annotations/sketches. Operators can rebuild missing memberships with `POST /auto-organize`. `GET /:id/primary` lists eligible machines and run status; `POST /:id/primary` `{ instanceId }` saves a primary and consolidates in the background. One-time ids save nothing: `unsorted` (unfiled gallery) and `shared-media` (files on 2+ machines). |
| `/api/media/holders` | Which machines hold each media file (`GET`) and Make primary (`POST /primary` `{ kind, filename, instanceId }`): keep that holder's copy and release the others |
| `/api/media/usages` | Where each media file is used (`GET`): `{ items: { '<kind>:<ref>': [{ source, label, id, title, role, href }] } }`. `DELETE /api/image-gen/:filename` and `DELETE /api/video-gen/history/:id` refuse a used file with `409 MEDIA_IN_USE` (usages in `context.usages`) unless `?force=1` |
| `/api/client-errors` | Client-side error reporting |
| `/api/backup` | Backup snapshots + restore |
| `/api/legacy-export` | Legacy data export |
| `/api/database` | Postgres introspection |
| `/api/image-clean` | Image metadata cleaning |
| `/api/eidoverse/world` | Private Eidoverse identity, projection, presence, augmentation, and chat adapter |
| `/api/eidoverse/travel` | Eidoverse travel: destinations, departing to a peer world, and the federation visit/chat/leave hops (`/guest` is the one public endpoint) |
| `/api/cos/gsd` | CoS GSD workflow |
| `/api/feature-agents` | Feature agent runs |
| `/api/feeds` | RSS/content feeds |
| `/api/catalog` | Creative ingredients catalog |
| `/api/tribe` | Tribe relationship graph |
| `/api/user-actions` | Read-only, machine-local operator-action ledger |
| `/api/skills` | Agent skill registry |
| `/api/notes` | Notes |
| `/api/calendar` | Calendar integration |
| `/api/messages` | Messages (email) integration |
| `/api/digital-twin/social-accounts`, `/api/digital-twin/identity`, `/api/digital-twin/autobiography` | Digital-twin sub-domains |
| `/api/meatspace`, `/api/meatspace/genome` | MeatSpace (health, POST) and genome markers |
| `/api/lmstudio`, `/api/local-llm` | Local LLM backends and the local runtime servers PortOS can start/stop (Ollama, LM Studio, `llama-server`, MTPLX, Slotstream — the last three as PM2 processes; `POST /api/local-llm/save-startup` is `pm2 save`), plus MTPLX's checkpoint catalog — `GET /api/local-llm/mtplx/models/search`, `POST .../models/pull` (byte progress on the `mtplx:download` socket event), `POST .../models/remove`. Slotstream lifecycle is `GET /api/local-llm/slotstream/status` (which also carries the curated checkpoint catalog), `POST .../start` (never downloads weights), `POST .../stop`, `POST .../install`, and `POST /api/local-llm/slotstream/models/download` — the separate, explicit action that fetches a checkpoint, with byte progress on the `slotstream:download` socket event. |
| `/api/code-review` | Code review runs |
| `/api/voice`, `/api/voice/public` | Voice assistant |
| `/api/api-docs` | Generated HTTP/event catalogs, OpenAPI 3.0.3 documents, AsyncAPI 3 document, and the minimized semantic tool resource |
| `/api/data` | Data manager/sync |
| `/api/datadog`, `/api/jira`, `/api/github`, `/api/telegram` | External integrations |
| `/api/apple-health` | Delete one imported Apple Health day (`DELETE /days/:date`); metrics, ingest, and XML import stay on `/api/health` |
| `/api/health` | Apple Health metrics, ingest, and XML import |
| `/api/human-actions` | Scheduled steps only the human can take, as Brain threads with reminders ([Human Actions](#human-actions)) |
| `/api/insights` | Cross-domain insights |
| `/api/instances`, `/api/sync`, `/api/peer-sync`, `/api/sharing` | Federation / peer sync (see [COMPANION_APP_API.md](./COMPANION_APP_API.md)); `POST /api/sharing/buckets` is host control (it names a host folder PortOS writes records into and imports manifests from) |
| `/api/peer-media` | Peer-only media commands: `POST /api/peer-media/delete` (`{ kind: 'video' \| 'image', key }`, an image keyed by gallery filename) deletes a row this machine holds at the request of a paired peer with media delete allowed here (see [PEER_PUSH_AUTH.md](./PEER_PUSH_AUTH.md)); `POST /api/peer-media/release` (`{ kind, filename, primaryInstanceId, primaryAt }`, same grant) drops this machine's copy of the bytes once the primary is verified to hold them, keeping the row and streaming from the primary. `POST /api/peer-media/copy` returns the local file's SHA-256 digest and can fetch missing bytes from the authenticated caller when given the expected `sha256` and the media-delete grant. |
| `/api/federation/media/v1` | Authenticated queued peer audio provider (see [FEDERATED_MEDIA_PROVIDERS.md](./FEDERATED_MEDIA_PROVIDERS.md)) |
| `/api/federation/admin/v1` | Paired-peer administration preflights and temporary signed plans; execution remains unsupported (see [peer administration planning](./features/peer-administration.md)) |
| `/api/peer-administration` | Operator-only per-peer/action planning grants and outbound previews (see [peer administration planning](./features/peer-administration.md)) |
| `/api/mortalloom` | MortalLoom (iCloud-JSON sync precedent) |
| `/api/review` | Review queue |
| `/api/settings` | App settings |
| `/api/update` | Self-update flow |
| `/api/loops` | Loops |
| `/api/character` | Character management |
| `/api/tools` | Agent tool registry |
| `/api/image-gen`, `/api/video-gen`, `/api/image-video/models` | Image/video generation |
| `/api/image-verifier` | Image quality verification: `POST /verify` (`{ filename, profileId?, prompt?, reviewerModel?, reviewer? }`), and `POST /override` (`{ filename, verdict, notes? }`). Verification and overrides persist in the image sidecar. Writes require host control. |
| `POST /api/video-gen` (Grok reference images) | With `backend=grok` and a `sourceImage` (or `sourceImageFile`), a multipart request may add up to 3 reference images: files `referenceImage1`..`referenceImage3` (`image/*` only), each with an optional text `referenceLabel1`..`referenceLabel3` (what the image shows, max 120 chars, default empty). They are staged in slot order as the job's `castReferences` (`[{ path, label }]`), so Grok runs `reference_to_video` with the source image as `first_frame` instead of `image_to_video`; any Music Video sheets come first and uploads follow. Another backend, no source image, a 4th image (`referenceImage4`) or a label without its image is a `400` (`VIDEO_REFERENCE_IMAGES_GROK_ONLY`, `_NEED_SOURCE`, `_TOO_MANY`, `VIDEO_REFERENCE_LABEL_ORPHANED`) and every upload is removed. Staged files are deleted by the Grok worker when the job completes, fails or is canceled, and by the queue if the job never starts. `POST /api/video-gen/prompt-preview` previews them via `previewUploads: ['sourceImage', 'referenceImage1', …]` |
| `/api/devtools/video-download` | Video download |
| `/api/video-timeline` | Video timeline editor |
| `/api/html-composition` | Offline seekable HTML-to-MP4 rendering; [contract and job endpoints](./HTML_COMPOSITIONS.md) |
| `/api/continuous-video` | Continuous-video episodes (script + bible → chained multi-clip generation) |
| `/api/media-jobs` | Async media job queue. `GET /queue` is a display feed: all live jobs plus up to `limit` recent failed/canceled jobs (default 10, range 0–100), filtered by optional `kind` and `owner`. A nonempty response does not mean work is running. Check for `status: queued` or `running` to determine render activity. `kind=video-upscale` also includes recent completed jobs and retains Topaz recovery rows independently of the limit. `GET /?status=running` and `GET /?status=queued` select active states directly. Failed film finishing retains the source in `result`; its status message identifies the retained image. Retrying unchanged generation inputs resumes finishing from the server's saved source without buying another render. |
| `/api/creative-director` | Creative Director projects |
| `/api/fableloom` | FableLoom interactive story generation |
| `/api/music-video` | Music video projects; [one-prompt autonomous runs](./features/music-video-autonomous.md) at `/api/music-video/autonomous` |
| `/api/music-video/:id/pacing-recut` | `GET` previews board-wide cuts to `pacing.maxShotSec` (minimum defaults to 1 s), preferring lyric-line starts, then downbeats and beats, with even cuts where no musical boundary fits. Returns `{ revision, updatedAt, minSec, maxSec, total, added, changes, skipped }`; each change lists its pieces and cut kinds. `POST` `{ revision }` atomically applies the preview and returns `{ project, added }`; 409 `MUSIC_VIDEO_PACING_CHANGED` if the project changed. Every first piece keeps its selected still and clip; new pieces inherit the prompt, carry `beatNeedsReview: true`, and have no clip. Clear that marker via the scene PATCH after reviewing its beat. `pacingCut: true` keeps the previewed timing in playback/export independently of actual `beatAligned` metadata. Untimed and before-song shots stay unchanged; incompatible pacing bounds are refused. Composition-source modes (code, document, Eidoverse) are refused because their cuts come from their source. No provider calls. |
| `/api/music-video/character-styles` | Built-in character styles a project loads via `concept.characterStyleId`: list with each style's sheet prompt and this install's sheet (`GET /`), full style (`GET /:id`), set or clear the install's character sheet (`PUT /:id/reference` `{ imageId }`) |
| `/api/mood-boards` | Mood boards; `POST /:id/generate` writes 1–4 prompts with the chosen LLM and queues new image items using saved imagegen settings (1024×576 default). Body: `requestId` (UUID), `providerId`, optional `model`, `effort`, `direction`, `count`, `render` (`mode`, `model`, `width`, `height`), `retry`. `GET /:id/generate` restores transient status; `mood-board:generate` pushes progress. Retry reuses the original batch and only queues unfinished slots. Prompt writing uses stored text, not pixels; saved prompts and references survive navigation and server restart, while transient batch status and recent request receipts reset on restart. |
| `/api/storyboards` | Storyboards (Create › Storyboards): `GET`/`POST /`, `GET`/`PATCH`/`DELETE /:id`; beats at `/:id/beats` (`POST`, `PATCH`/`DELETE /:beatId`, `POST /:beatId/move`); panels at `/:id/beats/:beatId/panels` (`POST`) and `/:id/panels/:panelId` (`PATCH`, `DELETE`, `POST /move` with `{ beatId?, index }`); panel art takes at `/:id/panels/:panelId/takes` (`POST` `{ source, image \| sketchKey }`, `POST /:takeId/select`, `DELETE /:takeId`); the panel maker at `PUT /:id/recipe` (`{ recipe \| null }`, null = default), `GET /:id/panels/:panelId/make` (linked catalog reference images; a panel `linkMedia` pick of catalog id → gallery filename is sent instead of the newest portrait), `PATCH /:id/panels/:panelId/make/:nodeId` (`{ text?, excludedRefs?, extraRefs? }`) and `POST /:id/panels/:panelId/make/:nodeId/run` (an LLM node answers when done; an image node once its frames are queued, with `storyboard:make` socket events after). Beats from a plot summary: `POST /:id/beats/extract` (`{ plot, providerId?, model?, effort? }` → `{ board, beats, sentPrompt, promptAdditions }`: the plot and pick are saved, the beats are a preview) and `POST /:id/beats/add` (`{ beats }`, appended). Make empty panels: `GET /:id/make-empty` (`{ batch, panelCount, steps }`: the panels with no art and each node it runs with its model) and `POST /:id/make-empty` (202, one batch per board, `storyboard:make-batch` progress). The saved recipe library: `GET`/`POST /recipes` (`{ name, recipe }`) and `DELETE /recipes/:recipeId`. The animatic's temp track is `PATCH /:id` `{ tempTrack: { filename, name?, sections?, lines? } \| null }`, naming an audio file already in `/api/uploads`, with its song marks (`sections` `{ id?, label, at }`, lyric `lines` `{ id?, text, at \| null }`); a beat starts at one with `PATCH …/beats/:beatId` `{ pin }`. Make storyboard from a music video: `POST /from-music-video/:projectId` (201 `{ board, project }`: one beat per song section, one panel per shot, and the project's `storyboardId` set; 409 while it links a live board). Fit to song: `POST /fit-music-video/:projectId` (`{ boardUpdatedAt, starts? }`, `starts` = beat id → picked start seconds → `{ project, shots, replaced }`: the linked board's panels written as the video's shots, each with `panelId`/`panelRev` and the panel's art as `panelArt`, a frame reference that keeps one slot; 409 when the board changed since `boardUpdatedAt`, the song is not analyzed, or a shot is locked). A fitted shot and its panel: `POST /music-video/:projectId/shots/:sceneId/update-from-panel` (`{ scene }`: the edited panel's action becomes the shot's intent, its art the shot's `panelArt` frame reference, and its `panelRev` is refreshed) and `POST /music-video/:projectId/shots/:sceneId/panel-art` (`{ board, scene }`: the shot's still becomes the panel's selected take and the shot's `panelArt`); both 409 `PANEL_MISSING` when the panel is gone. Start a Video from a board: `POST /:id/video` (`{ boardUpdatedAt, project }`, `project` = the Video draft choices of `POST /api/creative-director` → 201 `{ project }`: a Video draft with `storyboardId` whose treatment is one shot per panel, each with the panel's action as intent and prompt, its seconds rounded and capped at 10, and its catalog cast; the length is the shots' total; 409 when the board changed, 400 `STORYBOARD_VIDEO_UNFIT` under 5 s, over 600 s or over 120 shots; no provider call). Make storyboard from a FableLoom path: `POST /from-fableloom/:loomId/:episodeId` (`{ via? }`, the transition ids picked at forks → 201 board: one beat per dramatic scene on the path, one panel per scene with `sourceSceneId`, and the board's `source` naming the episode). Open in storyboard editor (Series Pipeline): `POST /from-pipeline/:issueId` (`{ boardId, created }`: the board whose `source` is the issue, made the first time with one beat per storyboard scene and one panel per shot, `sourceSceneId`/`sourceShotId` set; 201 when made, 200 when it existed; 400 `NO_SCENES`). The board is a linked copy and the stage stays the source of truth: `GET /pipeline/:issueId/changes` (`{ boardId, locked, changed: [{ sceneId, shotId, panelId, fields }] }`, the shots whose panel was edited on the board since the shot last took it, by the panel's `sourceRev`) and `POST /pipeline/:issueId/update-from-board` (`{ shotId? }` → `{ updated, issue, boardId, locked, changed }`: each edited panel's action, framing and length copied to its shot, or only `shotId`'s; 409 `NO_BOARD`, 400 `PIPELINE_STAGE_LOCKED`). Use as scene / shot art: `POST /:id/panels/:panelId/scene-art` (`{ board, target }`: the panel's selected image becomes its FableLoom scene's image or its pipeline shot's start frame; 400 `NO_IMAGE` for a sketch or no art, `NO_SOURCE` for a panel with no scene or shot, `PIPELINE_STAGE_LOCKED` while the pipeline stage is locked). Every write returns the whole board; over-limit text is refused. Beat extraction, a node run and `POST /:id/make-empty` are host control (they run a caller-chosen provider or queue renders); the rest store records. |
| `/api/decks` | Decks (playing-card / tarot designer) |
| `/api/writers-room` | Writers Room |
| `/api/universe-builder` | Universe Builder |
| `/api/authors`, `/api/artists`, `/api/albums`, `/api/tracks`, `/api/music` | Music/creator catalogs |
| `/api/music/supercollider` | Contained SuperCollider runtime status, setup and offline renders ([SUPERCOLLIDER.md](./SUPERCOLLIDER.md)) |
| `/api/docker-containment` | Opt-in Docker containment: engine status, explicit image pull, contained install/validate runs over a worktree ([CONTAINMENT.md](./CONTAINMENT.md)) |
| `/api/pipeline` | Series/comic pipeline |
| `/api/conflict-journal` | Sync conflict journal |
| `/api/importer` | Story importer |
| `/api/story-builder` | Story Builder |
| `/api/loras` | Supported inference adapter management |
| `/api/lora-training` | Retained run history: list/read runs, checkpoints and sample images, `POST /runs/:id/cancel` and `POST /runs/:id/promote-checkpoint`; launch and every other write return 410 `LORA_TRAINING_RETIRED`. `/api/lora-datasets` is removed |
| `/api/data-maintenance` | Operator-authorized retired-data inventory and `DELETE /:operationId` removal of an allowlisted directory; see [Data Maintenance](DATA_MAINTENANCE.md) |
| `/sdapi/v1` | AUTOMATIC1111-compatible image generation surface (gated by `settings.imageGen.expose.a1111`) |
| `/api/openclaw` | OpenClaw operator chat |
| `/api/rounds` | Rounds (music + Morse training) |
| `/api/ask` | Ask (LLM Q&A) |
| `/api/quota-burn` | Quota-burn plan (ordered scheduled-task references + per-invocation overrides), its live status, the app/provider catalog its pickers read, manual runs, and re-arm. The referenced work itself is read from — and only ever edited through — `/api/cos/schedule` and `/api/cos/jobs`. |
| `/api/timeline` | Human-activity timeline (day + events); the path-based Gmail mbox import is host control (it names a host file or folder to read) |
| `/api/games` | Game projects |
| `/api/sprites` | Sprite catalog / export; `POST /import` is host control (it names a host source tree to copy from) |
| `/api/threejs-models` | Procedural Three.js models |
| `/api/html-pages` | HTML Pages bench: run installed models against the creative HTML brief, keep and compare the pages |
| `/api/film-styles` | Read-only film style grammar catalog: picker list (`GET /`), full grammar record (`GET /:id`) and rendered prompt-section preview (`GET /:id/prompt?parts=motion,camera`) |
| `/api/code-animation` | Code Animation: LLM-written briefs, prompt building (a `baseJobId` forks a finished animation: its HTML rides the prompt as the cut to extend, refused whole above `baseHtmlMax`), persistent jobs gallery with poster thumbnails (`GET`/`POST /jobs/:id/poster`; captured in the jailed preview browser); `DELETE /jobs/:id` moves a finished item's HTML and poster to the system Trash, then removes it), generated HTML retrieval, frame-exact MP4 export (`POST /:id/export` → HTML-composition media job), a generated soundtrack for a finished animation (`POST /:id/soundtrack` → one local music-engine render at the film length onto a Music-library track that becomes the job audio; `POST /:id/soundtrack/track` returns that track, created on first use, for a coded score saved with `POST /api/music/code` + the track's code-take routes), the vendored three.js modules the `three` renderer's preview inlines (`GET /vendor/three`; the export stages the same files, hashed, beside the page), portable source download (`GET /:id/package`), and data-only package validation (`POST /packages/validate`; [contract](CODE_ANIMATION_PACKAGES.md)) |
| `/api/code-animation/execution` | Code Animation contained production execution: platform sandbox and lane readiness (`GET /`), operator-owned tool paths (`PUT /tools`, host control) and the adversarial containment check (`POST /probe`, host control; re-run automatically after a restart for an unchanged, already checked configuration) ([contract](CODE_ANIMATION_PACKAGES.md#contained-production-execution)) |
| `/api/image-to-3d` | Image-to-3D conversion |
| `/api/rigging` | Auto-skin rigging and animation retargeting for image-to-3D models |
| `/api/privacy` | PII vault / trusted-org / broker opt-out |
| `/api/shell` | Browser PTY shells |
| `/api/iterm` | iTerm2 view capability status (`GET /status` → `{ state, detail }`); sessions themselves travel over the `iterm:*` socket events ([ITERM.md](./ITERM.md)) |
| `/api/ports` | Port scan / allocation |
| `/api/logs` | PM2 process logs |
| `/api/scaffold` | App scaffolding |
| `/api/usage` | Provider usage / quota |
| `/api/daily-driver` | Daily-driver snapshot |
| `/api/attachments` | Task / CoS file attachments |
| `/api/autofix` | Autofixer metrics |
| `/api/uploads` | Generic uploads |
| `/api/agents` | Agent process management |
| `/api/agents/personalities`, `/api/agents/accounts`, `/api/agents/schedules`, `/api/agents/activity` | Agent personalities, platform accounts, automation schedules and activity feed |
| `/api/agents/tools/moltworld`, `/api/agents/tools/moltworld/ws` | MoltWorld agent tools and WebSocket |
| `/api/cos` | Chief of Staff |
| `/api/memory` | Memory CRUD / search |
| `/api/brain`, `/api/brain/import` | Brain (second brain) and document import |
| `/api/media` | Media library |
| `/api/imessage`, `/api/contacts`, `/api/signal`, `/api/beeper`, `/api/spotify`, `/api/youtube` | Personal-data ingest |
| `/api/notifications` | Notification stream |
| `/api/stacker-news`, `/api/x` | Social integrations |
| `/api/model-personality` | LLM personality tests |
| `/api/moa-presets` | [MoA presets](./features/mixture-of-agents.md) (`moa:<id>`) |
| `/api/provider-fallbacks` | GET/PUT the single ordered provider fallback list `{ entries: [{ providerId, model?, effort? }] }` (Models > Fallbacks); the step after the failed one runs next, wrapping to the first |
| `/api/providers/comparison` | Selectable model inventory, sourced PortOS composite, and public evidence; POST `/import` merges researched observations (see [MODEL-COMPARISON.md](./MODEL-COMPARISON.md)) |
| `/api/models/performance/task-benchmark` | Machine-local PortOS task benchmark history and configured-provider inventory; `POST /discover` and `POST /run` perform explicit user-requested actions |
| `/api/browser` | Managed Chromium |
| `/api/creative-commission` | Creative commissions |
| `/api/midi-runtime` | MIDI runtime |
| `/api/harnesses` | Coding-agent CLI/TUI harness lifecycle |
| `/api/runs` | AI runs: create, stream, stop and inspect provider runs (see the request example below) |
| `/api/prompts` | Prompt template stages, variables and previews |

## WebSocket Events

Connect to Socket.IO at `http://localhost:5555`.

The complete source-derived event list is visible in **API Explorer → Event API** and available at `GET /api/api-docs/asyncapi.json` as AsyncAPI 3. The examples below highlight common flows rather than serving as the exhaustive inventory.

### Log Streaming

```javascript
// Subscribe to process logs
socket.emit('logs:subscribe', { processName: 'portos-server', lines: 100 });

// Receive log lines
socket.on('logs:line', ({ processName, line }) => {
  console.log(`[${processName}] ${line}`);
});

// Unsubscribe
socket.emit('logs:unsubscribe', { processName: 'portos-server' });
```

### Error Notifications

Server errors are broadcast to all connected sockets — no subscription handshake is needed.

```javascript
// Receive error events
socket.on('error:occurred', (error) => {
  console.error('Server error:', error.message, error.code);
});
```

### Chief of Staff Events

```javascript
// Join the CoS room to receive agent lifecycle events
socket.emit('cos:subscribe');

socket.on('cos:agent:spawned', (agent) => {
  console.log('Agent spawned:', agent.id, agent.task);
});

socket.on('cos:agent:updated', (agent) => {
  console.log('Agent updated:', agent.id, agent.status);
});

socket.on('cos:agent:completed', (agent) => {
  console.log('Agent completed:', agent.id, agent.success);
});

socket.on('cos:agent:output', ({ agentId, lines }) => {
  console.log('Agent output:', agentId, lines);
});
```

### Memory Events

```javascript
socket.on('memory:created', (memory) => {
  console.log('Memory created:', memory.id);
});

socket.on('memory:updated', (memory) => {
  console.log('Memory updated:', memory.id);
});

socket.on('memory:deleted', ({ id }) => {
  console.log('Memory deleted:', id);
});
```

### App Detection (Streaming)

```javascript
// Start streaming detection
socket.emit('detect:start', { path: '/path/to/repo' });

// Receive discovery steps
socket.on('detect:step', (step) => {
  console.log('Discovered:', step.field, step.value);
});

// Detection complete
socket.on('detect:complete', (appData) => {
  console.log('Detection complete:', appData);
});
```

### Shell Terminal

> **Security**: The shell WebSocket API provides full terminal access as the PortOS process user. It relies on PortOS's network-level access control (see [Security Model](#security-model)) — do not expose the PortOS server to untrusted networks.

```javascript
// Start a shell session — the server assigns the id and replies with shell:started
socket.emit('shell:start', {});
socket.on('shell:started', ({ sessionId }) => console.log('session', sessionId));

// Send input to shell. Submit with `\r` (the byte Enter sends), never `\n` — cmd.exe
// under Windows ConPTY ignores LF and the line is typed but never executed.
socket.emit('shell:input', { sessionId, data: 'ls -la\r' });

// Receive shell output
socket.on('shell:output', ({ sessionId, data }) => {
  console.log(data); // Terminal output
});

// Change directory — send the PATH, not a command. The server renders the `cd` for
// the shell this session runs (`cd /d "…"` on cmd.exe, Set-Location on PowerShell).
socket.emit('shell:cd', { sessionId, path: '/path/to/app' });

// Resize terminal
socket.emit('shell:resize', { sessionId, cols: 120, rows: 40 });

// Stop shell session
socket.emit('shell:stop', { sessionId });
```

### iTerm2 Sessions

The Shell page's iTerm2 view uses its own `iterm:*` events, never the `shell:*` ones; their payloads are in [ITERM.md](./ITERM.md#socket-events). There is no start, stop or resize: iTerm2 owns its sessions' lifecycle and size.

`iterm:input` types exact bytes into a live host terminal and can run commands with the host user's privileges. Treat access to the PortOS socket as host-command access; the iTerm2 view adds no command allowlist. PortOS authentication and HTTPS are optional and off by default, so keep the instance on its private network and use a strong, unique instance password.

### Provider Status

```javascript
// Provider availability changed
socket.on('provider:status:changed', ({ providerId, status, reason }) => {
  console.log(`Provider ${providerId}: ${status}`, reason);
});
```

## Request Examples

### Register an App

```bash
curl -X POST http://localhost:5555/api/apps \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My App",
    "repoPath": "/path/to/repo",
    "uiPort": 3000,
    "apiPort": 3001,
    "pm2ProcessNames": ["myapp-server", "myapp-client"]
  }'
```

### Execute AI Run

```bash
curl -X POST http://localhost:5555/api/runs \
  -H "Content-Type: application/json" \
  -d '{
    "providerId": "claude-code",
    "prompt": "List all files in the current directory",
    "workspacePath": "/path/to/workspace"
  }'
```

### Get PM2 Process Logs

```bash
curl "http://localhost:5555/api/logs/portos-server?lines=50"
```

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
| 401 | `UNAUTHORIZED` | Authentication missing or rejected |
| 403 | `FORBIDDEN` | Refused, including a shell command outside the allowlist |
| 404 | `NOT_FOUND` | Resource not found |
| 409 | `CONFLICT` | State conflict (duplicate, stale, or already running) |
| 422 | `VALIDATION_ERROR` | Request understood but invalid |
| 500 | `INTERNAL_ERROR` | Server error (also the fallback for any unlisted status) |
| 502 | `BAD_GATEWAY` | An upstream service failed |
| 503 | `SERVICE_UNAVAILABLE` | A dependency is not available |
| 504 | `GATEWAY_TIMEOUT` | A service PortOS called did not answer in time |

Zod request validation (`validateRequest`) answers `400` with
`VALIDATION_ERROR` and the field errors in `context.details`. Domain routes may
also set their own code (for example `MERGE_METHOD_NOT_ALLOWED`) on top of the
status — branch on the status first, and treat an unfamiliar `code` as a
refinement of it.
