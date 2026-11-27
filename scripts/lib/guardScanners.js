/**
 * Tree guards: tests that assert over the tracked tree (#5055, #6363, #8723).
 * CI's impact selection follows imports and named basenames; a scanner reads
 * files it never imports, so only an always-run registration can reach it.
 *
 * The registration is the filename (#16553): the planner selects every
 * `*.guard.test.js` by suffix and reads no test source. Almost every check is
 * not a test file of its own but a module in a runner's guard directory
 * (GUARD_CHECK_DIRS, #16996), which that runner loads into one worker over one
 * shared corpus (guardCorpus.js); the directory is its registration. The content
 * detectors below no longer select anything. They are a one-way check
 * (server/test/guards/repo/repo-scan-guards.test.js): a test they recognise as a
 * scanner must carry the suffix or live in a guard directory, so a new scanner
 * cannot ride no plan unnoticed.
 * Builtins only: ci-test-plan.js imports this before `npm ci` runs.
 */
import { appendFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize } from './sourceTokens.js';
import { trackedFiles } from './trackedFiles.js';

/**
 * The filename suffix that marks a test as a tree guard (#16553). The name is
 * the registration: the planner runs every server-side `*.guard.test.js` on
 * every plan and every client one on any client source change, and the test
 * memo never skips one.
 */
const GUARD_TEST_RE = /\.guard\.test\.jsx?$/;
export const isGuardTest = (relPath) => GUARD_TEST_RE.test(relPath);

/**
 * The structural guard runners and the directory each loads its checks from
 * (#16996). A check is a `*.test.js` module in one of those directories; the
 * Vitest configs exclude them, so a check runs only inside its runner, in one
 * worker over one shared corpus (guardCorpus.js). The server checks are split by
 * subject into three runners of similar cost, so they fill the pool's workers in
 * parallel (three locally under the agent budget, four on hosted CI); the client
 * pool has two workers and two runners. A new check goes in the directory whose
 * subject it scans, and its placement is its registration.
 */
export const GUARD_CHECK_DIRS = Object.freeze([
  // Conventions over runtime source: rejection ownership, logging, spawning, timers, parameters,
  // environment reads, data directories and send authority.
  { dir: 'server/test/guards/runtime', runner: 'server/test/guards/runtime.guard.test.js' },
  // Module structure and contracts: import boundaries and cycles, single-owner tables, inventories, mock factories.
  { dir: 'server/test/guards/modules', runner: 'server/test/guards/modules.guard.test.js' },
  // Repository text and test-suite hygiene: docs, scripts, CI, migrations, instruction files, test conventions.
  { dir: 'server/test/guards/repo', runner: 'server/test/guards/repo.guard.test.js' },
  // Accessibility conventions over client markup, touch input included.
  { dir: 'client/src/test/guards/a11y', runner: 'client/src/test/guards/a11y.guard.test.js' },
  // Client UI conventions: layout and styling, effects and data fetching, module contracts, test timeouts.
  { dir: 'client/src/test/guards/ui', runner: 'client/src/test/guards/ui.guard.test.js' },
].map(Object.freeze));

const checkDirOf = (relPath) => GUARD_CHECK_DIRS.find(({ dir }) => relPath.startsWith(`${dir}/`)
  && /^[^/]+\.test\.jsx?$/.test(relPath.slice(dir.length + 1)));
/** A repo-relative path names a check module a guard runner loads. */
export const isGuardCheck = (relPath) => checkDirOf(relPath) !== undefined;
/** The runner (repo-relative) that loads the check module at `relPath`, or null for any other path. */
export const guardRunnerFor = (relPath) => checkDirOf(relPath)?.runner ?? null;
/** The check module filenames in a guard directory (an absolute path or file URL), sorted: what its runner loads. */
export const guardCheckModules = (dir) => readdirSync(dir).filter((name) => /\.test\.jsx?$/.test(name)).sort();

/**
 * Register every check in `dir` (a file URL) with the calling runner's Vitest
 * `describe`/`it` and its `load(name)` import (all passed in: this module stays
 * builtins-only, and the runner owns the computed `import()` that moduleGraph.js
 * bounds to its directory). Each check is a describe named after its module, so a
 * failure reads `<runner> > <check> > …` and `-t <check>` runs one check. A check
 * that throws while loading fails as its own `loads` test, so one broken module
 * cannot hide the others' results.
 *
 * Loading a check runs its imports and module-scope work, which no test duration
 * covers. When `PORTOS_GUARD_LOAD_LOG` names a file (scripts/run-ci-tests.js sets
 * it), each load appends `{ runner, check, ms }` there, so the guard budget charges
 * that time to the check (guardBudget.js).
 */
export function registerGuardChecks(dir, { describe, it, load, env = process.env }) {
  const runner = runnerOfDir(fileURLToPath(dir));
  for (const name of guardCheckModules(dir)) {
    const check = name.replace(/\.test\.jsx?$/, '');
    describe(check, async () => {
      const started = performance.now();
      try {
        await load(name);
      } catch (error) {
        it('loads', () => { throw error; });
      }
      if (env.PORTOS_GUARD_LOAD_LOG && runner) {
        appendFileSync(env.PORTOS_GUARD_LOAD_LOG, `${JSON.stringify({ runner, check, ms: performance.now() - started })}\n`);
      }
    });
  }
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The runner (repo-relative) whose check directory is `absDir`, or null. */
const runnerOfDir = (absDir) => {
  const rel = relative(REPO_ROOT, absDir).split(sep).join('/').replace(/\/$/, '');
  return GUARD_CHECK_DIRS.find(({ dir }) => dir === rel)?.runner ?? null;
};

/** Tracked guard tests (relative paths), by suffix alone: no source is read. */
export const guardTestFiles = (repoRoot) => trackedFiles(repoRoot, ['*.guard.test.js', '*.guard.test.jsx']).sort();

/** A `git` invocation through any child_process spawner that takes the program first… */
const GIT_CALL = /\b(?:execFileSync|execFile|spawnSync|spawn)\(\s*['"]git['"]/;
/** …carrying a tree-enumerating subcommand. */
const GIT_ENUMERATION = /['"](?:ls-files|grep)['"]/;
/**
 * The client's shared enumerator, which shells out to `git ls-files` for them.
 * The `test/` segment is optional because a guard living INSIDE client/src/test/
 * imports it as './trackedFiles.js' — a scanner the narrower pattern missed
 * entirely, so it registered as a non-scanner and this whole file passed on it.
 */
const TRACKED_HELPER = /from\s+['"](?:[^'"]*\/)?(?:trackedFiles|guardCorpus)\.js['"]/;

/**
 * A recursive directory walk (#8723): a call to one of the shared source
 * walkers in server/lib/testHelper.js, or a `readdirSync(…, { recursive: true })`.
 * Matched against comment-stripped source so a comment describing a walk
 * does not register one.
 */
const SHARED_WALKER_CALL = /\bcollect(?:Server|Client)Sources\s*\(|\bread(?:Server|Client)Source\s*\(\s*[^'"`)\s]/;
const RECURSIVE_READDIR = /readdirSync\s*\([^)]*\brecursive\s*:\s*true/;
const stripLineComments = (source) => source.replace(/^\s*(?:\/\/|\*|\/\*).*$/gm, '');

/**
 * Blank string literals that read as embedded code (they contain whitespace or a
 * call paren): a test's fixture snippet such as "execFileSync('git', ['ls-files'])"
 * is data under test, not a scan. Bare tokens ('git', 'ls-files', an import
 * specifier) stay visible because the detectors above match on them.
 */
const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const blankLiterals = (source) => source.replace(STRING_LITERAL, (lit) => (/[\s(]/.test(lit.slice(1, -1)) ? '""' : lit));

const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);
const isPunct = (token, value) => token?.t === 'p' && token.v === value;
/** Template holes hold code too: a walker called from `${…}` is still a call. */
const flattenTokens = (tokens, out = []) => {
  for (const token of tokens) {
    if (token.t === 'tpl') for (const hole of token.exprs) flattenTokens(hole, out);
    else out.push(token);
  }
  return out;
};
/** Index of the bracket closing the opener at `open`. */
const closerOf = (tokens, open) => {
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (tokens[i].t !== 'p') continue;
    if (OPENERS.has(tokens[i].v)) depth += 1;
    else if (CLOSERS.has(tokens[i].v) && --depth === 0) return i;
  }
  return tokens.length - 1;
};
/** End of a braceless arrow body: the first `;` or `,` at depth zero, or the enclosing closer. */
const expressionEnd = (tokens, start) => {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    if (tokens[i].t !== 'p') continue;
    if (OPENERS.has(tokens[i].v)) depth += 1;
    else if (CLOSERS.has(tokens[i].v)) { if (depth === 0) return i; depth -= 1; }
    else if (depth === 0 && (tokens[i].v === ';' || tokens[i].v === ',')) return i;
  }
  return tokens.length;
};
/** `{ name, from, to }` body token spans of every function bound to a name: a declaration, or a function/arrow assigned to an identifier. */
const namedFunctionBodies = (tokens) => {
  const bodies = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].t !== 'id') continue;
    if (tokens[i].v === 'function' && tokens[i + 1]?.t === 'id' && isPunct(tokens[i + 2], '(')) {
      const params = closerOf(tokens, i + 2);
      if (isPunct(tokens[params + 1], '{')) bodies.push({ name: tokens[i + 1].v, from: params + 1, to: closerOf(tokens, params + 1) });
      continue;
    }
    if (!isPunct(tokens[i + 1], '=') || isPunct(tokens[i + 2], '=')) continue;
    let j = i + 2;
    if (tokens[j]?.t === 'id' && tokens[j].v === 'async') j += 1;
    if (tokens[j]?.t === 'id' && tokens[j].v === 'function') {
      while (j < tokens.length && !isPunct(tokens[j], '(')) j += 1;
      const params = closerOf(tokens, j);
      if (isPunct(tokens[params + 1], '{')) bodies.push({ name: tokens[i].v, from: params + 1, to: closerOf(tokens, params + 1) });
      continue;
    }
    let arrow = -1;
    if (isPunct(tokens[j], '(')) {
      const params = closerOf(tokens, j);
      if (isPunct(tokens[params + 1], '=>')) arrow = params + 1;
    } else if (tokens[j]?.t === 'id' && isPunct(tokens[j + 1], '=>')) arrow = j + 1;
    if (arrow < 0) continue;
    bodies.push({
      name: tokens[i].v,
      from: arrow + 1,
      to: isPunct(tokens[arrow + 1], '{') ? closerOf(tokens, arrow + 1) : expressionEnd(tokens, arrow + 1),
    });
  }
  return bodies;
};

const READDIR_CALL = /\breaddir(?:Sync)?\b/;
const READDIR_NAMES = new Set(['readdirSync', 'readdir']);

/**
 * A hand-rolled directory walker (#16553): a named function that lists a
 * directory and calls itself. The regex detectors above see only the shared
 * walkers and `{ recursive: true }`, so a test that wrote its own `walk(dir)`
 * scanned the tree unseen. Token-based, so a walker quoted in a string or a
 * comment does not count. A source the tokenizer rejects counts as a walker
 * when it lists a directory at all: the check fails closed.
 */
export const hasRecursiveDirectoryWalk = (source) => {
  if (!READDIR_CALL.test(source)) return false;
  let tokens;
  try {
    tokens = flattenTokens(tokenize(source));
  } catch {
    return true;
  }
  return namedFunctionBodies(tokens).some(({ name, from, to }) => {
    let lists = false;
    let recurses = false;
    for (let i = from; i <= to && i < tokens.length; i += 1) {
      if (tokens[i].t !== 'id') continue;
      if (READDIR_NAMES.has(tokens[i].v)) lists = true;
      else if (tokens[i].v === name && isPunct(tokens[i + 1], '(') && !isPunct(tokens[i - 1], '.')) recurses = true;
    }
    return lists && recurses;
  });
};

const SHELL_EXEC_CALL = /\bexec(?:Sync)?\s*\(/;
const SHELL_EXEC_NAMES = new Set(['execSync', 'exec']);
const SHELL_GIT_ENUMERATION = /^\s*git\s+(?:-C\s+\S+\s+)?(?:ls-files|grep)\b/;

/**
 * `execSync('git ls-files …')`: the enumeration written as one shell string
 * (#16553). The regex detectors blank a literal holding whitespace, so this
 * reads the call's first argument as a token; a command quoted inside a
 * fixture string is one string token and never reaches here as a call.
 */
export const shellsOutToGitEnumeration = (source) => {
  if (!SHELL_EXEC_CALL.test(source)) return false;
  let tokens;
  try {
    tokens = tokenize(source);
  } catch {
    return /\bgit\s+(?:ls-files|grep)\b/.test(source);
  }
  const commandText = (token) => (token?.t === 's' ? token.v : token?.t === 'tpl' ? token.quasis[0] : '');
  const inList = (list) => list.some((token, i) => (token.t === 'tpl' && token.exprs.some(inList))
    || (token.t === 'id' && SHELL_EXEC_NAMES.has(token.v) && isPunct(list[i + 1], '(')
      && SHELL_GIT_ENUMERATION.test(commandText(list[i + 2]))));
  return inList(tokens);
};

/** True when `source` asserts over the tracked tree instead of over its imports. */
export const scansTrackedTree = (source) => {
  // Normalization only removes text and blanks literals, so these markers must already be present.
  if (/(?:git|trackedFiles|guardCorpus|(?:collect|read)(?:Server|Client)Source|readdirSync)/.test(source)) {
    const code = blankLiterals(stripLineComments(source));
    if ((GIT_CALL.test(code) && GIT_ENUMERATION.test(code)) || TRACKED_HELPER.test(code)
      || SHARED_WALKER_CALL.test(code) || RECURSIVE_READDIR.test(code)) return true;
  }
  return hasRecursiveDirectoryWalk(source) || shellsOutToGitEnumeration(source);
};

/** Which runner owns `relPath` (a `git ls-files`-relative path): 'client' or 'server'. */
const ownerRootFor = (relPath) => (relPath.startsWith('client/src/') ? 'client' : 'server');

/** The directory prefix, as a regex fragment, of the *other* runner's tree. */
const OPPOSITE_ROOT_PREFIX = {
  server: 'client\\/src\\/',
  client: '(?:server|scripts|autofixer)\\/',
};

/** A quoted/backtick string literal containing a cross-root directory reference. */
const crossRootLiteral = (ownRoot) => new RegExp(`(['"\`])(?:\\.\\.\\/)*${OPPOSITE_ROOT_PREFIX[ownRoot]}[^'"\`]*\\1`);
/** Same, but the literal also names a file (ends in an extension) before the closing quote. */
const crossRootNamedFile = (ownRoot) => new RegExp(
  `(['"\`])(?:\\.\\.\\/)*${OPPOSITE_ROOT_PREFIX[ownRoot]}[^'"\`]*\\.[A-Za-z0-9]+\\1`,
);

/**
 * True when `source` (the test at `relPath`) reads a file from the *other* runner's tree with `readFileSync` but never spells that file's name out as a single literal, the shape `pathContractTests` (ci-test-plan.js, #6363) can't reach by `git grep`-ing for a basename never written down. A test that names the target directly (`join(here, '../../client/src/lib/x.js')`: one literal with both the cross-root prefix and the extension) passes, since that literal is what the basename lookup matches.
 */
export const readsUnnamedCrossRootFile = (source, relPath) => {
  if (!/readFileSync\s*\(/.test(source)) return false;
  const ownRoot = ownerRootFor(relPath);
  return crossRootLiteral(ownRoot).test(source) && !crossRootNamedFile(ownRoot).test(source);
};


/** True when the test at `relPath` scans the tree or reads an unnamed cross-root file. */
export const isTreeScanner = (source, relPath) => scansTrackedTree(source) || readsUnnamedCrossRootFile(source, relPath);

/**
 * The one-way check: paths in `sources` (`{ path: source }`) the detectors
 * recognise as scanners that neither carry the guard suffix, nor live in a
 * guard directory, nor appear in `exempt`. A scanner named here is selected by nothing.
 */
export const findUnsuffixedScanners = (sources, exempt = new Set()) => Object.keys(sources)
  .filter((path) => !isGuardTest(path) && !isGuardCheck(path) && !exempt.has(path) && isTreeScanner(sources[path], path))
  .sort();
