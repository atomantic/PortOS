# App quality assessments

The dashboard app tiles, Apps list, and each app's Overview show a quality score.
Open **Category breakdown** in Overview to see the evidence, coverage, date,
confidence, worst-finding severity and originating CoS run. This includes PortOS's
baseline app. **Configure or run scheduled audits** opens that app's Tasks tab.
Nothing calls an AI provider when a page loads or when the server starts.
The browser explicitly requests `includeQuality=true` on app reads; bare
`/api/apps` peer probes retain their existing response without assessment prose.

All 30 scheduled audit categories first inventory first-party source roots, scan
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
coverage. Its denominator is the number of categories that **apply** to the
repository (`applicableCategories`): a category is inapplicable when the
repository scan says so (see "Which checks" below — the app detail read runs it)
or its own fresh assessment reported `not-applicable`, unless a fresh rated
assessment shows it applies after all. Inapplicable categories stay listed at
the bottom of the breakdown with their reason; `totalCategories` keeps the
catalog size for existing readers. An app with no eligible assessments shows **not assessed**, not zero.
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

Those lenses grew out of a web app with a UI, so five service and
data-platform lenses cover what a backend API, data platform, or infrastructure
repository is judged on and nothing above owns:

| Category | Owns | Distinct from |
| --- | --- | --- |
| `infrastructure` | IaC, containers, orchestration, platform manifests, CI: exposure, identity grants, secrets, pinning, resource limits and probes, state config, CI supply chain, environment drift | `security` (application code), `dependency-updates` |
| `data-integrity` | Runtime data correctness: idempotency under retry/redelivery, partial writes, lost updates, boundary validation, schema evolution of stored data, semantic corruption, pagination, retention reach, transfer checks | `data-safety` (upgrades, migrations, destructive defaults, backups) |
| `reliability` | System behavior under restart, overload and multiple instances: shutdown draining, truthful health checks, backpressure, job leasing/checkpoints, startup fragility, mixed-version deploys | `error-handling` (per-call timeouts, retries, fallbacks) |
| `privacy` | Personal/sensitive data: operational exposure, third-party minimization, API over-exposure, retention, erasure reach, real data in fixtures — under the project's documented sharing model | `security` (authz, injection) |
| `cost-efficiency` | Metered spend: repeated paid/model calls, unrequested provider work, retry multiplication, unbounded cloud scans, storage growth, over-provisioning, egress | `performance` (latency, throughput) |

All five default to file-issues. `infrastructure` is gated on deployment
configuration being present; the others apply to any repository and report
`not-applicable` when they do not. The same pass broadened five existing
prompts for services: `security` (tenant isolation, SSRF, unsafe
deserialization), `performance` (query plans, streaming, batch shape, pools,
partition pruning, cold start), `api-contract` (framework-neutral; spec drift,
breaking changes, idempotency keys, pagination bounds), `observability`
(correlation, alertable metrics, truthful health, audit trails) and
`data-safety` (backup restorability, bulk/backfill safety, retention reach).
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
Publish opens an immediately-merged pull request on `portos/quality-snapshot` and
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
oversize files are not evidence and are not overwritten. A v2 file whose
category dictionary names categories this install does not know yet — written by
a newer install after the catalog grew — is read for the rows it does know and is
never rewritten, since canonicalizing it would drop the newer rows. (Installs
predating that rule treat such a file as malformed: safe, but its scores are not
shown until they upgrade.) TSV is not the
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
audit reported as `coverage: not-applicable` within the last 30 days is skipped —
the auditing agent read the repository, so its ruling wins until it ages out
(a repository that later gains a UI gets its UI audits back). Otherwise applicability comes from the shapes
present in the tracked files (`git ls-files`): the UI lenses (UX, accessibility,
mobile/responsive, UI bugs, console errors, UI lifecycle, copy) need a user
interface or a configured UI port, typing needs TypeScript sources, dependency
freedom needs a dependency manifest, test quality needs existing tests, and API
contracts need a route/API surface, and infrastructure needs IaC, container,
deployment, process-manager, or CI configuration. Test **coverage** is deliberately never gated
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

**Dispatch-time bail-out.** The same verdict (`resolveAuditApplicability`) is
checked again before any agent is spawned, on every lane: the scheduler, a
manual Run, a maintenance run, and a quota-burn step. An inapplicable audit is
skipped with a logged reason and no provider call — the scheduled lane records
the execution so its cadence advances, a manual Run reports why nothing ran, a
maintenance run completes the step as skipped (recorded in the run's `skipped`
map) and moves on, and a quota-burn step is declined so the burn picks other
work. Detection failures never block: the gate only removes work it has
evidence against. The Quality tab's **Run checks** batch selections leave
inapplicable categories out; picking one by name still offers it (and the
server then explains the skip).

**When.** The selection is spread across the week as evenly as it allows — the
30 shipped checks become five slots a day, filled 5,5,4,4,4,4,4 so no day is
left empty — ordered so each one follows the audits `AUDIT_SUGGESTED_AFTER` names
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
