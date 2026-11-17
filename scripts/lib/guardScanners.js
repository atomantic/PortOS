/**
 * Detectors for tests that assert over the tracked tree (#5055, #6363, #8723).
 * CI's impact selection follows imports and named basenames; a scanner reads
 * files it never imports, so only an always-run registration can reach it.
 * The planner derives that set from these detectors instead of a hand list.
 * Builtins only: ci-test-plan.js imports this before `npm ci` runs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenize } from './sourceTokens.js';
import { trackedFiles } from './trackedFiles.js';

/** A `git` invocation… */
const GIT_CALL = /execFileSync\(\s*['"]git['"]/;
/** …carrying a tree-enumerating subcommand. */
const GIT_ENUMERATION = /['"](?:ls-files|grep)['"]/;
/**
 * The client's shared enumerator, which shells out to `git ls-files` for them.
 * The `test/` segment is optional because a guard living INSIDE client/src/test/
 * imports it as './trackedFiles.js' — a scanner the narrower pattern missed
 * entirely, so it registered as a non-scanner and this whole file passed on it.
 */
const TRACKED_HELPER = /from\s+['"](?:[^'"]*\/)?trackedFiles\.js['"]/;

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

/** True when `source` asserts over the tracked tree instead of over its imports. */
export const scansTrackedTree = (source) => {
  const code = blankLiterals(stripLineComments(source));
  return (GIT_CALL.test(code) && GIT_ENUMERATION.test(code)) || TRACKED_HELPER.test(code)
    || SHARED_WALKER_CALL.test(code) || RECURSIVE_READDIR.test(code);
};

/** Which runner owns `relPath` (a `git ls-files`-relative path): 'client' or 'server'. */
export const ownerRootFor = (relPath) => (relPath.startsWith('client/src/') ? 'client' : 'server');

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


/** Tracked test files (relative paths) that scan the tree or read an unnamed cross-root file. */
export const detectTreeGuards = (repoRoot) => {
  const found = [];
  for (const rel of trackedFiles(repoRoot, ['*.test.js', '*.test.jsx'])) {
    const source = readFileSync(join(repoRoot, rel), 'utf8');
    if (scansTrackedTree(source) || readsUnnamedCrossRootFile(source, rel)) found.push(rel);
  }
  return found.sort();
};
