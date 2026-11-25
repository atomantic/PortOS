/**
 * The test memo's `// test-memo: git-fixture` declaration
 * (`gitFixtureDeclaration`): whether a file makes it, and whether the file's
 * own text contradicts it. Pure.
 *
 * A test that spawns git is refused because repository state (history, refs,
 * the index, the working tree) is in no key. A suite that only drives git
 * inside repositories it creates under the temp directory has no such input,
 * but no static reading can prove where `git(dir, ...)` runs, so the suite
 * says so and this module refuses the declaration wherever the source shows
 * otherwise:
 *
 * - a git call that is not the literal program `git` with its arguments
 *   apart (a command line hides the directory it runs in);
 * - a git call that names no directory: no `cwd` in a literal options object
 *   (one a spread cannot replace) and no leading `-C <dir>` in a literal
 *   argument array. Without one, git runs where the test process does,
 *   inside this checkout;
 * - a directory written as a relative literal, for the same reason;
 * - a repository or home path anywhere a git process can take it from:
 *   inside a git call, in the arguments of any call of a function that runs
 *   git (followed through the functions that call those, and counting the
 *   repository's own `execGit`), in the iterable of a loop whose variable
 *   reaches one, or in any value assigned to a name that appears in one of
 *   those places.
 *
 * Names are followed by spelling, never by scope: every `name = …` in the
 * file is read for a name a git call uses, so two tests that each declare
 * `repo` are both read, and a function is one that runs git when a function
 * of that name does. That only ever refuses more.
 *
 * What stays on the declaration's word is a value the source does not
 * spell: a call's result, a property, a callback's parameter. The marker is
 * therefore added only after the suite has been read, and reviewed as a
 * claim about it (docs/TEST_MEMO.md, "Git fixtures").
 */

import { posix } from 'node:path';
import { BLOCK_KEYWORDS, GIT_FIXTURE_MARKER, SPAWN_CALLEES } from './constants.js';
import { evaluate } from './evaluator.js';
import { scopesOf } from './scopes.js';
import { expressionEnd, isPunct, isWord, listRanges, matchBrackets, tokenArrays } from './tokens.js';

const ABSOLUTE = /^(?:[\\/]|[A-Za-z]:[\\/])/;
/**
 * The repository's own way to run git (`server/lib/execGit.js`): a call of
 * it starts git as surely as a spawn does, wherever the name was imported
 * from, so its arguments are read like those of a function this file defines.
 */
const GIT_HELPERS = Object.freeze(['execGit']);
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
 * Every call of a spawn callee whose program is git, in the file and in its
 * template holes: a superset of what raises `facts.git` (`GIT_SPAWN`,
 * `noteLiteralProgram`). `whole`: the literal `git` alone, arguments apart.
 */
function gitCalls(arrays) {
  const calls = [];
  for (const { arr, m } of arrays) {
    for (let i = 0; i + 2 < arr.length; i += 1) {
      if (arr[i].t !== 'id' || !SPAWN_CALLEES.has(arr[i].v) || !isPunct(arr[i + 1], '(') || m[i + 1] === undefined) continue;
      const program = arr[i + 2];
      const text = program.t === 's' ? program.v : program.t === 'tpl' ? program.quasis[0] : null;
      if (text === null || posix.basename(text.trim().split(/\s+/)[0]) !== 'git') continue;
      const whole = text === 'git' && (program.t === 's' || program.exprs.length === 0) && isPunct(arr[i + 3], ',', ')');
      calls.push({ arr, m, open: i + 1, whole });
    }
  }
  return calls;
}

/** True when a function expression starts at `at`: `function`, `(…) =>` or `name =>`, `async` or not. */
function functionStartsAt(arr, m, at) {
  const start = isWord(arr[at], 'async') ? at + 1 : at;
  if (isWord(arr[start], 'function')) return true;
  if (isPunct(arr[start], '(')) return m[start] !== undefined && isPunct(arr[m[start] + 1], '=>');
  return arr[start]?.t === 'id' && isPunct(arr[start + 1], '=>');
}

/**
 * The named functions of the file, by spelling: `name = <function>` (a
 * declaration, an assignment), `name: <function>`, `function name(…) {…}`
 * and a method `name(…) {…}`. `from` and `to` are source offsets.
 */
function namedFunctions(arrays) {
  const functions = [];
  for (const { arr, m } of arrays) {
    for (let i = 0; i + 2 < arr.length; i += 1) {
      const token = arr[i];
      if (token.t !== 'id' && token.t !== 's') continue;
      if (isPunct(arr[i + 1], '=', ':') && functionStartsAt(arr, m, i + 2)) {
        const end = expressionEnd(arr, m, i + 2);
        functions.push({ name: token.v, token, from: token.i, to: end < arr.length ? arr[end].i : Infinity });
        continue;
      }
      const body = isPunct(arr[i + 1], '(') && m[i + 1] !== undefined ? m[i + 1] + 1 : null;
      if (token.t === 'id' && body !== null && isPunct(arr[body], '{') && m[body] !== undefined && !STATEMENT_HEADS.has(token.v)) {
        functions.push({ name: token.v, token, from: token.i, to: arr[m[body]].i });
      }
    }
  }
  return functions;
}

/**
 * The index of the expression that says where a git call runs: the `cwd` of
 * a literal options object, or what follows a leading `-C` in a literal
 * argument array. Null when the call names neither, or when a spread in the
 * options could put another `cwd` there.
 */
function directoryOf(arr, m, args) {
  for (const [from, to] of args.slice(1)) {
    if (!isPunct(arr[from], '{') || m[from] !== to - 1) continue;
    const entries = listRanges(arr, m, from);
    const cwd = entries.find(([at, end]) => (arr[at].t === 'id' || arr[at].t === 's') && arr[at].v === 'cwd' && (end === at + 1 || isPunct(arr[at + 1], ':')));
    if (cwd !== undefined && !entries.some(([at]) => isPunct(arr[at], '...'))) return cwd[1] === cwd[0] + 1 ? cwd[0] : cwd[0] + 2;
  }
  const [from, to] = args[1] ?? [];
  const leadsWithC = from !== undefined && isPunct(arr[from], '[') && m[from] === to - 1
    && arr[from + 1]?.t === 's' && arr[from + 1].v === '-C' && isPunct(arr[from + 2], ',');
  return leadsWithC && from + 3 < m[from] && !isPunct(arr[from + 3], '...') ? from + 3 : null;
}

/** Note that code at source offset `offset` can start git: every named function around it is one that runs git. */
function reaches(w, offset) {
  for (const fn of w.functions) {
    if (fn.from < offset && offset < fn.to && !w.runners.has(fn.name)) {
      w.runners.add(fn.name);
      w.pending.push({ runner: fn.name });
    }
  }
}

/**
 * Null, or why the tokens `[from, to)` hand a git process a place the suite
 * did not create. Every name read there is queued, so what the file assigns
 * to it is read too (`assignmentsProblem`).
 */
function rangeProblem(w, arr, m, from, to) {
  for (let i = from; i < to; i += 1) {
    const token = arr[i];
    if (token.t === 'tpl') {
      for (const inner of token.exprs) {
        const problem = rangeProblem(w, inner, matchBrackets(inner), 0, inner.length);
        if (problem !== null) return problem;
      }
      continue;
    }
    // A member name and a property key are no values of their own.
    if (token.t !== 'id' || isPunct(arr[i - 1], '.', '?.') || (isPunct(arr[i + 1], ':') && isPunct(arr[i - 1], '{', ','))) continue;
    const { value } = evaluate(arr, m, i, w.ctx);
    if (value.k === 'path') return `hands git a path in this repository (${value.v || '<repo root>'})`;
    if (value.k === 'home') return 'hands git a path in the home directory';
    if (!w.names.has(token.v)) {
      w.names.add(token.v);
      w.pending.push({ name: token.v });
    }
    // `for (const dir of [ROOT, scratch])`: the loop variable is whatever the iterable holds.
    const iter = scopesOf(w.ctx).binderAt(token.v, token.i)?.iter;
    if (iter !== undefined && !w.iterables.has(iter)) {
      w.iterables.add(iter);
      const problem = rangeProblem(w, iter.arr, iter.m, iter.from, iter.to);
      if (problem !== null) return problem;
    }
  }
  return null;
}

/**
 * A relative literal the directory expression at `from` can evaluate to on its
 * own (`'.'`, `dir || 'fixtures'`): relative to the test process, which runs
 * inside the checkout. A literal handed to a call (`join(root, 'repo')`) is a
 * segment of something else. Null when there is none.
 */
function relativeDirectory(arr, m, from) {
  const end = expressionEnd(arr, m, from);
  for (let i = from; i < end; i += 1) {
    const token = arr[i];
    if (isPunct(token, '(', '[', '{') && m[i] !== undefined) { i = m[i]; continue; }
    const text = token.t === 's' ? token.v : token.t === 'tpl' && token.exprs.length === 0 ? token.quasis[0] : null;
    if (text !== null && !ABSOLUTE.test(text)) return text;
  }
  return null;
}

/** One git call: the literal program, a named directory that is no relative literal, and nothing of this repository inside it. */
function gitCallProblem(w, { arr, m, open, whole }) {
  if (!whole) return 'runs git through a command line, which hides the directory it runs in';
  const directory = directoryOf(arr, m, listRanges(arr, m, open));
  if (directory === null) return 'starts git without naming the directory it runs in (a `cwd` option or a leading `-C`)';
  const relative = relativeDirectory(arr, m, directory);
  if (relative !== null) return `runs git in a directory relative to the test process (${relative || 'an empty path'})`;
  reaches(w, arr[open].i);
  return rangeProblem(w, arr, m, open + 1, m[open]);
}

/** Every `name = <expression>` in the file (a declaration, an assignment, a parameter default) is a value the name can hold. */
function assignmentsProblem(w, name) {
  for (const { arr, m } of w.arrays) {
    for (let i = 0; i + 2 < arr.length; i += 1) {
      if (!isWord(arr[i], name) || !isPunct(arr[i + 1], '=') || isPunct(arr[i + 2], '=') || isPunct(arr[i - 1], '.', '?.')) continue;
      // A function is no place; where it runs git, its calls are read instead (`runnerProblem`).
      if (functionStartsAt(arr, m, i + 2)) continue;
      const problem = rangeProblem(w, arr, m, i + 2, expressionEnd(arr, m, i + 2));
      if (problem !== null) return problem;
    }
  }
  return null;
}

/**
 * A function that runs git takes whatever its callers hand it, so every
 * call's arguments are read. A use that is no call (handed on, stored,
 * exported) has callers this file does not show; for a helper the file only
 * imports (`GIT_HELPERS`) such a use is its import, and proves nothing.
 */
function runnerProblem(w, name) {
  for (const { arr, m } of w.arrays) {
    for (let i = 0; i < arr.length; i += 1) {
      const token = arr[i];
      if (!isWord(token, name) || w.definitions.has(token)) continue;
      if (isPunct(arr[i + 1], '(') && m[i + 1] !== undefined) {
        reaches(w, token.i);
        const problem = rangeProblem(w, arr, m, i + 2, m[i + 1]);
        if (problem !== null) return problem;
      } else if (!GIT_HELPERS.includes(name) && !isPunct(arr[i - 1], '.', '?.') && !(isPunct(arr[i + 1], ':') && isPunct(arr[i - 1], '{', ','))) {
        return `${name}() runs git and is used other than by a direct call, so its callers are not all in view`;
      }
    }
  }
  return null;
}

/**
 * `declared`: the file carries the marker in a comment. `problem`: null, or
 * the first way its text contradicts the declaration. `calls`: how many git
 * calls were read, so a caller can tell a declaration that was checked from
 * one with nothing to check.
 *
 * @param {{ src: string, tokens: object[], match: number[], ctx: object }} file one file's tokens and evaluation context (`extractFileFacts`)
 * @returns {{ declared: boolean, problem: string|null, calls: number }}
 */
export function gitFixtureDeclaration({ src, tokens, match, ctx }) {
  const arrays = tokenArrays(tokens, match);
  if (!declaredInComment(src, arrays)) return { declared: false, problem: null, calls: 0 };
  const functions = namedFunctions(arrays);
  const w = {
    arrays, ctx, functions,
    definitions: new Set(functions.map((fn) => fn.token)),
    names: new Set(), runners: new Set(GIT_HELPERS), iterables: new Set(),
    pending: GIT_HELPERS.map((runner) => ({ runner })), // { name } to read the assignments of, { runner } to read the calls of
  };
  const calls = gitCalls(arrays);
  let problem = null;
  for (const call of calls) {
    problem = gitCallProblem(w, call);
    if (problem !== null) break;
  }
  while (problem === null && w.pending.length) {
    const next = w.pending.pop();
    problem = next.name !== undefined ? assignmentsProblem(w, next.name) : runnerProblem(w, next.runner);
  }
  return { declared: true, problem, calls: calls.length };
}
