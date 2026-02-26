# Phase 5: Unified Search (Cmd+K) - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Global search overlay accessible from any page via Cmd+K / Ctrl+K. Fans out keyword queries server-side to all data sources (Brain, Memory, Apps, History, Health, etc.), displays categorized results with icons and snippets, and navigates to deep-linked locations on click. Semantic/vector search and search history are deferred to v2.

</domain>

<decisions>
## Implementation Decisions

### Overlay appearance
- Spotlight-style centered modal (like macOS Spotlight / VS Code Cmd+P)
- ~800px wide for comfortable snippet display
- Semi-transparent dark backdrop — click backdrop to dismiss
- Subtle fade+scale animation (~150ms) on open/close

### Result presentation
- Results grouped by source under section headers (Brain, Memory, Apps, Health, etc.)
- Top 3 results per source category, with "Show more" to expand
- Each result row: source icon + title (bold) + 1-line text snippet with keyword highlighted
- Categories with zero results are hidden entirely

### Search interaction
- Full keyboard navigation: arrow keys move highlight, Enter navigates, Escape closes
- Search-as-you-type after 2+ characters with 300ms debounce
- Before typing: empty results area with placeholder hint ("Search Brain, Memory, Health...")
- No-results state: subtle centered "No results for 'xyz'" message

### Claude's Discretion
- Deep-link navigation behavior (close overlay on click, scroll-to-item, cross-page handling)
- Loading/spinner state while results are fetching
- Exact source icons per category
- Result highlight/hover styling
- Which existing service search functions to fan out to

</decisions>

<specifics>
## Specific Ideas

- Overlay should feel like Raycast/Spotlight — fast, focused, keyboard-first
- Source grouping similar to Raycast's category sections with clear headers
- Keep it simple for v1 — no filters, no tabs, just type and find

</specifics>

<deferred>
## Deferred Ideas

- Semantic/vector search layered on keyword search (SRC-05, v2)
- Recent searches and search history (SRC-06, v2)
- Quick actions or recent items shown before typing
- Source filtering tabs or toggles

</deferred>

---

*Phase: 05-unified-search*
*Context gathered: 2026-02-26*
