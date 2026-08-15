# `client/src/components/ui/` — shared UI primitives

Presentational building blocks with no domain knowledge. **Grep this catalog before
hand-rolling chrome** — nearly every primitive here exists because the same markup had
already been copy-pasted across three-to-ten surfaces and drifted (usually on
accessibility). Feature-specific components live under their own feature directory
(`components/pipeline/`, `components/meatspace/`, …), not here.

| Component | What it's for |
| --- | --- |
| `AutoSizeTextarea` | Controlled `<textarea>` that grows to fit its content — no internal scroll, no hand-resize. |
| `Banner` | Toned alert block (icon + content + actions) for warnings, errors, and info callouts. |
| `BeatPulse` | Metronome dot row — one dot per beat of the bar, the current one lit. |
| `CollapsibleSection` | Disclosure section header — chevron, leading icon, collapsed summary, `aria-expanded`. |
| `CollapsibleText` | Line-clamped text preview with a show-more/less toggle. |
| `ConfirmButtonPair` | Compact inline confirm/cancel pair for a destructive action in a dense control row. |
| `CopyableId` | Click-to-copy record-id badge — short prefix shown, full id copied. |
| `diffRuns` | Renders `{ text, changed }` runs from `diffWords` as highlighted nodes (shared by the diff views). |
| `FilePickerButton` | Opens the OS file picker, styled as a button or as a whole drop target. |
| `FormField` | Accessible config-field wrapper — generates an id and wires `<label htmlFor>` to the input. |
| `HunkDiff` | Hunked side-by-side diff for long texts, with unchanged runs collapsed. |
| `ImageThumb` | List-card thumbnail with an icon fallback when the ref is missing or 404s. |
| `InfoTooltip` | Focusable info/help tooltip — hover, keyboard focus, or tap; Esc to dismiss. |
| `InlineConfirmRow` | Inline "question + confirm + cancel" row — PortOS's preferred alternative to `window.confirm`. |
| `InlineDiff` | Stacked word-level diff — old row (red removals) over new row (green additions). |
| `Kbd` | Keycap for rendering a keyboard key in help/cheatsheet UI. |
| `Modal` | Shared modal chrome — backdrop, Esc handling, click-outside. |
| `OverflowMenu` | "…" menu that demotes rare or destructive row actions out of the visible control set. |
| `PageSkeleton` | Full-page loading skeleton that reserves the loaded layout so the first paint doesn't reflow. |
| `Pill` | Inline label badge — semantic tone, optional icon, `sm`/`xs` sizes. |
| `ProcessLogLines` | Renders a PM2 process's log lines (the body of a log pane). |
| `ProcessLogModal` | Self-contained viewer for a PM2 process's system log. |
| `ProgressBar` | Horizontal progress meter — `percent` (or `null` for indeterminate), semantic `tone`, and the ARIA trio with an accessible name from `label`. |
| `ProseEditor` | Prose-writing textarea — serif face, relaxed leading, spellcheck. Markdown string in/out. |
| `ProvenanceChip` | Chip + popover showing where a generated value came from. |
| `SideBySideDiff` | Columnar word-level diff — old left, new right. |
| `Skeleton` | Loading-placeholder primitives (`SkeletonBlock` / `Lines` / `Card` / `Rows` / `Region`) — what `PageSkeleton` is built from, and what a sub-region loader should reserve its shape with instead of a bare spinner. |
| `TabPills` | Shared tab nav — `underline` / `pills` families, with a mobile `<select>` fallback. |
| `Toast` | Toast notification system (`toast()`, `.success()`, `.error()`, `.loading()`, `<Toaster />`). |
| `ToggleChip` | Checkbox styled as a pill — the "pick some of these" affordance. |
| `ToolUseWarning` | The "this model can't call tools" warning every agent/model picker shows. |
| `UnsavedChangesConfirm` | The discard confirm every `useUnsavedChangesGuard` consumer renders from `blocked`. |

There is no `index.js` barrel here — components are imported by path
(`import ProgressBar from '../ui/ProgressBar'`), matching the rest of `components/`. The
barrel + README rule in the root `CLAUDE.md` covers `lib/`, `hooks/`, `utils/`, and
`services/`; this catalog exists for discovery only. **Adding a primitive here means
adding its row above** — a catalog nobody updates is the reason six copies of the
progress meter existed in the first place.
