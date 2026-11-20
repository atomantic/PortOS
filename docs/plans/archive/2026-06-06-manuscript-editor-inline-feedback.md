# Re-imagine the Manuscript Editor — in-context editorial feedback

## Context

The Manuscript editor (`/pipeline/series/:seriesId/manuscript`) makes the "Finish the
draft" editorial pass actionable. Today it's a two-pane layout: the manuscript on the
left (one plain `<textarea>` per issue) and a 380px sidebar on the right holding every
editorial comment, plus a floating overlay when you jump to one. The user's complaint:
**all the feedback lives in the sidebar, you scroll a lot, and you read each note out of
context.** They want feedback **integrated into the text itself, Grammarly-style** —
inline highlighted/underlined spans with helpful hints, expandable info beside the text,
a clear **side-by-side diff** for reviewing an edit, and a way to see **how accepted edits
change the whole manuscript** (per-card diffs don't convey cumulative impact).

Decisions from the user:
- **Grammarly-style inline hints** are the target feel: text stays editable, anchored
  feedback shows as colored underlines, clicking one pops a small card with the
  suggestion + actions.
- Unsure between "always-editable" and "read-then-edit" — **wants a toggle to try both.**
- **Diff:** side-by-side (old | new columns) is the default; keep today's stacked inline
  diff as a compact toggle.
- **Impact preview:** a full-screen modal showing before/after for the changed sections.

## What exists today (reuse, don't rebuild)

- `client/src/pages/PipelineManuscriptEditor.jsx` — the whole page (sections, sidebar,
  `CommentCard`, `ManuscriptSection`, `ActiveCommentOverlay`, generate/accept/dismiss,
  `fixDrafts` state lifted to the page, version history/revert).
- Comments anchor to text by **verbatim substring** (`anchorQuote`), not offsets.
  `jumpToComment` does `textarea.value.indexOf(anchorQuote)`. Server `locateFind`
  (`server/services/pipeline/manuscriptFix.js:153`) disambiguates recurring matches by
  picking the occurrence nearest the anchor — we mirror this client-side.
- `client/src/components/ui/InlineDiff.jsx` — word-level Myers LCS, stacked old/new rows,
  4M-cell cap with a both-versions fallback. **The only diff component.**
- Generate (`POST …/fix`), accept (`POST …/accept`, returns rewritten sections), save
  (`PUT …/sections/:issueId`), revert — all work. **No server changes needed.**
- Section auto-grows to fit content (`rowsFor`, cap 400 rows) → for typical sections
  there's no internal textarea scroll, which makes a highlight overlay tractable.

## Approach: two viewing modes behind a header toggle

A persisted (localStorage) **mode toggle** in the editor header lets the user try both
editing models the user was torn between. Both modes share one anchor-location lib, one
comment card, and one diff component — only the manuscript surface differs.

### Mode 1 — "Live" (Grammarly, default)
Each section is the **existing editable `<textarea>`** with a **backdrop highlight layer**
behind it (the established react-highlight-within-textarea technique):
- A backdrop `<div>` is absolutely positioned over the textarea with **identical** box
  metrics (font, line-height, padding, `white-space: pre-wrap`, `word-break`, width). Its
  text is `color: transparent`; anchored spans render as `<mark>` with a severity-toned
  **wavy/solid `border-bottom`** (the Grammarly underline). The textarea sits on top with
  a transparent background, so its real text + caret show over the backdrop's underlines —
  and because layout is identical, each underline sits exactly under its words.
- Sections auto-grow to content, so no scroll-sync in the common case; if a section
  exceeds the 400-row cap, sync `backdrop.scrollTop = textarea.scrollTop`.
- **Click-to-open without pointer-event juggling:** on textarea click, read
  `selectionStart`, find which anchor span covers that index, and open that comment's
  **popover** anchored to the corresponding backdrop `<mark>`'s `getBoundingClientRect()`.
  The popover is a compact `ManuscriptCommentCard` (problem + suggestion + side-by-side
  diff + Generate/Accept/Dismiss). `Esc` closes it.
- A subtle gutter/inline **hint chip** ("3 notes") per section gives a non-click way in
  and a count, and keeps discoverability for touch.

### Mode 2 — "Review" (read-then-edit)
Default to a **read-only annotated prose `<div>`** (highlights painted directly as
`<mark>`s + a margin pin rail aligned to each highlight); click a highlight/pin to expand
the same card inline beneath the paragraph; an **Edit** affordance (or clicking into the
prose) swaps that one section to the textarea, blur saves and re-annotates. Best for a
focused, whole-page editorial sweep and as the **safe fallback** if Live-mode overlay
alignment proves fiddly on some fonts.

Both modes: the **sidebar becomes a navigable index/filter** (severity / category /
open|accepted|dismissed chips + counts) rather than the reading surface. A row click
scrolls to the section and opens that comment's popover/card. The old
`ActiveCommentOverlay` is removed — the in-context card supersedes it.

## New pure helpers — `client/src/lib/` (barrel + README rows + colocated tests required)

Per the module-organization rule, each is added to `client/src/lib/index.js`, gets a row
in `client/src/lib/README.md`, and has a `*.test.js`.

1. **`diffWords.js`** — extract the `lcs` + tokenization + `DIFF_CELL_CAP` core out of
   `InlineDiff.jsx`. `diffWords(oldText, newText) → { tooLarge, oldRuns, newRuns }`
   (runs = `[{ text, changed }]`). Both `InlineDiff` and the new `SideBySideDiff` consume
   it — removes duplication of the LCS core.
2. **`manuscriptAnchors.js`** — `locateAnchors(content, comments)` → `[{ commentId,
   severity, start, end }]` for comments whose `anchorQuote` is found, reusing the
   **nearest-occurrence** disambiguation from server `locateFind` (header notes the
   mirror). `buildHighlightSegments(content, spans)` → flatten overlapping/recurring spans
   into ordered non-overlapping segments `[{ text, commentIds[], topSeverity }]`.
3. **`applyManuscriptEdits.js`** — `applyEditsToContent(content, edits, anchorQuote)`:
   client mirror of the server splice (locate each `find`, replace in descending order,
   skip overlaps) for the **preview only** (server stays authoritative). Shares one
   `locateFind` copy with `manuscriptAnchors.js`.

## New components — `client/src/components/`

- `ui/SideBySideDiff.jsx` — two-column old|new diff built on `diffWords`; respects
  `tooLarge` with the same fallback as `InlineDiff`. `+ SideBySideDiff.test.jsx`.
- `pipeline/manuscript/ManuscriptCommentCard.jsx` — **lift the existing `CommentCard`
  out of the page unchanged in logic** (it already takes `idScope` + lifted
  `draft`/`onDraftChange`, so the sidebar row, the inline popover, and the impact list can
  all share one edit state). Add a diff-style toggle (side-by-side default ⇄ stacked
  inline). `idScope` of `live-…`/`review-…` avoids `htmlFor` collisions.
- `pipeline/manuscript/ManuscriptLiveSection.jsx` — Mode 1: textarea + backdrop overlay +
  click→popover. Keeps `registerRef` so sidebar jump-to still focuses the textarea.
- `pipeline/manuscript/ManuscriptHighlightedProse.jsx` + `AnnotatedManuscriptSection.jsx`
  — Mode 2: read-only `<mark>` prose + pin rail + click-to-expand + edit toggle.
- `pipeline/manuscript/ManuscriptImpactPreview.jsx` — full-screen `Modal`
  (reuse `client/src/components/ui/Modal.jsx`) that runs `applyEditsToContent` per
  **changed** section, renders a `SideBySideDiff` per section (per-section, not one giant
  diff, so the cap isn't tripped), header summarizing "N edits · M issues". Toggle:
  changed-only ⇄ whole manuscript.

## Changes to `PipelineManuscriptEditor.jsx`

- Refactor: move `CommentCard` → `ManuscriptCommentCard.jsx`; remove `ManuscriptSection`
  + `ActiveCommentOverlay` (replaced by the two mode components + inline popover).
- State: add `viewMode` ('live'|'review', persisted), `openCommentId` (popover/inline),
  `editingIssueId` (review-mode textarea). Keep `fixDrafts`/`setCommentDraft` (now shared
  by sidebar + popover + preview). Remove `activeCommentId`.
- Memo grouping comments by issue, gated on `stageId === viewType` for anchoring (mirrors
  the existing `applyAccepted` cross-stage guard — comments targeting an off-screen format
  stay index-only).
- `jumpToComment` → "reveal in context": scroll section into view + open its
  popover/card (keep `setSelectionRange` when a section is already in edit mode).
- Header: mode toggle + an **"Impact preview"** button (opens the modal with open
  comments that have generated fixes and their selected edits from `fixDrafts`).
- `applyAccepted` unchanged — after accept the comment flips to `accepted`, its highlight
  drops, anchors recompute.

## Server

**None.** Anchoring, generate, accept (returns rewritten sections), save, revert all
exist. Impact preview computes from data already on the page. (A future
`POST …/review/preview` for server-authoritative preview is explicitly out of scope.)

## Phasing

1. **Diff core + side-by-side** — extract `diffWords.js`, refactor `InlineDiff` onto it
   (output identical), add `SideBySideDiff`. Independently shippable.
2. **Live mode** — `manuscriptAnchors.js`, `ManuscriptLiveSection`, lift
   `ManuscriptCommentCard`, click→popover; wire the mode toggle (Live default).
3. **Review mode** — `ManuscriptHighlightedProse` + `AnnotatedManuscriptSection`; the
   sidebar becomes index/filter; remove `ActiveCommentOverlay`.
4. **Impact preview** — `applyManuscriptEdits.js` + `ManuscriptImpactPreview` + button.

## Risks & mitigations

- **Overlay alignment (Live mode):** backdrop and textarea must share exact typography;
  any drift desyncs underlines. Mitigate by deriving both from one shared className and
  testing serif (prose) + mono (script) stages. Review mode is the fallback if a font
  refuses to align.
- **Anchor not found / fuzzy:** `anchorQuote` may not match verbatim (edited since review,
  or server flagged `fuzzy`). `locateAnchors` yields no highlight; the comment still lists
  in the sidebar with the existing "anchor not found" warning. Surface a "X of Y notes
  located in text" count so the divergence is explicit, not silent.
- **Overlapping / recurring anchors:** `buildHighlightSegments` flattens to non-overlapping
  segments carrying a `commentIds` set; a multi-comment span opens a chooser or the
  highest-severity card. Recurring quotes resolve to the single nearest-anchor occurrence
  (matches where accept lands).
- **Performance / diff cap:** segmentation is O(content) per section, memoized. Impact
  preview diffs **per changed section**, never one concatenation, so `DIFF_CELL_CAP` isn't
  tripped; keep `<mark>`s to open comments only.
- **Mobile (<640px):** sidebar already collapses below `lg`. Pins collapse to inline
  badges, popover becomes a bottom sheet, impact modal goes full-screen; verify no
  horizontal overflow with `resize-y`.
- **Accessibility:** marks/pins are real `<button>`s with `aria-expanded`/`aria-controls`
  → card id and a severity/category `aria-label`; `Esc` closes and returns focus; don't
  rely on underline color alone (keep the text severity label). Edit toggle is a real
  button, not click-anywhere only.

## Verification

- `npm run dev` (client `:5554`, API `:5555`). Open
  `/pipeline/series/:seriesId/manuscript` for a series with generated editorial comments.
- **Live mode:** anchored notes show severity-toned underlines under the right words;
  clicking text on an underline opens the popover at that spot; Generate/Accept/Dismiss
  work and the underline updates after accept; typing still saves on blur
  (`PUT …/sections/:issueId` in the Network tab); an un-findable anchor shows no underline
  but still lists in the sidebar.
- **Review mode:** toggle modes; highlights + aligned pins render; expand card inline;
  Edit toggle → textarea → blur saves → re-annotates; version history/revert still work.
- **Diff:** card defaults to side-by-side, toggles to stacked inline, identical word-level
  changes; force the `tooLarge` fallback with a large edit.
- **Impact preview:** with several fixes selected, open the modal; before/after spans the
  changed sections and matches what accept produces (accept one, reopen, it drops out).
- **Sidebar index:** severity/category/status filters; row click scrolls + opens the card.
- **Mobile:** below 640px — sidebar collapses, pins inline, popover bottom-sheet, modal
  full-screen, no horizontal scroll.
- **Unit tests:** `diffWords.test.js`, `manuscriptAnchors.test.js` (not-found / recurring
  / overlapping), `applyManuscriptEdits.test.js` (descending-splice + overlap rejection vs
  server `planEditsBySection` expectations), `SideBySideDiff.test.jsx`; run the existing
  `InlineDiff.test.jsx` to confirm the core extraction is behavior-preserving.
- After the feature lands, run `/simplify` on the diff, then commit + push.
