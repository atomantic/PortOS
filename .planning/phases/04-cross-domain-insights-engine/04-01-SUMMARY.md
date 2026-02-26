---
phase: 04-cross-domain-insights-engine
plan: 01
subsystem: insights-backend
tags: [insights, genome, blood-tests, taste-identity, llm, rest-api]
dependency_graph:
  requires:
    - server/services/genome.js (getGenomeSummary)
    - server/services/meatspaceHealth.js (getBloodTests)
    - server/services/taste-questionnaire.js (getTasteProfile)
    - server/services/providers.js (getActiveProvider, getProviderById)
    - server/services/appleHealthQuery.js (getCorrelationData)
    - server/lib/curatedGenomeMarkers.js (MARKER_CATEGORIES)
    - server/lib/fileUtils.js (PATHS, ensureDir, readJSONFile)
    - server/lib/errorHandler.js (asyncHandler)
  provides:
    - server/services/insightsService.js
    - server/routes/insights.js
    - /api/insights/* (5 endpoints)
    - client insights API (5 functions)
  affects:
    - server/index.js
    - server/lib/validation.js
    - client/src/services/api.js
    - data/insights/ (cache directory)
tech_stack:
  added: []
  patterns:
    - Cache-first reads with graceful degradation ({ available: false, reason })
    - callProviderAISimple inline LLM call pattern (replicated from taste-questionnaire.js)
    - Rule-based genome-blood correlation (no LLM, deterministic)
    - previousText diff support for narrative versioning
key_files:
  created:
    - server/services/insightsService.js
    - server/routes/insights.js
  modified:
    - server/lib/validation.js
    - server/index.js
    - client/src/services/api.js
    - .changelog/v1.14.x.md
decisions:
  - Correlation strength labels use "Evidence" and "Risk Marker" language — never causation language — per INS-01 requirement
  - CONFIDENCE_FROM_STATUS maps marker status to human-readable confidence level with color
  - CATEGORY_BLOOD_MAP covers 6 categories (cardiovascular, iron, methylation, diabetes, thyroid, nutrient); other categories get empty matchedBloodValues
  - Cache files written to data/insights/themes.json and data/insights/narrative.json using ensureDir before first write
  - narrativeRefresh preserves previousText and previousGeneratedAt for client-side diff
  - LLM generation functions return { available: false, reason } (not throw) when provider unavailable or no data
  - insightRefreshSchema uses optional() fields (not .optional().default(undefined)) to avoid presence side effects
metrics:
  duration: 174s
  completed: 2026-02-26
  tasks_completed: 2
  files_created: 2
  files_modified: 4
---

# Phase 4 Plan 1: Insights Engine Backend Summary

**One-liner:** Cross-domain insights engine with genome-health correlation (rule-based), LLM taste-identity themes, and cross-domain narrative — all served via 5 REST endpoints with cache-first graceful degradation.

## What Was Built

### `server/services/insightsService.js`

Five exported functions forming the insights engine core:

1. **`getGenomeHealthCorrelations()`** — Pure rule-based. Loads genome markers, filters `not_found` entries, groups by `MARKER_CATEGORIES` key, looks up blood analyte values using `CATEGORY_BLOOD_MAP`, attaches `CONFIDENCE_FROM_STATUS` label per marker. Returns `{ available: true, categories, totalMarkers, matchedMarkers, sources }`. Degrades to `{ available: false, reason: 'no_genome' }` if genome not uploaded.

2. **`getThemeAnalysis()`** — Cache-first. Reads `data/insights/themes.json`. Returns `{ available: false, reason: 'not_generated' }` if no cache.

3. **`generateThemeAnalysis(providerId, model)`** — LLM generation. Gets completed taste profile sections, builds analytical third-person prompt requesting 3-5 theme objects (title, narrative, evidence array, strength). Strips code fences, parses JSON, persists to `data/insights/themes.json`.

4. **`getCrossDomainNarrative()`** — Cache-first. Reads `data/insights/narrative.json`. Returns `{ available: false, reason: 'not_generated' }` if no cache.

5. **`refreshCrossDomainNarrative(providerId, model)`** — LLM generation with diff support. Gathers genome category summaries, taste theme titles, and Apple Health availability. Builds second-person prompt. Persists to `data/insights/narrative.json` with `previousText` and `previousGeneratedAt` from existing cache for client-side diff rendering.

### `server/routes/insights.js`

Five REST endpoints, all wrapped in `asyncHandler`:

| Method | Path | Handler |
|--------|------|---------|
| GET | /genome-health | getGenomeHealthCorrelations() |
| GET | /themes | getThemeAnalysis() |
| POST | /themes/refresh | generateThemeAnalysis(body.providerId, body.model) |
| GET | /narrative | getCrossDomainNarrative() |
| POST | /narrative/refresh | refreshCrossDomainNarrative(body.providerId, body.model) |

POST routes validate body with `insightRefreshSchema` (optional providerId, optional model).

### `server/lib/validation.js`

Added `insightRefreshSchema`:
```js
export const insightRefreshSchema = z.object({
  providerId: z.string().optional(),
  model: z.string().optional()
});
```

### `server/index.js`

Mounted `insightsRoutes` at `/api/insights` — inserted alphabetically between `/api/instances` and `/api/jira`.

### `client/src/services/api.js`

Added `// Insights` section with 5 exported functions:
- `getGenomeHealthCorrelations()`
- `getInsightThemes()`
- `refreshInsightThemes(providerId, model)`
- `getInsightNarrative()`
- `refreshInsightNarrative(providerId, model)`

## Verification Results

- All 5 insightsService.js functions exported and importable
- All 5 routes registered in insights router
- `insightRefreshSchema` exported from validation.js
- `getThemeAnalysis()` returns `{ available: false, reason: 'not_generated' }` gracefully
- `getCrossDomainNarrative()` returns `{ available: false, reason: 'not_generated' }` gracefully
- Route mount confirmed in index.js at `/api/insights`
- Client API functions confirmed in api.js

## Commits

| Task | Hash | Description |
|------|------|-------------|
| Task 1 | 0f20b69 | feat(04-01): create insightsService.js with genome-health correlation engine and LLM analysis functions |
| Task 2 | e4dc2be | feat(04-01): create insights routes, Zod validation, mount in index.js, add client API functions |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- server/services/insightsService.js: FOUND
- server/routes/insights.js: FOUND
- server/lib/validation.js (insightRefreshSchema): FOUND
- server/index.js (/api/insights mount): FOUND
- client/src/services/api.js (5 insight functions): FOUND
- commit 0f20b69: FOUND
- commit e4dc2be: FOUND
