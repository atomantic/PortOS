# App quality assessments

The dashboard app tiles, Apps list, and each app's Overview show a quality score.
Open **Category breakdown** in Overview to see the evidence, coverage, date,
confidence, worst-finding severity and originating CoS run. This includes PortOS's
baseline app. **Configure or run scheduled audits** opens that app's Tasks tab.
Nothing calls an AI provider when a page loads or when the server starts.
The browser explicitly requests `includeQuality=true` on app reads; bare
`/api/apps` peer probes retain their existing response without assessment prose.

All 25 scheduled audit categories first inventory first-party source roots, scan
for their category's signals, rank the top five candidates (or all if fewer),
and validate the strongest candidates before selecting a bounded investigation.
The raw worst offender may be passed over only with an explanation such as a
verified exemption or an existing issue. Existing unresolved issues still affect
the assessment. Low churn alone does not exempt a severe hotspot. Each category
has its own discovery strategy in `server/lib/auditQuality.js`; these instructions
are injected at dispatch even when an install customized its stored prompt.
File-only versus fix mode remains authoritative.

## Scoring

Auditors assess the **pre-fix** category from 0–100, where higher is healthier:

| Score | Meaning |
| --- | --- |
| 90–100 | No material defect found after broad evidence |
| 70–89 | Localized moderate debt |
| 40–69 | Significant recurring or widespread problems |
| 10–39 | Severe defects in core workflows |
| 0–9 | Pervasive critical failure |

Worst-finding severity is a separate 0–10 value (higher is worse; 0 means no
material finding verified). An issue being filed, or one fix being made, is not
an automatic score improvement. Scores express an auditor's judgment supported
by the scan and inspection, not a certification or an exhaustive proof.

The overall score is the rounded, equal-weight average of the latest eligible
category assessments: **broad** discovery coverage, medium/high confidence, and
at most 30 days old. Broad means the signal scan covered the entire declared
eligible inventory; deep investigation still stays bounded. Partial, stale,
low-confidence, unavailable and inapplicable assessments remain visible but do
not contribute. Missing categories do not count as 100. The contributing category
count is shown beside the score so a single good category cannot imply complete
coverage. An app with no eligible assessments shows **not assessed**, not zero.
Database failures show **unavailable** while app management stays usable.

The completion sentinel summary contains one `QUALITY_AUDIT_JSON: {...}` line
with the versioned report described in the dispatch prompt. The parser rejects
out-of-range scores, wrong categories, contradictory coverage counts, duplicate
markers and malformed JSON. Missing/invalid output never invents a score or
replaces a previous valid measurement; the prior measurement keeps its original
date and expires normally. Assessment collection does not relax commit/PR gates.
The run's recorded start time orders measurements so delayed recovery cannot
replace newer evidence. PostgreSQL stores the latest report per app/category,
locally and within the ordinary database backup; no old runs are guessed into
scores and no extra audit batch is enabled automatically.

## Coverage review

The existing catalog already separates conventional quality, cyclomatic
complexity, cognitive load, structural drift, module hygiene, dead code and
duplication, dependencies, typing, API contracts, runtime safety, error handling,
observability, performance, test coverage, test quality and documentation.
Security and data/upgrade safety cover their respective trust and persistence
boundaries. Product-facing coverage comes from UX (including onboarding and
successful task completion), UI bugs, console errors, accessibility,
mobile/responsive behavior and copy clarity.

This change keeps those 25 lenses rather than adding overlapping tasks.
Real-user product outcomes such as retention or satisfaction cannot be inferred
reliably from a source audit and are not fabricated into this codebase score.
A future distinct category must register both its scheduled prompt and a
repository discovery strategy; the catalog parity test prevents an auditor
without a search strategy.
