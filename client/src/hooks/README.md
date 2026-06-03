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
| `useSharingNotifications` | Subscriber for share-bucket notifications. | Wire once to surface federation/sync events. |

## Pipeline / Story Builder wiring

| Hook | Purpose | Use when |
|---|---|---|
| `useArcCanvasSync` | Host-side wiring for the embedded `<ArcCanvas>`: `lastSavedRef` dirty-check + `updateSeriesFromServer` / `handleIssuesUpdate` / `flushPending`. Parameterized by `flushFields` (which bible fields to flush) + `silent`/`onFlushError`. | Embedding `<ArcCanvas>` in a host that owns `series`/`issues` state (PipelineSeries, Story Builder arc step). Don't re-implement the setter contract. |

## Progress & streaming (SSE / socket)

| Hook | Purpose | Use when |
|---|---|---|
| `useSseProgress` | Generic JSON-frame EventSource subscriber. | New SSE progress stream — start here, build on top. |
| `useModelDownloadStatus` | Image/video model cache-status + SSE pre-download. | Surfacing "Available" vs "Download" badge inline in the gen form. |
| `useImageGenProgress` | Live diffusion progress for an image-gen call. | Showing per-call image-gen progress. |
| `useImporterProgress` | Live analyze-phase stage checklist via the `importer:progress` socket (runId-filtered); exports `stageStatusIcon` for the status→icon lookup. | Importer analyze progress UI only. |
| `useMediaJobProgress` | Live progress for a single `mediaJobQueue` job. | Subscribing to a known media-job id. |
| `useMediaJobSse` | Imperative per-job `/{kind}-gen/:id/events` SSE; `attach()` returns a Promise that settles on the terminal frame. | POST-then-attach media render flows that await completion (ImageGen/VideoGen). |
| `useOpenClawStream` | OpenClaw SSE chat stream. | OpenClaw file-browser chat surface only. |
| `usePipelineAutoRunProgress` | Auto-run-text SSE for a pipeline issue. | Pipeline auto-run UI surfaces only. |
| `usePipelineEditorialProgress` | Series editorial reader-emotion batch SSE. | Editorial Roadmap analysis UI only. |
| `usePipelineVolumeBeatsProgress` | Volume beat-sheet SSE. | Volume beat-sheet UI only. |
| `useSeriesEditorial` | Editorial-roadmap aggregate + batch lifecycle (load, re-attach, SSE, start/cancel, reload). | Any view of the editorial roadmap (panel or Reader Map page). |
| `useStoryStepProgress` | Generate/refine SSE for one Story Builder step. | Story Builder step generate/refine progress only. |

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
| `useArmedAction` | Two-click-arm `[armed, fire]` confirmation. | Destructive button needing a confirm tap. (Project memory: user finds this less discoverable — prefer inline confirm rows for new UI.) |
| `useAutoRefetch` | Poll-based refetch on an interval. `{ pollOnly: true }` skips internal data/loading state for side-effect-only callers (returns `{ refetch }` only). | Data needs periodic refresh (no socket / SSE available). |
| `useClickOutside` | Fire `onOutside` on mousedown outside a ref. | Popovers, menus, drawers. |
| `useCmdKSearch` | `⌘K` open/close state. | Anywhere that needs to toggle the palette. |
| `useContainerWidth` | `[ref, width]` via ResizeObserver. | Layout responds to a specific container's width. |
| `useCooldownTick` | 1-second ticker over a `{ id: epochMs }` cooldown map; fires `onAllExpired` once when every deadline passes. | Rate-limit countdown labels that need to refetch when the last cooldown clears (agents tabs pattern). |
| `useFieldDraft` | Local input draft that commits on blur. | Bible-editor-style single-field input that must dedupe sibling races. |
| `useRowDraft` | Multi-column row draft (analogue of `useFieldDraft`). | Multi-column row that commits as a unit. |
| `usePendingListRows` | List-of-rows where a new row is held client-side until a required column fills, then promoted to `onChange`. | Editable list whose nameless rows would otherwise be dropped by the server sanitizer (WardrobeSection, CharacterDetailEditor list sections). |
| `useKeyboardControls` | Keyboard binding for CyberCity mode toggle. | CyberCity-specific. |
| `useKeyboardHelp` | Esc closes, even from inputs/textareas. | Help/cheatsheet modals. |
| `useLockToggle` | Optimistic-PATCH lock toggle. | New "lock this field/stage/arc" button — use this, do not re-implement. |
| `usePopoverPosition` | Viewport-clamped `{ left, top, width }` for a fixed-position portal popover anchored to a trigger; re-measures on open and rAF-coalesced on capture-phase scroll/resize. Returns `{ triggerRef, popoverRef, style, reposition }`; pass `anchorRef` to follow a parent-owned trigger. | Any portal-into-`<body>` menu/popover placed relative to a button (ThemeSwitcher, CollectionPickerShell) — use this instead of re-rolling the measure/flip/clamp/reflow plumbing. |
| `useScrollLock` | Body-scroll lock with ref-count. | Modals, drawers, lightboxes. |
| `useSwipeNav` | Horizontal swipe prev/next. | Mobile swipe between siblings. |
| `useAsyncAction` | `running` state + toast-on-error. | Buttons that await an async action. |

## Storage & persistence

| Hook | Purpose | Use when |
|---|---|---|
| `useLocalStorageBool` | Boolean `useState` mirrored to `localStorage`. | Per-user UI preference toggle. |

## Apps / Sessions / Domain

| Hook | Purpose | Use when |
|---|---|---|
| `useAppDeploy` | Stream `deploy.sh` output via Socket.IO. | App deployment surfaces only. |
| `useAppOperation` | Socket-based app ops (update, standardize) with step tracking. | App operations UI. |
| `useCanonPatch` | Optimistic canon-entry patch: rebuild the kind list with one entry mutated, apply locally, PATCH the universe, re-apply the server copy. Targets + staleness-guards on the loaded record's `universe.id` so a mid-flight universe swap can't cross-PATCH or resurrect stale state. `apply` is `setUniverse` or `onUniverseChange`. | Inline canon-field edits on a universe (UniverseCanonSection, NounsStage). Don't re-roll the optimistic-then-confirm dance. |
| `useCityAudio` | CyberCity ambient audio. | CyberCity only. |
| `useCityData` | CyberCity environment data + physics. | CyberCity only. |
| `useCitySettings` | CyberCity quality presets + persistence. | CyberCity only. |
| `useCodeReviewDefaults` | Global Code Review Defaults (Review Loop reviewer chain + per-backend local-LLM model) via a small Provider/hook pair. | TaskAddForm, ScheduleTab, anywhere a default reviewer picker is shown. |
| `useCatalogTypes` | Catalog ingredient type registry (system + user-defined) merged with the static fallback via a Provider/hook pair; synchronous fallback to the built-in six so first render never blanks. | Catalog list/picker/editor; anywhere the catalog type list/lookup is needed. |
| `useDeathClock` | 1-second countdown for death-clock display. | Mortality / death-clock surfaces. |
| `useGoalDetail` | All state + handlers backing the GoalDetailPanel (edit form, todos, milestones, plan/phases, check-ins, progress log, activity/calendar links). Loads activities + subcalendars on mount. | GoalDetailPanel composition shell; not intended for reuse outside the goals panel. |
| `useNextEvalCountdown` | 1-second countdown to the next CoS evaluation tick. | Chief of Staff "next eval in Xs" displays. |
| `usePostSession` | Post-render callback scheduling. | Generic post-action chaining. |
| `useRecordMerge` | Duplicate Universe/Series merge flow: open → dry-run preview → resolve field conflicts → execute, with an `onMerged` refresh callback. Drives `<MergeModal>`. | Surfacing the merge-duplicates UI anywhere (Sharing → Duplicates, Universes page). Don't re-implement the preview/execute dance. |
| `useProviderModels` | AI providers + two-step provider→model selection. | Any UI that picks a provider + model. |
| `useTheme` | Dark/light theme + paired-theme switching. | Theme picker. |
| `useSyncIntegrity` | Fetches per-kind integrity diff from every eligible online peer; reduces to worst-case `statusById` + `byPeer` breakdown maps. | Federated media sync integrity UI — badges, drawers, peer breakdown. |
| `useUniverse` | Loads the universe record for a `universeId` with mount/cancel guards; returns `[universe, setUniverse, loading, error]` (setter exposed for optimistic post-mutation updates). | Any surface that loads a linked universe (pipeline stages, etc.) — use instead of re-rolling the getUniverse-on-mount effect. |
| `useUniverseAction` | LLM-driven universe mutation scaffolding. | Universe Builder action UIs. |
| `useUniverseNav` | `goToWorld(id)` → navigate to `/universes/:id`, preserve `location.search`. | Any Universe Builder caller that needs to switch worlds via URL. |
| `useVoiceUiSync` | Keeps voice server's UI index in sync with current page. | Wire once at root for voice agent support. |
| `useMoltworldWs` | Moltworld WebSocket feed. | Moltworld surfaces only. |
