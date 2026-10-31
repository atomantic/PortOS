# GitHub Actions Workflows

PortOS uses a test-impact-aware CI workflow plus a release workflow that cannot
publish until the complete CI suite has passed on the exact tree being released.

## Release Dependabot CI after review

Dependabot pull requests start with a small checkout/admission check only.
`Plan test impact` fails with a maintainer-release message before dependency
installation or tests, so the required `CI Gate` remains red. The SuperCollider
job inside `ci.yml` repeats the check before installing or building.
Other pull requests, scheduled checks, releases and manual dispatches retain
their existing behavior. No schedule or repository security setting changes.

After reviewing the dependency diff, open the **current commit's** CI workflow
run and choose **Re-run all jobs**, or run `gh run rerun RUN_ID`. GitHub permits
reruns only to repository writers. Re-running failed jobs also reruns their
dependents; re-running only CI Gate cannot release a failed impact check.
Tests still have to pass before merging.

This approval is **commit-bound**: GitHub preserves the original SHA and ref
when rerunning. An older run cannot validate a newer commit. Every subsequent
commit, including a maintainer fix or Dependabot rebase, starts a new run at
attempt 1 and needs review/release again. Repeated reruns are still subject to
the same writer-only GitHub control. Labels and PR approval reviews do not
release CI. Automated bot reruns (including cancellation recovery) cannot
release held updates. Existing runs created before this workflow change keep
the workflow version with which they started.

The existing **Run workflow** dispatch remains an explicit writer-controlled
way to run the full suite on a selected branch/ref. Inspect its exact SHA:
a dispatch on `main` says nothing about a dependency PR, and a later commit
needs its own validation. The normal dependency workflow is the PR rerun above.
No privileged `pull_request_target` execution, writable test token or secrets
are introduced; reruns retain the original actor's restricted token.

See [GitHub's rerun permissions and revision semantics](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).

## Where the suite actually runs

Every change reaches `main` through a pull request, and `main` reaches
`release` through a pull request, so the suite runs once per gate rather than
once per event:

| Event | What runs |
|-------|-----------|
| PR into `main` | Impact-scoped plan (only the surfaces the diff touches) |
| Push/merge to `main` | **Nothing** — no push trigger; the PR gate already passed |
| PR candidate → `release` | **Full suite**, forced regardless of the diff |
| Push/merge to `release` | Reuses the release PR's green gate; full suite only if it cannot be verified |
| Scheduled 09:17 and 21:17 UTC | Full suite — the `main`-branch health signal; a red run names the merges since the last green one |
| `workflow_dispatch` | Full suite |

A release therefore pays for one full run (on its PR), not three.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Active development |
| `release` | Merge the frozen candidate into `release` to trigger releases |

## CI Workflow (`ci.yml`)

PRs into `main` use `scripts/ci-test-plan.js` to classify the changed files
before installing dependencies. Directory-scoped features add their server and
client feature tests, and every behavioral source (nested or flat) uses the
runner's import-graph-aware `related` mode, fed the changed behavioral source
paths plus the planner's explicit test files. The planner deliberately chooses full CI for shared
composition roots, test configuration, dependency manifests, workflow changes,
unknown artifacts, or wide diffs.

PRs into `release` skip the planner entirely and force the full suite: that PR
is the single gate a release ships behind.

### Hidden-content gate

`npm run pregate` runs this same scanner before client and server lint or tests, using its resolved
merge base. It checks committed, staged, and unstaged diffs separately, plus
untracked files, without changing the index or file contents. The scan remains
active with `--skip-lint` or an empty test plan; `--plan-only` lists it without
executing it. A diff read failure fails the gate.

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
server job with those files selected. The one exception is a PR that changes
only generated data no code or test reads (`GENERATED_DATA_RULES`: the repo-root
`.quality.json` that `npm run quality:snapshot` publishes): it skips every job,
and `CI Gate` passes once the impact job's diff scan does. Two kinds of test qualify:

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

### Local equivalent: `npm run pregate`

`scripts/pregate.js` runs the same planner over the committed and uncommitted
diff and hands its plan to the same runners. Default `npm run pregate` runs the
hidden-content scan, early server and client structural guards, lint, and
focused unit tests: edited test files and sibling tests for changed sources,
including untracked tests, without expanding through transitive imports.

`npm run pregate -- --full` opts into the CI-selected broad suites locally:
server and client tests, the client build, the
boot smoke, browser suites (smoke profile, prerequisites required rather than
skipped), and the serial `portos_test` DB suite last and alone. Each stage
receives the environment the matching job sets. A suite the machine cannot run
(no reachable test Postgres; no Chrome, ffmpeg or client bundler), or one left to CI with
`--skip-db`, `--skip-browser`, `--skip-build` or `--skip-smoke`, is reported
as not run — in the summary and in the receipt `.cache/pregate/report.json`,
which records the plan, stage outcomes and durations, the skipped suites, the
base and HEAD SHAs, and the hash of the exact working tree validated. The
shipped prompt-history guard runs locally when selected; the Windows job and
the Linux worker-containment job are the two suites only CI can prove. Details and the receipt
contract: `docs/CONTRIBUTING.md`.

The early guards use the same always-run and diff-selected structural selection
as CI and `--guards-only`. They run before broad tests and resource probes.
Successful guards are reused within this invocation only when the working tree,
index, HEAD and refs remain unchanged; otherwise the broad runner executes them
again. The receipt records guard outcomes and reuse proofs. Persistent test
memo rules, required stages and worker caps remain the same. Downgraded full
plans and `--guards-only` run the guard selection once; `--full` runs it before
the full suites.

`npm run pregate:merged -- --merged-with <base-ref>` (the same as
`node scripts/pregate.js --guards-only --merged-with <base-ref>`) runs the
structural guards on HEAD merged with a fetched base in an isolated temporary
repository. It is an opt-in diagnostic for investigating an integration break,
not a merge precondition: no PortOS merge path runs it. The pending-merge sweep
and the quality-snapshot publisher merge when the forge reports the PR mergeable
with its required checks green, pinned to the recorded or published head. CI
already tests each pull request on its merge ref, skips every runner for a
`.quality.json`-only change because no guard reads that file, and scheduled CI
on `main` publishes `Full CI Gate` as the post-merge backstop. Snapshot
checkouts a guarded merge retained before this change are retired once their PR
is merged or closed.


### Browser workload partition

The browser job uses two runners. Each receives the complete planner selection
and `CI_SHARD`; the runner assigns files by alternating the canonical
`BROWSER_SUITES` registry before subtracting any memo entries. Scoped selections
keep those same owners. This separates the long document-rendering and HTML
composition suites, which the generic Vitest hash partition clustered together.
Unknown browser selectors fail rather than being dropped.

Each shard retains the full selected browser profile, the quiet capture project,
normal motion, fidelity assertions, process containment and the existing
720-second supervisor deadline. `CI Gate` consumes the matrix's aggregate result,
so every selected shard must pass. Transform artifacts, test memos and failure
artifacts have distinct shard keys; a passing shard cannot replace its sibling.

### Vitest runner tuning

On GitHub Actions, `CI=true` caps the server Vitest runner at `maxWorkers: 4`
(`scripts/vitestCiPool.js`, spread into `server/vitest.config.js` and
`client/vitest.config.js`). Standard Linux runners for public repositories are
[4 vCPU / 16GB](https://docs.github.com/en/actions/reference/runners/github-hosted-runners);
uncapped forks oversubscribe those cores during transform. Locally, Vitest workers
are `cores / maxConcurrentAgents` from the CoS settings (`scripts/lib/cosWorkerBudget.js`),
capped at 4, so concurrent worktree gates share one host budget; lower
**max concurrent agents** in the app to ease load — no env var. A focused file
run is not the full-suite result (`docs/CONTRIBUTING.md`). `npm run pregate`
passes the derived value to its stages. The DOM-heavy client retains its proven two-worker override:
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
so never helped. `client/src/test/timeouts.test.js` fails CI on an inline
`waitFor`/`findBy*` bound at or above the per-test budget — recognised by the
option object's keys, so `{ timeout, interval }` counts and a fixture record
that merely holds a `timeout` field does not. It asserts the EFFECTIVE runtime
values rather than the module constants, so a `configure()` that stopped being
applied is caught too. A file that raises its own budget with
`vi.setConfig({ testTimeout })` is exempt.

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

Four jobs install the server workspace — `server`, `database`, `browser`,
and `windows-server`. `setup-node`'s `cache: npm` only preserves `~/.npm`, the
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
  `steps.node.outputs.node-version` would discard the entry on every Node 26.x
  release for no ABI benefit; the mark carries the exact ABI as a backstop. A
  test compares the literal against the job's own `node-version:` pin.
  `server/package.json` is in the hash alongside the lockfile so that skipping
  `npm ci` does not also skip its manifest-vs-lockfile agreement check.

Hit rate comes from the nightly full run. There is no push trigger on `main`, and
a cache written by a pull request is visible only to that branch — so the 09:17
UTC schedule is what seeds the entries on the default branch, the one scope every
PR branch can read. A PR that changes the lockfile misses by design.

Two entries exist per key state (Linux, shared by `server`, `database` and `browser`, plus
Windows) at roughly 570 MB each, against GitHub's 10 GB per-repo cache budget.
Eviction is LRU, so the constantly-read `main` entries outlive the PR-scoped ones
— but a burst of lockfile-churning PRs can still push out the transform caches
and `~/.npm`. If that starts showing up as unexplained cold runs, the dependency
cache is the part to drop: the CUDA skip above carries most of the saving on its
own.

### Shallow checkouts

Only the path-gated **Shipped prompt history** job clones full history (it
reads every past stage-prompt body). `actions/checkout` runs at `fetch-depth: 2`
in every job that diffs against the base. The two gate jobs set no depth at all
(the action's own default is 1) and pass `sparse-checkout: scripts` instead:
they check out only to run `scripts/ci-gate-report.js`, never look at history,
and sparse mode makes the action fetch with `--filter=blob:none`. Depth 2 on a
pull request is the merge ref plus both of its parents — and the
first parent *is* the base-branch commit the pull request is diffed against.
`scripts/ci-base-sha.js` reads it (`HEAD^1`) and exports `CI_BASE_SHA` for the
rest of the job, so the planner's `git diff <base>...HEAD` resolves without
deeper history. The planner passes the resulting source paths to the runner,
which resolves them through its own module graph; Vitest no longer performs
its own Git diff.

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
  file backend under `NODE_ENV=test` and does not need Postgres). The smoke is
  hermetic (#8343): `scripts/smoke-boot.js` boots against a disposable install
  root seeded like a fresh install, with an allowlisted environment and
  `PORTOS_SMOKE_BOOT=1` so no scheduler, agent recovery, or peer sync starts —
  `npm run smoke` behaves the same on a clean checkout and on a live install. The install
  and the native-addon rebuild are skipped when a `server/node_modules` cache is
  restored and its trusted-rebuild mark checks out. The impact job (which
  always runs, even when the planner skips the server job) runs
  `npm ci --prefix autofixer` — uncached and never skipped, because resolving
  that workspace's tracked lockfile *is* the check — and `node --check
  server/index.js`. It is the only CI step that installs `autofixer/`, which
  `npm run setup` and `scripts/ensure-deps.js` install on every user's
  machine; without it a lockfile that stopped resolving shipped green and
  failed at setup time. (`browser/` gets no such step: zero dependencies, and
  its lockfile is deliberately gitignored.)
- **Client tests and build** — affected client tests, plus the production build
  whenever client source changed. The build runs on shard 1 only.
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
- **Browser suites** (their own `browser` job, beside DB tests) — the exact
  `BROWSER_SUITES` registry in `scripts/lib/browserSuites.js` owns these tests.
  Server unit runs exclude that registry whenever `PORTOS_CI_BROWSER_OWNER=unit`
  is exported (Linux server shards, and `npm run pregate` on every platform);
  other browser files, including `overlayTextService`, keep their existing owner.
  The planner selects affected registered files and the browser job requires
  Chrome, FFmpeg and bundler prerequisites instead of silently skipping them.
  Ordinary PRs run the `smoke` profile: all existing assertions except the
  explicitly tagged `[fidelity]` grading/authoring cases. Scheduled, release,
  and dispatched full runs also execute ordinary fidelity cases. The explicit
  `[local-performance]` playback case runs only in local fidelity, including when
  hosted CI selects `full`. Hosted profiles retain generated Three render/export
  and owned cleanup coverage. Profiles do not change pixels,
  render settings, tolerances, or cleanup assertions.
  They ran after the DB suite on one job until that job set the run's length
  more often than any other; split, each finishes in about the time of its own
  steps.
- **Windows native contracts** — one runner for CLI/TUI execution and prompt
  submission, cmd/PowerShell behavior, process settlement and filesystem/path
  compatibility. Relevant source/tooling changes and explicit full validation
  select it. Application import graphs and platform-neutral product suites stay
  on the primary jobs; see "Windows native contract coverage" below.

- **Node minimum compatibility** — installs every workspace and runs the
  runtime gate on the oldest supported Node. On a pull request it runs only
  when a `package.json`, a lockfile, an `.npmrc`, `.nvmrc`, the gate script or
  its `directInvocation.js` import, its drift test or `ci.yml` changed, since nothing else can change its answer; non-PR runs
  always run it.
- **Shipped prompt history** — the one job with a full-history clone; it checks
  that every stage-prompt body ever shipped is accepted by a prompt migration.
  On a pull request it runs only when the impact planner's `prompt_history`
  output is true: the diff touches `scripts/migrations/`,
  `data.reference/prompts/`, `server/services/taskPromptDefaults`, the
  integrity-snapshot regenerator, `ci.yml`, or any module the guard or a
  hash-declaring migration statically imports (`PROMPT_HISTORY_PATH_RE` and
  `collectPromptHistoryInputs()` in `scripts/ci-test-plan.js`). Non-PR runs
  and pull requests into `release` always run it, and `npm run pregate` runs
  it locally when selected.
- **Linux worker containment** — runs `LINUX_CONTAINMENT_TESTS` against real
  bubblewrap namespaces on ubuntu-22.04. On a pull request it runs only when
  the `linux_containment` output is true: the diff touches the static import
  closure of those tests and the server Vitest harness, `server/package.json`,
  `server/package-lock.json` or `ci.yml`. The closure is recomputed from the
  head tree on every run, so a new dependency is gated without a list edit.
  Non-PR runs and pull requests into `release` always run it. Pregate reports
  it as CI-only.
- **Docker containment live** — runs the opt-in live suite of the Docker
  containment profile (`server/services/dockerContainment.live.test.js`,
  [CONTAINMENT.md](CONTAINMENT.md)) against the ubuntu runner's native Docker
  Engine: non-root user, no host home or Docker socket, no network in the
  validate phase, registry-only egress in the install phase, kill-and-remove on
  timeout, and lifecycle writes kept out of the host worktree. It is part of
  `CI Gate`. On a pull request it runs only when the
  `docker_containment_live` output is true: the diff touches the static import
  closure of the live suite and the server Vitest harness,
  `server/package.json`, `server/package-lock.json` or `ci.yml`
  (`DOCKER_CONTAINMENT_LIVE_ENTRIES`, `DOCKER_CONTAINMENT_LIVE_PATH_RE`).
  Non-PR runs and pull requests into `release` always run it. Pregate reports
  it as CI-only. CI has no macOS Docker, so Docker Desktop is verified manually.
- **SuperCollider native containment** — builds `docker/supercollider/`, runs
  `npm run setup:supercollider` twice and executes the opt-in live suite
  (`server/services/superColliderRender.live.test.js`) against real Docker on
  native amd64 and arm64 runners. It is the only run of the container boundary
  for untrusted generated `sclang` source, and it is part of `CI Gate`: a red
  run blocks the merge, a skipped one passes. On a pull request it runs only
  when the `supercollider_live` output is true: the diff touches the static
  import closure of the live test, `scripts/setup-supercollider.js` and the
  server Vitest harness (so the spawn, kill and child-environment helpers it
  depends on select it), `docker/supercollider/`, a `package.json` or
  `package-lock.json`, or `ci.yml` (`SUPERCOLLIDER_LIVE_ENTRIES`,
  `SUPERCOLLIDER_LIVE_PATH_RE` and `collectSuperColliderLiveInputs()` in
  `scripts/ci-test-plan.js`). The closure is recomputed from the head tree on
  every run, so a new import is covered without a list edit. Non-PR runs
  (nightly) and pull requests into `release` always run it; `workflow_dispatch`
  of `CI` is the manual evidence run. Pregate reports it as CI-only.
- **CI Gate** — always reports one stable required-check result and fails if any
  selected job failed or was cancelled. Both block, but the message distinguishes
  them: `scripts/ci-gate-report.js` says *cancelled, not failed* and names the
  cancelled jobs when nothing actually failed — as far as the gate job itself
  runs, which a run-wide cancel prevents. See "External cancellation and one
  automatic retry" below. A job the planner skipped
  counts as passing here; the impact summary and `suite_reasons` say which
  ones, and why.
- **Full CI Gate** — published only when the plan chose the complete suite and
  the supported native Windows contracts, with the full browser profile executed in hosted CI.
  Ordinary PR smoke runs cannot publish it, and neither can any run whose plan is not full. It mirrors `CI Gate`'s result. This is the check the release workflow
  looks for; see "Reusing the release PR's CI run" below.

### Browser fidelity cases

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

### Full-suite sharding

A full plan is the slow case: on the 4-vCPU public runners the client suite
alone took ~10 minutes (DOM setup per file dominated — the 868-file run
spent 489 s in `environment` against 384 s in `tests` — and its worker cap is
two, see `scripts/vitestCiPool.js`), the Windows server suite ~10 minutes
(module import is several times slower there), and the Linux server suite ~6
minutes. Roughly half of all PR runs went full, so most PRs waited on the
longest of those.

Primary server/client test jobs use matrices. The impact job emits
`server_shards` and `client_shards` from `FULL_SUITE_SHARDS` (server 2, client 3).
Windows emits `[1]` for its native contract runner. `scripts/run-ci-tests.js`
turns `CI_SHARD=<index>/<count>` into a disjoint path-hash file slice before
launching Vitest; the union is the complete selected suite. Windows uses exact
native selectors and never repeats a related-graph traversal. Scoped Linux plans fan out the same way
(`fansOut()` in the planner): a server `related` plan always does, because its
import-graph reach is unbounded by the explicit selector count (scoped server
runs took 6.1 min median, 9.4 p90, on one runner), and either runner does when
its explicit selection exceeds `MAX_TARGETED_TEST_FILES` (125). That cap used to
force a full plan for the whole repository; it now keeps the scoped selection
and only partitions it, so a server-only overflow no longer starts three client
shards, the DB/browser suites, and a Windows run (#11871). Exact-file plans
under the cap and client `related` plans stay on one runner. Vitest refuses a
shard count above the number of files it resolved, so a runner fans out only
when at least that many explicit selectors are files the Linux job actually
runs (DB and browser suites have their own jobs); each primary shard repeats Vitest's related-graph pass. Once-only steps — smoke boot and the client build —
pin themselves to shard 1; lint is not among them,
because it has its own job (see above). `CI Gate` sees a matrix job as one
`needs` result, so nothing downstream changes; public-repo runner minutes are
free, so the fan-out costs only concurrency.

`scripts/run-ci-tests.test.js` pins the wiring: every runner job builds its
matrix from the planner, hands `CI_SHARD` to the runner, and gates its
once-only steps on shard 1.

### What a full plan costs the Windows job

Windows CI covers the supported native boundary: CLI/TUI launch and prompt
submission, cmd/PowerShell execution and quoting, process cancellation/settlement,
and filesystem/path semantics. It runs the explicit `WINDOWS_CONTRACT_TESTS`
registry on one Windows runner. It does not follow the application import graph
or duplicate platform-neutral application suites, including on full, scheduled
and release validation. Full primary server/client/browser/database coverage is
unchanged. Worker concurrency remains two and existing deadlines remain intact.

Native changes and Windows-installed dependency/tooling changes select the native
job. Client-only configuration, known platform-neutral schema/package changes
and ordinary application changes do not select it. An explicit full run includes
it. A missing native inventory fails plan publication instead of producing a
successful empty Windows job. Required `CI Gate` still waits for every selected
job. `Full CI Gate`, used for release reuse, requires a full primary plan and the
selected native Windows contract set, with a successful aggregate gate.

### Primary functional coverage and secondary compatibility

Run the functional suite once on the primary environment. Secondary OS/browser
coverage consists of basic app/runner smoke checks and focused compatibility
regressions. A Safari-specific report should yield a generic compatibility
contract where possible, or a small WebKit regression when the engine is
necessary, rather than a second full application suite.

The current browser job uses Chrome/Chromium via `scripts/lib/testChrome.js`.
Its two jobs are disjoint file shards selected by `CI_SHARD`; they are not two
browser engines or duplicate executions of every suite. Each selected browser
file runs once. No Firefox/WebKit full-suite matrix exists to remove. Existing
browser suites retain their distinct substantive assertions; this audit adds no
speculative cross-browser matrix.

### Windows native contract coverage

The canonical registry is `scripts/ci-test-plan.js` (25 files):

| Boundary | Retained suites |
| --- | --- |
| CLI launch, lookup, environment and cwd | `allowedCommands`, `agentGuard/index`, `bashResolver`, `bufferedSpawn`, `cliProviderRun`, `detachedSpawn`, `processEnv`, `processEnv.spawnOptions`, `spawnCwd` |
| Shell dialects and TUI submission | `shellCd`, `shellExit`, `shellLivenessProbe`, `shellReadinessProbe`, `tuiPromptRunner`, `shell.windows` |
| Native cancellation, ownership and filesystem safety | `execGit`, `windowsAgentProcess`, `windowsGitProcess`, `windowsGitProcess.protocol`, `gitRepositoryIdentity`, `checkoutRetirementAdmission`, `worktreeOwnership`, `staticImportGraph`, `nativeTrash`, `nativeTrash.smoke` |

`server/services/shell.windows.test.js` uses real ConPTY with cmd and PowerShell,
a tiny local CLI stand-in and synthetic prompt/reply files. It verifies exact
prompt submission, child environment and working-directory handling with spaces,
metacharacters and literal brackets. It also checks native path casing and
separator containment. It calls no provider and loads no model.

Application routes, PM2 parsing/standardization, media and ML jobs, provider
selection policy, static source pins and broad Git-history/archive workflows
remain covered in the primary jobs. No migration, data-integrity, security,
ownership, cleanup or cancellation assertion is deleted for this selection
change. In particular, `primaryCheckoutGuard.test.js` and `worktreeReap.test.js`
still test shipping ownership/retirement behavior on the primary runner. Their
broad real-Git histories/configuration fixtures are not native CLI contracts.
Native Git child ownership and settlement remain independently exercised on
Windows; a failure there must still be fixed, not hidden by this boundary.

### Windows selection for mixed changes

Windows source changes select the curated contracts directly, with no related
application consumers. Linux retains the complete diff-selected server coverage.
The representative `windowsGitProcess.protocol.test.js` plus `zodCompat.js` diff
therefore retains the schema's primary-platform coverage while selecting the
native Windows set on one runner.

Before this support-boundary change, pipeline/full plans selected four Windows
jobs over the server inventory. At that change, they selected one job over 23
native suites; the curated set can grow as native contracts are added.
This is a measured selection/setup reduction, not an execution-time or
runner-minute speedup claim. The obsolete Scalar package/chunk absence suite and
its extra post-build invocation are retired; the actual rendered API Explorer
contracts and production client build remain.

### Windows full-suite capacity

Historical full-run evidence is retained for comparison. On run
[40420582344](https://github.com/atomantic/PortOS/actions/runs/40420582344), the
workflow took 25m37s; Windows shard 1 took 24m46s, including 23m20s in its test
step. Windows shard 2 failed native Git startup and cleanup; the other Windows
shards passed. This was not a controlled before/after experiment and does not
establish the startup cause or a runtime improvement from the new selection.

Run [40425197057](https://github.com/atomantic/PortOS/actions/runs/40425197057)
also exposed a 30-second Windows timeout in the Metal profile cache persistence
test. Its source requests 130 concurrent learn updates against a temporary JSON
cache to verify the 128-entry bound, reload and expiry. Those assertions retain
value on the primary platform; they do not justify a native Windows media suite.
The new native TUI fixture writes only a small script and synthetic reply per
shell, with no repository/dependency copy, media payload or model data. Cleanup
waits for actual ConPTY exit before removing its fixture.

### Python sidecar scripts

`scripts/*.py` (the LTX-2, MiniMax, FastVideo, and download sidecars) used to
be "unclassified changed files" and forced the complete matrix on every edit.
Vitest's import graph cannot reach into them, but ~45 suites pin their
contracts by reading the `.py` source as text (argparse flags, MLX pins, model
paths). The planner now resolves the suites naming each changed script with
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

### Test memo

`scripts/run-ci-tests.js` skips a selected test file whose every input is
byte-identical to one a trusted green run already verified, locally under
`npm run pregate` and in CI through the same code path. Each selected file
gets two content-addressed keys (`scripts/lib/testMemo.js`):

- the **floor** key hashes the working-tree bytes of the file's static +
  dynamic module closure (`import`/`export … from`, `require()`, `import()`,
  `vi.mock`/`vi.doMock`/`vi.importActual`/`vi.importMock`/`vi.unmock`, all
  with literal specifiers);
- the **recorded** key hashes the modules the file actually loaded in the
  green run that produced its entry (Vitest's
  `experimental.recordDependencies` depfile, cleared before each run so only
  this run's records count). A module the test mocks away or never reaches
  cannot change its outcome, so a change to the lazily imported server
  cluster invalidates only the suites that loaded it; a new edge still
  invalidates because the importer's own bytes changed. Only plain import
  edges are narrowed this way: JS a member reads as text, spawns, loads
  with `require()`/`createRequire` or runs as a worker, and JS named through
  `readServerSource`/`readClientSource`, is a side module that stays in
  every key together with its own closure.

Both keys also cover: every non-JS file a member names through a literal path
anchored at `import.meta.url`, `__dirname`, `process.cwd()` or an identifier
bound to one of those (a literal directory contributes its whole tree, up to
400 files; snapshot files and each `FIXTURE_OWNERS` directory — or only
its direct children when the owner sets `fileRe` — are added for the test
itself); the installed version of every package the
members reach (so a lockfile bump invalidates exactly the suites that reach
the bumped packages); a Python sidecar's resolvable sibling imports; the
version of an external program a member reaches (`TEST_MEMO_TOOLS`: the
python the sidecar tests spawn — a literal, `PORTOS_TEST_PYTHON`, or an
interpreter bound from `resolveTestPython()`; ffmpeg/ffprobe; and Chrome for
the browser suites, found with the suites' own candidate list,
`resolveTestChrome` in `scripts/lib/testChrome.js`); an unknown program
handed a `.py` file fails closed; the workspace Vitest config closure, setup files,
`scripts/vitestCiPool.js`, `package.json` and lockfile (the workspace base,
below); the full Node
version, `process.platform`, `process.arch`; and `TEST_MEMO_ENV` (`CI`,
`NODE_ENV`, `PORTOS_BROWSER_TEST_PROFILE`, `PORTOS_CI_BROWSER_OWNER`,
`PORTOS_REQUIRE_BROWSER_SUITES`, `PORTOS_REQUIRE_LINUX_CONTAINMENT`,
`PORTOS_TEST_QUIET`, `PORTOS_TEST_PYTHON`, `CHROME_PATH`, `TZ`, `LANG`,
`LC_ALL`, `CI_EXPECT_SLASHDO_SUBMODULE`, …).

The workspace base leaves out two things that cannot change what a
collected file proves. The test-selection modules the configs import only
for `include`/`exclude` (`WORKSPACE_SELECTION_MODULES`:
`scripts/lib/workspaceTests.js`, `scripts/lib/dbTestFiles.js`,
`scripts/lib/browserSuites.js`) decide which files run, so adding a suite to
`DB_TEST_INCLUDE` no longer moves every key; a test that imports one keys it
through its own closure. And the walk does not follow a bare
`vi.mock`/`vi.doMock`/`vi.unmock` registration: setup's global
`vi.mock('./services/instances.js', …)` loads nothing until a test imports
`instances.js`, and then that module and its closure are in the test's own
closure (a non-literal edge fails the floor key closed) or record. What the
setup files really import (`mockPathsDataRoot.js`, `fileWriteQueue.js`,
`test/admissionSetup.js`, …) stays in every key. Before this, the floor
base pulled in instances.js's ~100-file product closure, so an edit to
`catalogValidation.js` changed every floor key and pull requests never hit
the nightly memo.

The recorded key takes the setup phase from the record too. Vitest's depfile
lists, in every test file's record, the modules its custom environment and
`setupFiles` loaded, so for the setup entries the config reaches
(`WORKSPACE_SETUP_ENTRIES`: `server/vitest.setup.js` and
`server/test/mediaRegistryEnvironment.js`, `client/src/test/setup.js`) the
recorded key's workspace base stops the static walk at them: a module the
setup files only mock or never load (`services/instances.js` and its
closure) no longer invalidates every recorded key. A record that does not
name every setup entry (a per-file environment pragma) keeps the full static
base, and a setup-phase problem the static walk finds still fails both keys
closed. The floor key always walks the setup closure (less bare mock
registrations).

**Never memoized (fails closed).** A file in the planner's `ALWAYS_RUN_TESTS`
or in `TEST_MEMO_NEVER` (the tree-wide convention and catalog scanners); a
file whose closure contains the `// test-memo: never` marker; a test file or
`scripts/` module that spawns `git` (repository state is not in the key —
product modules that run git on their own targets are under the test's
control); a test file or `scripts/` member that reads machine-local state
(`data/`, the home directory); a member that reads a path the analyzer
cannot resolve (`import.meta.glob`, anything under `.git/`, a non-literal
`readServerSource`/`readClientSource`, a literal directory with more than
400 files); a bare specifier that resolves to no installed package; and, for
the floor key only, a non-literal `import()`/`require()` or an unparseable
member. Two non-literal `require()` shapes are keyed instead: `require(CONST)`
with a module-level string is that bare specifier (package version), and
`require(join(<unknown dir>, 'name.cjs'))` keys every tracked file of that
basename. A Python `importlib.import_module('x')` follows like `import x`; a
computed name is not memoizable. `import(variable)` stays outside the
recorded key by design: only what the green run loaded is keyed. A recorded set that reaches outside the repository is not memoizable
either. Every unknown construct lands in one of those buckets rather than
silently narrowing the key.

**Store.** `~/.portos/test-memo/` (override with `PORTOS_TEST_MEMO_DIR`):
`entries/<key[0..2]>/<key>.json` holds `{ test, workspace, verifiedAt,
source: 'local'|'ci', commit }`, `records/<workspace>/<sha256(test)>.json`
the loaded-module list. Writes are temp-file-plus-rename so concurrent
worktree pregates never tear a file; any read error is a miss, and so is an
entry older than 14 days, so the nightly re-verifies what it keeps skipping.
Entries are written only from a Vitest process that exited 0 whose run-level
report (`scripts/vitestRunDiagnostics.js`) ended `passed` with no unhandled
error — a rejection after the last test still marks every file `passed` in
the JSON report — and only for files that report shows passed with no failed
and no skipped case (a browser profile's name pattern is the one accepted
skip reason). Every key is recomputed after the run and written only when it
still matches, so a file edited while Vitest ran is never attributed to the
verdict. The runner prints one line —
`🧠 Test memo: skipped N of M selected files (closure unchanged); running K.`
— and lists the skipped files under `PORTOS_TEST_MEMO_VERBOSE=1`. When every
selected file is memoized nothing is launched and the job exits 0.

**Shards.** A matrix shard takes its slice of the FULL selected list with
Vitest's own hash-sort-and-range algorithm (`vitestShardSlice`, pinned
against a real `vitest run --shard`) before the memo subtracts anything, so
every file lands in exactly one shard whatever each shard's store holds;
Vitest itself is never given `--shard`.

**CI seeding.** The server, client, browser and Windows jobs restore
`${{ runner.temp }}/portos-test-memo` with `actions/cache/restore` under a
per-job, per-shard key prefix (`test-memo-<os>-<arch>-<job>-<shard>of<n>-`).
Server, client and Windows restores prefer that partition, then fall back to
the newest memo from any shard of the same OS, architecture and job. Trusted
full runs never seed a scoped `1of1` lineage, so an exact-partition-only lookup
would leave those jobs permanently cold. A fallback contains only one shard's
entries: matching content keys may skip those tests; all other selected tests
still run. Partitioning happens before memo lookup, so changing the memo's
source shard cannot omit or duplicate a selected test.
Pull requests only read. The scheduled nightly, `workflow_dispatch` and
`workflow_call` runs on the default/release branches save a new entry keyed
by run id, and only when the test step itself succeeded, so the cache holds
nothing a pull-request branch or a red run wrote and every PR restores the
newest trusted lineage. The DB job runs the `db` scope
(`node scripts/run-ci-tests.js db`, the serial `portos_test` suite) and keeps
its own `-db-` lineage. The DB config, `server/scripts/init-db.sql` and
`server/scripts/setup-db-test.mjs` are base inputs (a schema change
invalidates every key) and `PGDATABASE` is a keyed env var.

**Disable.** `PORTOS_TEST_MEMO=off` turns reads and writes off together and
restores the pre-memo behavior. A test spawned under Vitest (`VITEST` set)
never touches the developer's store unless it sets `PORTOS_TEST_MEMO_DIR`.

No third-party change-filter action is used. The planner passes test paths as a
JSON argument array to `spawnSync`, never through shell interpolation.

### Full CI

The complete server, client, DB, lint, build, and smoke suite runs:

- on every pull request whose base branch is `release` (the release gate);
- on the schedule, 09:17 and 21:17 UTC;
- from manual workflow dispatch;
- as a reusable workflow called by a release whose tree has no verifiable gate.

There is **no push trigger on `main`**. A merge commit on `main` re-tests a
tree whose PR gate is already green, so the run was pure duplication; the
nightly full run is what catches a semantic conflict between two independently
green PRs, and the candidate → `release` PR catches it before a release ships.

A red scheduled run cannot point at a PR, so the gate's last step
(`scripts/ci-nightly-report.js`, scheduled runs only) writes the suspect list to the run
summary: the failing jobs and steps, plus every pull request merged since the last
**green** scheduled run (the Compare API against that run's head). An unreadable range or
a missing earlier green run is reported as such, never as "no suspects". To bisect, run the
failing suite at a merge in the middle of the list and halve it.

Changes to CI/test configuration also force the full suite on their own PR.
`[skip ci]` remains honored for push events only; PR CI always runs.

### Failures do not cancel other jobs

A failing job does not cancel its siblings, and every matrix sets
`fail-fast: false`. The run finishes with the failing job concluded `failure`
and the rest concluded on their own results, so **Re-run failed jobs** repeats
only the red shard. Runners on this public repository are not billed, so the
siblings that keep running cost concurrency, not money.

**Cancelled is not mergeable.** Every consumer allowlists green results:
branch protection requires `CI Gate` to conclude `success`; the gate accepts
only `success` or `skipped` per job; `scripts/verify-ci-status.js` accepts a
`Full CI Gate` only at `success`; and PortOS's auto-merge watcher
(`server/services/prWatcher.js`) counts only `SUCCESS`/`NEUTRAL`/`SKIPPED` as
green.

### Windows native worker crash evidence

When Vitest reports a worker exit with a crashed test filename, the test
launcher queries Windows Application Error event 1000 before the existing
single-file retry, and again if that retry crashes. Each query is limited to
the failed invocation's time window, 32 events and 10 seconds. Logs and the
step summary retain at most ten Node event candidates: Node/module versions,
module basename, exception code and fault offset. Raw event messages, paths,
machine identity and memory dumps are excluded. Diagnostic failures do not
change the test result or add retries.

These events can narrow the native module involved; they do not establish
causality or identify the triggering operation. A missing or unavailable
event is explicitly inconclusive. Correlate candidates with the crashed
test and a minimal Windows reproduction before changing production metadata
handling (#8152). Microsoft documents these fields in its
[application crash troubleshooting guide](https://learn.microsoft.com/en-us/troubleshoot/windows-server/performance/troubleshoot-application-service-crashing-behavior).

### Final test process exit evidence

The run report retains the exit-code snapshot from Vitest's normal hooks and
adds the later Node `exit` event code and `process.exitCode` in a synchronous,
best-effort write. The invocation report records the observed command boundary
(`direct npm process`, or `cmd.exe -> npm.cmd` when a batch wrapper is needed), its child `exit` and `close`
events, and the launcher's effective status. Collection prints only bounded
numeric status and allowlisted boundary names. Missing exit evidence stays an
explicit diagnostic gap; diagnostic I/O never changes the original result.

An exit event is later evidence, not proof of a cause or of every subsequent
exit listener's behavior. When a Windows batch wrapper is needed, npm's own process exit is still not
observed independently of `cmd.exe`; a passing Vitest exit with a failing
command boundary narrows the remaining investigation to that boundary. Forced
termination can prevent any exit-event write. Preserve the first failing job
and compare these observations on a hosted recurrence rather than classifying
a green rerun or a synthetic fixture as a causal fix (#12536).

### External cancellation and one automatic retry

Not every cancel comes from this repository. When several PRs build at once,
GitHub itself cancels in-flight runs — no job fails, and **no successor run exists for the branch** (issue 7437).
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
| no job concluded `failure`/`timed_out` | A run cancelled while one job was already red *looks* cancelled. Retrying it would re-run the suite on a broken tree. |
| no job hit its own `timeout-minutes` | GitHub reports a timed-out job as `cancelled`; only its check-run annotation ("exceeded the maximum execution time") tells it from an external cancel (#11910). A re-run would time out again, so it skips as `job-timed-out`. |
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
a failing job's step records can still be settling when a cancel lands.

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
marker a failing job writes: a marker fails OPEN. A lost write makes a red run
look externally cancelled, and it gets retried. Reading conclusions fails CLOSED: an unreadable listing is
`jobs-unavailable` and skips the retry. Do not "simplify" this into a marker.

**This is also the only layer that can explain a run-wide cancel.** `if:
always()` on the gate defeats an upstream failure, not a cancellation of the
whole run — so in the external-cancel case the gate is cancelled too and never
prints its verdict. The recovery run is a separate run, so it survives; its
step summary records which guard applied.

That summary lives on the recovery run, which nobody finds from the pull
request, so the workflow also **publishes the verdict back onto the cancelled
head SHA as a check run** named `CI cancel recovery` (issue #7438). It carries
the same fixed reason code the step summary renders — `superseded`,
`job-failed`, `job-timed-out`, `re-dispatched`, `retry-budget-exhausted`, `run-state-moved-on`,
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

- A directory feature such as `server/services/sprites/` additively selects
  tests carrying the same feature segment across server and client. The feature
  name never identifies all consumers (a nested leaf can be imported by a
  differently named test in another area), so it does not replace traversal.
- Every runner with a changed behavioral source — flat, shared, or nested
  feature — runs one `related` invocation driven by the exact changed source
  paths, combined with the explicit selectors (feature, basename contract,
  guard, direct test) without duplicate execution. Directly changed tests are
  always included; a test-only or barrel-only diff keeps exact-file selection.
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
- A changed source's basename lookup (`git grep` of test files, #6363) keeps
  every hit for a unique basename. For a basename several tracked sources
  share (`index.js`, `providers.js`), it keeps only tests inside the source's
  directory subtree or whose text also names its parent directory, so a
  `server/cos-runner/index.js` edit no longer selects every test naming any
  `index.js` (#11870). Import-graph selection still reaches real importers.
- Unmapped executable files use related-test mode. Unclassified artifacts,
  shared roots/config, or more than 30 executable changes fail safe to full
  CI. More than 125 selected tests on one runner keeps the scoped selection
  and shards that runner instead.

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
   The first changelog heading should be `# Release v{version} - {Fun Name}`;
   the workflow uses that complete heading without `# ` as the GitHub release
   title, with `Release v{version}` as the backward-compatible fallback for
   older unnamed notes.
7. If a pattern changelog file (`.changelog/v{major}.{minor}.x.md`) was used,
   archives it on `main` (renames `.x.md` to the exact version).
8. An archive advances only `main`; `release` remains pinned to the verified tree.

Capture and resume candidates using [the release procedure](VERSIONING.md#creating-a-release).
Concurrent development merges do not change the candidate or its CI inputs.

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

The ordinary release merge satisfies this when the frozen candidate contains
the captured `release` base: the merge commit's tree equals the candidate head
that full CI validated. The current `main` tip is irrelevant.

Everything else fails closed and runs the complete suite again: a direct push to
`release`, a hotfix committed on `release` that changes the merge tree, a
missing, failed, or merely impact-scoped gate, or an unreachable checks API.

### Pinning the release tag to the verified tree

The release action creates a missing tag at the repository default branch
unless told otherwise, and main may have advanced since CI verified the release
push. `release.yml` therefore passes `target_commitish: ${{ github.sha }}`, and
`scripts/verify-release-tag.js` covers the case the input cannot: a tag that
already exists is peeled (annotated tags included) and its commit's tree must
equal the released tree. A different tree, a non-commit target, or any lookup
GitHub does not answer fails the job; the script is read-only and never moves
or deletes a tag. It runs again after publication to confirm the new tag landed
on the verified tree.

## Working with CI

### Skip CI

Add `[skip ci]` to push commit messages for generated documentation-only
changes. Auto-generated commits from the release workflow include this
automatically. Pull-request checks ignore this marker so a PR cannot bypass its
required CI gate.

### Force Full CI

Use the workflow-dispatch button for an immediate full run. A PR also chooses
full CI automatically when its impact cannot be classified safely.

### Before Push

Fetch the intended base and inspect the branch and working tree before pushing:

```bash
git fetch origin main
npm run pregate
```

Commit intended changes and push to the branch's verified remote destination.
Integrate the fetched base when there is an actual conflict, an enforced
up-to-date policy, or evidenced semantic overlap; rerun pregate after a rebase.
A moving main alone does not require a new head or another hosted CI run.
Managed merges follow the hosting-provider eligibility and pinned-head policy
in the root AGENTS.md; combined-tree guards remain available for investigation.

## Adapting for Sub-Projects

1. Copy `.github/workflows/ci.yml` and `.github/workflows/release.yml`
2. Update installation and build commands for your project structure
3. For monorepos, add package.json update steps for each workspace
4. Update the changelog file path pattern if different

### Impact job command and finalization evidence

The `impact` job records the fixed stages `admission`, `base`, `hidden-content`,
`import-case`, `plan`, `node-minimum`, `summary`, `autofixer-install`, and `syntax`
through `scripts/ci-impact-diagnostics.js`. Each stage logs its start and direct
child `exit`/`close` status and elapsed milliseconds. Its original stdout, GitHub
command files, environment inputs and nonzero status pass through; a signal or
spawn failure remains a failure. No additional provider calls or retries occur.

A random marker inherited only by that stage's command lets Linux `/proc` scans
count surviving same-user owned processes after close and at the final
`always()` checkpoint. The scan is limited to 4,096 process entries and one second
per snapshot. Public evidence contains only fixed stage names, numeric statuses,
signals, elapsed time, counts and coverage. Markers, PIDs, host paths, environment
values and raw command lines are not published. Private per-stage records stay
under the runner's temporary directory; they are not uploaded as artifacts.

`coverage=partial|unavailable`, missing records, or missing events mean unknown,
not clean. Even complete coverage is a point-in-time observation of processes
that retained their inherited marker; it cannot prove the absence of work that
removed its marker. Nonzero owned counts are evidence to investigate, not
permission to kill a process. The observer signals/deletes nothing and does not
claim to repair an orphan. A settlement change needs a reproduced owner and a
causal negative control first.

The final checkpoint precedes checkout post-actions and the runner's own
finalization. Interpret the first unconfirmed boundary in order: stage start →
command exit → command close → owned-process snapshot → checkout post-action →
runner `Complete job` → overall job result. A successful repository checkpoint
cannot attest the later runner/result-service handoff. Keep the ten-minute impact
timeout, fail-closed `CI Gate`, and real-job-timeout exclusion in cancel recovery.

#### Retained investigation: #13500

The [original attempt-1 impact job](https://github.com/atomantic/PortOS/actions/runs/40115698658/job/120936398030)
ran head `9ce1866c45a5ae517b81a82bdc31e3cf4af395e9` on merge `47b63aa` with
base `8b8ffd5e847a6dca5e5c10a479338c94d561195a`. Its planner ran
17:21:02.180–17:21:02.977 UTC on 2026-10-24. Checkout post-cleanup and job output
publication ended by 17:21:04.175; the final retained log line begins runner orphan
cleanup. The job was cancelled at 17:34:22 with the ten-minute timeout annotation.

Initial API reads returned no steps and some reads failed with HTTP 502. Fresh
reads during this investigation returned successful conclusions for every step,
including `Complete job`, completed at 17:21:04. That later evidence narrows the
first unconfirmed boundary to completion of the runner/job-result handoff; the
log line alone had left orphan cleanup unconfirmed. The API's successful timeline
record does not prove the overall job result was accepted.

The matching [runner v2.338.0 finalizer](https://github.com/actions/runner/blob/v2.338.0/src/Runner.Worker/JobExtension.cs)
performs orphan inspection before completing the `Complete job` context. The
[runner job completion path](https://github.com/actions/runner/blob/v2.338.0/src/Runner.Worker/JobRunner.cs)
then drains its reporting queue and submits job completion. These source paths
identify possible boundaries, not a demonstrated cause in this job. No retained
runner transport trace or matching public GitHub Status incident establishes
which operation failed. Neither a repository-created orphan nor a specific
upstream incident has been proved.

The [existing attempt-2 impact job](https://github.com/atomantic/PortOS/actions/runs/40115698658/job/120941724098)
passed at the same head from 17:44:31–17:44:48. That is non-reproduction, not a
cause-specific fix. The request to rerun attempt 1 with debugging was refused
because it was no longer the current attempt; no further rerun was started.
Preserve attempt 1. Future recurrence needs the fixed-stage evidence plus the
runner's completion/queue/transport diagnostics, with sensitive fields redacted,
before changing lifecycle behavior or attributing a GitHub incident.

### Superseded queued aggregate recovery (#13591)

A newly requested PR CI run can be pending without jobs because its older run
still owns the CI concurrency slot. The default-branch `CI cancel recovery`
workflow observes requests outside that group. It acts only when a fresh API
read proves the same PR/workflow/repository, a different older head, the current
PR head on the waiting successor, and exactly one unfinished old job: a queued,
never-started `CI Gate`. All other jobs, including cleanup, must be terminal.
Completed failed tests and their logs remain intact; recovery never publishes a
passing gate or changes `always()` failure reporting.

If the older run still has known live non-gate jobs when the successor is
requested, the observer waits read-only and re-inspects every 15 seconds, for a
single two-minute deadline that includes API work. Every poll verifies the same
old attempt and current waiting successor. Missing job data, identity changes,
or live work at the deadline stop recovery without cancellation. The queued,
never-started aggregate must independently qualify after the live jobs finish.

The observer then requests normal cancellation once, waits 45 seconds, and rechecks
all identities, jobs and the current PR head. Only an accepted normal cancellation
that still has not settled permits one force-cancel request. It reads back the
outcome and distinguishes settlement, accepted-but-pending, and uncertainty; an
uncertain write is never retried or escalated blindly. More than 100 jobs/runs,
missing data, a permission refusal, live work, same-head reruns, and changed heads
all stop recovery. The existing Actions write grant is reused without adding
permissions. Private repositories that cannot read the PR with that grant remain
held rather than expanding authority. No PR checkout or code executes in this
privileged observer; both scripts run from the default branch's sparse checkout.

## Bounded frozen release-candidate failure collection

CI explicitly sets `PORTOS_CI_TEST_POLICY=release-candidate` only for same-repository
`codex/release-*` pull requests targeting `release`. Ordinary PRs, nightly runs,
release pushes and local `test:ci` keep bail=1. The shared CI command entry point supplies one
bail flag, raises it to five for that policy, and disables both Vitest retries
and the launcher's native-crash retry. Nested bare Vitest runs retain their own bail policy rather than inheriting the
outer npm lifecycle setting. Existing worker caps, shard selection,
quiet groups, database isolation and deadlines do not change.

The lifecycle reporter records up to five assertion failures, preserving the
first. Failed hooks (including assertion failures in hooks), collection errors,
non-assertion errors, unhandled errors and process teardown timeouts stop safe
collection. Vitest receives graceful cancellation; the launcher independently
monitors atomic reporter evidence and cancels its owned process tree on unsafe
or malformed evidence, using existing escalation and settlement guards. Already
running work can finish during cancellation; its later output is **unverified**,
not additional independent regressions. Failed assertions are candidates for
investigation, not proof that failures are independent or predate an amendment.
Capped, interrupted, unsafe or missing-evidence runs remain red and cannot write
green memo entries. First-cause run evidence
and process-settlement refusals remain in each attempt's diagnostics directory.

`invocation.json` binds policy, candidate head, tested checkout, actual checkout
base, shard, selection digest, workflow run ID/attempt and start/finish times.
`run.json` contains the bounded assertion list, stop reason and coverage status;
the ordinary JSON report and process evidence remain available. Report coverage
as unverified after any stop, including tests that never ran. A successful shard
alone is not evidence that the whole candidate passed.

For hosted before/after comparisons, group workflow rounds by exact candidate
head/base and selection digest. Use Actions job queued/start/completion times to
separate queue time from execution time; sum job execution minutes for
runner-minutes and report failures collected per invocation. Keep non-reproducing
failures and classify amendment-introduced regressions separately from failures
shown to exist at the original cutoff. No hosted duration improvement is claimed
by this implementation; a local synthetic collection test cannot measure it.
