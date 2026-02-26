---
phase: 03-apple-health-integration
plan: "03"
subsystem: ui
tags: [react, recharts, health, meatspace, charts, correlation]

# Dependency graph
requires:
  - phase: 03-01
    provides: Apple Health API endpoints (getAppleHealthMetrics, getAppleHealthCorrelation)
provides:
  - MeatSpace Health tab with four metric cards (steps, heart rate, sleep, HRV)
  - Time range selector (7d/30d/90d/1y) controlling all health cards
  - AlcoholHrvCorrelation dual-axis chart with computed text summary
  - ActivityBloodCorrelation chart with 30-day rolling average steps vs blood markers
  - Deep-linkable /meatspace/health route
affects: [04-health-insights, any phase adding MeatSpace tabs]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Hero number + trend chart card pattern for metric visualization
    - Parallel data fetching with Promise.all on range change
    - Computed correlation text summaries (no LLM, pure data math)
    - Minimum data threshold guard (14-day check) before rendering correlations
    - Stacked horizontal BarChart for sleep stage proportions

key-files:
  created:
    - client/src/components/meatspace/StepsCard.jsx
    - client/src/components/meatspace/HeartRateCard.jsx
    - client/src/components/meatspace/SleepCard.jsx
    - client/src/components/meatspace/HrvCard.jsx
    - client/src/components/meatspace/tabs/HealthTab.jsx
    - client/src/components/meatspace/AlcoholHrvCorrelation.jsx
    - client/src/components/meatspace/ActivityBloodCorrelation.jsx
  modified:
    - client/src/components/meatspace/constants.js
    - client/src/pages/MeatSpace.jsx

key-decisions:
  - "Correlation text summaries computed from data math (avgHrv, percentDiff) not LLM calls — keeps latency at zero"
  - "Minimum 14-day data threshold guard prevents misleading correlations with sparse data"
  - "Task 1 used placeholder div for correlations to avoid broken imports during two-task build"
  - "Health tab icon uses Stethoscope (lucide-react) — Activity and HeartPulse already used by other tabs"

patterns-established:
  - "Two-step card build pattern: card with placeholder (Task 1) then correlation wiring (Task 2) to prevent build failures"
  - "Dark theme chart tokens: CartesianGrid stroke=#2a2a2a, tick fill=#9ca3af fontSize=11, Tooltip bg=#1a1a1a"

requirements-completed: [HLT-05, HLT-06]

# Metrics
duration: ~15min
completed: 2026-02-26
---

# Phase 3 Plan 03: MeatSpace Health Tab Summary

**Four recharts-powered health metric cards (steps, heart rate, sleep, HRV) with time range selector and dual-axis alcohol/HRV and activity/blood correlation charts wired into MeatSpace at /meatspace/health**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-02-26T23:20:00Z
- **Completed:** 2026-02-26T23:37:11Z
- **Tasks:** 3 (2 auto + 1 checkpoint:human-verify)
- **Files modified:** 9

## Accomplishments

- Four health metric cards (StepsCard, HeartRateCard, SleepCard, HrvCard) each with hero number and recharts trend chart
- SleepCard uses stacked horizontal BarChart for sleep stage proportions (deep/rem/core/awake)
- HealthTab fetches all metrics in parallel via Promise.all on range change (7d/30d/90d/1y)
- AlcoholHrvCorrelation dual-axis ComposedChart with auto-computed text summary (avgHrvDrinking vs avgHrvSober)
- ActivityBloodCorrelation shows 30-day rolling average steps alongside blood test markers
- Both correlation charts guard with 14-day minimum threshold message for sparse data
- Health tab wired into MeatSpace.jsx at case 'health' and added to constants.js TABS with Stethoscope icon

## Task Commits

Each task was committed atomically:

1. **Task 1: Create four health metric cards and HealthTab container** - `11cc0ea` (feat)
2. **Task 2: Create correlation charts and wire Health tab into MeatSpace** - `81bd182` (feat)
3. **Task 3: Verify Health tab and correlation charts** - checkpoint:human-verify, approved by user

## Files Created/Modified

- `client/src/components/meatspace/StepsCard.jsx` - Steps trend card with hero average + LineChart, stroke #3b82f6
- `client/src/components/meatspace/HeartRateCard.jsx` - Heart rate card with avg BPM + LineChart, stroke #ef4444
- `client/src/components/meatspace/SleepCard.jsx` - Sleep card with avg hours hero + stacked horizontal BarChart for stages
- `client/src/components/meatspace/HrvCard.jsx` - HRV trend card with avg ms + LineChart, stroke #22c55e
- `client/src/components/meatspace/tabs/HealthTab.jsx` - Health tab container with range selector, card grid, and correlation section
- `client/src/components/meatspace/AlcoholHrvCorrelation.jsx` - Dual-axis ComposedChart with computed text summary and 14-day threshold
- `client/src/components/meatspace/ActivityBloodCorrelation.jsx` - 30-day rolling average steps vs blood markers with threshold guard
- `client/src/components/meatspace/constants.js` - Added Health tab with Stethoscope icon between Genome and Lifestyle
- `client/src/pages/MeatSpace.jsx` - Added HealthTab import and case 'health' in renderTabContent

## Decisions Made

- Correlation text summaries computed via pure data math (no LLM) — zero latency, deterministic output
- 14-day minimum threshold guard prevents misleading correlations when data is sparse
- Two-task build pattern: Task 1 used a placeholder comment div for correlations to avoid broken imports before Task 2 created the files
- Stethoscope icon chosen for Health tab — Activity already used by Overview, HeartPulse already used by Blood & Body

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None — build passed cleanly after both tasks, server tests passed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Health tab is live at /meatspace/health and deep-linkable
- All four metric cards and both correlation charts are wired to Phase 03-01 API endpoints
- Phase 04 (health insights/correlations) can extend AlcoholHrvCorrelation and ActivityBloodCorrelation with additional scientific correlation rules
- No blockers for next phase

## Self-Check: PASSED

- FOUND: client/src/components/meatspace/StepsCard.jsx
- FOUND: client/src/components/meatspace/HeartRateCard.jsx
- FOUND: client/src/components/meatspace/SleepCard.jsx
- FOUND: client/src/components/meatspace/HrvCard.jsx
- FOUND: client/src/components/meatspace/tabs/HealthTab.jsx
- FOUND: client/src/components/meatspace/AlcoholHrvCorrelation.jsx
- FOUND: client/src/components/meatspace/ActivityBloodCorrelation.jsx
- FOUND: commit 11cc0ea (Task 1)
- FOUND: commit 81bd182 (Task 2)

---
*Phase: 03-apple-health-integration*
*Completed: 2026-02-26*
