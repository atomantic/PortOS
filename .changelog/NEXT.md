# Unreleased Changes

## Added

- **CoS scheduled-task filter (All / Enabled).** The CoS Schedule tab header
  gains an All/Enabled filter persisted in the URL (`?filter=enabled`) so the
  selection is bookmarkable. Counts render once per pass, and each filter
  carries its own empty-state copy so a future filter can't fall back to an
  awkward auto-generated message. Touches
  `client/src/components/cos/tabs/ScheduleTab.jsx`.

- **Character canon: wardrobes (Cluster A).** Every entry under
  `universe.characters[]` gains an optional `wardrobes[]` array — each entry
  is an `{ id, name, description, createdAt, updatedAt }` outfit/styling
  variant layered on top of `physicalDescription`. Each character supports
  up to 10 wardrobes; `name` is the only required field (sanitizer drops
  nameless entries). The Universe Canon + Nouns stage cards render a
  collapsible "Outfits" section per character with an inline editor —
  click-to-expand, inline name + description inputs that buffer drafts and
  PATCH on blur (no per-keystroke round-trips), per-row trash, "Add outfit"
  that stays client-side-only until the user types a name (so a
  half-created row doesn't get sanitized away mid-type). Selective draft
  pruning on row delete preserves in-flight keystrokes in unrelated rows.
  Scene-level wardrobe picking (a panel says "Don Carlos in Wedding
  outfit") is deferred — captured in PLAN.md once the UX is settled.
  Touches: `server/lib/storyBible.js`
  (`sanitizeWardrobe` + `sanitizeWardrobeList` + `BIBLE_LIMITS.WARDROBE_*` +
  `PROMPT_FIELDS` + `MERGE_CONFIG.userEditable`),
  `server/lib/validation.js` (Zod parity sourcing limits from BIBLE_LIMITS),
  `client/src/components/pipeline/CanonCard.jsx` (new `WardrobeSection`).

- **Setting canon: INT/EXT + time-of-day metadata (Cluster A).** Every entry
  under `universe.settings[]` gains two new optional fields — `intExt`
  (`'INT'`/`'EXT'`/null) and `timeOfDay` (`'dawn'`/`'day'`/`'dusk'`/`'night'`
  /null) — that flow through the scene-prompt composer ahead of the description
  fragment so downstream image-gen calls inherit lighting / composition cues
  for free. Sanitizer normalizes case (`int` → `INT`); invalid values fall
  through to null without throwing, so legacy settings keep rendering. The
  scene-prompt builder prepends `Interior, night.` (or whichever subset is
  set) ahead of the existing description / palette / recurring-details
  fragments. Universe Canon + Nouns stage cards surface the new fields as
  inline chip pickers (single-click to set, click again to clear) that PATCH
  via the existing `updateUniverse` write path; reads stay through optimistic
  state so chips feel instant. The places-extraction LLM prompt asks for
  the two new fields in its JSON contract, with an idempotent migration
  (`007-places-int-ext-time-of-day.js`) auto-updating un-customized
  installs. Touches: `server/lib/storyBible.js` (sanitizer + enum
  normalizer + `SETTING_INT_EXT` / `SETTING_TIME_OF_DAY` exports +
  `PROMPT_FIELDS` + `MERGE_CONFIG.userEditable`),
  `server/lib/validation.js` (Zod parity with case-insensitive preprocessing),
  `server/lib/scenePrompt.js` + `client/src/lib/scenePrompt.js` (composer
  metadata fragment), `client/src/components/pipeline/CanonCard.jsx`
  (chip pickers + read-only chips), `client/src/pages/UniverseCanon.jsx`,
  `client/src/components/pipeline/stages/NounsStage.jsx` (optimistic
  PATCH wiring), `data.sample/prompts/stages/writers-room-places.md`,
  `data/migrations/007-places-int-ext-time-of-day.js`, `scripts/setup-data.js`.

- **Pipeline audio stage: music bed muxed into the episode video (Phase 4d).**
  When the Creative Director stitch step finishes the timeline render, a
  second ffmpeg pass overlays the issue's `stages.audio.music.trackFilename`
  as a looped-and-cut music bed (`-stream_loop -1 -shortest`, `-c:v copy`,
  default -6 dB gain). The pass is best-effort: a missing ffmpeg, missing
  music file, or non-zero exit logs and leaves the silent stitch in place
  rather than blocking the whole project. The link runs through a new
  `sourceIssueId` back-pointer on the CD project (set at create time in
  `episodeVideo.js`, validated by the create Zod schema). Per-temp-UUID
  output paths keep a future parallel-stitch scenario from racing on the
  destination filename. VO line muxing (per-scene timed dialogue + music
  ducking) is deferred to 4d.2 in PLAN.md once the gap-between-lines
  heuristic has real-world testing. Touches: new
  `server/services/pipeline/audioMux.js` + tests, `server/lib/validation.js`
  (schema parity), `server/services/creativeDirector/local.js`,
  `server/services/creativeDirector/stitchRunner.js`,
  `server/services/pipeline/episodeVideo.js` + tests.

- **Pipeline audio stage: background-music upload + shared library + picker
  (Phase 4c).** The audio stage now carries an optional music track alongside
  the VO lines, with three new routes: `POST
  /pipeline/issues/:id/stages/audio/music/upload` (multipart upload + attach
  in one round trip; MP3/WAV/M4A/OGG/FLAC, 50 MB max), `POST
  …/music/attach` (re-bind an existing library track to the issue), `DELETE
  …/music` (detach from the issue), plus library-level `GET
  /pipeline/audio/music-library` and `DELETE /pipeline/audio/music-library/:filename`.
  Tracks live under a new shared `data/music/` directory served via
  `/data/music` static; deleting a library file intentionally leaves
  pointers stale on issue records so the broken playback surfaces to the
  user (auto-purge would scan every issue on every delete). The AudioStage
  UI gains a "Background Music" section below the lines list with Upload /
  Pick from library buttons, an inline confirm row for destructive library
  deletes (matching the user's preference for `[Cancel] [Delete]` over the
  two-click-arm pattern), and inline `<audio>` playback for the attached
  track. The `MUSIC_SOURCE` const (`upload | library | gen`) replaces bare
  strings in the routes so the upcoming local-OSS MusicGen sub-phase
  (4c.2) plugs in as a sibling `'gen'` source without a contract change.
  Touches: new `server/services/pipeline/musicLibrary.js` + tests, new
  `server/services/pipeline/musicLibrary.test.js`, `server/routes/pipeline.js`,
  `server/lib/fileUtils.js` (`PATHS.music`), `server/index.js` (static
  mount), `client/src/services/apiPipeline.js`,
  `client/src/components/pipeline/stages/AudioStage.jsx`.

- **`plan-task` scheduled task — strict PLAN.md executor.** New task type in
  `server/services/taskSchedule.js` that picks the next unchecked PLAN.md
  item, implements it (worktree + `/simplify` + PR by default), and **moves**
  the item from PLAN.md to DONE.md in the same commit (mirrored entry under
  today's `## YYYY-MM-DD` section). Unlike `feature-ideas`, it has no
  `runAfter` dependencies and no brainstorm fallback — when PLAN.md is empty
  or every unchecked item is annotated `<!-- NEEDS_INPUT -->`, the task exits
  cleanly. Phase 3b mirrors `feature-ideas`: an infeasible item emits a
  `.plan-questions.md` marker, which `agentLifecycle.js` now converts into a
  `plan_question` notification for both task types. Default schedule: daily,
  disabled, `useWorktree+openPR+simplify`. Surfaces in the workflow visualizer
  alongside `feature-ideas` under the `build` stage; gets a `✅` icon in the
  Upcoming Tasks widget. `TaskItem.jsx#extractTaskType` learned the new
  description shape and matches it ahead of `do-replan` so the substring
  `plan.md` doesn't steal the icon. Touches `taskSchedule.js`, `cos.js`,
  `workflow.js`, `agentLifecycle.js`, `UpcomingTasksWidget.jsx`,
  `TaskItem.jsx`.

- **Comic pages + cover: proof vs final renders, with i2i upscale from
  proof.** Each comic page (and the cover) now carries two render slots —
  `proofImage` (fast layout render) and `finalImage` (hi-res print render).
  The UI exposes two render buttons per row plus a "from proof" checkbox
  that, when ticked for the final render, passes the proof's PNG as the
  i2i init image (denoise strength `0.25` by default) so the larger
  canvas preserves panel layout / character placement instead of redrawing
  from scratch. Codex (gpt-image-2 `$imagegen`) has no init-image input,
  so the checkbox disables with an explanatory tooltip when codex is the
  active backend — picking it anyway falls back to a full redraw with a
  server-side warning. PDF assembly reads `finalImage → proofImage →
  legacy filename` so the print bundle always uses the best available
  resolution per page. Schema caps lifted from 2048 to 3840 per edge with
  a total pixel cap of 8,294,400 (gpt-image-2's hard ceiling) across
  `imageGen.js` + the three pipeline render schemas, and three new codex-
  only presets land in `imageGenResolutions.js`: `3840×2160` (4K
  landscape), `2160×3840` (4K portrait, comic-page default), `2880×2880`
  (4K square). Owner format extended to `pipeline:<id>:comicPages:<target>:<variant>`;
  the filename hook routes completions to the right slot and migrates any
  legacy in-flight job into the new shape on landing, so upgrade is
  zero-friction. Files: `client/src/lib/imageGenResolutions.js`,
  `client/src/components/pipeline/stages/ComicScriptStage.jsx`,
  `server/routes/imageGen.js`, `server/routes/pipeline.js`,
  `server/services/pipeline/{owners,visualStages,comicPagesFilenameHook,
  comicPdf,issues}.js`, `server/services/imageGen/codex.js`. Tests:
  10 `owners.test.js` cases for the variant suffix + legacy parsing; 2
  `pipeline.test.js` render assertions migrated to the new slot shape; 1
  `visualStages.test.js` owner-string assertion bumped.

- **Story shape is now load-bearing across arc planning.** The Vonnegut
  shape picker on the series arc was previously decorative — picked, rendered
  as a sparkline, then ignored by every LLM prompt. Now the picked shape (or
  the LLM's proposed shape when the user hasn't picked one) flows into all
  five arc-planning passes as `{{{shapeGuidance}}}` (rendered curve +
  per-shape beat guidance) plus per-volume `{{shapePosition}}` /
  `{{volumeShapePosition}}` (where this season/volume sits on the curve so
  episode pacing and volume-internal beats follow the right trajectory):
  - `pipeline-arc-overview` — honor-or-propose mode. With a pre-pick the LLM
    must trace the curve and round-trip `shape` in the JSON. Without a pick
    the LLM proposes one from the 8 ids and returns it in the JSON.
  - `pipeline-season-episodes` — episode beats ramp / fall / plateau the
    direction the season's curve placement demands, not just by `arcRole`.
  - `pipeline-arc-verify` — new "story-shape adherence" check (rule 7/8)
    flags volumes whose ending hook contradicts the curve.
  - `pipeline-volume-verify` — new volume-internal adherence check + per-
    volume curve placement context.
  - `pipeline-arc-resolve` — preserves picked shape during auto-resolve.

  **Files:** new `ARC_SHAPES` catalog + `getArcShape` / `renderArcShapeGuidance`
  / `describeArcShapePositionForSeason` in `server/lib/storyArc.js` (points
  arrays kept in sync with the client `STORY_SHAPES` via a parity test);
  `buildArcBaseContext` / `buildArcOverviewContext` / `buildSeasonEpisodesContext`
  / `buildVolumeVerifyContext` in `server/services/pipeline/arcPlanner.js`
  thread shape into prompt contexts; both `data.sample/` and `data/`
  copies of the five prompts updated (resolve added to `data.sample/` for
  the first time — it previously only existed in `data/`); migration
  `005-shape-aware-arc-prompts.js` auto-applies the new templates when the
  installed copy still matches the pre-change shipped hash, skips with a
  manual-merge warning when customized; drift-warning hashes in
  `scripts/setup-data.js` extended to include the new lineage. 16 new tests
  (3 in `storyArc.test.js`, 5 in `arcPlanner.test.js`) lock the catalog
  shape, the position helper edge cases, both overview modes, and the
  season-episodes + volume-verify shape-context wiring.

- **`generateArcOverview` preserves an existing `arc.shape` on regenerate.**
  Sibling `resolveVerifyIssues` already had the right preservation pattern
  (`shape: content?.arc?.shape ?? series.arc.shape ?? null`); the regenerate
  path missed it, so every "Regenerate arc" click wiped a Vonnegut shape
  the user (or the LLM) had picked. **Files:** `server/services/pipeline/arcPlanner.js`
  + regression test in `arcPlanner.test.js`.

- **Beat-sheet expansion — arc / volume / neighbor-issue context block.**
  The `idea` text stage previously generated each issue's beats in isolation
  against the series bible + the user's seed. It now sees the whole frame a
  human editor has open while writing beats: the series arc (logline /
  summary / protagonist arc / themes when populated), the parent volume's
  logline / synopsis / `endingHook` / `episodeCountTarget` / themes, this
  issue's `arcRole` + position-in-volume, the immediate prior + next issue
  in the same volume (beats when expanded, synopsis when not — sourced
  from the current state of each neighbor so regenerating mid-volume picks
  up whatever's been written since), and the prior volume's `endingHook`
  when this is the opening issue of its volume. Regeneration is by design
  current-state-aware: re-running beat generation on issue 3 after issue 4
  is expanded will read issue 4's beats as the "next issue" context. Other
  text stages (prose, comicScript, teleplay) don't get the augment — they
  derive from beats which already encode this. **Files:** new
  `buildIdeaContextAugment` + `shapeNeighborForIdeaPrompt` in
  `server/services/pipeline/textStages.js`, wired into `generateStage`
  only for `stageId === 'idea'`; new `arcRole` field persisted on the
  issue (`server/services/pipeline/issues.js` sanitizer + create + update,
  schema in `server/routes/pipeline.js`, season-episodes commit forwards
  `ep.arcRole`); `ARC_ROLES` promoted from arcPlanner-local to a shared
  export in `server/lib/storyArc.js`; `compareIssuesByPosition` exported
  from arcPlanner.js so the augmenter reuses the canonical issue sort.
  Prompt template rewritten with `{{#arc}}` / `{{#volume}}` / `{{#priorIssue}}`
  / `{{#nextIssue}}` / `{{#priorVolume}}` / `{{#arcRole}}` /
  `{{#positionInVolume}}` Mustache sections that each gate independently on
  presence. New migration `data/migrations/004-augment-idea-expansion-context.js`
  updates installs from the post-003 hash to the new template; the drift
  warning in `scripts/setup-data.js` now accepts array-valued OLD hashes
  so multi-migration lineages still trigger "run migrations" instead of
  false-positive "customized" warnings.

- **Series Pipeline — per-volume Validate volume continuity pass.**
  Complement to the cross-volume Verify arc pass: a new "Validate volume"
  button on each season/volume row runs a deeper, narrower continuity check
  scoped to that single volume. Goes to beat depth (`stages.idea.output`) for
  issues whose beats are expanded; falls back to synopsis depth (`stages.idea.input`)
  for un-expanded issues, so a partially-expanded volume can still be
  validated mid-workflow. Boundary checks against the immediately-prior and
  immediately-next volumes only (the cross-volume arc verify handles distant
  cross-references). Checks: volume-internal arc shape, within-volume
  continuity, beat-level escalation, promise drift, boundary continuity,
  cast economy, volume-scope world-entity drift, and obvious length-vs-weight
  mismatches. Each verify button now also exposes an inline "What this
  checks" disclosure listing its rules and depth so the human editor knows
  what each pass covers (and what it explicitly doesn't) before trusting
  the result. **Files:** new
  `data.sample/prompts/stages/pipeline-volume-verify.md` + stage-config
  entry, new `verifyVolume()` in `server/services/pipeline/arcPlanner.js`,
  new `POST /pipeline/series/:id/seasons/:seasonId/verify` route,
  `verifyPipelineVolume()` API helper, and `VerifyScopeHint` + Validate
  volume button wiring in `client/src/components/pipeline/ArcCanvas.jsx`.

- **Series Pipeline — Vonnegut story-shape picker + sparkline visualization.**
  Series records can now carry an explicit narrative-shape decision drawn from
  Kurt Vonnegut's eight story shapes (Rags to Riches, Tragedy, Man in Hole,
  Icarus, Cinderella, Oedipus, Boy Meets Girl, Creation Story). New
  `series.arc.shape` field; each shape has a label, one-line description, and
  a normalized 7-point [-1, 1] series that drives a small inline SVG sparkline.
  Picker is a 2×4 grid of toggle chips; re-clicking the selected shape clears
  it back to none. Rendered both inline in the create-series form (new row
  alongside the new `Story size` issue/episode-count input — both fields
  thread into the create payload, falling through to server defaults when
  empty) and on the arc-canvas header + edit form for existing series. Each
  series card on the Series Pipeline index shows the shape as a small chip
  next to the name when set. **Files:** new `client/src/components/pipeline/StoryShapes.jsx`
  (display metadata + `ArcShapeSparkline` + `ArcShapePicker`), new
  `ARC_SHAPE_IDS` export in `server/lib/storyArc.js`, `shape` field on the
  arc sanitizer (treated as identifying content — a "shape only" arc survives
  so an explicit narrative-design choice at create time isn't silently
  dropped), schema parity in `server/routes/pipeline.js` (`arcSchema.shape`),
  and arc-resolve LLM merge preserves shape across LLM rewrites
  (`server/services/pipeline/arcPlanner.js`).

- **Stale-build detection — Socket.IO `build:id` event + Vite preload-error catch.**
  The "Failed to fetch dynamically imported module" red error screen after a
  server restart now self-resolves without user action. Two layers:
  - **Build-ID broadcast.** `server/lib/buildId.js` hashes `client/dist/index.html`
    once at boot (the file changes every Vite build because it embeds the
    bundle-hash filenames), injects `<meta name="portos-build-id" content="…">`
    into the served HTML, and exposes `getBuildId()` to the socket service.
    `express.static(CLIENT_DIST, { index: false })` so `/` flows through the
    SPA-fallback handler (which serves the stamped HTML) instead of being
    short-circuited by static. `initSocket` emits `build:id` on every connect.
    Client reads its embedded build id from the meta tag and on mismatch shows
    a sticky toast ("New build available. [Reload]") with a manual reload
    button — protects unsaved input. JSX-bearing toast extracted to
    `staleBuildToast.jsx` so `socket.js` stays JS.
  - **`vite:preloadError` listener in main.jsx.** Catches the chunk-preload
    404 *before* it propagates to React's error boundary, falls through to
    `reloadOnceForStaleChunk()`. Anti-loop guard now keys its sessionStorage
    flag on the build id (was a single session-wide one-shot, which left the
    user stranded on the error screen after a second rebuild — a fresh build
    now gets a fresh reload attempt). Same handler also runs on
    `unhandledrejection` so a stale-chunk rejection outside React's tree is
    caught too.

- **Comic Pages — rendered filename persisted on the record (survives queue TTL).**
  Comic-page records previously stored only `imageJobId`. After the
  mediaJobQueue's 24-hour archive TTL, the UI could no longer resolve
  a filename to render — even though the PNG was still on disk — and
  `MediaJobThumb` showed a spinner forever. New
  `server/services/pipeline/comicPagesFilenameHook.js` subscribes to
  `mediaJobEvents('completed')` and stamps `filename` onto
  `stages.comicPages.cover` / `.pages[i]` at completion time
  (gated on a still-matching `imageJobId` so a re-render between
  enqueue and completion doesn't overwrite the newer filename with the
  older one). New shared owner builder/parser
  (`server/services/pipeline/owners.js`) replaces inline owner-string
  templates in `visualStages.js` and the hook's regex so producers
  and consumers can't drift. `MediaJobThumb` short-circuits on
  `fallbackFilename`: when the parent has the saved filename, the
  component skips the live `getMediaJob` fetch and socket subscription
  entirely (no more 404s on completed-and-pruned jobs). Re-render
  routes (`comicPages/cover/render`, `comicPages/pages/:i/render`)
  clear `filename: null` alongside setting the new `imageJobId` so
  the stale image doesn't flash while a fresh render is in flight.


  Sharing a universe now bundles the linked media collection ("Universe:
  <name>" — the bucket of images the user generated via Universe Builder),
  so recipients see those images alongside the universe instead of an
  empty canon. Two pieces:
  - **Explicit `universeId` field on `mediaCollections`.** The universe-
    builder route now stamps the link at create time
    (`findOrCreateCollectionByName({ ..., universeId })`); legacy
    "Universe: <name>" collections get lazy-backfilled when the route
    re-uses them. Replaces the prior name-only convention so subsequent
    universe renames don't break the link.
  - **Exporter bundles the collection.** `exportUniverse` (and
    `exportSeries` when its series links a universe) finds the linked
    collection, includes a `manifest.collection` payload
    `{ name, universeId, items }`, and walks every item's asset
    filename + associated media-job record into the bucket. Recipients'
    importer find-or-creates a local collection by `universeId` and
    unions the items in (existing `ERR_DUPLICATE` semantics dedup so
    repeated processing is a no-op).
  - **Mutation triggers re-export.** `mediaCollections.addItem` /
    `removeItem` now emit `recordEvents('updated', 'universe',
    universeId)` when the collection carries a `universeId`. The
    subscription listener picks this up with the same 3-second debounce
    as record edits, so new images generated locally for a subscribed
    universe auto-flow to the bucket without the user re-clicking
    Share.
  - **Inbox UI shows the count.** Inbox entries now display
    "+ N collection items (Universe: <name>)" alongside the asset
    count so the user knows what they're accepting on promote.

  **Files:** `mediaCollections.js` (universeId field + emits on
  add/remove), `routes/universeBuilder.js` (pass universeId on create),
  `sharing/exporter.js` (linked-collection lookup + bundle helper),
  `sharing/manifest.js` (manifest.collection field), `sharing/importer.js`
  (mergeCollectionPayload + inbox surfacing), `Sharing.jsx` (inbox UI).
  Test: new integration round-trip covers export → delete locally →
  import → collection + items + assets all restored.

- **Sharing v1.3 — subscriptions: toggle on/off, updates auto-flow.**
  Rewrote the share-bucket model from one-shot manifests to persistent
  subscriptions, addressing two real UX gaps:
  1. The ShareToButton's always-on gray check icon made every bucket look
     "already checked" with no way to tell what was actually shared. The
     icon is now a real state indicator — filled CheckCircle on subscribed
     buckets, empty Circle otherwise.
  2. Every click previously wrote a fresh timestamped manifest, so picking
     the same bucket twice produced two manifests. Now each (bucket,
     record) pair is a single subscription whose manifest lives at a
     deterministic filename in the bucket; re-exports overwrite in place.
  - **Subscription model.** A subscription is a `(bucketId, recordKind,
     recordId)` tuple persisted in `data/sharing/subscriptions.json`. The
     subscribable kinds are `series` and `universe` (records that mutate
     over time). Media stays one-shot — items don't change after creation.
  - **Auto-re-export on edit.** A small `recordEvents` EventEmitter is
     fired by `updateSeries`, `updateIssue` (re-emits its parent series),
     and `updateUniverse` after each successful persist. The subscriptions
     service listens with a per-subscription 3-second debounce and re-exports
     the affected record into every bucket it's subscribed to. Recipients
     see the change via chokidar's `change` event.
  - **Content-aware cursor.** The bucket cursor now stores `{filename:
     manifestId}` so a re-import of the same subscription filename with a
     fresh manifestId processes the update, while legacy `processed[]`
     entries from v1.0–v1.2 still suppress re-imports of one-shot manifests.
  - **Unshare propagation.** Clicking a subscribed bucket again unsubscribes:
     the registry row is removed and the bucket-side file is deleted.
     Recipients' watchers fire `unlink`, which clears the cursor entry,
     drops any pending inbox row for that subscription, and emits a
     `sharing:unshared` socket event. The recipient's already-imported
     local record is NOT reverted — they keep what they have, just stop
     receiving updates.
  - **Inbox collapse.** Subscription manifests in inbox mode replace any
     prior inbox entry for the same `(recordKind, recordId)` so the user
     always sees the latest snapshot, not a pile of revisions.

  **Endpoints:** new `GET /api/sharing/subscriptions[?filter]`,
  `POST /api/sharing/subscriptions`, `DELETE /api/sharing/subscriptions/:id`.
  **Files:** new `server/services/sharing/{recordEvents,subscriptions}.js`,
  changes to `manifest.js` (cursor + filename), `exporter.js` (subscription
  opt-in), `importer.js` (content-aware dedup + `handleUnshare`),
  `watcher.js` (`unlink` handler), `pipeline/{series,issues}.js` +
  `universeBuilder.js` (emit on update), `routes/sharing.js`, and
  `client/src/components/sharing/ShareToButton.jsx`. Tests: 11 new (7 unit
  for the subscriptions service, 4 covering the new cursor and
  deterministic-filename behavior, plus an integration round-trip).

- **Universal folder-picker UX — Sharing + Backup + Templates.**
  Three places that ask the user for a server-side folder path now all
  use the same `FolderPicker` component (a folder-icon button that opens
  a modal directory browser backed by `GET /api/scaffold/directories`).
  Wired into the Sharing page's add-bucket form and the Backup settings
  tab so the user no longer has to hand-type a path. Migrated
  `Templates.jsx` off its inline-dropdown `DirectoryPicker` so the
  codebase converges on a single picker primitive; `DirectoryPicker.jsx`
  removed. The picker's existing UX (modal overlay, Windows drive
  selector, Home shortcut, click-outside/Escape) is preserved.

- **Sharing v1.2 — schema versioning + producedBy attribution.**
  Defensive plumbing so PortOS version drift between peers fails loudly
  instead of silently corrupting shares. Every outgoing artifact (manifests
  and bucket.json) is stamped with `SHARING_SCHEMA_VERSION` (the on-the-
  wire protocol version) and `producedByVersion` (the PortOS app version
  read from package.json).
  - **Importer compatibility gate.** `processManifest` reads the manifest's
    `sharingSchemaVersion` and refuses anything newer than what the local
    PortOS understands. The cursor still records the filename so the
    chokidar watcher doesn't replay it on every event, and a new
    `sharing:incompatible-manifest` socket event surfaces a clear error
    toast ("Can't import share from <peer> (PortOS X.Y.Z) — protocol vN
    requires upgrading PortOS"). Older versions still merge cleanly.
  - **UI surfacing.** Each bucket card now shows its schema version with a
    warning indicator when the remote bucket's version exceeds the local
    PortOS. Inbox + activity entries display the producing peer's PortOS
    version next to the source name so the user knows who's running what.
  - New `server/services/sharing/version.js` is the single source of
    truth — `SHARING_SCHEMA_VERSION`, `isManifestCompatible`,
    `getProducedByVersion()`. The `updateChecker.getCurrentVersion`
    import is dynamic so the eager-PATHS chain doesn't leak into modules
    that other tests lazy-mock.

- **Sharing v1.1 — id-preserving auto-merge + override notifications.**
  Round-trip refinements on top of the v1 share-buckets feature:
  - Imports now insert under the manifest's original record id (new
    `insertSeriesWithId` / `insertIssueWithId` / `insertUniverseWithId`
    helpers). A subsequent re-share of the same series LWW-merges onto
    the same local row instead of accumulating a duplicate. Issue
    `seriesId` references stay valid across peers without rewiring.
  - `applyAutoMerge` now returns an `overridden[]` list naming the local
    records LWW-overwrote by an incoming share. A new global
    `useSharingNotifications` hook (mounted in `Layout.jsx`) listens to
    the `sharing:manifest-processed` socket event and toasts the user —
    suppressed when they're already viewing `/sharing`. Suffices for
    "your work just got changed by peer X" awareness without modal noise.
  - Integration tests at `server/services/sharing/integration.test.js`
    exercise the full export → manifest → import round-trip in both
    `inbox` and `auto-merge` modes, plus cursor-dedup on replay.

- **Cross-network sharing via cloud-synced folders (share buckets).**
  Pipeline series (with all issues + linked universe), universes, and
  individual media can now be shared with peers on **different Tailscale
  networks** by exporting into a cloud-synced folder (Google Drive, Dropbox,
  iCloud Drive, Syncthing, USB stick). PortOS reads/writes a stable layout
  inside the folder; the cloud-sync app handles cross-network transport, so
  no PortOS-side broker is required.
  - New **Sharing** page at `/sharing` (under Create in the sidebar +
    `⌘K`-reachable) registers each synced folder as a "bucket" with a
    per-bucket import mode: `inbox` (incoming shares queue for explicit
    review) or `auto-merge` (LWW into the local working set on arrival).
  - **ShareToButton** on the Pipeline series list, UniverseBuilder toolbar,
    and Media Collection detail bulk-action bar exports the selected record
    into any registered bucket. **OriginBadge** chips render on every
    imported record with the sharer's display name + bucket name + import
    timestamp.
  - **Full-fidelity gen metadata.** Exports walk each record's
    `imageJobId` / `sceneVideoJobId` / `imageRefs` / `videoPath` references,
    copy the underlying asset (+ sidecar metadata JSON) into the bucket's
    `assets/{images,videos}/`, and write the full `media-jobs.json` entry
    (prompt, negative prompt, model, seed, sampler, dimensions, ref images,
    audio inputs, LoRA selections, etc.) into `records/media/<jobId>.json`
    so recipients can Regenerate / Iterate with identical parameters.
  - **Source attribution.** A user-configurable `sharingDisplayName` +
    optional `sharingBio` (in PortOS settings, with per-bucket overrides)
    is stamped onto every outgoing manifest and every record's
    `origin.{ bucketId, bucketName, source, sourceBio, manifestId,
    importedAt }`. Recipients see attribution via `<OriginBadge>` on
    imported records.
  - **chokidar** watcher attaches to each bucket's `manifests/` directory
    on boot and on bucket registration; backlog processing catches any
    manifests that arrived while the server was offline. Per-bucket cursor
    dedup (`data/sharing/cursors/<bucketId>.json`) ensures the same manifest
    is never imported twice.
  - **Privacy note:** the cloud-sync provider sees bucket contents in
    plaintext; this is no different from any Google Drive folder share and
    is surfaced inline on the Sharing page.

  **Files:** new `server/services/sharing/{index,buckets,manifest,exporter,
  importer,watcher}.js`, `server/routes/sharing.js`,
  `server/lib/sharingOrigin.js`, `client/src/pages/Sharing.jsx`,
  `client/src/components/sharing/{ShareToButton,OriginBadge}.jsx`,
  `client/src/services/apiSharing.js`. `series` / `issues` / `universes` /
  `media-collections` sanitizers gained an optional `origin` field. Tests:
  `server/lib/sharingOrigin.test.js`, `server/services/sharing/{buckets,
  manifest}.test.js`.

- **Pipeline — per-issue length profile, per-stage gen config, comic front cover.**
  Three additive pipeline-UX features rescued from a pre-crash recovery branch
  and cherry-picked into main:
  - **Length profile picker** in the pipeline issue header. Sets
    `issue.lengthProfile` (`teaser` / `standard` / `extended` / `finale` /
    `custom`) plus optional `pageTarget` + `minutesTarget`. New
    `server/lib/issueLength.js` materializes the profile into prompt-template
    variables (`{{lengthTargets.profile}}`, `pageTarget`, `minutesTarget`,
    `proseWordsMin/Max`, `beatsMin/Max`) that the idea, prose, comic-script,
    TV-script prompts now consume — beat counts, prose word ranges, and page
    counts scale with the picked profile instead of being hardcoded to 22
    pages / 24 minutes. The season-episodes generator emits a `lengthProfile`
    per episode so a finale auto-scales without manual tweaking.
  - **Per-stage generation settings.** New gear-icon modal in the issue
    header on the **Storyboards** tab exposes `imageMode` (`auto` / `local` /
    `codex`), pinned local image model, and a refine-LLM override. Persisted
    on `stages.<stageId>.genConfig` so reloads keep the user's choice; the
    Comic editor (`comicScript` tab) keeps its existing image-gen drawer so
    the gear stays off that tab to avoid duplicate controls. The same
    `genConfig` shape persists on `stages.comicPages.genConfig` as well —
    threaded through `generatePipelineComicPage`,
    `generatePipelineVisualImage`, and the two refine-prompt endpoints —
    so a future header-gear extension to the Comic tab can opt in without
    a schema change. Visual stages' server resolver now defaults to codex
    when `imageGen.codex.enabled` (still falls back to local diffusion
    otherwise).
  - **Comic-issue front cover.** Optional cover concept per issue persisted
    on `stages.comicPages.cover` (`script` + `imageJobId` + `prompt`). New
    `POST /pipeline/issues/:id/stages/comicPages/cover/render` route builds
    the cover prompt server-side (series masthead + issue-number tag + the
    user's concept) and enqueues an image-gen job; the cover card sits
    above the page list in the Comic tab (the merged Comic editor).
  - **Comic-script parser** now recognizes an optional `## Cover concept`
    section and the simpler `Panel N` / `Field:` plain-line format the
    updated prompts emit, alongside the legacy `### Panel N` /
    `**Field:**` form. `parseComicScript` returns
    `{ coverConcept, pages: [{ rawText, panels }] }`.

- **Shell — UUID-based URLs for each sub-shell session.** The shell page now
  mounts at `/shell/:sessionId` in addition to `/shell`, and mirrors the active
  session id into the URL whenever a session is started, attached, or switched.
  Reload preserves the active shell, the URL is shareable as a deep link, and
  browser back/forward + manual URL paste switch between live sessions.
  Stopping or killing the active session (or its PTY exiting with no remaining
  sessions) clears the URL back to `/shell`. The pre-existing `?session=<uuid>`
  query-param (one-shot "attach to this session") still works alongside the
  new path param.
  - **Attach-failure recovery.** Switching sessions no longer pre-clears the
    displayed session — `sessionIdRef` only swaps on `shell:attached`. If the
    target session dies between list read and attach (race), `shell:error`
    restores the URL + terminal to the previously displayed session (or falls
    back to a live survivor) instead of stranding the UI on a dead URL.
  - **Multi-tab handoff notification.** Opening the same `/shell/:sessionId`
    in a second tab takes over the PTY socket (single-subscriber by design).
    The server now emits `shell:detached` to the previous socket so the
    original tab clears its disconnected view + navigates back to `/shell`
    instead of sitting "Connected" with no output.
  - **Auto-pick won't steal an attached session.** Session list entries now
    carry `attached: boolean` from the server. Every auto-pick path on the
    client (initial load, external-kill fallback, shell:exit fallback,
    shell:error recovery) filters survivors to ones that aren't already
    driving another tab. Manual tab clicks and deep-link URL navigation
    still take over (intent is explicit). Prevents tab B from booting
    tab A off its shell when tab B's session is killed externally.
  - **`attached` is recipient-relative.** `listAllSessions` and
    `broadcastSessionList` now personalize each subscriber's payload so
    `attached` only reports `true` when the session is bound to a
    *different* socket. Sessions bound to the recipient's own singleton
    socket (e.g. sessions opened earlier in this tab that stayed bound
    when the user navigated away and back) report `attached: false`, so
    the client's auto-pick path adopts them on return instead of leaving
    bare `/shell` disconnected.
  - **Pending-attach gate.** A new `pendingAttachRef` tracks the in-flight
    start/attach target. While set, keystrokes and quick commands are
    dropped (so input doesn't land in the previous session during the
    "Attaching…" window), incoming `shell:output` is suppressed (so the
    old session's stream doesn't paint into the cleared terminal), and
    stale `shell:attached` responses for an older target are ignored when
    the user rapid-fire-clicks tabs.
  - **Start-failure error message preserved.** When `shell:error` fires
    from a start attempt while an existing session is still alive (e.g.
    session limit hit), `handleShellError` no longer re-attaches and
    repaints the terminal — the error stays readable. Re-attach recovery
    now triggers when the URL diverged from the active session (URL-nav
    switch failure) OR when `pendingAttachRef` was for a different session
    at the time of error (tab-click switch failure — URL never moved
    because `activateSession` never fired). The start-failure path
    (`pendingAttachRef === 'new'`) leaves the terminal untouched so the
    error message survives.
  - **Layout full-width includes deep links.** `Layout.jsx` matches both
    `/shell` and `/shell/<id>` for full-height/overflow-hidden styling so
    deep-linked terminals render edge-to-edge like the bare route.
  - **Server-side claim semantics for auto-pick.** Client auto-pick paths
    (initial load, external-kill recovery, shell:exit fallback, error
    fallback, bare-/shell adoption) now send `shell:attach` with
    `claim: true`. The server's `attachSession` honors it — if the session
    is bound to a different socket, the attach is refused with a
    `claimRejected` result and the client gets `shell:error` with
    `sessionId` for correlation. Manual paths (tab click, deep-link URL)
    still default to `claim:false` (takeover semantics). Prevents two
    idle tabs receiving the same `shell:sessions` broadcast from racing
    to attach the same survivor and booting each other.
  - **Strict-equality pending tracking.** Replaced the simple
    `pendingAttachRef` with a `{ target, generation }` shape and helpers
    `setPendingAttach` / `cancelPendingAttach`. Response handlers
    (`handleShellAttached`, `handleShellStarted`) consume only when
    target matches exactly, so a cancelled-mid-flight attach can't
    re-navigate after Stop. Deferred work (setTimeout fallbacks) captures
    generation and aborts if the user changed their mind during the
    delay window.
  - **Server-correlated attach errors.** `shell:error` from `shell:attach`
    failures now carries the requested `sessionId`. The client matches it
    against `pendingAttachRef.current.target` to recover the correct
    request and ignores stale errors from earlier rapid clicks. Passive
    errors (`shell:input` to a missing session) carry sessionId too but
    don't match a pending request, so they don't mutate pending state.
  - **Intentional vs passive idle preserved across reconnect.** Initial-
    load auto-attach (which also runs on every reconnect because
    `handleConnect` resets `hasInitializedRef`) gates on `!userIdleRef`,
    and the empty-list auto-start branch does too. A transient
    disconnect no longer re-adopts a session — or spawns a new one —
    that the user had explicitly stopped.
  - **handleShellExit / Detached / external-kill respect pending.** When
    the displayed session dies but the user has an attach in flight to a
    different session, the recovery handlers now skip their auto-pick
    fallback and let the pending request complete. Previously,
    `clearActiveSession` was implicated in cancelling the user's
    in-flight switch by tearing down pending state alongside the
    displayed session.

- **Universe Canon page — lock toggle, tag chips, and "from series" badge on every card.**
  Phase 2a of the Universe-as-Canon UI. Each `CanonCard` (used on both the
  Universe Canon page and the per-series Nouns page) now renders:
  - A **Lock / Unlock** button (only on pages that pass `onToggleLock`; the
    Nouns page omits it since per-series canon doesn't have universe-level
    locks). When the entry is locked, the card border picks up the accent
    color, a `Locked` pill appears next to the name, the "AI: differentiate"
    button disables with an "Unlock to refine" tooltip, and the toggle button
    flips to "Unlock" with an unlock-icon glyph.
  - A `from series` badge (titled with the introducing series id) when the
    entry's `sourceSeriesId` is set — so a user scanning the universe
    immediately sees which canon came from prose extraction vs. universe
    expand or manual authorship.
  - A row of tag chips when `entry.tags[]` has items — surfaces the
    `landscape` / `vehicle` / etc. tags the categories→canon backfill
    stamps, plus any tags the user adds later.
  New client helper `setUniverseCanonLock(universeId, kind, entryId, locked)`
  calls the Phase 1 `PATCH /api/universe-builder/:id/canon/:kind/:entryId/lock`
  route. ESLint clean, Vite production build green.

- **Universe-as-Canon lock semantics — series-extracted canon arrives auto-locked.**
  Every canon entry on a universe (characters/settings/objects) can now carry a
  `locked: true` flag, plus `prompt`, `tags`, `source`, and `sourceSeriesId`
  fields. When a series with a linked universe runs prose extraction (`prose`
  stage auto-extract or the `/extract-bible` route), every NEW canon entry it
  inserts is stamped `source: 'series-extract'`, `sourceSeriesId: series.id`,
  and `locked: true`. This protects an active series's canon from being
  silently rewritten by a later refine / re-extract / differentiate-cast pass
  against the universe — the human operator unlocks the entry first when they
  want regeneration to touch it.
  - **Refine + Differentiate honor locks.** `POST /:id/characters/:entryId/refine`
    returns 409 (`UNIVERSE_CANON_LOCKED`) on a locked character. The
    `differentiate-cast` flow sends the full cast to the LLM (so unlocked
    rewrites stay distinct from locked descriptions) but discards rewrites
    targeting locked ids at apply time — locked `physicalDescription` round-
    trips verbatim. New `skippedLocked` count surfaces alongside the existing
    `touched` / `skipped` counts in the response.
  - **`mergeExtractedBible` lock-aware semantics.** Locked entries pass
    through narrative-field overwrites intact; only `evidence[]` is appended
    (deduped) so the crossover trail still grows across multiple extractions.
    `firstAppearance` and `missingFromProse` are not touched on locked
    entries.
  - **Categories→canon backfill on first read.** v1 universes (no
    `schemaVersion` on disk) load through `sanitizeTemplate` and have every
    `categories[key].variations[i]` copied into the matching canon array as a
    new entry — characters → `characters[]`, landscapes/environments →
    `settings[]` (tagged `landscape` / `environment`), vehicles/structures →
    `objects[]` (tagged `vehicle` / `structure`), and any custom category
    bucket flows into `objects[]` tagged with the bucket name. The migration
    is idempotent (`schemaVersion: 2` stamped after first read and persisted
    so user-renamed entries survive subsequent loads). Categories continue to
    coexist with canon arrays during the UI transition; a follow-up retires
    `categories` once the UI reads canon directly.
  - **New lock-toggle route.** `PATCH /api/universe-builder/:id/canon/:kind/:entryId/lock`
    with `{ locked: boolean }` toggles a single entry's lock. Unlock strips
    the field entirely so the on-disk shape stays minimal (only `true` is
    persisted, mirroring the variation pattern).
  - **Source vocabulary.** Legacy `source: 'user' | 'ai' | 'imported'`
    accepted on read for back-compat; new universe-canon writes use the
    semantic `source: 'universe-expand' | 'series-extract' | 'manual'`
    vocabulary. Writers-room flows continue to write the legacy values, so
    the existing badge UI in `CharactersBible.jsx` / `SettingsBible.jsx` /
    `ObjectsBible.jsx` is unaffected.
  - **Tests.** 8 new storyBible cases (sanitizer extras + lock-aware merge +
    autoLock provenance), 3 new universeBuilder cases (backfill + idempotence
    + no-overwrite), and a new `universeCanon.test.js` file with 10 cases
    covering `setCanonEntryLock` + refine refuses locked + differentiate
    skips locked + extract autoLock pass-through. Full server suite (4,525
    tests) passes.

- **TUI providers — codex, claude code, gemini in attachable shells.** New
  provider type `tui` runs CoS agents inside a PTY-backed shell session that
  the user can attach to mid-run from the Shell page (`/shell?session=…`).
  Ships disabled-by-default entries for `codex-tui`, `claude-code-tui`, and
  `gemini-tui` in `data.sample/providers.json`; existing deployments pick
  them up automatically because `scripts/setup-data.js` now JSON-merges new
  `providers` entries on update (same starter-merge pattern as
  `prompts/stage-config.json`). The Shell page's quick-command toolbar also
  gains a `gemini` button alongside the existing `claude` / `codex` buttons.

- **Universe canon — characters, places, and objects on the universe.** Phase A
  of the Universe-as-canon refactor. `universe.characters[]`/`settings[]`/
  `objects[]` arrays now live on the universe record alongside the existing
  prompt-template categories (additive — existing universes load with empty
  canon arrays). New routes:
  - `POST /api/universe-builder/:id/extract-canon` — pulls characters/places/
    objects from a prose body and merges into canon. Mirrors the series-side
    bible extractor.
  - `POST /api/universe-builder/:id/characters/:entryId/refine` — single-
    character rewrite (same prompt as the series-side refine).
  - `POST /api/universe-builder/:id/characters/differentiate-cast` — one LLM
    call rewrites every character's `physicalDescription` to push the entire
    cast apart on ethnicity/age/build/hair/wardrobe so no two characters
    render visually interchangeable. New prompt template
    `pipeline-character-differentiate-cast.md`.

  A new **Canon** page (`/universe-builder/:universeId/canon`) accessed via
  the Library button on the Universe Builder header surfaces all three
  operations + per-entity reference renders + click-to-preview thumbnails.
  Shared `CanonCard` component used by both the Universe Canon page and the
  per-series Nouns page (the per-series view stays alive until Phase B
  migrates series.cast → universe references).

  Image-delete now purges canon refs from both the series store AND the
  universe store, so deleting a reference image from the gallery cleans both.

- **Pipeline Issue — merged Comic Pages tab.** Comic Script + Comic Pages are
  now one tab labeled *Comic Pages*. Each row is a per-page editable markdown
  textarea on the left and the rendered full-page comic image on the right.
  Generating from prose auto-splits the script into pages. Panels are still
  parsed internally so the image prompt stays high-quality, but the
  panel-level UI is gone — the user only sees pages. A new
  `PATCH /pipeline/issues/:id/stages/comicPages/pages/:pageIndex` endpoint
  accepts an edited `rawText` and re-parses panels. The comic-script parser
  now emits a per-page `rawText` slice; legacy pages without one fall back to
  reconstructing markdown from their structured panels, so existing series
  don't lose data.

- **LLM provider+model picker on issue pages.** The `SeriesLlmPicker` from
  the arc header is now also rendered at the top of every issue stage page
  (idea / prose / comic / TV script / etc.), bound to the same `series.llm`
  field. Idea generation, prose generation, comic-script generation, and
  auto-run-text all thread the choice into their `providerId` / `model`
  payloads. Changing the provider on one page updates it everywhere.

- **Codex CLI assistant-reply extractor.** New `server/lib/codexAssistantExtract.js`
  carves out just the assistant reply from Codex's full session transcript
  (banner + metadata + echoed prompt + `codex\n<reply>` + `tokens used: ...`
  footer). Applied unconditionally in `stageRunner.js` — idempotent for
  non-Codex providers. Text stages no longer ship the whole transcript in
  their output; JSON stages get a cleaner walker input as a side benefit.
  Fixes prior runs where comicScript / prose / idea outputs captured the
  banner + echoed prompt alongside the real response.

- **Pipeline Issue — answer-and-refine flow for beat-sheet open questions.**
  The idea stage prompt now tells the LLM to commit to decisive choices
  rather than hedging — `## Open questions` is OPTIONAL and only used when
  something fundamentally needs user input the LLM can't infer from the
  bible. When the section does appear, the idea page renders a panel below
  the output with one input per question and a *Refine with answers* button
  that re-runs the stage with the answers folded into the seed and
  instructions to drop the open-questions section in the revision. Blank
  answers tell the LLM to commit to its own best guess on that item.

- **Pipeline Series — configurable per-series AI provider + model.** The arc
  header now has provider + model dropdowns (mirroring the World Builder
  expansion picker) bound to a new `series.llm = { provider, model }` field.
  The choice persists on the series and is threaded into every arc operation —
  Generate / Regenerate arc, Verify arc, Resolve, and per-season Generate
  episodes — so the whole arc workflow runs against one consistent provider.
  Defaults to the active system provider when unset.

- **Pipeline Series — granular continuity context for season generation and
  verification.** When generating volume N's episode breakdown, the LLM now
  receives the actual per-episode beats of all prior volumes (pulled from each
  issue's `stages.idea.input`), not just the season-level synopses. The
  Verify arc pass also sees those per-episode synopses, so it can finally
  catch contradictions like "S1E7 introduces a character never referenced
  again" or "S2E3 implies a state S1's final episode hasn't reached" — the
  prompt has always asked for these checks, but with only episode titles
  visible the LLM had to bluff.

- **Pipeline Series — automatic bible extraction after generation.** After a
  successful per-season *Generate episodes* run, the server now extracts new
  characters / settings / objects mentioned in the new episode loglines and
  synopses, deduplicates them against the existing bible, and merges them in.
  The same extraction also fires after every successful prose-stage
  generation (`stages.prose`). Result: characters introduced mid-writing flow
  back into the series bible automatically, so downstream visual stages
  render the same character consistently across issues. Toast on the
  episodes-generate flow now reads `"Generated 11 episodes (+3 chars, +2
  settings, +1 objects extracted)"`.

- **Pipeline Series — character physical descriptions reach image
  composers.** `composeComicPagePrompt` and `composeVisualPrompt` now receive
  the matched character profiles for everyone speaking on the page or named
  in a storyboard scene's description, and prepend a "Featuring — NAME:
  <physicalDescription>; ..." clause to the diffusion prompt. A new
  `matchCharactersInText` helper word-boundary-scans free-text scene
  descriptions for bible character names + aliases (the comic-page path uses
  the structured dialogue character field directly). Same character now
  renders the same way across panels, pages, and scenes.

- **Pipeline Series — auto-resolve verification findings.** The verify panel
  now has a *Resolve all* button at the top and a per-finding *Resolve* button
  on each row. Each kicks off an LLM pass that rewrites the arc + volume
  outlines (logline, summary, synopses, episode-count targets) to address the
  selected finding(s) and persists the result. Per-issue scripts are never
  touched. New stage prompt `pipeline-arc-resolve` and route
  `POST /pipeline/series/:id/arc/resolve-issues`.

- **Pipeline Series — recommended-structure hint.** The *Target issues /
  episodes* field shows a live suggestion next to it ("3 volumes × 8
  episodes", etc.) computed from comic-as-TV norms: 1 volume for ≤ 12, 2 for
  13–17, 3 for 18–32, 4 for 33–44, 5 beyond. The arc-overview LLM prompt now
  receives the same recommendation so it stops slicing 12-issue runs into
  three 4-issue seasons.

- **Pipeline Series — linked World context flows into arc planning.** The
  arc-overview, verify, resolve, and season-episode-breakdown prompts now
  receive the linked World Builder world's full entity set (categories like
  factions / characters / environments / artifacts + composite reference
  sheets + influences). The LLM is instructed to ground every volume's
  logline and synopsis in those entities by name rather than inventing
  parallel ones, and the verify pass flags arc references that don't exist
  in the world (or major world entities that go entirely unused).

- **Pipeline Series — auto-flush bible state before LLM actions.** Clicking
  *Regenerate arc*, *Verify arc*, *Resolve all*, or *Resolve* now first
  pushes any pending local bible edits (issue count target, logline,
  premise, etc.) to the server so the LLM runs against the on-screen state
  rather than the last manually-saved snapshot.

- **Pipeline — Nouns stage between Prose and Comic.** New UI-only tab that
  surfaces, per-issue, the characters / settings / objects appearing in the
  prose. Each entry shows its canonical description and an `imageRefs[]`
  thumbnail strip with a *Render reference* button that fires a styled image
  gen and pins the resulting filename onto the series bible — so the
  comic-page renderer (which now cites those rich descriptions in its prompt)
  keeps characters and settings visually consistent across pages without
  having to pass actual reference images (which Codex's `$imagegen` doesn't
  accept). Extract from prose lives here now too; removed from the Prose tab.
  Reference renders inherit the linked world's `stylePrompt` + `negativePrompt`
  via `composeStyledPrompt`, so the aesthetic stays consistent with comic pages.
  The card defers the series PATCH until the job's `useMediaJobProgress`
  reports `completed`, so the UI never tries to load a not-yet-written
  `/data/images/<jobId>.png`.

- **Comic page renderer — cite settings + objects in the prompt, not just
  characters.** `enqueueVisualComicPage` now builds the matched bible set
  from the union of dialogue CAPS speakers and panel description / caption /
  SFX prose. `composeComicPagePrompt` emits new `Setting — <name>: …, palette,
  recurring details` and `Notable — <name>: <description>` clauses alongside
  the existing `Featuring —` clause. Fixes the case where a panel like
  "Wren pins the navy woman's wrist against the pavement" rendered with the
  model re-improvising both subjects every time because dialogue-only
  matching never saw them. New `matchSettingsInText` + `matchObjectsInText`
  mirror the character matcher; all three share a private
  `matchEntriesByCandidates` helper.

- **Pipeline image-gen — DRY settings form + codex-by-default for comic
  pages.** New `ImageGenSettingsForm` component bundles the backend chip
  strip + per-model controls + style textareas behind a single
  `{value, onChange}` contract; reused by the Comic Pages tab and the new
  Nouns tab. Settings persist to `settings.pipeline.imageGen` and default to
  Codex whenever the system has `imageGen.codex.enabled === true`, matching
  the recommendation that cloud models render comic pages dramatically
  better than local diffusion. Default resolution is now `1024×1536`
  (2:3 portrait, the closest preset to a real comic-book trim) instead of
  `1024×1024`. Right-side `Drawer` opened via a header gear button.

- **Pipeline image-gen — seed support for comic page + scene renders.**
  `comicPageRenderSchema` and `visualGenerateSchema` (server) now accept
  `seed`, and `enqueueImageJob` threads it into the queued job params.
  Client form exposes a seed input + random-dice button. Local mflux and
  diffusers runners honor it; codex still picks its own.

- **Series bible — `imageRefs[]` on settings and objects.** Previously
  characters-only; the Nouns stage's *Render reference* button writes to all
  three. Pipeline route schemas already use `.passthrough()`, so the client
  PATCH round-trips cleanly through the canonical sanitizer with no other
  schema changes.

- **Backup defaults — skip large re-downloadable assets, with per-default override.**
  `loras/*.safetensors`, `repos/`, `cos/reference-repos/`, and `browser-downloads/`
  are now in the built-in `DEFAULT_EXCLUDES` for scheduled and manual backups,
  so the default snapshot no longer balloons by tens of GB of LoRA weights,
  cloned upstream repos, and browser download cache when the user just wants
  their data backed up to iCloud or an external drive. Each new entry is
  tagged `overridable: true`; the Backup settings page renders a toggle per
  overridable default so users can opt to back them up by adding the path
  to a new `backup.disabledDefaultExcludes` array. The pre-existing
  `browser-profile/` + `cos/worktrees/` + `cos/feature-agents/*/worktree/`
  entries stay `overridable: false` (cache/ephemeral data with no
  irreplaceable user content) and continue to be skipped unconditionally.
  Plumbed through `runBackup()`, the route, the scheduler, and
  `backupConfigSchema`; tests updated.

  **Notes on review feedback:**
  - All `DEFAULT_EXCLUDES` paths are anchored with a leading `/` (rsync
    filter syntax for "relative to the transfer root"). Without the anchor
    a pattern like `loras/*.safetensors` would match any `loras/` directory
    anywhere under data/ — including user-managed collections under e.g.
    `brain/.../loras/` — and silently exclude unrelated user data.
  - The LoRA exclude is `/loras/*.safetensors`, not `/loras/`. The
    `.metadata.json` sidecars next to each `.safetensors` file (Civitai
    metadata + user-editable name / recommendedScale / notes) are the
    source of truth for that user data and ARE backed up.
  - The cron handler in `backupScheduler.js` re-reads settings on each
    invocation, so toggling a default exclude in the UI takes effect on the
    next scheduled run without a server restart. The handler also re-checks
    `backup.enabled` and `backup.destPath`, so disabling backups or clearing
    the destination after startup short-circuits the run. (Only the cron
    expression itself is captured at registration.)
  - `runBackup()` guards `excludePaths` and `disabledDefaultExcludes` with
    `Array.isArray` before filtering, so a hand-edited settings.json with
    the wrong shape doesn't abort the backup. Exclude-computation extracted
    into `computeEffectiveExcludes()` (pure, unit-tested).
  - The Backup tab `<isExcluded>` state now accounts for paths also listed
    in Additional Exclude Paths via a `shadowsDefault()` helper that
    catches exact matches AND broader rsync patterns (`loras/`, `loras/**`,
    `/cos/` covering `/cos/reference-repos/`). Toggling a default to
    "included" strips every shadowing custom entry, and `addExclude`
    refuses to add a pattern that would shadow any default. The warning
    chip names the offending custom entry so the user knows which one to
    delete.
  - `backupConfigSchema` is now wired into the settings PUT route (used as
    `.partial()` so an unrelated settings save doesn't require a full
    backup config). The schema's `destPath` was loosened to
    `z.string().nullable().optional()` to match the route's existing
    "empty / missing destPath = not configured" semantics — saving an
    empty input no longer 400s.
  - Client-side `asArray()` normalizer wraps `settings.backup.excludePaths`
    and `disabledDefaultExcludes` (and the `defaultExcludes` returned from
    `/api/backup/status`) before they reach React state — settings.json is
    hand-editable and the GET endpoint is unvalidated, so an incoming
    non-array shape no longer crashes downstream `.some` / `.includes` /
    `.filter` calls in the Backup tab.

## Changed

- **CI test output is now quiet + fail-fast.** New `server/package.json`
  `test:ci` script (`vitest run --bail=1 --silent=passed-only
  --reporter=default --reporter=github-actions`) used by `.github/workflows/ci.yml`.
  Suppresses `console.log/error` output from passing tests (so the 1000s of
  emoji-prefixed logs that previously flooded CI only appear when the owning
  test fails), bails after the first failing test, and emits GitHub Actions
  annotations on failure lines so the PR view links straight to the
  offending assertion. Local `npm test` is unchanged.

- **TUI agents now write a markdown task summary into `.agent-done` and
  PortOS ingests it as the agent's `outputBuffer`.** With per-line PTY
  capture off, the agent card's "Show output" panel only showed
  lifecycle events — no view of what the agent actually accomplished,
  and downstream consumers (`extractFinalSummary`, memory extraction,
  completion hooks) had nothing to work with. The Completion Workflow
  prompt section now instructs the agent to `cat > .agent-done <<EOF
  …` a short markdown report (Summary / Changes / PR sections) instead
  of just `echo "done"`. The spawner's sentinel watcher reads that
  content, line-feeds it through `appendLine` so it lands in both
  `outputBuffer` and `output.txt`, and caps the ingested content at 4 KB
  so a runaway agent that dumps an entire diff doesn't bloat the agent
  record or downstream memory prompts. Headless CLI agents still capture
  their summary the old way (Claude's stdout response trailer); only the
  TUI path needed the explicit sentinel pivot.

- **Claude Code TUI is now the default enabled provider in the base PortOS
  config.** Fresh installs get `activeProvider: "claude-code-tui"` with
  `claude-code-tui.enabled: true` out of the seed JSON. The headless
  `claude-code` CLI provider stays available (and enabled) as a fallback
  for non-interactive flows, but CoS agents launch into the TUI by default
  — the TUI owns its own commit/push/PR sequence via slashdo, handles
  live BTW paste-through, and avoids the headless CLI's stale-prompt edge
  cases. A new migration `008-default-to-claude-code-tui.js` flips
  existing installs IFF they're still on the pre-flip default
  (`activeProvider === "claude-code"` and `claude-code-tui.enabled !==
  true`); users who deliberately picked a different active provider or
  already enabled the TUI on their own are left untouched.

- **BTW ("by the way") messages are now Claude-Code-TUI-only and paste live
  into the running session.** The old flow wrote a `BTW.md` file in the
  workspace and relied on a prompt instruction telling the agent to poll
  for it — brittle, often ignored, and required ephemeral-file cleanup on
  every cleanup path. The new flow detects whether the running agent is a
  Claude Code TUI session (codex / gemini / lm-studio TUIs don't honor
  bracketed-paste the same way) and, if so, pastes the BTW message into
  the live PTY as bracketed paste + delayed Enter. Non-Claude-TUI agents
  (headless CLI, runner-spawned, other TUI kinds) reject the request with
  a clear error instead of silently writing a file the agent will never
  read. The prompt's `BTW Messages` instruction is removed entirely
  because Claude Code natively handles user input mid-session and other
  agents no longer support BTW. The client BTW input box is gated on
  `metadata.executionMode === 'tui' && metadata.tuiKind === 'claude'` so it
  never offers a feature the server can't honor. `BTW.md` cleanup paths
  (`agentLifecycle`, `agentTuiSpawning`, `agentCliSpawning`) and the
  runner-client `sendBtwToAgent` HTTP wrapper are deleted. A new
  `metadata.tuiKind` field on agent state records which TUI binary is
  running (`claude`, `codex`, `gemini`, etc.).

- **TUI agents own the full PR creation and write the body themselves.**
  Reinforced after a TUI agent's PR ended up populated with garbled
  captured-output as the PR body. The Completion Workflow section now
  explicitly states "**You own the entire commit → push → PR sequence —
  PortOS will NOT push or open a PR on your behalf**" and instructs the
  agent to write the PR title/body itself based on actual changes (not
  auto-generated from terminal output). The post-exit `cleanupAgentWorktree`
  path for TUI agents was already passing `openPR: false`,
  `requestCopilotReview: false`, `skipMerge: true`; the review-loop prompt
  section is now also suppressed for TUI so the agent isn't told the
  system will request a Copilot review (it won't — the agent does it
  inline via `gh` after `/do:pr`).

- **`setup.{sh,ps1}` and `update.{sh,ps1}` now auto-install/update slash-do
  via `npx slash-do@latest`.** Previously, `update.sh` and `update.ps1`
  prompted the user interactively to install `slash-do` only when the
  global binary was missing (and `setup` didn't touch it at all), so most
  installs sat on a stale or absent user-global command pool. All four
  scripts now run `npx --yes slash-do@latest` unconditionally to lay down
  the latest slash commands for whichever AI environments are detected
  (`~/.claude/commands/`, etc.). Failures are non-fatal — PortOS continues
  setup/update if the npm registry is down or the package install
  errors. The git submodule at `lib/slashdo` remains the in-repo source
  for inline command loading from CoS agents; the npx call is purely for
  keeping the user-global pool fresh.

- **TUI agents now own the simplify → push → PR sequence and self-signal
  completion.** With Claude Code TUI available as a provider type, the
  system no longer needs to drive `cleanupAgentWorktree`'s push/PR steps
  from outside the agent: the agent's prompt now ends with a Completion
  Workflow section instructing it to run `/simplify` (when enabled),
  `/do:pr` (or `/do:push` when `openPR` is false), write `.agent-done`
  in the workspace as a completion sentinel, and `/quit` to exit. PortOS
  polls for the sentinel every 2 s and finalizes the agent with reason
  `agent-signaled-done` as soon as it appears (the existing idle-timeout
  is kept as a fallback for non-compliant agents). The TUI cleanup path
  forces `openPR: false`, `requestCopilotReview: false`, `skipMerge: true`
  so the worktree cleanup never double-fires push/PR after the agent has
  already done it. CLAUDE.md is also no longer pasted into TUI prompts —
  Claude Code reads it natively at session start, so duplicating it just
  wastes tokens. The agent "Show output" panel for TUI agents drops
  per-line PTY capture entirely (TUI is a screen, not a log — the
  attached Shell tab is the live view) and only records lifecycle
  events. Touches `server/services/agentPromptBuilder.js`,
  `server/services/agentLifecycle.js`,
  `server/services/agentTuiSpawning.js` + tests.

- **Writers Room / Universe Builder / Series detail — collapse UX now matches
  CoS.** The three pages previously left a 32px vertical rail in place when
  their middle sidebar was collapsed. They now mirror the Chief of Staff
  pattern exactly: the grid track collapses to `0px` and a floating
  `PanelLeftOpen` button anchored at `left-0 top-2 z-20` (styled as a tab
  flush with the app nav edge — `rounded-r-md`, `border-l-0`, `bg-port-card/60`)
  stands in for the rail. Added `transition-[grid-template-columns] duration-200`
  on the grid container so the swap animates instead of jumping. Each page
  keeps its own breakpoint convention (`md:` for Writers Room, `lg:` for the
  other two). Files: `client/src/pages/WritersRoom.jsx`,
  `client/src/pages/UniverseBuilder.jsx`,
  `client/src/pages/PipelineSeries.jsx`.

- **Pipeline stage `tvScript` renamed to `teleplay` end-to-end.** Full
  rename of the internal stage id, not just the visible label. Touches
  server schemas (`TEXT_STAGE_IDS`, `STAGE_IDS`), routes
  (`stages/teleplay/generate`, `SOURCE_KIND.TELEPLAY`), the auto-runner
  fan-out, scene extractor source kinds, client services
  (`PIPELINE_TEXT_STAGES`, stage labels, page imports), the
  `TeleplayStage.jsx` component (renamed from `TVScriptStage.jsx`), and
  the prompt file
  (`data.sample/prompts/stages/pipeline-teleplay.md`,
  installed copy renamed too; hash table keys in `setup-data.js`
  updated; `stage-config.json` key renamed). All 32 existing pipeline
  issues had their `stages.tvScript` records renamed to
  `stages.teleplay` in `data/pipeline-issues.json` — single-instance
  app, no migration path needed. Voice agent keeps both spoken aliases
  (`tv script`, `teleplay`) but both now resolve to the `teleplay`
  stage id. Historical references in `DONE.md`, prior changelog
  versions, `data/migrations/003-*.js`, and `data/runs/*/metadata.json`
  left as-is (record of past work, not current state).

- **Series Pipeline index — renamed + cards wrap + shape visible.** The
  `/pipeline` page is now titled **Series Pipeline** (matching the URL's
  intent — the page lists series in a pipeline, not just a generic
  "Pipeline"); sidebar label + nav-manifest label updated in lockstep
  (existing `pipeline` / `series` / `series-pipeline` aliases keep ⌘K and
  voice navigation working). Series rows no longer truncate — name uses
  `flex-wrap` so the shape chip can sit beside it, and the logline wraps
  with `whitespace-pre-wrap break-words` for full-length descriptions. Each
  card with `series.arc.shape` set renders an inline shape badge (40×14
  sparkline + uppercase label) next to the series name.

- **Sidebar nav: "Pipeline" → "Series".** Label change only — URLs,
  files, server routes, and API endpoints all retain the `pipeline`
  namespace because the inner Series record already owns the word
  "Series" and `/series/series/:id` would be ugly. Updates the visible
  sidebar entry (`Layout.jsx`), nav-manifest label (also adds `series`
  as an alias for ⌘K + voice), and the Series-index page H1.


  scripts under `server/scripts/`:
  - `migrateWorldToUniverse.js` — renames `data/world-builder.json` →
    `data/universe-builder.json`, the top-level `worlds[]` → `universes[]`
    key, every `"worldId":` → `"universeId":` in `pipeline-series.json`,
    and every `"worldRun":` → `"universeRun":` in `media-jobs.json`. Safe
    to re-run (idempotent).
  - `migrateAll.js` — chains world→universe naming (above) and then
    series-canon → universe-canon in the correct order. The single
    command other machines need to catch up to the current schema.

  Run with `node server/scripts/migrateAll.js --dry-run` first to preview;
  drop `--dry-run` to apply.

  Also fixed a bug in `migrateSeriesCanon.js` where the migration was a
  no-op because `mergeExtractedBible` mutates its first arg (pushes into
  it) — the post-merge length comparison was always equal. Now clones the
  universe-side array before passing.

- **Universe Canon page — "Appears in" cross-references.** Each canon card
  (characters / places / objects) now shows which linked series + how many
  issues that entry appears in: `Appears in: Clandestiny (15 issues)`. New
  server service `canonUsage.js` aggregates prose-matched usage across
  every linked series's issues (scans prose + idea + scripts via the same
  matchers the comic-page renderer uses). New route
  `GET /api/universe-builder/:id/canon-usage`. Loaded lazily after the
  initial Canon page paint and refreshed after extract operations so new
  entries get usage attribution automatically.

- **Nouns page is universe-only — orphan fallback removed (Phase B.3b).**
  The per-issue Nouns page no longer falls back to series-side canon for
  unlinked series. A series with no `universeId` now renders a clear gate
  banner ("Link this series to a universe") in place of the noun cards;
  every active series in this install has a universe link, so the
  dual-path branching was just complexity tax. Drops the unused legacy
  imports (`extractPipelineBibles`, `updatePipelineSeries`,
  `refinePipelineCharacter`), the `onSeriesUpdate` prop, and the
  `canonStore` / `canonRecord` ternaries. The server-side legacy services
  still redirect to universe-side (Phase B.3a) for any caller that
  bypasses the UI.

- **Legacy series-side canon helpers redirect to universe (Phase B.3a).**
  `extractAndMergeIntoSeries` and `refineCharacterDescription` now early-
  return into their universe-side equivalents when `series.universeId` is
  set. Every legacy caller (the season:episodes:generate auto-extract,
  textStages auto-extract, the `/series/:id/extract-bible` route, the
  `/series/:id/characters/:entryId/refine` route) automatically writes to
  the universe without a fork. The redirect uses dynamic `import('../universeCanon.js')`
  to avoid a module-init cycle.

  Net effect: linked series's auto-flows now populate universe canon
  exactly like the manual paths on the Nouns + Universe Canon pages.
  Orphan series (no universeId) still take the legacy series-side merge.

- **Per-issue Nouns page reads + writes universe canon (Phase B.2).** When
  the series is linked to a universe, the Nouns page now points all canon
  reads (preview thumbnails, "in this issue" filtering) and all mutations
  (extract from prose, AI: differentiate per character, render reference
  → imageRefs persistence) at the universe rather than the per-series
  bible arrays. Adds + edits propagate to every series sharing that
  universe. For orphan series with no `universeId`, the legacy series-side
  flow continues to work unchanged so the page never breaks.
  Header copy + page comments reflect the new flow.

- **Pipeline render paths read canon from the linked universe (Phase B).**
  Comic-page, panel, storyboard, and arc-planner LLM contexts now resolve
  characters/places/objects via `getSeriesCanon(series)` — preferring the
  series's linked universe canon and falling back to the series's own arrays
  only when the universe isn't migrated yet. Switching the source of truth
  to the universe is the prerequisite for crossover series sharing a cast.

  Migration utility: `node server/services/pipeline/migrateSeriesCanon.js`
  (optional `--dry-run`) copies each series's
  `series.{characters,settings,objects}[]` into its linked universe via
  `mergeExtractedBible` (dedup by name). Idempotent. Auto-creates a
  universe for orphan series. Does NOT clear the series arrays — they stay
  as a pre-migration fallback until Phase B.2 drops the schema fields.

  Fallback is **all-or-nothing per series**: if a series has any kind
  populated locally that the universe hasn't received yet, we read the
  whole series-side canon (rather than mixing universe characters with
  series settings and producing silent hybrid stale data).

  Phase B.2 (next): point the per-issue Nouns page directly at universe
  canon, remove series-side bible arrays from the schema, drop the
  legacy `extractAndMergeIntoSeries` + `refineCharacterDescription`
  functions.

- **BREAKING — World Builder is now Universe Builder.** A universe can contain
  many worlds, and stories within the same universe can share canon (characters,
  places, things) across multiple series — Marvel-style crossovers. This is a
  pure rename pass; behavior is unchanged. Files (`worldBuilder*.js` →
  `universeBuilder*.js`, `WorldBuilder.jsx` → `UniverseBuilder.jsx`), routes
  (`/api/world-builder/*` → `/api/universe-builder/*`), client routes
  (`/world-builder` → `/universe-builder`), fields (`series.worldId` →
  `series.universeId`), top-level data key (`worlds: []` → `universes: []` in
  `data/universe-builder.json`), function names (`getWorld` → `getUniverse`,
  etc.), constants (`WORLD_ID_MAX` → `UNIVERSE_ID_MAX`), and the
  `params.worldRun` mediaJobQueue tag (148 existing job records migrated).
  Back-compat: the `⌘K` palette + voice agent keep `'world'`/`'world-builder'`
  as aliases for the renamed nav entry, so muscle memory still resolves.
  Sets up the next phase: lift canon entities (characters/places/objects)
  from per-series bibles to the universe so multiple series can share them.

- **Pipeline character — "AI: differentiate" button.** Per-character refine on
  the Nouns page (Universe Builder side coming). Sends the target plus every
  peer's `physicalDescription` to a new `pipeline-character-refine` prompt
  and rewrites only the target's `physicalDescription` so no two characters
  collide on ethnicity, age, hair, silhouette, or signature wardrobe.
  Preserves evidence + firstAppearance.

- **Character extraction prompt — opinionated commits, not gaps.**
  `writers-room-characters.md` now requires every renderable axis (ethnicity,
  age decade, build, hair color/length/texture/style, eye color, distinguishing
  facial features, signature wardrobe with palette + era, posture). When prose
  is silent, the LLM is told to COMMIT to a specific choice that differentiates
  the character from the rest of the cast and log the committed axes in
  `missingFromProse[]`. The old "do not invent" rule was producing
  visually-interchangeable characters when prose was sparse on visual specifics.

- **Sidebar Pipeline submenu — all series, not 10 recent issues.** The
  Create → Pipeline grandchildren now list every series alphabetically
  (links to `/pipeline/series/:id`) instead of the 10 most recently updated
  issues. Series-level entries stay coherent across many series — individual
  issues live under their series page. Sort happens in the fetch effect so
  the memoized nav tree doesn't re-sort when unrelated `sidebarApps` state
  changes.

- **Comic-page image prompts — balloon lettering rule.** `composeComicPagePrompt`
  in `server/services/pipeline/visualStages.js` now formats each dialogue
  line as `Speech balloon reads: "<text>" (spoken by NAME[, balloon style: <hint>])`
  and translates `(EARPIECE)` / `(WHISPERED)` / `(THOUGHT)` parentheticals
  into visual styling hints. The page-layout clause explicitly tells the
  diffusion model to letter ONLY the quoted text — speaker names and
  parentheticals were previously being lettered verbatim inside balloons.

- **Prose stage — present tense, non-negotiable.** `data.sample/prompts/stages/pipeline-prose.md`
  now demands present tense throughout so the upstream draft matches the
  downstream comic and TV-script adaptations, keeping visual beats
  translatable across formats.

- **Comic-script stage — target a standard 22-page issue.** The comic-script
  prompt now anchors on the industry-standard 22-page count (100–140 panels)
  and tells the LLM to expand action across more panels when the prose draft
  is short rather than cutting page count.

- **Pipeline nav — shorter tab labels.** *Comic Pages* → *Comic*,
  *Episode Video* → *Video*. The full names were redundant inside the
  Pipeline page where every tab is obviously a pipeline stage.

- **Pipeline Series — Regenerate arc button no longer requires two clicks.**
  Dropped the `useArmedAction` two-click-arm pattern from the regenerate
  button; one click runs. The pattern was confusing — users didn't realize
  "Click again to replace" was an instruction rather than a status. The
  delete-season and delete-issue buttons keep the arm pattern since they're
  hover-revealed trash icons where misclick risk is real.

- **Pipeline Series — combined comic/TV terminology.** Every series now ships
  in both formats by default — graphic novel (issues → volumes) AND TV
  (episodes → seasons). Dropped the *Target format* picker from the new-
  series form and the bible sidebar; all labels read as `issues / episodes`
  and `volumes / seasons` so a single record drives both pipelines. The
  arc-overview / verify / resolve prompts were rewritten to author for both
  formats simultaneously.

- **Pipeline Series — flush-edge layout.** The series detail page now uses
  the same edge-to-edge canvas as World Builder. The bible sidebar sits flush
  against the main app sidebar (no Layout padding between them) and the
  collapse rail is a plain hairline toggle instead of a floating rounded
  button.

- **World Builder — inline Refine prompts.** Clicking *Refine prompts* now
  expands a feedback textarea right under the header buttons instead of
  opening a modal. The LLM picked in the page's own provider/model selectors
  is used directly (no second selector), and the refined output is applied
  straight to the prompt fields below so you can see the changes in place. A
  short rationale + change list appears below the textarea after each refine.

- **World Builder — explicit-removal handling in Refine.** When the user
  feedback names a specific variation or composite to remove, the LLM is now
  told to omit it entirely (including composite sheets whose primary subject
  is the removed entity, e.g. a "Faction A vs Faction B branding sheet") and
  to scrub stray references from sibling unlocked composites' prompts.

## Fixed

- **Flaky death-clock test passes again.** `computeDeathClock` healthy-years
  test in `server/services/meatspace.test.js` derived its expected value from
  `result.yearsRemaining` (rounded to 2dp by the service) but compared
  against `result.healthyYearsRemaining` (derived from the full-precision
  value). On some calendar dates the two rounding paths differed by 0.1 and
  the assertion failed in CI. Now uses `toBeCloseTo(..., 0)` so the test
  asserts the 85% ratio with tolerance instead of re-deriving from a
  pre-rounded number.

- **Theme contrast: white text on light-green success backgrounds now uses
  dark text.** `--port-on-success` defaulted to white (255 255 255), which
  fails WCAG AA against bright/medium-bright greens (white on #22c55e ≈ 2.0,
  on #16a34a ≈ 3.3). The base token now routes to dark forest green
  (5 46 22) — fixes Classic Midnight, Classic Noon, and Lumen Glass Day,
  where the `bg-port-success text-white` mapping in `index.css` (lines
  336-338) now produces readable contrast (≥ 4.6). Darker-green day themes
  (Phosphor Paper #167a3c, Drafting Paper #15803d) keep white text since
  their greens are dark enough that white passes AA (~5.0+) and dark text
  would fail. Added a defensive CSS rule that routes hardcoded Tailwind
  `bg-green-{400,500,600}` / `bg-emerald-{400,500,600}` / `bg-lime-{400,500}`
  + `text-white` combos through the same `--port-on-success` token, so
  components that bypass the theme color (DataDog/Jira/SoulWizard buttons,
  etc.) inherit the fix automatically. Touches `client/src/themes/portosThemes.js`,
  `client/src/index.css`.

- **TUI agent prompt now actually lands in Claude Code's input.** The fixed
  2500 ms paste delay raced Claude Code's banner/loading render, so bracketed
  paste arrived before the input field was ready and the entire prompt was
  discarded — the agent then sat at an empty `>` prompt forever. The paste
  is now gated on output-idle (TUI has stopped repainting for 1.2 s) with a
  minimum boot delay floor and a 10 s deadline fallback, and the `\r`
  submission is split out from the paste write by 400 ms so Claude Code can
  commit the paste buffer before Enter fires. The deferred Enter is tracked
  and cancelled in `finish()` if the agent ends inside the 400 ms window.
  Also cleaned up the agent "Show output" panel: a streaming ANSI stripper
  buffers unterminated CSI/OSC sequences across PTY chunks (was leaking
  `0;Claude Code…` title-set fragments as visible text), and an `isTuiNoise`
  filter drops the welcome banner, status footer, box-drawing lines, and
  letter-spaced animation frames so what's left is closer to actual agent
  output. The raw PTY stream is unaffected and still flows to the attached
  shell session for live inspection. Touches `server/services/agentTuiSpawning.js`
  + `agentTuiSpawning.test.js`.

- **`index.html` now revalidates on every navigation, so rebuilds are picked
  up without a hard refresh.** The SPA fallback in `server/index.js` was
  serving `index.html` with no `Cache-Control` header, so browsers fell back
  to default heuristics and happily cached the file — which embeds the
  current build's hashed asset filenames. After a rebuild + restart, the
  stale HTML pointed at chunks that no longer existed on disk
  (`index-CwBEDqDF.css: 404` class of error). The fallback now sets
  `Cache-Control: no-cache` on the HTML response, forcing an etag
  revalidation on every request; hashed assets continue to cache normally
  because their filenames change on every build.

- **Scheduled tasks no longer block forever on disabled dependencies.** `checkRunAfterDeps`
  in `server/services/taskSchedule.js` previously required every `runAfter`
  dependency to have run since the dependent task's last execution — but if a
  dep was disabled (e.g. `do-replan` globally paused while `feature-ideas` is
  enabled), it would never run, and the dependent task would wait indefinitely
  with `reason: 'waiting-on-dependencies'`. The dep gate now skips dependencies
  that are disabled globally (`enabled: false` or missing from the schedule)
  or disabled for the requesting app (`isTaskTypeEnabledForApp` returns false),
  matching the rule that the actual scheduler uses to decide whether a task
  will ever run. Tests cover the global-disabled and per-app-disabled paths;
  the existing "blocks when dep is enabled but hasn't run" coverage is
  preserved with an explicit `do-replan: enabled: true` in the fixture.

- **Browser download-UI shell handoffs dead on macOS (Show in Finder / Open file silently no-op).**
  `browser/server.js` spawned Chrome as a direct child of `node`/PM2, which
  made PM2 the TCC "responsible app" for Chrome's AppleEvent +
  LaunchServices calls on macOS Sequoia. PM2 hasn't been granted Automation
  or Files-and-Folders access, so every shell handoff from Chrome's download
  UI ("Show in Finder", "Open file", chrome://downloads row click) silently
  no-op'd. Downloads themselves landed correctly because Chrome's own
  sandboxed writes don't go through TCC. Fix: on macOS headed mode, launch
  via `/usr/bin/open -na "Google Chrome.app" --args …` so launchd is the
  responsible launcher and Chrome runs with its own TCC identity (Chrome's
  parent PID is now `launchd` instead of `node`). Headless mode keeps the
  direct `spawn` (no UI to click), and Linux/Windows are unaffected (no TCC).
  Trade-off: `open` returns immediately, so we lose the direct PID handle;
  shutdown now sends CDP `Browser.close` (with a 2s safety timeout + WS
  fallback) instead of SIGTERM on macOS headed mode. **Files:**
  `browser/server.js` — `MAC_CHROME_APP` constant, platform-split launch
  branch in `launchBrowser`, new `closeBrowserViaCdp` helper, `shutdown`
  promoted to async.

- **Stale-build cache — buildId now invalidates when `client/dist/index.html` changes.**
  The boot-time cache in `server/lib/buildId.js` was load-once: once captured,
  the server kept serving the *original* stamped index.html — referencing the
  *original* Vite chunk filenames — even after a subsequent `npm run build`
  rewrote `client/dist/` with new chunk hashes. The old chunk files were gone
  from disk, so the browser got 404s on every code-split chunk and rendered
  a black page; the only workaround was restarting the server. Same caching
  affected `getBuildId()`, so the socket's `build:id` emit reported the *old*
  build id and the stale-build toast never fired. Fix: cache keyed on the
  file's mtime, recomputed on read when the mtime advances. The SPA-fallback
  handler in `server/index.js` was also pulling the stamped HTML once at boot
  outside the route handler; moved inside the handler so it picks up rebuilds
  per request. **Files:** `server/lib/buildId.js`, `server/index.js`. New
  `server/lib/buildId.test.js` covers the rebuild path, the no-change cache
  hit, and the missing-file dev fallback.

- **Arc header — "Generate arc" stays accurate when only a shape is picked.**
  After the sanitizer started preserving shape-only arcs, any series created
  with a Vonnegut shape but no other arc content immediately showed
  *Regenerate arc* and the *Verify arc* button — even though the LLM hadn't
  written any logline/summary/themes yet. New `hasGeneratedArc` check gates
  on actual text content (`logline || summary || protagonistArc ||
  themes.length`), so the button reads *Generate arc* and Verify stays
  hidden until the LLM has actually produced an arc to regenerate or verify.

- **Storyboards scene extraction now uses the per-series configured LLM.**
  Clicking "From Teleplay" / "From Prose" on the Storyboards stage was
  calling Claude Code (the system default) regardless of the
  provider/model set in the issue header — leading to surprise
  5-minute timeouts when the user had Codex configured. Fix has three
  parts: the `extract-scenes` route now accepts `modelOverride` and
  falls back to `series.llm.provider` / `series.llm.model` when no
  override is passed; `extractScenes` in `lib/sceneExtractor.js`
  threads `modelOverride` through to `runStagedLLM`; the
  `StoryboardsStage` component reads `series.llm.{provider,model}`
  and passes both explicitly (defense in depth so even older client
  builds against the new server still pick up the right provider).
  Text-stage generates + auto-run already honored this; visual-refine
  endpoints (`refine-prompt`) are intentionally exempt because they
  use the per-issue `genConfig.refineProvider` setting.

- **`updateStageWithLatest` short-circuits on empty-patch returns.** A
  computeFn returning `{}` (the "I decided not to write" signal — e.g.
  a stale media-job completion landing against a re-rendered page) no
  longer writes the issue file or fires `emitRecordUpdated('series',
  ...)`. Previously every such no-op merged `updatedAt` and triggered
  the share-bucket subscription's debounced re-export of the entire
  series — multiplied by every duplicate image-gen `completed` event
  that arrived for an old jobId after the user re-ran a render. Fix
  benefits every other caller that adopts the empty-patch convention.

- **`severity: 'warning'` server errors stop surfacing as console errors.**
  Routes can flag expected high-volume 404s (e.g. speculative
  `GET /api/media-jobs/:id` lookups for jobs past the queue's 24h
  archive TTL) with `severity: 'warning'` — the original intent per
  `mediaJobs.js`'s comment. Now honored on both ends: client
  `useErrorNotifications.handleError` returns early for warnings
  (no toast, no `console.error`), and the server `asyncHandler`'s
  log branch suppresses the `❌ Route error: ...` line for the same.
  The network-tab 404 is the only remaining signal.


  Running `npm run migrations` now auto-updates the five pipeline stage prompt
  templates (`pipeline-idea-expansion.md`, `pipeline-prose.md`,
  `pipeline-comic-script.md`, `pipeline-tv-script.md`,
  `pipeline-season-episodes.md`) on machines that were set up before the
  length-profile feature landed. Migration `003` compares each file's MD5 to
  the pre-feature shipped hash: unmodified files are overwritten with the new
  template; customized files are skipped with a diff hint. `setup-data.js` also
  emits a one-line warning at install time when any stage prompt has drifted,
  pointing at the migration command.

- **CoS-spawned PRs — concise title + no double "Summary" heading.** Two
  related bugs in the PR-creation path:
  - The PR title was the raw user task description (e.g. "on the
    settings/backup page, we should have a button to run the backup. Also,
    we should show default…"), truncated at 100 chars. New helper
    `git.suggestPRTitle()` picks the oldest commit subject on the branch as
    the title (the agent already wrote a conventional `feat:`/`fix:` commit
    message that summarizes the change far better than the prompt), falling
    back to the description's first line when no commits are found. Used in
    both the worktree-PR path and the JIRA-ticket PR path (where the
    `${jiraTicketId}: ` prefix is preserved).
  - The PR body rendered "Summary" twice — `generatePRDescription` wraps the
    extracted agent summary in `## Summary`, but agents often write their own
    `## Summary` heading at the top of their final message. `extractAgentSummary`
    now strips a leading `Summary` / `## Summary` / `Summary:` heading before
    returning, so the wrapping section is the only one in the rendered PR.
  - Tests: 2 new `extractAgentSummary` cases for the heading-strip behavior;
    `cleanupAgentWorktree.test.js` mock updated to stub `suggestPRTitle`.
    Full server suite (4,549 tests) green.

- **CoS orphan handler — no more duplicate `[Auto-Fix]` investigation tasks.**
  When `cleanupOrphanedAgents` swept up two stale "running" agents that shared a
  taskId, `handleOrphanedTask` ran once per agent. The first call blocked the
  task with `blockedCategory='max-retries'` and spawned an investigation task;
  the second call fell through the existing guard (which only short-circuits on
  `'user-terminated'`), incremented `orphanRetryCount` past its ceiling, and
  spawned a SECOND investigation task with the same `[Auto-Fix] Investigate
  repeated agent orphaning for task <id>` headline (the `addTask` dedup at
  `cos.js:2194` missed it because the description body embeds the per-agent
  `retryCount`/`agentId`). The handler now also early-returns when the task is
  already blocked with `'max-retries'` or `'orphan-cooldown'`. Adds
  `agentManagement.test.js` covering all four short-circuit branches.

- **Media Jobs Queue — empty prompt tooltip.** Job rows without a prompt
  no longer render an empty `title=""` tooltip. Rows with a prompt now
  show the full prompt on hover (the visible cell is still truncated to
  80 chars).

- **CoS agent summary — historical Codex agents now auto-repair on read.**
  The previous fix (above) corrected the extractor for *new* Codex agents, but
  agents that completed before the patch landed already had their
  multi-megabyte transcript dumps persisted into `metadata.json` (e.g.
  agent-5f6951e3: 5.2MB metadata, 737KB `taskSummary`, 4.4MB `simplifySummary`).
  Adds `server/services/codexSummaryRepair.js`: when `getAgent` or
  `getAgentsByDate` loads a completed agent whose `taskSummary` or
  `simplifySummary` is ≥20KB, it re-reads `output.txt`, re-extracts the
  assistant tail via `extractCodexAssistantTail`, clears the false
  `simplifySummary` (Codex CLI cannot execute `/simplify`), and rewrites
  metadata.json in place. One-time per agent, idempotent thereafter.

- **CoS agent summary — Codex output now extracts the actual final message.**
  When a CoS task ran on the Codex provider, the persisted `taskSummary`
  ballooned to multi-megabyte dumps containing every diff, grep result, and
  `apply_patch` payload Codex streamed during the run. `extractFinalSummary`'s
  tool-marker heuristic (`🔧`, `→`, `↳`) does not match any of Codex's section
  markers (`exec` / `apply patch` / `codex` / `tokens used`), so the
  backwards walk swept through the whole transcript. The simplify-summary
  splitter also false-positived on diff lines that quoted source code
  containing `/simplify` and a `run` verb. Adds an `extractCodexAssistantTail`
  helper next to `extractCodexAssistant` that carves out just the message
  following the last `tokens used\n<count>` (or inline `tokens used: <n>`)
  footer; both `extractFinalSummary` and `extractSimplifySummaries` short-
  circuit on Codex output so the agent card shows the real summary instead of
  a transcript dump.

- **Codex image gen — "Codex returned no session id" false negative.** With
  long pipeline prompts (multi-KB comic-script payloads), codex emits the
  banner + echoed prompt in a single stderr chunk that exceeds the
  banner-scan buffer. The old `captureSession()` sliced the buffer's tail
  before running the regex, chopping the `session id:` line off the front
  and failing every render. Now matches before slicing, and stops feeding
  stdout into the banner buffer so an interleaved stdout chunk can't split
  the session-id line either. Adds regression tests for both paths.

## Removed

- **Dead `listRecentPipelineIssues` client API.** Sidebar no longer fetches
  recent issues, so the corresponding `apiPipeline.js` wrapper is removed.
  The server route + tests stay for now in case future surfaces want it.
