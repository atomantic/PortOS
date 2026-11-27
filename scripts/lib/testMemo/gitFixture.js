/**
 * Checks a reviewed Git fixture declaration at its direct spawn calls and detects undeclared indirect Git spawns.
 */

import { posix } from 'node:path';
import { BLOCK_KEYWORDS, GIT_FIXTURE_MARKER, PATH_JOIN, SPAWN_CALLEES } from './constants.js';
import { evaluate } from './evaluator.js';
import { scopesOf } from './scopes.js';
import { expressionEnd, groupsAt, isPunct, isWord, listRanges, matchBrackets, tokenArrays } from './tokens.js';

const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/** Names followed by `(…) {` that head a statement, not a method. */
const STATEMENT_HEADS = new Set([...BLOCK_KEYWORDS, 'catch', 'function', 'await']);

/**
 * True when the marker line is a comment. Comments leave no token, so marker
 * text a token kept is a string, a template or a regex (a test that embeds
 * fixture source), and JSX prose is not tokenized at all.
 */
function declaredInComment(src, arrays) {
  if (!GIT_FIXTURE_MARKER.test(src)) return false;
  return !arrays.some(({ arr }) => arr.some((token) => token.t === 'jsx'
    || ((token.t === 's' || token.t === 're') && GIT_FIXTURE_MARKER.test(token.v))
    || (token.t === 'tpl' && token.quasis.some((quasi) => GIT_FIXTURE_MARKER.test(quasi)))));
}

/**
 * The names a file gives a spawn callee besides its own: `const run =
 * execFileSync`, `promisify(execFile)`, `childProcess.spawnSync` bound to a
 * name, and a renaming import or destructuring (`execFileSync as run`,
 * `{ execFileSync: run }`). A call of one starts whatever program it is
 * handed, as a call of the callee does.
 */
function spawnAliases(arrays) {
  const aliases = new Set();
  const spawner = (token) => token?.t === 'id' && (SPAWN_CALLEES.has(token.v) || aliases.has(token.v));
  // Twice: an alias of an alias is found whichever is written first.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const { arr } of arrays) {
      for (let i = 0; i + 2 < arr.length; i += 1) {
        if (arr[i].t !== 'id') continue;
        if (spawner(arr[i]) && (isWord(arr[i + 1], 'as') || isPunct(arr[i + 1], ':')) && arr[i + 2].t === 'id' && isPunct(arr[i + 3], ',', '}')) aliases.add(arr[i + 2].v);
        if (!isPunct(arr[i + 1], '=') || isPunct(arr[i + 2], '=')) continue;
        let at = i + 2;
        if (arr[at]?.t === 'id' && isPunct(arr[at + 1], '.') && arr[at + 2]?.t === 'id') at += 2; // util.promisify, childProcess.spawnSync
        const wrapped = isWord(arr[at], 'promisify') && isPunct(arr[at + 1], '(');
        let callee = wrapped ? at + 2 : at;
        if (wrapped && arr[callee]?.t === 'id' && isPunct(arr[callee + 1], '.') && arr[callee + 2]?.t === 'id') callee += 2;
        if (spawner(arr[callee]) && !isPunct(arr[callee + 1], '(', '.', '?.')) aliases.add(arr[i].v);
      }
    }
  }
  return aliases;
}

const isGitProgram = (text) => text === 'git' || (text.includes('git') && posix.basename(text.trim().split(/\s+/)[0]) === 'git');

/**
 * Check for a Git program in the expression and the values assigned to its
 * names. For an ordinary runner parameter, check the callers' arguments too.
 */
function spellsGit(w, arr, m, from, to, seen) {
  for (let i = from; i < to; i += 1) {
    const token = arr[i];
    if (token.t === 's' && isGitProgram(token.v)) return true;
    if (token.t === 'tpl' && (isGitProgram(token.quasis[0])
      || token.exprs.some((inner) => spellsGit(w, inner, matchBrackets(inner), 0, inner.length, seen)))) return true;
    if (token.t !== 'id' || isPunct(arr[i - 1], '.', '?.') || isPunct(arr[i + 1], '(')) continue;
    if (!seen.has(token.v)) {
      seen.add(token.v);
      for (const { arr: assigned, m: brackets, at } of assignmentsOf(w, token.v)) {
        if (spellsGit(w, assigned, brackets, at, expressionEnd(assigned, brackets, at), seen)) return true;
      }
    }
    const binder = scopesOf(w.ctx).binderAt(token.v, token.i);
    if (binder === null || seen.has(binder)) continue;
    const owner = w.functions.find((fn) => fn.parameters.some((parameter) => parameter.token === binder.token));
    if (owner === undefined) continue;
    seen.add(binder);
    const { index } = owner.parameters.find((parameter) => parameter.token === binder.token);
    for (const { arr: caller, m: brackets, open } of callersOf(w, owner.name)) {
      const passed = listRanges(caller, brackets, open)[index];
      if (passed !== undefined && spellsGit(w, caller, brackets, passed[0], passed[1], seen)) return true;
    }
  }
  return false;
}

/** Spawn calls in the file and its template holes, in scan order. */
function* spawnCalls(arrays, aliases = new Set()) {
  for (const { arr, m } of arrays) {
    for (let i = 0; i + 2 < arr.length; i += 1) {
      const callee = arr[i];
      if (callee.t !== 'id' || !(SPAWN_CALLEES.has(callee.v) || aliases.has(callee.v))) continue;
      const open = i + 1;
      if (isPunct(arr[open], '(') && m[open] !== undefined) yield { arr, m, open };
    }
  }
}

/** True when a function expression starts at `at`: `function`, `(…) =>` or `name =>`, `async` or not. */
function functionStartsAt(arr, m, at) {
  const start = isWord(arr[at], 'async') ? at + 1 : at;
  if (isWord(arr[start], 'function')) return true;
  if (isPunct(arr[start], '(')) return m[start] !== undefined && isPunct(arr[m[start] + 1], '=>');
  return arr[start]?.t === 'id' && isPunct(arr[start + 1], '=>');
}

/** Plain parameter names and their argument positions for indirect program detection. */
function parametersAt(arr, m, at, open = null) {
  let list = open;
  if (list === null) {
    let start = isWord(arr[at], 'async') ? at + 1 : at;
    if (isWord(arr[start], 'function')) {
      start += isPunct(arr[start + 1], '*') ? 2 : 1;
      if (arr[start]?.t === 'id') start += 1;
    } else if (!isPunct(arr[start], '(')) return [{ index: 0, token: arr[start] }];
    list = start;
  }
  if (!isPunct(arr[list], '(') || m[list] === undefined) return [];
  const parameters = [];
  listRanges(arr, m, list).forEach(([from, to], index) => {
    if (arr[from].t === 'id' && (to === from + 1 || isPunct(arr[from + 1], '='))) parameters.push({ index, token: arr[from] });
  });
  return parameters;
}

/** Named functions in the file and the plain parameters they bind. */
function namedFunctions(arrays) {
  const functions = [];
  for (const { arr, m } of arrays) {
    for (let i = 0; i + 2 < arr.length; i += 1) {
      const token = arr[i];
      if (token.t !== 'id' && token.t !== 's') continue;
      if (isPunct(arr[i + 1], '=', ':') && functionStartsAt(arr, m, i + 2)) {
        functions.push({ name: token.v, token, parameters: parametersAt(arr, m, i + 2) });
        continue;
      }
      const body = isPunct(arr[i + 1], '(') && m[i + 1] !== undefined ? m[i + 1] + 1 : null;
      if (token.t === 'id' && body !== null && isPunct(arr[body], '{') && m[body] !== undefined && !STATEMENT_HEADS.has(token.v)) {
        functions.push({ name: token.v, token, parameters: parametersAt(arr, m, i + 1, i + 1) });
      }
    }
  }
  return functions;
}

/** The `(` of the call the name at `i` makes, `name(…)` or `name?.(…)`, or null when it is not called there. */
function callOpen(arr, m, i) {
  const open = isPunct(arr[i + 1], '?.') ? i + 2 : i + 1;
  return isPunct(arr[open], '(') && m[open] !== undefined ? open : null;
}

function* callersOf(w, name) {
  for (const { arr, m, i } of occurrencesOf(w, name)) {
    if (w.definitions.has(arr[i])) continue;
    const open = callOpen(arr, m, i);
    if (open !== null) yield { arr, m, open };
  }
}

function assignmentsOf(w, name) {
  const found = [];
  for (const { arr, m, i } of occurrencesOf(w, name)) {
    if (i + 2 >= arr.length || !isPunct(arr[i + 1], '=') || isPunct(arr[i + 2], '=') || isPunct(arr[i - 1], '.', '?.')) continue;
    if (!functionStartsAt(arr, m, i + 2)) found.push({ arr, m, at: i + 2 });
  }
  return found;
}

function occurrencesOf(w, name) {
  if (w.occurrences === null) {
    w.occurrences = new Map();
    for (const { arr, m } of w.arrays) {
      for (let i = 0; i < arr.length; i += 1) {
        const token = arr[i];
        if (token.t !== 'id') continue;
        const occurrences = w.occurrences.get(token.v);
        if (occurrences === undefined) w.occurrences.set(token.v, [{ arr, m, i }]);
        else occurrences.push({ arr, m, i });
      }
    }
  }
  return w.occurrences.get(name) ?? [];
}

/**
 * Detects a Git program spelled by a binding or runner parameter, and Git
 * launched by an alias. Used by the ordinary rule for Git dependencies.
 */
export function startsGitThroughName({ tokens, match, ctx }) {
  const arrays = tokenArrays(tokens, match);
  // No literal in the file spells git: no name can hold it.
  const spelled = arrays.some(({ arr }) => arr.some((token) => (token.t === 's' && isGitProgram(token.v)) || (token.t === 'tpl' && isGitProgram(token.quasis[0]))));
  if (!spelled) return false;
  const functions = namedFunctions(arrays);
  const w = { arrays, ctx, functions, occurrences: null, definitions: new Set(functions.map((fn) => fn.token)) };
  for (const { arr, m, open } of spawnCalls(arrays, spawnAliases(arrays))) {
    const [program] = listRanges(arr, m, open);
    if (program !== undefined && spellsGit(w, arr, m, program[0], program[1], new Set())) return true;
  }
  return false;
}

/**
 * The expression index of a literal cwd option. A later spread, computed
 * property or accessor can hide the effective directory.
 */
function optionDirectoryOf(arr, m, args) {
  for (const [from, to] of args.slice(1)) {
    if (!isPunct(arr[from], '{') || m[from] !== to - 1) continue;
    const entries = listRanges(arr, m, from);
    for (const [at, end] of entries.toReversed()) {
      if (isPunct(arr[at], '...', '[') || isWord(arr[at], 'get', 'set')) break;
      if (arr[at].v !== 'cwd') continue;
      if (end === at + 1) return at;
      if (isPunct(arr[at + 1], ':')) return at + 2;
      break;
    }
  }
  return null;
}

/** The directory expression after a leading `-C` in a literal argument array. */
function argumentDirectoryOf(arr, m, args) {
  const [from, to] = args[1] ?? [];
  const leadsWithC = from !== undefined && isPunct(arr[from], '[') && m[from] === to - 1
    && arr[from + 1]?.t === 's' && arr[from + 1].v === '-C' && isPunct(arr[from + 2], ',');
  return leadsWithC && from + 3 < m[from] && !isPunct(arr[from + 3], '...') ? from + 3 : null;
}

const NO_DIRECTORY = 'starts git without naming the directory it runs in (a `cwd` option or a leading `-C`)';
const NULLISH_DIRECTORY = 'gives git a nullish directory, which runs it where the test process is';
const relativeReason = (text) => `runs git in a directory relative to the test process (${text || 'an empty path'})`;

/**
 * A literal part of a direct directory expression can still point back at
 * the checkout. Skip opaque call arguments and later path segments.
 */
function literalDirectoryProblem(arr, m, from, to) {
  for (let i = from; i < to; i += 1) {
    const token = arr[i];
    if (token.t === 's' && !ABSOLUTE.test(token.v)) return relativeReason(token.v);
    if (token.t === 'tpl') {
      const [prefix] = token.quasis;
      const [first] = token.exprs;
      const problem = prefix === '' && first !== undefined
        ? literalDirectoryProblem(first, matchBrackets(first), 0, first.length)
        : ABSOLUTE.test(prefix) ? null : relativeReason(prefix);
      if (problem !== null) return problem;
    }
    if (isWord(token, 'null', 'undefined', 'void') && !isPunct(arr[i - 1], '.', '?.')) return NULLISH_DIRECTORY;
    if (!isPunct(token, '(', '[', '{') || m[i] === undefined) continue;
    if (isPunct(token, '(') && PATH_JOIN.has(arr[i - 1]?.v)) {
      const [first] = listRanges(arr, m, i);
      if (first === undefined) return relativeReason(`${arr[i - 1].v}()`);
      const problem = literalDirectoryProblem(arr, m, first[0], first[1]);
      if (problem !== null) return problem;
    } else if (groupsAt(arr, i)) {
      const problem = literalDirectoryProblem(arr, m, i + 1, m[i]);
      if (problem !== null) return problem;
    }
    i = m[i];
  }
  return null;
}

function directCallProblem(arr, m, args, program, open, ctx) {
  const [from, to] = args[0];
  const token = arr[from];
  if (program !== 'git' || to !== from + 1 || (token.t === 'tpl' && token.exprs.length > 0)
    || isWord(arr[open - 1], 'exec', 'execSync')) {
    return 'runs git through a command line, which hides the directory it runs in';
  }
  const cwd = optionDirectoryOf(arr, m, args);
  const gitDirectory = argumentDirectoryOf(arr, m, args);
  const directory = cwd ?? gitDirectory;
  if (directory === null) return NO_DIRECTORY;
  // A leading -C can override cwd with a checkout path.
  for (const at of [cwd, gitDirectory]) {
    if (at === null) continue;
    const { value } = evaluate(arr, m, at, ctx);
    if (value.k === 'path') return `hands git a path in this repository (${value.v || '<repo root>'})`;
    if (value.k === 'home') return 'hands git a path in the home directory';
  }
  return literalDirectoryProblem(arr, m, directory, expressionEnd(arr, m, directory));
}

/** Returns the marker's presence, its first direct contradiction and the number of direct Git calls. */
export function gitFixtureDeclaration({ src, tokens, match, ctx }) {
  const arrays = tokenArrays(tokens, match);
  if (!declaredInComment(src, arrays)) return { declared: false, problem: null, calls: 0 };
  let calls = 0;
  let problem = null;
  for (const { arr, m, open } of spawnCalls(arrays)) {
    const args = listRanges(arr, m, open);
    const token = arr[args[0]?.[0]];
    const program = token?.t === 's' ? token.v : token?.t === 'tpl' ? token.quasis[0] : '';
    if (!isGitProgram(program)) continue;
    calls += 1;
    problem ??= directCallProblem(arr, m, args, program, open, ctx);
  }
  return { declared: true, problem, calls };
}
