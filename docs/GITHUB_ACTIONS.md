# GitHub Actions Workflows

PortOS uses a test-impact-aware CI workflow plus a release workflow that cannot
publish until the complete CI suite has passed on the exact tree being released.

## Where the suite actually runs

Every change reaches `main` through a pull request, and `main` reaches
`release` through a pull request, so the suite runs once per gate rather than
once per event:

| Event | What runs |
|-------|-----------|
| PR into `main` | Impact-scoped plan (only the surfaces the diff touches) |
| Push/merge to `main` | **Nothing** — no push trigger; the PR gate already passed |
| PR `main` → `release` | **Full suite**, forced regardless of the diff |
| Push/merge to `release` | Reuses the release PR's green gate; full suite only if it cannot be verified |
| Nightly 09:17 UTC | Full suite — the `main`-branch health signal |
| `workflow_dispatch` | Full suite |

A release therefore pays for one full run (on its PR), not three.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Active development |
| `release` | Merge `main` into `release` to trigger releases |

## CI Workflow (`ci.yml`)

PRs into `main` use `scripts/ci-test-plan.js` to classify the changed files
before installing dependencies. Directory-scoped features run their server and
client feature tests; flat modules fall back to Vitest's import-graph-aware
`related` mode, fed the changed behavioral source paths plus the planner's
explicit test files. The planner deliberately chooses full CI for shared
composition roots, test configuration, dependency manifests, workflow changes,
unknown artifacts, or wide diffs.

PRs into `release` skip the planner entirely and force the full suite: that PR
is the single gate a release ships behind.

### Hidden-content gate

The `impact` job runs `node scripts/scan-diff-hidden-content.js` before it
plans anything, and every other job needs `impact` — so a finding stops the
whole run, before a reviewer (human, `/do:pr` reviewer, or PR bot) ever reads
the diff. It is plain pattern matching over the diff's **added** lines, costs
no provider call, and cannot be argued out of a verdict by the content it is
reading. These shapes fail the run:

- **Invisible or direction-control Unicode** — C0/C1 controls (NUL, ESC/ANSI,
  a lone CR that is not part of CRLF), soft hyphen, combining grapheme joiner,
  zero-width characters, bidi overrides (Trojan Source), the Unicode tag block
  (ASCII smuggling), and both variation-selector blocks (U+FE00–U+FE0F,
  U+E0100–U+E01EF), which encode a byte apiece in the selector-smuggling
  attack. Text the rendered PR shows nobody while every model reading the diff
  sees it. The same code points in a **filename** fail too — `git diff` is
  collected with `core.quotepath=false` so they arrive as those characters
  rather than octal escapes.
- **A dense cluster of the invisible characters the rules exempt** — an emoji
  presentation selector or a joiner inside an emoji sequence is ordinary text;
  six of them inside 200 characters is a channel. This is the backstop that
  keeps the exemptions from becoming the attack.
- **A compressed or opaque encoded payload** — base64/base64url/hex that
  decodes to a gzip/zip/xz/zstd member or a native executable, or a 200+
  character opaque run. The bytes a reviewer approves are not the bytes that
  run.
- **A new symlink that leaves the repository** (absolute, `://`, above the
  tree root, or a secret path like `.env`) or a **new git submodule** — the
  review is of a path or a SHA, not of the bytes that would be read. Relative
  in-repo links (the slashdo command wrappers) stay clear; bumping an existing
  submodule SHA is not a new gitlink.
- **A non-media binary patch** — `Binary files differ` / `GIT binary patch`
  for anything that is not a common image, font, or audio/video file. The
  bytes never appear in the diff.
- **An inline script or `javascript:` URL** added to SVG/HTML/XML markup.

A leading byte-order mark is allowed (several Windows shells require one),
lockfiles skip the encoded-payload rule but never the Unicode ones, and a
deliberate case opts out with the visible `portos-allow-hidden-content` marker
**on that line** — so the exemption shows up in the diff a human reads. The
detectors are shared with `server/lib/modelAbuseGuard.js`, which applies the
same rules to external pull-request content before the model-abuse classifier
sees it — and which honors no marker, because that author is not trusted to
grant one.

An always-run list (`ALWAYS_RUN_TESTS` in the planner) is added to every plan,
so no impact scope can drop it. A documentation-only PR therefore still runs the
server job with those files selected. Two kinds of test qualify:

- **Cross-install contract snapshots** — `server/services/taskPromptDefaults.test.js`
  pins the prompt-upgrade contract, and nothing else in the suite notices when
  it breaks.
- **Repo-hygiene guards that enumerate the tracked tree** with `git grep` /
  `git ls-files` and assert over files they never import. Impact selection is
  import-graph-driven, so it has no edge that can reach them — the violating
  file is always some *other* file the guard sees only as a path string. Left
  off the list they are structurally unselectable and can sit red on `main`
  while every PR reports green (issue #5055).
- **Doc-parity guards** — `docs/api-doc.test.js` and `docs/deps-doc.test.js`
  compare the `.md` beside them with source they read rather than import
  (the route graph, the dependency manifests). The `.md` is documentation-only
  to the planner and the source has no import edge to the guard, so a docs-only
  PR is exactly the one that could document a removed endpoint and merge green.

`scripts/repo-scan-guards.test.js` keeps the second half honest: it re-derives
the scanner set from the tree and fails when a new scanner is added without
being registered, either in `ALWAYS_RUN_TESTS` or in its own
`STRUCTURALLY_SELECTED` map naming the selector that already reaches it.

### The bundled `lib/slashdo` submodule

`server/lib/slashdoLoader.test.js` and `server/lib/slashdoInvocation.test.js`
carry contract suites that exercise the real bundled renderer in
`lib/slashdo` (see AGENTS.md "Slashdo Commands"). A git diff reports only the
gitlink pointer at that path, never the files inside it, so the planner can't
detect a relevant change the way it does an ordinary source edit.
`needsSlashdoSubmodule()` in `ci-test-plan.js` sets the `slashdo` output
whenever the plan is full, the gitlink itself changed, or either contract
suite (or the loader/adapter source it exercises) is selected. The `server`
job's "Initialize slashdo submodule" step runs `git submodule update --init
lib/slashdo` only when that output is true, so an unrelated scoped PR pays
nothing for the fetch. When the output is true, the two contract suites fail
the job instead of silently skipping if the submodule still isn't there
(`CI_EXPECT_SLASHDO_SUBMODULE`); outside that signal — a local checkout, or a
CI run that never needed it — they keep the documented skip.

### Vitest runner tuning

On GitHub Actions, `CI=true` caps the server Vitest runner at `maxWorkers: 4`
(`scripts/vitestCiPool.js`, spread into `server/vitest.config.js` and
`client/vitest.config.js`). Standard Linux runners for public repositories are
[4 vCPU / 16GB](https://docs.github.com/en/actions/reference/runners/github-hosted-runners);
uncapped forks oversubscribe those cores during transform. Local `npm test`
is unbounded. The DOM-heavy client retains its proven two-worker override:
four workers made its async rendering assertions timing-dependent under CI
contention. File-level parallelism stays on; the DB suite already serializes
files because those tests share one Postgres.

Each test job restores Vite/Vitest transform artifacts
(`node_modules/.vite`, `node_modules/.vitest`) **after** the install — `npm ci`
wipes `node_modules`, so a restore ordered ahead of it is lost.
`scripts/run-ci-tests.js`
writes Vitest wall time to the job summary so later runs can be compared
against the pre-change full-suite job wall on `main` (2026-08-16, run
`31951919659`): server ~300s, client+build ~467s, Windows ~463s.

### Test environment cost (happy-dom, and skipping the DOM entirely)

`environment` — the per-file cost of constructing the DOM the test runs in — was
the single largest phase of the client suite. On the 2026-08-16 full run it was
`environment 489s` against `tests 384s`: building jsdom cost more than running
the assertions. Two levers cut it, and both are now applied.

**Lever 1 — don't build a DOM you don't need.** A test file that never touches
the DOM opts out with a `// @vitest-environment node` pragma on line 1, and pays
~0ms instead of ~0.35s (local) / ~0.7s (CI runner) for its environment. Every
file under `client/src/{lib,utils,services}` that passes in `node` carries the
pragma. Measured on the 36 files converted in that sweep (#6008):

| environment | wall |
| --- | --- |
| jsdom: 12.69s | 1.76s |
| node: 0.002s | 0.74s |

When adding a test under `client/src/{lib,utils,services}`, default to the
pragma and only drop it if the file (or the module it imports) genuinely needs
`document`/`window`. The 13 files in that tree that legitimately keep a DOM do
so because the *module under test* reaches for a browser global — e.g.
`apiApps.js` navigates via `window.location`, `webglSupport.js` calls
`document.createElement('canvas')`.

**Lever 2 — a cheaper DOM.** `client/vitest.config.js` runs on happy-dom
(#6144). Full-suite figures for the 834 files, Node 24, same machine, same
assertions:

| environment | wall |
| --- | --- |
| jsdom 30.0.1: 236.86s | 55.68s |
| happy-dom 20.14.0: 83.65s | 34.83s |

A 65% cut to the environment phase and a 37% cut to wall. jsdom is no longer a
dependency, so `// @vitest-environment jsdom` is not available as a per-file
escape hatch — a divergence gets fixed in the test, the way the six below were.

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

### Client suite time budgets

Two numbers, derived from one another in `client/src/test/timeouts.js` rather
than written side by side:

| Budget | Value | Applied by |
| --- | --- | --- |
| Testing Library `asyncUtilTimeout` (`waitFor`, `findBy*`) | 5000 ms | `client/src/test/setup.js` |
| Vitest `testTimeout` / `hookTimeout` | 15000 ms (3x) | `client/vitest.config.js` |

**The ordering is the point, not the values.** An inner bound that reaches the
budget enclosing it can never report its own failure: the test dies first with a
bare "test timed out" naming nothing it was waiting on. That has shipped twice —
`WordplayTrainer`'s 5 s drill bound against Vitest's 5 s default, and a
`{ timeout: 15000 }` in `BeeperTab.test.jsx` that could never wait past 5 s and
so never helped. `client/src/test/timeouts.test.js` fails CI on any inline
`{ timeout: N }` at or above the per-test budget, and asserts the EFFECTIVE
runtime values rather than the constants, so a `configure()` that stopped being
applied is caught too.

5000 ms because Testing Library's 1000 ms default, and the 3000 ms this suite
ran at before #7448, both sat under what a 2-vCPU public runner needs: shard 1
failed a different `await`-a-mock-call assertion on most runs while passing
locally every time. A loaded runner should make a test slower, not red. The cost
is that a genuinely hung assertion reports in 5 s instead of 3.

**A budget is not a race fix.** It buys a slow runner room; it cannot rescue an
assertion waiting on a call that already happened with the wrong argument. Those
need a settled precondition — see `client/src/test/settledInput.js` (type-then-
submit) and `client/src/test/pageLoadBarrier.js` (render-then-act, two-sided so
a barrier naming a string the page never renders fails loudly instead of passing
on its first poll).

### Reusing the client install

Four jobs install `client/` — the three client test shards and `lint`.
`setup-node`'s `cache: npm` only preserves the tarball cache, so `npm ci` still
wipes and repopulates a 393 MB `client/node_modules` on each. `Cache client
node_modules` keys exactly on `client/package-lock.json`, `client/package.json`
and `client/.npmrc`, with no restore-keys, and the install is skipped outright
on a hit. Unlike the server, there is no rebuild half to verify: `client/.npmrc`
pins `ignore-scripts=true` and `scripts/trusted-rebuilds.js` deliberately lists
nothing for this workspace, so a restored tree is usable as-is.

### Reusing the server install

Three jobs install the server workspace — `server`, `database`, and
`windows-server`. `setup-node`'s `cache: npm` only preserves `~/.npm`, the
tarball cache, so `npm ci` still wipes and repopulates a ~570 MB
`node_modules` on each of them. Two changes cut that.

**Skip the CUDA execution provider.** onnxruntime-node bundles its CPU binaries
in the npm tarball, but its postinstall *downloads* the CUDA EP — several
hundred MB — on linux-x64 whenever `libonnxruntime_providers_cuda.so` is
absent. `server/.npmrc` pins `ignore-scripts=true`, so that runs inside
`scripts/trusted-rebuilds.js`, on the `server` and `database` jobs, every run.
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

  That step is pinned to `shell: bash`, which is load-bearing rather than
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
  `steps.node.outputs.node-version` would discard the entry on every Node 24.x
  release for no ABI benefit; the mark carries the exact ABI as a backstop. A
  test compares the literal against the job's own `node-version:` pin.
  `server/package.json` is in the hash alongside the lockfile so that skipping
  `npm ci` does not also skip its manifest-vs-lockfile agreement check.

Hit rate comes from the nightly full run. There is no push trigger on `main`, and
a cache written by a pull request is visible only to that branch — so the 09:17
UTC schedule is what seeds the entries on the default branch, the one scope every
PR branch can read. A PR that changes the lockfile misses by design.

Two entries exist per key state (Linux, shared by `server` and `database`, plus
Windows) at roughly 570 MB each, against GitHub's 10 GB per-repo cache budget.
Eviction is LRU, so the constantly-read `main` entries outlive the PR-scoped ones
— but a burst of lockfile-churning PRs can still push out the transform caches
and `~/.npm`. If that starts showing up as unexplained cold runs, the dependency
cache is the part to drop: the CUDA skip above carries most of the saving on its
own.

### Shallow checkouts

No job clones full history. `actions/checkout` runs at `fetch-depth: 2`
in every job that diffs against the base. The two gate jobs set no depth at all
(the action's own default is 1) and pass `sparse-checkout: scripts` instead:
they check out only to run `scripts/ci-gate-report.js`, never look at history,
and sparse mode makes the action fetch with `--filter=blob:none`. Depth 2 on a
pull request is the merge ref plus both of its parents — and the
first parent *is* the base-branch commit the pull request is diffed against.
`scripts/ci-base-sha.js` reads it (`HEAD^1`) and exports `CI_BASE_SHA` for the
rest of the job, so the planner's `git diff <base>...HEAD` resolves without
deeper history. The planner passes the resulting source paths directly to
`vitest related`; Vitest no longer performs its own Git diff.

Reading the base off the checkout rather than `github.event.pull_request.base.sha`
is also more correct: GitHub rebuilds the merge ref when the base branch moves,
so the payload value can name a commit the tested tree was never merged with.

Non-pull-request runs (nightly, dispatch, release fallback) force the complete
suite, need no diff at all, and get no base.

### Required checks

The `main` ruleset — which also covers `release` — requires exactly one
context: **`CI Gate`**. The workflow used to carry two extra jobs solely to
publish historical required-check names (a `lint` job that only echoed the
client job's result, and `test (24.x)` on the server job); both are retired. A
`lint` job exists again since #7448, but it is the real linter doing real work,
not a name-publishing shim. If a required check is ever added, require
`CI Gate`, never a job name.

The selected work is split across parallel jobs:

- **Server tests** — full, related, or explicit feature test files. Smoke-boots
  the server on the same job when server source changed (the smoke path uses the
  file backend under `NODE_ENV=test` and does not need Postgres). The install
  and the native-addon rebuild are skipped when a `server/node_modules` cache is
  restored and its trusted-rebuild mark checks out. This job also runs
  `npm ci --prefix autofixer` — uncached and never skipped, because resolving
  that workspace's tracked lockfile *is* the check. It is the only CI step that
  installs `autofixer/`, which `npm run setup` and `scripts/ensure-deps.js`
  install on every user's machine; without it a lockfile that stopped resolving
  shipped green and failed at setup time. (`browser/` gets no such step: zero
  dependencies, and its lockfile is deliberately gitignored.)
- **Client tests and build** — affected client tests, plus the production build
  whenever client source changed. Build and the Scalar-removal bundle pin run on
  shard 1 only.
- **Lint client** — Biome over the changed client sources, in its own job. It used
  to be a shard-1 step on the client job. Steps within a job run sequentially, so
  that put ~31 s of Biome in front of the slowest shard's tests rather than beside
  them, and it meant a lint-only diff started a whole client test job. It was
  **not** what made shard 1 flaky — see "Client suite time budgets" below. It
  cannot move to a later shard instead: a scoped plan emits `client_shards: [1]`,
  so a second-shard pin would skip lint on every scoped pull request. It shares
  `Cache client node_modules` with the client job, so on a hit it pays no install.
- **DB tests** — provisions only the isolated `portos_test` database and runs
  the serial DB suite when database-sensitive files changed.
- **Windows server tests** — the same server selection, but only on full CI
  (the `main` → `release` PR, nightly, release, workflow dispatch) or when a
  Windows-sensitive surface changed (`.ps1` / `.cmd` spawn, PowerShell BOM,
  `bufferedSpawn`, `cos-runner`, shell/PM2, etc.). Docs-only and ordinary
  Linux-faithful PRs skip this job. `pinPlatform('win32')` tests still run on
  Linux. A full plan does not automatically mean a full *Windows* run — see
  "What a full plan costs the Windows job" below.
- **CI Gate** — always reports one stable required-check result and fails if any
  selected job failed or was cancelled. Both block, but the message distinguishes
  them: `scripts/ci-gate-report.js` says *cancelled, not failed* and names the
  cancelled jobs when nothing actually failed — as far as the gate job itself
  runs, which a run-wide cancel prevents. See "External cancellation and one
  automatic retry" below.
- **Full CI Gate** — published only when the plan chose the complete suite, and
  mirrors `CI Gate`'s result. This is the check the release workflow looks for;
  see "Reusing the release PR's CI run" below.

### Full-suite sharding

A full plan is the slow case: on the 4-vCPU public runners the client suite
alone took ~10 minutes (DOM setup per file dominated — the 868-file run
spent 489 s in `environment` against 384 s in `tests` — and its worker cap is
two, see `scripts/vitestCiPool.js`), the Windows server suite ~10 minutes
(module import is several times slower there), and the Linux server suite ~6
minutes. Roughly half of all PR runs went full, so most PRs waited on the
longest of those.

The three test-runner jobs are therefore matrices. The impact job emits
`server_shards`, `client_shards`, and `windows_shards` — `[1]` for a scoped
plan and `[1..n]` for a full one, sized by `FULL_SUITE_SHARDS` in
`scripts/ci-test-plan.js` (client 3, Windows 3, server 2) — and each job builds
its matrix from that output. The decision has to be made in the planner: a
job-level `if` cannot read the `matrix` context, so a job cannot skip its own
extra shards. `scripts/run-ci-tests.js` turns `CI_SHARD=<index>/<count>` into
Vitest's `--shard`, which slices the file list by path hash — every shard is a
fixed, disjoint subset, and their union is the complete suite. A scoped plan
never shards (its handful of files would trip Vitest's shard-count guard) and
passes no flag at all, so its invocation stays identical to a local
`npm run test:ci`. Once-only steps — smoke boot, the client build, the
Scalar-removal bundle pin — pin themselves to shard 1; lint is not among them,
because it has its own job (see above). `CI Gate` sees a matrix job as one
`needs` result, so nothing downstream changes; public-repo runner minutes are
free, so the fan-out costs only concurrency.

`scripts/run-ci-tests.test.js` pins the wiring: every runner job builds its
matrix from the planner, hands `CI_SHARD` to the runner, and gates its
once-only steps on shard 1.

### What a full plan costs the Windows job

Measured from 11 real full CI runs (`gh api repos/atomantic/PortOS/actions/runs/<id>/jobs`,
September 2026). A full run is **12 jobs / 28.7 runner-minutes**:

| Job | Jobs | Runner-min | At `windows-latest` 2x |
| --- | --- | --- | --- |
| Windows server tests | 3 | 11.8 | 23.5 |
| Client tests and build | 3 | 8.3 | 8.3 |
| Server tests | 2 | 6.8 | 6.8 |
| DB tests, impact, both gates | 4 | 1.7 | 1.7 |
| **Total** | **12** | **28.7** | **40.4** |

Measured before lint moved to its own job, so the client column still carries the
~31 s of Biome that now runs beside it rather than inside it. The matrix is 13
jobs rather than 12; the totals move less than that implies, because
`Cache client node_modules` now skips the 393 MB `npm ci` on all four jobs that
install this workspace.

Windows is 41% of a full run's runner occupancy, and 58% once GitHub's 2x
`windows-latest` multiplier is applied. **This repository is public, so those
minutes are not billed** — the cost that binds is runner occupancy and
concurrent-job slots, which is what makes several simultaneous PR builds queue.
The 2x column is kept because a fork on private billing does pay it.

**Not every full plan needs a full Windows run.** Replaying 250 merge commits
through `buildCiTestPlan`, 64 went full — and 24 of those (38%) went full for a
reason `windows-server` cannot observe:

| Full-plan reason | Runs | Windows-relevant? |
| --- | --- | --- |
| targeted test set exceeded safety cap | 17 | no — capacity, not risk |
| wide change (>30 executable files) | 6 | no — capacity, not risk |
| client composition root / build config / lint config / test setup | 1 | no — client-only |
| dependency manifest, server contract, CI pipeline script, workflow, … | 40 | yes |

So each full trigger in `FULL_TRIGGER_RULES` carries a `windowsEscalates` flag,
and `fullPlan()` escalates Windows to the complete server suite only when **any**
matching trigger is Windows-relevant, the diff touches `WINDOWS_RISK_RULES`, or
the run is force-full. **Any** is load-bearing: the reason line reports only the
first match in sorted-path order, and the `client/src/App.jsx` branch returns
before the trigger loop, so both read the same OR over every match. A diff that
edits `App.jsx` *and* bumps a lockfile escalates. Otherwise the job drops to **one shard running
`WINDOWS_CONTRACT_TESTS`** — reduced, never skipped, and exactly the depth a
Windows-risk scoped PR already gets.

Three properties keep that safe, each pinned by `scripts/ci-test-plan.test.js`:

- **Fail-closed by default.** `windowsEscalates` defaults to `true`, so a
  `fullPlan()` call site added later over-tests rather than under-tests.
- **Fail-closed on an empty baseline.** `run-ci-tests.js` prints "No server
  tests selected" and exits 0 for an empty `files` list, so a downgrade that
  resolved to no tracked contract tests would be a green job that ran nothing.
  The planner falls back to the full suite instead.
- **Force-full keeps the discovery net.** Nightly, the `main` → `release` PR,
  release, and an explicit full-CI request still run the complete Windows
  matrix. `ci.yml` has no push trigger, so those are the whole net for a Windows
  regression on a surface nobody has tagged yet (`staticImportGraph` in #5909,
  `voice/fineTuning` in #6268), and worst-case detection latency for a
  downgraded PR is the next nightly — always before a release, because the
  `main` → `release` PR is force-full. That is not a new exposure: it is the
  same net every PR touching no `WINDOWS_RISK_RULES` file already relies on,
  which is most of them. This change widens that population by 24 runs in 250.

**Before / after**, on the same 250-merge sample:

| | Jobs | Runner-min | 2x-equivalent |
| --- | --- | --- | --- |
| Full run, Windows-relevant (40 of 64) — unchanged | 12 | 28.7 | 40.4 |
| Full run, downgraded (24 of 64) — before | 12 | 28.7 | 40.4 |
| Full run, downgraded (24 of 64) — after | **10** | **18.4** | **19.9** |
| Per merged PR, averaged over all 250 — before | — | 10.25 | 13.78 |
| Per merged PR, averaged over all 250 — after | — | **9.26** | **11.81** |

That is −36% runner-minutes on a downgraded full run (−51% at the 2x multiplier),
and **−9.6% overall runner-minutes / −14.3% 2x-equivalent** across the whole sample.
The one estimated input is the baseline Windows shard at ~1.5 min (~0.83 min
measured fixed overhead plus the contract suite); every other figure is measured.

There is **no wall-clock regression**: a downgraded run's Windows job goes from 4.15 min to
~1.5 min, so the full path gets *shorter*, and no full-Windows run changes at all.

**Why the matrix is still 3 shards.** Dropping Windows to 2 was measured and
rejected. Per-shard step timings put fixed overhead (checkout, setup-node, cache
restore) at only ~0.83 min of the 4.15-min shard; the rest is the test step. Going
3 → 2 therefore removes one setup (~1.7 equivalent-minutes, 7%) while adding
~1.65 min to the full path's critical chain. Tightening the selection above beat
that at zero wall-clock cost, so `FULL_SUITE_SHARDS.windows` stays at 3.
`max-parallel` is not an alternative — it lowers peak concurrency, not total
occupancy.

### Python sidecar scripts

`scripts/*.py` (the LTX-2, MiniMax, FastVideo, and download sidecars) used to
be "unclassified changed files" and forced the complete matrix on every edit.
Vitest's import graph cannot reach into them, but ~45 suites pin their
contracts by reading the `.py` source as text (argparse flags, MLX pins, model
paths). The planner now resolves the suites naming each changed script with
`git grep` (`pythonReferencePattern`) and runs exactly them in `files` mode,
failing closed to the full suite for a script nothing names. A `.py` outside
`scripts/` is still unclassified.

Targeted `files` plans run the planner's exact test files once. `related` plans
run `vitest related` once with changed behavioral source paths and the cheap
structural/repository contract files as inputs. Vitest treats a test-file input
as directly selected, so contracts and changed tests share the import-graph run
without being repeated in a second process.
There is no buffered discovery pass: the old `vitest list --changed` path could
spend minutes printing every test name, overflow Node's buffer, discard the
result, and rerun the same graph.

No third-party change-filter action is used. The planner passes test paths as a
JSON argument array to `spawnSync`, never through shell interpolation.

### Full CI

The complete server, client, DB, lint, build, and smoke suite runs:

- on every pull request whose base branch is `release` (the release gate);
- nightly at 09:17 UTC;
- from manual workflow dispatch;
- as a reusable workflow called by a release whose tree has no verifiable gate.

There is **no push trigger on `main`**. A merge commit on `main` re-tests a
tree whose PR gate is already green, so the run was pure duplication; the
nightly full run is what catches a semantic conflict between two independently
green PRs, and the `main` → `release` PR catches it before a release ships.

Changes to CI/test configuration also force the full suite on their own PR.
`[skip ci]` remains honored for push events only; PR CI always runs.

### Fail-fast sibling cancellation

Each selected leaf job (`server`, `client`, `lint`, `database`, and
`windows-server`) ends with an `if: failure() && github.event_name ==
'pull_request'` step that asks GitHub to cancel the current pull-request
workflow run. The event guard is important because the same workflow is reused
by the release workflow: a failing reusable `full-ci` job must not cancel its
parent release run before that workflow can report the release failure. The
request uses the repository-owned
`scripts/cancel-current-ci-run.js` helper and the standard workflow-run cancel
endpoint. The helper accepts no repository or run arguments: it validates and
uses only `GITHUB_REPOSITORY` and `GITHUB_RUN_ID` supplied by Actions, with the
step-scoped `GITHUB_TOKEN`.

The leaf jobs request only `contents: read` and `actions: write`, and check
out with `persist-credentials: false` so a token that can now cancel runs is
not left in `.git/config` for the test suite's own subprocesses to read. The
token is present in the environment only for the cancellation step, and no
third-party action or long-lived secret is involved. The failing test/build
step runs before cancellation, so its annotations and logs remain the evidence
for the failure. A successful cancellation returns `202`; a `409` means the run
is already terminal and is treated as a no-op.

`release.yml`'s `full-ci` job must grant `actions: write` to the workflow it
calls even though the cancellation step never fires there — a called workflow's
jobs cannot hold a permission the calling job lacks. See the comment on that
job; `scripts/ci-fail-fast.test.js` pins it.

Cancellation is deliberately best-effort. Fork pull requests and other
read-only-token runs may receive a permission failure, and transient API or
network failures are also possible. The helper logs the unavailable
cancellation and exits normally, preserving the original failed step and its
failed job result when the API is unavailable. It imports only Node builtins,
so it still runs from a job that failed before `npm ci`
(`scripts/pre-install-entrypoints.test.js` enforces that).

**Canceled is not mergeable.** A run-wide cancellation lands on the requesting
job and on `CI Gate`, which is usually still waiting on its `needs` and so ends
`cancelled` rather than running its comparison. Every consumer treats that as a
non-pass, by allowlisting the green results rather than denylisting the red
ones:

- Branch protection requires the `CI Gate` context to conclude `success`;
  `cancelled` does not satisfy it, and a gate that never publishes leaves the
  required context unreported, which also blocks.
- If the gate job does run, it accepts only `success` or `skipped` per job, so
  the failed leaf (or its own `cancelled` result) fails the gate. It reports a
  cancel and a failure differently — see the next section — but neither passes.
- `scripts/verify-ci-status.js` accepts a `Full CI Gate` only at
  `conclusion === 'success'`, so a canceled run can never let a release skip
  the full suite.
- PortOS's own auto-merge watcher (`server/services/prWatcher.js`) counts only
  `SUCCESS`/`NEUTRAL`/`SKIPPED` as green.

The consequence to expect in the UI: on a fail-fast run the required check
reads *canceled*, not *failed*. The failing step's log and annotations are
still the diagnosis. The target is for siblings to become canceled within 30
seconds of the first failing job completing, while the existing workflow-level
`concurrency.cancel-in-progress` continues to handle superseded runs
independently — the two are orthogonal, one canceling this run by id and the
other canceling an older run when a newer commit arrives. Scheduled, manually
dispatched, and release-called runs skip this sibling cancellation so their
aggregate diagnostics and cache post-steps can complete normally.

### External cancellation and one automatic retry

Not every cancel comes from this repository. When several PRs build at once,
GitHub itself cancels in-flight runs — no job fails, the fail-fast step above
stays `skipped`, and **no successor run exists for the branch** (issue 7437).
That last property is the whole diagnosis: a `cancel-in-progress` supersession
always leaves a newer run for the same PR, and an external cancel leaves none.

`.github/workflows/ci-cancel-recovery.yml` runs on `workflow_run` and
re-dispatches such a run exactly once. `scripts/ci-retry-cancelled-run.js`
retries only when every one of these holds:

| Guard | Why |
| --- | --- |
| conclusion is `cancelled` | A failure is a failure. |
| event is `pull_request` | Nightly, dispatch, and release-called runs are not ours to re-drive. |
| `run_attempt == 1` | The retry budget. `POST /rerun` makes attempt 2, whose cancel sees attempt 2 and stops — one retry per run, and a PR run is one run per head SHA. |
| no job concluded `failure`/`timed_out` | Fail-fast cancellation makes a genuinely red run *look* cancelled. Retrying it would re-run the suite on a broken tree. |
| no newer run for the branch | That is a supersession; the newer run already covers this code. |

Any API lookup that cannot be completed skips the retry rather than assuming a
guard passed — a missed retry costs one manual re-run, a wrong one loops.

**The re-dispatch waits five minutes first** (`RETRY_DELAY_MS`, issue 7439).
The cancel it recovers from is caused by a saturated queue, so firing the
one-retry budget the instant the `workflow_run` event arrives spends it at the
moment it is least likely to survive: on PR 7434 three re-runs of the identical
SHA were each cancelled again while other runs were in flight, and that same SHA
passed on the first attempt made against an idle queue. One job idling — not
computing — for five minutes is the cheap side of that trade against re-running
twelve jobs straight into another cancel. The recovery job pins
`timeout-minutes` above `MAX_RUNTIME_MS` — the delay *plus* two worst-case
guard passes — so a slow GitHub can never get it killed mid-wait; that bound is
derived from the constants, and the workflow test asserts the inequality, so
raising the delay fails the build rather than quietly eating the margin.

Every API-backed guard in the table is evaluated **twice**: once before the wait
and once after it. A push or a human re-run that lands during the delay
therefore still wins, and the post-wait job listing is the more reliable one —
a failing job's step records can still be settling when the run's own fail-fast
cancel lands.

The two passes are **not** equal in authority. The post-wait pass is the reading
the re-dispatch is made on, and it fails CLOSED as before. The pre-wait pass is
only an optimization — it exists so an obviously ineligible run skips without
holding a runner idle — so **only a definitive `skipped` verdict short-circuits
there.** An `unavailable` reading before the wait is not evidence of
ineligibility, and a saturated GitHub is exactly when a transient 5xx is
likeliest, so it falls through to the wait and lets the post-wait pass decide.
Forfeiting the retry on a blip would lose the very case the delay was added to
win.

The step summary records `phase: before-wait | after-wait` and the `delay` it
used, so the Actions history can be read back as evidence when the constant is
tuned — under the delay that actually produced each outcome, not today's value.

Deliberately **not** chosen: polling `GET /actions/runs?status=in_progress` and
retrying only once the repository is quiet. On a busy repo that can mean never
retrying, which is worse than retrying into a cancel.

**Why the failing-job guard reads the jobs' own conclusions** rather than a
marker written by the fail-fast step: a marker fails OPEN. It would be written
by a job that is already failing, on a run about to be cancelled out from under
it, so a lost write makes a red run look externally cancelled — and get
retried. Reading conclusions fails CLOSED: an unreadable listing is
`jobs-unavailable` and skips the retry. Do not "simplify" this into a marker.
The ambiguity itself is the price of cancelling the run on first failure rather
than letting the remaining jobs fail naturally; that trade buys the 30-second
fail-fast above and is not on the table.

**This is also the only layer that can explain a run-wide cancel.** `if:
always()` on the gate defeats an upstream failure, not a cancellation of the
whole run — so in the external-cancel case the gate is cancelled too and never
prints its verdict. The recovery run is a separate run, so it survives; its
step summary records which guard applied.

That summary lives on the recovery run, which nobody finds from the pull
request, so the workflow also **publishes the verdict back onto the cancelled
head SHA as a check run** named `CI cancel recovery` (issue #7438). It carries
the same fixed reason code the step summary renders — `superseded`,
`job-failed`, `re-dispatched`, `retry-budget-exhausted`, `run-state-moved-on`,
or one of the `*-unavailable` lookup failures — plus one sentence saying what
to do about it.

The check's conclusion is **always `neutral`, and that is load-bearing**.
Branch protection requires `CI Gate` alone, so a `failure` here would block a
merge the repository allows; and `success` would read as a passing gate —
PortOS's own auto-merge watcher (`server/services/prWatcher.js`) counts
`NEUTRAL` as green. Neutral is the only conclusion that stays informational to
a human and to that watcher alike. Publishing is best-effort for the same
reason the retry is: a recovery job must never turn red on top of an
already-cancelled run, so a rejected or failed publish is logged and swallowed
and the job still exits 0. The only extra grant this needs is `checks: write`;
a `contents:`/`pull-requests: write` token on a `workflow_run` workflow is what
would turn an informational job into a push surface.

One known limit, filed: a retry re-runs the whole suite — Windows shards
included — so if the cause is the spending limit then recovery spends more of
it. Reducing the billable minutes of a full run is the complementary root-cause
lever (#7440).

Because the trigger is `workflow_run`, the recovery workflow runs the
**default branch's** copy of itself with writable `actions` and `checks`
tokens, and never checks out, installs, or executes the pull request's head.
The only PR-derived values it touches are validated run ids and one
URL-encoded branch name.

Reader-facing symptoms, the `gh` commands that tell an external cancel from a
supersession, and the account-billing check that confirms the upstream cause
are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md) under "CI cancelled with no
successor run".

### Impact-planner safety rules

- A directory feature such as `server/services/sprites/` selects tests carrying
  the same feature segment across server and client.
- Flat/shared behavioral modules use Vitest's import graph, driven by their
  exact changed source paths. Directly changed tests are always included.
- Barrel/catalog guards are added when reusable `lib`, `hooks`, or `utils`
  directories change, and catalog-only barrels are excluded from import-graph
  expansion. JSX changes include the global accessibility convention guard.
- Any server source change adds the tree-scanning guards
  (`server/lib/apiRouteGraph.test.js`, `server/lib/apiRouteParity.test.js`,
  `scripts/generate-prompt-stage-call-sites.test.js`): they read the tree
  rather than importing what they scan, so no import edge reaches them (#5898).
- A `scripts/*.py` sidecar selects every test that names a python script
  (`git grep`), in `files` mode, and falls back to the full suite when none do
  — see "Python sidecar scripts" above.
- A deleted executable source cannot be handed to `vitest related`, so that
  case fails closed to the complete suite.
- Database adapters, DB scripts, and relevant migrations add the complete
  serial DB suite.
- Unmapped executable files use related-test mode. Unclassified artifacts,
  shared roots/config, more than 30 executable changes, or more than 120
  selected tests fail safe to full CI.

## Release Workflow (`release.yml`)

Triggers on push to `release` branch. Steps:

1. Runs `scripts/verify-ci-status.js` to look for a full CI run that already
   covered this exact tree (see below).
2. Calls `ci.yml` with `full: true` **only if** step 1 found nothing.
3. Reads version from `package.json`.
4. Checks if the git tag already exists (skips release creation if so).
5. Looks for a changelog file:
   - First: `.changelog/v{version}.md` (exact match)
   - Then: `.changelog/v{major}.{minor}.x.md` (pattern match, replaces placeholders)
   - Fallback: generates changelog from commit messages
6. Creates the GitHub release with tag `v{version}`.
7. If a pattern changelog file (`.changelog/v{major}.{minor}.x.md`) was used,
   archives it on `main` (renames `.x.md` to the exact version).
8. If the archive step ran, fast-forwards `release` to match `main`.

### Reusing the release PR's CI run

`scripts/verify-ci-status.js` decides whether the push already has a green
gate. Two independent conditions must hold, because each alone is forgeable:

1. **Content, not SHA.** A commit vouches for this push only when its git tree
   is byte-identical to the tree being released. It considers the pushed commit
   itself and its direct parents.
2. **Fullness.** The gate must be `Full CI Gate`, a check run `ci.yml`
   publishes *only* when the impact plan chose the complete suite. The
   aggregate `CI Gate` cannot serve here — an impact-scoped PR run turns it
   green too, so it cannot distinguish "the full suite passed on this tree"
   from "some subset of it did".

The ordinary release merge satisfies this — `release` is strictly behind
`main`, so the merge commit's tree equals the `main` tip it merged, and that
tip is exactly the SHA the release PR ran full CI on.

Everything else fails closed and runs the complete suite again: a direct push to
`release`, a hotfix committed on `release` that changes the merge tree, a
missing, failed, or merely impact-scoped gate, or an unreachable checks API.

## Working with CI

### Skip CI

Add `[skip ci]` to push commit messages for generated documentation-only
changes. Auto-generated commits from the release workflow include this
automatically. Pull-request checks ignore this marker so a PR cannot bypass its
required CI gate.

### Force Full CI

Use the workflow-dispatch button for an immediate full run. A PR also chooses
full CI automatically when its impact cannot be classified safely.

### Rebase Before Push

Since CI may auto-commit changelog archives, always rebase before pushing:

```bash
git pull --rebase --autostash && git push
```

## Adapting for Sub-Projects

1. Copy `.github/workflows/ci.yml` and `.github/workflows/release.yml`
2. Update installation and build commands for your project structure
3. For monorepos, add package.json update steps for each workspace
4. Update the changelog file path pattern if different
