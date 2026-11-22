/**
 * Test memo configuration tables and the callee/keyword sets the analyzer
 * reads source with. Data only: no imports, so every other testMemo module
 * can depend on it without a cycle.
 */

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

export const JS_EXT = /\.(?:[cm]?js|jsx|tsx?)$/;
export const RESOLVE_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json'];
export const RESOLVE_INDEXES = ['/index.js', '/index.jsx', '/index.ts', '/index.tsx'];

/** Never repository inputs: installs, caches, build output, machine-local state. */
export const SKIP_TREE_DIRS = new Set(['node_modules', '.git', '.cache', 'coverage', 'dist', '.vite', '__pycache__']);
export const IGNORED_INPUT_PREFIXES = ['data/', '.cache/', 'coverage/', 'dist/', 'client/dist/', 'server/.cache/', 'client/.cache/'];

export const PATH_JOIN = new Set(['join', 'resolve']);
export const PATH_DIRNAME = new Set(['dirname']);
export const PATH_IDENTITY = new Set(['fileURLToPath', 'pathToFileURL', 'String', 'normalize', 'toNamespacedPath']);
/** Consumers of a path that never read it: string/path arithmetic and assertions. */
export const NON_READ_CALLEES = new Set([
  'relative', 'basename', 'extname', 'isAbsolute', 'startsWith', 'endsWith', 'includes', 'replace', 'replaceAll',
  'split', 'slice', 'indexOf', 'lastIndexOf', 'trim', 'toLowerCase', 'toUpperCase', 'localeCompare', 'expect',
  'toBe', 'toEqual', 'toStrictEqual', 'toContain', 'toMatch', 'toHaveBeenCalledWith', 'toMatchObject', 'log',
  'error', 'warn', 'info', 'debug', 'stringify', 'encodeURIComponent', 'escapeRegExp', 'RegExp', 'toModuleKey',
  'push', 'add', 'set', 'has', 'get', 'map', 'filter', 'some', 'every', 'test', 'match', 'exec', 'isDirectlyInvoked',
  'describe', 'it', 'Error', 'TypeError', 'diagnosticTestFile', 'concat', 'from', 'padEnd', 'padStart', 'repeat', 'createRequire',
  'mkdirSync', 'mkdir', 'writeFileSync', 'writeFile', 'rmSync', 'rm', 'unlinkSync', 'renameSync', 'rename',
]);
/** `readServerSource(rel)` / `readClientSource(rel)` (server/lib/testHelper.js): the workspace directory `rel` is relative to. */
export const SOURCE_READERS = Object.freeze({ readServerSource: 'server', readClientSource: 'client/src' });
/**
 * Helpers whose every call is keyed or refused at the call site by name
 * (`SOURCE_READERS`): a literal names the file, anything else fails closed.
 * Their own read of the variable path is therefore no input of the module
 * that defines them, which every suite importing it would otherwise share.
 */
export const CALL_SITE_CHECKED_READERS = Object.freeze({ 'server/lib/testHelper.js': Object.keys(SOURCE_READERS) });
/** `exec`/`spawn`-style sinks whose first argument names a program. */
export const SPAWN_CALLEES = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork',
  'bufferedSpawn', 'bufferedSpawnOrThrow', 'prepareCliSpawn', 'execa']);
/** Filesystem sinks whose first argument names what is read. */
export const READ_CALLEES = new Set(['readFileSync', 'readFile', 'readdirSync', 'readdir', 'existsSync', 'statSync',
  'lstatSync', 'stat', 'lstat', 'accessSync', 'access', 'createReadStream', 'opendirSync', 'opendir', 'realpathSync',
  'copyFileSync', 'copyFile', 'cpSync', 'cp', 'readJson', 'readJsonSync', 'globSync', 'glob']);
export const DIR_READ_CALLEES = /^(?:readdir|opendir|glob)/;
export const MOCK_CALLEES = new Set(['mock', 'doMock', 'importActual', 'importMock', 'unmock', 'doUnmock']);
/** Mock calls that only register a factory for a path; the rest load the module. */
export const MOCK_REGISTER_CALLEES = new Set(['mock', 'doMock', 'unmock', 'doUnmock']);
export const PATH_LIKE_LITERAL = /^(?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+\.[a-z0-9]{1,8}$/i;
export const GIT_SPAWN = /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|exec|bufferedSpawn|bufferedSpawnOrThrow)\s*\(\s*(?:'git'|`git\s)/;
export const GIT_PACKAGE = /^(?:simple-git|isomorphic-git|nodegit)$/;

/**
 * The repository modules whose `pathWithin(dir, ...segments)` joins like
 * `path.join()` and throws when the result is outside `dir`: the shared
 * implementation and the `scripts/` re-export of it.
 */
export const PATH_WITHIN_MODULES = new Set(['lib/pathWithin.js', 'scripts/lib/pathWithin.js']);

/** Array methods that call their first argument with each element. */
export const ELEMENT_CALLBACKS = new Set(['map', 'forEach', 'filter', 'flatMap', 'some', 'every', 'find', 'findLast', 'findIndex', 'findLastIndex']);
/** Array methods whose result holds only elements of the receiver. */
export const ELEMENT_PRESERVING = new Set(['filter', 'sort', 'slice', 'reverse', 'toSorted', 'toReversed']);
/** Array methods that hand their callback the array itself, as the argument after the index. */
export const ARRAY_ITERATORS = new Set([...ELEMENT_CALLBACKS, 'reduce', 'reduceRight']);
/**
 * What may be done to a `const` array whose elements are taken as known:
 * these neither add an element nor return the array itself, which
 * `names.sort().push(x)` would then write through.
 */
export const ARRAY_READS = new Set([...ARRAY_ITERATORS, 'length', 'includes', 'indexOf', 'lastIndexOf', 'join', 'slice', 'at', 'concat',
  'entries', 'keys', 'values', 'toString', 'flat', 'toSorted', 'toReversed', 'toSpliced', 'with']);
/** Matchers that compare against an array handed to them. */
export const ARRAY_MATCHERS = new Set(['toEqual', 'toStrictEqual', 'toContain', 'arrayContaining']);
/** Matchers that only compare what `expect()` was handed: `toSatisfy(cb)` and a custom matcher are handed the array itself. */
export const COMPARING_MATCHERS = new Set(['toEqual', 'toStrictEqual', 'toContain', 'toContainEqual', 'toHaveLength', 'toBe', 'toMatchObject', 'toBeDefined', 'toBeInstanceOf', 'toMatchSnapshot', 'toMatchInlineSnapshot']);
export const READDIR_CALLEES = new Set(['readdirSync', 'readdir']);
export const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);
export const BLOCK_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'with']);
/** Keywords an operand follows, so the token after one continues the expression. */
export const OPERAND_KEYWORDS = new Set(['await', 'typeof', 'new', 'yield', 'void', 'delete', 'async', 'return', 'throw', 'case', 'else', 'do', 'in', 'of', 'instanceof', 'function', 'class', 'extends']);
/** Keywords a parenthesized operand follows: `delete (x[0])`. After any other name, `(` opens a call, a head or a parameter list. */
export const BEFORE_GROUPING = new Set(['await', 'typeof', 'yield', 'void', 'delete', 'return', 'throw', 'case', 'else', 'do', 'in', 'of', 'instanceof']);

/** Keywords after which `function` starts an expression, or an exported declaration other modules can call. */
export const BEFORE_FUNCTION_EXPRESSION = new Set([...OPERAND_KEYWORDS, 'export', 'default']);

/** How many combinations of variable values one path expression is evaluated for before it counts as unbounded. */
export const VARIABLE_VALUES_LIMIT = 64;
