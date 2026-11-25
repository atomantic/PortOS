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
  `experimental.recordDependencies` depfile, cleared before a run that
  records new dependencies so only that run's records count). A module the test mocks away or never reaches
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
400 files, and past that through the repository listing when it is only read
as data: [Directory trees](#directory-trees); snapshot files and each `FIXTURE_OWNERS` directory — or only
its direct children when the owner sets `fileRe` — are added for the test
itself); the installed version of every package the
members reach (so a lockfile bump invalidates exactly the suites that reach
the bumped packages); a Python sidecar's resolvable sibling imports; the
version of an external program a member reaches (`TEST_MEMO_TOOLS`: the
python the sidecar tests spawn — a literal, `PORTOS_TEST_PYTHON`, or an
interpreter bound from `resolveTestPython()`; ffmpeg/ffprobe; Chrome for
the browser suites, found with the suites' own candidate list,
`resolveTestChrome` in `scripts/lib/testChrome.js`; and git, with the
settings its repositories inherit, for a suite that declares its repositories
fixtures: [TEST_MEMO_GIT_FIXTURES.md](./TEST_MEMO_GIT_FIXTURES.md)); an unknown program
handed a `.py` file fails closed; the workspace Vitest config closure, setup files,
`scripts/vitestCiPool.js`, `package.json` and lockfile (the workspace base,
below); the full Node
version, `process.platform`, `process.arch`; and `TEST_MEMO_ENV` (`CI`,
`NODE_ENV`, `PORTOS_BROWSER_TEST_PROFILE`, `PORTOS_CI_BROWSER_OWNER`,
`PORTOS_REQUIRE_BROWSER_SUITES`, `PORTOS_REQUIRE_LINUX_CONTAINMENT`,
`PORTOS_TEST_QUIET`, `PORTOS_TEST_PYTHON`, `CHROME_PATH`, `TZ`, `LANG`,
`LC_ALL`, `CI_EXPECT_SLASHDO_SUBMODULE`, …); and the arguments that select
which cases of a file run (a browser profile's `--testNamePattern`), because
a green verdict covers only the cases that ran. An unfiltered run adds
nothing, so its keys are unchanged.

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

## Directory trees

A directory a test reads as a whole is an input as a whole.

- **Up to 400 files** the tree is walked on disk. JS found there is a side
  module: it stays in the key with its own closure and its own reads.
- **Past 400 files**, a tree that is only read as data (listed, read as text,
  served) is taken from one `git ls-files` instead: every tracked file plus
  every untracked file a commit would pick up, so a new source file moves
  the key before it is staged. Each file counts by its bytes, and the walk
  follows the literal imports of the tree's JS out of the tree, since
  whatever serves or bundles it follows the same specifiers
  (`client/src/App.jsx` imports `server/lib/navManifest.js`). A served file's
  own filesystem reads, git use and `// test-memo: never` marker say nothing
  about the test process and are left out. Git-ignored files are outside the
  key, as `.env` files and installs are outside every key. Suites that key
  the same tree from inside it would hash the same file set, so such a key
  also names its test.
- **A real-browser test** renders what a dev server, bundler or static
  server reads on its behalf, and the module runner records none of it. A
  test is one when it, a module it imports or a script it runs names the
  browser (`CHROME_PATH`, `playwright-core`); browser tests that a member
  merely lists in a directory do not make their lister's importers one. Every directory the test file hands to such a tool is
  therefore a tree input under the two rules above: the value of a `root:`,
  `dir:` or `base:` option, any other object-literal value
  (`publicDir: join(client, 'public')`), and a function argument
  (`express.static(dir)`). An install directory stands for the
  `package.json` and lockfile beside it; `resolveClientBundler(repoRoot)` is
  read as the client workspace's install directory. Before #16545 such a
  directory was "a value", so a suite that wrote `root: clientDir` and loaded
  its component from a fixture string was skipped after the component
  changed. A variable `root:`, `dir:` or `base:` is keyed by its resolved
  directory or by its proven containing tree. An unbounded rooting option
  refuses the browser test. A Node test that passes a directory along keeps
  the older reading.
- **A served root narrows to what the fixture served** (#17616, #17894). Keyed
  whole, `client/` is ~4,600 files, so any client edit re-ran every
  real-Chromium suite. When the runner records (`--experimental.recordDependencies`)
  it also sets `PORTOS_TEST_MEMO_SERVED_DIR`, and `startBrowserFixture` plus the
  instrumented Vite/static helpers (`buildRecordedViteFixture`,
  `startRecordedViteServer`, `createRecordedStaticServer` in
  `scripts/lib/browserServedFiles.js`) add a recorder that notes every file
  Vite loads, transforms, copies from `publicDir` or serves statically. The
  suite's memo record stores those files (`served: { roots, files }`,
  repo-relative, installed packages and paths outside the repository
  dropped). For a root the record names, the recorded key and
  `recordedReach` then key only the served files, what served CSS
  `@import`s, the shared inputs no request names
  (`BROWSER_SERVED_SHARED_INPUTS`: `client/src/index.css`,
  `client/src/themes/`), the root's own direct non-dot files (its
  manifests and PostCSS config) and the manifests above it (`servedTree`).
  A served module is not walked, as with the recorded key: the importer
  that gains an edge is itself served. A Tailwind class an unrelated page
  adds styles only elements that use it, and those live in served files.
  The whole tree stays keyed, failing closed, when there is no record or
  the record names another root, a served path leaves the repository, or
  the test file serves or bundles through an uninstrumented call of its own
  (`UNRECORDED_SERVER_CALL`: `createServer(`, `build(`, `express.static(`, `.listen(`, …), which
  the recorder never sees. The floor key is unchanged.

The key still fails closed for the repository root; for a tree the test
spawns, imports or requires through a variable path; for a directory that is
only the known prefix of a path with a variable segment, even one proven to
stay inside it ([Variable path segments](#variable-path-segments)); for a test with a
non-literal `require()`, which could load the tree natively where no
recording shows it (a browser suite therefore loads its driver with
`import { chromium } from 'playwright-core'`, never through
`require(require.resolve(…))`, #16586); for a tree holding a submodule or
nested repository (one listed entry, whatever it contains); and outside a git checkout. A product
module's own oversized read is still ignored, as before: only a tree-scanning
guard calls those walkers, and a guard (`*.guard.test.js`) is never memoized.

## Variable path segments

`join(HERE, name)` names a directory and leaves the rest to run time. Until
#16602 the key took that directory's tree, as if the read had to land in it.
A helper called as `read('../../client/src/limits.js')` leaves it, and a
template URL (``new URL(`../../data.reference/templates/${name}`, import.meta.url)``)
was keyed as the importing file's own directory: the key held files the test
never read and missed the one it did. `server/test/fixtures/ecosystemConfigCopy.js`
was keyed that way in every suite that imports it.

A variable segment is now one of three things:

- **Resolved.** The variable is a parameter of a function declared once in
  the file, never exported, stored, handed on or reassigned, and every call
  passes a literal (or another resolved variable; a `let` that is assigned
  again is not a literal); or it is the callback parameter or `for…of`
  variable (declared with `const` or `let`: a `var` outlives its loop) of a
  literal array, an `it.each` table of strings, or a `const`
  array nothing in the file can add to (no method that adds an element or
  returns the array itself, no element or `length` assigned, updated or
  deleted, in parentheses or not, no iteration callback that takes the array,
  not handed to unknown code (`expect(NAMES)` only with a comparing matcher such
  as `toEqual` or `toHaveLength`), declared once). An array literal with an empty
  slot (`['a', , 'b']`) is not resolved: the slot is `undefined` to the loop.
  An imported name can also resolve when its repository module exports a literal
  string or a literal array wrapped in the built-in `Object.freeze()`.
  The path is evaluated once per
  value (up to 64 combinations) and each file is an ordinary input. No
  directory is keyed, and a helper nothing calls contributes nothing. A
  parameter or loop variable shadows a module-level binding of the same name.
  One named like a module-level path (`function read(ROOT)` beside
  `const ROOT = …`) is the path every call passes when that is one complete
  path, and unbounded otherwise: the read is never dropped. Where a
  shared name leaves only unknown text for a whole path (`readFileSync(FILE)`
  beside a parameter `FILE`), the file the constant names stays an input, as
  it was before parameters were modelled.
  A resolved value is then read by JavaScript's own rules: text after a path
  continues its last segment unless a separator is written, `join()` keeps a
  trailing separator and `resolve()` does not, `resolve()` restarts at the
  rightmost proven absolute anchor (ignoring preceding segments such as
  environment expressions) while `join()` does not, a URL spec is parsed (`%20` is
  a space, `?raw` is not part of the path), a module path is completed the
  way the loader completes it, and a glob pattern keys the directory in front
  of its first wildcard. A value that names different files on Windows
  (`a\b`, `C:`) is not resolved.
- **Contained.** The variable is an unchanged entry of a `readdir`/
  `readdirSync` listing (imported from Node's `fs`; not `withFileTypes`), a
  `randomUUID()` from `node:crypto`, or the path is built with `pathWithin(dir, ...segments)`
  (`lib/pathWithin.js`, re-exported by `scripts/lib/pathWithin.js`), which joins like `path.join` and throws when
  the result is outside `dir`. The directory's tree is the input, as before.
  The literal directories in front of the variable are part of it:
  `` `${HERE}/fixtures/${name}` `` keys `fixtures`, not `HERE`. Literal text
  after the variable is judged as it accumulates (`name + '/.' + './x'`
  climbs), and `dirname()` of such a path, or a URL resolved against it, is
  no longer contained.
- **Unbounded.** Anything else: a property, a call result, an argument that is
  not a literal, a name that was rewritten (`name.replace(…)`), chosen
  (`cond ? a : name`), followed by a `..` segment, glued to the directory
  with no separator, or resolved through `new URL()` (which decodes `%2e%2e`
  and reads `\` as a separator). The test fails closed, whichever member of
  its closure reads the path: `reads a path through read() that the analyzer
  cannot resolve (under <dir>)` when the variable is a helper's parameter,
  `reads a path with a variable segment that can leave <dir>` otherwise.
  An environment value such as `process.env.FIXTURE` used as a segment under a
  repository anchor is unbounded because it can contain a relative path.

Code that reads a file it cannot name in its own source (a name from a table
in another module, a value parsed out of a file) stays memoizable by joining
with `pathWithin()`. The analyzer accepts the call only when the name is
imported from either guard module. A file that mocks `fs`, `crypto` or `pathWithin.js`
(`vi.mock`, a `vi.spyOn` of the member, any use of the `fs` namespace but a
call through it), or that imports a helper or runs under a workspace setup
file that does, decides what they return, and a parameter or
local named `readdirSync`, `randomUUID` or `pathWithin` is not the import, so
nothing is inferred from them there. A mock counts against a read that relies
on it: every `pathWithin()` call (literal segments included), a listing or a
generated id only where a read is contained by it. It counts only from a
member that runs: a test file another member reads as text registers nothing.

A read that relies on an imported constant is refused if a file that runs
mocks its exporting module.

The analysis reads tokens, not scopes, so it resolves a name only where no
other reading is possible: a text constant that another scope declares, binds
as a parameter or assigns again is unknown, and so is a helper or an array
whose name turns up inside a string (`eval`, or code the tokenizer took for
text). `Object.freeze` is the built-in only where no `Object` is declared in the
file. The language and the test API are taken as they are defined: a
file that replaces `Array.prototype.forEach` or mocks `vitest` itself is past
what its source can prove, for a variable segment as for a literal path.

A search path built with Node's `path.delimiter` keys its repository
directory entries, including the agent guard's executable shims.

The unbounded-read rule applies to every member of a test's closure (#16660).
A library module can supply a literal name, resolve that name from an imported
constant, or prove containment with `pathWithin()`. The analyzer handles
`readServerSource()` and `readClientSource()` at their call sites. A direct
call with a literal argument keys the named file. A non-literal argument or
passing the reader as a callback fails closed. A variable `import()` whose
module path is unbounded is an unresolved edge for the floor key.

On a path the analyzer has already anchored, `.replaceAll('\\', '/')`,
`.replace(/\\/g, '/')`, `.normalize()` and `.toString()` preserve its
identity for the key when the literal spelling stays canonical. A slash
replacement on a complete path containing a literal backslash, on a partial
path whose variable parts cannot be expanded to canonical literals (including
a guarded path from `pathWithin()` or a directory listing, where a POSIX
filename can contain a literal backslash), or a Unicode normalization that
changes the literal spelling can name a different file and escape its
bounded directory. A read, spawn or unmodelled function call that takes the
result of one of these changes or another member operation fails closed with
`reads a path the analyzer cannot follow through .<name>()`. An assertion
or string-only consumer can still use that result. A later `pathWithin(dir, ...)`
call establishes a new bound only when `dir` is already bounded and the guard
operates on the normalized value itself as a segment.

## Never memoized (fails closed)

A tree guard, named `*.guard.test.js` (the planner selects guards by that
suffix, see [CI_HIDDEN_CONTENT_GATE.md](CI_HIDDEN_CONTENT_GATE.md#guard-selection-and-registration)); any other file in the
planner's always-run set or in `TEST_MEMO_NEVER` (the catalog and enumeration
tests another selector reaches); a
file whose closure contains the `// test-memo: never` marker; a test file or
`scripts/` module that spawns `git`, named in the call, by a name that holds
it or by a caller of a runner (repository state is not in the key —
product modules that run git on their own targets are under the test's
control; a test file that declares its repositories fixtures with
`// test-memo: git-fixture` is keyed by git itself instead:
[TEST_MEMO_GIT_FIXTURES.md](./TEST_MEMO_GIT_FIXTURES.md)); a test file or `scripts/` member that reads machine-local state
(`data/`, the home directory); any member that reads
a path whose variable segment nothing bounds
([Variable path segments](#variable-path-segments)); a member that reads a path the analyzer
cannot resolve (`import.meta.glob`, anything under `.git/`, a non-literal
`readServerSource`/`readClientSource`, a directory with more than 400
files that the listing cannot stand in for, see
[Directory trees](#directory-trees)); a bare specifier that resolves to no installed package; and, for
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

The planner checks a file's recorded key before anything else. Its floor
key and static closure are computed only when that misses, or when related
selection has no narrowing record for the file, so a warm memo does not
walk the closures of the files it is about to skip (#17617). Every file
that runs has had its floor key computed before Vitest starts, which the
after-run comparison above relies on.

Parsing every file the plan reaches (about 9k on the server side) was the
rest of the planning time, so the parsed facts persist too
(`scripts/lib/testMemo/factsCache.js`, `facts/<workspace>.json` in the
store). An entry is keyed by the file's bytes and path, the workspace, the
three sources the setup files replace, and the version of the extraction code
(`FACTS_CODE`, the Node version and the platform). Every constant the file
imported from another module (`exportedConstant`) is recorded with it and
looked up again on reuse; a different answer re-parses the file. Facts or
lookups that would not decode to exactly what extraction returned are never
stored. A save keeps what the run used and anything another branch used in
the last 14 days. A pull request reads it from the parked lineages and never
writes it, and the merge copies it into a store that has none. Over the real
tree, keys, closures and narrowed reach match an uncached analysis exactly,
and a warm server plan parses 2 of about 12k files.

A store can also be several directories: `PORTOS_TEST_MEMO_READ_DIRS` (a
`path.delimiter` list) adds read-only ones after the usual directory. An
entry is the first valid one across them, a record the newest by
`recordedAt` (a tie keeps the earlier directory), and writes go to the
first. Pull-request CI jobs use it to read the parked shard lineages in
place ([CI seeding](#ci-seeding)).

The store is bounded at the end of a run that may publish it
(`pruneTestMemo`). A trusted CI run (not a pull request) removes unreadable
and expired entries, keeps the newest three entries per `(workspace, test)`
(`MAX_ENTRIES_PER_TEST`) and drops entries and records of test files the
checkout no longer has: a test gets new entries only when it ran, which
means its inputs had already moved past the older ones. Before #17617 a
saved server lineage carried 213,086 entry files. The developer's store is
shared by every worktree and branch, so a local run only removes expired
entries, at most once a day (a `pruned-at` stamp in the store).
When every selected file is memoized nothing is launched and the job exits 0.

After a run that may record (every run but a pull request's), the runner
also names each passed file it stored under neither key, with why each key
was refused:

```
🧠 Test memo: recorded 12 green entries for 14 passed files.
🧠   not recorded: client/src/components/Example.browser.test.js (floor key: …: require() with a non-literal specifier; recorded key: …: directory input too large: client)
🧠   not recorded: 3 files never memoized by declaration (tree guard or always-run test, TEST_MEMO_NEVER or the test-memo: never marker).
```

At most 40 files are listed, then the rest are counted. Files that are never
memoized on purpose are only counted: a full run passes dozens of them every
time. A suite that appears here on every run is re-executing identical
inputs forever, which is how #16545 was found.

### Runs under a name pattern

A browser profile selects cases with `--testNamePattern`. Vitest calls such a
run partial and writes a file's dependency record only by merging into one it
already has: cases the pattern skipped may import modules the record would
lack, and Vitest reuses the record for unfiltered runs. The runner clears the
depfile before every run, so a profile run recorded nothing, and the 15
registered browser suites whose closures have non-literal imports (no floor
key) never got an entry. The runner now writes an empty record for each file
about to run (`seedVitestDependencies`), under every project name, into the
path Vitest reads (`<cacheDir>/vitest/<sha1 of the root project name>/dependencies.json`).
Vitest's concern does not apply to the memo: the pattern is in the key, so an
entry only vouches for a run that skips the same cases, and a record from a
filtered run is stored without digests, so it never narrows related
selection for another profile. A seed the run does not fill in stays empty
and is ignored. `scripts/lib/testMemoRunner.test.js` pins the whole exchange
against the installed Vitest.

### Smoke reuses a full verdict

Pull requests run the browser suites on the `smoke` profile, and only trusted
runs save the memo, on `full`. Their keys differ in the profile's env value and
case filter, so before #16546 a pull request never skipped a browser suite. A
`smoke` run now also looks up, under both the recorded and the floor key, the
key the same inputs would get with `PORTOS_BROWSER_TEST_PROFILE=full` and
`full`'s `--testNamePattern` (`browserProfileAcceptedVerdicts` in
`scripts/lib/browserTestProfiles.js`, `acceptVerdictsFrom` on `planTestMemo`).
Every other key line (file bytes, records, packages, tools, Node, platform,
arch and other env values) stays this run's own, and entries are still written
under the run's own key only.

Smoke can use a different stable shard assignment. Smoke jobs read all trusted
full-run browser shard lineages, so a suite that moves can still reuse its
former owner's verdict.
Full-profile jobs keep their per-partition restore and save behavior.

`smoke` skips `[fidelity]` cases and `full` skips `[local-performance]` ones.
Every `[local-performance]` case is also `[fidelity]`, so a file's smoke cases
are a subset of its full cases, and a full verdict covers them.
`server/test/guards/repo/browser-suite-registry.test.js` reads every registered suite and fails
on a line that mentions `local-performance` without `[fidelity]`. The reverse
never holds: a `smoke` entry skipped the fidelity cases, so `full` and
`fidelity` accept only their own entries. The verbose listing marks such a
skip `(recorded key, full profile verdict)`.

Browser shards check the memo before provisioning audio tools. A shard with
verified hits for every suite skips audio and client setup. Before a client
install exists, the check can use unconditional package versions from the
integrity-pinned client lockfile, which must match the lockfile in the memo
key. Test execution still keys the installed package manifests. If provisioning
ffmpeg could turn every remaining verdict into a hit, the shard checks again
before client setup and browser startup. A cold memo or a definite miss goes
straight from audio provisioning to the usual client setup and test runner.
Only a successful browser run that records green entries saves a new memo.
An unavailable tool cannot supply a browser memo hit or green entry.

## Shards

The runner determines shard ownership from the complete memo-independent
candidate inventory, including explicit files. Unit jobs use Vitest's
hash-sort-and-range algorithm (`vitestShardSlice`, checked against a real
`vitest run --shard`), and browser jobs use the browser suite registry order.
The two-shard server unit matrix pins heavy suites and all non-capture serial
suites to balance the two jobs. Its regression checks the pinned duration spread
with shard 1's Smoke-boot step and the distribution of always-run guards and
non-capture serial suites.
The runner then evaluates related reach and subtracts memo hits within each
shard's own candidates. Each file has one owner even when sibling shards
restore different memo records. Vitest receives the final selection directly.

The planner sizes the client matrix before any memo is restored, so it
counts real-Chromium suites itself (#17616): a client plan fans out across
`FULL_SUITE_SHARDS.client` once it selects `CLIENT_BROWSER_FANOUT_SUITES` (4)
of them, explicitly or, for `related`, by reach (`clientBrowserSuiteReach()`
in `scripts/lib/importReach.js`: the suite's own import closure, the closure
of the `/src/…` entries its fixture renders, or a shared input such as
`client/src/index.css`, `client/src/themes/` or a direct file of `client/`).
Each costs a Chrome launch and a cold Vite graph, so 32 of them on one runner
took 282–402 s against 55–91 s across four shards.

## Related selection

A `related` plan selects, besides the planner's explicit files, every test a
changed source can affect. Lazy `import()` edges made that the whole lazily
imported server cluster: across the server's sources the median selected 1,392
suites, nearly all of them because some module in their closure has a
non-literal edge (#16424). A test with a version 2 record whose recorded key is
memoizable (the gate the record was written under) is now selected through
`recordedReach` (`scripts/lib/testMemo/analyzer.js`):

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
or a record the recorded key rejects is selected through its full static and
dynamic closure and tracked inputs. An unresolved edge or an unbounded read
anywhere in that closure selects the test for every changed source, since it
could reach outside the known inputs. Selection never trusts a record further
than the memo already does to skip the test outright, and it is stricter about
staleness. The full suite on every push to `main` still runs everything, so a
miss is caught by the next completed run.

The gate-tooling suites are the exception (#16798). They spawn git or carry
`test-memo: never`, so none can ever earn a record, and the rule above would
select them on nearly every diff. `TOOLING_TESTS` (`scripts/lib/ciPlanRules.js`)
names them: `planTestMemo` drops one from the related walk's result unless a
changed source is a member of its closure or one of its tracked inputs. The
planner supplies the rest through `TOOLING_OWNER_RE` (`scripts/**`, `.github/**`,
every `package.json`, `package-lock.json` and `.npmrc`, the Vitest configs and
the Vitest environment modules under `server/test/`): a diff touching one of
those adds the whole list to the plan's explicit files, which are always kept. A
suite joins the list only after its real-tree reads have been checked to sit
under an owner path or inside its closure; one that asserts over other tracked
files stays out.

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
source shard cannot omit or duplicate a selected test. The server and client
jobs restore each distinct full-run lineage once, counting the initial partition
or family match. Their `merge-shards` input equals `FULL_SUITE_SHARDS` for the
family and is pinned by `scripts/ci-test-memo-cache.test.js`. A trusted run
folds the lineages in with `scripts/merge-test-memo.js`, keeping the newer
record per test and every live entry, because it records into that store and
saves it. A pull request only reads and discards its store with the job, so it
skips the copy and exports `PORTOS_TEST_MEMO_READ_DIRS` naming the parked
lineages, which the runner reads in place with the same precedence. A shard records only its slice, and related selection
narrows a test only through its own record. Each lineage restores to the path it
was saved from because the cache version hashes that path. The job then moves
it aside before the next restore. Each shard saves as soon as its own tests pass.
Pull requests only read. Pushes to `main`, the scheduled nightly, `workflow_dispatch` and
`workflow_call` runs on the default/release branches save a new entry keyed
by run id, and only when the test step itself succeeded, so the cache holds
nothing a pull-request branch or a red run wrote and every PR restores the
newest trusted lineage. The DB job runs the `db` scope
(`node scripts/run-ci-tests.js db`, the serial `portos_test` suite) and keeps
its own `-db-` lineage. The DB config, `server/scripts/init-db.sql` and
`server/scripts/setup-db-test.mjs` are base inputs (a schema change
invalidates every key) and `PGDATABASE` is a keyed env var.
The DB job restores the memo and counts remaining tests before provisioning
`portos_test` or installing verification tools. It skips those steps and the
DB runner when the count is zero and the impact plan does not request a live
restore. The real `pg_dump` restore runs outside the memo on full plans,
changes matching database risk rules, or changes in the restore suite's import
closure. An inconclusive closure also selects the restore on server-source changes.

## Disable

`PORTOS_TEST_MEMO=off` turns reads and writes off together and
restores the pre-memo behavior. A test spawned under Vitest (`VITEST` set)
never touches the developer's store unless it sets `PORTOS_TEST_MEMO_DIR`;
the workspace configs also clear `PORTOS_TEST_MEMO_READ_DIRS`, so a nested
run never reads a pull-request job's parked lineages.
