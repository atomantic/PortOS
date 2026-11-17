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
 * server (`handedDirs`); the installed version of every package the
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
 * (repository state is not in the key), when a directory input exceeds the
 * limit and the listing cannot stand in for it (the repository root, a tree
 * that is spawned or may be loaded natively, a nested repository), when a
 * test or `scripts/` member reads machine-local state (`data/`,
 * the home directory), when the `// test-memo: never` marker is present, when
 * the test is in the planner's `ALWAYS_RUN_TESTS` or `TEST_MEMO_NEVER`, or —
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
 */

import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import { tokenize, staticEdges } from './sourceTokens.js';
import { getAlwaysRunTests, FIXTURE_OWNERS } from '../ci-test-plan.js';

export { tokenize } from './sourceTokens.js';

/** Opt-out marker; anywhere in a test or a closure member. */
export const NEVER_MARKER = /\/\/\s*test-memo:\s*never\b/;

/**
 * Hex characters of sha256 a v2 memo record keeps per loaded module. It only
 * detects that a module changed since the record (never authenticates), so
 * 64 bits is ample and keeps records small.
 */
export const RECORD_DIGEST_LENGTH = 16;

/** A literal directory input larger than this is "the tree", not an input. */
export const DIRECTORY_INPUT_LIMIT = 400;

/**
 * Environment variables that change what a suite does. Audited from
 * `process.env.*` reads in test files, the Vitest configs and setup files:
 * CI/runner gates, browser and containment requirements, output verbosity,
 * and the submodule expectation. Worker-count and diagnostics variables are
 * left out on purpose — they change how fast a run is, never what it proves.
 */
export const TEST_MEMO_ENV = Object.freeze([
  'CHROME_PATH',
  'CI',
  'CI_EXPECT_SLASHDO_SUBMODULE',
  'GITHUB_ACTIONS',
  'LANG',
  'LC_ALL',
  'MEMORY_BACKEND',
  'NODE_ENV',
  'PGDATABASE',
  'PORTOS_BROWSER_TEST_PROFILE',
  'PORTOS_CI_BROWSER_OWNER',
  'PORTOS_REQUIRE_BROWSER_SUITES',
  'PORTOS_REQUIRE_DB',
  'PORTOS_REQUIRE_LINUX_CONTAINMENT',
  'PORTOS_TEST_PYTHON',
  'PORTOS_TEST_QUIET',
  'SKIP_HEAVY_INTEGRATION',
  'TZ',
  'VITEST_FAST',
]);

/**
 * External programs whose version is part of a key when a member reaches
 * them: the Python sidecars, ffmpeg/ffprobe, and Chrome for the browser
 * suites. The runner resolves the versions; the analyzer only names them.
 */
export const TEST_MEMO_TOOLS = Object.freeze(['chrome', 'ffmpeg', 'python']);

/**
 * Tree-wide guards that read the repository rather than import it. Most are
 * also in `ALWAYS_RUN_TESTS`; the rest spawn git or walk the tree and would
 * fail closed on their own. Naming them keeps the reason explicit.
 */
export const TEST_MEMO_NEVER = Object.freeze({
  'scripts/migrations/shippedPromptHashes.guard.test.js': 'compares shipped-hashes.json against the reference prompts and the merge base',
  'scripts/direct-invocation-drift.guard.test.js': 'scans every tracked .js file',
  'scripts/repo-scan-guards.guard.test.js': 'scans every tracked test file',
  'server/lib/importScoping.test.js': 'base-relative import-growth comparison against git history',
  'server/lib/layering.guard.test.js': 'scans every server/lib source for upward service imports',
  'server/lib/generatedManifests.guard.test.js': 'scans scripts/generate-*.js and their sibling tests',
  'server/lib/moduleSummaries.test.js': 'reads every server/lib module header',
  'server/lib/apiAccessPolicy.test.js': 'walks server/lib and server/services source trees',
  'server/lib/creativeLatitude.sources.guard.test.js': 'walks server sources to collect source literals',
  'server/lib/dispatchLabels.audit.guard.test.js': 'walks repository instructions and source trees',
  'server/lib/dynamicImportGlob.guard.test.js': 'walks server sources for dynamic imports',
  'server/lib/promptSystemStages.test.js': 'enumerates shipped prompt templates in data.reference',
  'server/logLevelConventions.guard.test.js': 'scans the whole server tree',
  'server/services/agentImportCycles.test.js': 'walks the server/services import graph for static cycles',
  'server/services/meatspacePostImportCycles.test.js': 'walks the server/services import graph for static cycles',
  'server/services/serviceImportCycles.test.js': 'walks the server/services import graph for static cycles',
  'server/services/twinImportCycles.test.js': 'walks the server/services import graph for static cycles',
  'server/mockContractConventions.guard.test.js': 'scans every tracked test file',
  'server/negativeProofSleepConventions.guard.test.js': 'scans every tracked test file',
  'server/childListenerOrderConventions.guard.test.js': 'scans the whole server tree',
  'server/routeTestCoverageConventions.guard.test.js': 'scans server/index.js mounts against every test',
  'server/routeValidationConventions.guard.test.js': 'scans every route module',
  'server/floatingAsyncConventions.guard.test.js': 'scans the whole server tree',
  'server/timerCallbackConventions.guard.test.js': 'scans the whole server tree',
  'client/src/lib/moduleSummaries.test.js': 'reads every client/src/lib module header',
  'client/src/hooks/moduleSummaries.test.js': 'reads every client/src/hooks module header',
  'client/src/utils/moduleSummaries.test.js': 'reads every client/src/utils module header',
  'client/src/services/moduleSummaries.test.js': 'reads every client/src/services module header',
  'client/src/services/index.test.js': 'enumerates the client/src/services directory against api.js',
  'scripts/lib/workspaceTests.test.js': 'enumerates the server workspace against vitest list',
  'client/src/test/workspaceTests.test.js': 'enumerates the client workspace against vitest list',
});

/**
 * Workspace inputs shared by every key: the Vitest config(s) and setup files
 * (walked as closures, see `workspaceBase`), the worker-pool policy, and the
 * manifest/lockfile.
 */
export const WORKSPACE_BASE_INPUTS = Object.freeze({
  server: ['server/vitest.config.js', 'server/vitest.setup.js', 'scripts/vitestCiPool.js', 'server/package.json', 'server/package-lock.json'],
  client: ['client/vitest.config.js', 'client/src/test/setup.js', 'scripts/vitestCiPool.js', 'client/package.json', 'client/package-lock.json'],
  // The Postgres service is not visible to a key; the schema its suites run against is applied from these tracked files.
  db: ['server/vitest.config.db.js', 'server/vitest.setup.js', 'scripts/vitestCiPool.js', 'server/package.json', 'server/package-lock.json',
    'server/scripts/init-db.sql', 'server/scripts/setup-db-test.mjs'],
});

/**
 * Test-selection modules the configs import only for `include`/`exclude`
 * (and the CI runner for enumeration and browser sharding). They decide
 * which files a run collects, never what a collected file proves, so the
 * workspace base stops its walk at them: adding a DB suite to
 * `DB_TEST_INCLUDE` must not move every key. A test that imports one (the
 * DB inventory guard) still keys it through its own closure.
 */
export const WORKSPACE_SELECTION_MODULES = Object.freeze([
  'scripts/lib/browserSuites.js',
  'scripts/lib/dbTestFiles.js',
  'scripts/lib/workspaceTests.js',
]);

/**
 * Setup-phase entries: each config's `setupFiles` and its repository-local
 * custom `environment`. Vitest 5's depfile already lists what they load in
 * every test file's record (`runBaseTests` seeds a file's record with the
 * environment loader's modules; setup files run inside the file's own
 * recording), so the recorded key takes them from the record and its
 * workspace base stops the static walk at them. The floor key walks them.
 * An entry the config no longer reaches is ignored rather than trusted.
 */
export const WORKSPACE_SETUP_ENTRIES = Object.freeze({
  server: ['server/vitest.setup.js', 'server/test/mediaRegistryEnvironment.js'],
  client: ['client/src/test/setup.js'],
  db: ['server/vitest.setup.js', 'server/test/mediaRegistryEnvironment.js'],
});

const JS_EXT = /\.(?:[cm]?js|jsx|tsx?)$/;
const RESOLVE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json'];
const RESOLVE_INDEXES = ['/index.js', '/index.jsx', '/index.ts', '/index.tsx'];
const BUILTINS = new Set(builtinModules);
/** Never repository inputs: installs, caches, build output, machine-local state. */
const SKIP_TREE_DIRS = new Set(['node_modules', '.git', '.cache', 'coverage', 'dist', '.vite']);
const IGNORED_INPUT_PREFIXES = ['data/', '.cache/', 'coverage/', 'dist/', 'client/dist/', 'server/.cache/', 'client/.cache/'];

const PATH_JOIN = new Set(['join', 'resolve']);
const PATH_DIRNAME = new Set(['dirname']);
const PATH_IDENTITY = new Set(['fileURLToPath', 'pathToFileURL', 'String', 'normalize', 'toNamespacedPath']);
/** Consumers of a path that never read it: string/path arithmetic and assertions. */
const NON_READ_CALLEES = new Set([
  'relative', 'basename', 'extname', 'isAbsolute', 'startsWith', 'endsWith', 'includes', 'replace', 'replaceAll',
  'split', 'slice', 'indexOf', 'lastIndexOf', 'trim', 'toLowerCase', 'toUpperCase', 'localeCompare', 'expect',
  'toBe', 'toEqual', 'toStrictEqual', 'toContain', 'toMatch', 'toHaveBeenCalledWith', 'toMatchObject', 'log',
  'error', 'warn', 'info', 'debug', 'stringify', 'encodeURIComponent', 'escapeRegExp', 'RegExp', 'toModuleKey',
  'push', 'add', 'set', 'has', 'get', 'map', 'filter', 'some', 'every', 'test', 'match', 'exec', 'isDirectlyInvoked',
  'describe', 'it', 'Error', 'TypeError', 'diagnosticTestFile', 'concat', 'from', 'padEnd', 'padStart', 'repeat', 'createRequire',
  'mkdirSync', 'mkdir', 'writeFileSync', 'writeFile', 'rmSync', 'rm', 'unlinkSync', 'renameSync', 'rename',
]);
/** `exec`/`spawn`-style sinks whose first argument names a program. */
const SPAWN_CALLEES = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork',
  'bufferedSpawn', 'bufferedSpawnOrThrow', 'prepareCliSpawn', 'execa']);
/** Filesystem sinks whose first argument names what is read. */
const READ_CALLEES = new Set(['readFileSync', 'readFile', 'readdirSync', 'readdir', 'existsSync', 'statSync',
  'lstatSync', 'stat', 'lstat', 'accessSync', 'access', 'createReadStream', 'opendirSync', 'opendir', 'realpathSync',
  'copyFileSync', 'copyFile', 'cpSync', 'cp', 'readJson', 'readJsonSync', 'globSync', 'glob']);
const DIR_READ_CALLEES = /^(?:readdir|opendir|glob)/;
const MOCK_CALLEES = new Set(['mock', 'doMock', 'importActual', 'importMock', 'unmock', 'doUnmock']);
/** Mock calls that only register a factory for a path; the rest load the module. */
const MOCK_REGISTER_CALLEES = new Set(['mock', 'doMock', 'unmock', 'doUnmock']);
const PATH_LIKE_LITERAL = /^(?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[a-z0-9]{1,8}$/i;
const GIT_SPAWN = /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec|bufferedSpawn|bufferedSpawnOrThrow)\s*\(\s*(?:'git'|`git\s)/;
const GIT_PACKAGE = /^(?:simple-git|isomorphic-git|nodegit)$/;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------
// Bracket matching and the path-expression evaluator.
// ---------------------------------------------------------------------------

const OPENERS = { '(': ')', '[': ']', '{': '}' };

/** Matching bracket indexes; an unmatched closer is ignored, an unmatched opener stays undefined. */
function matchBrackets(tokens) {
  const match = new Array(tokens.length);
  const stack = [];
  tokens.forEach((token, index) => {
    if (token.t !== 'p') return;
    if (OPENERS[token.v]) { stack.push(index); return; }
    if (token.v === ')' || token.v === ']' || token.v === '}') {
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (OPENERS[tokens[stack[depth]].v] !== token.v) continue;
        const open = stack[depth];
        stack.length = depth;
        match[open] = index;
        match[index] = open;
        return;
      }
    }
  });
  return match;
}

const UNKNOWN = Object.freeze({ k: 'unknown' });
const EXTERNAL = Object.freeze({ k: 'ext' });
/** A path under the user's home directory: machine-local state, never a repository input. */
const HOME = Object.freeze({ k: 'home' });
const NODE = Object.freeze({ k: 'node' });
const str = (v) => ({ k: 'str', v });
const normalizeRel = (value) => {
  // `new URL('../../', import.meta.url)` normalizes to './': the root is '' however it was spelled.
  const normalized = posix.normalize(value).replace(/\/$/, '');
  return normalized === '.' ? '' : normalized;
};
const pathValue = (v, extra = {}) => ({ k: 'path', v: normalizeRel(v), partial: false, isDir: false, ...extra });
const dirValue = (v) => pathValue(v, { isDir: true });

function joinPath(base, segment) {
  if (base.partial) return base;
  if (segment.k === 'str') {
    if (segment.v.startsWith('/')) return EXTERNAL;
    const leaf = posix.basename(segment.v);
    const isDir = segment.v.endsWith('/') || leaf === '..' || leaf === '.' || (base.isDir && !/\.[A-Za-z0-9]+$/.test(leaf));
    return pathValue(posix.join(base.v, segment.v), { isDir });
  }
  if (segment.k === 'path') return segment;
  if (segment.k === 'ext') return EXTERNAL;
  return { ...base, partial: true };
}

/** `${dir}/x` and `dir + '/x'`: the separator belongs to the join, not to an absolute path. */
function appendPath(base, text) {
  if (text === '') return base;
  return joinPath(base, str(text.replace(/^\/+/, '')));
}

function concatValue(left, right) {
  if (left.k === 'str' && right.k === 'str') return str(left.v + right.v);
  if (left.k === 'str' && left.v === '') return right;
  if (left.k === 'path') return right.k === 'str' ? appendPath(left, right.v) : joinPath(left, right);
  if (left.k === 'ext' || left.k === 'home') return left;
  return UNKNOWN;
}

function urlValue(args) {
  if (args.length === 0) return UNKNOWN;
  if (args.length === 1) {
    const only = args[0];
    return only.k === 'path' ? only : only.k === 'str' && /^[a-z]+:/i.test(only.v) ? EXTERNAL : only.k === 'ext' ? EXTERNAL : UNKNOWN;
  }
  const [spec, base] = args;
  if (base.k === 'ext' || base.k === 'home') return base;
  if (base.k !== 'path') return UNKNOWN;
  if (base.partial) return base;
  const baseDir = base.isDir ? base.v : posix.dirname(base.v);
  if (spec.k === 'str') {
    if (/^[a-z]+:/i.test(spec.v) || spec.v.startsWith('/')) return EXTERNAL;
    return pathValue(posix.join(baseDir, spec.v), { isDir: spec.v.endsWith('/') });
  }
  if (spec.k === 'path') return spec;
  return { ...dirValue(baseDir), partial: true };
}

function dirnameValue(value) {
  if (value.k !== 'path') return value.k === 'ext' ? EXTERNAL : UNKNOWN;
  if (value.partial) return UNKNOWN;
  return dirValue(posix.dirname(value.v));
}

function foldJoin(args) {
  if (args.length === 0) return UNKNOWN;
  let acc = args[0];
  if (acc.k === 'str' && acc.v.startsWith('/')) acc = EXTERNAL;
  for (const arg of args.slice(1)) {
    if (acc.k === 'str') {
      if (arg.k === 'str') acc = str(posix.join(acc.v, arg.v));
      else if (arg.k === 'path') acc = arg;
      else return UNKNOWN;
      continue;
    }
    if (acc.k !== 'path') return acc.k === 'ext' || acc.k === 'home' ? acc : UNKNOWN;
    acc = joinPath(acc, arg);
  }
  return acc;
}

function evaluateArgs(tokens, match, open, ctx, depth) {
  const close = match[open];
  if (close === undefined) return null;
  const args = [];
  let cursor = open + 1;
  while (cursor < close) {
    const { value, end } = evaluate(tokens, match, cursor, ctx, depth + 1);
    args.push(value);
    cursor = end;
    while (cursor < close && !(tokens[cursor].t === 'p' && tokens[cursor].v === ',')) {
      const token = tokens[cursor];
      cursor = token.t === 'p' && OPENERS[token.v] && match[cursor] !== undefined ? match[cursor] + 1 : cursor + 1;
    }
    if (cursor < close) cursor += 1;
  }
  return args;
}

function evaluate(tokens, match, start, ctx, depth = 0) {
  if (depth > 12 || start >= tokens.length) return { value: UNKNOWN, end: start };
  let { value, end } = evaluatePostfix(tokens, match, start, ctx, depth);
  while (tokens[end]?.t === 'p' && tokens[end].v === '+') {
    const rhs = evaluatePostfix(tokens, match, end + 1, ctx, depth);
    value = concatValue(value, rhs.value);
    end = rhs.end;
  }
  return { value, end };
}

const closeOf = (match, open) => (match[open] ?? open) + 1;

function evaluatePostfix(tokens, match, start, ctx, depth) {
  let { value, end } = evaluatePrimary(tokens, match, start, ctx, depth);
  for (;;) {
    const token = tokens[end];
    if (!token || token.t !== 'p' || !(token.v === '.' || token.v === '?.') || tokens[end + 1]?.t !== 'id') break;
    const name = tokens[end + 1].v;
    const open = end + 2;
    const call = tokens[open]?.t === 'p' && tokens[open].v === '(';
    if (name === 'href' || name === 'pathname') { end += 2; continue; }
    if (name === 'toString' && call) { end = closeOf(match, open); continue; }
    if (call && value.k === 'unknown' && (PATH_JOIN.has(name) || PATH_DIRNAME.has(name) || PATH_IDENTITY.has(name))) {
      // `path.join(...)`, `posix.resolve(...)`, `url.fileURLToPath(...)`: a module namespace receiver.
      const args = evaluateArgs(tokens, match, open, ctx, depth) ?? [];
      value = PATH_JOIN.has(name) ? foldJoin(args) : PATH_DIRNAME.has(name) ? dirnameValue(args[0] ?? UNKNOWN) : (args[0] ?? UNKNOWN);
      end = closeOf(match, open);
      continue;
    }
    if (call && value.k === 'unknown' && (name === 'tmpdir' || name === 'homedir')) { value = name === 'homedir' ? HOME : EXTERNAL; end = closeOf(match, open); continue; }
    // Any other member access or method call on a path leaves the subset.
    return { value: value.k === 'path' ? UNKNOWN : value, end };
  }
  return { value, end };
}

function evaluatePrimary(tokens, match, start, ctx, depth) {
  const token = tokens[start];
  if (!token) return { value: UNKNOWN, end: start };
  if (token.t === 's') return { value: str(token.v), end: start + 1 };
  if (token.t === 'tpl') {
    let acc = str(token.quasis[0]);
    for (let i = 0; i < token.exprs.length; i += 1) {
      const inner = token.exprs[i];
      const { value } = evaluate(inner, matchBrackets(inner), 0, ctx, depth + 1);
      acc = concatValue(acc, value);
      acc = concatValue(acc, str(token.quasis[i + 1]));
    }
    return { value: acc, end: start + 1 };
  }
  if (token.t === 'p' && token.v === '(') {
    const inner = evaluate(tokens, match, start + 1, ctx, depth + 1);
    return { value: inner.value, end: closeOf(match, start) };
  }
  if (token.t !== 'id') return { value: UNKNOWN, end: start + 1 };
  const dot = (i) => tokens[i]?.t === 'p' && tokens[i].v === '.';
  const id = (i, name) => tokens[i]?.t === 'id' && tokens[i].v === name;
  if (token.v === 'new' && id(start + 1, 'URL') && tokens[start + 2]?.v === '(') {
    return { value: urlValue(evaluateArgs(tokens, match, start + 2, ctx, depth) ?? []), end: closeOf(match, start + 2) };
  }
  if (token.v === '__dirname') return { value: dirValue(posix.dirname(ctx.fileRel)), end: start + 1 };
  if (token.v === '__filename') return { value: pathValue(ctx.fileRel), end: start + 1 };
  if (token.v === 'import' && dot(start + 1) && id(start + 2, 'meta')) {
    if (dot(start + 3) && (id(start + 4, 'url') || id(start + 4, 'filename'))) return { value: pathValue(ctx.fileRel), end: start + 5 };
    if (dot(start + 3) && id(start + 4, 'dirname')) return { value: dirValue(posix.dirname(ctx.fileRel)), end: start + 5 };
    return { value: UNKNOWN, end: start + 3 };
  }
  if (token.v === 'process' && dot(start + 1)) {
    if (id(start + 2, 'cwd') && tokens[start + 3]?.v === '(') return { value: dirValue(ctx.cwdRel), end: closeOf(match, start + 3) };
    if (id(start + 2, 'execPath')) return { value: NODE, end: start + 3 };
    if (id(start + 2, 'env')) {
      let end = start + 3;
      const name = dot(end) && tokens[end + 1]?.t === 'id' ? tokens[end + 1].v : null;
      if (name !== null) end += 2;
      return { value: name === 'HOME' || name === 'USERPROFILE' ? HOME : EXTERNAL, end };
    }
    return { value: UNKNOWN, end: start + 1 };
  }
  const call = tokens[start + 1]?.t === 'p' && tokens[start + 1].v === '(';
  if (call) {
    const end = closeOf(match, start + 1);
    if (token.v === 'homedir') return { value: HOME, end };
    if (['tmpdir', 'mkdtempSync', 'mkdtemp'].includes(token.v)) return { value: EXTERNAL, end };
    const args = evaluateArgs(tokens, match, start + 1, ctx, depth);
    if (args === null) return { value: UNKNOWN, end };
    if (PATH_JOIN.has(token.v)) return { value: foldJoin(args), end };
    if (PATH_DIRNAME.has(token.v)) return { value: dirnameValue(args[0] ?? UNKNOWN), end };
    if (PATH_IDENTITY.has(token.v)) return { value: args[0] ?? UNKNOWN, end };
    if (token.v === 'URL') return { value: urlValue(args), end };
    return { value: UNKNOWN, end };
  }
  return { value: bindingValue(token.v, ctx, depth), end: start + 1 };
}

/** The evaluated initializer of a `const`/`let`/`var` binding, memoized per file. */
function bindingValue(name, ctx, depth = 0) {
  const bound = ctx.bindings.get(name);
  if (bound === undefined || ctx.resolving.has(name)) return UNKNOWN;
  if (ctx.bindingValues.has(name)) return ctx.bindingValues.get(name);
  ctx.resolving.add(name);
  const { value } = evaluate(ctx.tokens, ctx.match, bound, ctx, depth + 1);
  ctx.resolving.delete(name);
  ctx.bindingValues.set(name, value);
  return value;
}

/** `const|let|var NAME =` initializers by name; a name bound twice is ambiguous and dropped. */
function collectBindings(tokens) {
  const bindings = new Map();
  const seen = new Set();
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.t !== 'id' || !(token.v === 'const' || token.v === 'let' || token.v === 'var')) continue;
    const name = tokens[i + 1];
    if (name.t !== 'id' || tokens[i + 2].t !== 'p' || tokens[i + 2].v !== '=') continue;
    if (seen.has(name.v)) { bindings.delete(name.v); continue; }
    seen.add(name.v);
    bindings.set(name.v, i + 3);
  }
  return bindings;
}

function calleeStart(tokens, open) {
  let start = open;
  while (tokens[start - 1]?.t === 'id') {
    start -= 1;
    if (tokens[start - 1]?.t === 'p' && (tokens[start - 1].v === '.' || tokens[start - 1].v === '?.') && tokens[start - 2]?.t === 'id') start -= 1;
    else break;
  }
  if (tokens[start - 1]?.t === 'id' && tokens[start - 1].v === 'new') start -= 1;
  return start;
}

const calleeName = (tokens, open) => (tokens[open - 1]?.t === 'id' ? tokens[open - 1].v : null);

/** The nearest enclosing opener whose partner lies beyond `index`, or null. */
function enclosingOpen(tokens, match, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (token.t !== 'p') continue;
    if (token.v === ')' || token.v === ']' || token.v === '}') {
      if (match[i] !== undefined) { i = match[i]; continue; }
      depth += 1;
      continue;
    }
    if (OPENERS[token.v]) {
      if (depth > 0) { depth -= 1; continue; }
      return match[i] !== undefined && match[i] > index ? i : null;
    }
  }
  return null;
}

/**
 * From an anchor token, walk outward through enclosing path-building calls
 * and `+` chains to the widest expression that still evaluates as a path,
 * and report what consumes it. `null` means the occurrence is a binding
 * initializer or a reassignment. `option` names a `cwd:`/`root:`/`dir:`/
 * `base:` property the expression is the value of: where a tool is rooted,
 * never a read by this file, though a directory there is still handed to the
 * tool (`handedDirs`). `member` marks any other object-literal value
 * (`key: <expr>` or the shorthand `{ name }`), which a block's `{` is not.
 */
function widestPathExpression(tokens, match, index) {
  let start = index;
  for (;;) {
    while (tokens[start - 1]?.t === 'p' && tokens[start - 1].v === '+') {
      const operand = tokens[start - 2];
      if (!operand) break;
      if (operand.t === 'p' && operand.v === ')' && match[start - 2] !== undefined) start = calleeStart(tokens, match[start - 2]);
      else start -= 2;
    }
    const parent = enclosingOpen(tokens, match, start);
    if (parent === null || tokens[parent].v !== '(') break;
    const callee = calleeStart(tokens, parent);
    const name = calleeName(tokens, parent);
    const isNew = tokens[callee]?.t === 'id' && tokens[callee].v === 'new';
    if ((isNew && name === 'URL') || name === 'URL' || PATH_JOIN.has(name) || PATH_DIRNAME.has(name) || PATH_IDENTITY.has(name)) {
      start = callee;
      continue;
    }
    break;
  }
  const before = tokens[start - 1];
  if (before?.t === 'p' && before.v === '=') return null;
  const parent = enclosingOpen(tokens, match, start);
  if (before?.t === 'p' && before.v === ':' && tokens[start - 2]?.t === 'id' && ['cwd', 'root', 'dir', 'base'].includes(tokens[start - 2].v)) {
    return { index: start, consumer: null, walk: false, bare: start === index, option: tokens[start - 2].v, member: true };
  }
  let consumer = null;
  let walk = false;
  if (parent !== null && tokens[parent].v === '(') {
    consumer = calleeName(tokens, parent);
    walk = consumer !== null && SPAWN_CALLEES.has(consumer);
  } else if (parent !== null && tokens[parent].v === '[') {
    const outer = enclosingOpen(tokens, match, parent);
    walk = outer !== null && tokens[outer].v === '(' && SPAWN_CALLEES.has(calleeName(tokens, outer) ?? '');
    consumer = walk ? calleeName(tokens, outer) : null;
  }
  const punct = (token, ...values) => token?.t === 'p' && values.includes(token.v);
  const keyed = punct(before, ':') && (tokens[start - 2]?.t === 'id' || tokens[start - 2]?.t === 's') && punct(tokens[start - 3], '{', ',');
  const shorthand = start === index && punct(before, '{', ',');
  return { index: start, consumer, walk, bare: start === index, option: null, member: parent !== null && tokens[parent].v === '{' && (keyed || shorthand) };
}

// ---------------------------------------------------------------------------
// Per-file extraction.
// ---------------------------------------------------------------------------

/**
 * Everything one source file contributes, before any filesystem lookup:
 * module edges, path inputs, directory inputs, cwd-relative literals, and the
 * reasons it fails closed. Pure.
 */
export function extractFileFacts(src, { fileRel, cwdRel }) {
  const facts = {
    edges: [], // { spec, kind: 'static'|'dynamic'|'require'|'mock' (registration)|'mock-import' }
    paths: [], // { rel, walk, read } — repo-relative literal paths; `read`: only handed to a filesystem read
    dirs: [], // { rel, walk, guessed } — repo-relative directory prefixes whose tree is an input; guessed: the prefix of a path with a variable segment
    scopedNames: [], // basenames a require() reads under an unknown directory: every tracked file of that name is an input
    cwdLiterals: [], // { value, walk, dir } — resolved against cwd, then repo root, then the file
    unresolvedEdges: [], // the module graph is not fully known from source
    unresolvedInputs: [], // a filesystem input is not fully known from source
    handedDirs: [], // complete directories given to code the analyzer does not model (a Vite root, a static server)
    nativeUnresolved: false, // a non-literal require(): a native load no recording shows
    localReads: [], // machine-local state a member reads (home directory); the test or tooling fails closed on it
    tools: new Set(), // external programs reached (TEST_MEMO_TOOLS)
    never: NEVER_MARKER.test(src),
    git: false,
  };
  let tokens;
  try { tokens = tokenize(src, new Set(), { jsx: !/\.[cm]?ts$/.test(fileRel) }); } catch (error) {
    facts.unresolvedEdges.push(`unparseable source: ${error.message}`);
    facts.unresolvedInputs.push(`unparseable source: ${error.message}`);
    return facts;
  }
  const match = matchBrackets(tokens);
  const ctx = { fileRel, cwdRel, tokens, match, bindings: collectBindings(tokens), bindingValues: new Map(), resolving: new Set() };
  for (const spec of staticEdges(tokens, match)) facts.edges.push({ spec, kind: 'static' });
  // `const load = createRequire(import.meta.url)` makes `load(...)` a native require;
  // `const pyBin = resolveTestPython()` makes `pyBin` the python interpreter.
  const boundTo = (callee) => new Set([...ctx.bindings].filter(([, at]) => tokens[at]?.t === 'id' && tokens[at].v === callee && tokens[at + 1]?.v === '(').map(([name]) => name));
  const requireNames = new Set(['require', ...boundTo('createRequire')]);
  const pythonNames = boundTo('resolveTestPython');
  const PYTHON_NAME = /^(?:py|python3?|py(?:thon)?(?:Bin|Path|Cmd|Exe))$/i;

  const code = tokens.map((t) => (t.t === 's' ? `'${t.v}'` : t.t === 'tpl' ? `\`${t.quasis.join('${}')}\`` : t.t === 'id' || t.t === 'p' ? t.v : '0')).join(' ');
  if (GIT_SPAWN.test(code)) facts.git = true;
  if (/\bimport \. meta \. glob\b/.test(code)) facts.unresolvedEdges.push('import.meta.glob');
  // The browser suites resolve Chrome through CHROME_PATH or playwright-core.
  if (/\bCHROME_PATH\b/.test(code) || facts.edges.some((edge) => packageNameOf(edge.spec) === 'playwright-core')) facts.tools.add('chrome');

  const literalArg = (open) => {
    const first = tokens[open + 1];
    const second = tokens[open + 2];
    if (!first || match[open] === undefined) return { kind: 'none' };
    const endsArg = second?.t === 'p' && (second.v === ',' || second.v === ')');
    if (first.t === 's' && endsArg) return { kind: 'literal', value: first.v };
    if (first.t === 'tpl' && first.exprs.length === 0 && endsArg) return { kind: 'literal', value: first.quasis[0] };
    if (first.t === 'p' && first.v === ')') return { kind: 'none' };
    return { kind: 'expr', index: open + 1 };
  };

  /** The literal last segment of `join(<anything>, 'name')`, followed through one binding; else null. */
  const joinedBasename = (index) => {
    let at = index;
    for (let hop = 0; hop < 4 && tokens[at]?.t === 'id' && ctx.bindings.has(tokens[at].v) && tokens[at + 1]?.v !== '('; hop += 1) at = ctx.bindings.get(tokens[at].v);
    if (tokens[at]?.t === 'id' && tokens[at + 1]?.v === '.' && tokens[at + 2]?.t === 'id') at += 2; // path.join(
    if (tokens[at]?.t !== 'id' || !PATH_JOIN.has(tokens[at].v) || tokens[at + 1]?.v !== '(') return null;
    const last = (evaluateArgs(tokens, match, at + 1, ctx, 0) ?? []).at(-1);
    // Only an explicit file extension proves a file: a bare name may be a directory Node resolves
    // through index.js or package.json main, which a basename match would not collect.
    return last?.k === 'str' && /\.(?:c?js|mjs|json|node)$/.test(last.v) ? posix.basename(last.v) : null;
  };

  const record = (value, { walk = false, consumer = null, bare = false, option = null, member = false } = {}) => {
    if (option !== null) {
      // The value of a rooting option is not read here; a directory is still what the tool works from.
      if (value.k === 'path' && !value.partial && option !== 'cwd') facts.handedDirs.push(value.v);
      return true;
    }
    if (value.k === 'home') {
      if (!(consumer !== null && NON_READ_CALLEES.has(consumer))) facts.localReads.push('~');
      return true;
    }
    if (value.k === 'str') {
      if (value.v.startsWith('/') || /^[a-z]+:/i.test(value.v)) return true;
      facts.cwdLiterals.push({ value: value.v, walk, dir: false });
      return true;
    }
    if (value.k !== 'path') return value.k !== 'unknown';
    if (consumer !== null && NON_READ_CALLEES.has(consumer)) return true;
    if (value.partial || value.isDir) {
      // A complete directory handed to an unknown function (`resolveInstallRoot(join(__dirname, '..'))`)
      // or passed nowhere (`cwd || process.cwd()`) is a value. A partial path (variable
      // segments) or a directory handed to a read/spawn sink is a read of that tree.
      const read = value.partial || (consumer !== null && (READ_CALLEES.has(consumer) || SPAWN_CALLEES.has(consumer)));
      if (!read) {
        // `resolveClientBundler(repoRoot)` resolves the client workspace's bundler packages.
        if (consumer === 'resolveClientBundler') facts.handedDirs.push(normalizeRel(posix.join(value.v, 'client/node_modules')));
        else if (consumer !== null || member) facts.handedDirs.push(value.v);
        return true;
      }
      facts.dirs.push({ rel: value.v, walk, guessed: value.partial });
      return true;
    }
    facts.paths.push({ rel: value.v, walk: walk || JS_EXT.test(value.v), read: consumer !== null && READ_CALLEES.has(consumer) });
    return true;
  };

  const anchorInside = (list) => list.some((t) => (t.t === 'id' && (t.v === '__dirname' || t.v === '__filename' || t.v === 'import' || t.v === 'process'
    || (ctx.bindings.has(t.v) && bindingValue(t.v, ctx).k === 'path'))) || (t.t === 'tpl' && t.exprs.some(anchorInside)));
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.t === 's') continue; // a bare string is a name (a registry entry, an exclude glob), never a read
    if (token.t === 'tpl') {
      // `${ROOT}/docs/x.md`: the hole holds the anchor, the template is the expression.
      if (!token.exprs.some(anchorInside)) continue;
      const widest = widestPathExpression(tokens, match, i);
      if (widest !== null) record(evaluate(tokens, match, widest.index, ctx).value, widest);
      continue;
    }
    if (token.t !== 'id') continue;
    const open = tokens[i + 1]?.t === 'p' && tokens[i + 1].v === '(' ? i + 1 : null;
    const prev = tokens[i - 1];
    const isMember = prev?.t === 'p' && (prev.v === '.' || prev.v === '?.');
    const receiver = isMember ? tokens[i - 2] : null;

    // Module edges that the static pass cannot see.
    if ((token.v === 'import' || requireNames.has(token.v)) && open !== null && !isMember) {
      const kind = token.v === 'import' ? 'dynamic' : 'require';
      const arg = literalArg(open);
      if (arg.kind === 'literal') { facts.edges.push({ spec: arg.value, kind }); continue; }
      if (arg.kind === 'none') continue;
      const { value } = evaluate(tokens, match, arg.index, ctx);
      if (value.k === 'path' && !value.partial && !value.isDir) { facts.paths.push({ rel: value.v, walk: true }); continue; }
      if (value.k === 'path') { facts.dirs.push({ rel: value.v, walk: true }); continue; }
      // `require(PACKAGE_CONSTANT)`: a module-level string is a specifier like a literal one.
      if (value.k === 'str') { facts.edges.push({ spec: value.v, kind }); continue; }
      // `require(join(<unknown dir>, 'ecosystem.config.cjs'))`: the directory is a parameter or an
      // install root, the basename is fixed, so every tracked file of that name is an input
      // (tests only load in-repo files, so keying by tracked basename covers the real target).
      const scoped = kind === 'require' ? joinedBasename(arg.index) : null;
      if (scoped !== null) { facts.scopedNames.push(scoped); continue; }
      if (kind === 'require') facts.nativeUnresolved = true;
      facts.unresolvedEdges.push(`${token.v}() with a non-literal specifier`);
      continue;
    }
    if (isMember && receiver?.t === 'id' && receiver.v === 'vi' && open !== null && MOCK_CALLEES.has(token.v)) {
      const arg = literalArg(open);
      if (arg.kind === 'literal') facts.edges.push({ spec: arg.value, kind: MOCK_REGISTER_CALLEES.has(token.v) ? 'mock' : 'mock-import' });
      else if (arg.kind === 'expr' && tokens[arg.index].t === 'id' && tokens[arg.index].v === 'import') continue; // vi.mock(import('./x')): the import() pass records it
      else facts.unresolvedEdges.push(`vi.${token.v}() with a non-literal specifier`);
      continue;
    }

    // Sinks.
    if (open !== null && SPAWN_CALLEES.has(token.v) && !(isMember && receiver?.t === 'id' && receiver.v === 'vi')) {
      const arg = literalArg(open);
      if (arg.kind === 'literal') {
        const program = posix.basename(arg.value.split(/\s+/)[0]);
        if (program === 'git') facts.git = true;
        else if (/^python3?$/.test(program)) facts.tools.add('python');
        else if (program === 'ffmpeg' || program === 'ffprobe') facts.tools.add('ffmpeg');
      } else if (arg.kind === 'expr') {
        const { value } = evaluate(tokens, match, arg.index, ctx);
        if (value.k === 'path') record(value, { walk: true, consumer: token.v });
        // `spawn(process.env.PORTOS_TEST_PYTHON || 'python3', …)`, `spawn(pyBin, …)` with
        // `const pyBin = resolveTestPython()`: the program expression names python.
        let python = false;
        for (let j = arg.index; j < match[open] && !(tokens[j].t === 'p' && tokens[j].v === ','); j += 1) {
          const t = tokens[j];
          if ((t.t === 'id' && (t.v === 'PORTOS_TEST_PYTHON' || pythonNames.has(t.v) || PYTHON_NAME.test(t.v))) || (t.t === 's' && /^python3?$/.test(t.v))) python = true;
        }
        if (python) facts.tools.add('python');
        else if (value.k === 'unknown' || value.k === 'ext') {
          // An unknown program handed a .py file is an interpreter the key cannot name.
          for (let j = open + 1; j < match[open]; j += 1) {
            const literal = tokens[j].t === 's' ? tokens[j].v : tokens[j].t === 'tpl' ? tokens[j].quasis.join('') : '';
            if (/\.py$/.test(literal)) { facts.unresolvedInputs.push('spawns an unknown program with a python sidecar'); break; }
          }
        }
      }
      const close = match[open];
      for (let j = open + 1; j < close; j += 1) {
        const literal = tokens[j].t === 's' ? tokens[j].v : tokens[j].t === 'tpl' && tokens[j].exprs.length === 0 ? tokens[j].quasis[0] : null;
        if (literal !== null && JS_EXT.test(literal) && PATH_LIKE_LITERAL.test(literal)) facts.cwdLiterals.push({ value: literal, walk: true, dir: false });
      }
      continue;
    }
    if (open !== null && READ_CALLEES.has(token.v)) {
      const arg = literalArg(open);
      if (arg.kind === 'literal') {
        if (!(arg.value.startsWith('/') || /^[a-z]+:/i.test(arg.value))) facts.cwdLiterals.push({ value: arg.value, walk: false, dir: DIR_READ_CALLEES.test(token.v) });
      } else if (arg.kind === 'expr') {
        const { value } = evaluate(tokens, match, arg.index, ctx);
        // An unanchored variable is a temp path or runtime data, not a repository read.
        record(value, { consumer: token.v });
      }
      continue;
    }
    if (open !== null && (token.v === 'readServerSource' || token.v === 'readClientSource') && !(prev?.t === 'id' && prev.v === 'function')) {
      // server/lib/testHelper.js reads a source file by workspace-relative name
      // (its own `function readServerSource(rel)` definition is not a call).
      const arg = literalArg(open);
      const base = token.v === 'readServerSource' ? 'server' : 'client/src';
      if (arg.kind === 'literal') facts.paths.push({ rel: normalizeRel(posix.join(base, arg.value)), walk: false, read: true });
      else if (arg.kind === 'expr') facts.unresolvedInputs.push(`${token.v}() with a non-literal path`);
      continue;
    }
    if (open !== null && token.v === 'toMatchFileSnapshot') {
      const arg = literalArg(open);
      if (arg.kind === 'literal') facts.paths.push({ rel: normalizeRel(posix.join(posix.dirname(fileRel), arg.value)), walk: false });
      else if (arg.kind === 'expr') record(evaluate(tokens, match, arg.index, ctx).value, { consumer: token.v });
      continue;
    }

    // Anchors anywhere else: the widest path expression around them is an input.
    const isAnchor = token.v === '__dirname' || token.v === '__filename'
      || (!isMember && token.v === 'import' && tokens[i + 1]?.v === '.' && tokens[i + 2]?.v === 'meta')
      || (!isMember && token.v === 'process' && tokens[i + 1]?.v === '.' && tokens[i + 2]?.v === 'cwd')
      || (!isMember && open === null && ctx.bindings.has(token.v) && bindingValue(token.v, ctx).k === 'path');
    if (!isAnchor) continue;
    // The declared name itself (`const ROOT = …`) is not a use.
    if (prev?.t === 'id' && (prev.v === 'const' || prev.v === 'let' || prev.v === 'var')) continue;
    // Nor is a property key that happens to share a binding's name (`{ root: client }` beside `const root`).
    if (tokens[i + 1]?.t === 'p' && tokens[i + 1].v === ':' && prev?.t === 'p' && (prev.v === '{' || prev.v === ',')) continue;
    const widest = widestPathExpression(tokens, match, i);
    if (widest === null) continue;
    const { value } = evaluate(tokens, match, widest.index, ctx);
    record(value, widest);
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Closure analysis and key computation.
// ---------------------------------------------------------------------------

/**
 * Resolve a specifier relative to the importing file, mirroring Vite's
 * extensionless and directory-index resolution. Returns the repo-relative
 * posix path of an existing file, or null.
 */
export function resolveRelativeSpecifier(fromRel, spec, kindOf) {
  const clean = spec.replace(/[?#].*$/, '');
  const target = posix.normalize(posix.join(posix.dirname(fromRel), clean));
  if (target.startsWith('../') || target === '..') return null;
  const candidates = [target, ...RESOLVE_EXTENSIONS.map((ext) => target + ext), ...RESOLVE_INDEXES.map((index) => target + index)];
  return candidates.find((candidate) => kindOf(candidate) === 'file') ?? null;
}

/** The package name a bare specifier reaches: `@scope/name` or `name`. */
export function packageNameOf(spec) {
  const clean = spec.replace(/[?#].*$/, '');
  const parts = clean.split('/');
  return clean.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const isBuiltin = (spec) => spec.startsWith('node:') || BUILTINS.has(packageNameOf(spec));

/**
 * The git rule and the oversized-tree rule apply to the test itself and to
 * repository tooling under `scripts/`; a product or library module's git use
 * and unbounded reads happen only when a test calls them.
 */
const gitRuleApplies = (rel, testRel) => rel === testRel || rel.startsWith('scripts/');

/**
 * The analyzer over an abstract filesystem (`read(rel) -> Buffer|null`,
 * `kind(rel) -> 'file'|'dir'|null`, `list(rel) -> string[]`), so the whole
 * thing is unit-testable from an in-memory tree.
 *
 * `listFiles` returns every working-tree file git does not ignore
 * (repo-relative posix paths), or null when it cannot say. It is asked at
 * most once per analyzer and only lets a directory input past
 * `DIRECTORY_INPUT_LIMIT` be keyed instead of failing closed (`listedTree`).
 *
 * `acceptVerdictsFrom` lists other run settings (`{ label, env, caseFilter }`,
 * `env` overriding this run's values) whose green verdict also proves this
 * run's cases. Each memoizable verdict then carries `acceptedKeys`: the key
 * those settings would compute for the same inputs, differing only in the
 * environment lines. They are lookup keys only; entries are written under
 * `key` alone. The caller owns the claim that the other run's cases include
 * this run's (`browserProfileAcceptedVerdicts`).
 */
export function createTestMemoAnalyzer({ fs, workspaceRel, env = {}, platform = process.platform, arch = process.arch, nodeVersion = process.versions.node, toolVersion = () => null, caseFilter = [], acceptVerdictsFrom = [], listFiles = null }) {
  const hashes = new Map();
  const facts = new Map();
  const trees = new Map();
  const listedTrees = new Map();
  const dataTrees = new Map();
  const packages = new Map();
  let byName = null;
  let listing; // undefined until first asked; null when git cannot list the tree

  const fileHash = (rel) => {
    if (hashes.has(rel)) return hashes.get(rel);
    const bytes = fs.read(rel);
    const digest = bytes === null ? null : sha256(bytes);
    hashes.set(rel, digest);
    return digest;
  };

  const ignoredInput = (rel) => IGNORED_INPUT_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix));
  const localState = (target) => target === 'data' || target.startsWith('data/');
  const underGit = (rel) => rel === '.git' || rel.startsWith('.git/');

  /**
   * Sorted files under `dirRel`, or null when the collected set exceeds the
   * limit. `nameRe` keeps only direct children whose basename matches; other
   * names are not counted, so a directory past the limit can still contribute
   * a small explicit set (the Python requirement pins under `scripts/`).
   */
  const tree = (dirRel, nameRe = null) => {
    const cacheKey = nameRe ? `${dirRel}\0${nameRe.source}\0${nameRe.flags}` : dirRel;
    if (trees.has(cacheKey)) return trees.get(cacheKey);
    const files = [];
    const walk = (dir) => {
      for (const name of fs.list(dir).sort()) {
        if (SKIP_TREE_DIRS.has(name) || (dir === '' && name === 'data')) continue;
        const rel = dir === '' ? name : `${dir}/${name}`;
        const kind = fs.kind(rel);
        if (kind === 'dir') {
          if (!nameRe) walk(rel);
        } else if (kind === 'file' && (!nameRe || nameRe.test(name))) files.push(rel);
        if (files.length > DIRECTORY_INPUT_LIMIT) throw new RangeError('tree too large');
      }
    };
    let result = files;
    try { walk(dirRel); } catch (error) { if (!(error instanceof RangeError)) throw error; result = null; }
    trees.set(cacheKey, result);
    return result;
  };

  /**
   * The files of a directory past the limit, from the repository listing
   * instead of a walk. Null (the caller fails closed) when there is no
   * listing; for a directory the listing has no file in (an ignored tree:
   * installs, build output, machine-local state); and for one holding an
   * entry the listing does not enumerate (a submodule or nested repository
   * is a single entry whatever it contains).
   *
   * The listing includes untracked files a commit would pick up, so a new
   * source file moves the key before it is ever staged. A listed path that
   * is gone from the working tree is left out, which changes the set.
   * Git-ignored files are outside the key here, as `.env` files and installs
   * are outside every key.
   */
  const listedTree = (dirRel) => {
    if (!listFiles) return null;
    if (listedTrees.has(dirRel)) return listedTrees.get(dirRel);
    if (listing === undefined) {
      const all = listFiles();
      listing = Array.isArray(all) ? [...new Set(all.map((rel) => rel.replace(/\/+$/, '')))].sort() : null;
    }
    let files = null;
    if (listing !== null) {
      const prefix = `${dirRel}/`;
      files = [];
      for (const rel of listing) {
        if (!rel.startsWith(prefix)) continue;
        const kind = fs.kind(rel);
        if (kind === 'dir') { files = null; break; }
        if (kind === 'file') files.push(rel);
      }
      if (files !== null && files.length === 0) files = null;
    }
    listedTrees.set(dirRel, files);
    return files;
  };

  /**
   * The files a data tree starts from: a walk under the limit, the listing
   * past it. Never the repository root, which stays "the tree" and belongs
   * to the always-run scanners.
   */
  const dataTreeFiles = (dirRel) => (dirRel === '' ? null : tree(dirRel) ?? listedTree(dirRel));

  /**
   * What a directory contributes when it is served or bundled rather than
   * executed by the test process (a suite that hands `client/` to Vite as its
   * root): every file by its bytes, plus what those files import from outside
   * the tree, transitively, since whatever serves or bundles the tree follows
   * the same specifiers (`client/src/App.jsx` imports
   * `server/lib/navManifest.js`). Only literal import edges are followed, the
   * trust the recorded key gives a side module. A served file's own
   * filesystem reads, git use and `test-memo: never` marker are not facts
   * about the test process and are left out, which is why a reader that could
   * load the tree natively is refused (`nativeUnresolved`). Null when the
   * tree cannot be enumerated (`dataTreeFiles`). Cached per directory: every
   * client-root suite shares one walk.
   */
  const dataTree = (dirRel) => {
    if (dataTrees.has(dirRel)) return dataTrees.get(dirRel);
    const start = dataTreeFiles(dirRel);
    if (start === null) { dataTrees.set(dirRel, null); return null; }
    const files = new Set();
    const absent = new Set();
    const packageVersions = new Map();
    const pending = [...start];
    while (pending.length) {
      const rel = pending.pop();
      if (files.has(rel)) continue;
      files.add(rel);
      if (!JS_EXT.test(rel)) continue;
      const f = factsFor(rel);
      for (const target of f.edgeTargets) if (!files.has(target)) pending.push(target);
      for (const missing of f.absent) absent.add(missing);
      for (const [name, version] of f.packages) packageVersions.set(name, version);
    }
    const result = { files, absent, packages: packageVersions };
    dataTrees.set(dirRel, result);
    return result;
  };

  /** Every file named `name` anywhere in the repository (one cached walk, same skips as `tree`). */
  const filesNamed = (name) => {
    if (!byName) {
      byName = new Map();
      const walk = (dir) => {
        for (const entry of fs.list(dir)) {
          if (SKIP_TREE_DIRS.has(entry) || (dir === '' && entry === 'data')) continue;
          const rel = dir === '' ? entry : `${dir}/${entry}`;
          const kind = fs.kind(rel);
          if (kind === 'dir') walk(rel);
          else if (kind === 'file') byName.set(entry, [...(byName.get(entry) ?? []), rel]);
        }
      };
      walk('');
    }
    return (byName.get(name) ?? []).sort();
  };

  /** Installed version of the package `spec` reaches from `fromRel`, or null. */
  const packageVersion = (fromRel, spec) => {
    const name = packageNameOf(spec);
    const cacheKey = `${posix.dirname(fromRel)}\0${name}`;
    if (packages.has(cacheKey)) return packages.get(cacheKey);
    const roots = [];
    for (let dir = posix.dirname(fromRel); ; dir = posix.dirname(dir)) {
      roots.push(dir === '.' ? '' : dir);
      if (dir === '.' || dir === '') break;
    }
    roots.push(workspaceRel);
    let found = null;
    for (const root of roots) {
      const bytes = fs.read(`${root === '' ? '' : `${root}/`}node_modules/${name}/package.json`);
      if (bytes === null) continue;
      try { found = { name, version: String(JSON.parse(bytes.toString('utf8')).version ?? '') }; } catch { found = null; }
      break;
    }
    packages.set(cacheKey, found);
    return found;
  };

  /** Extracted and resolved facts for one file (cached). */
  const factsFor = (rel) => {
    if (facts.has(rel)) return facts.get(rel);
    const resolved = {
      modules: new Set(), // import edges: narrowed to what a green run loaded by the recorded key
      sideModules: new Set(), // JS read as text, spawned, loaded natively or as a worker: in every key with its closure
      mockOnly: new Set(), // modules only named by a vi.mock-style registration, which loads nothing by itself
      lazyModules: new Set(), // modules only reached through a literal import(): followed for selection only where no current record vouches (`recordedReach`)
      dataModules: new Set(), // side modules only read as data (as text, or listed by a directory read); never spawned, required or run as a worker
      edgeTargets: new Set(), // every file a literal relative import, require or mock-import names, JS or not
      dataTrees: [], // directories past the limit that are keyed from the repository listing (`dataTree`)
      handedDirs: [], // existing directories this file gives to a tool; inputs of a real-browser test (`gather`)
      nativeUnresolved: false,
      inputs: new Set(), absent: new Set(), packages: new Map(), tools: new Set(),
      unresolvedEdges: [], unresolvedInputs: [], oversized: [], localReads: [], never: false, git: false,
    };
    facts.set(rel, resolved);
    const bytes = fs.read(rel);
    if (bytes === null) { resolved.unresolvedEdges.push('missing file'); resolved.unresolvedInputs.push('missing file'); return resolved; }
    if (!JS_EXT.test(rel)) { resolved.inputs.add(rel); return resolved; }
    const raw = extractFileFacts(bytes.toString('utf8'), { fileRel: rel, cwdRel: workspaceRel });
    resolved.never = raw.never;
    resolved.git = raw.git;
    resolved.nativeUnresolved = raw.nativeUnresolved;
    resolved.handedDirs = [...new Set(raw.handedDirs)].filter((dirRel) => !dirRel.startsWith('..') && fs.kind(dirRel) === 'dir');
    resolved.unresolvedEdges.push(...raw.unresolvedEdges);
    resolved.unresolvedInputs.push(...raw.unresolvedInputs);
    resolved.localReads.push(...raw.localReads);
    for (const tool of raw.tools) resolved.tools.add(tool);

    const addPackage = (spec, { mock = false } = {}) => {
      const pkg = packageVersion(rel, spec);
      if (pkg) { resolved.packages.set(pkg.name, pkg.version); return; }
      if (mock) { resolved.packages.set(packageNameOf(spec), 'absent'); return; }
      resolved.unresolvedEdges.push(`package not installed: ${packageNameOf(spec)}`);
    };
    /** A Python sidecar's sibling imports are inputs too (one directory, resolvable names only). */
    const addPython = (target, seen = new Set()) => {
      if (seen.has(target)) return;
      seen.add(target);
      resolved.inputs.add(target);
      const text = fs.read(target)?.toString('utf8') ?? '';
      const dir = posix.dirname(target);
      for (const line of text.split('\n')) {
        const m = /^\s*(?:from\s+(\.*[\w.]*)\s+import\b|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/.exec(line);
        const names = m ? (m[1] !== undefined ? [m[1]] : m[2].split(',')).map((part) => part.trim()).filter(Boolean) : [];
        // `importlib.import_module('x')` is a sibling import; a non-literal name may reach any module.
        if (!/^\s*#/.test(line)) {
          for (const call of line.matchAll(/\bimport_module\s*\(\s*(?:(['"])([\w.]+)\1(?=\s*[,)])|)/g)) {
            if (call[2] !== undefined) names.push(call[2]);
            else resolved.unresolvedInputs.push(`python import_module with a non-literal name in ${target}`);
          }
        }
        for (const name of names) {
          const relative = name.startsWith('.');
          const head = name.replace(/^\.+/, '').split('.')[0];
          const candidate = [`${dir}/${head}.py`, `${dir}/${head}/__init__.py`].find((rel) => fs.kind(rel) === 'file');
          if (candidate) addPython(candidate, seen);
          else if (relative) resolved.unresolvedInputs.push(`python import ${name} in ${target} does not resolve`);
        }
      }
    };
    const executedSide = new Set();
    const addFile = (target, { edge = false, data = false } = {}) => {
      if (JS_EXT.test(target) && !edge) (data ? resolved.dataModules : executedSide).add(target);
      if (JS_EXT.test(target)) (edge ? resolved.modules : resolved.sideModules).add(target);
      else if (target.endsWith('.py')) addPython(target);
      else resolved.inputs.add(target);
    };
    const oversizedData = [];
    for (const name of raw.scopedNames) for (const target of filesNamed(name)) addFile(target);
    const addDir = (dirRel, walk, guessed = false) => {
      if (localState(dirRel)) { resolved.localReads.push(dirRel); return; }
      if (ignoredInput(dirRel)) return;
      if (underGit(dirRel)) { resolved.unresolvedInputs.push('reads repository state under .git'); return; }
      if (fs.kind(dirRel) !== 'dir') return;
      const files = tree(dirRel);
      // Past the limit: a tree only read as data may still be keyed, decided once this file's edges are
      // all known. Not a guessed one: the variable segment may leave the prefix (`join(HERE, p)` called
      // with '../../client/x.js'), and under the limit that guess was only ever an approximation.
      if (files === null) { if (walk || guessed) resolved.oversized.push(dirRel || '<repo root>'); else oversizedData.push(dirRel); return; }
      for (const file of files) addFile(file, { data: !walk });
    };
    const addPath = (target, walk, read = false) => {
      if (underGit(target)) { resolved.unresolvedInputs.push('reads repository state under .git'); return; }
      if (localState(target)) { resolved.localReads.push(target); return; }
      if (ignoredInput(target)) return;
      const inModules = target.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
      if (inModules) { addPackage(inModules[1]); return; }
      const kind = fs.kind(target);
      if (kind === 'file') { addFile(target, { data: read }); return; }
      if (kind === 'dir') { addDir(target, walk); return; }
      const viaExt = resolveRelativeSpecifier('x', `./${target}`, fs.kind);
      if (viaExt) addFile(viaExt, { data: read });
    };

    const registered = new Set();
    const loaded = new Set();
    const eager = new Set();
    for (const { spec, kind } of raw.edges) {
      if (spec.startsWith('/')) { resolved.unresolvedEdges.push(`absolute specifier ${spec}`); continue; }
      if (spec.startsWith('.')) {
        const target = resolveRelativeSpecifier(rel, spec, fs.kind);
        if (target !== null) (kind === 'mock' ? registered : loaded).add(target);
        if (target !== null) (kind === 'dynamic' ? resolved.lazyModules : eager).add(target);
        if (target !== null && kind !== 'mock') resolved.edgeTargets.add(target);
        // require() is a native load the Vite module runner never records.
        if (target !== null) { addFile(target, { edge: kind !== 'require' }); continue; }
        // Node cannot load a module whose import is missing, so a file with one
        // is data (served to a browser, templated, mocked away): the key records
        // the absence and changes the day the file appears.
        resolved.absent.add(normalizeRel(posix.join(posix.dirname(rel), spec.replace(/[?#].*$/, ''))));
        continue;
      }
      if (isBuiltin(spec) || spec.startsWith('data:')) continue;
      if (GIT_PACKAGE.test(packageNameOf(spec))) resolved.git = true;
      addPackage(spec, { mock: kind === 'mock' || kind === 'mock-import' });
    }
    for (const target of registered) if (!loaded.has(target) && resolved.modules.has(target)) resolved.mockOnly.add(target);
    for (const target of eager) resolved.lazyModules.delete(target);
    for (const { rel: target, walk, read } of raw.paths) addPath(target, walk, read);
    for (const { rel: dirRel, walk, guessed } of raw.dirs) addDir(dirRel, walk, guessed === true);
    for (const { value, walk, dir } of raw.cwdLiterals) {
      const bases = value.startsWith('.') ? [posix.dirname(rel), workspaceRel] : [workspaceRel, '', posix.dirname(rel)];
      for (const base of bases) {
        const target = normalizeRel(posix.join(base, value));
        if (target.startsWith('..')) continue;
        const kind = fs.kind(target);
        if (kind === 'file') { addPath(target, walk, !walk); break; }
        if (kind === 'dir' && dir) { addDir(target, walk); break; }
      }
    }
    // One executing reference outweighs any number of data reads.
    for (const target of executedSide) resolved.dataModules.delete(target);
    // A reader with a non-literal require() may load what it read natively, where no
    // recording shows it and the file's own reads count: that stays failed closed.
    // (A non-literal import() is recorded when it runs, and fails the floor key anyway.)
    for (const dirRel of oversizedData) {
      if (!resolved.nativeUnresolved && dataTreeFiles(dirRel) !== null) resolved.dataTrees.push(dirRel);
      else resolved.oversized.push(dirRel || '<repo root>');
    }
    return resolved;
  };

  /**
   * Fold one directory a real-browser test hands to a tool into `into`
   * (`inputs`, `absent`, `dataPackages`), or return why it cannot be keyed.
   * An install directory stands for its manifest and lockfile. Build output
   * and caches are never inputs, so a suite that serves one fails closed:
   * what it renders was made from sources this key would not see.
   */
  const addHandedDir = (dir, own, into) => {
    if (dir === '') return 'hands the repository root to a tool';
    if (underGit(dir)) return 'reads repository state under .git';
    if (localState(dir)) return `reads machine-local state (${dir})`;
    const installs = /^(.*?)\/?node_modules(?:\/|$)/.exec(dir);
    if (installs) {
      for (const name of ['package.json', 'package-lock.json']) {
        const manifest = normalizeRel(posix.join(installs[1], name));
        if (fs.kind(manifest) === 'file') into.inputs.add(manifest);
      }
      return null;
    }
    if (ignoredInput(dir)) return `hands build output or a cache to a tool: ${dir}`;
    if (own.nativeUnresolved) return `hands ${dir} to a tool and has a non-literal require()`;
    const data = dataTree(dir);
    if (data === null) return `directory input too large: ${dir}`;
    into.trees?.add(dir);
    for (const file of data.files) into.inputs.add(file);
    for (const missing of data.absent) into.absent.add(missing);
    for (const [name, version] of data.packages) if (!into.dataPackages.has(name)) into.dataPackages.set(name, version);
    return null;
  };

  /**
   * True when the code `roots` run reaches Chrome: a root, or (when walking)
   * a module it imports or a script it executes, names the browser. JS that
   * is only read as data does not count: a product module that lists a
   * template directory also lists that directory's browser tests, and that
   * must not turn every importer into a real-browser test.
   */
  const reachesChrome = (roots, walk) => {
    const seen = new Set();
    const pending = [...roots];
    while (pending.length) {
      const rel = pending.pop();
      if (seen.has(rel)) continue;
      seen.add(rel);
      const f = factsFor(rel);
      if (f.tools.has('chrome')) return true;
      if (walk) for (const dep of f.modules) pending.push(dep);
      for (const side of f.sideModules) if (!f.dataModules.has(side)) pending.push(side);
    }
    return false;
  };

  /** Fold the facts of `members` (and, when walking, of everything they reach) into one verdict. */
  const gather = (roots, { walk, testRel = null, stop = null, followMockOnly = true }) => {
    const members = new Set();
    // A side module (read as text, spawned, loaded natively or as a worker)
    // is never narrowed by the recording: it and its own closure are walked
    // in full even when the roots are a recorded set.
    const stack = [...roots].map((rel) => ({ rel, walkEdges: walk }));
    const inputs = new Set();
    const absent = new Set();
    const packageVersions = new Map();
    const dataPackages = new Map();
    const trees = new Set(); // directories keyed whole (`dataTree`)
    const tools = new Set();
    const unresolvedEdges = [];
    const unresolvedInputs = [];
    let never = false;
    let git = false;
    while (stack.length) {
      const { rel, walkEdges } = stack.pop();
      if (members.has(rel) || stop?.has(rel)) continue;
      members.add(rel);
      const f = factsFor(rel);
      if (walkEdges) for (const dep of f.modules) if (!members.has(dep) && (followMockOnly || !f.mockOnly.has(dep))) stack.push({ rel: dep, walkEdges: true });
      for (const side of f.sideModules) if (!members.has(side)) stack.push({ rel: side, walkEdges: true });
      for (const input of f.inputs) inputs.add(input);
      for (const tool of f.tools) tools.add(tool);
      // Machine-local state (data/, the home directory) is outside every key:
      // the test and repository tooling fail closed on reading it; a product
      // module's runtime data path is redirected or mocked by its tests.
      if (f.localReads.length && (testRel === null || gitRuleApplies(rel, testRel))) unresolvedInputs.push(`${rel}: reads machine-local state (${f.localReads[0]})`);
      for (const missing of f.absent) absent.add(missing);
      for (const [name, version] of f.packages) packageVersions.set(name, version);
      for (const reason of f.unresolvedEdges) unresolvedEdges.push(`${rel}: ${reason}`);
      for (const reason of f.unresolvedInputs) unresolvedInputs.push(`${rel}: ${reason}`);
      // A tree past the limit under a variable path is the whole repository as
      // far as the key can tell. For the test and for repository tooling that
      // fails closed. A library member (`server/lib/testHelper.js` and its
      // source walkers) reads such a tree only when a test calls it, and every
      // test that does is a tree scanner the planner already keeps always-run
      // (`scripts/repo-scan-guards.guard.test.js` enforces the registration).
      // A data-read tree the repository listing can enumerate is keyed instead
      // (`dataTree`), under the same membership rule.
      const ownsTrees = testRel === null || gitRuleApplies(rel, testRel);
      for (const dir of f.oversized) if (ownsTrees) unresolvedInputs.push(`${rel}: directory input too large: ${dir}`);
      for (const dir of ownsTrees ? f.dataTrees : []) {
        const data = dataTree(dir);
        if (data === null) { unresolvedInputs.push(`${rel}: directory input too large: ${dir}`); continue; }
        trees.add(dir);
        for (const file of data.files) inputs.add(file);
        for (const missing of data.absent) absent.add(missing);
        // The members' own resolution wins where both name a package.
        for (const [name, version] of data.packages) if (!dataPackages.has(name)) dataPackages.set(name, version);
      }
      if (f.never) never = true;
      if (f.git && (testRel === null || gitRuleApplies(rel, testRel))) git = true;
    }
    // A real-browser test renders what a dev server, bundler or static server
    // reads for it, none of which the module runner records. Every directory
    // the test file hands to such a tool is therefore an input, whole. Every
    // other test keeps the older reading (a directory passed along is a value).
    if (testRel !== null && members.has(testRel) && reachesChrome(roots, walk)) {
      const own = factsFor(testRel);
      for (const dir of own.handedDirs) {
        const problem = addHandedDir(dir, own, { inputs, absent, dataPackages, trees });
        if (problem) unresolvedInputs.push(`${testRel}: ${problem}`);
      }
    }
    for (const [name, version] of dataPackages) if (!packageVersions.has(name)) packageVersions.set(name, version);
    return { members, inputs, absent, packages: packageVersions, tools, trees, unresolvedEdges, unresolvedInputs, never, git };
  };

  const closureOf = (entry, testRel = entry, stop = null, { followMockOnly = true } = {}) => gather([entry], { walk: true, testRel, stop, followMockOnly });

  const snapshotInputs = (testRel) => {
    const base = posix.basename(testRel);
    const dir = posix.dirname(testRel);
    return [`${dir}/__snapshots__/${base}.snap`, `${dir}/__snapshots__/${base.replace(/\.(?:test|spec)\.[jt]sx?$/, '')}.snap`]
      .filter((rel) => fs.kind(rel) === 'file');
  };

  const fixtureInputs = (testRel) => {
    const inputs = new Set();
    const problems = [];
    for (const owner of FIXTURE_OWNERS) {
      if (!owner.tests.includes(testRel)) continue;
      const files = tree(owner.dir, owner.fileRe);
      if (files === null) problems.push(`fixture directory too large: ${owner.dir}`);
      else for (const file of files) inputs.add(file);
    }
    return { inputs, problems };
  };

  const environmentLinesFor = (runEnv, runCaseFilter) => [
    `node ${nodeVersion} ${platform} ${arch}`,
    ...TEST_MEMO_ENV.map((name) => `env ${name} ${runEnv[name] === undefined ? '<unset>' : runEnv[name]}`),
    // Arguments that decide which cases of a file run (a browser profile's name
    // pattern). A green verdict covers only the cases that ran, so the filter is
    // an input; an unfiltered run adds no line and keeps its keys.
    ...runCaseFilter.map((arg) => `case-filter ${arg}`),
  ];
  const environmentLines = environmentLinesFor(env, caseFilter);
  // Node, platform and arch stay this run's: only the env and case filter may differ.
  const acceptedEnvironments = acceptVerdictsFrom.map(({ label, env: overrides, caseFilter: otherFilter }) => (
    { label, lines: environmentLinesFor({ ...env, ...overrides }, otherFilter) }));

  /**
   * The workspace-level inputs every key shares: the Vitest config closure and
   * manifest. The walk skips `WORKSPACE_SELECTION_MODULES` and the targets of
   * a bare `vi.mock`/`vi.doMock`/`vi.unmock` registration: setup's global
   * `vi.mock('./services/instances.js', …)` loads instances.js only when a
   * test imports it, and then it is in that test's own closure (a non-literal
   * edge fails the floor key closed) or record. `recorded` is the same walk stopped at the setup entries the
   * config reaches (`WORKSPACE_SETUP_ENTRIES`), for a recorded key whose
   * module list names every one of `recorded.entries`. It keeps the full
   * walk's `unresolved`, so a setup-phase problem fails both keys closed.
   */
  const workspaceBase = (roots, setupEntries = []) => {
    const walkBase = (setupStops) => {
      const stop = new Set([...WORKSPACE_SELECTION_MODULES, ...setupStops]);
      const files = new Set();
      const packageVersions = new Map();
      const unresolved = [];
      for (const root of roots) {
        if (stop.has(root)) continue;
        if (fs.kind(root) !== 'file') { unresolved.push(`missing workspace input ${root}`); continue; }
        if (!JS_EXT.test(root)) { files.add(root); continue; }
        const closure = closureOf(root, null, stop, { followMockOnly: false });
        for (const rel of closure.members) files.add(rel);
        for (const rel of closure.inputs) files.add(rel);
        for (const [name, version] of closure.packages) packageVersions.set(name, version);
        unresolved.push(...closure.unresolvedEdges, ...closure.unresolvedInputs);
      }
      return { files, packages: packageVersions, unresolved };
    };
    const full = walkBase([]);
    const entries = setupEntries.filter((rel) => full.files.has(rel));
    if (!entries.length) return { ...full, recorded: null };
    const narrowed = walkBase(entries);
    return { ...full, recorded: { ...narrowed, unresolved: full.unresolved, entries } };
  };

  const verdict = (testRel, gathered, extra, baseClosure, { requireEdges }) => {
    const reasons = [];
    if (getAlwaysRunTests().includes(testRel)) reasons.push('always-run guard');
    if (TEST_MEMO_NEVER[testRel]) reasons.push(TEST_MEMO_NEVER[testRel]);
    if (gathered.never) reasons.push('test-memo: never marker');
    // Set before the analyzer's own findings are appended: these three are a decision someone wrote down.
    const declared = reasons.length > 0;
    if (gathered.git) reasons.push('spawns git');
    if (baseClosure.unresolved.length) reasons.push(`workspace config: ${baseClosure.unresolved[0]}`);
    if (requireEdges) reasons.push(...gathered.unresolvedEdges);
    reasons.push(...gathered.unresolvedInputs, ...extra.problems);
    if (reasons.length) return { key: null, memoizable: false, reason: reasons[0], reasons, declared };
    const lines = [];
    // Suites that key the same tree from inside it hash the same file set, and an
    // entry names one test: without this line they would overwrite each other's entry.
    if (gathered.trees.size) lines.push(`test ${testRel}`);
    const files = new Set([...gathered.members, ...gathered.inputs, ...extra.inputs, ...snapshotInputs(testRel), ...baseClosure.files]);
    for (const rel of [...files].sort()) {
      const digest = fileHash(rel);
      if (digest === null) return { key: null, memoizable: false, reason: `unreadable input ${rel}`, reasons: [`unreadable input ${rel}`] };
      lines.push(`file ${rel} ${digest}`);
    }
    for (const rel of [...gathered.absent].sort()) lines.push(`absent ${rel}`);
    const versions = new Map([...baseClosure.packages, ...gathered.packages]);
    for (const name of [...versions.keys()].sort()) lines.push(`pkg ${name} ${versions.get(name)}`);
    for (const tool of [...gathered.tools].sort()) lines.push(`tool ${tool} ${toolVersion(tool) ?? 'absent'}`);
    const keyWith = (head) => sha256([...head, ...lines].join('\n'));
    return {
      key: keyWith(environmentLines),
      acceptedKeys: acceptedEnvironments.map(({ label, lines: head }) => ({ label, key: keyWith(head) })),
      memoizable: true,
      reasons: [],
    };
  };

  /** The truncated content digest a v2 memo record stores per loaded module; null for a missing file. */
  const moduleDigest = (rel) => fileHash(rel)?.slice(0, RECORD_DIGEST_LENGTH) ?? null;

  /**
   * What can change a recorded test's outcome, for related selection: the
   * test, every module its green run loaded, the names those modules import,
   * and their non-JS inputs. A module the run did not load is reached by
   * name only: under unchanged recorded code it was mocked away or on an
   * untaken path. A literal `import()` edge is followed only from the test
   * itself and below a member whose bytes no longer match the record's
   * digest: a lazy edge gained since the run is in such a member, so its
   * whole closure counts, as it does for an unrecorded test. Side modules
   * keep their whole closure because the module runner never records them.
   * An unresolved edge fails closed in a stale member or below a side module
   * that executes (spawned, `require()`d, run as a worker); JS only read as
   * data (`dataModules`: read as text, or listed by a directory read) counts
   * by its own bytes, and with its closure (which cannot fail closed, the
   * trust the recorded key gives it) only when the reader has a non-literal
   * import that could evaluate it. Only a record whose members all still exist gets here (the
   * recorded key fails closed on a missing one).
   *
   * @param {{ modules: string[], digests: string[] }} record
   * @returns {{ reach: Set<string>, failClosed: string|null }}
   */
  const recordedReach = (testRel, record) => {
    const recordedDigest = new Map(record.modules.map((rel, index) => [rel, record.digests[index]]));
    const NARROW = 0;
    const DATA = 1;
    const FULL = 2;
    const reach = new Set();
    // The directories a real-browser test hands to a tool (`gather`); a problem there already failed the recorded key.
    const own = factsFor(testRel);
    if (reachesChrome([testRel, ...record.modules], false)) {
      for (const dir of own.handedDirs) addHandedDir(dir, own, { inputs: reach, absent: new Set(), dataPackages: new Map() });
    }
    const walked = new Map(); // rel -> highest mode walked; a wider later visit re-walks it
    const stack = [testRel, ...record.modules].map((rel) => ({ rel, mode: NARROW }));
    let failClosed = null;
    while (stack.length) {
      const next = stack.pop();
      const { rel } = next;
      reach.add(rel);
      if (fileHash(rel) === null) continue;
      const stale = recordedDigest.has(rel) && moduleDigest(rel) !== recordedDigest.get(rel);
      const mode = stale ? FULL : next.mode;
      // Reached only through unchanged recorded code yet absent from the record:
      // the green run never loaded it (mocked away or on an untaken path), so
      // nothing below it can change the outcome. Its own name stays in reach.
      if (mode === NARROW && !recordedDigest.has(rel) && rel !== testRel) continue;
      if ((walked.get(rel) ?? -1) >= mode) continue;
      walked.set(rel, mode);
      const f = factsFor(rel);
      for (const input of f.inputs) reach.add(input);
      if (gitRuleApplies(rel, testRel)) for (const dir of f.dataTrees) for (const file of dataTree(dir)?.files ?? []) reach.add(file);
      if (mode === FULL && f.unresolvedEdges.length && failClosed === null) failClosed = `${rel}: ${f.unresolvedEdges[0]}`;
      const lazy = mode !== NARROW || rel === testRel;
      for (const dep of f.modules) if (lazy || !f.lazyModules.has(dep)) stack.push({ rel: dep, mode });
      for (const side of f.sideModules) {
        // Read as data by a module with only literal edges: just those bytes count.
        // A reader with a non-literal import may evaluate what it read (a data: URL), so the closure counts.
        if (f.dataModules.has(side) && f.unresolvedEdges.length === 0) reach.add(side);
        else stack.push({ rel: side, mode: mode === DATA || f.dataModules.has(side) ? DATA : FULL });
      }
    }
    return { reach, failClosed };
  };

  /**
   * Both keys for one test. `recorded` is the module list a previous green
   * run loaded (repo-relative), or null when none is on record. `digests`
   * (aligned with `recorded`, from a v2 record) also narrows related
   * selection to `recordedReach` when the recorded key is memoizable — the
   * gate the record was written under, so selection never trusts a record
   * the memo itself would not.
   *
   * @returns {{ floor: Verdict, recorded: Verdict|null, closure: Set<string>, edgesResolved: boolean, narrowed: object|null }}
   */
  const analyzeTest = (testRel, { baseClosure, recorded = null, digests = null }) => {
    const closure = closureOf(testRel);
    const fixtures = fixtureInputs(testRel);
    const floor = verdict(testRel, closure, fixtures, baseClosure, { requireEdges: true });
    let recordedVerdict = null;
    if (recorded !== null) {
      const outside = recorded.find((rel) => rel.startsWith('../') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel));
      if (outside !== undefined) {
        recordedVerdict = { key: null, memoizable: false, reason: `loaded a module outside the repository: ${outside}`, reasons: [] };
      } else {
        const gathered = gather(new Set([testRel, ...recorded]), { walk: false, testRel });
        // A record missing a setup entry (a per-file environment pragma, a
        // Vitest that stopped recording them) keeps the full static base.
        const base = baseClosure.recorded?.entries.every((rel) => gathered.members.has(rel)) ? baseClosure.recorded : baseClosure;
        recordedVerdict = verdict(testRel, gathered, fixtures, base, { requireEdges: false });
      }
    }
    const narrowed = recordedVerdict?.memoizable && Array.isArray(digests) && digests.length === recorded.length
      ? recordedReach(testRel, { modules: recorded, digests })
      : null;
    return { floor, recorded: recordedVerdict, closure: closure.members, inputs: closure.inputs, edgesResolved: closure.unresolvedEdges.length === 0, narrowed };
  };

  return { analyzeTest, closureOf, fileHash, moduleDigest, workspaceBase, factsFor };
}

/**
 * Keys for `testFiles` (repo-relative posix paths) in one workspace.
 * `records` maps a test to the module list its last green run loaded.
 * `digests` maps a test to that record's per-module digests (a v2 record),
 * which lets related selection narrow it.
 *
 * @returns {Map<string, { floor, recorded, closure: Set<string>, edgesResolved: boolean }>}
 */
export function computeTestMemoKeys(testFiles, { fs, workspace, env, platform, arch, nodeVersion, toolVersion, caseFilter, listFiles, records = new Map(), digests = new Map() }) {
  const analyzer = createTestMemoAnalyzer({ fs, workspaceRel: workspace, env, platform, arch, nodeVersion, toolVersion, caseFilter, listFiles });
  const baseClosure = analyzer.workspaceBase(WORKSPACE_BASE_INPUTS[workspace] ?? [], WORKSPACE_SETUP_ENTRIES[workspace] ?? []);
  const out = new Map();
  for (const test of testFiles) out.set(test, analyzer.analyzeTest(test, { baseClosure, recorded: records.get(test) ?? null, digests: digests.get(test) ?? null }));
  return out;
}

/**
 * Tests related to `sources` under closure-based selection. A test with a
 * narrowing record (`analyzeTest`'s `narrowed`) is related when a source is
 * in its `recordedReach`, or when that walk failed closed. Any other test is
 * related when a source is in its static+dynamic module closure or among the
 * non-JS inputs it reaches (a JSON or CSS import, a fixture), or when its
 * edges could not all be resolved (fail closed: it may reach anything).
 */
export function relatedTests(keys, sources) {
  const changed = new Set(sources);
  const reaches = (set) => [...set].some((rel) => changed.has(rel));
  return [...keys.entries()]
    .filter(([, info]) => (info.narrowed
      ? info.narrowed.failClosed !== null || reaches(info.narrowed.reach)
      : !info.edgesResolved || reaches(info.closure) || reaches(info.inputs)))
    .map(([test]) => test);
}

/** A disk-backed `fs` for `createTestMemoAnalyzer`, rooted at `repoRoot`. */
export function createDiskFs(repoRoot, nodeFs, nodePath) {
  const abs = (rel) => nodePath.join(repoRoot, ...rel.split('/').filter(Boolean));
  const stat = (rel) => {
    try { return nodeFs.statSync(abs(rel)); } catch { return null; }
  };
  return {
    read(rel) {
      const s = stat(rel);
      if (!s || !s.isFile()) return null;
      try { return nodeFs.readFileSync(abs(rel)); } catch { return null; }
    },
    kind(rel) {
      const s = stat(rel);
      return !s ? null : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null;
    },
    list(rel) {
      try { return nodeFs.readdirSync(abs(rel)); } catch { return []; }
    },
  };
}
