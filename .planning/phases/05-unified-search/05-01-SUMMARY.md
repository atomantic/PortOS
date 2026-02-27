---
phase: 05-unified-search
plan: 01
subsystem: api
tags: [search, fan-out, bm25, express, zod, promise-allsettled]

# Dependency graph
requires:
  - phase: 03-apple-health-integration
    provides: appleHealthQuery.listDayFiles referenced for health source adapter
  - phase: 04-cross-domain-insights-engine
    provides: memory BM25 index and brainStorage services used as search sources

provides:
  - fanOutSearch engine in server/services/search.js
  - GET /api/search?q= route with Zod validation
  - searchQuerySchema in server/lib/validation.js
  - search(q) client API function in client/src/services/api.js

affects: [05-02-search-overlay-ui]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Promise.allSettled for fault-isolated fan-out search across multiple data sources
    - extractSnippet helper for keyword-centered 100-char excerpts with ellipsis trimming
    - Source adapters return { id, label, icon, results } with results as { id, title, snippet, url, type }
    - Sources with zero results filtered from response before return

key-files:
  created:
    - server/services/search.js
    - server/routes/search.js
  modified:
    - server/lib/validation.js
    - server/index.js
    - client/src/services/api.js

key-decisions:
  - "Health adapter is synchronous (no I/O) — searches known metric names + display aliases in-memory, no file reads needed"
  - "Memory adapter uses Promise.allSettled internally to isolate BM25 failures from memory index failures"
  - "Brain adapter fans out to all 5 sub-types (inbox/people/projects/ideas/links) via Promise.allSettled and aggregates into one source block"
  - "fanOutSearch returns only non-empty sources — zero-result sources are omitted from the response"

patterns-established:
  - "Search route pattern: asyncHandler + validateRequest(searchQuerySchema, req.query) + service call"
  - "Source adapter contract: async fn(query) => { id, label, icon, results[] } where results are { id, title, snippet, url, type }"

requirements-completed: [SRC-02, SRC-03]

# Metrics
duration: 8min
completed: 2026-02-26
---

# Phase 5 Plan 01: Unified Search — Server Foundation Summary

**Fan-out keyword search engine with 5 source adapters (Brain/Memory/Apps/History/Health), GET /api/search?q= route, Zod schema, and client search() function**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-02-26T23:54:25Z
- **Completed:** 2026-02-27T00:01:05Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Built `server/services/search.js` with `fanOutSearch()` engine and 5 source adapters using Promise.allSettled for complete fault isolation
- Implemented `extractSnippet()` helper that finds keyword match position and extracts a ~100-char window with `...` padding
- Created `GET /api/search` route with Zod min-2/max-200 query validation and structured `{ query, sources }` response
- Added `search(q)` client API function to `client/src/services/api.js` for use by the overlay component in Plan 05-02

## Task Commits

Each task was committed atomically:

1. **Task 1: Create search service with source adapters and fan-out engine** - `226b850` (feat)
2. **Task 2: Create search route, Zod schema, register in index.js, and add client API function** - `ea077ee` (feat)

**Plan metadata:** (docs commit — see state update)

## Files Created/Modified
- `server/services/search.js` - Fan-out search engine with 5 source adapters and extractSnippet helper
- `server/routes/search.js` - GET /api/search route handler with asyncHandler + Zod validation
- `server/lib/validation.js` - Added searchQuerySchema (q: min 2, max 200, trimmed)
- `server/index.js` - Registered searchRoutes at /api/search (alphabetically after /api/screenshots)
- `client/src/services/api.js` - Added search(q) function using encodeURIComponent

## Decisions Made
- Health adapter has no I/O — it matches keyword against a static list of known metric names and display aliases (e.g., "step_count" / "Steps"), making it synchronous and zero-latency
- Memory adapter guards both BM25 and memory index calls with Promise.allSettled internally, returns empty results if either fails
- Brain adapter fans out to 5 sub-sources (inbox/people/projects/ideas/links) via Promise.allSettled and merges into a single "Brain" source block, takes first 5 across all sub-types
- `fanOutSearch` filters out sources with zero results before returning, keeping the response lean

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `GET /api/search?q=` is live and ready for the overlay UI component in Plan 05-02
- `search(q)` client function available in `api.js` for immediate import
- Response shape `{ query, sources: [{ id, label, icon, results: [{ id, title, snippet, url, type }] }] }` is stable
- All 5 source adapters operational; Health is always synchronous, others degrade gracefully on empty data

---
*Phase: 05-unified-search*
*Completed: 2026-02-26*
