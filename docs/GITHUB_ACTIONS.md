# GitHub Actions Workflows

PortOS uses a test-impact-aware CI workflow plus a release workflow that cannot
publish until the complete CI suite has passed on the exact tree being released.

## Release Dependabot CI after review

Dependabot pull requests start with a small checkout/admission check only.
`Plan test impact` fails with a maintainer-release message before dependency
installation or tests, so the required `CI Gate` remains red. The optional
SuperCollider workflow uses the same check before installing or building.
Other pull requests, scheduled checks, releases and manual dispatches retain
their existing behavior. No schedule or repository security setting changes.

After reviewing the dependency diff, open the **current commit's** CI workflow
run and choose **Re-run all jobs**, or run `gh run rerun RUN_ID`. GitHub permits
reruns only to repository writers. If SuperCollider also ran, release that
workflow's current run separately. Re-running failed jobs also reruns their
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

### Local equivalent: `npm run pregate`

`scripts/pregate.js` runs the same planner over the committed and uncommitted
diff and hands its plan to the same runners, so a scoped plan is reproduced
locally stage for stage: hidden-content scan, lint, server and client tests,
the client build and its API Explorer bundle pin, the boot smoke, the browser
suites (smoke profile, prerequisites required rather than skipped), and the
serial `portos_test` DB suite last and alone. Each stage receives the
environment the matching job sets. A full plan runs only the always-run guards
unless `--full` is passed. A suite the machine cannot run (no reachable test
Postgres; no Chrome, ffmpeg or client bundler), or one left to CI with
`--skip-db`, `--skip-browser`, `--skip-build` or `--skip-smoke`, is reported
as not run — in the summary and in the receipt `.cache/pregate/report.json`,
which records the plan, stage outcomes and durations, the skipped suites, the
base and HEAD SHAs, and the hash of the exact working tree validated. The
shipped prompt-history guard runs locally when selected; the Windows job and
the Linux worker-containment job are the two suites only CI can prove. Details and the receipt
contract: `docs/CONTRIBUTING.md`.

### Pregate attestation

A green pregate on this machine runs the same planner, runners, environment
and `portos_test` database the Linux jobs do, so repeating those stages in CI
for the install's own pull requests buys queue time and nothing else (design
record: `docs/plans/2026-10-18-ci-local-first-merge-gate.md`). After the push,
`node scripts/pregate-attest.js` turns the receipt into a commit status on the
pushed head, and the impact planner skips what it attests to:

- **What is attested.** Only receipt stages that ran and passed: the
  hidden-content scan, lint, server and client tests, the client build and its
  bundle pin, the boot smoke, the browser suites and the DB suite, and the
  shipped prompt-history guard. A suite pregate reported as not run — skipped
  by a `--skip-*` flag, left to CI by a downgraded full plan, or missing a
  prerequisite — is not attested, and a downgraded full plan never attests
  its server or client stage (it ran the always-run guards, not CI's
  selection). A receipt planned with `--base` against anything other than the
  default branch's merge base attests no server, client or lint stage either:
  its diff-selected plan was narrower than CI's. The vocabulary is
  `ATTESTABLE_STAGES` in `scripts/lib/pregateAttestation.js`.
- **The tree binding.** The status description is
  `tree=<40-hex> os=<platform> node=<major> stages=<list>`: the receipt's
  `git write-tree` hash of the exact working tree pregate validated, untracked
  and uncommitted files included, plus the platform and Node major the stages
  ran on. `pregate-attest.js` refuses unless `<commit>^{tree}` equals the
  receipt's tree — anything changed after pregate means a rerun — and the
  planner compares it with the head commit's tree on the PR. A SHA is never
  compared, for the same reason `scripts/verify-ci-status.js` compares trees:
  the content is what was tested. The commit must already be on the upstream
  remote (the one `branch.<name>.remote` names); GitHub only accepts a status
  on a commit it has, which is why attesting is a step after `git push`, not a
  pregate flag.
- **The merge ref is not the head tree.** The receipt vouches for the head
  commit's tree; CI tests the merge ref, that tree plus whatever `main`
  gained since the branch forked. The planner reads that base-side diff
  (`git diff --name-only HEAD^2 HEAD`) and refuses the attestation **per
  stage** when it contains a test file the plan selected for that runner, a
  non-test source under the runner's roots (`server/`, `scripts/`, `lib/`,
  `autofixer/` for the server stages; `client/src/` for the client ones), or a
  runner config, setup, workflow or dependency-manifest file (which refuses
  every stage). Docs-only movement, or movement in the other runner, keeps
  the attestation. Each refusal names the path in `suite_reasons` and in the
  `attestation` output's `driftRefused`. In practice the local workflow
  re-syncs the branch onto `main` before pregate, so the drift is usually
  empty.
- **Who can post one.** A commit status on this repository can only be created
  by an actor with write access, and the planner honors only the newest
  `pregate` status — of any state — when it is a success whose
  `creator.login` is the repository owner. The `GITHUB_TOKEN` of a
  `pull_request` run from a fork is read-only and cannot create one; a
  Dependabot pull request is refused by author; a status by anyone else is
  ignored, and a newer one by anyone else blocks the owner's older success.
  The impact job holds `statuses: read` and nothing more (`release.yml`
  grants the same scope to the called workflow). CI is still the authority
  for every outsider.
- **Revocation.** `node scripts/pregate-attest.js --revoke "<reason>"` posts a
  `failure` status on the commit; because the newest status decides, every
  earlier attestation on that commit is withdrawn and the next run plans as
  if none existed. Use it when a local result turns out to be wrong (a flaky
  pass, a suite that was not really run).
- **Platform.** A macOS pregate may attest the Linux jobs: per the project's
  policy, other platforms are checked only when a change could plausibly
  break them, and the Windows job is the one platform-specific proof CI keeps.
  The one Linux-only failure a case-insensitive filesystem cannot see — a
  relative import whose case differs from the tracked path — is closed by
  `scripts/check-import-case.js`, which the impact job runs on every pull
  request before any stage can be skipped (it resolves every relative
  `import`, `import()` literal and `new URL(…, import.meta.url)` in the
  changed modules against `git ls-files` with exact spelling). The platform
  and Node major of the attesting run are in the status and in the plan
  summary's `Pregate attestation` line.
- **When it applies.** Only a same-repository pull request into a non-`release`
  base that was not forced full. The planner verifies the merge-ref checkout's
  second parent is the event's head (so the attested tree is compared with
  the right commit) and reads `repos/{repo}/commits/{head}/statuses`. A head
  committed less than five minutes ago with no `pregate` status yet is re-read
  for up to 90 seconds (10-second interval; the summary says how long it
  waited), because the status is posted after the push that started the run.
  When you open the pull request yourself, the order is push, attest, then
  `gh pr create`, so the status precedes the `pull_request` event. Any
  failure — API error, unreadable description, tree mismatch, wrong creator,
  a non-success newest status — leaves the plan exactly as computed and
  records the reason.
- **What CI still runs.** The impact job — its hidden-content scan, the
  import-case check, `npm ci --prefix autofixer` and the `node --check` of
  the server entry point (both moved here from the server job so an attested
  run cannot skip them) — the Windows job, the Linux worker-containment job,
  the Node-minimum check and the `CI Gate` itself always run as planned. The
  server job stays when its boot smoke is selected but not attested, because
  the smoke runs on that job. An attested run reports `full: false`, so
  `Full CI Gate` is never published on the strength of a receipt.
- **How to inspect it.** The impact job's summary prints a `Pregate
  attestation` line (`attested`, the head and tree, the platform and Node,
  the stages, `driftRefused`, or the reason none applied) and `suite_reasons`
  names each skipped suite as attested and each refused one with its path.
  On the commit: `gh api repos/<owner>/<repo>/commits/<sha>/statuses` lists
  every `pregate` status with its creator, state, description and timestamp;
  `node scripts/pregate-attest.js --dry-run` shows what would be posted for
  the current receipt and HEAD without posting it.

### Vitest runner tuning

On GitHub Actions, `CI=true` caps the server Vitest runner at `maxWorkers: 4`
(`scripts/vitestCiPool.js`, spread into `server/vitest.config.js` and
`client/vitest.config.js`). Standard Linux runners for public repositories are
[4 vCPU / 16GB](https://docs.github.com/en/actions/reference/runners/github-hosted-runners);
uncapped forks oversubscribe those cores during transform. Local `npm test`
is unbounded so a developer machine can use every core. The supported full
local validation is `PORTOS_PREGATE_MAX_WORKERS=4 npm test` (see
`docs/CONTRIBUTING.md`); a focused file run is not that result. `npm run pregate` exports `PORTOS_PREGATE_MAX_WORKERS` (default 4,
overridable) so concurrent worktree gates on one host bound their Vitest
workers; it can only lower a workspace's cap (client stays at 2), and direct
test runs ignore it unless you set it. Divide the host between simultaneous
gates, e.g. `PORTOS_PREGATE_MAX_WORKERS=2 npm run pregate`. The DOM-heavy client retains its proven two-worker override:
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
  `steps.node.outputs.node-version` would discard the entry on every Node 24.x
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
  always runs, even when a pregate attestation skips this one) runs
  `npm ci --prefix autofixer` — uncached and never skipped, because resolving
  that workspace's tracked lockfile *is* the check — and `node --check
  server/index.js`. It is the only CI step that installs `autofixer/`, which
  `npm run setup` and `scripts/ensure-deps.js` install on every user's
  machine; without it a lockfile that stopped resolving shipped green and
  failed at setup time. (`browser/` gets no such step: zero dependencies, and
  its lockfile is deliberately gitignored.)
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
- **Windows server tests** — the same server selection, but only on full CI
  (the `main` → `release` PR, nightly, release, workflow dispatch) or when a
  Windows-sensitive surface changed (`.ps1` / `.cmd` spawn, PowerShell BOM,
  `bufferedSpawn`, `cos-runner`, shell/PM2, etc.). Docs-only and ordinary
  Linux-faithful PRs skip this job. `pinPlatform('win32')` tests still run on
  Linux. A full plan does not automatically mean a full *Windows* run — see
  "What a full plan costs the Windows job" below.
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
- **CI Gate** — always reports one stable required-check result and fails if any
  selected job failed or was cancelled. Both block, but the message distinguishes
  them: `scripts/ci-gate-report.js` says *cancelled, not failed* and names the
  cancelled jobs when nothing actually failed — as far as the gate job itself
  runs, which a run-wide cancel prevents. See "External cancellation and one
  automatic retry" below. A job the planner skipped on a pregate attestation
  counts as passing here like any other skipped job; the impact summary and
  `suite_reasons` say which ones, and why (see "Pregate attestation").
- **Full CI Gate** — published only when the plan chose the complete suite and
  full Windows coverage, with the full browser profile executed in hosted CI.
  Ordinary PR smoke runs cannot publish it, and neither can a run that skipped
  any stage on a pregate attestation — the planner reports `full: false` for
  those. It mirrors `CI Gate`'s result. This is the check the release workflow
  looks for; see "Reusing the release PR's CI run" below.

### Browser fidelity cases

Pull requests run the browser suites' smoke profile, which skips the
`[fidelity]` grading cases. Those cases run in hosted CI on the nightly
schedule, on the `main` -> `release` pull request and on dispatched full runs,
so a fidelity regression shows up there rather than blocking the PR that
caused it. The `[local-performance]` playback case runs only locally.

To check the fidelity cases on a PR before merging, run
`node scripts/browser-fidelity.js --pr NUMBER` from its clean checkout with
existing `gh` authentication. It runs the registered fidelity cases, keeps a
local receipt, and publishes an exact-commit status for the PR head. That
status is informational: no required check reads it. Software WebGL results do
not certify physical-GPU performance, and Mac-local results cannot replace
Windows compatibility or Linux containment.

### Full-suite sharding

A full plan is the slow case: on the 4-vCPU public runners the client suite
alone took ~10 minutes (DOM setup per file dominated — the 868-file run
spent 489 s in `environment` against 384 s in `tests` — and its worker cap is
two, see `scripts/vitestCiPool.js`), the Windows server suite ~10 minutes
(module import is several times slower there), and the Linux server suite ~6
minutes. Roughly half of all PR runs went full, so most PRs waited on the
longest of those.

The three test-runner jobs are therefore matrices. The impact job emits
`server_shards`, `client_shards`, and `windows_shards` — `[1]` for exact-file
plans and `[1..n]` for full plans. Windows also uses its full matrix for
related-test plans: a single shared source can select most of the server graph
and exceed the 15-minute test-step budget on one Windows runner. Matrices are
sized by `FULL_SUITE_SHARDS` in
`scripts/ci-test-plan.js` (client 3, Windows 3, server 2) — and each job builds
its matrix from that output. The decision has to be made in the planner: a
job-level `if` cannot read the `matrix` context, so a job cannot skip its own
extra shards. `scripts/run-ci-tests.js` turns `CI_SHARD=<index>/<count>` into
Vitest's `--shard`, which slices the file list by path hash — every shard is a
fixed, disjoint subset, and their union is the complete selected suite. Windows
related plans retain the same source graph and explicit contracts on every
shard; only execution is partitioned. Scoped Linux plans fan out the same way
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
runs (DB and browser suites have their own jobs); each shard repeats Vitest's
related-graph pass, the trade the Windows job already makes. Once-only steps — smoke boot, the client build, the
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
| targeted test set exceeded safety cap (no longer full; see "Full-suite sharding") | 17 | no — capacity, not risk |
| wide change (>30 executable files) | 6 | no — capacity, not risk |
| client composition root / build config / lint config / test setup | 1 | no — client-only |
| dependency manifest, server contract, CI pipeline script, workflow, … | 40 | yes at the time — manifests and server contracts are now narrowed (below) |

So each full trigger in `FULL_TRIGGER_RULES` carries a `windowsEscalates` flag,
and `fullPlan()` escalates Windows to the complete server suite only when **any**
matching trigger is Windows-relevant, the diff touches `WINDOWS_RISK_RULES`, or
the run is force-full. **Any** is load-bearing: the reason line reports only the
first match in sorted-path order, and the `client/src/App.jsx` branch returns
before the trigger loop, so both read the same OR over every match. A diff that
edits `App.jsx` *and* bumps a lockfile escalates. Otherwise the job drops to **one shard running
`WINDOWS_CONTRACT_TESTS`** — reduced, never skipped, and exactly the depth a
Windows-risk scoped PR already gets.

**Dependency manifests decide per package.** The planner's 32-PR sample in
October 2026 traced every full plan to a lockfile/manifest change (4),
`server/lib/validation.js` (2) or `.github/workflows/ci.yml` (2). A lockfile
bump that swapped one pure-JS Gmail client still ran the whole suite on three
Windows shards (~11 min each), although nothing it installs differs by
platform. A changed `package.json`/`package-lock.json` (root, `server`,
`client`, `autofixer`) therefore still forces a full plan, but its trigger
carries `windowsEscalates: 'dependencies'`: `collectPlanInputs()` reads each
file at `CI_BASE_SHA` (`git show`; the base is inside the depth-2 checkout)
and in the tree under test, and `classifyDependencyChange()` diffs them.
Windows escalates when any added, removed or changed lockfile entry (either
side) has `hasInstallScript`, `os`, `cpu`, `libc`, `optional` or
`devOptional`, or matches `PLATFORM_PACKAGE_RES` — every `TRUSTED_REBUILDS`
package (mirrored rather than imported, so the pre-install planner does not
load the rebuild script's spawn helpers; a test fails on drift) plus the
native/platform families (`sharp`,
`@img/*`, `esbuild`, `@rollup/rollup-*`, `rolldown`, `@biomejs/*`,
`playwright*`, …: dispatchers whose own entry carries no platform
metadata); when the lockfile's top-level fields or its root entry's non-dependency
fields (`engines`) change; when a `package.json` field other than metadata
and the dependency maps changes (`engines`, `overrides`,
`optionalDependencies`, `scripts`, …); and whenever a version cannot be read
or parsed (fail closed: a new or deleted manifest, an unavailable base, or no
verdict at all). Any `.npmrc` change escalates on its own trigger. Otherwise
Windows runs the contract baseline, and `suite_reasons.windows` names the
decision and the packages behind it. Replayed against recent server bumps:
zod, express, undici and the Gmail swap keep the baseline; playwright-core
and Vitest (rolldown bindings) escalate.

`server/lib/validation.js` and `server/lib/schemaVersions.js` stay full-plan
triggers for their import fan-out but no longer escalate Windows: they are pure
schema logic with no spawn, path or filesystem semantics, and neither is in
`WINDOWS_RISK_RULES`. `Full CI Gate` still requires `windows_mode == 'full'`,
so none of these baseline plans can stand in for the complete Windows suite a
release relies on.

**Measured full trigger: `server/services/worktreeManager.js` (#9999).** A
two-file change to this module expanded through Vitest's import-consumer
traversal to 57 explicit selectors and a ~941-file, ~40-minute local run
(including real Chrome/ffmpeg renders), while still reading as a scoped plan
because `MAX_TARGETED_TEST_FILES` counts only explicit selectors. It now plans
full (Windows escalates, since the module owns cross-platform worktree
lifecycle). Default `npm run pregate` therefore runs only its always-run guards
for it, `--full` runs everything (the build, smoke, browser and DB suites
included), and CI runs the full sharded suite. Its test
file alone stays scoped; the #9673 consumer traversal is unchanged elsewhere.

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
400 files; snapshot files and the planner's `FIXTURE_OWNERS` directories are
added for the test itself); the installed version of every package the
members reach (so a lockfile bump invalidates exactly the suites that reach
the bumped packages); a Python sidecar's resolvable sibling imports; the
version of an external program a member reaches (`TEST_MEMO_TOOLS`: the
python the sidecar tests spawn — a literal, `PORTOS_TEST_PYTHON`, or an
interpreter bound from `resolveTestPython()`; ffmpeg/ffprobe; and Chrome for
the browser suites, found with the suites' own candidate list,
`resolveTestChrome` in `scripts/lib/testChrome.js`); an unknown program
handed a `.py` file fails closed; the workspace Vitest config closure, setup files,
`scripts/vitestCiPool.js`, `package.json` and lockfile; the full Node
version, `process.platform`, `process.arch`; and `TEST_MEMO_ENV` (`CI`,
`NODE_ENV`, `PORTOS_BROWSER_TEST_PROFILE`, `PORTOS_CI_BROWSER_OWNER`,
`PORTOS_REQUIRE_BROWSER_SUITES`, `PORTOS_REQUIRE_LINUX_CONTAINMENT`,
`PORTOS_TEST_QUIET`, `PORTOS_TEST_PYTHON`, `CHROME_PATH`, `TZ`, `LANG`,
`LC_ALL`, `CI_EXPECT_SLASHDO_SUBMODULE`, …).

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
member. A recorded set that reaches outside the repository is not memoizable
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
Pull requests only read. The scheduled nightly, `workflow_dispatch` and
`workflow_call` runs on the default/release branches save a new entry keyed
by run id, and only when the test step itself succeeded, so the cache holds
nothing a pull-request branch or a red run wrote and every PR restores the
newest trusted lineage. The DB job does not go through `run-ci-tests.js`
and is not memoized.

**Disable.** `PORTOS_TEST_MEMO=off` turns reads and writes off together and
restores the pre-memo behavior. A test spawned under Vitest (`VITEST` set)
never touches the developer's store unless it sets `PORTOS_TEST_MEMO_DIR`.

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

### Rebase Before Push

Since CI may auto-commit changelog archives, always rebase before pushing:

```bash
git fetch origin main
git rebase origin/main
npm run pregate
git push
```

## Adapting for Sub-Projects

1. Copy `.github/workflows/ci.yml` and `.github/workflows/release.yml`
2. Update installation and build commands for your project structure
3. For monorepos, add package.json update steps for each workspace
4. Update the changelog file path pattern if different
