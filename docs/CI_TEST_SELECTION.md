# CI Test Selection and Sizing

How CI selects, partitions and sizes the test suites. Split out of [GITHUB_ACTIONS.md](GITHUB_ACTIONS.md); the workflow overview stays there.

## Browser workload partition

The browser job uses one runner for one selected suite, two for two or three,
and four for four or more. Each runner receives the complete planner selection
and `CI_SHARD`. For a given shard count and profile, the registry pins suite
owners before subtracting memo hits. The two-runner smoke profile moves GPU
film look away from animatic capture. With four runners, both profiles separate
those suites through the shared ownership table. Unknown browser selectors fail
rather than being dropped.

The four-runner layout spreads the expensive memo misses from hosted run
45642241181. That run's fastest runner skipped its only suite, while the
slowest ran template parity, production review and animatic capture. A cold
run has a different floor. In uncached run 45038139135, document render and
HTML composition each exceeded 115 seconds by themselves.

Each shard retains the full selected browser profile, the quiet capture project,
normal motion, fidelity assertions, process containment and the existing
720-second supervisor deadline. `CI Gate` consumes the matrix's aggregate result,
so every selected shard must pass. Transform artifacts, test memos and failure
artifacts have distinct shard keys; a passing shard cannot replace its sibling.

## Vitest runner tuning

On GitHub Actions, `CI=true` caps the server Vitest runner at `maxWorkers: 4`
(`scripts/vitestCiPool.js`, spread into `server/vitest.config.js` and
`client/vitest.config.js`). Standard Linux runners for public repositories are
[4 vCPU / 16GB](https://docs.github.com/en/actions/reference/runners/github-hosted-runners);
uncapped forks oversubscribe those cores during transform. Locally, Vitest workers
are `cores / maxConcurrentAgents` from the CoS settings (`scripts/lib/cosWorkerBudget.js`),
capped at 4, so concurrent worktree gates share one host budget; lower
**max concurrent agents** in the app to ease load — no env var. A focused file
run is not the full-suite result (`docs/CONTRIBUTING.md`). `npm run pregate`
passes the derived value to its stages. The client caps Vitest at three
workers, leaving one runner core for Chromium and DOM spikes. File-level
parallelism stays on; the DB suite already serializes
files because those tests share one Postgres.

Each test job restores Vite/Vitest transform artifacts from checkout-owned
`.cache/` paths (`server/.cache/vitest`, `server/.cache/vitest-db`,
`client/.cache/vitest`), outside `node_modules`, which `npm ci` wipes and
worktrees may share. The server key hashes the lockfile, both server Vitest
configs and `scripts/vitestCiPool.js`, plus a per-job/per-shard suffix so
parallel saves never race; restore-keys survive a lockfile bump. Pull requests
only restore this and the APT cache; other events save them.
`scripts/run-ci-tests.js`
writes Vitest wall time to the job summary so later runs can be compared
against the pre-change full-suite job wall on `main` (2026-08-16, run
`31951919659`): server ~300s, client+build ~467s, Windows ~463s.

## Test environment cost (happy-dom, and skipping the DOM entirely)

`environment` — the per-file cost of constructing the DOM the test runs in — was
the largest phase of the client suite. Two levers cut it, both applied.

**Lever 1 — don't build a DOM you don't need.** A test file that never touches
the DOM opts out with a `// @vitest-environment node` pragma on line 1, and pays
~0ms instead of ~0.35s (local) / ~0.7s (CI runner) for its environment. Every
file under `client/src/{lib,utils,services}` that passes in `node` carries the
pragma.

When adding a test under `client/src/{lib,utils,services}`, default to the
pragma and only drop it if the file (or the module it imports) genuinely needs
`document`/`window`. The 13 files in that tree that legitimately keep a DOM do
so because the *module under test* reaches for a browser global — e.g.
`apiApps.js` navigates via `window.location`, `webglSupport.js` calls
`document.createElement('canvas')`.

**Lever 2 — a cheaper DOM.** `client/vitest.config.js` runs on happy-dom
(#6144), which cut the environment phase 65% and wall time 37%. jsdom is no longer a
dependency, so `// @vitest-environment jsdom` is not available as a per-file
escape hatch — a divergence gets fixed in the test.

**What differs, when a test breaks after touching the DOM.** happy-dom is not
bug-compatible with jsdom, and the gaps all showed up as tests rather than as
product failures. Two are patched centrally in `client/src/test/`, so they never
need handling again; the rest are per-site idioms worth copying.

Patched in setup:

- **Constraint validation.** happy-dom computes `stepMismatch` as a raw float
  modulo against `step`, ignoring the step base — so
  `<input type="range" min="0" max="1" step="0.05" value="0.35">` reports
  invalid. One invalid control makes the form's `checkValidity()` false, and
  implicit submission is then dropped *silently*: clicking a `type="submit"`
  button runs no handler and raises nothing.
  `client/src/test/formValidityPolyfill.js` restores the browser behaviour.
- **Storage identity.** happy-dom backs `localStorage` with a Proxy that turns a
  property definition into a stored item, so `vi.spyOn(window.localStorage,
  'setItem')` cannot be undone and leaks a throwing stub into every later test in
  the file. `installTestStorage()` now replaces Storage with the plain in-memory
  shim unconditionally.

Per-site idioms:

- **`getComputedStyle` returns no UA defaults.** An unstyled `<span>` reports
  `display: ""`, and `dom-accessibility-api` joins non-inline text with a space —
  so a `TabPills` chip's accessible name is `'Ollama 1'`, not jsdom's
  `'Ollama1'`. A real browser blockifies the flex item and also spaces it. Match
  a whitespace-tolerant regex rather than pinning one engine.
- **No `SVGAnimatedString`.** `svgEl.className` is a plain string, so `.baseVal`
  is `undefined`. Assert on `getAttribute('class')`, which works everywhere.
- **`clientHeight` is declared on `HTMLElement`, not `Element`**, and
  `vi.spyOn` only walks *up* the prototype chain. Spy on `HTMLElement.prototype`.
- **`WheelEvent` does not extend `MouseEvent`**, so modifier keys passed to the
  constructor are dropped. `Object.defineProperty(event, 'shiftKey', …)` after
  construction works in both.
- **Some `navigator` members are getter-only** (`navigator.locks`), where a plain
  assignment throws. Use `Object.defineProperty`.
- **A `<label>` reports itself as the label of *any* labelable descendant**, not
  just its control — so a `<button>` nested inside a field's `<label>` takes the
  label's text as its accessible name. Pair `htmlFor`/`id` and keep the button a
  sibling, which is the convention anyway.

## Client suite time budgets

Two numbers, derived from one another in `client/src/test/timeouts.js` rather
than written side by side:

| Budget | Value | Applied by |
| --- | --- | --- |
| Testing Library `asyncUtilTimeout` (`waitFor`, `findBy*`) | 5000 ms | `client/src/test/setup.js` |
| Vitest `testTimeout` / `hookTimeout` | 15000 ms (3x) | `client/vitest.config.js` |

**The ordering is the point, not the values.** An inner bound that reaches the
budget enclosing it can never report its own failure: the test dies first with a
bare "test timed out" naming nothing it was waiting on. `client/src/test/guards/ui/timeouts.test.js` fails CI on an inline
`waitFor`/`findBy*` bound at or above the per-test budget — recognised by the
option object's keys, so `{ timeout, interval }` counts and a fixture record
that merely holds a `timeout` field does not. It asserts the EFFECTIVE runtime
values rather than the module constants, so a `configure()` that stopped being
applied is caught too. A file that raises its own budget with
`vi.setConfig({ testTimeout })` is exempt.

5000 ms because Testing Library's 1000 ms default sat under what a 2-vCPU public
runner needs. A loaded runner should make a test slower, not red; the cost is that
a genuinely hung assertion reports in 5 s instead of 3.

**A budget is not a race fix.** It buys a slow runner room; it cannot rescue an
assertion waiting on a call that already happened with the wrong argument. Those
need a settled precondition — see `client/src/test/settledInput.js` (type-then-
submit) and `client/src/test/pageLoadBarrier.js` (render-then-act, two-sided so
a barrier naming a string the page never renders fails loudly instead of passing
on its first poll).

## Reusing the client install

Every client test shard, `client-build`, `lint` and `browser` install `client/` through the
`setup-client` action.
`setup-node`'s `cache: npm` only preserves the tarball cache, so `npm ci` still
wipes and repopulates a 393 MB `client/node_modules` on each. `Cache client
node_modules` keys exactly on `client/package-lock.json`, `client/package.json`
and `client/.npmrc`, with no restore-keys, and the install is skipped outright
on a hit. Unlike the server, there is no rebuild half to verify: `client/.npmrc`
pins `ignore-scripts=true` and `scripts/trusted-rebuilds.js` deliberately lists
nothing for this workspace, so a restored tree is usable as-is.

## Reusing the server install

Five jobs install the server workspace through the `setup-server` action —
`server`, `database`, `browser`, `windows-server` and `macos-native`. `setup-node`'s `cache: npm` only preserves `~/.npm`, the
tarball cache, so `npm ci` still wipes and repopulates a ~570 MB
`node_modules` on each of them. Two changes cut that.

**Skip the CUDA execution provider.** onnxruntime-node bundles its CPU binaries
in the npm tarball, but its postinstall *downloads* the CUDA EP — several
hundred MB — on linux-x64 whenever `libonnxruntime_providers_cuda.so` is
absent. `server/.npmrc` pins `ignore-scripts=true`, so that runs inside
`scripts/trusted-rebuilds.js`, on the Linux server-installing jobs, every run.
No hosted runner has an NVIDIA GPU to use it with. Setting
`ONNXRUNTIME_NODE_INSTALL_CUDA=skip` on the rebuild step removes the download
outright, and inference is unaffected. This is the largest single saving here,
and it costs no cache budget.

**Cache the installed tree**, keyed on `runner.os`, `runner.arch`, the Node
major, and a hash of `server/package-lock.json`, `server/package.json`,
`server/.npmrc`, and `scripts/trusted-rebuilds.js`. On a hit the install and
the rebuild are both skipped. `scripts/ci-base-sha.test.js` guards the
contract; the parts that are not obvious:

- **Install and rebuild share one condition.** `ignore-scripts=true` means npm
  alone leaves the allowlisted packages un-built, so whenever a job builds the
  tree it will cache, it must build a rebuilt one. (The `server` job used to
  skip the rebuild for always-run-only plans; that condition is narrower, so it
  is gone — along with the planner's `server_native` output, which had no other
  consumer.)
- **A restored tree is checked by a mark, not by importing things.**
  `scripts/trusted-rebuild-stamp.js` writes
  `node_modules/.portos-trusted-rebuild.json` in the same `run:` block as the
  rebuild, recording the allowlist hash, platform, arch, and
  `NODE_MODULE_VERSION`. A cache hit reads it back and reinstalls on any
  mismatch.

  That step is pinned to `shell: bash` (composite actions require a shell on
  every step, but this one must be bash), which is load-bearing rather than
  stylistic. `windows-server` would otherwise default to pwsh, where a
  *native* command's non-zero exit neither throws nor stops the block
  (`$PSNativeCommandUseErrorActionPreference` is false) and only the last
  command's code becomes the step result — so a failed rebuild would write the
  mark anyway, exit 0, and publish a green, marked, un-rebuilt entry. Under
  `bash -e` the block stops at the rebuild and the job fails, and
  `actions/cache` declares `post-if: success()`, so nothing is saved.

  It has to be an extrinsic mark because "was this rebuilt?" is not answerable
  by inspecting the tree. With today's versions the rebuild is close to a
  no-op: node-pty and sharp ship prebuilt bindings inside their tarballs (there
  is no `build/` directory even in a fully rebuilt tree), onnxruntime-node
  bundles its CPU binaries, and protobufjs only regenerates a bundle nothing
  requires. `require()`-ing those packages therefore succeeds on a
  never-rebuilt tree and proves nothing. That is a property of the current
  versions, not a guarantee — a release that drops a prebuild for the runner's
  platform, or an install under `npm_config_build_from_source` (which makes
  node-pty's install script *delete* the prebuilds), puts the rebuild back on
  the critical path, and the mark still discriminates.
- **A bad entry is survived, not repaired.** The check is
  `continue-on-error`, and the install and rebuild key off
  `steps.server-modules-usable.outcome != 'success'` — one expression covering
  all three cases, since the step is `skipped` on a miss. The entry itself is
  not replaced: cache keys are immutable and `actions/cache` skips its save on
  an exact hit, so it keeps costing each run a reinstall until the key moves.
  It will not age out on its own either — GitHub's 7-day eviction is keyed on
  *access*, and an entry every run restores is accessed every run. Purging it
  would mean granting the workflow `actions: write`, which is not worth it when
  the worst case is already just the pre-cache cost.

  Two residual cases are accepted rather than defended. A rebuild in which only
  a `fatal: false` group failed exits 0, so a partially-rebuilt tree is marked
  and shared — where before, each job rebuilt from scratch and a transient
  failure degraded exactly one run. Today that is inert: with the CUDA download
  skipped onnxruntime-node's script early-exits, and protobufjs only
  regenerates a bundle nothing requires. And the dependency entry physically
  contains `node_modules/.vite`, so those artifacts are stored in both entries;
  `!` exclusions do not fix it, because `@actions/cache` resolves `path` with
  `implicitDescendants: false` — a bare directory pattern is archived whole and
  a sibling negation has nothing to subtract.
- **No `restore-keys` on this entry**, because the install is skipped on a hit
  and a near-miss restore would run the suite against a different lockfile's
  `node_modules`. The transform-artifact cache is the opposite case — its
  contents are revalidated rather than trusted — so it keeps its own key and its
  own restore-keys, and stays warm across a lockfile bump that misses here.
- **The key pins the Node major, not the resolved patch.**
  `NODE_MODULE_VERSION` is stable across patch releases, so keying on
  `steps.node.outputs.node-version` would discard the entry on every Node 26.x
  release for no ABI benefit; the mark carries the exact ABI as a backstop. A
  test compares the literal against the job's own `node-version:` pin.
  `server/package.json` is in the hash alongside the lockfile so that skipping
  `npm ci` does not also skip its manifest-vs-lockfile agreement check.

Hit rate comes from the full runs on `main` (every push, which seeds Windows
and macOS only when it runs them, and both schedule runs). A cache written by a
pull request is visible only to that branch, so those runs seed the entries on
the default branch, the one scope every PR branch can read. A PR that changes
the lockfile misses by design.

Three entries exist per key state (Linux, shared by `server`, `database` and `browser`,
plus Windows and macOS) at roughly 570 MB each, against GitHub's 10 GB per-repo cache budget.
Eviction is LRU, so the constantly-read `main` entries outlive the PR-scoped ones
— but a burst of lockfile-churning PRs can still push out the transform caches
and `~/.npm`. If that starts showing up as unexplained cold runs, the dependency
cache is the part to drop: the CUDA skip above carries most of the saving on its
own.

## Shallow checkouts

`actions/checkout` runs at `fetch-depth: 2`
in every job that diffs against the base. The two gate jobs set no depth at all
(the action's own default is 1) and pass `sparse-checkout: scripts` instead:
they check out only to run `scripts/ci-gate-report.js`, never look at history,
and sparse mode makes the action fetch with `--filter=blob:none`. Depth 2 on a
pull request is the merge ref plus both of its parents — and the
first parent *is* the base-branch commit the pull request is diffed against.
`scripts/ci-base-sha.js` reads it (`HEAD^1`) and exports `CI_BASE_SHA` for the
rest of the job, so the planner's `git diff <base>...HEAD` resolves without
deeper history. The planner passes the resulting source paths to the runner,
which resolves them through its own module graph. The always-run shipped
prompt hash guard compares with `CI_BASE_SHA` on pull requests and the first
parent on other hosted runs. Every current or retired hash in that base must
remain current or retired in `data.reference/prompts/shipped-hashes.json`.

Reading the base off the checkout rather than `github.event.pull_request.base.sha`
is also more correct: GitHub rebuilds the merge ref when the base branch moves,
so the payload value can name a commit the tested tree was never merged with.

Non-pull-request runs (push, nightly, dispatch, release fallback) force the
complete suite and get no base; a push gets `CI_GATED_BASE_SHA` (see [Native jobs on a push to `main`](CI_NATIVE_JOBS.md#native-jobs-on-a-push-to-main)).

## Browser fidelity cases

Pull requests run the browser suites' smoke profile, which skips the
`[fidelity]` grading cases. Those cases run in hosted CI on the nightly
schedule, on the candidate → `release` pull request and on dispatched full runs,
so a fidelity regression shows up there rather than blocking the PR that
caused it. The `[local-performance]` playback case runs only locally.

To check the fidelity cases on a PR before merging, run
`node scripts/browser-fidelity.js --pr NUMBER` from its clean checkout with
existing `gh` authentication. It runs the registered fidelity cases, keeps a
local receipt, and publishes an exact-commit status for the PR head. That
status is informational: no required check reads it. Software WebGL results do
not certify physical-GPU performance, and Mac-local results cannot replace
Windows compatibility, Linux containment or the SuperCollider live suite.

## Full-suite sharding

A full plan runs the broadest selection. Before sharding, the client
suite took about 10 minutes on a 4-vCPU runner, with 489 s of cumulative DOM
environment setup across 868 files. Sharding spreads that work across runners.

Primary server/client test jobs use matrices. The impact job emits
`server_shards` and `client_shards` from `FULL_SUITE_SHARDS` (server 2, client 6).
The client matrix pins five or six existing Chromium suites per shard,
balanced against the estimated cost of its other tests. The runner hashes
the remaining suites.
Windows emits `[1]` for its native contract runner. `scripts/run-ci-tests.js`
turns `CI_SHARD=<index>/<count>` into a disjoint file slice before
launching Vitest; the union is the complete selected suite. Windows uses exact
native selectors and never repeats a related-graph traversal. A scoped Linux plan fans out the same way
(`fansOut()` in the planner) only when its explicit selection exceeds its cap: `MAX_TARGETED_TEST_FILES` (125) for the server,
`CLIENT_FANOUT_TEST_FILES` (400) for the client, since one client runner absorbs 400 files at about 0.4 s each (#16805). That cap keeps the scoped selection and only partitions it, so a server-only
overflow does not start the client shards, the DB/browser
suites, and a Windows run (#11871). A `related` plan also fans out
when its measured import reach (`serverReach.selected` / `clientReach.selected`,
the suites its related walk will select) exceeds that runner's cap, even with few explicit selectors: one
runner executing ~1,000 related suites took 11 minutes on the server (#16547) and 16 on the client
(a shared module such as `client/src/services/apiCore.js`, #17456).
4 Chrome client suites do too ([why](./TEST_MEMO.md#shards)).
The reach, the DB, browser and client consumer closures and the gated-job
closures all read one module graph (`scripts/lib/moduleGraph.js`, #16998),
the same extractor and resolver pregate's local selection uses.
The summary names that reach-based fan-out. Every other scoped plan stays on one
runner; record-aware selection ([TEST_MEMO.md](./TEST_MEMO.md#related-selection), #16424) still narrows what
each selected suite runs. The runner slices the selection itself and never hands Vitest
`--shard`, so a shard whose slice is empty exits green. Server smoke boot
runs on shard 1. The production client build and client lint each run once
in a separate job, in parallel with the test shards. `CI Gate` checks each
selected job and sees each test matrix as one `needs` result.

`npm run pregate -- --full` reuses the same split locally: a full unit plan
becomes one stage per shard (server 2, client 6, from `FULL_SUITE_SHARDS`), run
sequentially with the env `resolvePlanStages` builds once per scope. Each shard
is a normal runner invocation with its own memo write, so a late failure in one
shard leaves the earlier shards' green entries reusable on the next attempt;
nothing is certified from a failed run. Sequential execution keeps a single
writer on each workspace's Vitest dependency record. Scoped plans, structural
guards and the browser stage clear `CI_SHARD` and stay unsliced.

`scripts/run-ci-tests.test.js` pins the matrix wiring, the server smoke
shard, and the separate client build job's dependency on the impact plan.

## Python sidecar scripts

`scripts/ml/*.py` (the LTX-2, MiniMax, FastVideo, and download sidecars) are
not reachable through Vitest's import graph, but ~45 suites pin their
contracts by reading the `.py` source as text (argparse flags, MLX pins, model
paths). The planner resolves the suites naming each changed script with
`git grep` (`sourceReferencePattern`) and runs exactly them in `files` mode,
failing closed to the full suite for a script nothing names. A `.py` outside
`scripts/` is still unclassified.

Targeted `files` plans run the planner's exact test files once. `related` plans
resolve the changed behavioral source paths through the runner's own module
graph (`scripts/lib/testMemo.js`: static, dynamic and `vi.mock` edges, the
same edges `vitest related` follows): a test is selected when a changed
source is in its closure or when one of its edges cannot be resolved, plus
the cheap structural/repository contract files, in one Vitest invocation.
The exact list reaches Vitest through a selection file
(`PORTOS_CI_TEST_SELECTION`, read by both workspace configs) rather than
command-line selectors, because a related set can exceed the Windows
command-line limit. Computing the set in the runner is what lets the test
memo below subtract the files a trusted green run already verified.
There is no buffered discovery pass: the old `vitest list --changed` path could
spend minutes printing every test name, overflow Node's buffer, discard the
result, and rerun the same graph.

## Test memo

The content-addressed test memo, its CI seeding and record-aware `related`
selection are documented in [TEST_MEMO.md](./TEST_MEMO.md).

No third-party change-filter action is used. The planner passes test paths as a
JSON argument array to `spawnSync`, never through shell interpolation.

## Impact-planner safety rules

- Jobs read decisions as `fromJSON(needs.impact.outputs.plan).<key>`
  (`githubPlanOutput()`); only `*_shards` and `db_image` are separate outputs.
- A directory feature such as `server/services/sprites/` additively selects
  same-workspace tests carrying that feature segment (#17895); cross-workspace
  edges ride `pathContractTests` and `clientDependencies`. It never identifies
  all consumers, so it does not replace traversal.
- Every runner with a changed behavioral source — flat, shared, or nested
  feature — runs one `related` invocation driven by the exact changed source
  paths, combined with the explicit selectors (feature, basename contract,
  guard, direct test) without duplicate execution. Directly changed tests are
  always included; a test-only or barrel-only diff keeps exact-file selection.
- Barrel/catalog guards are added when reusable `lib`, `hooks`, or `utils`
  directories change, and catalog-only barrels are excluded from import-graph
  expansion. JSX changes include the global accessibility convention guard.
- Any server source change adds `server/lib/apiRouteParity.test.js` and
  `scripts/generate-prompt-stage-call-sites.test.js`: they read the tree
  rather than importing what they scan, so no import edge reaches them (#5898).
  The route-graph guard, `server/test/guards/modules/apiRouteGraph.test.js`, rides every
  plan by its name.
- A change to `server/scripts/init-db.sql` or `init-db.base.sql` adds
  `server/lib/db.ddlParity.test.js`, which fails when the generated file is
  stale (#16092).
- A `scripts/ml/*.py` sidecar selects every test that names a python script
  (`git grep`), in `files` mode, and falls back to the full suite when none do
  — see "Python sidecar scripts" above.
- A deleted executable source cannot be handed to `vitest related`, so that
  case fails closed to the complete suite.
- Database adapters, DB scripts, and relevant migrations add the complete
  serial DB suite.
- A changed source's basename lookup (`git grep` of test files, #6363) keeps
  every hit for a unique basename. For a basename several tracked sources
  share (`index.js`, `providers.js`), it keeps only tests inside the source's
  directory subtree or whose text also names its parent directory (#11870). Import-graph selection still reaches real importers.
- Unmapped executable files use related-test mode. Unclassified artifacts,
  shared roots/config, or more than 30 executable changes fail safe to full
  CI. More than 125 selected tests on one runner keeps the scoped selection
  and shards that runner instead.
