/**
 * Content-addressed test memo — key computation ("locked code paths").
 *
 * A key is one sha256 over every input that can change a test file's
 * outcome. Two keys exist for each test:
 *
 * - The **floor** key hashes the static+dynamic module closure: `import` /
 *   `export … from`, `require()`, `import()` and the `vi.mock` / `vi.doMock` /
 *   `vi.importActual` / `vi.importMock` / `vi.unmock` family, all with
 *   literal specifiers, from working-tree bytes. It needs no prior run.
 * - The **recorded** key hashes the modules the test actually loaded in the
 *   green run that produced its entry (Vitest's `experimental.recordDependencies`
 *   depfile). A module a test mocks away or never reaches cannot change its
 *   outcome, so this key survives churn in the lazily imported server cluster
 *   that the floor key cannot. A new edge still invalidates: the importer
 *   that gained it is in the recorded set and its bytes changed. Only plain
 *   import edges are narrowed this way: JS a member reads as text, spawns,
 *   loads with `require()`/`createRequire` or runs as a worker is a "side
 *   module" and stays in every key together with its own closure, because
 *   the module runner never records it.
 *
 * Both keys add, over their member set: every non-JS file a member names
 * through a literal path anchored at `import.meta.url`, `__dirname`,
 * `process.cwd()` or an identifier bound to one of those (a literal that
 * names a directory contributes its whole tree, bounded by
 * `DIRECTORY_INPUT_LIMIT`; past it, a tree that is only read as data is taken
 * from the repository listing instead, `dataTree`); for a real-browser test,
 * every directory the test file hands to a dev server, bundler or static
 * server (`handedDirs`), or for the recorded key only what its fixture's
 * Vite server served from it (`servedTree`, #17616); the installed version of every package the
 * members reach; the sibling imports of a Python sidecar; the version of an
 * external program a member reaches (`TEST_MEMO_TOOLS`); the workspace's
 * Vitest configuration closure and manifest, less the test-selection modules
 * and bare mock registrations (`workspaceBase`; for a recorded key, the setup
 * files and custom environment come from the record instead of the static
 * walk: `WORKSPACE_SETUP_ENTRIES`); the full Node version, platform and
 * arch; `TEST_MEMO_ENV`; and the arguments that select which cases run
 * (`caseFilter`).
 *
 * Fail closed. A test is not memoizable when a member reads a path the
 * analyzer cannot resolve, when a test or `scripts/` member spawns `git`
 * (repository state is not in the key; a test file that declares its
 * repositories fixtures, `testMemo/gitFixture.js`, is keyed by git itself
 * instead), when a directory input exceeds the
 * limit and the listing cannot stand in for it (the repository root, a tree
 * that is spawned or may be loaded natively, a nested repository), when a
 * test or `scripts/` member reads machine-local state (`data/`,
 * the home directory), when any member reads a path with a variable segment
 * nothing bounds (`join(HERE, name)`: `createScopes` resolves the variable to
 * its literal values, also through another module's literal export, or
 * proves it stays under the prefix, else the read may land anywhere), when
 * the `// test-memo: never` marker is present, when the test is a tree
 * guard (`*.guard.test.js`), in the planner's always-run set or in
 * `TEST_MEMO_NEVER`, or —
 * for the floor key only — when a module edge is non-literal or unresolvable.
 * A recorded set that reaches outside the repository is not memoizable
 * either. Every unknown construct lands in one of those buckets rather than
 * silently narrowing the key.
 *
 * Related selection (`relatedTests`) reuses the records: a test with a
 * version 2 record (per-module digests) is selected through
 * `recordedReach`, which follows a lazy `import()` only where the record
 * cannot vouch for it; any other test through its full closure.
 *
 * The store is `testMemoStore.js`; selection and the summary line live in
 * `scripts/run-ci-tests.js`.
 *
 * This file is the public facade. The implementation lives in `testMemo/`:
 * `constants.js` (tables), `tokens.js` (token helpers), `pathValues.js`
 * (path algebra), `evaluator.js` (path expressions), `scopes.js`
 * (`createScopes`), `fileFacts.js` (`extractFileFacts`), `gitFixture.js`
 * (the git-fixture declaration), `specifiers.js` and `analyzer.js` (closures
 * and keys). Every module stays builtins-only so the
 * memo runs before `npm ci`.
 */

export { tokenize } from './sourceTokens.js';
export {
  DIRECTORY_INPUT_LIMIT, GUARD_SUFFIX_REASON, NEVER_MARKER, RECORD_DIGEST_LENGTH, TEST_MEMO_ENV, TEST_MEMO_NEVER, TEST_MEMO_TOOLS,
  WORKSPACE_BASE_INPUTS, WORKSPACE_SELECTION_MODULES, WORKSPACE_SETUP_ENTRIES,
} from './testMemo/constants.js';
export { literalExports, replacedSources } from './testMemo/evaluator.js';
export { extractFileFacts } from './testMemo/fileFacts.js';
export { packageNameOf, resolveRelativeSpecifier } from './testMemo/specifiers.js';
export { computeTestMemoKeys, createDiskFs, createTestMemoAnalyzer, relatedTests } from './testMemo/analyzer.js';
