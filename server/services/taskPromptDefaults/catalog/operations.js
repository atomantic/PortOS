export const prompts = {
  'infrastructure': `[Improvement: {appName}] Infrastructure and deployment audit

Audit how {appName} is built, packaged, deployed, and run, as described by the
configuration in its repository.

Repository: {repoPath}

{modeInstructions}

Inventory the infrastructure-as-code, container, orchestration, platform, process
manager, and CI/CD files first. Judge each against the environment it actually
targets — a local development compose file is not a production manifest, and
the project's documented deployment model decides which exposure is intended.

## Hunt for

- **Exposure beyond intent** — a storage bucket, database, admin port, or
  service reachable from a wider network than the design calls for: public ACLs,
  \`0.0.0.0/0\` ingress, a load balancer in front of an internal endpoint, a
  debug port published by a container.
- **Over-broad identity** — a role, service account, token, or CI permission
  granted wildcard actions or resources, or more than the workload uses; a
  long-lived static credential where the platform offers a short-lived one.
- **Secrets in configuration** — a credential committed in a manifest, a
  variables file, a CI file, or a baked-in image layer; a secret passed where it
  lands in logs or process listings.
- **Irreproducible builds and deploys** — an unpinned base image (\`latest\`), an
  unpinned CI action or provider plugin, a build step that fetches whatever is
  newest, a deploy that depends on state only one machine has.
- **Missing runtime guardrails** — no resource requests/limits, no health or
  readiness probe where the orchestrator uses one, a container running as root
  with a writable root filesystem it does not need, no restart policy for a
  long-running service.
- **Unsafe state and data configuration** — IaC state with no locking or no
  encryption, a storage resource with no encryption at rest, no versioning or
  deletion protection on data that cannot be regenerated, no backup policy.
- **CI/CD supply-chain and injection risk** — untrusted pull-request content
  reaching a privileged workflow context, script injection through
  interpolated event fields, artifacts published without provenance.
- **Environment drift** — two environments (or a manifest and the code that
  reads it) that disagree about a port, a variable, or a resource, so the first
  deploy to the other one fails.

## CI efficiency and placement

This is part of the audit, alongside deployment safety. Trace workflow files
through their planner, runners, scripts and required-check rules; YAML alone
may hide what actually runs.

- **Measure before changing.** Sample recent representative PR/MR, merge,
  nightly and release runs, including a small change and a broad-risk change.
  Record run links/commit SHAs, sample window and count, execution frequency,
  per-job/step durations, queue time, summed runner time and the dependency
  critical path. Separate measured data from estimates and explain missing
  telemetry; estimate savings per run and at the observed cadence.
- **Select work by risk.** Inspect event triggers, path filters, affected-test
  selection and full-suite fallbacks. Check that small unrelated changes do
  not select expensive work without a reason, and relevant changes cannot skip
  required coverage. Evaluate PR/MR versus merge, nightly, release and opt-in
  placement against the failures each check catches and when detection is
  needed. Preserve required status reporting and fail closed on uncertain scope.
- **Remove demonstrated duplicate work.** Trace overlapping workflows, matrix
  jobs, installs, builds, test processes and setup. Inspect job dependencies for
  unnecessary serialization or repeated prerequisites. Distinguish runner-time
  savings from critical-path latency; more parallelism can increase total cost.
- **Reuse safely.** Check cache hits/misses, keys and invalidation, restore cost,
  artifact upload/download cost, retention and same-input build reuse. Preserve
  platform/toolchain compatibility, provenance and untrusted-PR isolation.
- **Bound obsolete work.** Inspect concurrency groups, superseded-run
  cancellation, failure cancellation, retries and timeouts. Keep release work,
  required gates and failure diagnostics reliable; do not trade waste for
  missing results or restart loops.
- **Prove test value.** Coordinate with Test Quality for redundant or vacuous
  tests: identify the stronger surviving coverage or use a bounded mutation
  probe, reverted before commit. A slow test is not a valueless test. Improve
  fixtures, imports or setup before removing useful correctness/security checks.

For a CI finding, give the measured baseline, exact selection/dependency change,
expected savings, retained risk coverage and validation. Test representative
changed-path/event cases and required-check behavior, then compare equivalent
before/after runs where available. If access prevents measurement, report that
limit; do not invent savings or weaken essential coverage to obtain green CI.

## Not yours

Application-code vulnerabilities belong to the security work; package version
bumps to dependency updates; per-call timeouts and retries to the failure-path
work; process shutdown and health-endpoint behavior inside the code to the
reliability work. Name the overlap if it is the cause, then leave it to its owner.

## The bar

Every finding names the file and line, the environment it affects, and the
concrete consequence: who can reach what, what a leaked credential grants, or
which deploy breaks, measured avoidable runner time or critical-path delay,
or a coverage/required-check failure.`,

  'reliability': `[Improvement: {appName}] Reliability and operability audit

Audit how {appName} behaves as a running service: when it starts, when it is
stopped or restarted, when load exceeds capacity, and when a deploy or upgrade
restarts the server.

Repository: {repoPath}

{modeInstructions}

Inventory the process entry points, signal handling, health endpoints, queues
and worker pools, scheduled and background jobs, and the deployment shape the
repository describes (single process, replicas, serverless, a process manager).
Judge against that shape — a single-user tool on one machine does not need
leader election or multi-instance leases, and the project's documented
deployment model is binding.

## Hunt for

- **Work dropped on shutdown that corrupts primary data** — a shutdown path that
  leaves durable user records corrupted or double-charges a paid external API.
  Restarting an interrupted background job from the beginning (or marking an
  interrupted agent/render run retryable on boot) is the preferred, simple
  design when the work is idempotent or regenerable; do not flag missing
  shutdown job checkpointing or multi-instance leases on single-install
  background jobs unless an interrupted run would corrupt primary user data or
  double-charge a paid external API.
- **Health checks that lie or amplify** — a readiness check that reports ready
  before dependencies are usable, or a liveness check that fails when a
  dependency is down, so the orchestrator restart-loops a healthy process.
- **Unbounded intake** — an in-memory queue, buffer, fan-out, or worker pool
  with no bound or backpressure, so a burst turns into memory exhaustion instead
  of rejected or delayed work.
- **Startup fragility** — a process that crashes permanently when a dependency
  is briefly unavailable at boot instead of retrying, or that starts with
  invalid configuration and fails on the first request instead of at startup.
- **Mixed-version hazards** — a message, job payload, cache entry, or stored
  record whose shape changed such that the old and new versions across an
  upgrade or peer sync misread each other.
- **Single points of failure the design did not choose** — process-local state
  (sessions, locks, rate counters, caches treated as truth) in a service that
  is explicitly deployed or scaled as multiple instances.
- **Self-inflicted overload** — synchronized timers or cron jobs that all fire
  at once, a thundering herd after a restart, a cache stampede on expiry.

## Not yours

Per-call timeouts, retry ceilings, and degraded-dependency fallbacks belong to
the failure-path work; latent code defects (missing awaits, leaks) to the
runtime-safety work; health-probe and resource-limit configuration in
manifests to the infrastructure work; missing metrics to the observability work.

## The bar

Every finding names the event (a deploy, a crash, a burst, a second instance),
the code path with \`file:LINE\`, and what is lost, duplicated, or unavailable
as a result. A resilience pattern the design does not need is not a finding.`,

  'cost-efficiency': `[Improvement: {appName}] Cost and resource-efficiency audit

Find where {appName} spends money or metered quota it does not need to: paid
API and model calls, cloud storage, query, compute, and egress.

Repository: {repoPath}

{modeInstructions}

Inventory the metered dependencies first — paid third-party APIs, AI model
providers, cloud object storage, warehouse or lake query engines, serverless
or managed compute, message services, and cross-region or internet egress —
then every call site, schedule, and retry path that reaches them.

## Estimate, never guess

A cost finding needs a rough quantity: how often the path runs, the unit cost
or what the bill scales with (calls, bytes scanned, bytes stored, GB-hours), and
how that grows with usage. State the estimate and its assumptions. "This could
be expensive" is not a finding.

## Hunt for

- **Paid calls repeated for the same answer** — a model or API call with no
  cache for identical inputs, a call re-made on every render, poll, or retry
  when the result could be reused.
- **Paid work nobody asked for** — calls on startup, background pre-generation,
  or batch fills the user did not trigger; honor the project's documented rules
  about when provider calls are allowed.
- **Retries that multiply spend** — retry loops around paid calls with no
  ceiling, or retries of errors that can never succeed.
- **Unbounded scans of metered stores** — listing an entire bucket, a query
  without a partition or date filter, \`SELECT *\` against a columnar store, a
  full-table scan where an index or predicate pushdown was available.
- **Storage that only grows** — no lifecycle rule moving cold data to a cheaper
  tier or expiring it, unbounded log or artifact retention, many small files
  where the engine charges or slows per file.
- **Over-provisioning** — always-on resources sized for peak, idle capacity
  that could scale to zero, a larger instance or model tier than the workload
  uses (a cheaper model would do the job).
- **Avoidable egress** — data moved across regions or out of the provider on a
  hot path when it could be processed in place.

## Not yours

Latency and throughput belong to the performance work, even when a fix also
saves money; resource limits in manifests belong to the infrastructure work.

## The bar

For each finding give \`file:LINE\`, the cost driver, the estimate with its
assumptions, the proposed change, and the expected saving. Reject changes that
save pennies at the cost of correctness or clarity.`,

  'upgrade-rehearsal': `[Improvement: {appName}] Upgrade and restore rehearsal

Execute {appName}'s upgrade path and its backup restore against scratch
installs, and file what breaks. Every command in this run targets a scratch
directory or scratch database you create: never the live \`data/\`, never the real Postgres
(the install's \`PGDATABASE\`, \`portos\`, \`portos_test\`), with
\`NODE_ENV=test\` in the environment and a free loopback port chosen inside the
project's documented port band (\`docs/PORTS.md\`) and checked free first, never
the running server's. The only Postgres databases you may touch are the
\`portos_rehearsal_<id>_test\` ones that \`node scripts/rehearsal-scratch-db.js
create\` makes for you; \`MEMORY_BACKEND=file\` is set only on the file-only
fallback below. Keep each scratch root and its private HOME short (under about
60 characters): a HOME nested inside another temp directory pushes the pm2
interactor socket path past the 104-byte macOS limit and the restored boot
exits with EINVAL, which reads as a restore defect but is not one. A command
whose working directory, data root, database name, or port is the live
install's is out of bounds even when it only reads.

Repository: {repoPath}

{modeInstructions}

Reading a migration shows what it intends; running it against an older shape
shows what it does. The failures that reach installs — a seed landing before
the migration that derives from it, a non-atomic write under a crash, two
runners sharing one ledger, a migration importing a live service — are
executed-path failures that no static read of one file surfaces.

## Rehearse

1. **Build a synthetic older install.** Create a disposable root the way
   \`scripts/smoke-boot.js\` (\`createSmokeRoot\`) does — marker file, private
   HOME and TMPDIR, a copy of \`data.reference/\` — then overlay two or three
   past record shapes taken from the fixtures in \`scripts/migrations/*.test.js\`:
   the oldest shape still carried, a mid-history shape, and the shape the
   newest derive-style migration reads. Seed \`data/\` from the reference copy
   (\`scripts/lib/seedDataDir.js\`, the step \`scripts/setup-data.js\` performs),
   run \`scripts/run-migrations.js\` (\`runMigrations({ rootDir })\`) against that
   root, then boot the server with \`PORTOS_DATA_ROOT\` pinned to it on your port
   and wait for \`/api/system/health\` before stopping it.
2. **Restore a backup.** Produce a snapshot from the scratch data with
   \`services/backup.js\` (\`runBackup\`, which writes the manifest), or use the
   newest snapshot already readable to you, and restore it into a second
   scratch root with \`restoreSnapshot\` — dry run first, then execute — and
   verify the manifest: every recorded file present with its recorded hash,
   nothing extra, nothing the current code refuses to read.
   If the restore refuses legacy database metadata created by this rehearsal,
   do not report that refusal as a product defect yet. \`NODE_ENV=test\` keeps
   \`pgFileFacade\` consumers on file storage even with \`MEMORY_BACKEND=postgres\`,
   so the synthetic records may not have gone through their normal import.
   Create the helper-made scratch database pair below if needed, then run the
   existing file-to-DB importer for each relevant synthetic domain (for
   example, \`server/scripts/migrateUniversesToDB.js\` for universes) against
   only the source scratch root and its \`portos_rehearsal_\` database. Check the
   importer's result and verify the synthetic rows in that scratch database.
   If imports succeed, take a fresh snapshot and repeat the dry run; retain the
   original refusal as rehearsal evidence. If an importer cannot complete,
   report that domain-facade coverage as uncovered and include its result.
3. **Round-trip Postgres.** Postgres is the primary store and its dump and
   restore are where restore defects have been found, so exercise them.
   Unless step 2 already created the pair, run
   \`node scripts/rehearsal-scratch-db.js create\` (one JSON line on stdout):
   when \`ok\` is false — no reachable Postgres, or a role that cannot create the
   base schema's extensions — use the file-only fallback below. Otherwise create
   two databases, a source and a target, and drop both with
   \`node scripts/rehearsal-scratch-db.js drop <name>\` however the run ends,
   success or failure (the helper refuses any other name; list a database you
   could not drop in the report).
   - **Back up.** With \`PGDATABASE=<source>\`, \`NODE_ENV=test\` and the source
     scratch root as the data root, run \`ensureSchema\` (\`server/lib/db.js\`),
     insert a few synthetic rows, and take the snapshot with \`runBackup\`; the
     dump (\`dumpPostgres\`) must report \`ok\`, not \`skipped\`.
   - **Restore.** In a separate process with \`PGDATABASE=<target>\` and the
     second scratch root as the data root, call \`restorePostgres\` on that
     snapshot — dry run first, then execute. A restore replays into whatever
     \`PGDATABASE\` its process holds, so print it and confirm the
     \`portos_rehearsal_\` prefix before each call.
   - **Compare.** Report row counts for every table in source and target.
     Compare application-table counts and the \`schema_migrations\` ledger;
     unexplained differences are findings. Report \`restore_receipts\` and
     \`media_assets\` counts separately with an explanation: restore receipts
     are machine-local evidence created by the target restore, and media assets
     are a rebuildable index reconstructed from authoritative files, so neither
     table is expected to have matching counts. Do not hide their observed
     counts or treat these documented differences as data loss. Any dump or
     restore status other than \`ok\` remains a finding.
4. **Boot the restored root** the same way and confirm its health endpoint;
   when step 3 ran, boot it with \`MEMORY_BACKEND=postgres\` and
   \`PGDATABASE=<target>\`. This verifies the primary store and memory
   backend; the domain facades above remain file-backed under
   \`NODE_ENV=test\`, so report their PostgreSQL boot coverage as untested.

**File-only fallback.** When no scratch database can be created, run every step
except 3 with \`MEMORY_BACKEND=file\` and \`NODE_ENV=test\`, and report the
Postgres dump, \`restorePostgres\`, and the database-backed boot as uncovered,
quoting the helper's \`error\` text — never as passing.

A repository with a different runner substitutes its documented equivalents;
one with no migration runner and no backup path reports not-applicable and
stops. Record every command with its data root and database name so the run
can be repeated.

## Hunt for

- **A migration that fails or no-ops on a real older shape** — a crash, a
  derive skipped because its output was seeded first, a result that differs
  from what the migration's own test asserts.
- **A restore that does not round-trip** — a file the manifest records but
  the restore skips, a hash mismatch, a restored record the booted server
  rejects.
- **A Postgres restore that does not round-trip** — a dump \`restorePostgres\`
  refuses, a table whose row count or the migration ledger differs between
  source and target, a restored database the booted server rejects.
- **A step the rehearsal could not reach** — one that needs a database it
  could not create stays unexercised; report it as uncovered, never as
  passing.

## Not yours

Reading migrations and schemas for missing safety nets belongs to the
data-safety work; runtime correctness of writes to the data-integrity work; a
restore endpoint's own error handling to the failure-path work. Name the
overlap when the rehearsal exposes it.

## The bar

Every finding names the step that broke (the migration file or restore
function, \`file:LINE\`), the fixture shape it ran against, the exact scratch
command, and what the next boot sees. One issue per root cause, not per
symptom; a rehearsal in which nothing breaks files nothing and says so, with
the shapes it covered.`,

  'workflow-recovery': `[Improvement: {appName}] Workflow completion and recovery audit

Find the long-running, multi-minute or paid generation workflows in {appName}
(such as full media renders, database cutovers, or multi-stage pipelines) that
can stop halfway and leave the user's record with no visible way to finish,
resume, or cancel them.

**Scope boundary:** Exclude short request-bound operations, git worktree
cleanup, and in-memory re-entrancy guards from needing 3-exit persisted
recovery ledgers or reattach UIs; a simple timeout or clean reset on server
restart is sufficient for those.

Repository: {repoPath}

{modeInstructions}

A page walk exercises one click on a fresh page. This audit exercises the
long-running sequence: a multi-stage generation or cutover started in one tab
and watched from another, or a paid render job that waits for an external
completion event. The defect lives in the gap between steps, so it is invisible
until a step fails, a tab reloads, or the server restarts.

## Work from server state, not from views

1. **Inventory long-running in-progress states the server persists for user workflows:**
   persisted statuses on user records (rendering, generating, awaiting review,
   cutover in progress) and long-running job claims that refuse new user runs
   because a multi-minute workflow is "already in progress".
2. **For each long-running user workflow state, check three exits:**
   - The page that owns the record detects the state on load and shows it in
     a visible, expanded place, not only inside a collapsed panel or another
     tab.
   - The user can resume, retry, reattach to, or cancel it from there.
   - The refusal for a busy state carries the id of what holds it (the job,
     run, or revision), and the client uses that id to reattach or link to it.
3. **For each client-orchestrated chain** (step A then step B; a kickoff that
   waits for an event; a completion callback that finalizes server state):
   - If step B throws, or the tab reloads between A and B, an exit is still
     visible after reload.
   - An error in the client's own follow-up code is not reported as a server
     failure ("save failed" after the save succeeded), and is not swallowed.
   - Every wait for an event has a timeout or a cancel, and treats an
     interrupted or failed status as settled rather than waiting on.
   - Progress markers that prevent a duplicate (committed, consumed ids,
     idempotency keys) live on the server, not only in component state.
4. **Disabled controls say why.** A control disabled because of hidden state
   names the reason and links to where the user resolves it.

When a running interface is reachable, confirm the worst candidates by driving
the workflow: interrupt it (reload mid-step, stop the server between steps) and
record what the page offers afterward. Otherwise trace the code on both sides
and say that is what you did; a state with no exit is proven by reading the
code that enters it and every path that leaves it.

## Not yours

Short request-bound operations, git worktree cleanup, and in-memory re-entrancy
guards do not need persisted recovery ledgers or reattach UIs. Per-call timeouts
and retries belong to the failure-path work; process restart and shutdown
draining to the reliability work; duplicate writes under redelivery to the
data-integrity work; a feature that was never finished to the
incomplete-feature work. Name the overlap if it is the cause.

## The bar

Every finding names the in-progress state and where it is set (\`file:LINE\`),
the step that can fail or be interrupted (\`file:LINE\`), the sequence that
strands it, and what the user sees afterward. Prefer a fix in the shared
primitive (the job-tracking hook, the refusal shape) over one workflow at a
time when several share the cause.`,
};
