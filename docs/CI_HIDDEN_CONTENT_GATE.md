# CI Hidden-Content Gate

The hidden-content gate that runs in the CI workflow. Split out of [GITHUB_ACTIONS.md](GITHUB_ACTIONS.md).

## Hidden-content gate

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

AI conversation-session links in commit messages and PR descriptions are
banned by the AGENTS.md Git Workflow rule, but no CI check enforces it: outside
contributors do not always follow it, and refusing their pull requests only
created churn.

The import-growth guard measures one development change. Release promotions and
pushes retain the existing exception for a whole release cycle's aggregate growth.
Local pregate carries its exact chosen base ref alongside `CI_BASE_SHA`, so the
documented release refs use that same policy; main, other refs and raw SHAs keep
the normal growth assertion. Other structural guards and full release suites run
unchanged.

An always-run set (`getAlwaysRunTests()` in the planner) is added to every plan,
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
- **Doc-parity guards** — `server/test/guards/repo/docsIntegrity.test.js`
  compare a `.md` with source they read rather than import
  (the route graph, the dependency manifests). The `.md` is documentation-only
  to the planner and the source has no import edge to the guard, so a docs-only
  PR is exactly the one that could document a removed endpoint and merge green.

**Gate-tooling suites ride owner paths (#16798).** The eight tests of the CI and
pregate machinery (`TOOLING_TESTS`) can never earn a memo record, so `related`
selection used to pick them for every diff. The planner now adds them only when a
changed path matches `TOOLING_OWNER_RE`, and `planTestMemo` keeps one from the walk
only when a changed source reaches its closure ([TEST_MEMO.md](./TEST_MEMO.md#related-selection)).
Full plans and pushes to `main` run all of them.

## Guard selection and registration

**A tree guard registers by its filename.** The planner selects every tracked
`*.guard.test.js` (`getGuardTests()`: one `git ls-files`, no test source
read): a guard outside `client/src` joins every plan, and a client guard rides
any `client/src` js/jsx change. The test memo never skips one.

**Server scans are checks inside three structural guard runners (#16996).**
`server/test/guards/{runtime,modules,repo}.guard.test.js` (`GUARD_CHECK_DIRS`
in `scripts/lib/guardScanners.js`) each load every `*.test.js` in the same-named
directory into one worker over one corpus (`scripts/lib/guardCorpus.js`: one
`git ls-files`, each file read once); the Vitest config excludes the directories
and a changed check selects its runner. A new scan goes in the directory for its
subject; a standalone guard needs a reason in `STANDALONE_GUARDS`. Client scans run the same way in
`client/src/test/guards/{a11y,ui}.guard.test.js`, node-environment runners that
ride any `client/src` js/jsx change.
`EXPLICIT_ALWAYS_RUN_TESTS` lists the always-run tests that are neither (route
policy, import growth, the prompt-upgrade contract).

The content detectors in `scripts/lib/guardScanners.js` (git enumeration, the
shared source walkers, `readdirSync` with `recursive: true`, a hand-rolled
recursive directory walker, an unnamed cross-root read) select nothing. They
are a one-way check in `server/test/guards/repo/repo-scan-guards.test.js`: a test they
recognise as a scanner fails unless it carries the suffix, lives in a guard
directory, or is listed in that file's `SCANNERS_WITHOUT_SUFFIX` with the reason (another selector reaches it,
or its walk reads a temporary directory). A scanner the detectors cannot see
(one that scans through an imported helper) is still selected by its name.

Because they run on every PR, each always-run guard has a time budget: each
structural guard runner's checks (a check's load plus its test times) and every other
always-run file whole (`CI_GUARD_BUDGET_MS`, 4s, in `scripts/lib/guardBudget.js`;
~1.6x the 2.5s local target). Only the scheduled Linux server run enforces it
(`CI_GUARD_BUDGET=enforce`, `ci.yml`, #16810): `scripts/run-ci-tests.js` runs the
always-run guards in their own pass and fails any guard over budget. Other runs
warn with a `::warning::`, and local pregate only reports it (`docs/PREGATE.md`).
