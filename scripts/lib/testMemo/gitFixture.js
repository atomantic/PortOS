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
 * - a relative literal that can become that directory, for the same reason:
 *   written in place, assigned to a name the directory is read from, passed
 *   by a caller as the parameter it is read from, or the first segment of a
 *   `join()`/`resolve()` there;
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
import { BLOCK_KEYWORDS, GIT_FIXTURE_MARKER, PATH_JOIN, SPAWN_CALLEES } from './constants.js';
import { evaluate } from './evaluator.js';
import { scopesOf } from './scopes.js';
import { expressionEnd, groupsAt, isPunct, isWord, listRanges, matchBrackets, tokenArrays } from './tokens.js';

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

const NO_DIRECTORY = 'starts git without naming the directory it runs in (a `cwd` option or a leading `-C`)';
const relativeReason = (text) => `runs git in a directory relative to the test process (${text || 'an empty path'})`;

/**
 * Null, or why the expression in `[from, to)`, which says where git runs,
 * can be relative to the test process: that process runs inside the
 * checkout, so every literal that can become the directory has to be
 * absolute. Read are the literals the expression can evaluate to on its own
 * (`'.'`, `dir || 'fixtures'`), the first segment of a `join()` or
 * `resolve()` (later segments only extend it), and each name it can take its
 * value from (`directoryNameProblem`). A call's result, a property and
 * anything else the source does not spell stay on the declaration's word.
 */
function directoryProblem(w, arr, m, from, to) {
  const whole = evaluate(arr, m, from, w.ctx);
  if (whole.end === to && whole.value.k === 'str' && !ABSOLUTE.test(whole.value.v)) return relativeReason(whole.value.v);
  for (let i = from; i < to; i += 1) {
    const token = arr[i];
    if (token.t === 's' || token.t === 'tpl') {
      // A template that opens with a hole starts wherever that hole does.
      const start = token.t === 'tpl' && token.quasis[0] === '' && token.exprs.length > 0 ? token.exprs[0] : null;
      const problem = start !== null ? directoryProblem(w, start, matchBrackets(start), 0, start.length)
        : ABSOLUTE.test(token.t === 's' ? token.v : token.quasis[0]) ? null : relativeReason(token.t === 's' ? token.v : token.quasis[0]);
      if (problem !== null) return problem;
    } else if (isPunct(token, '(', '[', '{') && m[i] !== undefined) {
      const callee = arr[i - 1];
      let problem = null;
      if (isPunct(token, '(') && callee?.t === 'id' && PATH_JOIN.has(callee.v)) {
        const [first] = listRanges(arr, m, i);
        problem = first === undefined ? relativeReason(`${callee.v}()`) : directoryProblem(w, arr, m, first[0], first[1]);
      } else if (groupsAt(arr, i)) problem = directoryProblem(w, arr, m, i + 1, m[i]);
      if (problem !== null) return problem;
      i = m[i];
    } else if (token.t === 'id' && !isPunct(arr[i - 1], '.', '?.') && !isPunct(arr[i + 1], '(', '.', '?.', '[')) {
      const problem = directoryNameProblem(w, token);
      if (problem !== null) return problem;
    }
  }
  return null;
}

/**
 * What a name the directory is read from can hold: every value the file
 * assigns to it (by spelling, as everywhere here) and, where the name is a
 * positional parameter of a named function, what each call of that function
 * passes there.
 */
function directoryNameProblem(w, token) {
  if (!w.directoryNames.has(token.v)) {
    w.directoryNames.add(token.v);
    for (const { arr, m, at } of assignmentsOf(w, token.v)) {
      const problem = directoryProblem(w, arr, m, at, expressionEnd(arr, m, at));
      if (problem !== null) return problem;
    }
  }
  const binder = scopesOf(w.ctx).binderAt(token.v, token.i);
  if (binder?.role?.kind !== 'named' || !Number.isInteger(binder.index) || w.directoryBinders.has(binder)) return null;
  w.directoryBinders.add(binder);
  for (const { arr, m } of w.arrays) {
    for (let i = 0; i + 1 < arr.length; i += 1) {
      if (!isWord(arr[i], binder.role.nameToken.v) || w.definitions.has(arr[i]) || !isPunct(arr[i + 1], '(') || m[i + 1] === undefined) continue;
      const passed = argumentAt(arr, m, i + 1, binder.index);
      const problem = passed === null ? null : directoryProblem(w, arr, m, passed[0], passed[1]);
      if (problem !== null) return problem;
    }
  }
  return null;
}

/** The `[from, to)` of argument `index` of the call opened at `open`, or null: left out, or behind a spread. */
function argumentAt(arr, m, open, index) {
  const ranges = listRanges(arr, m, open);
  return index < ranges.length && !ranges.slice(0, index + 1).some(([from]) => isPunct(arr[from], '...')) ? ranges[index] : null;
}

/** One git call: the literal program, a named directory no relative literal can become, and nothing of this repository inside it. */
function gitCallProblem(w, { arr, m, open, whole }) {
  if (!whole) return 'runs git through a command line, which hides the directory it runs in';
  const directory = directoryOf(arr, m, listRanges(arr, m, open));
  if (directory === null) return NO_DIRECTORY;
  reaches(w, arr[open].i);
  return directoryProblem(w, arr, m, directory, expressionEnd(arr, m, directory)) ?? rangeProblem(w, arr, m, open + 1, m[open]);
}

/**
 * Where every `name = <expression>` in the file starts its expression (a
 * declaration, an assignment, a parameter default): each is a value the name
 * can hold. A function is no place; where it runs git, its calls are read
 * instead (`runnerProblem`).
 */
function assignmentsOf(w, name) {
  const found = [];
  for (const { arr, m } of w.arrays) {
    for (let i = 0; i + 2 < arr.length; i += 1) {
      if (!isWord(arr[i], name) || !isPunct(arr[i + 1], '=') || isPunct(arr[i + 2], '=') || isPunct(arr[i - 1], '.', '?.')) continue;
      if (!functionStartsAt(arr, m, i + 2)) found.push({ arr, m, at: i + 2 });
    }
  }
  return found;
}

function assignmentsProblem(w, name) {
  for (const { arr, m, at } of assignmentsOf(w, name)) {
    const problem = rangeProblem(w, arr, m, at, expressionEnd(arr, m, at));
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * A function that runs git takes whatever its callers hand it, so every
 * call's arguments are read. A use that is no call (handed on, stored,
 * exported) has callers this file does not show; for a helper the file only
 * imports (`GIT_HELPERS`) such a use is its import, and proves nothing.
 * Such a helper takes its directory second (`execGit(args, dir)`), which is
 * read as a git call's own directory is.
 */
function runnerProblem(w, name) {
  for (const { arr, m } of w.arrays) {
    for (let i = 0; i < arr.length; i += 1) {
      const token = arr[i];
      if (!isWord(token, name) || w.definitions.has(token)) continue;
      if (isPunct(arr[i + 1], '(') && m[i + 1] !== undefined) {
        reaches(w, token.i);
        const problem = (GIT_HELPERS.includes(name) ? helperDirectoryProblem(w, arr, m, i + 1) : null) ?? rangeProblem(w, arr, m, i + 2, m[i + 1]);
        if (problem !== null) return problem;
      } else if (!GIT_HELPERS.includes(name) && !isPunct(arr[i - 1], '.', '?.') && !(isPunct(arr[i + 1], ':') && isPunct(arr[i - 1], '{', ','))) {
        return `${name}() runs git and is used other than by a direct call, so its callers are not all in view`;
      }
    }
  }
  return null;
}

/** A git helper's call: its second argument is the directory, and leaving it out runs git where the test process is. */
function helperDirectoryProblem(w, arr, m, open) {
  const ranges = listRanges(arr, m, open);
  if (ranges.slice(0, 2).some(([from]) => isPunct(arr[from], '...'))) return null;
  return ranges.length < 2 ? NO_DIRECTORY : directoryProblem(w, arr, m, ranges[1][0], ranges[1][1]);
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
    names: new Set(), runners: new Set(GIT_HELPERS), iterables: new Set(), directoryNames: new Set(), directoryBinders: new Set(),
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
