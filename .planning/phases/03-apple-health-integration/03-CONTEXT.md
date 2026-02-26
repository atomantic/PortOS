# Phase 3: Apple Health Integration - Context

**Gathered:** 2026-02-26
**Status:** Ready for planning

<domain>
## Phase Boundary

Ingest Apple Health data into PortOS via Health Auto Export JSON push and bulk XML import, persist to day-partitioned storage, and display health metrics (steps, heart rate, sleep, HRV) on the MeatSpace dashboard with cross-data correlations. All Apple Health metric types are stored, but only the core four get dashboard cards. Creating insights or cross-domain analysis beyond simple correlations belongs in Phase 4.

</domain>

<decisions>
## Implementation Decisions

### Import workflow
- Two ingest paths: Health Auto Export REST push to `/api/health/ingest` AND manual file upload in the Import tab
- Bulk XML import via file picker in the existing Import tab (replace the disabled placeholder)
- XML import progress shown as progress bar with percentage + live record counts, updated via WebSocket
- Duplicate handling: silent dedup by metric type + timestamp — no user notification unless error

### Health metric scope
- Import ALL Apple Health metric types into day-partitioned storage (not just core four)
- Dashboard cards built for core four only: steps, heart rate, sleep analysis, HRV
- All other metrics stored for future use (Phase 4 correlations, future dashboard expansion)
- Apple Health nutrition data REPLACES existing daily-log nutrition for overlapping days (overwrite silently, no backup)
- One file per day with all metrics: `data/health/YYYY-MM-DD.json`

### Dashboard cards
- New "Health" tab added to MeatSpace (alongside Overview, Alcohol, Blood & Body, Genome, Lifestyle)
- Default time range: last 7 days
- Range selector buttons: 7d / 30d / 90d / 1y — consistent across all health cards
- Card layout: hero number (current/average value) at top, line chart trend below
- Sleep card: total hours as hero number, stacked horizontal bar showing deep/REM/light/awake stage proportions, time-in-bed vs actual sleep

### Health correlations
- Correlations section at the bottom of the new Health tab
- Alcohol vs HRV: dual-axis overlay chart (HRV left axis, alcohol grams right axis, same time range)
- Activity vs blood work: 30-day rolling average steps/activity leading up to each blood test date, plotted alongside key blood markers
- Each correlation chart includes an auto-generated text summary below (e.g., "HRV averages 42ms on drinking days vs 58ms on sober days (-28%)") — computed from data, no LLM
- Minimum data threshold: 14+ days before showing correlations. Show message: "Need 14+ days of data for correlations — X days so far."

### Claude's Discretion
- Chart library choice and styling details
- Exact JSON schema for day-partitioned health files
- SAX parser implementation details for XML streaming
- Health Auto Export JSON validation schema specifics
- Card grid layout and responsive breakpoints
- Color palette for chart lines and sleep stage bars
- How to handle Apple Health records with no date or invalid timestamps

</decisions>

<specifics>
## Specific Ideas

- Cards should follow the existing MeatSpace card pattern: `bg-port-card`, `border-port-border`, rounded corners
- Health Auto Export is an iOS app that can be configured to POST JSON to a REST endpoint on each sync
- The existing Import tab already has a disabled Apple Health placeholder — replace it with the real file picker
- Sleep visualization inspired by Apple Health's own sleep cards (stacked bar for stages)
- Correlation text summaries should be simple computed comparisons (averages, percentages), not AI-generated

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 03-apple-health-integration*
*Context gathered: 2026-02-26*
