# Test memo

How CI and `npm run pregate` skip test files a trusted green run already
verified, and how `related` selection uses the same records. Moved out of
[GITHUB_ACTIONS.md](./GITHUB_ACTIONS.md), which covers the workflows that run it.

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

## Never memoized (fails closed)

A file in the planner's always-run set
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

## Store

`~/.portos/test-memo/` (override with `PORTOS_TEST_MEMO_DIR`):
`entries/<key[0..2]>/<key>.json` holds `{ test, workspace, verifiedAt,
source: 'local'|'ci', commit }`, `records/<workspace>/<sha256(test)>.json`
the loaded-module list (version 2 also holds a 16-hex sha256 digest per module,
aligned with the list; a record without them still feeds the recorded key but
never narrows selection). The list comes from Vitest's depfile, which Vitest
5.1 writes as version 2 (`files[test] = { at, deps }`); the reader accepted only
version 1 until #16424, so from the 5.1 bump until then no record or
recorded-key entry was written anywhere. Writes are temp-file-plus-rename so concurrent
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
(plus `U never-memoized guards not analyzed.` when U > 0: those are decided before
any closure walk; and `Related selection used R digest records.` in a related
plan) — and lists the skipped files under `PORTOS_TEST_MEMO_VERBOSE=1`.
When every selected file is memoized nothing is launched and the job exits 0.

## Shards

A matrix shard takes its slice of the FULL selected list with
Vitest's own hash-sort-and-range algorithm (`vitestShardSlice`, pinned
against a real `vitest run --shard`) before the memo subtracts anything, so
every file lands in exactly one shard whatever each shard's store holds;
Vitest itself is never given `--shard`.

## Related selection

A `related` plan selects, besides the planner's explicit files, every test a
changed source can affect. Lazy `import()` edges made that the whole lazily
imported server cluster: across the server's sources the median selected 1,392
suites, nearly all of them because some module in their closure has a
non-literal edge (#16424). A test with a version 2 record whose recorded key is
memoizable (the gate the record was written under) is now selected through
`recordedReach` (`scripts/lib/testMemo.js`):

- the test, every module its green run loaded, and those modules' non-JS
  inputs;
- the names those modules import but the run never loaded (mocked away or on
  an untaken path), without walking below them;
- a literal `import()` from the test file itself;
- the whole closure (static and lazy) below any recorded module whose current
  digest differs from the record's: a lazy edge gained since the run lives in
  such a module, so its closure counts as it does for an unrecorded test;
- the whole closure of a side module that executes (spawned, `require()`d,
  run as a worker), which the module runner never records. An unresolved edge
  there, or in a changed recorded module, fails closed (always selected);
- JS that is only read as data (as text, or listed by a directory read, such
  as a template tree that is copied) by its own bytes, and by its closure only
  when the reader has a non-literal import that could evaluate it.

A test with no record, a version 1 record, a record naming a deleted module,
or a record the recorded key rejects is selected exactly as before, through
its full static and dynamic closure. Selection never trusts a record further
than the memo already does to skip the test outright, and it is stricter about
staleness. The full suite on every push to `main` still runs everything, so a
miss is caught by the next completed run.

## CI seeding

The server, client, browser and Windows jobs restore
`${{ runner.temp }}/portos-test-memo` through the `test-memo` action
(`actions/cache/restore`) under a per-job, per-shard key prefix
(`test-memo-<os>-<arch>-<job>-<shard>of<n>-`).
Server, client and Windows restores prefer that partition, then fall back to
the newest memo from any shard of the same OS, architecture and job. Trusted
full runs never seed a scoped `1of1` lineage, so an exact-partition-only lookup
would leave those jobs permanently cold. A fallback contains only one shard's
entries: matching content keys may skip those tests; all other selected tests
still run. Partitioning happens before memo lookup, so changing the memo's
source shard cannot omit or duplicate a selected test. The server and client jobs also
restore every full-run shard lineage (`merge-shards`, equal to
`FULL_SUITE_SHARDS` for the family and pinned by `scripts/ci-test-memo-cache.test.js`)
and fold them in with `scripts/merge-test-memo.js`, keeping the newer record
per test and every live entry: a shard records only its slice, and related
selection narrows a test only through its own record. Each lineage restores to the path it was saved from (a cache version hashes the path; restoring elsewhere finds nothing) and is then moved aside before the next. Each shard saves as soon
as its own tests pass.
Pull requests only read. Pushes to `main`, the scheduled nightly, `workflow_dispatch` and
`workflow_call` runs on the default/release branches save a new entry keyed
by run id, and only when the test step itself succeeded, so the cache holds
nothing a pull-request branch or a red run wrote and every PR restores the
newest trusted lineage. The DB job runs the `db` scope
(`node scripts/run-ci-tests.js db`, the serial `portos_test` suite) and keeps
its own `-db-` lineage. The DB config, `server/scripts/init-db.sql` and
`server/scripts/setup-db-test.mjs` are base inputs (a schema change
invalidates every key) and `PGDATABASE` is a keyed env var.

## Disable

`PORTOS_TEST_MEMO=off` turns reads and writes off together and
restores the pre-memo behavior. A test spawned under Vitest (`VITEST` set)
never touches the developer's store unless it sets `PORTOS_TEST_MEMO_DIR`.
