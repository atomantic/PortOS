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
 */

import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import { tokenize, staticEdges } from './sourceTokens.js';
import { getAlwaysRunTests, FIXTURE_OWNERS } from './ciPlanRules.js';
import { isGuardTest } from './guardScanners.js';

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
 * Tree readers the guard suffix and the always-run set do not already cover:
 * catalog and enumeration tests another selector reaches. A `*.guard.test.js`
 * and an always-run test are never memoized without an entry here (`verdict`);
 * these spawn git or walk the tree and would fail closed on their own, and
 * naming them keeps the reason explicit.
 */
export const TEST_MEMO_NEVER = Object.freeze({
  'server/lib/cos/moduleSummaries.test.js': 'reads every server/lib/cos module header',
  'server/lib/agent/moduleSummaries.test.js': 'reads every server/lib/agent module header',
  'server/lib/moduleSummaries.test.js': 'reads every server/lib module header',
  'server/lib/catalog/moduleSummaries.test.js': 'reads every server/lib/catalog module header',
  'server/lib/persistent/moduleSummaries.test.js': 'reads every server/lib/persistent module header',
  'server/lib/provider/moduleSummaries.test.js': 'reads every server/lib/provider module header',
  'server/lib/promptSystemStages.test.js': 'enumerates shipped prompt templates in data.reference',
  'client/src/lib/moduleSummaries.test.js': 'reads every client/src/lib module header',
  'client/src/hooks/moduleSummaries.test.js': 'reads every client/src/hooks module header',
  'client/src/utils/moduleSummaries.test.js': 'reads every client/src/utils module header',
  'client/src/services/moduleSummaries.test.js': 'reads every client/src/services module header',
  'client/src/services/index.test.js': 'enumerates the client/src/services directory against api.js',
  'scripts/lib/workspaceTests.test.js': 'enumerates the server workspace against vitest list',
  'client/src/test/workspaceTests.test.js': 'enumerates the client workspace against vitest list',
});

/** Why a client tree guard, which rides client changes rather than every plan, is never memoized. */
export const GUARD_SUFFIX_REASON = 'tree guard (*.guard.test.js)';

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
/** `readServerSource(rel)` / `readClientSource(rel)` (server/lib/testHelper.js): the workspace directory `rel` is relative to. */
const SOURCE_READERS = Object.freeze({ readServerSource: 'server', readClientSource: 'client/src' });
/**
 * Helpers whose every call is keyed or refused at the call site by name
 * (`SOURCE_READERS`): a literal names the file, anything else fails closed.
 * Their own read of the variable path is therefore no input of the module
 * that defines them, which every suite importing it would otherwise share.
 */
const CALL_SITE_CHECKED_READERS = Object.freeze({ 'server/lib/testHelper.js': Object.keys(SOURCE_READERS) });
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
/**
 * `delimiter` imported from node's `path`: `:` or `;`, never a path separator.
 * `${dir}${delimiter}${rest}` puts `dir` on a search path (`PATH`) and ends it
 * there, so what follows is another entry (`searchPath`), not more of `dir`.
 */
const DELIMITER = Object.freeze({ k: 'delimiter' });
/** A search-path string: each entry a directory whose programs may be found and run (`record`). */
const searchPath = (entries, tail = str('')) => ({ k: 'search', entries, tail });
const str = (v) => ({ k: 'str', v });
const normalizeRel = (value) => {
  // `new URL('../../', import.meta.url)` normalizes to './': the root is '' however it was spelled.
  const normalized = posix.normalize(value).replace(/\/$/, '');
  return normalized === '.' ? '' : normalized;
};
const pathValue = (v, extra = {}) => ({ k: 'path', v: normalizeRel(v), partial: false, isDir: false, ...extra });
const dirValue = (v) => pathValue(v, { isDir: true });
const unfollowedReason = (value) => `reads a path the analyzer cannot follow through ${value.unfollowed}`;
const openReadReason = (rel, via) => via == null
  ? `reads a path with a variable segment that can leave ${rel || '<repo root>'}`
  : `reads a path through ${via}() that the analyzer cannot resolve (under ${rel || '<repo root>'})`;

/**
 * A path with a variable part (`partial`) names only its literal prefix `v`.
 * Whether a read of it can land outside that prefix is its containment:
 *
 * - `open: false`: every variable part is a directory-entry name (`LISTED_NAME`)
 *   or went through `pathWithin()`, so the path is inside `v`.
 * - `open: true` with `vars`: each variable part is a parameter or loop
 *   variable with a known set of literal values (`Binder.domain`); the
 *   expression is evaluated again once per combination, exactly.
 * - `open: true` with `vars: null`: nothing bounds it. `via` names the helper
 *   whose parameter it is, for the reason a test is refused with.
 *
 * `trust` lists what a contained path took on trust: `fs` (a directory
 * listing), `crypto` (`randomUUID`), `guard` (`pathWithin`). A member of the
 * closure that mocks one of them takes the proof away (`gather`).
 */
const CONTAINED = Object.freeze({ open: false, vars: null, via: null, trust: Object.freeze([]), filter: null });
const UNBOUNDED = Object.freeze({ open: true, vars: null, via: null, trust: Object.freeze([]), filter: null });
const containmentOf = ({ open, vars = null, via = null, trust = [], filter = null }) => (open ? { open, vars, via, trust: [], filter: null } : { ...CONTAINED, trust, filter });
/** Two variable parts in one path: inside only when both are; resolvable only when both are. */
function bothContainments(a, b) {
  if (!a.open && !b.open) return { ...CONTAINED, trust: [...new Set([...(a.trust ?? []), ...(b.trust ?? [])])], filter: a.filter ?? b.filter ?? null };
  if (!a.open) return containmentOf(b);
  if (!b.open) return containmentOf(a);
  const vars = a.vars === null || b.vars === null ? null : [...a.vars, ...b.vars.filter((binder) => !a.vars.includes(binder))];
  return { open: true, vars, via: a.via ?? b.via, trust: [], filter: null };
}
const partialPath = (base, v, containment) => ({ ...base, v: normalizeRel(v), partial: true, sep: false, ...containmentOf(containment) });
const unfollowedPath = (value, member) => value.unfollowed ? value : { ...partialPath(value, value.v, UNBOUNDED), unfollowed: member };
/**
 * A partial path under the literal directories of unknown text: `lit/${x}`
 * joined to `base` is under `base/lit`. `outer` keeps `base`, the prefix
 * such a path was keyed with before its literal directories were read: where
 * nothing bounds the variable part neither directory is proven, so where
 * such a path is not refused (the recorded key of a variable `import()`) both
 * are keyed rather than a narrower guess, and related selection reaches both.
 */
function underLiteral(base, baseDir, piece, containment = piece) {
  const dir = piece.lit.slice(0, piece.lit.lastIndexOf('/') + 1);
  const under = partialPath(base, posix.join(baseDir, dir), containment);
  return dir === '' ? under : { ...under, outer: normalizeRel(baseDir) };
}

/**
 * Text that starts with the literal `lit` and continues with something the
 * source does not spell out: `\`../fixtures/${name}\``, `name + '.json'`. `post`
 * is the literal text written after the last unknown piece. Containment as
 * for a partial path, read for the unknown pieces only.
 */
const tailValue = (lit, containment = UNBOUNDED, post = '') => ({ k: 'tail', lit, post, ...containmentOf(containment) });
/**
 * Text that cannot climb out of a directory: an unchanged entry name from a
 * directory listing (never empty, `.` or `..`, and with no `..` segment even
 * from a recursive listing) or a generated id (`randomUUID()`). Joined under
 * a directory it stays inside it, and so does any run of such names.
 */
const isMigrationFile = (name) => /^\d+-.*\.js$/.test(name) && !name.endsWith('.test.js');
const isDbMigrationFile = (name) => /\.(sql|js)$/.test(name) && !name.endsWith('.test.js') && !name.startsWith('_');
const LISTED_NAME = Object.freeze(tailValue('', { open: false, trust: ['fs'] }));
const MIGRATION_LISTED_NAME = Object.freeze(tailValue('', { open: false, trust: ['fs'], filter: isMigrationFile }));
const DB_MIGRATION_LISTED_NAME = Object.freeze(tailValue('', { open: false, trust: ['fs'], filter: isDbMigrationFile }));
const GENERATED_NAME = Object.freeze(tailValue('', { open: false, trust: ['crypto'] }));
/** Literal text that can climb out of a directory when it follows a variable part: a `..` segment, under either separator. */
const CLIMBS = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
/** A parameter or loop variable the source never spells out (`identifierValue`): unknown, with the containment a path built from it gets. */
const variableValue = (containment) => ({ k: 'unknown', ...containmentOf(containment) });
/** A value that is not a literal, as unknown text: `ext`, `home` and a plain `unknown` bound nothing. */
const asTail = (value) => (value.k === 'tail' ? value : tailValue('', value.k === 'unknown' && value.open ? value : UNBOUNDED));
/** Unknown text or a variable: the kinds a later operator turns into something else. */
const isVariableText = (value) => value.k === 'tail' || (value.k === 'unknown' && value.open === true);

/** `tail` followed by literal text or by another unknown piece. */
function extendTail(tail, next) {
  if (next.k === 'str') {
    const post = tail.post + next.v;
    // Text after a listed name keeps it inside unless it climbs: `name + '/../../x'`.
    return tailValue(tail.lit, !tail.open && CLIMBS.test(post) ? UNBOUNDED : tail, post);
  }
  const piece = asTail(next);
  const head = piece.lit === '' ? tail : extendTail(tail, str(piece.lit));
  return tailValue(head.lit, bothContainments(head, piece), piece.post);
}

/**
 * One more segment on a path that already has a variable part, or text
 * `glued` onto its last segment. `post` is the literal text since the last
 * variable piece, judged as it accumulates: `'/.' + './x'` climbs though
 * neither piece does.
 */
function joinPartial(base, segment, glued = false) {
  const before = `${base.post ?? ''}${glued ? '' : '/'}`;
  if (glued && base.maybeSelf && !base.open && (base.post ?? '') === '') return partialPath(base, base.v, UNBOUNDED);
  if (segment.k === 'str') {
    const post = before + segment.v;
    // A resolvable path is evaluated again in full, so only a contained one can be lost here.
    const climbs = !base.open && (CLIMBS.test(post) || (!glued && segment.v.startsWith('/')));
    return { ...partialPath(base, base.v, climbs ? UNBOUNDED : base), post };
  }
  // `resolve(partial, ROOT)` restarts at ROOT; an external or home segment is unknown text.
  const piece = segment.k === 'path' ? tailValue('') : asTail(segment);
  const climbs = CLIMBS.test(before + piece.lit) || (!glued && piece.lit.startsWith('/'));
  return { ...partialPath(base, base.v, bothContainments(base, climbs && !piece.open ? UNBOUNDED : piece)), post: piece.post };
}

function joinPath(base, segment) {
  if (base.unfollowed || segment.unfollowed) return base.unfollowed ? base : segment;
  if (base.partial) return joinPartial(base, segment);
  if (segment.k === 'str') {
    if (segment.v.startsWith('/')) return EXTERNAL;
    const leaf = posix.basename(segment.v);
    const isDir = segment.v.endsWith('/') || leaf === '..' || leaf === '.' || (base.isDir && !/\.[A-Za-z0-9]+$/.test(leaf));
    return pathValue(posix.join(base.v, segment.v), { isDir });
  }
  if (segment.k === 'path') return segment;
  if (segment.k === 'ext') return EXTERNAL;
  const piece = asTail(segment);
  // A leading slash restarts `resolve()` at the filesystem root and is a plain segment to `join()`;
  // a Windows separator in the literal part can spell a climb this reading does not see.
  if (piece.lit.startsWith('/') || (!piece.open && piece.lit.includes('\\'))) return partialPath(base, base.v, UNBOUNDED);
  return { ...underLiteral(base, base.v, piece), post: piece.post };
}

/**
 * Text appended to a path, as string concatenation has it. `${dir}/x` and
 * `dir + '/x'` join (the separator belongs to the join, not to an absolute
 * path), and so does text after a path that ends in a separator. Anything
 * else continues the last segment: `${file}.bak`, `${dir}/${stem}.json`.
 */
function appendPath(base, text) {
  if (text === '') return base;
  let appended;
  if (base.partial) appended = joinPartial(base, str(text.replace(/^\/+/, '')), !(text.startsWith('/') || base.sep));
  else if (text.startsWith('/') || base.sep) appended = joinPath(base, str(text.replace(/^\/+/, '')));
  // Glued onto the repository root's own name, the text names a sibling of the repository.
  else if (base.v === '') return EXTERNAL;
  else {
    const glued = base.v + text;
    appended = pathValue(glued, { isDir: text.endsWith('/') || (base.isDir && !/\.[A-Za-z0-9]+$/.test(posix.basename(glued))) });
  }
  // `${dir}/` ends in a separator, so what follows is a new segment.
  return text.endsWith('/') && appended.k === 'path' ? { ...appended, sep: true } : appended;
}

function concatValue(left, right) {
  if (left.k === 'search') {
    if (right.k === 'delimiter') return searchPath([...left.entries, left.tail]);
    if (right.k === 'search') {
      const [head, ...rest] = right.entries;
      return searchPath([...left.entries, concatValue(left.tail, head), ...rest], right.tail);
    }
    return searchPath(left.entries, concatValue(left.tail, right));
  }
  if (right.k === 'delimiter') return left.k === 'path' ? searchPath([left]) : UNKNOWN;
  if (left.unfollowed || right.unfollowed) return left.unfollowed ? left : right;
  if (left.k === 'str' && right.k === 'str') return str(left.v + right.v);
  if (left.k === 'str' && left.v === '') return right;
  if (left.k === 'path') {
    if (right.k === 'str') return appendPath(left, right.v);
    // `${DIR}/${name}` is a join. `${DIR}${name}` glues unknown text onto the last segment and may name a
    // sibling of DIR. (An external segment keeps its older reading, in `joinPath`: outside the repository.)
    if (left.partial) return joinPartial(left, right, !left.sep);
    return left.sep || right.k === 'ext' ? joinPath(left, right) : partialPath(left, left.v, UNBOUNDED);
  }
  if (left.k === 'ext' || left.k === 'home') return left;
  if (right.k === 'path') return UNKNOWN;
  if (left.k === 'str') return extendTail(tailValue(left.v, CONTAINED), right);
  if (isVariableText(left)) return extendTail(asTail(left), right);
  return UNKNOWN;
}

/**
 * The path `new URL(spec, <a file under baseDir>)` names, by the URL parser's
 * own rules: `%20` is a space, `?raw` and `#x` are not part of the path, `\`
 * is a separator. A URL that names a directory serializes with a trailing
 * separator (`sep`).
 */
function fileUrlPath(baseDir, spec) {
  const ROOT = '/-repository-root-/';
  let url;
  try { url = new URL(spec, `file://${ROOT}${baseDir === '' ? '' : `${baseDir.split('/').map(encodeURIComponent).join('/')}/`}`); } catch { return UNKNOWN; }
  if (url.protocol !== 'file:' || url.host !== '') return EXTERNAL;
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { return UNKNOWN; }
  // Above the stand-in root is above the repository: outside it, as a `../` join is.
  const rel = path.startsWith(ROOT) ? path.slice(ROOT.length) : `../${path.replace(/^\/+/, '')}`;
  return pathValue(rel, { isDir: spec.endsWith('/'), sep: path.endsWith('/') });
}

function urlValue(args) {
  const unfollowed = args.find((arg) => arg.unfollowed);
  if (unfollowed) return unfollowed;
  if (args.length === 0) return UNKNOWN;
  if (args.length === 1) {
    const only = args[0];
    if (only.k !== 'path') return only.k === 'str' && /^[a-z]+:/i.test(only.v) ? EXTERNAL : only.k === 'ext' ? EXTERNAL : UNKNOWN;
    if (only.partial) return only.open ? only : partialPath(only, only.v, UNBOUNDED);
    // `new URL(href + '/' + name)` parses `?raw` and `%20` out of the text, `new URL(pathToFileURL(file))`
    // keeps a `#` that is part of the name: which one this is, the path does not say.
    return /[?#%\\\s]/.test(only.v) ? partialPath(dirValue(posix.dirname(only.v)), posix.dirname(only.v), UNBOUNDED) : only;
  }
  const [spec, base] = args;
  if (base.k === 'ext' || base.k === 'home') return base;
  if (base.k !== 'path') return UNKNOWN;
  const elsewhere = (text) => /^[a-z]+:/i.test(text) || text.startsWith('/');
  if (spec.k === 'str' && elsewhere(spec.v)) return EXTERNAL;
  if (spec.k === 'path') return spec;
  // A URL decodes `%2e%2e` and reads `\` as a separator, so not even a listed name is provably inside.
  const piece = spec.k === 'str' ? null : asTail(spec);
  const unlisted = piece === null || piece.open ? piece : UNBOUNDED;
  if (base.partial) {
    // A resolvable base is evaluated again in full. A contained one is not contained any more: the spec
    // resolves beside its last segment, and the parser has its own ways to spell a climb.
    if (!base.open) return partialPath(base, base.v, UNBOUNDED);
    return partialPath(base, base.v, bothContainments(base, spec.k === 'str' ? CONTAINED : unlisted));
  }
  // Against a base that ends in a separator a spec resolves inside it, against any other beside it.
  const baseDir = base.sep ? base.v : posix.dirname(base.v);
  if (spec.k === 'str') return fileUrlPath(baseDir, spec.v);
  if (elsewhere(piece.lit)) return EXTERNAL;
  // The literal directories of the spec are kept: `new URL(\`../fixtures/${name}\`, here)` is under ../fixtures.
  return underLiteral(dirValue(baseDir), baseDir, piece, unlisted);
}

function dirnameValue(value) {
  if (value.k !== 'path') return value.k === 'ext' ? EXTERNAL : UNKNOWN;
  // The parent of a contained path may be the prefix's own parent (`dirname` twice, or once on a guard
  // that returned its directory). A resolvable one is evaluated again in full.
  if (value.partial) return value.open ? value : partialPath(value, value.v, UNBOUNDED);
  return dirValue(posix.dirname(value.v));
}

const isProvenAbsolute = (arg) => (arg.k === 'path' && !arg.unfollowed) || (arg.k === 'str' && arg.v.startsWith('/'));

/** `join(...args)`, or `resolve(...args)` when `joins` is false: only `join` keeps a trailing separator. */
function foldJoin(args, joins = true) {
  // `join()` reads a leading separator as a plain segment; `resolve()` restarts at the rightmost proven absolute anchor.
  let segments = args;
  if (joins) {
    segments = args.map((arg, i) => (i > 0 && arg.k === 'str' ? str(arg.v.replace(/^\/+/, '')) : arg));
  } else {
    const anchor = args.findLastIndex(isProvenAbsolute);
    if (anchor > 0) segments = args.slice(anchor);
  }
  const folded = foldSegments(segments);
  if (folded.k !== 'path' || folded.partial) return folded;
  const last = args.at(-1);
  const sep = joins && (args.length === 1 ? folded.sep === true : last.k === 'str' && last.v.endsWith('/'));
  return { ...folded, sep };
}

function foldSegments(args) {
  if (args.length === 0) return UNKNOWN;
  const unfollowed = args.find((arg) => arg.unfollowed);
  if (unfollowed) return unfollowed;
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

/**
 * The repository modules whose `pathWithin(dir, ...segments)` joins like
 * `path.join()` and throws when the result is outside `dir`: the shared
 * implementation and the `scripts/` re-export of it.
 */
const PATH_WITHIN_MODULES = new Set(['lib/pathWithin.js', 'scripts/lib/pathWithin.js']);

/** True when the file imports `name`, under that name, from a module `accepts(specifier)` vouches for. */
function importsNamed(tokens, match, name, accepts) {
  return tokens.some((token, i) => {
    if (!isWord(token, 'import') || !isPunct(tokens[i + 1], '{') || match[i + 1] === undefined) return false;
    const close = match[i + 1];
    if (!isWord(tokens[close + 1], 'from') || tokens[close + 2]?.t !== 's' || !accepts(tokens[close + 2].v)) return false;
    return tokens.slice(i + 2, close).some((imported, at, names) => isWord(imported, name) && !isWord(names[at - 1], 'as') && !isWord(names[at + 1], 'as'));
  });
}

/**
 * `import { A, B as C } from './x.js'`: local name -> `{ spec, name }` for
 * every named import from a relative specifier (a repository module), whose
 * exported literal the analyzer may read (`importedConstant`).
 */
function namedImports(tokens, match) {
  const imports = new Map();
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isWord(tokens[i], 'import') || !isPunct(tokens[i + 1], '{') || match[i + 1] === undefined) continue;
    const close = match[i + 1];
    if (!isWord(tokens[close + 1], 'from') || tokens[close + 2]?.t !== 's' || !tokens[close + 2].v.startsWith('.')) continue;
    for (const [from, to] of listRanges(tokens, match, i + 1)) {
      const aliased = to === from + 3 && isWord(tokens[from + 1], 'as');
      if (tokens[from]?.t !== 'id' || !(to === from + 1 || aliased) || tokens[aliased ? from + 2 : from]?.t !== 'id') continue;
      imports.set(tokens[aliased ? from + 2 : from].v, { spec: tokens[close + 2].v, name: tokens[from].v });
    }
  }
  return imports;
}

/**
 * What a module exports as a literal the analyzer can name a file with:
 * `export const NAME = '<literal>'` (a string) and
 * `export const NAME = Object.freeze([<literals>])` (an array). Only the frozen
 * form of an array: an exported array that is not frozen can gain an element
 * from any module that imports it. Anything else (a computed value, a
 * re-export, an object) is not read. Pure.
 *
 * @returns {Map<string, { k: 'str', v: string } | { k: 'array', values: string[] }>}
 */
export function literalExports(src, fileRel) {
  const exported = new Map();
  let tokens;
  try { tokens = tokenize(src, new Set(), { jsx: !/\.[cm]?ts$/.test(fileRel) }); } catch { return exported; }
  const match = matchBrackets(tokens);
  let scopes;
  const literal = (token) => (token?.t === 's' ? token.v : token?.t === 'tpl' && token.exprs.length === 0 ? token.quasis[0] : null);
  // The initializer is the literal alone: `'a'.repeat(2)` and `'a' + b` are not it.
  const endsStatement = (token) => token === undefined || isPunct(token, ';') || (token.t === 'id' && !['in', 'instanceof', 'as'].includes(token.v));
  for (let i = 0; i + 4 < tokens.length; i += 1) {
    if (!isWord(tokens[i], 'export') || !isWord(tokens[i + 1], 'const') || tokens[i + 2]?.t !== 'id' || !isPunct(tokens[i + 3], '=')) continue;
    const at = i + 4;
    const text = literal(tokens[at]);
    if (text !== null) {
      if (endsStatement(tokens[at + 1])) exported.set(tokens[i + 2].v, { k: 'str', v: text });
      continue;
    }
    const open = at + 3;
    if (!(isWord(tokens[at], 'Object') && isPunct(tokens[at + 1], '.') && isWord(tokens[at + 2], 'freeze') && isPunct(tokens[open], '(') && isPunct(tokens[open + 1], '['))) continue;
    if (match[open] === undefined || match[open + 1] === undefined || match[open] !== match[open + 1] + 1 || !endsStatement(tokens[match[open] + 1])) continue;
    scopes ??= createScopes({ fileRel, src, tokens, match, bindings: collectBindings(tokens, match), replaced: {} });
    if (scopes.shadowed('Object') || scopes.writtenIn('Object', () => true) || scopes.hiddenWrite('Object')) continue;
    // A hole (`[a, , b]`) is an empty range: no literal, so the array is not read.
    const values = listRanges(tokens, match, open + 1).map(([from, to]) => (to === from + 1 ? literal(tokens[from]) : null));
    if (!values.includes(null)) exported.set(tokens[i + 2].v, { k: 'array', values });
  }
  return exported;
}

/**
 * The literal an imported name stands for (`literalExports` of the module it
 * is imported from), or null: no resolver (`extractFileFacts` run alone), not
 * a named import of a repository module, or a name the file binds again. The
 * exporting module is an import edge, so its bytes are already in the key;
 * the module is logged (`trustLog`) so a member that mocks it voids a read
 * named through it (`gather`).
 */
function importedConstant(name, ctx, shadowed) {
  const imported = ctx.imports.get(name);
  if (imported === undefined || ctx.exportedConstant === null || shadowed(name)) return null;
  const value = ctx.exportedConstant(imported.spec, imported.name);
  if (value !== null) ctx.shared.trustLog.push(imported.spec);
  return value;
}

/**
 * True when the file replaces a module `accepts(specifier)` names (`vi.mock`,
 * `vi.doMock`) or names one of `members` as a string (`vi.spyOn(fs,
 * 'readdirSync')`). What such a module then returns is the test's to decide,
 * so nothing is inferred from a call to it.
 */
function mocksModule(tokens, match, accepts, members) {
  // A string, a template without holes, or either inside `import('…')`.
  const texts = (token) => (token.t === 's' ? [token.v] : token.t === 'tpl' ? [token.quasis.join('')] : []);
  return tokens.some((token, i) => {
    if (texts(token).some((text) => members.includes(text))) return true;
    if (!isWord(token, 'mock', 'doMock') || !isPunct(tokens[i - 1], '.') || !isPunct(tokens[i + 1], '(') || match[i + 1] === undefined) return false;
    const [first] = listRanges(tokens, match, i + 1);
    return first !== undefined && tokens.slice(first[0], first[1]).flatMap(texts).some(accepts);
  });
}

/** True when `tokens[at]` is a plain name in an `import { … }` or `export { … }` list (not renamed with `as`). */
function namedInImportList(tokens, match, at) {
  if (isWord(tokens[at + 1], 'as') || isWord(tokens[at - 1], 'as')) return false;
  const open = enclosingOpen(tokens, match, at);
  return open !== null && isPunct(tokens[open], '{') && isWord(tokens[open - 1], 'import', 'export');
}

/**
 * Which of the three trusted sources a file replaces: node's `fs` (a
 * directory listing), `crypto` (`randomUUID`) and the `pathWithin` guard.
 * Pure; `createTestMemoAnalyzer` asks it of the workspace setup files too,
 * whose mocks apply to every test.
 */
export function replacedSources(src, fileRel) {
  let tokens;
  try { tokens = tokenize(src, new Set(), { jsx: !/\.[cm]?ts$/.test(fileRel) }); } catch { return { fs: true, crypto: true, guard: true }; }
  const match = matchBrackets(tokens);
  return {
    fs: mocksModule(tokens, match, (spec) => FS_MODULES.has(spec), [...READDIR_CALLEES]),
    crypto: mocksModule(tokens, match, isCryptoModule, ['randomUUID']),
    guard: mocksModule(tokens, match, (spec) => isGuardModule(fileRel, spec), ['pathWithin']),
  };
}
const isCryptoModule = (spec) => spec === 'crypto' || spec === 'node:crypto';
/** `spec`, written in `fileRel`, names the guard module, with or without its extension. */
const isGuardModule = (fileRel, spec) => spec.startsWith('.') && PATH_WITHIN_MODULES.has(
  normalizeRel(posix.join(posix.dirname(fileRel), spec.endsWith('.js') ? spec : spec + '.js'))
);

/**
 * `pathWithin(dir, ...segments)`: the call throws unless the joined path is
 * inside `dir`, so a run that passed read nothing outside it, whatever the
 * segments were. Literal segments still resolve exactly.
 */
function guardedJoin(args) {
  const [dir, ...segments] = args;
  if (dir?.k !== 'path') return UNKNOWN;
  if (dir.partial) return dir; // inside the real directory, which is wherever the partial path says it is
  // `maybeSelf`: with an empty segment the result is the directory itself, so text glued onto it names a sibling.
  // A segment with an unfollowed transform (such as slash normalization) is re-bounded to `dir` here.
  if (!segments.every((segment) => segment.k === 'str')) return { ...partialPath({ ...dir, isDir: true }, dir.v, { open: false, trust: ['guard'] }), maybeSelf: true };
  // `join()` semantics: a leading separator is a plain segment.
  return segments.reduce((path, segment) => joinPath(path, str(segment.v.replace(/^\/+/, ''))), dir);
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
  // `name && other`, `name ? a : b`, `name[0]`, `name.replace(…)`: what follows decides the value, so a
  // literal, a listed name or a variable with known values is no longer what it was. (A path keeps the
  // older reading: an input either way.)
  const next = tokens[end];
  const continues = next !== undefined && (next.t === 'p' ? ![',', ';', ')', ']', '}'].includes(next.v) : next.t === 'id' && (next.v === 'in' || next.v === 'instanceof'));
  return { value: continues && (isVariableText(value) || value.k === 'str') ? UNKNOWN : value, end };
}

const closeOf = (match, open) => (match[open] ?? open) + 1;
/**
 * The value of a parenthesized expression or a template hole that was
 * evaluated up to `end`. `(name, other)` is `other`, so a literal, a listed
 * name or a resolvable variable that is not the whole of it is none of them.
 */
const wholeValue = ({ value, end }, close) => (end !== close && (isVariableText(value) || value.k === 'str') ? UNKNOWN : value);

/** The repository's normalization spellings preserve canonical paths. */
function pathMemberIdentity(value, tokens, match, name, open, call) {
  if (!call) return name === 'href' || name === 'pathname';
  const close = match[open];
  if (name === 'toString') return close === open + 1;
  if (name === 'normalize') return close === open + 1 && (value.partial || value.v.normalize() === value.v);
  // A literal backslash can spell a separator on Windows or be part of a filename on POSIX.
  // A partial path can also carry an unproven backslash in its dynamic segment; only a path
  // whose variable parts still expand to concrete literals (`vars !== null`) can be checked again.
  if (value.v.includes('\\')) return false;
  if (value.partial && !(value.open && value.vars !== null)) return false;
  const first = tokens[open + 1];
  const second = tokens[open + 3];
  if (close !== open + 4 || tokens[open + 2].v !== ',' || second.t !== 's' || second.v !== '/') return false;
  return (name === 'replaceAll' && first.t === 's' && first.v === '\\')
    || (name === 'replace' && first.t === 're' && first.v === '/\\\\/g');
}

function evaluatePostfix(tokens, match, start, ctx, depth) {
  let { value, end } = evaluatePrimary(tokens, match, start, ctx, depth);
  for (;;) {
    const token = tokens[end];
    const memberOpen = isPunct(token, '?.') ? end + 1 : end;
    if (value.k === 'path' && isPunct(tokens[memberOpen], '[')) {
      value = unfollowedPath(value, '[]');
      end = closeOf(match, memberOpen);
      continue;
    }
    if (!isPunct(token, '.', '?.') || tokens[end + 1]?.t !== 'id') break;
    const name = tokens[end + 1].v;
    const open = end + 2;
    const call = tokens[open]?.t === 'p' && tokens[open].v === '(';
    if (value.k === 'path') {
      if (!pathMemberIdentity(value, tokens, match, name, open, call)) value = unfollowedPath(value, `.${name}${call ? '()' : ''}`);
      end = call ? closeOf(match, open) : open;
      continue;
    }
    if (name === 'href' || name === 'pathname') { end += 2; continue; }
    if (name === 'toString' && call) { end = closeOf(match, open); continue; }
    if (call && value.k === 'unknown' && (PATH_JOIN.has(name) || PATH_DIRNAME.has(name) || PATH_IDENTITY.has(name))) {
      // `path.join(...)`, `posix.resolve(...)`, `url.fileURLToPath(...)`: a module namespace receiver.
      const args = evaluateArgs(tokens, match, open, ctx, depth) ?? [];
      value = PATH_JOIN.has(name) ? foldJoin(args, name === 'join') : PATH_DIRNAME.has(name) ? dirnameValue(args[0] ?? UNKNOWN) : (args[0] ?? UNKNOWN);
      end = closeOf(match, open);
      continue;
    }
    if (call && value.k === 'unknown' && (name === 'tmpdir' || name === 'homedir')) { value = name === 'homedir' ? HOME : EXTERNAL; end = closeOf(match, open); continue; }
    return { value, end };
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
      const hole = evaluate(inner, matchBrackets(inner), 0, ctx, depth + 1);
      acc = concatValue(acc, wholeValue(hole, inner.length));
      acc = concatValue(acc, str(token.quasis[i + 1]));
    }
    return { value: acc, end: start + 1 };
  }
  if (token.t === 'p' && token.v === '(') {
    const inner = evaluate(tokens, match, start + 1, ctx, depth + 1);
    return { value: wholeValue(inner, match[start]), end: closeOf(match, start) };
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
  if (token.v === 'PATHS' && dot(start + 1) && id(start + 2, 'slashdo')) {
    ctx.shared.scopes ??= createScopes(ctx.shared.root);
    const imported = ctx.imports.get('PATHS');
    if (imported !== undefined && imported.name === 'PATHS' && /(?:^|\/)(?:fileUtils|paths)\.js$/.test(imported.spec)
      && !ctx.shared.scopes.shadowed('PATHS') && !ctx.mocksSpecifier?.(imported.spec)) {
      ctx.shared.trustLog.push(imported.spec);
      return { value: dirValue('lib/slashdo'), end: start + 3 };
    }
  }
  if (token.v === 'process' && dot(start + 1)) {
    if (id(start + 2, 'cwd') && tokens[start + 3]?.v === '(') return { value: dirValue(ctx.cwdRel), end: closeOf(match, start + 3) };
    if (id(start + 2, 'execPath')) return { value: NODE, end: start + 3 };
    if (id(start + 2, 'env')) {
      let end = start + 3;
      const name = dot(end) && tokens[end + 1]?.t === 'id' ? tokens[end + 1].v : null;
      if (name !== null) end += 2;
      return { value: name === 'HOME' || name === 'USERPROFILE' ? HOME : variableValue(UNBOUNDED), end };
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
    if (PATH_JOIN.has(token.v)) return { value: foldJoin(args, token.v === 'join'), end };
    if (PATH_DIRNAME.has(token.v)) return { value: dirnameValue(args[0] ?? UNKNOWN), end };
    if (PATH_IDENTITY.has(token.v)) return { value: args[0] ?? UNKNOWN, end };
    if (token.v === 'URL') return { value: urlValue(args), end };
    // Both are trusted as the imported binding only: a parameter or a local of that name is anything.
    if ((token.v === 'pathWithin' && ctx.guarded) || (token.v === 'randomUUID' && ctx.uuid && args.length === 0)) {
      ctx.shared.scopes ??= createScopes(ctx.shared.root);
      // Shadowed or mocked, the guard guards nothing: its directory is only where the path starts.
      if (ctx.shared.scopes.shadowed(token.v) || (token.v === 'pathWithin' && ctx.replaced.guard)) {
        return { value: token.v === 'pathWithin' && args[0]?.k === 'path' ? partialPath(args[0], args[0].v, UNBOUNDED) : UNKNOWN, end };
      }
      // A guard call is a path this file has the guard's word for, literal segments included: a
      // replaced guard returns what it likes. A UUID counts only where a read is contained by it
      // (`trusts`): a lock file named with one is no read.
      if (token.v === 'pathWithin') ctx.shared.trusted.guard = true;
      // A UUID is 36 characters of hex and dashes: a name, wherever it is joined.
      return { value: token.v === 'pathWithin' ? guardedJoin(args) : GENERATED_NAME, end };
    }
    return { value: UNKNOWN, end };
  }
  return { value: identifierValue(token, ctx, depth), end: start + 1 };
}

// ---------------------------------------------------------------------------
// Parameters and loop variables: where a variable path segment comes from.
// ---------------------------------------------------------------------------

/** Array methods that call their first argument with each element. */
const ELEMENT_CALLBACKS = new Set(['map', 'forEach', 'filter', 'flatMap', 'some', 'every', 'find', 'findLast', 'findIndex', 'findLastIndex']);
/** Array methods whose result holds only elements of the receiver. */
const ELEMENT_PRESERVING = new Set(['filter', 'sort', 'slice', 'reverse', 'toSorted', 'toReversed']);
/** Array methods that hand their callback the array itself, as the argument after the index. */
const ARRAY_ITERATORS = new Set([...ELEMENT_CALLBACKS, 'reduce', 'reduceRight']);
/**
 * What may be done to a `const` array whose elements are taken as known:
 * these neither add an element nor return the array itself, which
 * `names.sort().push(x)` would then write through.
 */
const ARRAY_READS = new Set([...ARRAY_ITERATORS, 'length', 'includes', 'indexOf', 'lastIndexOf', 'join', 'slice', 'at', 'concat',
  'entries', 'keys', 'values', 'toString', 'flat', 'toSorted', 'toReversed', 'toSpliced', 'with']);
/** Matchers that compare against an array handed to them. */
const ARRAY_MATCHERS = new Set(['toEqual', 'toStrictEqual', 'toContain', 'arrayContaining']);
/** Matchers that only compare what `expect()` was handed: `toSatisfy(cb)` and a custom matcher are handed the array itself. */
const COMPARING_MATCHERS = new Set(['toEqual', 'toStrictEqual', 'toContain', 'toContainEqual', 'toHaveLength', 'toBe', 'toMatchObject', 'toBeDefined', 'toBeInstanceOf', 'toMatchSnapshot', 'toMatchInlineSnapshot']);
const READDIR_CALLEES = new Set(['readdirSync', 'readdir']);
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
const BLOCK_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'with']);
/** Keywords an operand follows, so the token after one continues the expression. */
const OPERAND_KEYWORDS = new Set(['await', 'typeof', 'new', 'yield', 'void', 'delete', 'async', 'return', 'throw', 'case', 'else', 'do', 'in', 'of', 'instanceof', 'function', 'class', 'extends']);
/** Keywords a parenthesized operand follows: `delete (x[0])`. After any other name, `(` opens a call, a head or a parameter list. */
const BEFORE_GROUPING = new Set(['await', 'typeof', 'yield', 'void', 'delete', 'return', 'throw', 'case', 'else', 'do', 'in', 'of', 'instanceof']);
/** True when the `(` at `open` only groups an expression. */
const groupsAt = (tokens, open) => {
  const before = tokens[open - 1];
  return isPunct(tokens[open], '(') && !isPunct(before, ')', ']') && before?.t !== 'tpl' && (before?.t !== 'id' || BEFORE_GROUPING.has(before.v));
};
/** Keywords after which `function` starts an expression, or an exported declaration other modules can call. */
const BEFORE_FUNCTION_EXPRESSION = new Set([...OPERAND_KEYWORDS, 'export', 'default']);
/** The elements of an array are directory-entry names (`LISTED_NAME`); a finite set is a `string[]`. */
const LISTED = Object.freeze({ listed: true });
const MIGRATION_LISTED = Object.freeze({ listed: true, filter: isMigrationFile });
const DB_MIGRATION_LISTED = Object.freeze({ listed: true, filter: isDbMigrationFile });
const isListedDomain = (domain) => domain === LISTED || domain === MIGRATION_LISTED || domain === DB_MIGRATION_LISTED;
/** How many combinations of variable values one path expression is evaluated for before it counts as unbounded. */
const VARIABLE_VALUES_LIMIT = 64;
/** One `binder -> text` map per combination of the variables' values, or null when there is no finite set or too many. */
function variableCombinations(vars) {
  if (vars === null || vars.reduce((count, binder) => count * binder.domain.length, 1) > VARIABLE_VALUES_LIMIT) return null;
  return vars.reduce((all, binder) => all.flatMap((chosen) => binder.domain.map((text) => new Map([...chosen, [binder, text]]))), [new Map()]);
}

const isPunct = (token, ...values) => token?.t === 'p' && values.includes(token.v);
const isWord = (token, ...values) => token?.t === 'id' && values.includes(token.v);
/**
 * True when the tokens from `index` assign: `=`, or a compound operator and
 * `=` (`+=`, `||=`). `==` does not; `<=` is read as one, which only costs a
 * resolution.
 */
function assignsAt(tokens, index) {
  let at = index;
  while (at < index + 3 && isPunct(tokens[at], '+', '-', '*', '/', '%', '|', '&', '?', '^', '<', '>')) at += 1;
  return isPunct(tokens[at], '=') && !isPunct(tokens[at + 1], '=');
}

/** Every token array of a file with its bracket matches: the top level and each template hole, recursively. */
function tokenArrays(tokens, match, out = []) {
  out.push({ arr: tokens, m: match });
  for (const token of tokens) if (token.t === 'tpl') for (const inner of token.exprs) tokenArrays(inner, matchBrackets(inner), out);
  return out;
}

/**
 * Index of the token that ends the expression starting at `start`: a
 * top-level `,` `;` or closer, or the first token of the next statement where
 * the semicolon was left out (an operand directly after a complete operand).
 */
function expressionEnd(tokens, match, start) {
  let bodies = 0; // `function` and `class` expressions whose `{…}` body is still to come
  for (let i = start; i < tokens.length; i += 1) {
    const token = tokens[i];
    const prev = tokens[i - 1];
    const complete = i > start && (prev.t === 'p' ? [')', ']', '}'].includes(prev.v) : !(prev.t === 'id' && OPERAND_KEYWORDS.has(prev.v)));
    if (token.t === 'p') {
      if (OPENERS[token.v]) {
        // `a {` is no expression: a block after a complete operand starts the next statement, unless
        // it is the body of a function or class expression. `a (` and `a [` continue, as they do in JavaScript.
        if (token.v === '{' && complete) {
          if (bodies === 0) return i;
          bodies -= 1;
        }
        if (match[i] === undefined) return tokens.length;
        i = match[i];
      } else if ([',', ';', ')', ']', '}'].includes(token.v)) return i;
      continue;
    }
    if (isWord(token, 'function', 'class')) bodies += 1;
    // A template after an operand is a tagged template, not a new statement.
    if (i === start || token.t === 'tpl' || isWord(token, 'in', 'of', 'instanceof', 'as', 'extends')) continue;
    if (complete) return i;
  }
  return tokens.length;
}

/** Top-level comma-separated `[from, to)` ranges between an opener and its closer; a trailing comma adds none. */
function listRanges(tokens, match, open) {
  const close = match[open];
  const ranges = [];
  let from = open + 1;
  for (let i = open + 1; i <= close; i += 1) {
    const token = tokens[i];
    if (i < close && token.t === 'p' && OPENERS[token.v] && match[i] !== undefined) { i = match[i]; continue; }
    if (i === close || isPunct(token, ',')) {
      if (from < i || i < close) ranges.push([from, i]);
      from = i + 1;
    }
  }
  return ranges;
}

/**
 * The identifier tokens a parameter list or destructuring pattern binds.
 * Property keys and default values are not bindings: counting one would hide
 * a module-level path constant of that name inside the function.
 */
function boundNames(tokens, match, from, to, out = []) {
  let i = from;
  while (i < to) {
    let at = i;
    let end = at;
    while (end < to && !isPunct(tokens[end], ',')) end = isPunct(tokens[end], '(', '[', '{') && match[end] !== undefined ? match[end] + 1 : end + 1;
    if (isPunct(tokens[at], '...')) at += 1;
    // `key: target`: the target is what is bound.
    if ((tokens[at]?.t === 'id' || tokens[at]?.t === 's') && isPunct(tokens[at + 1], ':')) at += 2;
    else if (isPunct(tokens[at], '[') && match[at] !== undefined && isPunct(tokens[match[at] + 1], ':')) at = match[at] + 2;
    if (isPunct(tokens[at], '{', '[') && match[at] !== undefined && match[at] < end) boundNames(tokens, match, at + 1, match[at], out);
    else if (tokens[at]?.t === 'id' && at < end) out.push(tokens[at]);
    i = end + 1;
  }
  return out;
}

/**
 * The parameters and `for…of` variables of one file, and what each can hold.
 *
 * `binderAt(name, offset)` is the binder a use of `name` at a source offset
 * refers to, or null when it is a module-level name. `domainOf(binder)` is
 * `LISTED` (unchanged entries of a directory listing), a `string[]` (every
 * value the source can pass), or null. A domain is only claimed where the
 * source proves it: a parameter of a function declared once in this file,
 * never exported or handed on, whose every call passes a literal or such a
 * variable; the callback of an array method on a literal or listed array; a
 * `for…of` over one. Anything else is null, and a path built from it has no
 * bound (`UNBOUNDED`).
 */
function createScopes(ctx) {
  const arrays = tokenArrays(ctx.tokens, ctx.match);
  const binders = new Map(); // name -> Binder[]
  const declared = new Map(); // name -> source offsets of const/let/var/function/class declarations
  const ownDeclarations = new Map(); // name -> declarations that introduce the trusted meaning itself (a `const` arrow, a `require` of fs)
  const loopVariables = new Set(); // the tokens a `for…of` head declares: binders, counted as such
  const arrowArity = new Map(); // `const name = (a, b) => …`: name -> parameter count (Infinity with a rest parameter, or declared twice)
  const declare = (token) => { if (!loopVariables.has(token)) declared.set(token.v, [...(declared.get(token.v) ?? []), token.i]); };
  const bind = (token, extent, detail) => binders.set(token.v, [...(binders.get(token.v) ?? []), { name: token.v, token, ...extent, ...detail, domain: undefined }]);

  /** What a function is to the code around it: a name every caller uses, an argument, or neither. */
  const roleOf = (arr, m, head, nameToken = null) => {
    let before = head - 1;
    if (isWord(arr[before], 'async')) before -= 1;
    const prev = arr[before];
    if (nameToken !== null) {
      const expression = prev !== undefined && (prev.t === 'p' ? ![';', '}', '{', ')'].includes(prev.v) : prev.t === 'id' && BEFORE_FUNCTION_EXPRESSION.has(prev.v));
      return expression ? { kind: 'other' } : { kind: 'named', nameToken };
    }
    if (isPunct(prev, '=') && arr[before - 1]?.t === 'id' && isWord(arr[before - 2], 'const', 'let', 'var')) {
      return isWord(arr[before - 3], 'export') ? { kind: 'other' } : { kind: 'named', nameToken: arr[before - 1], constant: isWord(arr[before - 2], 'const') };
    }
    return isPunct(prev, '(', ',') ? { kind: 'callback', arr, m, at: before } : { kind: 'other' };
  };
  const bindParameters = (arr, m, open, extent, role) => {
    listRanges(arr, m, open).forEach(([from, to], index) => {
      // Only a plain positional parameter has a domain; a default initializer or destructured
      // object parameter may still resolve to a complete path (`migrationsDir = DEFAULT_MIGRATIONS_DIR`).
      const plain = to === from + 1 && arr[from].t === 'id';
      if (plain) { bind(arr[from], extent, { kind: 'param', role, index }); return; }
      if (arr[from]?.t === 'id' && isPunct(arr[from + 1], '=') && from + 2 < to) {
        bind(arr[from], extent, { kind: 'opaque', defaultExpr: { arr, m, from: from + 2, to } });
        return;
      }
      if (isPunct(arr[from], '{') && m[from] !== undefined) {
        const handled = new Set();
        for (const [pf, pt] of listRanges(arr, m, from)) {
          if (arr[pf]?.t === 'id' && pf + 1 === pt) {
            handled.add(arr[pf]);
            bind(arr[pf], extent, { kind: 'destructured', role, index, prop: arr[pf].v });
          } else if (arr[pf]?.t === 'id' && isPunct(arr[pf + 1], '=') && pf + 2 < pt) {
            handled.add(arr[pf]);
            bind(arr[pf], extent, { kind: 'destructured', role, index, prop: arr[pf].v, defaultExpr: { arr, m, from: pf + 2, to: pt } });
          } else if (arr[pf]?.t === 'id' && isPunct(arr[pf + 1], ':') && arr[pf + 2]?.t === 'id' && isPunct(arr[pf + 3], '=') && pf + 4 < pt) {
            handled.add(arr[pf + 2]);
            bind(arr[pf + 2], extent, { kind: 'destructured', role, index, prop: arr[pf].v, defaultExpr: { arr, m, from: pf + 4, to: pt } });
          }
        }
        for (const token of boundNames(arr, m, from, to)) if (!handled.has(token)) bind(token, extent, { kind: 'opaque' });
        return;
      }
      for (const token of boundNames(arr, m, from, to)) bind(token, extent, { kind: 'opaque' });
    });
  };
  /** Parameters of an arrow whose list opens at `open` (null: one bare name); a rest parameter can take any number. */
  const parameterCount = (arr, m, open) => {
    if (open === null) return 1;
    const ranges = listRanges(arr, m, open);
    return ranges.some(([from]) => isPunct(arr[from], '...')) ? Infinity : ranges.length;
  };
  const bodyExtent = (arr, m, from, bodyStart) => {
    if (isPunct(arr[bodyStart], '{') && m[bodyStart] !== undefined) return { from, to: arr[m[bodyStart]].i };
    const end = expressionEnd(arr, m, bodyStart);
    return { from, to: end < arr.length ? arr[end].i : Infinity };
  };

  for (const { arr, m } of arrays) {
    const functionParens = new Set();
    for (let i = 0; i < arr.length; i += 1) {
      const token = arr[i];
      if (isWord(token, 'const', 'let', 'var')) {
        // Every declarator: `const a = 1, readdirSync = fake` declares the second name too.
        for (let at = i + 1; ;) {
          if (arr[at]?.t === 'id') declare(arr[at]);
          else if (isPunct(arr[at], '{', '[') && m[at] !== undefined) boundNames(arr, m, at + 1, m[at]).forEach(declare);
          else break;
          const end = expressionEnd(arr, m, at);
          if (!isPunct(arr[end], ',')) break;
          at = end + 1;
        }
      } else if (isWord(token, 'class') && arr[i + 1]?.t === 'id') declare(arr[i + 1]);
      else if (isWord(token, 'function') && !isPunct(arr[i - 1], '.', '?.')) {
        let open = isPunct(arr[i + 1], '*') ? i + 2 : i + 1;
        const nameToken = arr[open]?.t === 'id' ? arr[open] : null;
        if (nameToken !== null) { declare(nameToken); open += 1; }
        if (!isPunct(arr[open], '(') || m[open] === undefined || !isPunct(arr[m[open] + 1], '{')) continue;
        functionParens.add(open);
        bindParameters(arr, m, open, bodyExtent(arr, m, arr[open].i, m[open] + 1), roleOf(arr, m, i, nameToken));
      } else if (isPunct(token, '=>')) {
        const open = isPunct(arr[i - 1], ')') && m[i - 1] !== undefined ? m[i - 1] : null;
        if (open === null && arr[i - 1]?.t !== 'id') continue;
        const head = open ?? i - 1;
        const extent = bodyExtent(arr, m, arr[head].i, i + 1);
        const role = roleOf(arr, m, head);
        // A `let` can be given another function later, so only a `const` arrow has a known parameter list.
        if (role.kind === 'named' && role.constant) arrowArity.set(role.nameToken.v, arrowArity.has(role.nameToken.v) ? Infinity : parameterCount(arr, m, open));
        if (open !== null) bindParameters(arr, m, open, extent, role);
        else bind(arr[head], extent, { kind: 'param', role, index: 0 });
      } else if (isWord(token, 'for') && !isPunct(arr[i - 1], '.', '?.')) {
        const open = isWord(arr[i + 1], 'await') ? i + 2 : i + 1;
        if (!isPunct(arr[open], '(') || m[open] === undefined) continue;
        let of = open + 1;
        while (of < m[open] && !isWord(arr[of], 'of', 'in')) of = OPENERS[arr[of].v] && arr[of].t === 'p' && m[of] !== undefined ? m[of] + 1 : of + 1;
        if (of >= m[open]) continue; // `for (;;)`: its `let i = 0` is an ordinary binding
        const from = isWord(arr[open + 1], 'const', 'let', 'var') ? open + 2 : open + 1;
        // `const` or `let`: one binding per turn. A `var` (or a name declared elsewhere) outlives the loop,
        // and a callback registered in it reads whatever the name is assigned afterwards.
        const plain = of === from + 1 && arr[from].t === 'id' && arr[of].v === 'of' && isWord(arr[open + 1], 'const', 'let');
        const extent = bodyExtent(arr, m, arr[open].i, m[open] + 1);
        for (const name of boundNames(arr, m, from, of)) {
          loopVariables.add(name);
          bind(name, extent, plain ? { kind: 'loop', iter: { arr, m, from: of + 1, to: m[open] } } : { kind: 'opaque' });
        }
      } else if (isPunct(token, ')') && isPunct(arr[i + 1], '{') && m[i] !== undefined && m[i + 1] !== undefined && !functionParens.has(m[i])) {
        // A method (`name(a) {`) or a catch clause: nothing in this file says what it is called with.
        const callee = arr[m[i] - 1];
        if (callee?.t === 'id' && !BLOCK_KEYWORDS.has(callee.v)) {
          for (const name of boundNames(arr, m, m[i] + 1, i)) bind(name, { from: arr[m[i]].i, to: arr[m[i + 1]].i }, { kind: 'opaque' });
        }
      }
    }
  }

  // Local names of node's directory listers. A `readdir` of any other origin (a wrapper, a store
  // method) can return anything, so only an import or require of fs vouches for the name.
  const listers = new Set();
  const scanners = new Map();
  const fsNamespaces = new Set();
  const fromFs = (token) => token?.t === 's' && FS_MODULES.has(token.v);
  const scannerFor = (imported, spec) => {
    if (ctx.mocksSpecifier?.(spec)) return null;
    if (imported === 'scanMigrationFiles' && /(?:^|\/)migration(?:Files|Ledger)\.js$/.test(spec)) return MIGRATION_LISTED;
    if (imported === 'scanDatabaseMigrationFiles' && /(?:^|\/)migrationFiles\.js$/.test(spec)) return DB_MIGRATION_LISTED;
    return null;
  };
  const main = ctx.tokens;
  const addFsNames = (open, alias, own) => {
    for (const [from, to] of listRanges(main, ctx.match, open)) {
      const local = isWord(main[from + 1], alias) || isPunct(main[from + 1], alias) ? main[from + 2] : main[from];
      if (local?.t !== 'id' || main[from].t !== 'id' || to - from > 3) continue;
      if (READDIR_CALLEES.has(main[from].v)) listers.add(local.v);
      else if (main[from].v === 'promises' || main[from].v === 'default') fsNamespaces.add(local.v);
      else continue;
      if (own) ownDeclarations.set(local.v, 1);
    }
  };
  /** An import is a declaration of its local names; the ones this pass trusts are trusted as that import. */
  const TRUSTED_IMPORTS = { path: ['delimiter'], 'node:path': ['delimiter'], vitest: ['it', 'test', 'describe', 'expect'], crypto: ['randomUUID'], 'node:crypto': ['randomUUID'] };
  const importLocal = (token, imported, spec) => {
    declare(token);
    const scanner = scannerFor(imported, spec);
    if (scanner !== null) scanners.set(token.v, scanner);
    const trusted = TRUSTED_IMPORTS[spec] ?? (isGuardModule(ctx.fileRel, spec) ? ['pathWithin'] : []);
    if (ctx.imports?.has(token.v) || (token.v === imported && trusted.includes(imported))) ownDeclarations.set(token.v, 1);
  };
  for (let i = 0; i < main.length; i += 1) {
    if (isWord(main[i], 'import') && !isPunct(main[i + 1], '(', '.')) {
      let from = i + 1;
      while (from < main.length && !isWord(main[from], 'from') && !isPunct(main[from], ';')) from = isPunct(main[from], '{') && ctx.match[from] !== undefined ? ctx.match[from] + 1 : from + 1;
      if (!isWord(main[from], 'from') || main[from + 1]?.t !== 's') continue;
      const spec = main[from + 1].v;
      for (let at = i + 1; at < from; at += 1) {
        if (isPunct(main[at], '{') && ctx.match[at] !== undefined) {
          for (const [a, b] of listRanges(main, ctx.match, at)) if (main[b - 1]?.t === 'id' && main[a]?.t === 'id') importLocal(main[b - 1], main[a].v, spec);
          if (fromFs(main[from + 1])) addFsNames(at, 'as', true);
          at = ctx.match[at];
        } else if (main[at].t === 'id' && main[at].v !== 'as') {
          // A default import, or the name after `* as`.
          importLocal(main[at], 'default', spec);
          if (fromFs(main[from + 1])) { fsNamespaces.add(main[at].v); ownDeclarations.set(main[at].v, 1); }
        }
      }
    } else if (isWord(main[i], 'const', 'let', 'var')) {
      const pattern = isPunct(main[i + 1], '{') && ctx.match[i + 1] !== undefined;
      const eq = pattern ? ctx.match[i + 1] + 1 : i + 2;
      if (!isPunct(main[eq], '=') || !isWord(main[eq + 1], 'require') || !isPunct(main[eq + 2], '(') || !fromFs(main[eq + 3])) continue;
      // The `const` is itself the declaration that gives the name its meaning.
      if (pattern) addFsNames(i + 1, ':', true);
      else if (main[i + 1]?.t === 'id') { fsNamespaces.add(main[i + 1].v); ownDeclarations.set(main[i + 1].v, 1); }
    }
  }
  // A file that mocks fs, or spies on its readdir, decides what a listing returns; so does one that
  // writes to the namespace object or hands it on (`fs.readdirSync = fake`, `Object.assign(fs, …)`).
  if (ctx.replaced.fs) { listers.clear(); fsNamespaces.clear(); }
  // Every use of a namespace is a call through it (`fs.readdirSync(…)`, `fs.promises.readdir(…)`). Anything
  // else can replace a member or alias the object, and the namespaces share their objects, so one
  // such use takes the trust from all of them.
  const calledThrough = (arr, at) => {
    let last = at;
    while (isPunct(arr[last + 1], '.') && arr[last + 2]?.t === 'id') last += 2;
    return last > at && isPunct(arr[last + 1], '(');
  };
  const intact = [...fsNamespaces].every((name) => arrays.every(({ arr }) => arr.every((use, at) => use.t !== 'id' || use.v !== name
    || isPunct(arr[at - 1], '.', '?.') || isWord(arr[at - 1], 'import', 'as', 'const', 'let', 'var') || calledThrough(arr, at))));
  if (!intact) { listers.clear(); fsNamespaces.clear(); }
  /** True when `name` is bound anywhere in the file beyond the declaration its trusted meaning comes from: a use may then mean something else. */
  const shadowed = (name) => binders.has(name) || (declared.get(name) ?? []).length > (ownDeclarations.get(name) ?? 0);
  /** True when the call whose callee ends at `callee` (a dotted path from `head`) is node's readdir. */
  const listsDirectory = (arr, head, callee) => {
    if (shadowed(arr[head].v)) return false;
    if (callee === head) return listers.has(arr[head].v);
    return fsNamespaces.has(arr[head].v) && READDIR_CALLEES.has(arr[callee].v) && (callee === head + 2 || (callee === head + 4 && arr[head + 2].v === 'promises'));
  };

  /** `arr[from..to]` with the grouping parentheses around it: `((p))`. */
  const grouped = (arr, m, from, to) => {
    let [a, b] = [from, to];
    while (m[a - 1] === b + 1 && groupsAt(arr, a - 1)) { a -= 1; b += 1; }
    return [a, b];
  };
  /** `x++`, `--(x)`, `delete x[0]`, `(x.length) = 5`: the operand `arr[from..to]` is changed where it stands. */
  const changes = (arr, m, from, to) => {
    const [a, b] = grouped(arr, m, from, to);
    return isPunct(arr[b + 1], '++', '--') || isPunct(arr[a - 1], '++', '--') || isWord(arr[a - 1], 'delete') || assignsAt(arr, b + 1);
  };
  /** `for (x[0] of rows)`, `for ((x.length) in sizes)`: the head assigns the operand `arr[from..to]` on every turn. */
  const loopAssigns = (arr, m, from, to) => isWord(arr[grouped(arr, m, from, to)[1] + 1], 'of', 'in');
  /** True when `arr[at]` is written: assigned, updated, or a target of a destructuring assignment. */
  const writesTo = (arr, m, at) => {
    if (isPunct(arr[at - 1], '.', '?.')) return false; // a property of that name
    let after = at + 1;
    while (isPunct(arr[after], ')')) after += 1; // `(p) = other`
    if (assignsAt(arr, after) || changes(arr, m, at, at)) return true;
    // `for (p of rows)`, `for ((p) of rows)`: the head assigns on every turn.
    if (isWord(arr[after], 'of', 'in') && !isWord(arr[at - 1], 'const', 'let', 'var') && inForHead(arr, m, at)) return true;
    // `({ p } = other)`, `[p] = other`: the pattern closes before the `=`.
    return inAssignedPattern(arr, m, at);
  };
  /** True when `name` is written at a source offset `inside` accepts, other than at the token `declaration`. */
  const writtenIn = (name, inside, declaration = null) => arrays.some(({ arr, m }) => arr.some((use, at) => use.t === 'id' && use.v === name && use !== declaration && inside(use.i) && writesTo(arr, m, at)));

  const binderAt = (name, offset) => {
    const candidates = binders.get(name);
    if (candidates === undefined) return null;
    let found = null;
    for (const binder of candidates) if (binder.from <= offset && offset < binder.to && (found === null || binder.from > found.from)) found = binder;
    return found;
  };

  /**
   * The values of the array expression in `arr[from, to)`: a literal of
   * strings, a directory listing, a `const` bound to one, with any chain of
   * element-preserving methods after it. `.map()` and every other method
   * produce new elements, which says nothing about them.
   */
  const elementsOf = (arr, m, from, to, depth = 0) => {
    let i = from;
    while (i < to && isWord(arr[i], 'await')) i += 1;
    if (i >= to || depth > 6) return null;
    // A ternary `cond ? a : b` where both branches have the same listed/array domain.
    let q = -1;
    let qDepth = 0;
    for (let k = i; k < to; k += 1) {
      if (arr[k].t === 'p' && OPENERS[arr[k].v] && m[k] !== undefined) { k = m[k]; continue; }
      if (isPunct(arr[k], '?')) { if (q === -1) q = k; qDepth += 1; }
      else if (isPunct(arr[k], ':') && q !== -1) {
        qDepth -= 1;
        if (qDepth === 0) {
          const left = elementsOf(arr, m, q + 1, k, depth + 1);
          const right = elementsOf(arr, m, k + 1, to, depth + 1);
          return unionOf([left, right]);
        }
      }
    }
    let domain;
    const head = arr[i];
    if (isPunct(head, '(') && m[i] !== undefined && m[i] < to) {
      domain = elementsOf(arr, m, i + 1, m[i], depth + 1);
      i = m[i] + 1;
    } else if (isPunct(head, '[') && m[i] !== undefined && m[i] < to) {
      domain = [];
      for (const [a, b] of listRanges(arr, m, i)) {
        // `['f0', , 'f1']`: the empty slot is `undefined` to whatever iterates the array.
        if (a === b) return null;
        const { value, end } = evaluate(arr, m, a, ctx);
        if (value.k !== 'str' || end !== b) return null;
        domain.push(value.v);
      }
      i = m[i] + 1;
    } else if (head.t === 'id') {
      // `fs.readdirSync(`, `fs.promises.readdir(`, `Object.freeze(`: the callee is the last name of the dotted path.
      let callee = i;
      while (isPunct(arr[callee + 1], '.') && arr[callee + 2]?.t === 'id') callee += 2;
      const open = callee + 1;
      const calls = isPunct(arr[open], '(') && m[open] !== undefined && m[open] < to;
      if (calls && listsDirectory(arr, i, callee)) {
        // `withFileTypes` yields Dirent objects, not names.
        if (arr.slice(open + 1, m[open]).some((token) => isWord(token, 'withFileTypes'))) return null;
        domain = LISTED;
        i = m[open] + 1;
      } else if (calls && callee === i && scanners.has(head.v) && !shadowed(head.v)) {
        domain = scanners.get(head.v);
        i = m[open] + 1;
      } else if (calls && callee === i + 2 && head.v === 'Object' && arr[callee].v === 'freeze' && !shadowed('Object')) {
        domain = elementsOf(arr, m, open + 1, m[open], depth + 1);
        i = m[open] + 1;
      } else {
        domain = arrayBinding(head, depth);
        i += 1;
      }
    } else return null;
    while (domain !== null && i < to) {
      if (!isPunct(arr[i], '.', '?.') || arr[i + 1]?.t !== 'id' || !ELEMENT_PRESERVING.has(arr[i + 1].v) || !isPunct(arr[i + 2], '(') || m[i + 2] === undefined) return null;
      // A filter callback is handed the array and can replace an element it has not reached yet.
      if (arr[i + 1].v === 'filter' && !callbackIsBlind(arr, m, i + 3)) return null;
      i = m[i + 2] + 1;
    }
    return domain;
  };

  /**
   * True when the callback at `start` (an iteration method's first argument) cannot reach the array
   * it is handed after the index: an arrow with at most `limit` parameters, written inline or
   * declared once as a `const` in this file. A `function` has `arguments`.
   */
  const callbackIsBlind = (arr, m, start, limit = 2) => {
    let at = start;
    if (isWord(arr[at], 'async')) at += 1;
    const count = isPunct(arr[at], '(') && m[at] !== undefined && isPunct(arr[m[at] + 1], '=>') ? parameterCount(arr, m, at)
      : arr[at]?.t === 'id' && isPunct(arr[at + 1], '=>') ? 1
        : arr[at]?.t === 'id' && isPunct(arr[at + 1], ')') ? namedArity(arr[at].v)
          : Infinity;
    return count <= limit;
  };
  /** Parameters of the callback `name`: the global `Boolean`, or a `const` arrow declared once and bound nowhere else. */
  const namedArity = (name) => {
    if (name === 'Boolean') return shadowed(name) ? Infinity : 1;
    return (declared.get(name) ?? []).length === 1 && !binders.has(name) ? arrowArity.get(name) ?? Infinity : Infinity;
  };
  /** True when `arr[at]` is directly inside the parentheses of a `for` head. */
  const inForHead = (arr, m, at) => {
    let open = enclosingOpen(arr, m, at);
    while (open !== null && isPunct(arr[open], '(') && isPunct(arr[open - 1], '(')) open = enclosingOpen(arr, m, open); // grouping parentheses
    return open !== null && isPunct(arr[open], '(') && (isWord(arr[open - 1], 'for') || (isWord(arr[open - 1], 'await') && isWord(arr[open - 2], 'for')));
  };
  /** True when `arr[at]` sits in a pattern that is assigned to: `[a, names[0]] = pair`, `for ({ p } of rows)`. */
  const inAssignedPattern = (arr, m, at) => {
    for (let open = enclosingOpen(arr, m, at); open !== null; open = enclosingOpen(arr, m, open)) {
      // `[(p)] = pair`: a target may stand in grouping parentheses.
      if (groupsAt(arr, open)) continue;
      if (!isPunct(arr[open], '{', '[')) return false;
      if (assignsAt(arr, m[open] + 1)) return true;
      if (isWord(arr[m[open] + 1], 'of', 'in') && !isWord(arr[open - 1], 'const', 'let', 'var') && inForHead(arr, m, open)) return true;
    }
    return false;
  };
  /**
   * The text of every string and template in the file. The tokenizer can take code for one (a regex
   * literal it reads as division swallows what follows up to the next quote), and `eval` runs one: a
   * use of a name that would change what is proven about it may be hiding there.
   */
  const stringText = arrays.flatMap(({ arr }) => arr.flatMap((token) => (token.t === 's' ? [token.v] : token.t === 'tpl' ? token.quasis : []))).join('\n');
  const named = (name, after) => new RegExp(`(?:^|[^\\w$.])${name.replace(/[$]/g, '\\$&')}\\s*(?:${after})`, 'g');
  const hiddenUse = (name, after) => named(name, after).test(stringText);
  /** A write to `name` spelled inside a string or template: `eval("name = …")`, or code read as text. */
  const hiddenWrite = (name) => confused || hiddenUse(name, '=(?!=)|\\+\\+|--|[-+*/%|&^?]{1,3}=|\\)\\s*=(?!=)');
  /**
   * True when the source calls `name` more often than the tokens show. A regex literal read as
   * division can end in `//` and take the rest of its line for a comment, call and all; a comment
   * that happens to spell a call costs that file the resolution, nothing more.
   */
  const hiddenCall = (name) => {
    const written = (ctx.src.match(named(name, '\\(')) ?? []).length;
    const seen = arrays.reduce((count, { arr }) => count + arr.filter((token, at) => token.t === 'id' && token.v === name && isPunct(arr[at + 1], '(') && !isPunct(arr[at - 1], '.', '?.')).length, 0);
    return written > seen;
  };
  /** A lone backslash is no JavaScript outside a literal: an escaped identifier (`r\u0065ad`) or code the tokenizer lost. */
  const confused = arrays.some(({ arr }) => arr.some((token) => isPunct(token, '\\')));
  /** True when the dotted callee ending at `arr[at]` hangs off the test API: `it.each`, `describe.skip.each`. */
  const onTestApi = (arr, at) => {
    let root = at;
    while (isPunct(arr[root - 1], '.') && arr[root - 2]?.t === 'id') root -= 2;
    return isWord(arr[root], 'it', 'test', 'describe') && !shadowed(arr[root].v);
  };

  /** The elements of a module-level `const` array, when nothing in the file can add one to it. */
  const arrayBinding = (token, depth) => {
    const name = token.v;
    const start = ctx.bindings.get(name);
    if (binderAt(name, token.i) !== null) return null;
    // A frozen array another module exports (`literalExports`): nothing can add to it.
    if (start === undefined) {
      const imported = importedConstant(name, ctx, shadowed);
      return imported?.k === 'array' ? imported.values : null;
    }
    // One declaration of the name in the whole file: an inner `const { NAMES } = row` would be another array.
    if (binders.has(name) || !isWord(ctx.tokens[start - 3], 'const') || (declared.get(name) ?? []).length !== 1) return null;
    const end = expressionEnd(ctx.tokens, ctx.match, start);
    // `Object.freeze([...])` as the whole initializer: `Object.freeze([...]).slice()` is an unfrozen copy.
    const frozen = isWord(ctx.tokens[start], 'Object') && isPunct(ctx.tokens[start + 1], '.') && isWord(ctx.tokens[start + 2], 'freeze') && isPunct(ctx.tokens[start + 3], '(')
      && ctx.match[start + 3] === end - 1 && !shadowed('Object');
    // A frozen array cannot change. Any other must only be read: an export or an alias can reach `push()`.
    if (!frozen && (isWord(ctx.tokens[start - 4], 'export') || hiddenUse(name, '\\??\\.|\\[|\\)')
      || !arrays.every(({ arr, m }) => arr.every((use, at) => use.t !== 'id' || use.v !== name || use === ctx.tokens[start - 2] || readsArray(arr, m, at))))) return null;
    return elementsOf(ctx.tokens, ctx.match, start, end, depth + 1);
  };
  const readsArray = (arr, m, at) => {
    const prev = arr[at - 1];
    const next = arr[at + 1];
    // `({ map: NAMES.map } = other)`, `[NAMES[0]] = pair`: a target, whatever is named.
    if (inAssignedPattern(arr, m, at)) return false;
    if (isPunct(prev, '.', '?.')) return true; // a property of that name on something else
    if (isPunct(prev, '...') || isWord(prev, 'of') || (isPunct(prev, '?') && isPunct(next, ':') && inForHead(arr, m, at))) return true;
    if (isPunct(next, '.', '?.')) {
      const method = arr[at + 2];
      // A method that only reads, and is not replaced (`NAMES.map = other`). `NAMES.length++`,
      // `++(NAMES.length)` and `(NAMES.length) = 5` add empty slots.
      if (method?.t !== 'id' || !ARRAY_READS.has(method.v) || changes(arr, m, at, at + 2) || loopAssigns(arr, m, at, at + 2)) return false;
      const open = isPunct(arr[at + 3], '?.') ? at + 4 : at + 3; // `NAMES.forEach?.(cb)`
      if (!ARRAY_ITERATORS.has(method.v) || !isPunct(arr[open], '(') || m[open] === undefined) return true;
      // `names.forEach((name, i, all) => all.push(x))`: the callback is handed the array.
      return callbackIsBlind(arr, m, open + 1, method.v.startsWith('reduce') ? 3 : 2);
    }
    if (isPunct(next, '[') && m[at + 1] !== undefined) {
      // One element, read: not called (`NAMES['push'](x)`), not written (`NAMES[0] = x`, `NAMES[0] += x`,
      // `[NAMES[0]] = pair`, `for (NAMES[0] of xs)`), not removed (`delete NAMES[0]`, which leaves an
      // empty slot). `NAMES[0] === x` is a read.
      if (isPunct(arr[m[at + 1] + 1], '(', '?.') || changes(arr, m, at, m[at + 1])) return false;
      return !loopAssigns(arr, m, at, m[at + 1]);
    }
    if (isPunct(prev, '(', ',') && isPunct(next, ')', ',')) {
      // Handed to something that only reads it: `expect(NAMES)`, `new Set(NAMES)`, `Array.from(NAMES)`,
      // `Object.freeze(NAMES)`, `JSON.stringify(NAMES)`, `it.each(NAMES)`, a matcher.
      const open = enclosingOpen(arr, m, at);
      const callee = open !== null && isPunct(arr[open], '(') ? arr[open - 1] : null;
      // Alone: a second argument can be a callback that is handed the array, or bound to it as `this`.
      if (callee?.t !== 'id' || listRanges(arr, m, open).length !== 1) return false;
      if (!isPunct(arr[open - 2], '.')) {
        if (shadowed(callee.v)) return false;
        if (callee.v === 'Set') return isWord(arr[open - 2], 'new');
        // `expect(NAMES).toHaveLength(2)`, `expect(NAMES).not.toContain(x)`: compared, there and then.
        const matcher = m[open] + (isPunct(arr[m[open] + 1], '.') && isWord(arr[m[open] + 2], 'not') ? 4 : 2);
        return callee.v === 'expect' && isPunct(arr[matcher - 1], '.') && arr[matcher]?.t === 'id' && COMPARING_MATCHERS.has(arr[matcher].v) && isPunct(arr[matcher + 1], '(');
      }
      const owner = arr[open - 3];
      const global = (name) => isWord(owner, name) && !isPunct(arr[open - 4], '.', '?.') && !shadowed(name);
      return (callee.v === 'each' && onTestApi(arr, open - 1)) || ARRAY_MATCHERS.has(callee.v)
        || (global('Array') && (callee.v === 'from' || callee.v === 'isArray'))
        || (global('Object') && callee.v === 'freeze') || (global('JSON') && callee.v === 'stringify');
    }
    return false;
  };

  /** Start of the member/call chain that ends just before `end`, or null. */
  const operandStart = (arr, m, end) => {
    let i = end - 1;
    for (;;) {
      const token = arr[i];
      if (token === undefined) return null;
      if (isPunct(token, ')', ']')) {
        if (m[i] === undefined) return null;
        i = m[i];
        const before = arr[i - 1];
        // A call or an index continues leftwards to its callee; a parenthesized head or an array literal starts here.
        if (isPunct(before, ')', ']') || (before?.t === 'id' && !OPERAND_KEYWORDS.has(before.v))) { i -= 1; continue; }
        // After `}` or a literal, with no semicolon between, this is an index into what came before.
        if (isPunct(before, '}') || ['s', 'n', 'tpl', 're'].includes(before?.t)) return null;
        return i;
      }
      if (token.t !== 'id') return null;
      if (!isPunct(arr[i - 1], '.', '?.')) return i;
      i -= 2;
    }
  };

  const unionOf = (parts) => {
    if (parts.includes(null)) return null;
    if (parts.every((part) => !isListedDomain(part))) return [...new Set(parts.flat())];
    return parts.every((part) => part === parts[0] && isListedDomain(part)) ? parts[0] : null;
  };

  /** The `[from, to)` of argument `index` of the call opened at `open`, or null: too few arguments, or a spread before it. */
  const argumentRange = (arr, m, open, index) => {
    const ranges = listRanges(arr, m, open);
    if (index >= ranges.length || ranges.slice(0, index + 1).some(([from]) => isPunct(arr[from], '...'))) return null;
    return ranges[index];
  };
  /** What argument `index` of the call opened at `open` can be. */
  const argumentDomain = (arr, m, open, index) => {
    const range = argumentRange(arr, m, open, index);
    if (range === null) return null;
    const [from, to] = range;
    const { value, end } = evaluate(arr, m, from, ctx);
    if (end !== to) return null;
    if (value.k === 'str') return [value.v];
    // A listed name passed on unchanged.
    if (value === LISTED_NAME) return LISTED;
    // Text built from other resolved variables (`read(\`${stem}.json\`)`): one value per combination of theirs.
    const texts = isVariableText(value) ? variableCombinations(value.vars)?.map((chosen) => evaluate(arr, m, from, { ...ctx, overrides: chosen, bindingValues: new Map(), resolving: new Set() }).value) : null;
    return texts?.every((text) => text.k === 'str') ? texts.map((text) => text.v) : null;
  };

  /** Every use of the function named by `nameToken` but its declaration, or null when the name can mean something else. */
  const usesOf = (nameToken) => {
    const name = nameToken.v;
    if ((declared.get(name) ?? []).length !== 1 || binders.has(name) || hiddenUse(name, '[(`.]|\\?\\.') || hiddenCall(name)) return null;
    const uses = [];
    for (const { arr, m } of arrays) {
      for (let at = 0; at < arr.length; at += 1) {
        const use = arr[at];
        if (use.t !== 'id' || use.v !== name || use === nameToken) continue;
        if (isPunct(arr[at - 1], '.', '?.') || (isPunct(arr[at + 1], ':') && isPunct(arr[at - 1], '{', ','))) continue; // another object's property
        uses.push({ arr, m, at });
      }
    }
    return uses;
  };

  /** Every value parameter `index` of the function named by `nameToken` is called with, or null when a use is not a plain call. */
  const callSiteDomain = (nameToken, index) => {
    const uses = usesOf(nameToken);
    if (uses === null) return null;
    const parts = [];
    for (const { arr, m, at } of uses) {
      const prev = arr[at - 1];
      const next = arr[at + 1];
      if (isPunct(next, '(') && m[at + 1] !== undefined) parts.push(argumentDomain(arr, m, at + 1, index));
      else if (index === 0 && isPunct(prev, '(') && isPunct(next, ')') && arr[at - 2]?.t === 'id' && ELEMENT_CALLBACKS.has(arr[at - 2].v) && isPunct(arr[at - 3], '.', '?.')) {
        // `NAMES.map(read)`: called with each element, and with the array, which it must not be able to take.
        if (!callbackIsBlind(arr, m, at)) return null;
        const start = operandStart(arr, m, at - 3);
        parts.push(start === null ? null : elementsOf(arr, m, start, at - 3));
      } else return null; // exported, aliased, stored or handed on: its callers are not all in view
      if (parts.at(-1) === null) return null;
    }
    return unionOf(parts);
  };

  /** The one complete path every call passes as parameter `index` (or destructured property `prop`) of `nameToken`, or null. */
  const callSitePath = (nameToken, index, prop = null) => {
    const uses = usesOf(nameToken);
    if (uses === null) return null;
    let passed = null;
    for (const { arr, m, at } of uses) {
      if (!isPunct(arr[at + 1], '(') || m[at + 1] === undefined) return null; // not every caller is in view
      const range = argumentRange(arr, m, at + 1, index);
      if (range === null) return null;
      let exprFrom = range[0];
      let exprTo = range[1];
      if (prop !== null) {
        if (!isPunct(arr[exprFrom], '{') || m[exprFrom] === undefined || m[exprFrom] + 1 !== exprTo) return null;
        const entry = listRanges(arr, m, exprFrom).find(([pf, pt]) => arr[pf]?.t === 'id' && arr[pf].v === prop && (pf + 1 === pt || isPunct(arr[pf + 1], ':')));
        if (entry === undefined) return null;
        exprFrom = entry[0] + 1 === entry[1] ? entry[0] : entry[0] + 2;
        exprTo = entry[1];
      }
      const { value, end } = evaluate(arr, m, exprFrom, ctx);
      if (end !== exprTo || value.k !== 'path' || value.partial) return null;
      if (passed !== null && JSON.stringify(passed) !== JSON.stringify(value)) return null;
      passed = value;
    }
    return passed;
  };

  /** The first parameter of a callback handed to an array method or to `it.each(table)`. */
  const callbackDomain = ({ arr, m, at }, index) => {
    if (index !== 0) return null;
    const open = isPunct(arr[at], '(') ? at : enclosingOpen(arr, m, at);
    if (open === null || !isPunct(arr[open], '(')) return null;
    const position = listRanges(arr, m, open).findIndex(([from, to]) => from <= at + 1 && at + 1 < to);
    const callee = arr[open - 1];
    if (position === 0 && callee?.t === 'id' && ELEMENT_CALLBACKS.has(callee.v) && isPunct(arr[open - 2], '.', '?.')) {
      // The callback is handed the array too, and could replace an element it has not been called with yet.
      const start = callbackIsBlind(arr, m, at + 1) ? operandStart(arr, m, open - 2) : null;
      return start === null ? null : elementsOf(arr, m, start, open - 2);
    }
    // `it.each(TABLE)('title', (row) => …)`: one call per row; a row that is itself an array is spread, and is no string.
    if (position >= 1 && isPunct(callee, ')') && m[open - 1] !== undefined && isWord(arr[m[open - 1] - 1], 'each') && onTestApi(arr, m[open - 1] - 1)) {
      return elementsOf(arr, m, m[open - 1] + 1, open - 1);
    }
    return null;
  };

  /** True when the binder holds what it was given wherever its name is used inside its extent. */
  const settled = (binder) => {
    // Two binders of one name where one is inside the other, or a declaration of the name inside
    // the body: which one a use means depends on scoping this pass does not model.
    const inside = (offset) => binder.from <= offset && offset < binder.to;
    const ambiguous = binders.get(binder.name).some((other) => other !== binder && (inside(other.from) || (other.from <= binder.from && binder.from < other.to)))
      || (declared.get(binder.name) ?? []).some(inside);
    // `p = other()`, `p++` or `({ p } = other)` in the body: the variable no longer holds what it was given.
    // `arguments[0] = x` rebinds a parameter in a sloppy-mode script, and `eval` can do anything.
    const rewritten = writtenIn(binder.name, inside, binder.token ?? null) || arrays.some(({ arr }) => arr.some((token) => isWord(token, 'arguments', 'eval') && inside(token.i)))
      || hiddenWrite(binder.name);
    return !ambiguous && !rewritten;
  };
  /**
   * The path a helper's parameter holds when every call passes the same complete one (`read(FIXTURES)`),
   * or null. Asked only for a parameter named like a module-level path (`identifierValue`).
   */
  const pathOf = (binder) => {
    if (binder.path !== undefined) return binder.path;
    binder.path = null; // a value that flows back into itself resolves to nothing
    if (!settled(binder)) return null;
    if (binder.defaultExpr !== undefined) {
      const { value, end } = evaluate(binder.defaultExpr.arr, binder.defaultExpr.m, binder.defaultExpr.from, ctx);
      if (end === binder.defaultExpr.to && value.k === 'path' && !value.partial && !value.unfollowed) binder.path = value;
    }
    if (binder.path === null && binder.kind === 'param' && binder.role.kind === 'named') {
      binder.path = callSitePath(binder.role.nameToken, binder.index);
    } else if (binder.path === null && binder.kind === 'destructured' && binder.prop !== null && binder.role.kind === 'named') {
      binder.path = callSitePath(binder.role.nameToken, binder.index, binder.prop);
    }
    return binder.path;
  };
  const domainOf = (binder) => {
    if (binder.domain !== undefined) return binder.domain;
    binder.domain = null; // a value that flows back into itself resolves to nothing
    if (!settled(binder)) return null;
    const logged = ctx.shared.trustLog.length;
    if (binder.kind === 'loop') binder.domain = elementsOf(binder.iter.arr, binder.iter.m, binder.iter.from, binder.iter.to);
    else if (binder.kind === 'param' && binder.role.kind === 'named') binder.domain = callSiteDomain(binder.role.nameToken, binder.index);
    else if (binder.kind === 'param' && binder.role.kind === 'callback') binder.domain = callbackDomain(binder.role, binder.index);
    binder.trusts = ctx.shared.trustLog.slice(logged);
    return binder.domain;
  };

  return { binderAt, domainOf, pathOf, writtenIn, shadowed, hiddenWrite, declaredTwice: (name) => (declared.get(name) ?? []).length > 1, hasBinder: (name) => binders.has(name) };
}

/**
 * A bare identifier. An enclosing parameter or loop variable shadows a
 * module-level binding of the same name, and evaluates to what the source
 * proves about it (`createScopes`): an entry of a directory listing, one of a
 * known set of literal values (substituted when `ctx.overrides` names it), or
 * unknown, named after the helper it is a parameter of.
 */
function identifierValue(token, ctx, depth) {
  if (ctx.unscoped) return bindingValue(token.v, ctx, depth);
  ctx.shared.scopes ??= createScopes(ctx.shared.root);
  const binder = ctx.shared.scopes.binderAt(token.v, token.i);
  if (binder === null && token.v === 'delimiter' && ctx.delimiter && !ctx.shared.scopes.shadowed('delimiter')) return DELIMITER;
  if (binder === null) return bindingValue(token.v, ctx, depth);
  if (ctx.overrides?.has(binder)) return str(ctx.overrides.get(binder));
  const domain = ctx.shared.scopes.domainOf(binder);
  if (domain !== null) ctx.shared.trustLog.push(...binder.trusts);
  if (domain === LISTED) return LISTED_NAME;
  if (domain === MIGRATION_LISTED) return MIGRATION_LISTED_NAME;
  if (domain === DB_MIGRATION_LISTED) return DB_MIGRATION_LISTED_NAME;
  if (domain !== null) return variableValue({ open: true, vars: [binder] });
  const via = binder.kind === 'param' && binder.role?.kind === 'named' ? binder.role.nameToken.v : null;
  const paramPath = ctx.shared.scopes.pathOf(binder);
  if (paramPath !== null) return paramPath;
  // Named like a module-level path (`function read(ROOT)` beside `const ROOT = …`): the constant when
  // every call passes one path, which is then that path; otherwise somewhere the source does not say,
  // starting from the constant the name was read as before binders were modelled. Never nothing.
  const outer = bindingValue(token.v, ctx, depth);
  if (outer.k === 'path') return partialPath(outer, outer.v, { open: true, via });
  return via === null ? UNKNOWN : variableValue({ open: true, via });
}

/** The evaluated initializer of a `const`/`let`/`var` binding, memoized per file. */
function bindingValue(name, ctx, depth = 0) {
  const bound = ctx.bindings.get(name);
  if (bound === undefined) {
    ctx.shared.scopes ??= createScopes(ctx.shared.root);
    const imported = importedConstant(name, ctx, ctx.shared.scopes.shadowed);
    return imported?.k === 'str' ? str(imported.v) : imported?.k === 'path' ? imported : UNKNOWN;
  }
  if (ctx.resolving.has(name)) return UNKNOWN;
  if (ctx.bindingValues.has(name)) {
    const cached = ctx.bindingValues.get(name);
    ctx.shared.trustLog.push(...cached.trusts);
    return cached.value;
  }
  ctx.resolving.add(name);
  const logged = ctx.shared.trustLog.length;
  const initial = evaluate(ctx.tokens, ctx.match, bound, ctx, depth + 1).value;
  ctx.resolving.delete(name);
  // `let name = 'a.json'` that is assigned again is not the literal it started as. (A path keeps the
  // older reading: its first value is an input either way.)
  ctx.shared.scopes ??= createScopes(ctx.shared.root);
  // Nor is it when another scope declares the name again (`const { name } = row`, an import) or binds it
  // as a parameter or loop variable: which one a use means is scoping this pass models only roughly.
  const declarator = ctx.tokens[bound - 2];
  const constant = isWord(ctx.tokens[bound - 3], 'const');
  const rebound = !ctx.unscoped && (initial.k === 'str' || isVariableText(initial)) && (ctx.shared.scopes.declaredTwice(name) || ctx.shared.scopes.hasBinder(name)
    || (!constant && (ctx.shared.scopes.writtenIn(name, () => true, declarator) || ctx.shared.scopes.hiddenWrite(name))));
  const value = rebound ? UNKNOWN : initial;
  ctx.bindingValues.set(name, { value, trusts: ctx.shared.trustLog.slice(logged) });
  return value;
}

/** `const|let|var NAME =` initializers by name; a name bound twice is ambiguous and dropped. */
function collectBindings(tokens, match) {
  const bindings = new Map();
  const seen = new Set();
  for (let i = 0; i + 3 < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.t !== 'id' || !(token.v === 'const' || token.v === 'let' || token.v === 'var')) continue;
    // Every declarator: `const a = 1, file = join(HERE, name)` binds `file` too.
    for (let at = i + 1; tokens[at]?.t === 'id' && isPunct(tokens[at + 1], '=');) {
      const name = tokens[at];
      if (seen.has(name.v)) bindings.delete(name.v);
      else { seen.add(name.v); bindings.set(name.v, at + 2); }
      const end = expressionEnd(tokens, match, at + 2);
      if (!isPunct(tokens[end], ',')) break;
      at = end + 1;
    }
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
function widestPathExpression(tokens, match, index, guarded = false) {
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
    // A group does not consume the path. Look for the call or option around it.
    if (groupsAt(tokens, parent) && parent + 1 === start) { start = parent; continue; }
    const callee = calleeStart(tokens, parent);
    const name = calleeName(tokens, parent);
    const isNew = tokens[callee]?.t === 'id' && tokens[callee].v === 'new';
    if ((isNew && name === 'URL') || name === 'URL' || PATH_JOIN.has(name) || PATH_DIRNAME.has(name) || PATH_IDENTITY.has(name) || (guarded && name === 'pathWithin')) {
      start = callee;
      continue;
    }
    break;
  }
  const before = tokens[start - 1];
  if (before?.t === 'p' && before.v === '=') return null;
  const parent = enclosingOpen(tokens, match, start);
  if (before?.t === 'p' && before.v === ':' && ['id', 's'].includes(tokens[start - 2]?.t) && ['cwd', 'root', 'dir', 'base'].includes(tokens[start - 2].v)) {
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
  const member = parent !== null && tokens[parent].v === '{' && (keyed || shorthand);
  let recipient = consumer;
  // Unsupported path values can be passed inside an options object or array.
  if (recipient === null && parent !== null && (member || tokens[parent].v === '[')) {
    let outer = enclosingOpen(tokens, match, parent);
    while (outer !== null && punct(tokens[outer], '{', '[')) outer = enclosingOpen(tokens, match, outer);
    if (outer !== null && punct(tokens[outer], '(')) recipient = calleeName(tokens, outer);
  }
  return { index: start, consumer, walk, bare: start === index, option: null, member, recipient };
}

// ---------------------------------------------------------------------------
// Per-file extraction.
// ---------------------------------------------------------------------------

/**
 * Everything one source file contributes, before any filesystem lookup:
 * module edges, path inputs, directory inputs, cwd-relative literals, and the
 * reasons it fails closed. Pure, but for `exportedConstant(spec, name)`: the
 * analyzer's reading of another module's literal exports (`literalExports`),
 * so an imported constant names its files; without it an import is unknown.
 */
export function extractFileFacts(src, { fileRel, cwdRel, replaced = null, exportedConstant = null }) {
  const facts = {
    edges: [], // { spec, kind: 'static'|'dynamic'|'require'|'mock' (registration)|'mock-import' }
    paths: [], // { rel, walk, read } — repo-relative literal paths; `read`: only handed to a filesystem read
    dirs: [], // { rel, walk, guessed, open, via } — repo-relative directory prefixes whose tree is an input; guessed: the prefix of a path with a variable segment; open: nothing proves that segment stays under the prefix (via: the helper whose parameter it is)
    scopedNames: [], // basenames a require() reads under an unknown directory: every tracked file of that name is an input
    cwdLiterals: [], // { value, walk, dir } — resolved against cwd, then repo root, then the file
    unresolvedEdges: [], // the module graph is not fully known from source
    unresolvedInputs: [], // a filesystem input is not fully known from source
    handedProblems: new Set(), // rooting options that a real-browser key cannot follow
    handedDirs: [], // directories given to code the analyzer does not model (a Vite root, a static server)
    nativeUnresolved: false, // a non-literal require(): a native load no recording shows
    localReads: [], // machine-local state a member reads (home directory); the test or tooling fails closed on it
    tools: new Set(), // external programs reached (TEST_MEMO_TOOLS)
    never: NEVER_MARKER.test(src),
    git: false,
    trusts: new Set(), // specifiers of the modules whose constants named a read: a member that mocks one voids it (`gather`)
  };
  let tokens;
  try { tokens = tokenize(src, new Set(), { jsx: !/\.[cm]?ts$/.test(fileRel) }); } catch (error) {
    facts.unresolvedEdges.push(`unparseable source: ${error.message}`);
    facts.unresolvedInputs.push(`unparseable source: ${error.message}`);
    return facts;
  }
  const match = matchBrackets(tokens);
  const ctx = { fileRel, cwdRel, tokens, match, bindings: collectBindings(tokens, match), bindingValues: new Map(), resolving: new Set() };
  ctx.imports = namedImports(tokens, match);
  ctx.mocksSpecifier = (spec) => mocksModule(tokens, match, (mocked) => mocked === spec, []);
  ctx.exportedConstant = exportedConstant && ((spec, name) => (
    ctx.mocksSpecifier(spec) ? null : exportedConstant(spec, name)
  ));
  // A source this file or the workspace setup (`replaced`) mocks is trusted for nothing.
  const own = replacedSources(src, fileRel);
  ctx.replaced = { fs: own.fs || replaced?.fs === true, crypto: own.crypto || replaced?.crypto === true, guard: own.guard || replaced?.guard === true };
  ctx.guarded = importsNamed(tokens, match, 'pathWithin', (spec) => isGuardModule(fileRel, spec));
  ctx.delimiter = importsNamed(tokens, match, 'delimiter', (spec) => spec === 'path' || spec === 'node:path');
  facts.replaces = own;
  ctx.src = src;
  ctx.uuid = !ctx.replaced.crypto && importsNamed(tokens, match, 'randomUUID', isCryptoModule);
  // One holder for every copy of the context (`valuesAt` evaluates under a copy): the scope analysis is per file.
  // The sources a read of this file relies on, for a mock registered by another member (`gather`).
  facts.trusted = { fs: false, crypto: false, guard: false };
  ctx.shared = { root: ctx, scopes: undefined, trusted: facts.trusted, trustLog: [] };
  const trusts = (value) => { if (value.partial && !value.open) for (const source of value.trust ?? []) facts.trusted[source] = true; };
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

  const literalArg = (open, source = tokens, brackets = match) => {
    const first = source[open + 1];
    const second = source[open + 2];
    if (!first || brackets[open] === undefined) return { kind: 'none' };
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

  /**
   * The values of the expression at `index`. A path whose variable parts each
   * have a known set of literal values is evaluated once per combination, so
   * `read('../../client/x.js')` contributes that file and not a directory the
   * read never touches. A helper that is never called contributes nothing.
   */
  let valueTrusts = []; // the modules the values `valuesAt` last returned came through
  const valuesAt = (index) => {
    const logged = ctx.shared.trustLog.length;
    const { value } = evaluate(tokens, match, index, ctx);
    valueTrusts = ctx.shared.trustLog.slice(logged);
    if (value.k === 'unknown' || value.k === 'tail') {
      // Unknown text read as a whole path is runtime data and no input. Where it is unknown only because
      // a parameter or a loop variable shares a constant's name (`unscoped`: every name is its
      // module-level binding, as before binders were modelled), what the constant names stays an input:
      // the scope rules may refuse a read, never drop one.
      const before = evaluate(tokens, match, index, { ...ctx, unscoped: true, bindingValues: new Map(), resolving: new Set() }).value;
      valueTrusts = ctx.shared.trustLog.slice(logged);
      if (before.k !== 'unknown' && before.k !== 'tail') return [before];
    }
    const combinations = value.k === 'path' && value.partial && value.open ? variableCombinations(value.vars) : null;
    // `a\\b` is one name on POSIX and two segments on Windows, and `C:` is a drive there: no single file to key.
    if (combinations === null || combinations.some((chosen) => [...chosen.values()].some((text) => /\\|^[A-Za-z]:/.test(text)))) return [value];
    // `resolved`: a path with a variable part is a read whoever consumes it, and stays one with the variable filled in.
    return combinations.map((chosen) => ({ ...evaluate(tokens, match, index, { ...ctx, overrides: chosen, bindingValues: new Map(), resolving: new Set() }).value, resolved: true }));
  };
  /** Only a value that is keyed depends on the modules it came through (`valueTrusts`): note them for `gather`. */
  const trusted = () => { for (const spec of valueTrusts) facts.trusts.add(spec); };

  const record = (value, { walk = false, consumer = null, bare = false, option = null, member = false, recipient = consumer } = {}) => {
    // A search-path entry is where a program the string is handed to is found and run: a directory
    // handed to a spawn (its whole tree is an input), whatever the string is then given to.
    if (value.k === 'search') {
      for (const entry of [...value.entries, value.tail]) if (entry.k === 'path') record(entry, { walk: true, consumer: 'spawn' });
      return true;
    }
    if (option !== null) {
      if (value.k !== 'path' || option === 'cwd') return true;
      if (value.unfollowed) facts.handedProblems.add(unfollowedReason(value));
      else if (value.partial && value.open) facts.handedProblems.add(openReadReason(value.v, value.via));
      else { trusted(); trusts(value); facts.handedDirs.push(value.v); }
      return true;
    }
    if (value.k === 'home') {
      if (!(consumer !== null && NON_READ_CALLEES.has(consumer))) facts.localReads.push('~');
      return true;
    }
    if (value.k === 'str') {
      if (value.v.startsWith('/') || /^[a-z]+:/i.test(value.v)) return true;
      trusted();
      facts.cwdLiterals.push({ value: value.v, walk, dir: false });
      return true;
    }
    if (value.k !== 'path') return value.k !== 'unknown';
    if (value.unfollowed) {
      // An unsupported operation may produce ordinary text. Refuse only when a
      // sink or an unmodelled call could read through the result.
      if (recipient !== null && (!NON_READ_CALLEES.has(recipient) || SPAWN_CALLEES.has(recipient) || READ_CALLEES.has(recipient))) {
        facts.unresolvedInputs.push(unfollowedReason(value));
      }
      return true;
    }
    if (consumer !== null && NON_READ_CALLEES.has(consumer)) return true;
    trusted();
    // A glob pattern is no file: it reads every match under the directory in front of its first wildcard.
    if (consumer !== null && /^glob/i.test(consumer) && !value.partial && /[*?[\]{}]/.test(value.v)) {
      const literal = value.v.slice(0, value.v.search(/[*?[\]{}]/));
      const rel = normalizeRel(literal === '' || literal.endsWith('/') ? literal : posix.dirname(literal));
      facts.dirs.push({ rel, walk, guessed: true, open: CLIMBS.test(value.v.slice(literal.length)), via: null });
      return true;
    }
    if (value.partial || value.isDir) {
      // A complete directory handed to an unknown function (`resolveInstallRoot(join(__dirname, '..'))`)
      // or passed nowhere (`cwd || process.cwd()`) is a value. A partial path (variable
      // segments) or a directory handed to a read/spawn sink is a read of that tree.
      const read = value.partial || value.resolved === true || (consumer !== null && (READ_CALLEES.has(consumer) || SPAWN_CALLEES.has(consumer)));
      if (!read) {
        // `resolveClientBundler(repoRoot)` resolves the client workspace's bundler packages.
        if (consumer === 'resolveClientBundler') facts.handedDirs.push(normalizeRel(posix.join(value.v, 'client/node_modules')));
        else if (consumer !== null || member) facts.handedDirs.push(value.v);
        return true;
      }
      const open = value.partial && value.open;
      trusts(value);
      for (const rel of open && value.outer !== undefined ? [value.v, value.outer] : [value.v]) facts.dirs.push({ rel, walk, guessed: value.partial, open, via: value.via ?? null, ...(value.filter ? { filter: value.filter } : {}) });
      return true;
    }
    facts.paths.push({ rel: value.v, walk: walk || JS_EXT.test(value.v), read: consumer !== null && READ_CALLEES.has(consumer) });
    return true;
  };

  const anchorInside = (list) => list.some((t) => (t.t === 'id' && (t.v === '__dirname' || t.v === '__filename' || t.v === 'import' || t.v === 'process'
    || (ctx.bindings.has(t.v) && bindingValue(t.v, ctx).k === 'path'))) || (t.t === 'tpl' && t.exprs.some(anchorInside)));
  // These reads are keyed at their call sites, including calls nested in template holes.
  if (/\bread(?:Server|Client)Source\b/.test(src)) {
    for (const { arr, m } of tokenArrays(tokens, match)) {
      for (let i = 0; i < arr.length; i += 1) {
        const { t, v: name } = arr[i];
        const prev = arr[i - 1];
        if (t !== 'id' || !Object.hasOwn(SOURCE_READERS, name) || isWord(prev, 'function')) continue;
        if (isPunct(arr[i + 1], '(')) {
          const arg = literalArg(i + 1, arr, m);
          if (arg.kind === 'literal') facts.paths.push({ rel: normalizeRel(posix.join(SOURCE_READERS[name], arg.value)), walk: false, read: true });
          else if (arg.kind === 'expr') facts.unresolvedInputs.push(`${name}() with a non-literal path`);
        } else if (!isWord(prev, 'const', 'let', 'var') && !namedInImportList(arr, m, i) && !(isPunct(arr[i + 1], ':') && isPunct(prev, '{', ','))) {
          facts.unresolvedInputs.push(`${name} used other than by a direct call`);
        }
      }
    }
  }
  // The bodies of the source readers whose every call is checked by name above: what they read is
  // what their callers name, which those callers already contribute (or fail closed on).
  const checkedBodies = [];
  for (const name of CALL_SITE_CHECKED_READERS[fileRel] ?? []) {
    for (let i = 0; i + 2 < tokens.length; i += 1) {
      if (!isWord(tokens[i], 'function') || !isWord(tokens[i + 1], name) || !isPunct(tokens[i + 2], '(') || match[i + 2] === undefined) continue;
      const body = match[i + 2] + 1;
      if (isPunct(tokens[body], '{') && match[body] !== undefined) checkedBodies.push([body, match[body]]);
    }
  }
  for (let i = 0; i < tokens.length; i += 1) {
    if (checkedBodies.some(([from, to]) => from < i && i < to)) continue;
    const token = tokens[i];
    if (token.t === 's') continue; // a bare string is a name (a registry entry, an exclude glob), never a read
    if (token.t === 'tpl') {
      // `${ROOT}/docs/x.md`: the hole holds the anchor, the template is the expression.
      if (!token.exprs.some(anchorInside)) continue;
      const widest = widestPathExpression(tokens, match, i, ctx.guarded);
      if (widest !== null) for (const value of valuesAt(widest.index)) record(value, widest);
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
      for (const value of valuesAt(arg.index)) {
        if (value.k === 'path' || value.k === 'str') trusted();
        if (value.k === 'path') {
          if (value.unfollowed) { facts.unresolvedInputs.push(unfollowedReason(value)); continue; }
          // A complete path: a file, a directory, or a name the loader completes (`./mod` is `./mod.js`).
          if (!value.partial) { facts.paths.push({ rel: value.v, walk: true }); continue; }
          facts.dirs.push({ rel: value.v, walk: true, ...(value.filter ? { filter: value.filter } : {}) });
          trusts(value);
          if (!(value.partial && value.open)) continue;
          // Unbounded, the module may be anywhere, under the prefix or not: an edge the source does not name.
          if (value.outer !== undefined) facts.dirs.push({ rel: value.outer, walk: true });
        } else {
          // `require(PACKAGE_CONSTANT)`: a module-level string is a specifier like a literal one.
          if (value.k === 'str') { facts.edges.push({ spec: value.v, kind }); continue; }
          // `require(join(<unknown dir>, 'ecosystem.config.cjs'))`: the directory is a parameter or an
          // install root, the basename is fixed, so every tracked file of that name is an input
          // (tests only load in-repo files, so keying by tracked basename covers the real target).
          const scoped = kind === 'require' ? joinedBasename(arg.index) : null;
          if (scoped !== null) { facts.scopedNames.push(scoped); continue; }
        }
        if (kind === 'require') facts.nativeUnresolved = true;
        facts.unresolvedEdges.push(`${token.v}() with a non-literal specifier`);
      }
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
        for (const program of valuesAt(arg.index)) if (program.k === 'path') record(program, { walk: true, consumer: token.v });
        // `spawn(process.env.PORTOS_TEST_PYTHON || 'python3', …)`, `spawn(pyBin, …)` with
        // `const pyBin = resolveTestPython()`: the program expression names python.
        let python = false;
        for (let j = arg.index; j < match[open] && !(tokens[j].t === 'p' && tokens[j].v === ','); j += 1) {
          const t = tokens[j];
          if ((t.t === 'id' && (t.v === 'PORTOS_TEST_PYTHON' || pythonNames.has(t.v) || PYTHON_NAME.test(t.v))) || (t.t === 's' && /^python3?$/.test(t.v))) python = true;
        }
        if (python) facts.tools.add('python');
        else if (value.k === 'unknown' || value.k === 'ext' || value.k === 'tail') {
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
        // An unanchored variable is a temp path or runtime data, not a repository read.
        for (const value of valuesAt(arg.index)) record(value, { consumer: token.v });
      }
      continue;
    }
    if (open !== null && token.v === 'toMatchFileSnapshot') {
      const arg = literalArg(open);
      if (arg.kind === 'literal') facts.paths.push({ rel: normalizeRel(posix.join(posix.dirname(fileRel), arg.value)), walk: false });
      else if (arg.kind === 'expr') for (const value of valuesAt(arg.index)) record(value, { consumer: token.v });
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
    const widest = widestPathExpression(tokens, match, i, ctx.guarded);
    if (widest === null) continue;
    for (const value of valuesAt(widest.index)) record(value, widest);
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
 * is controlled by the test that calls it.
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
  const exportedLiterals = new Map(); // module -> its literal exports (`literalExports`)
  const exportedPaths = new Map(); // module -> its complete path exports (`export const X = join(__dirname, ...)`)
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

  /** The sources the workspace's setup files mock for every test (`replacedSources`); asked once. */
  let setupReplaced = null;
  const replacedBySetup = () => {
    if (setupReplaced !== null) return setupReplaced;
    // Set before the walk: the setup files' own facts ask for it, and what they trust does not matter.
    setupReplaced = { fs: false, crypto: false, guard: false, modules: new Set() };
    for (const entry of WORKSPACE_SETUP_ENTRIES[workspaceRel] ?? []) {
      if (fs.kind(entry) !== 'file') continue;
      // The entry and everything it imports: `import './testMocks.js'` registers its mocks all the same.
      for (const rel of closureOf(entry, null, null, { followMockOnly: false }).members) {
        const f = factsFor(rel);
        for (const source of ['fs', 'crypto', 'guard']) setupReplaced[source] ||= f.replaces?.[source] === true;
        for (const target of f.mocked) setupReplaced.modules.add(target);
      }
    }
    return setupReplaced;
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
      handedProblems: new Set(),
      handedDirs: [], // existing directories this file gives to a tool; inputs of a real-browser test (`gather`)
      nativeUnresolved: false,
      inputs: new Set(), absent: new Set(), packages: new Map(), tools: new Set(),
      unresolvedEdges: [], unresolvedInputs: [], oversized: [], localReads: [], never: false, git: false,
      openReads: new Set(), // reads whose variable segment is not proven to stay under the prefix that was keyed
      replaces: null, trusted: null, // sources this file mocks, and sources its contained paths rely on (`replacedSources`)
      trusts: new Set(), // modules whose constants named a read: void when a member mocks one (`gather`)
      mocked: new Set(), // modules this file replaces with vi.mock / vi.doMock
    };
    facts.set(rel, resolved);
    const bytes = fs.read(rel);
    if (bytes === null) { resolved.unresolvedEdges.push('missing file'); resolved.unresolvedInputs.push('missing file'); return resolved; }
    if (!JS_EXT.test(rel)) { resolved.inputs.add(rel); return resolved; }
    const pathExports = (src, fileRel) => {
      const exported = new Map();
      let tokens;
      try { tokens = tokenize(src, new Set(), { jsx: !/\.[cm]?ts$/.test(fileRel) }); } catch { return exported; }
      const match = matchBrackets(tokens);
      const ctx = {
        fileRel, cwdRel: workspaceRel, tokens, match, bindings: collectBindings(tokens, match),
        bindingValues: new Map(), resolving: new Set(), imports: new Map(), exportedConstant: null,
        replaced: { fs: false, crypto: false, guard: false }, guarded: false, delimiter: false, uuid: false, src,
      };
      ctx.shared = { root: ctx, scopes: undefined, trusted: { fs: false, crypto: false, guard: false }, trustLog: [] };
      for (let i = 0; i + 4 < tokens.length; i += 1) {
        if (!isWord(tokens[i], 'export') || !isWord(tokens[i + 1], 'const') || tokens[i + 2]?.t !== 'id' || !isPunct(tokens[i + 3], '=')) continue;
        const { value, end } = evaluate(tokens, match, i + 4, ctx);
        if (value.k === 'path' && !value.partial && !value.unfollowed && end === expressionEnd(tokens, match, i + 4)) {
          exported.set(tokens[i + 2].v, value);
        }
      }
      return exported;
    };
    const exportedConstant = (spec, name) => {
      const target = resolveRelativeSpecifier(rel, spec, fs.kind);
      if (target === null || !JS_EXT.test(target)) return null;
      if (!exportedLiterals.has(target)) exportedLiterals.set(target, literalExports(fs.read(target)?.toString('utf8') ?? '', target));
      const lit = exportedLiterals.get(target).get(name);
      if (lit !== undefined) return lit;
      if (!exportedPaths.has(target)) exportedPaths.set(target, pathExports(fs.read(target)?.toString('utf8') ?? '', target));
      return exportedPaths.get(target).get(name) ?? null;
    };
    const raw = extractFileFacts(bytes.toString('utf8'), { fileRel: rel, cwdRel: workspaceRel, replaced: replacedBySetup(), exportedConstant });
    for (const spec of raw.trusts) {
      const target = resolveRelativeSpecifier(rel, spec, fs.kind);
      if (target !== null) resolved.trusts.add(target);
    }
    resolved.replaces = raw.replaces ?? null;
    resolved.trusted = raw.trusted ?? null;
    resolved.never = raw.never;
    resolved.git = raw.git;
    resolved.nativeUnresolved = raw.nativeUnresolved;
    resolved.handedProblems = raw.handedProblems;
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
    const addDir = (dirRel, walk, guessed = false, open = false, via = null, filter = null) => {
      // An open read may land outside the prefix. `gather` carries that fact into keying and selection.
      if (open) resolved.openReads.add(openReadReason(dirRel, via));
      if (localState(dirRel)) { resolved.localReads.push(dirRel); return; }
      if (ignoredInput(dirRel)) return;
      if (underGit(dirRel)) { resolved.unresolvedInputs.push('reads repository state under .git'); return; }
      const kind = fs.kind(dirRel);
      // `join(HERE, 'LICENSE')`: a name with no extension reads as a directory until the tree says otherwise.
      if (kind === 'file' && !guessed) addFile(dirRel, { data: !walk });
      if (kind !== 'dir') return;
      const files = tree(dirRel) ?? (filter !== null ? listedTree(dirRel) : null);
      // Past the limit: a tree only read as data may still be keyed, decided once this file's edges are
      // all known. Not a guessed one: the variable segment may leave the prefix (`join(HERE, p)` called
      // with '../../client/x.js'), and under the limit that guess was only ever an approximation.
      if (files === null) { if (walk || guessed) resolved.oversized.push(dirRel || '<repo root>'); else oversizedData.push(dirRel); return; }
      for (const file of files) {
        if (filter !== null && !filter(posix.basename(file))) continue;
        addFile(file, { data: !walk });
      }
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
    resolved.mocked = registered;
    for (const target of eager) resolved.lazyModules.delete(target);
    for (const { rel: target, walk, read } of raw.paths) addPath(target, walk, read);
    for (const { rel: dirRel, walk, guessed, open, via, filter } of raw.dirs) addDir(dirRel, walk, guessed === true, open === true, via ?? null, filter ?? null);
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
    const replacedBy = { fs: null, crypto: null, guard: null }; // the first member that mocks each trusted source
    const trusting = []; // members whose contained paths rely on one
    const namedTrusts = [];
    const mocked = new Set(replacedBySetup().modules);
    let hasOpenReads = false;
    let never = false;
    let git = false;
    while (stack.length) {
      const { rel, walkEdges } = stack.pop();
      if (members.has(rel) || stop?.has(rel)) continue;
      members.add(rel);
      const f = factsFor(rel);
      if (walkEdges) for (const dep of f.modules) if (!members.has(dep) && (followMockOnly || !f.mockOnly.has(dep))) stack.push({ rel: dep, walkEdges: true });
      for (const side of f.sideModules) {
        if (f.dataModules.has(side) && f.unresolvedEdges.length === 0) inputs.add(side);
        else if (!members.has(side)) stack.push({ rel: side, walkEdges: true });
      }
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
      // test that does is a tree scanner, which carries the guard suffix and is
      // never memoized (`server/test/guards/repo/repo-scan-guards.test.js` enforces the name).
      // A data-read tree the repository listing can enumerate is keyed instead
      // (`dataTree`), under the same membership rule.
      const ownsTrees = testRel === null || gitRuleApplies(rel, testRel);
      for (const dir of f.oversized) if (ownsTrees) unresolvedInputs.push(`${rel}: directory input too large: ${dir}`);
      // A variable path segment nothing bounds can name any file, so the prefix that was keyed is a
      // guess, whichever member reads it: a library module's read lands wherever its caller or its
      // own data says, which no key line follows (#16660). Unlike the two rules above, no caller
      // proves it: such a module resolves the name, or joins it with `pathWithin()`.
      if (f.openReads.size > 0) hasOpenReads = true;
      for (const reason of f.openReads) unresolvedInputs.push(`${rel}: ${reason}`);
      // A library's explicit guard is part of the read proof. Keep the existing scope for
      // directory-listing and UUID inference, including recorded dynamic imports.
      if (f.trusted) {
        const { fs, crypto, guard } = f.trusted;
        if (guard || (ownsTrees && (fs || crypto))) trusting.push({ rel, trusted: { fs: ownsTrees && fs, crypto: ownsTrees && crypto, guard } });
      }
      if (f.trusts.size) namedTrusts.push(rel);
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
    // A mock registered by any member (a helper the test imports) replaces the module for the test too:
    // what a listing, a generated id or the guard returns is then that member's to decide.
    // Only a member that runs registers one: a test file another member lists or reads as text does not.
    const running = [...roots].map((rel) => ({ rel, walkEdges: walk }));
    const ran = new Set();
    while ((trusting.length || namedTrusts.length) && running.length) {
      const { rel, walkEdges } = running.pop();
      if (ran.has(rel) || stop?.has(rel)) continue;
      ran.add(rel);
      const f = factsFor(rel);
      for (const target of f.mocked) mocked.add(target);
      if (f.replaces) for (const source of Object.keys(replacedBy)) if (f.replaces[source]) replacedBy[source] ??= rel;
      if (walkEdges) for (const dep of f.modules) running.push({ rel: dep, walkEdges: true });
      for (const side of f.sideModules) if (!f.dataModules.has(side)) running.push({ rel: side, walkEdges: true });
    }
    const SOURCE_NAMES = { fs: 'a directory listing', crypto: 'randomUUID()', guard: 'pathWithin()' };
    for (const { rel, trusted } of trusting) {
      for (const source of Object.keys(replacedBy)) {
        if (trusted[source] && replacedBy[source] !== null && replacedBy[source] !== rel) unresolvedInputs.push(`${rel}: relies on ${SOURCE_NAMES[source]}, which ${replacedBy[source]} mocks`);
      }
    }
    // A mock can change the imported constant that named a read.
    for (const rel of namedTrusts) {
      for (const target of factsFor(rel).trusts) if (mocked.has(target)) unresolvedInputs.push(`${rel}: names a path through ${target}, which the test mocks`);
    }
    // A real-browser test renders what a dev server, bundler or static server
    // reads for it, none of which the module runner records. Every directory
    // the test file hands to such a tool is therefore an input, whole. Every
    // other test keeps the older reading (a directory passed along is a value).
    if (testRel !== null && members.has(testRel) && reachesChrome(roots, walk)) {
      const own = factsFor(testRel);
      for (const problem of own.handedProblems) unresolvedInputs.push(`${testRel}: ${problem}`);
      for (const dir of own.handedDirs) {
        const problem = addHandedDir(dir, own, { inputs, absent, dataPackages, trees });
        if (problem) unresolvedInputs.push(`${testRel}: ${problem}`);
      }
    }
    for (const [name, version] of dataPackages) if (!packageVersions.has(name)) packageVersions.set(name, version);
    return { members, inputs, absent, packages: packageVersions, tools, trees, unresolvedEdges, unresolvedInputs, hasOpenReads, never, git };
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
    else if (isGuardTest(testRel)) reasons.push(GUARD_SUFFIX_REASON);
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
   * @returns {{ floor: Verdict, recorded: Verdict|null, closure: Set<string>, inputs: Set<string>, edgesResolved: boolean, hasOpenReads: boolean, narrowed: object|null }}
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
    return {
      floor,
      recorded: recordedVerdict,
      closure: closure.members,
      inputs: closure.inputs,
      edgesResolved: closure.unresolvedEdges.length === 0,
      hasOpenReads: closure.hasOpenReads,
      narrowed,
    };
  };

  return { analyzeTest, closureOf, fileHash, moduleDigest, workspaceBase, factsFor };
}

/**
 * Keys for `testFiles` (repo-relative posix paths) in one workspace.
 * `records` maps a test to the module list its last green run loaded.
 * `digests` maps a test to that record's per-module digests (a v2 record),
 * which lets related selection narrow it.
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
 * closure has unresolved edges or unbounded reads (it may reach anything).
 */
export function relatedTests(keys, sources) {
  const changed = new Set(sources);
  const reaches = (set) => [...set].some((rel) => changed.has(rel));
  return [...keys.entries()]
    .filter(([, info]) => (info.narrowed
      ? info.narrowed.failClosed !== null || reaches(info.narrowed.reach)
      : !info.edgesResolved || info.hasOpenReads || reaches(info.closure) || reaches(info.inputs)))
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
