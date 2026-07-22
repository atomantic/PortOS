# Unreleased

## Tribe outreach

- **[issue-2831] Unanswered 1:1 emails to a Gmail alias now surface as outreach nudges** — a message delivered to one of your Gmail send-as aliases (not your primary address) is correctly treated as a one-on-one conversation instead of a group thread, so a genuinely unanswered email to an alias no longer gets silently skipped. Your own alias addresses never appear as a Tribe contact.

## Render Queue

- **[issue-2827] Inspect and change Codex reasoning effort when retrying a render** — a failed Codex image job now shows the reasoning-effort level it used in the Render Queue, and the Edit & Retry editor gains a Codex-only Reasoning-effort control so you can pin a different level or reset it to the default before re-queuing.

## Security

- Guard paid-provider API keys against SSRF / key-exfiltration: `streamCompletion` (askService), voice-LLM endpoint resolution, and the local-LLM playground now validate a provider's endpoint through the shared endpoint guard before attaching the `Authorization: Bearer` header, so a mistyped or malicious custom endpoint (including cloud-metadata hosts) never receives the key unless the provider opts in via `allowCustomEndpoint`.
- Reject non-`http(s)` schemes on Privacy Center URL fields (org website/portal, broker search/opt-out/screenshot/listing URLs), closing a stored-XSS vector where a `javascript:`/`data:` value would execute when rendered as a link. Added a shared server `isSafeHref` helper mirroring the client's `isHttpUrl`, applied at the Zod write layer and at every render site.

## Fixed

- `executeTuiRun`'s `finish()` now always settles its run promise even if a finalization step throws, so a one-shot TUI run can no longer hang forever (leaking the PTY and wedging `/runs`).
- `execGh` now times out (60s default, overridable) and kills a stalled `gh` CLI child, so a hung network/credential prompt can't wedge the scheduled PR-watcher / issue- and branch-reconcile / update-check jobs or orphan `gh` processes.
- `NextActionBanner`'s question fetch is guarded against stale responses, so a slow earlier request can no longer overwrite a newer question.
- The Login and ErrorBoundary full-screen layouts use dvh-capped min-height, so their content isn't pushed below the fold by mobile browser chrome.
- r3f `<Canvas>` backgrounds (goals tree, memory graph, brain graph) track the `port-bg` theme token instead of a hardcoded black, fixing a black rectangle under light themes.
- Accessibility: `<label htmlFor>`/`id` pairing on the Avatar Emoji/Color (AgentList), Folder path (Sharing), and AI-refinement (StoryBuilder) inputs; hand-rolled clickable elements (ElementsSong element tile, NotificationDropdown row, TaskAddForm template picker) now use the shared `clickableProps` helper, restoring Space-key activation.
- The ProactiveAlertsWidget chevron affordance is now visible on touch devices.

## Changed

- **[issue-2833] Decompose the ~1000-line `spawnTuiAgent()`** — extract the output buffering/spooling pipeline into `agentTuiSpawning/outputSpooler.js` and the failure-analysis + worktree-inspection helpers into `agentTuiSpawning/finalizeHelpers.js`, leaving `spawnTuiAgent` as a thinner orchestrator. No behavior change to spawn/timeout/completion semantics; adds unit coverage for both extracted modules.
- Route client `localStorage` access through the `safeStorage` helpers (Layout, MorseTrainer, calendar persisted-state, MoodBoard reference strip, VoiceWidget, WorkEditor, Tribe) — several sites previously threw uncaught in Safari private mode instead of degrading gracefully.
- Replace inline `new Promise(r => setTimeout(r, …))` delays with the shared `sleep(ms)` helper across nine server modules.

## Removed

- Drop the unused `featureFlags`/`lockPolicies` reserved config slots from `collectionStore`'s typedef.

## Internal

- **[issue-2840] Paginate album/artist/author list endpoints** — `GET /api/albums`, `/api/artists`, and `/api/authors` now accept `limit`/`offset` via the shared `parsePagination`/`paginateArray` helpers, returning the same `{ items, total, limit, offset }` envelope the notes/mood-board/loras list endpoints use when a pagination param is present. Unparameterized requests still return the full array, so existing callers are unaffected.
- **[issue-2832] Split the boot-schema DDL into per-domain modules** — the ~1265-line inline `CREATE TABLE`/`CREATE INDEX`/trigger block in `ensureSchemaImpl()` (`server/lib/db.js`) is extracted into per-domain modules under `server/lib/db/schema/` (catalog, media, universes, writers-room, pipeline, privacy, tribe, audit, …), each exporting a statement array; `ensureSchemaImpl` is now a thin composer. Statement text and order are byte-identical, so the composed schema is unchanged.
- **[issue-2834] Split the ~1990-line `VideoGen.jsx` into hooks + subcomponents** — the client-side batch-queue orchestration moves into `useVideoGenQueue`, the pure model-memory / FFLF frame-budget / mode-compat helpers into `lib/videoGenParams.js`, and four presentational blocks into `components/videoGen/` (`RuntimeFingerprint`, `ModelRepairBanner`, `VideoPreviewPanel`, `VideoGenGallery`). The inline runtime-status `fetch()` now routes through a `getVideoGenRuntimeStatus` service wrapper, and the Seed input gains a proper `<label htmlFor>`/`id` pairing. Behavior and deep-link routing are unchanged.
- **[issue-2835] Split the ~2875-line `ArcCanvas.jsx` into per-component files** — each of the 32 subcomponents/helpers (ArcHeader, EditorialRoadmapPanel, SeasonRow, IssueRow, VolumeCoversPanel, …) now lives in its own file under `client/src/components/pipeline/arcCanvas/`, with the shared severity-color map in `arcCanvas/shared.js`. `ArcCanvas.jsx` (default export) is now a thin 122-line composer and still re-exports `ArcRoadmapChart` so its public import path is unchanged. Pure mechanical, behavior-preserving refactor — no rendered-output change.
- **[issue-2836] Extract helpers from `generateManagedAppImprovementTaskForType()`** — the ~533-line function in `server/services/cosTaskGenerator.js` is decomposed into named metadata-building and gate-checking helpers (`buildImprovementTaskMetadata`, `resolveTaskInputHook`, `resolveClaimWorkRouting`, `applyPerpetualWorkGate`, `resolveBranchReconcileBlock`, `resolveIssueReconcileBlock`, `resolveReferenceWatchBlock`, `resolvePrWatcherBlock`), each returning a `{ skip }` / prompt-block result so the main function reads as a thin orchestrator. Prompt resolution (reviewers/author-filter/swarm directives plus the token-replacement chain) moves into `buildImprovementTaskDescription`, and the provider/model/effort pin layering into `applyProviderModelPins`. Behavior-preserving — no change to task generation, park/convergence semantics, or dispatch ordering.
