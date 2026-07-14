# client/src/hooks/ — shared React hooks

State + lifecycle + side-effect hooks. **Before writing a `useX` hook, grep this catalog
first** — many domain patterns already have one. When you add a new hook, add it to
`index.js` AND add a row here.

Pure helpers (no React state) live in `client/src/lib/`. HTTP/socket clients live in
`client/src/services/`. Formatting helpers live in `client/src/utils/`.

## Discovery rule

```
grep -i "what you want to do" client/src/hooks/README.md
```

---

## Notifications & toasts

| Hook | Purpose | Use when |
|---|---|---|
| `useNotifications` | Generic toast dispatch + socket-subscribed notification list. | You need to read / dispatch the global notification stream. |
| `useErrorNotifications` | Subscribes to server error events and shows toasts. | Wire once high in the tree to surface server errors. |
| `useAIStatusNotifications` | Subscribes to AI operation status events. | Wire once to surface AI run lifecycle as toasts. |
| `useAgentFeedbackToast` | Agent completion toast with thumbs-up/down UI. | Show actionable agent-run completion feedback. |
| `useOnDemandTaskToast` | Toasts when a user-triggered on-demand task run found no work (parked). | Wire once high in the tree so an explicit "Run" that parks isn't a silent no-op. |
| `useSharingNotifications` | Subscriber for share-bucket notifications. | Wire once to surface federation/sync events. |

## Pipeline / Story Builder wiring

| Hook | Purpose | Use when |
|---|---|---|
| `useArcCanvasSync` | Host-side wiring for the embedded `<ArcCanvas>`: `lastSavedRef` dirty-check + `updateSeriesFromServer` / `handleIssuesUpdate` / `flushPending`. Parameterized by `flushFields` (which bible fields to flush) + `silent`/`onFlushError`. | Embedding `<ArcCanvas>` in a host that owns `series`/`issues` state (PipelineSeries, Story Builder arc step). Don't re-implement the setter contract. |

## Progress & streaming (SSE / socket)

| Hook | Purpose | Use when |
|---|---|---|
| `useSseProgress` | Generic JSON-frame EventSource subscriber. | New SSE progress stream — start here, build on top. |
| `useSseJobSlot` | Generic single-slot SSE job: `pending`/`job` state, terminal-frame handling (`complete`/`error`/`canceled`), and `sse.closed`-without-terminal-frame recovery in one place. Returns `{ active, percent, stage, context, start, cancel }`; pass `startRequest`/`eventsUrl`/`cancelRequest` + per-feature toast copy. | Any "kick off a job → stream SSE → settle on terminal frame" hook. The reference-audio/YouTube/video-download/MIDI hooks all wrap this — don't re-roll the terminal-frame + lost-connection dance. |
| `useInstallStream` | BYO-runtime install-log EventSource lifecycle: `stage`/`log`/`complete`/`error` frame dispatch, capped + optionally-debounced log accumulation, "connection lost" handling, ref-stashed `onComplete`, auto-scroll. | A streamed install/setup modal that shows live SSE log lines (FLUX.2, video runtimes). Don't re-roll the EventSource teardown/onComplete-ref dance. |
| `useModelDownloadStatus` | Image/video model cache-status + SSE pre-download. | Surfacing "Available" vs "Download" badge inline in the gen form. |
| `useImageGenProgress` | Live diffusion progress for an image-gen call. | Showing per-call image-gen progress. |
| `useImporterProgress` | Live analyze-phase stage checklist via the `importer:progress` socket (runId-filtered); exports `stageStatusIcon` for the status→icon lookup. | Importer analyze progress UI only. |
| `useMediaJobProgress` | Live progress for a single `mediaJobQueue` job. | Subscribing to a known media-job id. |
| `useSceneRenderLifecycle` | One Music Video board lane's async-render lifecycle: owns the per-scene spinner state (`genScenes`), job-id→scene correlation, orphan-terminal reconcile, and the durable-attach + `*-gen:completed/failed/canceled` socket subscription (with running-cancel toast disambiguation). Returns `{ genScenes, startScene, clearScene, trackJob }`. | A board lane that kicks media-job renders per scene and clears spinners from terminal events (reference frame, i2v clip). One call per lane. |
| `useSlotInFlight` | Whether a render slot (`{ jobId, filename }`) has an in-flight render; returns `{ inFlight, setStatus }`. A present `filename` (or 5s grace on a stale/expired job) clears `inFlight` so the render button never sticks "loading". | A render button that should disable + spin only while its own slot is actually rendering (comic pages, covers). Wire `setStatus` to the slot's `MediaJobThumb` `onStatus`. |
| `useMediaJobSse` | Imperative per-job `/{kind}-gen/:id/events` SSE; `attach()` returns a Promise that settles on the terminal frame. | POST-then-attach media render flows that await completion (ImageGen/VideoGen). |
| `useOpenClawStream` | OpenClaw SSE chat stream. | OpenClaw file-browser chat surface only. |
| `usePipelineProgress` | Id-derived runner SSE stream: builds the URL from `(urlBuilder, ids)`, connects only when every id is truthy. | Any runner SSE keyed by record ids (pipeline auto-run, editorial, manuscript completeness, volume beats, story steps). |
| `useSeriesEditorial` | Editorial-roadmap aggregate + batch lifecycle (load, re-attach, SSE, start/cancel, reload). | Any view of the editorial roadmap (panel or Reader Map page). |
| `useReaderPanel` | Reader-panel snapshot (four personas + mined disagreements) + convene lifecycle (load, re-attach, per-persona SSE, run/cancel, reload). | The Reader Map page's Reader Panel tab (#2170). |

## Media (annotations, completion, attachments)

| Hook | Purpose | Use when |
|---|---|---|
| `useMediaAnnotations` | Per-entry `own`/`others` annotations with back-compat aliases. | Showing media annotations + ownership. |
| `useMediaCompletionRefresh` | Refetch on image/video completion socket events. | A list view that needs to refresh when new media lands. |
| `useOpenClawAttachments` | File attachment handling (base64, size-capped). | OpenClaw attachment UI. |
| `useMediaPreviewActions` | Shared MediaPreview / MediaLightbox action handlers (images + videos — dispatch by `item.kind`). | New surface that exposes the same 4 preview actions. |
| `usePreviewRoute` | URL-driven `[preview, setPreview]` via `?preview=<filename>`. | Any page hosting `<MediaPreview>` — gives the preview a deep-link. |
| `useImageGenQueue` | Work-scoped live queue of in-flight image renders. | Pages that show per-work image-gen queue state. |
| `useImageRenderSettings` | Load the pipeline image-gen config once (`getSettings → readPipelineImageSettings`), failing open to `PIPELINE_IMAGE_DEFAULTS`; returns `{ imageCfg }`. | A single-image render slot that needs the render config and doesn't already load the full settings blob. |
| `useSingleImageRender` | Queue-one-render / wait-for-completion jobId lifecycle: builds opts from `imageCfg`, calls `buildPrompt`, POSTs `generateImage`, tracks the `jobId` head, and runs a once-per-`(key, filename)` completion guard before `onComplete`. | Single-image render slots driven by `EntryThumbSlot`/`MediaJobThumb` (style probe, characters step). Completion SSE stays in the thumb. |

## Sockets & lifecycle

| Hook | Purpose | Use when |
|---|---|---|
| `useSocket` | Shared socket instance + connection status. | You need to subscribe to a socket event. |
| `useUpdateChecker` | Detect stale client bundle; show reload toast. | Wire once at app root. |
| `useMounted` | `mountedRef` whose `.current` is true while mounted. | Async deferred work that must abort on unmount. |
| `usePrevious` | Returns the value from the previous render — snapshot updated in a `useEffect`. | Compare-and-act on prop/state change from inside a `useEffect`. |
| `usePreviousSync` | Same shape, but snapshot updated *during* render. | The prior value gates an in-render `setState` (React's "adjusting state on prop change" pattern); the during-render update avoids an extra discard/rerun cycle. |
| `useTimeTick` | Singleton-backed wall-clock tick (`Date.now()`); N subscribers at the same cadence share one `setInterval`. | A widget renders something derived from `Date.now()` (relative timestamps, threshold-based health labels, countdowns) and is also fed by a deduped `useAutoRefetch` — without this the label goes stale until the data changes. |
| `useVisibilityEvent` | Singleton-backed `document.visibilitychange` subscription (N subscribers share one listener). | Reacting to tab show/hide without spawning a per-component listener. `useAutoRefetch` already builds on this. |

## UI / interaction

| Hook | Purpose | Use when |
|---|---|---|
| `useAnchorReveal` | `useAnchorReveal(getTarget, key, { reveal? })` — scroll a freshly-opened element into view + flash a tint over it; re-fires when `key` changes; no-op when `key` is falsy or `getTarget()` is null. | Reveal an editorial finding's anchored manuscript text on open / prev-next step (#1601). |
| `useArmedAction` | Two-click-arm `[armed, fire]` confirmation. | Destructive button needing a confirm tap. (Project memory: user finds this less discoverable — prefer inline confirm rows for new UI.) |
| `useAutoRefetch` | Poll-based refetch on an interval. `{ pollOnly: true }` skips internal data/loading state for side-effect-only callers (returns `{ refetch }` only). | Data needs periodic refresh (no socket / SSE available). |
| `useAutoSizeTextarea` | `[ref, resize]` — grows a `<textarea>` to fit its content (no scroll / hand-resize); recomputes before paint on value change. | A textarea that should auto-fit content. Prefer the `AutoSizeTextarea` UI component, which wraps this. |
| `useChartColors` | Resolves the `--port-*` theme tokens (accent/success/warning/error, `chart-1..4`, grid, axis, tooltip surfaces) to concrete `rgb()` strings via `getComputedStyle`, re-resolving on theme switch. | A recharts card needs theme-following colors — SVG `fill`/`stroke` props can't read CSS vars, so pass these resolved strings instead of hardcoded hex. |
| `useClickOutside` | Fire `onOutside` on mousedown outside a ref. | Popovers, menus, drawers. |
| `useConfirmDelete` | Single-at-a-time `{ confirmingId, isConfirming, requestDelete, cancelDelete, confirmDelete }` for arming one list/card row at a time. | New destructive list action — pair with `<InlineConfirmRow>` / `<ConfirmButtonPair>` instead of deleting on the raw trash click. |
| `useEscapeKey` | `useEscapeKey(active, handler)` — call `handler` on Escape while `active`. | Non-modal dismissables (in-context popovers/cards); Modal owns Esc for true modals. |
| `useFocusTrap` | `useFocusTrap(active, containerRef, { initialFocusRef? })` — moves focus into the container on open, traps Tab/Shift+Tab so it can't escape to the page behind, and restores focus to the opener on close (WCAG 2.4.3 / 2.1.2). | Modal surfaces (dialogs, drawers, lightboxes). Already wired into `Modal` and `Drawer` — reach for it when hand-rolling a new overlay. |
| `useCmdKSearch` | `⌘K` open/close state. | Anywhere that needs to toggle the palette. |
| `useContainerWidth` | `[ref, width]` via ResizeObserver. | Layout responds to a specific container's width. |
| `useCooldownTick` | 1-second ticker over a `{ id: epochMs }` cooldown map; fires `onAllExpired` once when every deadline passes. | Rate-limit countdown labels that need to refetch when the last cooldown clears (agents tabs pattern). |
| `useDrawerTab` | Deep-linkable `[activeTab, setActiveTab]` for a tabbed `<Drawer>`, backed by a caller-named URL search param (falls back to a default on stale/missing). | A tabbed config drawer whose open section should be shareable/bookmarkable — use with `<Drawer tabs>`; don't re-roll the search-param plumbing. |
| `useFieldDraft` | Local input draft that commits on blur. | Bible-editor-style single-field input that must dedupe sibling races. |
| `useRowDraft` | Multi-column row draft (analogue of `useFieldDraft`). | Multi-column row that commits as a unit. |
| `usePendingListRows` | List-of-rows where a new row is held client-side until a required column fills, then promoted to `onChange`. | Editable list whose nameless rows would otherwise be dropped by the server sanitizer (WardrobeSection, CharacterDetailEditor list sections). |
| `useKeyboardControls` | Keyboard binding for CyberCity mode toggle. | CyberCity-specific. |
| `useKeyboardShortcuts` | `useKeyboardShortcuts(active, bindings, opts?)` — fire a `{ key: handler }` map while `active`; ignores events from editable fields (`isEditableTarget` also exported), ⌘/Ctrl/Alt chords, OS key auto-repeat (`{ ignoreRepeat: false }` to opt back in), and any keystroke while an `aria-modal` dialog is open (`{ enabledInDialog: true }` for a modal-owned shortcut); a falsy handler disables that key. | Single-surface action shortcuts (editorial comment card prev/next + accept/dismiss/generate, #1603). Not for held-key/game input (that's `useKeyboardControls`). |
| `useKeyboardHelp` | Esc closes, even from inputs/textareas. | Help/cheatsheet modals. |
| `useLockToggle` | Optimistic-PATCH lock toggle. | New "lock this field/stage/arc" button — use this, do not re-implement. |
| `usePopoverPosition` | Viewport-clamped `{ left, top, width }` for a fixed-position portal popover anchored to a trigger; re-measures on open and rAF-coalesced on capture-phase scroll/resize. Returns `{ triggerRef, popoverRef, style, reposition }`; pass `anchorRef` to follow a parent-owned trigger. | Any portal-into-`<body>` menu/popover placed relative to a button (ThemeSwitcher, CollectionPickerShell) — use this instead of re-rolling the measure/flip/clamp/reflow plumbing. |
| `useScrollLock` | Body-scroll lock with ref-count. | Modals, drawers, lightboxes. |
| `useSwipeNav` | Horizontal swipe prev/next. | Mobile swipe between siblings. |
| `useValidTab` | Resolve the active tab from the `:tab` URL param against a TABS list, falling back to a default on invalid/missing. | Any tabbed page whose tab lives in the URL — don't re-roll the `new Set(TABS.map(...))` guard. |
| `useAsyncAction` | `running` state + toast-on-error. | Buttons that await an async action. |

## Storage & persistence

| Hook | Purpose | Use when |
|---|---|---|
| `useLocalStorageBool` | Boolean `useState` mirrored to `localStorage`. | Per-user UI preference toggle. |
| `useNavWorkingSet` | Sidebar Pinned + Recent working set (localStorage MRU + pins); resolves stored paths to `{ path, label, icon }` rows via a `resolveNavEntry` arg. | Rendering the sidebar's Pinned/Recent sections. |

## Sidebar navigation data

| Hook | Purpose | Use when |
|---|---|---|
| `useFocusRefreshedList` | Load-once-then-refresh-on-focus list fetcher: debounces focus refreshes to 30s, sorts by name, and skips re-render when an `id\|name` signature is unchanged. Owns its own warn-on-error. | Any sidebar/nav list that should refresh when the user returns to the tab without hammering the API. Pass a stable `api.*` fetch fn. |
| `useSidebarApps` | Apps list for sidebar nav: socket-driven (`apps:changed`), archived filtered out, name-sorted. | The sidebar apps section. |
| `useSidebarSeries` | Pipeline series for the Create > Pipeline grandchildren (built on `useFocusRefreshedList`). | The sidebar pipeline-series section. |
| `useSidebarUniverses` | Universes for the Create > Universes grandchildren (built on `useFocusRefreshedList`). | The sidebar universes section. |

## Apps / Sessions / Domain

| Hook | Purpose | Use when |
|---|---|---|
| `useAppDeploy` | Stream `deploy.sh` output via Socket.IO. | App deployment surfaces only. |
| `useAppOperation` | Socket-based app ops (update, standardize) with step tracking. | App operations UI. |
| `useAppOverrideActions` | Per-app scheduled-task override mutations (`{ handleUpdateOverride, handleBulkToggleOverride }`) with shared toast copy + silent flag; pass the tab's `refetch`. | Any surface hosting `PerAppOverrideList` (Schedule tab, Timeline tab) — don't re-copy the write-plus-toast-plus-refetch handlers. |
| `useCanonPatch` | Optimistic canon-entry patch: rebuild the kind list with one entry mutated, apply locally, PATCH the universe, re-apply the server copy. Targets + staleness-guards on the loaded record's `universe.id` so a mid-flight universe swap can't cross-PATCH or resurrect stale state. `apply` is `setUniverse` or `onUniverseChange`. | Inline canon-field edits on a universe (UniverseCanonSection, NounsStage). Don't re-roll the optimistic-then-confirm dance. |
| `useCityAudio` | CyberCity ambient audio. | CyberCity only. |
| `useCityData` | CyberCity environment data + physics. | CyberCity only. |
| `useCityPlayback` | Timeline-scrubber transport: loads the snapshot series, steps a frame index, play/pause/speed. | CyberCity playback (history) mode only. |
| `useCitySettings` | CyberCity quality presets + persistence. | CyberCity only. |
| `useColorMatch` | Drives a song color-match run: counts the singer in with the metronome, walks the notated score in tempo, grades each note against the live mic pitch (#1022 tracker + colorMatch lib), and exposes `{ running, countingIn, noteColors, summary, activeIndex, start, stop }` for the `<ScoreSheet>` + an accuracy readout. Taps the passed recording stream (no second mic); tears down on stop/unmount. | The Song editor's color-match panel. Don't re-wire the metronome + tracker + grading loop by hand. |
| `useCodeReviewDefaults` | Global Code Review Defaults (Review Loop reviewer chain + per-backend local-LLM model) via a small Provider/hook pair. | TaskAddForm, ScheduleTab, anywhere a default reviewer picker is shown. |
| `useCatalogTypes` | Catalog ingredient type registry (system + user-defined) merged with the static fallback via a Provider/hook pair; synchronous fallback to the built-in six so first render never blanks. | Catalog list/picker/editor; anywhere the catalog type list/lookup is needed. |
| `useDeathClock` | 1-second countdown for death-clock display. | Mortality / death-clock surfaces. |
| `useGoalDetail` | All state + handlers backing the GoalDetailPanel (edit form, todos, milestones, plan/phases, check-ins, progress log, activity/calendar links). Loads activities + subcalendars on mount. | GoalDetailPanel composition shell; not intended for reuse outside the goals panel. |
| `usePostSession` | Post-render callback scheduling. | Generic post-action chaining. |
| `useRecordMerge` | Duplicate Universe/Series merge flow: open → dry-run preview → resolve field conflicts → execute, with an `onMerged` refresh callback. Drives `<MergeModal>`. | Surfacing the merge-duplicates UI anywhere (Sharing → Duplicates, Universes page). Don't re-implement the preview/execute dance. |
| `useProviderModels` | AI providers + two-step provider→model selection. | Any UI that picks a provider + model. |
| `useLocalModels` | Live installed Ollama/LM Studio model ids per backend + the server's editorial recommendation. | Model pickers that must show currently-installed local models (not just a provider's stale stored `models`). Fold in via `mergeModelLists` + `localBackendForProvider`. |
| `useTheme` | Dark/light theme + paired-theme switching. | Theme picker. |
| `useSingToScore` | Capture a sung melody from the mic and transcribe it into lead-sheet notation. `start()` opens the mic, counts in on the shared metronome, then accumulates a pitch track relative to beat 1; `stop()` runs the `transcribePitchTrack` pipeline (segment → quantize at the song tempo → spell for the key) and returns the lead-sheet body. Exposes `{ phase, beat, result, error, start, stop, reset }`; tears down mic/analyser/tracker/metronome on stop and unmount. | The Song editor's Sing-to-score panel. |
| `useSongTraining` | Drives a song training run over one scope (whole song or a sliced section) on top of `useColorMatch`: counts in, walks + grades the scope's score, then folds the finished take into the rolling progress history (`songProgress.recordAttempt`) and surfaces the next aggregate via `onProgress`. Supports looping (auto-restart after a run) and keeps a `lastSummary`. Exposes `{ running, countingIn, noteColors, activeIndex, lastSummary, start, stop }`; cancels pending loop relaunches on stop/unmount. | The Song editor's Training panel. |
| `useSyncIntegrity` | Fetches per-kind integrity diff from every eligible online peer; reduces to worst-case `statusById` + `byPeer` breakdown maps. | Federated media sync integrity UI — badges, drawers, peer breakdown. |
| `useTwinEvaluationSuite` | Shared lifecycle for the three Digital Twin evaluation-suite panels (Values-Alignment, Adversarial-Boundary, Multi-Turn): loads suite + recent history (silenced), runs every selected provider/model in parallel, prepends fresh runs, and handles the stale-persona / partial-failure toast fan-out. `countField` names the suite's pass-count key so history stays generic. Returns `{ items, history, loading, running, results, expanded, setExpanded, run, reload }`. | The Digital Twin `TwinEvaluationSuitePanel` presentation shell — don't re-roll the load/run/history dance per suite. |
| `useRenderJobQueue` | Per-entry render-job queue for the Universe Builder — `pendingByEntryId` (entryId → jobId[]), `pendingHeadByEntryId` (first jobId per entry for single-subscription thumbs), `enqueueEntryJobs` (append variation/canon jobs), `clearPendingForEntry` (shift a jobId out, or drop the entry). | Universe Builder render orchestration. Don't re-roll the per-entry pending-jobs reducer. |
| `useUniverse` | Loads the universe record for a `universeId` with mount/cancel guards; returns `[universe, setUniverse, loading, error]` (setter exposed for optimistic post-mutation updates). | Any surface that loads a linked universe (pipeline stages, etc.) — use instead of re-rolling the getUniverse-on-mount effect. |
| `useUniverseAction` | LLM-driven universe mutation scaffolding. | Universe Builder action UIs. |
| `useUniverseGallery` | Page-level lightbox + gallery-metadata concern for the Universe Builder. Takes `{ draft, runsLength }`; hydrates a filename→sidecar map (prompt/seed/model), derives `previewItems` across variations, composite sheets, style probes, and canon/character-sheet refs (namespaced-key dedupe), and wires `usePreviewRoute` + `useMediaPreviewActions` + `useMediaAnnotations`. Returns `{ previewItems, preview, setPreview, previewActions, openPreviewByFilename, openVariationPreview, annotations, updateAnnotation, bumpGalleryRefresh }`. | Universe Builder image lightbox — don't re-roll the gallery-sidecar/previewItems derivation. |
| `useUniverseNav` | `goToWorld(id)` → navigate to `/universes/:id`, preserve `location.search`. | Any Universe Builder caller that needs to switch worlds via URL. |
| `useVoiceUiSync` | Keeps voice server's UI index in sync with current page. | Wire once at root for voice agent support. |
| `useMoltworldWs` | Moltworld WebSocket feed. | Moltworld surfaces only. |
| `useYoutubeTrackImport` | One YouTube-audio-import job slot (#1945): start/cancel + SSE progress + terminal-frame handling via `POST /api/tracks/import/youtube`. Returns `{ active, percent, start(url, context), cancel }`; `onComplete(track, context)` fires with the finished Track. Call once per UI surface that can independently kick off an import — a shared slot would let one surface's kickoff orphan another's in-flight job. | Any picker that lets a user paste a YouTube URL to create a Track (Music Video's create form and track-change row). |
| `useVideoDownload` | One full-video-download job slot (#1946): start/cancel + SSE progress + terminal-frame handling via `POST /api/devtools/video-download`. Returns `{ active, percent, stage, start(url), cancel }`; `onComplete(video)` fires with the finished video-history entry. | The Dev Tools Video Downloader page. |
| `useReferenceAudioImport` | One round reference-audio-import job slot (#2120): start/cancel + SSE progress + terminal-frame handling via `POST /api/rounds/reference-audio/import`. Returns `{ active, percent, stage, start(url, context), cancel }`; `onComplete(filename, context)` fires with the uploads-dir filename to persist on the reference. Call once per surface that can independently kick off a download. | The reference-audio attach controls (`ReferenceAudioAttach`) — the "Download from URL" convenience. |
| `useMidiTranscription` | One audio → MIDI transcription job slot (MuScriptor): start/cancel + SSE stage progress + terminal-frame handling, generic over the Rounds and Music Video API surfaces (pass `startRequest`/`eventsUrl`/`cancelRequest`). Returns `{ active, stage, stageLabel, context, start(context), cancel }` (`stageLabel` is the ready-to-render human label for the current STAGE — including a distinct "Downloading model…" for the first-use weight download, which also fires a one-time toast; `context` is the in-flight job's captured target, for per-target UI gates); `onComplete(frame, context)` fires with the terminal frame (`filename`, `model`, any server-merged extras). | The Rounds reference "Transcribe MIDI" control and the Music Video MIDI button. |
| `useCanvasDprSize` | DevicePixelRatio-aware canvas sizing shared by the piano-roll renderers (`<PianoRoll>`, `<MidiPianoRoll>`): sizes the bitmap to container-width × height at the DPR, applies the transform, and redraws via a `drawRef` on mount + every `ResizeObserver` resize (observer created once per height, never churned by draw-closure changes). Returns a ref holding the current CSS width so draw code doesn't measure the DOM per frame. | Both piano-roll canvases. |
| `useCanvasRollPalette` | Resolves the roll canvas palette (theme-following `--port-accent` + roll bg via `rollPalette`) into a ref, re-resolving on theme switch (`data-port-theme` MutationObserver) and repainting through a `drawRef`. Hands back a ref, not state, so a theme swap redraws the imperative canvas without a React re-render. | Both piano-roll canvases need theme-aware accent/bg colors that canvas `fillStyle` can't read from CSS vars. |
| `useMidiNotes` | Fetch + parse a transcribed `.mid` file into the piano-roll view-model (`parseMidiFile` in `lib/midiNotes.js`), with a module-level per-URL cache so remounts (collapse, tab switches) don't refetch/reparse. Returns `{ status: 'idle'\|'loading'\|'ready'\|'error', data, error, reload }`; a generation counter drops stale in-flight responses on URL change/unmount. Plain `fetch` of the static file URL — errors surface inline, never as toasts (#2477). | `<MidiVisualization>` (Rounds ReferenceAnalysis + Music Video). |
| `useMidiPlayer` | React wrapper over `lib/midiPlayback.js` (#2490): one synth player per parsed MIDI view-model, torn down when the data changes/unmounts so oscillators never outlive the roll. Returns `{ playing, toggle, seek(sec), getPosition }` — `getPosition` is the stable ref the `<MidiPianoRoll>` rAF playhead reads; no AudioContext is touched until the first toggle. A resume failure resets `playing` instead of lying. | `<MidiVisualization>` (Rounds ReferenceAnalysis + Music Video). |
