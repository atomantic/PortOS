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

## Progress & streaming (SSE / socket)

| Hook | Purpose | Use when |
|---|---|---|
| `useSseProgress` | Generic JSON-frame EventSource subscriber. | New SSE progress stream — start here, build on top. |
| `useImageGenProgress` | Live diffusion progress for an image-gen call. | Showing per-call image-gen progress. |
| `useMediaJobProgress` | Live progress for a single `mediaJobQueue` job. | Subscribing to a known media-job id. |
| `useOpenClawStream` | OpenClaw SSE chat stream. | OpenClaw file-browser chat surface only. |
| `usePipelineAutoRunProgress` | Auto-run-text SSE for a pipeline issue. | Pipeline auto-run UI surfaces only. |
| `usePipelineVolumeBeatsProgress` | Volume beat-sheet SSE. | Volume beat-sheet UI only. |

## Media (annotations, completion, attachments)

| Hook | Purpose | Use when |
|---|---|---|
| `useMediaAnnotations` | Per-entry `own`/`others` annotations with back-compat aliases. | Showing media annotations + ownership. |
| `useMediaCompletionRefresh` | Refetch on image/video completion socket events. | A list view that needs to refresh when new media lands. |
| `useOpenClawAttachments` | File attachment handling (base64, size-capped). | OpenClaw attachment UI. |
| `useMediaPreviewActions` | Shared MediaPreview / MediaLightbox action handlers (images + videos — dispatch by `item.kind`). | New surface that exposes the same 4 preview actions. |
| `usePreviewRoute` | URL-driven `[preview, setPreview]` via `?preview=<filename>`. | Any page hosting `<MediaPreview>` — gives the preview a deep-link. |
| `useImageGenQueue` | Work-scoped live queue of in-flight image renders. | Pages that show per-work image-gen queue state. |

## Sockets & lifecycle

| Hook | Purpose | Use when |
|---|---|---|
| `useSocket` | Shared socket instance + connection status. | You need to subscribe to a socket event. |
| `useUpdateChecker` | Detect stale client bundle; show reload toast. | Wire once at app root. |
| `useMounted` | `mountedRef` whose `.current` is true while mounted. | Async deferred work that must abort on unmount. |
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
| `useCityAudio` | CyberCity ambient audio. | CyberCity only. |
| `useCityData` | CyberCity environment data + physics. | CyberCity only. |
| `useCitySettings` | CyberCity quality presets + persistence. | CyberCity only. |
| `useCodeReviewDefaults` | Global Code Review Defaults (Review Loop reviewer chain + per-backend local-LLM model) via a small Provider/hook pair. | TaskAddForm, ScheduleTab, anywhere a default reviewer picker is shown. |
| `useDeathClock` | 1-second countdown for death-clock display. | Mortality / death-clock surfaces. |
| `useNextEvalCountdown` | 1-second countdown to the next CoS evaluation tick. | Chief of Staff "next eval in Xs" displays. |
| `usePostSession` | Post-render callback scheduling. | Generic post-action chaining. |
| `useRecordMerge` | Duplicate Universe/Series merge flow: open → dry-run preview → resolve field conflicts → execute, with an `onMerged` refresh callback. Drives `<MergeModal>`. | Surfacing the merge-duplicates UI anywhere (Sharing → Duplicates, Universes page). Don't re-implement the preview/execute dance. |
| `useProviderModels` | AI providers + two-step provider→model selection. | Any UI that picks a provider + model. |
| `useTheme` | Dark/light theme + paired-theme switching. | Theme picker. |
| `useSyncIntegrity` | Fetches per-kind integrity diff from every eligible online peer; reduces to worst-case `statusById` + `byPeer` breakdown maps. | Federated media sync integrity UI — badges, drawers, peer breakdown. |
| `useUniverseAction` | LLM-driven universe mutation scaffolding. | Universe Builder action UIs. |
| `useUniverseNav` | `goToWorld(id)` → navigate to `/universes/:id`, preserve `location.search`. | Any Universe Builder caller that needs to switch worlds via URL. |
| `useVoiceUiSync` | Keeps voice server's UI index in sync with current page. | Wire once at root for voice agent support. |
| `useMoltworldWs` | Moltworld WebSocket feed. | Moltworld surfaces only. |
