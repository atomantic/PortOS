# App quality assessments

The dashboard app tiles, Apps list, and each app's Overview show a quality score.
Open **Category breakdown** in Overview to see the evidence, coverage, date,
confidence, worst-finding severity and originating CoS run. This includes PortOS's
baseline app. **Configure or run scheduled audits** opens that app's Tasks tab.
Nothing calls an AI provider when a page loads or when the server starts.
The browser explicitly requests `includeQuality=true` on app reads; bare
`/api/apps` peer probes retain their existing response without assessment prose.

The Quality tab's top status card shows active and pending check counts, each
batch's current check and progress, and any reason it is waiting. Stop remaining
checks is available on each batch without opening Run checks. Stopping prevents
later checks from starting; work already queued or running can still finish.
A failed check holds its batch on the blocked task: retrying that task keeps the
batch waiting on it, while deleting it (or the 14-day failure cleanup expiring
it) stops the batch with that reason instead of running the check again. Start
the check again to rerun it. Status updates arrive through the existing maintenance events, including after
reconnecting or returning to the tab. Loading and failed reads are shown beside
a retry action rather than reported as an empty queue.

Each scheduled audit inventories first-party source roots, scans for its
category's signals, ranks the top five candidates (or all if fewer), and
validates the strongest candidates before selecting a bounded investigation.
Prefer to re-verify a slice that scored below 85 once its filed issues are
closed and their fixes are present in the checkout. When no remediated slice
needs verification, pick the highest-ranked actionable candidate. Existing
unresolved issues still affect the assessment. Low churn alone does not exempt
a severe hotspot. Dispatch injects the discovery strategy from
`server/lib/auditQuality.js`, including for customized prompts. The selected
file-only or fix mode remains authoritative.

## Scoring

Auditors assess the entire **pre-fix slice** they deep-reviewed on a scale from
0–100, where higher is healthier. The score reflects the severity, prevalence,
and reach of verified defects across all deep-reviewed paths. The defect that
led to selecting the slice is one part of that evidence.

| Score | Meaning |
| --- | --- |
| 96–100 | Exceptional quality demonstrated by inspection |
| 88–95 | Clean, healthy slice without speculative hardening |
| 85–87 | Healthy with minor polish remaining |
| 75–84 | One or two localized defects in secondary paths |
| 70–74 | Material but contained defects with wider impact than isolated secondary-path defects |
| 40–69 | Recurring or systemic defects across multiple files or in core paths |
| 0–39 | Severe core workflow breakage, data loss, or verified reachable exploits |

Worst-finding severity is a separate 0–10 value (higher is worse; 0 means no
material finding verified). An issue being filed, or one fix being made, is not
an automatic score improvement. Scores express an auditor's judgment supported
by the scan and inspection, not a certification or an exhaustive proof.

Each run rates only the **slice** it deep-reviewed (report `version: 2`:
`slice` names the top-level paths or area, `sliceScore` is its 0–100 rating).
A bounded run cannot honestly rate the whole category, and when it was asked to
(`version: 1`, a category-wide `score`) the dashboard moved with whichever
slice the agent picked — a 20-point swing between consecutive runs was normal.
Stored v1 reports stay readable; their `score` is read as that run's score.

A category's score is derived server-side: the confidence- and recency-weighted
mean of up to three qualifying runs from the last 30 days. Qualifying runs
have broad discovery coverage, medium or high confidence, and a score. High
confidence starts at weight 1 and medium at 0.5, with each weight halved every
seven days. A newer qualifying run supersedes an older slice when both share
the same canonical primary path (the first listed segment), or when the newer
slice covers all of the older slice's comma-separated segments. Paths match
exactly or by directory prefix at a slash boundary after normalizing case,
whitespace, and slash notation. Distinct slices may contribute on the same UTC
day. For each audit category and UTC day, the window
takes at most one slice-less run and gives a retained slice precedence, even
over a later slice-less run that day. Peer and release snapshot rows omit slice
names. These rows can fill otherwise eligible days when there is no qualifying
local slice or their timestamp is at least as recent as the newest qualifying
local slice in the category window's eligible set.
The pragmatic target band is **85–95**, and the healthy threshold is **85**.
The breakdown shows how many runs fed the figure and the worst severity any of
them found; the row's coverage, confidence, date, slice and summary describe the
newest run. A newer partial run does not erase a fresh scored one. With no
eligible run the row shows the newest run's own score beside its stale, partial
or low-confidence label and does not contribute. The overall score is the
rounded, equal-weight average of the contributing category scores. Broad means
the signal scan covered the entire declared eligible inventory; deep
investigation still stays bounded. Partial, stale, low-confidence, unavailable
and inapplicable assessments remain visible but do not contribute. Missing
categories do not count as 100. The contributing category count is shown beside
the score so a single good category cannot imply complete coverage. Its denominator is the number of categories that **apply** to the
repository (`applicableCategories`): a category is inapplicable when the
repository scan says so (see "Which checks" below — the app detail read runs it)
or its own fresh assessment reported `not-applicable`, unless a fresh rated
assessment shows it applies after all. Inapplicable categories stay listed at
the bottom of the breakdown with their reason; `totalCategories` keeps the
catalog size for existing readers. An app with no eligible assessments shows **not assessed**, not zero.
Database failures show **unavailable** while app management stays usable.

Broad coverage requires a signal scan of at least 95% of a nonempty eligible
inventory. A scored broad claim below that threshold is recorded as partial.

For PortOS itself, scores cover the install's `P0`-`P2` feature scope: an audit drops
areas this install marks `P3` (dormant) from its inventory, so `totalFiles`,
`scannedFiles` and **broad** coverage are measured against what remains. The
security, privacy and data-integrity audits ignore tiers and keep the whole
repository. The `.quality.json` wire shape is unchanged and carries no tier data.
Managed apps are not scoped. See [feature priorities](feature-priorities.md#audit-scope).

The completion sentinel summary contains one `QUALITY_AUDIT_JSON: {...}` line
with the versioned report described in the dispatch prompt. The parser rejects
out-of-range scores, wrong categories, contradictory coverage counts, duplicate
markers and malformed JSON. Missing/invalid output never invents a score or
replaces a previous valid measurement; the prior measurement keeps its original
date and expires normally. Assessment collection does not relax commit/PR gates.
The run's recorded start time orders measurements so delayed recovery cannot
replace newer evidence. PostgreSQL retains each run measurement and projects the
recent runs per app/category into the rolling score, locally and within the
ordinary database backup; no old runs are guessed into scores and no extra
audit batch is enabled automatically. The summary also carries one
`AUDIT_SLICE: <paths or areas deep-reviewed>` line, stored in the measurement's
`slice` column (null for runs that predate it, or the v2 report's `slice` when
the line is missing). Every audit lane preloads its last eight slices for the
app through the `audit-slice-history` task data input ("Recent audit slices")
to identify remediated slices that need re-verification and uncovered areas
for future runs. The `ux` and `module-hygiene` prompts read that block for their
route and slice choice. Peers and the `.quality.json` snapshot
receive the numeric v1 wire shape with a v2 run's `sliceScore` in `score`, so
older installs can read it. Exports set `scannedFiles` to `totalFiles` for
qualifying broad rows to satisfy older readers' equal-count rule. PostgreSQL and
the local category tooltip keep the actual counts. Slice text stays local.

### Lane health

Every audit lane also preloads what became of the issues it filed, through the
`lane-health` task data input ("Lane health", #12088). `server/lib/laneHealth.js`
computes, per lane (the audit's metric label; the shared `code-quality` label
yields to the more specific lane label beside it), the issues filed in the last
60 days and how they ended: completed, not planned (or duplicate), open, fixes
reverted (a later commit whose subject starts with `Revert` and names the
closing PR or one of its SHAs), and re-filed (a new issue citing a
`path/to/file.ext` that a closed finding of the same lane cited within 30
days). The block lists up to ten of the lane's not-planned, reverted or re-filed
titles under "Findings this lane got wrong or repeated", and the discovery
contract tells the lane not to re-file one of them without new evidence.
`services/appLaneHealth.js` reads the forge (`gh`/`glab`) and the checkout's
revert commits on request; nothing is cached or scheduled. The Quality page
shows the same numbers for every lane in a "Lane health" table
(`GET /api/apps/:id/lane-health`), noisiest lane first, so the operator can see
which lanes to retune. A truncated issue read shortens the window and says so;
a failed pull-request or commit read is named rather than read as "nothing
reverted".

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

`upgrade-rehearsal` is `data-safety`'s executed counterpart: it builds scratch
installs from migration-test fixture shapes, runs the migration runner and a
backup restore against them, and boots the result, so a failure only an
executed path shows (#6182, #12044, #12046, #12049) is caught without touching
live data. On a host with Postgres it also round-trips the database: backup,
then `restorePostgres` into a second throwaway `portos_rehearsal_<id>_test`
database made and dropped by `scripts/rehearsal-scratch-db.js` (#12906); with
no reachable Postgres it falls back to the file path and reports Postgres as
uncovered.

`over-engineering` is the removal counterpart of the proportionality check every
audit carries: other lanes may not propose a new validation layer, archive,
ledger, retry or recovery workflow, or slower process without a measured harm,
while this lane hunts the machinery already added — verification of state the
code host or CI system already owns, archives and retry layers with no reachable
failure, guards that add CI or local gate time without catching a real
regression, and docs that mandate such processes. Findings are removals or
simplifications with measured cost (CI minutes, agent turnaround, local gate
time, maintenance), plus corrected instruction text. It names no single code
host or platform, defaults to file-issues, and applies to any repository.
`simplify` owns code that nothing runs and copy-paste duplication.

Two gap lenses cover defects every page-walking and code-shape audit reads as
intentional or never reaches:

| Category | Owns | Distinct from |
| --- | --- | --- |
| `feature-completeness` | Work started and never finished: stubs and 501s reachable from the UI, permanently disabled or "coming soon" controls, UI/doc promises the code does not keep, settings nothing reads, capabilities with no entry point, server events nobody hears, deferred work with no live tracker item. Decides finish, hide, or remove | `simplify` (code with no user meaning), `ui-bugs` (finished controls that fail) |
| `workflow-recovery` | Multi-step workflows judged from the server's in-progress states: a visible resume/cancel/reattach exit after a failed follow-up step or a reload, busy refusals that carry the holder's id, waits that time out, duplicate-preventing markers kept on the server | `ui-bugs` (one click on a fresh page), `error-handling` (per-call failures), `reliability` (process restart) |

Both default to file-issues and apply to any repository. Deterministic
contract breaks in untyped client code (a call to a member the imported module
lacks, a test mock defining members the real module lacks, a browser
`confirm()`) are not left to an audit: `client/src/test/guards/ui/moduleContractConventions.test.js`
fails CI on them.
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

Daily snapshots apply the same rolling derivation to the runs known on that
date, carrying each run forward for at most 30 days. Missing or expired evidence
creates a gap. The
current day ends at the request time. Category charts include provisional
partial/low-confidence scores; the overall chart applies the same eligibility
rules as today's score. Coverage is shown with each value because adding or
losing a category can change the mean without same-category improvement.
History begins with newly reported assessments; no scores are invented for old
runs. The local detail endpoint `/api/apps/:id/quality-history?days=90` reads only
that app's measurements, including multiple local runs per UTC day, with a
30-day lookback to seed the selected range.

## Release snapshot file

A managed app can publish numeric scores into `.quality.json` at the repository
root. This file is shared history across installs: publishing unions the local
measurements with all previously published dates and categories. PostgreSQL
keeps individual local runs; the 30-day freshness rule for the current score
does not delete published history. A file is limited to 250,000 rows and 16 MiB;
publication reports `snapshot-too-large` and leaves it intact if either limit
would be exceeded.
Publish opens an immediately-merged pull request on `portos/quality-snapshot` and
does not commit the live checkout. With no local evidence, a non-empty file is
left as it is. The immediate merge takes the install's repository merge
admission (the lease a `/claim` run holds around its final verify-and-merge); while
another owner holds it, or ownership can't be verified, the PR stays open and is
handed to the pending-merge queue (GitHub) or retried on the next publish (GitLab).

The checked-in schema is v3. It stores an opaque origin fingerprint, sorted
category and enum dictionaries, and fixed rows
`[assessedAt, categoryIndex, score, worstSeverity, coverageIndex, confidenceIndex, scannedFiles, totalFiles]`.
Scores stay nullable. New `assessedAt` values retain their UTC timestamp; legacy
date-only values remain dates because their time is unknown. The file does not
store summaries, paths, app names, agent ids, or `measurementId`. For each UTC
day and category, a later known timestamp replaces an earlier known timestamp.
For older date-only records, a deterministic choice resolves same-day conflicts;
when a timestamped record is available, it is preferred. The exact order of
legacy date-only runs cannot be recovered from the file.

That file is not the peer federation payload. Peers still exchange schema v1
objects. Older installations cannot read v3 and will refuse to rewrite it as a
future format; upgrade each publisher to resume publishing its new results.

The category catalog can grow without breaking that exchange. A requester sends
the categories it can parse (`categories=` on `GET /api/apps/quality-federation`),
and the peer answering returns only those. A request without the parameter, from
an install that predates it, gets only the 25 categories that existed before the
service and data-platform lenses (`FEDERATION_LEGACY_CATEGORIES`), because such an
install rejects a whole payload over one row it cannot parse. On receipt, rows are
validated one at a time, so a malformed or unknown row costs that row, not the
peer's other evidence.

Readers accept v1 and v2 `.quality.json` and, when that file is absent, the historical
`quality-snapshot.json` name. A read never rewrites the checkout. Future schemas,
unrecognized documents (including TSV, CSV, or NDJSON), malformed snapshots, and
oversize files are not evidence and are not overwritten. Valid numeric rows for
retired or newer categories are preserved and appear as “Other / previous” in
the history selector. They do not become active checks or enter the current
overall score.

`npm run quality:snapshot` writes canonical v3 from local and previously
published evidence, including when the committed file is still v1 or v2.
`npm run quality:snapshot -- --migrate`
converts an older file or the historical filename to canonical v3 using only the
rows already stored, through the same pull request. A second publish of the
same normalized v3 snapshot does not open another pull request.

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
interface or a configured UI port, typing needs typed-language sources (including native Swift, TypeScript, Rust, Go, Java, Kotlin, C#, C/C++, Scala, Dart, and F#), dependency
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
checked again before an agent is spawned for automated work, with no provider
call: the scheduled lane skips the audit and records the execution so its
cadence advances, a maintenance run completes the step as skipped (recorded in
the run's `skipped` map, and named in its completion reason) and moves on, and
a quota-burn step is declined so the burn picks other work. Detection failures
never block: the gate only removes work it has evidence against.

An explicit choice always wins over the verdict. A manual **Run** of one task
type is not gated. The Quality tab's **Run checks** batch selections leave
inapplicable categories out, but picking a single category by name runs it
(its step carries `runInapplicableAudit`). A check the user selects in the
weekly schedule form despite its skip reason is saved with
`runInapplicableAudit: true` in that app's task metadata, so the scheduled
lane runs it; the flag is cleared when a later plan finds the check applies.

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
