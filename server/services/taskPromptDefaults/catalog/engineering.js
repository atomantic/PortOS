export const prompts = {
  'observability': `[Improvement: {appName}] Logging and observability audit

Audit how {appName} logs events, reports runtime failures, and surfaces
diagnostics.

Repository: {repoPath}

{modeInstructions}

Hunt specifically for:

- **Silent failure swallowing** — a \`catch\` that discards the error with no
  log and no telemetry, so the failure is invisible in production.
- **Log noise** — a polling loop, socket frame handler, or hot render path
  emitting a line every tick, burying the errors that matter.
- **Missing error context** — an error logged with only \`err.message\`, with no
  task id, record id, route, or stack to reproduce from.
- **Wrong level** — a fatal runtime error logged through the equivalent of
  \`console.log\` instead of the project's error path.
- **Uninstrumented workflows** — a multi-step background pipeline or agent
  transition with no progress logging, so a stuck job looks identical to a slow
  one.
- **Lost correlation** — a request, job, or message id that is not carried
  across a service, queue, or thread boundary, so one failure's log lines cannot
  be joined together.
- **Nothing to alert on** — a critical path (request latency and error rate,
  queue depth or consumer lag, job success and duration, data freshness) with no
  metric or countable signal, so a degradation is only discovered by a user.
- **Health signals that do not reflect health** — a status or health endpoint
  that reports OK while a dependency the service needs is down, or that never
  reports degraded states.
- **No trail for consequential actions** — destructive, administrative, or
  permission-changing operations with no record of who did what and when,
  where the domain needs one.

Match the project's scale: a single-process tool needs good logs and a truthful
status view, not a tracing stack. For each finding, name the catch block,
uninstrumented step, or missing signal and state the operational blind spot it
creates: what breaks, and how long before anyone notices.`,

  'better-structural-drift': `[Improvement: {appName}] Structural drift and sources of truth

Find where {appName} keeps the same fact in two places, so the two can disagree
— and where one of them has silently drifted already.

Repository: {repoPath}

{modeInstructions}

## Hunt for

1. **Derived artifacts committed as a second source of truth** — generated
   catalogs, manifests, snapshots, indexes, or caches copying facts already
   available from source. Ask first whether the artifact needs to exist at all:
   a derivation that is deterministic, cheap, and reads only inputs every
   install already ships belongs in memory, derived on first use and cached for
   the process.
2. **Position-keyed records** — any committed artifact addressing what it
   describes by line number, column, byte offset, array index, or insertion
   order. These are rewritten by edits that change nothing, so their drift tests
   fire on innocent commits, parallel branches regenerate them differently, and
   rebases conflict on them. Records must be keyed by the declaring file plus
   the semantic identity of what it declares.
3. **Manually synchronized registries and mirrors** — the same routes, events,
   commands, schemas, feature flags, constants, or capabilities declared in more
   than one place, held together by a comment ("keep in sync with…", "mirrors…",
   "must match…") or by a drift test whose only remedy is for a human to copy
   one side onto the other.
4. **Incidental-layout coupling** — tests, fixtures, or runtime behavior
   depending on source line numbers, array positions, object key insertion
   order, or filenames that are not part of the product contract.
5. **Behaviour twins** — two code paths that implement the same concern for
   different callers (an operator lane and an unattended lane, a modal and a
   drawer, a direct call and a queued one) where a guard, redaction, cleanup or
   contract check exists in one and not the other. Prove it with \`git log -S\`
   on the fix that reached one side; the resolution is one shared primitive or
   a parity test, never a copied patch.

## Prove the drift, do not assert it

A duplicate that has never diverged and is cheap to keep aligned may be correct.
Evidence that turns a suspicion into a finding:

\`\`\`bash
# Regeneration-only churn: commits that touched ONLY the artifact
git log --oneline -- <artifact> | wc -l
# One-sided history is the drift proof: a fix that landed in one copy, not both
git log -S'<symbol>' --oneline -- <fileA>
git log -S'<symbol>' --oneline -- <fileB>
\`\`\`

A symbol present in one copy's history and absent from the other's means a fix
reached one side only. Identical same-commit history across both means recurring
manual churn — weaker, but still a cost you can count. Then diff the present-day
bodies and say whether they have already drifted.

## Legitimate second copies — do not file these

- Distribution genuinely lacks the source at the point of use.
- Derivation is expensive, nondeterministic, or needs inputs an install lacks.
- Reproducible releases require frozen bytes.
- A cross-runtime mirror the project's layering rules forbid collapsing (a
  browser bundle that must not import a server-only module), where a parity test
  already guards it mechanically.
- Vendored or third-party trees maintained upstream.

When a copy is legitimate, the finding may still be that the parity check is
missing: a hand-synced pair with NO mechanical guard is a defect even when the
duplication itself is justified.

## For each finding

Name the producer, every consumer, the evidence above, and the decided
resolution — derive at first use, re-export from the declaring module, generate
with a content-addressed key, or add the mechanical parity check. Say what
remains behind and what compatibility obligation it carries.`,

  'better-runtime-safety': `[Improvement: {appName}] Runtime safety and async correctness

Read {appName}'s source for latent defects — the ones already in the code that
simply have not been triggered yet.

Repository: {repoPath}

{modeInstructions}

## Hunt for

- **Missing \`await\` and floating promises** — an async call whose result nobody
  waits for, so its failure is invisible and its effect lands after the caller
  moved on. Check whether SOMEONE awaits the returned promise before calling it
  a bug.
- **Rejections with no owner outside the request lifecycle** — timers,
  intervals, event listeners, socket handlers, child-process callbacks, and
  queue workers. Nothing holds the promise these return, so a rejection escapes
  unhandled and can take the whole process down.
- **Unguarded access** — a property read, index, or destructure on a value a
  real code path can deliver as null, undefined, or empty.
- **Sentinel confusion** — code letting *absent*, *failed to load*, and
  *legitimately empty* collapse into one value. Truthiness on a length, or a
  bare \`||\` fallback, conflates "nothing there" with "we never looked" — so a
  cleared value silently reverts, or a cached empty result is re-fetched forever.
- **Shared-state races in memory** — check-then-act sequences on module-level
  state whose condition can change before the act, and handlers mutating
  module-level state concurrently.
- **Resource leaks** — caches and maps that only grow, listeners and
  subscriptions never removed, streams, connections, or handles never closed on
  the error path.
- **Unbounded reads** — a query, directory walk, or fetch with no limit over a
  set that grows with usage.
- **Wrong operator or off-by-one** — a boundary comparison, slice bound, or loop
  condition provably off by one for a stated input.
- **Process-killing calls in reusable code** — exiting the process from a module
  a library or test can import.
- **Cross-module contract breaks in untyped code** — where no type checker
  runs, a call to a member the imported object does not define, a named import
  the module does not export, or an argument at a position the callee never
  reads (an options object a wrapper silently drops). Read the callee's actual
  export, not its name. A class of these across many call sites is one
  finding, and its fix includes a mechanical guard test.

## Not yours — name the overlap and move on

Performance shapes (N+1 queries, quadratic loops, missing indexes) belong to the
performance work; lost updates and read-modify-write races on a persisted record
or file to the data-integrity work; retries, timeouts, fallbacks, and health
checks to the error-handling work; swallowed errors and missing log context to the
observability work; UI resource lifetimes and state correctness to the UI
lifecycle and state work. Mentioning an overlap is fine; filing it twice is noise.

## The bar: a failure scenario, not a code shape

Every finding must state concrete inputs or state, the sequence reaching the
defect, and the observable outcome — a crash, a wrong value, a lost write, a
leak growing without bound. Read the callers and at least 30 surrounding lines
before flagging: a guard may live one frame up, and framework idioms routinely
handle what looks unhandled. If you cannot construct the scenario, you do not
have a finding.

Cite \`file:LINE\` for the defect AND for the caller that reaches it.`,

  'better-test-quality': `[Improvement: {appName}] Test quality audit

Audit {appName}'s existing tests for ones that cannot fail, prove nothing, or
duplicate a stronger test. Missing coverage is separate work — you own the tests
that already exist.

Repository: {repoPath}

{modeInstructions}

A suite's value is the regressions it catches, not its size. A vacuous test is
worse than no test: it costs CI time on every run and reports safety that is not
there.

## Hunt for

**Vacuous — the test passes no matter what the code does:**

- Assertions against a mocked return value, so the test proves the mock works.
- A test that mocks the very module it is testing.
- A test re-implementing the logic under test instead of importing it, so it
  agrees with itself while the real code regresses.
- Assertions that cannot fail: a literal compared to itself, a type check on an
  object literal, a bare truthiness check on an always-truthy value.
- A named test with no meaningful assertion, or with its assertions commented
  out.

**Weak — the test passes for the wrong reason:**

- Assertions on implementation details: internal state, private helpers, call
  counts, or a call order the contract does not promise.
- A test that would still pass if the function returned null, undefined, or an
  empty collection.
- An integration test mocked so heavily it only exercises glue.
- Only the happy path, where the error and boundary paths carry the risk.
- Cases sharing mutable state, so they pass only in one order.
- A guard or safety test that never probes the bypass — it asserts the guard
  allows the good case but never proves it blocks the bad one.
- Mocks that drift from the module they replace — a mock defining a member,
  export, or response shape the real module does not have, so the suite passes
  against a contract production code cannot meet. Compare each widely used
  mock's keys with the real export; one drifted mock repeated across many
  suites is one finding.

**Redundant — the test is real but earns nothing:**

- It duplicates an assertion a higher-level test already makes.
- Table-driven permutations that all prove the same single outcome.
- A unit test on a deterministic helper already exercised through a stable
  caller, where the helper and every caller would have to change together
  anyway.

## Prove it before you file it

The rigorous check is a **mutation probe**: change the code under test so it is
wrong — invert a condition, return a constant, delete a guard — and run the
test. If it still passes, you have proof, and the finding must quote what you
changed and what still passed. Revert the mutation before moving on; never
commit one. For a redundant test, name the stronger test that survives it.

For each finding, also name the regression the test was presumably meant to
catch, and whether that regression is still caught after your proposed change.

## Deletion is a valid outcome

Removing a vacuous or redundant test is an improvement, and the resulting drop
in test count or line coverage is not a regression — say so plainly in the
finding so a reviewer does not read the deletion as lost safety. When a weak
test guards behavior that genuinely matters, strengthen it at the highest
practical public boundary instead of deleting it.

Cite the test file and case name with \`file:LINE\`, the source it claims to
cover, and the probe result.`,

  'better-dev-environment': `[Improvement: {appName}] Development environment audit

Audit what {appName}'s development loop does to the machine it runs on: the test
suites, dev server, watchers and pre-push checks. The product can be correct and
every test meaningful while each run quietly leaves something behind. On a machine where agents run the suites many times a day, one leaked
directory per run becomes tens of thousands.

Repository: {repoPath}

{modeInstructions}

## Measure, do not only read

A static read of one test file cannot see accumulation — you have to observe it.
Before and after ONE run of the project's own test commands (a representative
subset is enough — a per-run leak shows up in a single run) and, where safe, one
start of its dev server stopped after about 60 seconds, snapshot:

- entries in the system temp directory, counted by name prefix;
- child processes the run started, and ports left listening;
- untracked or modified files in the checkout (\`git status --porcelain\`);
- the modification times of user-level files the run could touch: the
  project's git config, home-directory dotfiles and caches it names.

Run only commands the repository documents for development. Never run a suite
against real user data or a production database, never start a second copy of
a long-running service on its production port, and follow the repository's
instructions about which databases and directories tests may use. Do not
delete anything that existed before your run — report its count and the safe
cleanup command instead. After recording the measurement, stop every process and
remove every temp entry YOUR run created (the after-minus-before set), so the
audit does not add the leaks it reports.

## Hunt for

- **Leaks per run** — temp directories or files a test or helper creates and
  never removes; child processes, servers, or watchers still alive after the
  suite exits; ports left bound; handles that keep the runner from exiting.
- **Writes outside the sandbox** — a test or script that mutates the real
  checkout's git config, the user's home directory, a global cache, the real
  database, or a shared directory other checkouts also use.
- **Accumulation** — caches, logs, build output, worktrees, or downloaded
  artifacts that only grow during development and have no cleanup path.
- **Idle and watcher cost** — a dev server or watcher that watches directories
  that churn (data, temp, dependency trees), a polling loop, or CPU and disk
  activity when nothing is being edited.
- **Parallel-checkout collisions** — fixed ports, fixed temp paths, or a shared
  database that break when two checkouts or agents run the suite at once.
- **Slow loop** — the slowest suites and what makes them slow (real sleeps,
  real network, repeated expensive setup), read from that same run's reporter
  output rather than a second run.

## Prefer a guard to a patch

When a finding is a class of mistake (every suite that calls \`mkdtemp\` without
removing it), the fix includes a mechanical guard — a conventions test, a
shared helper with cleanup built in, or a runner-level teardown — so the next
suite cannot reintroduce it. Fixing the one instance you measured is not enough.

## Not yours

Whether a test's assertions prove anything, and order-dependent tests, belong to
the test-quality work; documented setup that no longer works to the
documentation work; missing coverage to the test-coverage work; leaks in the running product to
the runtime-safety work; CI and deployment configuration to the infrastructure
work; dependency versions to the dependency-update work.

## The bar

Every finding quotes its measurement — the before and after counts, the
surviving process, the changed file — and estimates the cost at the project's
real cadence (runs per day times what each run leaves or spends). Report counts
and name prefixes.`,
};
