---
phase: 04-cross-domain-insights-engine
plan: 02
subsystem: insights-ui
tags: [insights, genome, taste-identity, cross-domain, react, ui, diff-viewer]
dependency_graph:
  requires:
    - client/src/services/api.js (getGenomeHealthCorrelations, getInsightThemes, getInsightNarrative, refreshInsightThemes, refreshInsightNarrative)
    - /api/insights/* (5 endpoints from Plan 01)
    - client/src/pages/MeatSpace.jsx (structural pattern reference)
    - client/src/components/Layout.jsx (nav entry)
    - client/src/App.jsx (route configuration)
  provides:
    - client/src/pages/Insights.jsx
    - client/src/components/insights/ConfidenceBadge.jsx
    - client/src/components/insights/InsightCard.jsx
    - client/src/components/insights/ProvenancePanel.jsx
    - client/src/components/insights/EmptyState.jsx
    - client/src/components/insights/GenomeHealthTab.jsx
    - client/src/components/insights/TasteIdentityTab.jsx
    - client/src/components/insights/CrossDomainTab.jsx
    - /insights/:tab routes (4 deep-linked sub-views)
  affects:
    - client/src/App.jsx (2 new routes)
    - client/src/components/Layout.jsx (Insights nav entry, isFullWidth)
    - client/package.json (react-diff-viewer-continued dependency)
    - .changelog/v1.14.x.md
tech_stack:
  added:
    - react-diff-viewer-continued (narrative before/after diff display)
  patterns:
    - Tabbed page at /:page/:tab with useParams for deep-linked URLs
    - Promise.allSettled for parallel multi-domain data fetching in Overview
    - Cache-first API with { available: false, reason } graceful degradation
    - Collapsible sections pattern (CategorySection, ProvenancePanel, EvidenceList)
    - MeatSpace structural pattern replicated for Insights (header + tab bar + scrollable content)
key_files:
  created:
    - client/src/pages/Insights.jsx
    - client/src/components/insights/ConfidenceBadge.jsx
    - client/src/components/insights/InsightCard.jsx
    - client/src/components/insights/ProvenancePanel.jsx
    - client/src/components/insights/EmptyState.jsx
    - client/src/components/insights/GenomeHealthTab.jsx
    - client/src/components/insights/TasteIdentityTab.jsx
    - client/src/components/insights/CrossDomainTab.jsx
  modified:
    - client/src/App.jsx
    - client/src/components/Layout.jsx
    - client/package.json
    - .changelog/v1.14.x.md
decisions:
  - Insights nav entry placed as single item (not expandable) — sub-tabs navigate from within the page
  - /insights added to isFullWidth paths in Layout.jsx to match MeatSpace full-height rendering pattern
  - STRENGTH_TO_LEVEL maps tentative->weak, moderate->moderate, strong->strong for ConfidenceBadge consistency
  - Overview tab uses Promise.allSettled so any single domain failure does not block the other cards
  - CrossDomainTab diff view only appears after a refresh has been triggered and previousText differs from text (trimmed)
  - Summary cards use navigate() (not Link) so the entire card area is clickable without nested link issues
metrics:
  duration: 238s
  completed: 2026-02-26
  tasks_completed: 3
  files_created: 8
  files_modified: 4
---

# Phase 4 Plan 2: Insights Dashboard UI Summary

**One-liner:** Tabbed Insights dashboard at `/insights/:tab` with genome-health correlation cards, LLM taste-identity theme cards, and cross-domain narrative with ReactDiffViewer diff toggle — all deep-linked and following established PortOS design patterns.

## What Was Built

### Dependency Added

`react-diff-viewer-continued` installed in `client/package.json` for the narrative before/after diff display in CrossDomainTab.

### Shared Components (`client/src/components/insights/`)

**`ConfidenceBadge.jsx`** — Presentational badge with 5 confidence levels:
- `strong` → green (`port-success`)
- `moderate` → yellow (`port-warning`)
- `weak` → red (`port-error`)
- `significant` → deeper red
- `unknown` → gray

**`InsightCard.jsx`** — Shared card shell with `bg-port-card border border-port-border rounded-lg p-4` layout, header row with title + badge, subtitle, inline source pills, and `children` slot.

**`ProvenancePanel.jsx`** — Collapsed by default. Click ChevronRight/Down to expand. Renders reference list with study name, publication year, database source badge.

**`EmptyState.jsx`** — Centered Info icon + message + optional NavLink button. Guides users to relevant data import pages.

### Tab Components

**`GenomeHealthTab.jsx`** (INS-01, INS-03):
- Fetches `getGenomeHealthCorrelations()` on mount
- Loading: skeleton cards with pulse animation
- Empty state: links to `/meatspace/genome` for upload
- Available: summary stats bar + collapsible CategorySection components
- Each category section: icon, label, marker count, expand/collapse toggle
- Each marker card: name + gene subtitle, confidence badge mapped from marker status, description, implications, matched blood values or "No blood test on record" link, collapsible ProvenancePanel

**`TasteIdentityTab.jsx`** (INS-02, INS-03):
- Fetches `getInsightThemes()` on mount
- Empty state `no_taste_data` → links to `/digital-twin/taste`
- Empty state `not_generated` → explanation + Generate Themes button
- Available: header bar with theme count, relative time, model, Refresh button
- Theme cards in 2-column grid on lg screens with EvidenceList (collapsible)

**`CrossDomainTab.jsx`** (INS-04, INS-03):
- Fetches `getInsightNarrative()` on mount
- Not generated → explanation + Generate Narrative button
- Available: narrative text rendered paragraph-by-paragraph, generatedAt relative time, model badge
- Refresh button: calls `refreshInsightNarrative()`, shows loading spinner
- After refresh: "Show changes" button appears if `previousText` differs from `text` (trimmed comparison)
- Diff view: ReactDiffViewer with `splitView=false, useDarkTheme, hideLineNumbers` and port-* color overrides

### Page: `client/src/pages/Insights.jsx`

Four-tab page with `TABS` config array and `VALID_TAB_IDS` Set for safe param validation.

**Overview tab** (inline in Insights.jsx):
- Parallel fetches via `Promise.allSettled` — 3 domains load independently
- 3 clickable domain summary cards in responsive grid (1 col mobile, 3 cols lg)
- Each card: icon, label, ArrowRight (highlights on hover), key stat, top insight text, confidence badge, source tags
- Card content degrades gracefully when data unavailable

**Routing** (`client/src/App.jsx`):
```jsx
<Route path="insights" element={<Navigate to="/insights/overview" replace />} />
<Route path="insights/:tab" element={<Insights />} />
```
Inserted alphabetically between `instances` and `meatspace`.

**Navigation** (`client/src/components/Layout.jsx`):
```javascript
{ to: '/insights/overview', label: 'Insights', icon: Lightbulb, single: true }
```
Positioned between Instances and MeatSpace (alphabetical).
`/insights` added to `isFullWidth` check for full-height layout rendering.

## Verification Results

- Vite build: success (✓ 3388 modules transformed, 4.42s)
- All 7 component files: FOUND
- Insights.jsx: FOUND
- commits 832c561 and 4cd9ee9: FOUND

## Commits

| Task | Hash | Description |
|------|------|-------------|
| Task 1 | 832c561 | feat(04-02): install react-diff-viewer-continued and create shared insight components and tab views |
| Task 2 | 4cd9ee9 | feat(04-02): create Insights page with 4 tabs, wire App.jsx routes and Layout.jsx navigation |

## Deviations from Plan

### Auto-added Missing Feature

**[Rule 2 - Missing functionality] Added /insights to isFullWidth in Layout.jsx**
- **Found during:** Task 2
- **Issue:** Without adding `/insights` to the `isFullWidth` path check, the Insights page would have rendered in the constrained `max-w-7xl` wrapper with padding, not the full-height flex layout matching MeatSpace (which is the referenced structural pattern)
- **Fix:** Added `location.pathname.startsWith('/insights')` to the isFullWidth check
- **Files modified:** `client/src/components/Layout.jsx`
- **Commit:** 4cd9ee9

## Self-Check: PASSED

- client/src/components/insights/ConfidenceBadge.jsx: FOUND
- client/src/components/insights/ProvenancePanel.jsx: FOUND
- client/src/components/insights/EmptyState.jsx: FOUND
- client/src/components/insights/InsightCard.jsx: FOUND
- client/src/components/insights/GenomeHealthTab.jsx: FOUND
- client/src/components/insights/TasteIdentityTab.jsx: FOUND
- client/src/components/insights/CrossDomainTab.jsx: FOUND
- client/src/pages/Insights.jsx: FOUND
- commit 832c561: FOUND
- commit 4cd9ee9: FOUND

## Status

All 3 tasks complete. Tasks 1-2 committed. Task 3 (human-verify checkpoint) approved by user — all 4 insight tabs verified to render correctly with proper empty states, confidence badge color coding, and alphabetical sidebar nav positioning. Plan 04-02 fully complete.
