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
replace newer evidence. PostgreSQL retains each run measurement and projects the latest per app/category,
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

## Quality history

Each app Overview includes a daily UTC chart with 30-day, 90-day and one-year
ranges and an overall/category selector. Both selections are shareable URL
parameters. The expandable history table provides dates, values and coverage
without relying on color or hover. Refresh history reloads measurements.

Daily snapshots use the latest assessment available on that date, carrying it
forward for at most 30 days. Missing or expired evidence creates a gap. The
current day ends at the request time. Category charts include provisional
partial/low-confidence scores; the overall chart applies the same eligibility
rules as today's score. Coverage is shown with each value because adding or
losing a category can change the mean without same-category improvement.
History begins with newly reported assessments; no scores are invented for old
runs. The local detail endpoint `/api/apps/:id/quality-history?days=90` reads only
that app's measurements and bounds results to the last measurement per UTC day
and category, including a 30-day lookback to seed the selected range.

## Release snapshot file

A managed app can publish its recent numeric scores into `.quality.json` at the
repository root. The file is a bounded projection, not the audit history:
PostgreSQL keeps every measurement, and the file keeps one row per UTC day and
category for the same 30-day window the quality panel uses, capped at 4 MiB.
Publish opens a merge-on-green pull request on `portos/quality-snapshot` and
does not commit the live checkout. With no local evidence, a non-empty file is
left as it is.

The checked-in schema is v2. It stores an opaque origin fingerprint, sorted
category and enum dictionaries, and fixed rows
`[assessedAt, categoryIndex, score, worstSeverity, coverageIndex, confidenceIndex, scannedFiles, totalFiles]`.
Scores stay nullable. Timestamps stay ISO instants. The file does not store
summaries, paths, app names, agent ids, or `measurementId`. Same-timestamp
ordering uses a transient digest of the row, computed when the file is read.

That file is not the peer federation payload. Peers still exchange schema v1
objects. Upgrading the file does not require every peer to upgrade.

Readers accept a v1 `.quality.json` and, when that file is absent, the historical
`quality-snapshot.json` name. A read never rewrites the checkout. Future schemas,
unrecognized documents (including TSV, CSV, or NDJSON), malformed snapshots, and
oversize files are not evidence and are not overwritten. TSV is not the
canonical artifact: an append-only text log would grow without a bound and would
be harder to validate, while the database is already the history.

`npm run quality:snapshot` writes canonical v2 from local evidence, including
when the committed file is still v1. `npm run quality:snapshot -- --migrate`
converts a v1 file or the historical filename to canonical v2 using only the
rows already stored, through the same pull request. A second publish of the
same normalized v2 snapshot does not open another pull request. Duplicate rows
for one UTC day and category are rejected rather than silently dropped.

## Weekly quality schedule

The app's Quality tab carries a **Weekly quality schedule** form that configures
every applicable audit for that app in one write, instead of hand-picking a
cron expression per audit on the Schedule page. It writes ordinary per-app task-type
overrides, so every entry it creates stays editable there afterwards.

**Which checks.** Checks are pre-selected by applicability. A category an earlier
audit reported as `coverage: not-applicable` is skipped — the auditing agent read
the repository, so its ruling wins. Otherwise applicability comes from the shapes
present in the tracked files (`git ls-files`): the UI lenses (UX, accessibility,
mobile/responsive, UI bugs, console errors, UI lifecycle, copy) need a user
interface or a configured UI port, typing needs TypeScript sources, dependency
freedom needs a dependency manifest, test quality needs existing tests, and API
contracts need a route/API surface. Test **coverage** is deliberately never gated
on tests — a repository with none is the one it has the most to say about. Each
audit declares its own requirement as `requiresCapability` in
`AUDIT_DEFINITIONS` (`server/lib/auditCatalog.js`), beside its other metadata
and under the catalog's guard test; `server/services/appQualitySchedule.js` owns
the detection, and throws at load if a declared capability has no way to be
recognized. Everything is advisory: a skipped check
is still listed with its reason and can be selected by hand, and a repository that could not be
fully inventoried offers every check rather than deselecting the catalog for want
of evidence — a `git ls-files` that fails falls back to a two-level listing, which
is explicitly not evidence of absence.

**When.** The selection is spread across the week — the 25 shipped checks become
four a day — ordered so each one follows the audits `AUDIT_SUGGESTED_AFTER` names
as its predecessors, and laid out in clock order within each day so that sequence
survives. Asking for more checks per day uses fewer days; asking for fewer than
the week needs is raised to the floor, with a warning saying so. The hours are
chosen, not entered: the planner collects the weekday/hour cells already occupied
by this app's other cron-scheduled work (the CoS cadence of every type enabled for
this app plus every install-wide type whether or not it is, each perpetual drain's
recheck cadence, and the app's own cron overrides — where a per-app cadence
REPLACES the global one, as `shouldRunTask` reads it), pads each by an hour before
and two after, and places slots in the free cells nearest an even spacing. That
is what keeps an audit out of a 03:30 nightly release window. The types the plan
is about to rewrite are excluded from that collection, so re-running the form
does not treat last week's plan as an obstacle to this week's. A window cannot
wrap past midnight; asking for one is reported rather than silently collapsed.

**Delivery and the claim drain.** Each check either files issues or implements the
fix (`taskMetadata.fileIssues`). The form defaults to **each check's own catalog
default** — 11 audits ship `defaultFileIssues: false`, and a form-wide default
would silently contradict every other dispatch path — with a form-wide override
and a per-check override above it. When at least one check files issues, one claim
job — `claim-work` by default, which routes to whichever tracker the app resolves
to — is scheduled a few hours after each check as a single daily cron (with the
shipped defaults, `0 3,9,15,21 * * *`), so the issues an audit files get worked
before the next audit runs. Its placement only ever moves later **in the same
day** than the check it follows — a daily cron that wrapped past midnight would
run before every audit, not after — and the slot is dropped rather than wrapped
when the day has no room left. No claim drain is scheduled when every selected
check implements its own fixes, and Apply retires a drain an earlier plan planted
when the drain is switched off or switched to another type (recognized by the
cron shape this planner emits, so a claim cadence set by hand survives).

Nothing is written until **Apply**, which is also the whole picture: the selected
checks are enabled with their planned cron and delivery mode, and audit types
left out are disabled with their stale cron cleared. Other task types are
untouched. Endpoints: `GET /api/apps/:id/quality-schedule`,
`POST /api/apps/:id/quality-schedule/preview` (read-only re-plan), and
`POST /api/apps/:id/quality-schedule/apply`.
