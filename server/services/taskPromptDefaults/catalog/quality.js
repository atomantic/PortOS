export const prompts = {
  'code-quality': `[Improvement: {appName}] Code Quality Review

Audit {appName} for maintainability defects that create real operational or
engineering cost.

Repository: {repoPath}

{modeInstructions}

## Hunt for

- **Brittle conditionals and hardcoded paths** — logic that works for the cases
  it was written against and silently misbehaves just outside them: an
  environment or platform assumption baked into a branch, a narrow
  implementation that passes a specific case without being correct in general.
- **Unexplained magic values** — a number, timeout, limit, or string literal
  carrying meaning nothing states, especially one repeated across files.
- **Test-shaped hacks in production code** — a branch that exists only to make a
  test pass, an environment check gating real behavior, a stub left reachable.
- **Dead and unreachable code** — unused imports and variables, a branch whose
  condition can no longer occur, an option nothing sets.
- **Convention violations** — code contradicting the conventions the repository
  documents for itself, including the non-issues it explicitly declares.
- **Stale TODOs and comments that lie** — a comment describing behavior the code
  no longer has, or a TODO whose work already shipped.

## Lane recommendation

This is the triage lane: its second deliverable is where to look next. Rank
the three focused audits (by scheduled task type) that the evidence says would
find the most, each with one sentence of evidence and the paths it points at.
Put the ranked list in the completion summary under the heading
\`Recommended next audits\`, one audit per line as
\`1. <task-type> — <evidence>: <paths>\`.

## Owned by sibling audits — do not file here

Filing the same problem twice is noise. Name an overlap if it is the cause of
what you found, then leave it to its owner:

- Generated artifacts as a second source of truth, hand-synchronized registries,
  and incidental-layout coupling belong to the structural-drift work.
- Counted branching complexity and reader-cost problems (mixed abstraction
  levels, flag arguments, misleading names) belong to the complexity and
  cognitive-load work.
- Responsibility boundaries, module topology, and reuse discoverability belong
  to the module-hygiene work.
- Pure dead-code removal and copy-paste consolidation belong to the
  simplification work.
- Latent runtime defects belong to the runtime-safety work; logging gaps to the
  observability work; a boundary call whose failure is simply unhandled to the
  failure-path work.

## The evidence bar

Read the producer, its callers, its tests, and recent history before judging
anything. Keep only findings with a named transformation and a proven
consequence: a reachable runtime or data failure, a CI or release failure, or
recurring manual churn demonstrated by the repository's own history. Delete
subjective style preferences and any finding whose consequence you cannot show.
Do not propose a rewrite because you would have written it differently.

Cite \`file:LINE\` for every finding.`,

  'test-coverage': `[Improvement: {appName}] Test Coverage

Find the untested behavior in {appName} whose silent failure would actually
cost something, and cover it at the right level.

Repository: {repoPath}

{modeInstructions}

## Prioritize by consequence, not by percentage

Coverage percentage is a diagnostic, not a goal. Rank gaps by what breaking them
costs: data loss or corruption, money or quota spend, a security or privacy
guarantee, a destructive action, an upgrade or migration path, then everything
else. A gap in code that changes often is worth more than a gap in code that
never changes — the repository's history tells you which is which.

## Test at the highest practical boundary

Prefer a test at a real public surface — an HTTP route, a service workflow, a
persisted-store adapter, a rendered user interaction, a CLI invocation — over a
test of an internal helper. A boundary test should cover the success path plus
the materially different failure and compatibility paths. Do not enumerate every
internal branch just because the branch exists, and do not add a unit test for a
deterministic helper already exercised through a stable caller.

Focused unit tests are still right for behavior a higher-level test cannot pin
cheaply or precisely: parsers and algorithms with a real input matrix; security,
privacy, and destructive-action guards; migrations and cross-version
compatibility; serialization and schema boundaries; retry, timeout, and
lifecycle state machines. Test real timeout behavior once, with injected or fake
time, never with production sleeps.

## Before adding a test, name the regression it uniquely catches

If you cannot name a specific way the code could break that this test and no
existing test would catch, do not write it. When you add one, verify it is not
vacuous: mutate the code it covers so it is wrong, confirm the test fails, then
revert the mutation. A test that passes against broken code is worse than no
test.

Follow the project's existing test conventions — its runner, file placement,
naming, and mocking patterns — rather than importing a style from elsewhere.
In implement mode, when you add a test to a suite over the project's documented
size budget, name the redundant test you removed to pay for it.

## Not yours

Existing tests that are vacuous, weak, or redundant belong to the test-quality
work. You own the gaps; leave the audit of what is already written to its owner
unless a gap is hidden BY a vacuous test, in which case say so explicitly.

For each finding, name the uncovered behavior with \`file:LINE\`, the failure it
would allow, the boundary you would test it at, and why that boundary.`,

  'performance': `[Improvement: {appName}] Performance Analysis

Find where {appName} does provably more work than it needs to, on a path that is
actually hot.

Repository: {repoPath}

{modeInstructions}

## Measure or reason concretely — never guess

A performance finding needs a quantity: how often the path runs, over how much
data, and what the cost grows with. "This could be slow" is not a finding.
Prefer evidence in this order: a measurement you took, a complexity argument
over a data size you can state, or a pattern whose cost is unambiguous at the
scale the code actually sees. Say which one you have.

## Hunt for

- **Work repeated per item that could be done once** — a query, read, parse,
  compile, or allocation inside a loop whose result does not vary.
- **N+1 access patterns** — a related record, file, or request fetched inside a
  loop over a parent collection.
- **Superlinear algorithms on unbounded input** — nested scans over the same
  collection, repeated linear lookups where a map would answer in one step.
- **Unbounded result sets** — a query, listing, or fetch with no limit over data
  that grows with usage, especially one rendered or held entirely in memory.
- **Missing indexes** — a filter or sort on a column that has none, on a table
  that grows.
- **Redundant re-computation in a render or hot callback** — work repeated on
  every frame, keystroke, or event that depends only on stable inputs.
- **Payload and startup weight** — a large module pulled into a path that needs
  one constant from it, an asset far larger than its rendered size, work done at
  import time that only one rare path needs.
- **Cache misuse** — a cache that never invalidates, one that never hits because
  its key varies, or an unbounded one that is really a leak.
- **Stable reference data re-downloaded** — a list that changes only on an
  event (configuration, providers, a catalog) fetched on a timer or on every
  visit instead of being invalidated by the event that changes it.

## Where present: service and data-path coverage

Apply the items that exist in this app and skip the rest silently. For
services, APIs, workers, and data pipelines, inspect the heaviest request and
job paths as well as any UI:

- **Query plans** — read the plan (EXPLAIN or the engine's equivalent) for the
  most frequent and the most expensive queries rather than inferring index use
  from the schema; watch for sequential scans, sorts spilling to disk, and plans
  that change with data volume.
- **Buffering instead of streaming** — a whole file, object, result set, or
  response body loaded into memory when it could be streamed or paged.
- **Batch shape** — bulk operations done one row or one request at a time, or
  batches so large they time out or hold locks for seconds.
- **Connection and concurrency limits** — pools sized below the concurrency the
  service accepts, work serialized behind one connection, or unbounded parallel
  fan-out that saturates a downstream.
- **Data layout for analytical reads** — reads that cannot prune partitions or
  push predicates down, many small files, row-oriented formats scanned for a
  few columns.
- **Serialization and startup cost** — repeated encode/decode of the same
  payload, and cold-start work on a serverless or per-request path.

## Where present: UI load and idle-network coverage

Apply the items that exist in this app and skip the rest silently. For apps
with a UI, inspect the shared shell and at least one high-volume
collection route, plus a sibling tab that does not use that collection. Trace
initial reads, mounted hidden panels, polling timers, websocket invalidations,
and reconnect recovery. Include the app's largest growing collections (inboxes,
histories, media libraries, logs) when they exist; follow the app's
collection-loading standard.

When browser tooling is available, capture a cold route load, navigation to the
sibling tab, and at least 60 seconds of idle network activity. Report request
counts and transferred/decoded bytes by endpoint, duplicate or overlapping
requests, time until useful content renders, and idle bytes per minute. Include
websocket payloads, not only fetch/XHR.
Distinguish expected live telemetry from whole-list polling; telemetry should
be scoped to visible consumers. Use synthetic large collections to verify
server page limits, compact list projections, lazy details, bounded rendered
rows, and no full history hydration hidden behind client-side slicing.

Only when the app is PortOS (it ships scripts/perf/browserCollectionAudit.mjs) and
the live browser is unauthenticated, also run
node scripts/perf/browserCollectionAudit.mjs --route=/ --sibling=/<path> against
its synthetic fixture (see scripts/perf/README.md). That is synthetic shell
traffic only; live UI load and idle transfer stay UNVERIFIED.

Do not claim UI performance passed from source inspection or a small/empty
fixture alone. If browser access, an authorized session, or usable large-fixture
evidence is unavailable during a headless audit, explicitly mark UI load/idle
transfer \`UNVERIFIED\` in your assessment summary and inspect static bundle and
polling code, without filing a tracker issue for missing audit-environment
browser access.
Never copy live personal records, hostnames, tokens, or raw private HAR bodies
into reports; report redacted endpoint patterns and aggregate measurements.

Money and metered-quota spend belong to the cost-efficiency work; stay on
latency, throughput, and resource use.

## Do not trade correctness or clarity for a gain you cannot measure

Reject micro-optimizations with no measured effect, and any change that makes
behavior harder to reason about for a speedup you cannot state. If a slow path
is slow because it is doing something necessary, say so and move on.

For each finding, give \`file:LINE\`, the quantity (frequency times size), the
growth term, the proposed change, and the expected effect. In implement mode,
state how you verified the improvement.`,

  'api-contract': `[Improvement: {appName}] API and route-contract audit

Audit {appName}'s API surface — HTTP routes, RPC services, GraphQL resolvers,
event and message contracts, and any published SDK or client — for contract
drift, validation gaps, and error traps.

Repository: {repoPath}

{modeInstructions}

Identify the framework and the project's own conventions (validation library,
error envelope, async wrapper, versioning scheme) before judging anything. Trace
callers — in-repo clients, SDKs, consumers of a published spec — through to the
handlers and schemas, hunting for:

- **Unvalidated inputs** — handlers reading the request body, query, params, or
  message payload directly with no schema, letting malformed types into domain
  logic.
- **Caller/handler drift** — a caller sending a field no handler reads, a
  handler requiring one the caller omits, or a caller reading a key the response
  never carries.
- **Spec drift** — an OpenAPI, protobuf, GraphQL, or event schema that no longer
  matches the implementation, so generated clients and documentation are wrong.
- **Breaking changes to a published contract** — a renamed, removed, or retyped
  field, a changed default, or a reused protobuf field number on an API other
  systems consume, with no new version or deprecation path.
- **Status and envelope errors** — success statuses carrying errors, a server
  error for bad client input, or responses that break the project's own error
  envelope, so callers cannot tell retryable failures from permanent ones.
- **Async traps** — a handler whose rejected promise or thrown error bypasses
  the framework's error path (for example an Express handler missing the
  project's async wrapper), hanging the request instead of failing it.
- **Unsafe mutation semantics** — a mutation behind a safe method, a
  non-idempotent PUT or DELETE, or a create endpoint clients will retry with no
  idempotency key, producing duplicates on a timeout.
- **Unbounded or unstable collections** — list endpoints with no limit, no
  maximum page size, or offset pagination over data that changes underneath the
  caller.
- **Long work on a synchronous request** — an endpoint that does minutes of work
  inline where the contract should accept the job and report status.
- **Loose schemas** — unbounded strings, arbitrary extra keys, or an enum
  accepting values downstream code cannot handle.

For each finding, name the caller AND the handler with \`file:LINE\`, the shape
that gets through, and the concrete failure it produces for a consumer.`,

  'error-handling': `[Improvement: {appName}] Failure-path Audit

Audit what {appName} does when things go wrong: whether failures are handled,
recoverable, and comprehensible to whoever hits them.

Repository: {repoPath}

{modeInstructions}

## Hunt for

- **Failures with no handler at a real boundary** — a network call, filesystem
  operation, database query, subprocess, or external API whose failure has no
  path other than propagating as an unhandled error.
- **Missing timeouts** — an outbound call that can hang indefinitely, holding a
  connection, a worker, or a user's request open with it.
- **Retries without a ceiling** — a retry loop with no maximum, no backoff, or
  no jitter, which converts a downstream blip into a self-inflicted flood.
- **No fallback for a degraded dependency** — a feature that fails completely
  when an optional or slow dependency is unavailable, where partial service was
  possible.
- **Errors that reach the user as noise** — a raw stack trace, an internal
  identifier, or "Something went wrong" with no statement of what failed or what
  to do next. An error message a user cannot act on is a defect.
- **Cleanup that only runs on success** — a handle, lock, temporary file, or
  in-flight marker released on the happy path but leaked when the operation
  throws.

## Not yours

A swallowed error with no log, log noise, and missing diagnostic context belong
to the observability work. Latent defects that are simply bugs — a missing
await, an unguarded null — belong to the runtime-safety work. Sensitive detail
leaking through an error path belongs to the privacy work; partial writes to
the data-integrity work. Name an overlap
where it is the cause, but leave the filing to its owner.

## The bar

Read the caller and the surrounding frames before flagging: the handling may
live one level up, and the framework may already route what looks unhandled. For
each finding, state the failure that reaches this code, what happens today, and
what should happen instead — with \`file:LINE\`.`,

  'typing': `[Improvement: {appName}] Type Safety Audit

Improve the type contracts in {appName} where weak typing is actually hiding a
defect or blocking a correct change.

Repository: {repoPath}

{modeInstructions}

If the project does not use a typed language or a type checker, say so and exit
cleanly rather than proposing that it adopt one.

## Hunt for

- **Escape hatches at a real boundary** — an untyped or \`any\`-typed value
  crossing a public API, a route handler, a persisted record, or a module
  boundary, so nothing downstream is checked.
- **Assertions that paper over an unknown shape** — a cast asserting what the
  code hopes is true, where a validated parse would prove it.
- **Unvalidated external data typed as if it were trusted** — a network
  response, file, environment value, or model output declared as a concrete type
  without a runtime check that it matches.
- **Optionality that does not match reality** — a field marked optional that
  every path requires, or required where a real path omits it, forcing defensive
  access everywhere.
- **Types that disagree with their runtime validator** — a declared shape and
  its schema that can accept different values, so one of them is lying.
- **Structural duplicates** — the same shape declared independently in several
  places, free to drift.

## The bar

A type change must remove a real class of mistake, not merely add annotation.
Prefer narrowing at the boundary where untrusted data enters, so everything
inside can rely on it. Do not propose a mechanical annotation sweep, and do not
weaken a check to make an error disappear — if the type is inconvenient because
the value really can be absent, the fix is the missing branch, not the cast.

For each finding, give \`file:LINE\`, the value whose shape is unproven, the
mistake the current typing permits, and the narrowing you propose. In implement
mode, run the project's type check and tests before committing.`,
};
