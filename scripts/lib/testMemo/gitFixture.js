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
 *   apart (a command line hides the directory it runs in), a git command
 *   line handed to another program (`sh -c 'git log'`) included. A call is
 *   a git call when its program can spell git: written in place, assigned
 *   to the name it is read from, or passed by a caller as that parameter;
 * - a git call that names no directory: no `cwd` in a literal options object
 *   (one a spread cannot replace) and no leading `-C <dir>` in a literal
 *   argument array. Without one, git runs where the test process does,
 *   inside this checkout;
 * - a relative literal, or a spelled `null`/`undefined`, that can become
 *   that directory, for the same reason: written in place, assigned to a
 *   name the directory is read from, or the first segment of a
 *   `join()`/`resolve()` there;
 * - a caller that gives a git wrapper no fixture directory: the argument it
 *   passes for the parameter the directory is read from, an argument or an
 *   options property it leaves out where nothing defaults it, and any use of
 *   the wrapper through `.call`, `.apply` or `.bind`;
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
 * spell: a call's result, a property of something that is no parameter, a
 * callback's parameter, an argument behind a spread, an options object that
 * is no literal, and whatever another program the suite starts goes on to
 * run. The marker is
 * therefore added only after the suite has been read, and reviewed as a
 * claim about it (docs/TEST_MEMO_GIT_FIXTURES.md).
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

const isGitProgram = (text) => posix.basename(text.trim().split(/\s+/)[0]) === 'git';
/** A git command inside a shell line: `sh -c 'git status'`, `cd x && git log`, `$(git rev-parse HEAD)`. */
const SHELL_GIT = /(?:^|[\s;&|(`$])git\s+[a-z-]/;
const COMMAND_LINE = 'runs git through a command line, which hides the directory it runs in';

/**
 * Every text the expression in `[from, to)` can spell, into `texts` as
 * `{ text, exact, lead }` (`exact`: a whole literal, not a piece of a
 * template with holes; `lead`: where a literal starts, which is where a
 * program name is): the literals written there, and those a name there can
 * hold. A name is followed like a directory's: every value the file assigns
 * to it, and for a parameter of a named function what each call of that
 * function passes there, so `const command = 'git'`, `tool || 'git'` and
 * `run('git', …)` into `(program, args) => spawn(program, args)` are all
 * read as the git calls they are.
 */
function spelledTexts(w, arr, m, from, to, seen, texts) {
  for (let i = from; i < to; i += 1) {
    const token = arr[i];
    if (token.t === 's') texts.push({ text: token.v, exact: true, lead: true });
    else if (token.t === 'tpl') {
      token.quasis.forEach((quasi, at) => texts.push({ text: quasi, exact: token.exprs.length === 0, lead: at === 0 }));
      for (const inner of token.exprs) spelledTexts(w, inner, matchBrackets(inner), 0, inner.length, seen, texts);
    }
    if (token.t !== 'id' || isPunct(arr[i - 1], '.', '?.') || isPunct(arr[i + 1], '(')) continue;
    if (!seen.has(token.v)) {
      seen.add(token.v);
      for (const assigned of assignmentsOf(w, token.v)) spelledTexts(w, assigned.arr, assigned.m, assigned.at, expressionEnd(assigned.arr, assigned.m, assigned.at), seen, texts);
    }
    const binder = scopesOf(w.ctx).binderAt(token.v, token.i);
    const owner = binder === null ? undefined : w.functions.find((fn) => fn.parameters.some((parameter) => parameter.token === binder.token && parameter.prop === null));
    if (owner === undefined || seen.has(binder)) continue;
    seen.add(binder);
    const { index } = owner.parameters.find((parameter) => parameter.token === binder.token);
    for (const call of w.arrays) {
      for (let at = 0; at + 1 < call.arr.length; at += 1) {
        const open = isWord(call.arr[at], owner.name) && !w.definitions.has(call.arr[at]) ? callOpen(call.arr, call.m, at) : null;
        const passed = open === null ? [] : listRanges(call.arr, call.m, open);
        if (index < passed.length) spelledTexts(w, call.arr, call.m, passed[index][0], passed[index][1], seen, texts);
      }
    }
  }
}

/**
 * Every call of a spawn callee whose program can be git, in the file and in
 * its template holes: a superset of what raises `facts.git` (`GIT_SPAWN`,
 * `noteLiteralProgram`), which reads only a literal written in the call.
 * `whole`: every such spelling is the literal `git` alone, arguments apart.
 *
 * With `shell`, also every call of another program that is handed a git
 * command line (`sh -c 'git log'`), which is never `whole`. A declaring file
 * is held to that; the git rule is not, since a line a program is handed is
 * not always one it runs.
 */
function gitCalls(w, { shell = false } = {}) {
  const calls = [];
  for (const { arr, m } of w.arrays) {
    for (let i = 0; i + 2 < arr.length; i += 1) {
      if (arr[i].t !== 'id' || !SPAWN_CALLEES.has(arr[i].v) || !isPunct(arr[i + 1], '(') || m[i + 1] === undefined) continue;
      const [program] = listRanges(arr, m, i + 1);
      if (program === undefined) continue;
      const texts = [];
      spelledTexts(w, arr, m, program[0], program[1], new Set(), texts);
      const git = texts.filter(({ text, lead }) => lead && isGitProgram(text));
      if (git.length) { calls.push({ arr, m, open: i + 1, whole: git.every(({ text, exact }) => exact && text === 'git') }); continue; }
      if (!shell) continue;
      spelledTexts(w, arr, m, program[1], m[i + 1], new Set(), texts);
      if (texts.some(({ text }) => SHELL_GIT.test(text))) calls.push({ arr, m, open: i + 1, whole: false });
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
 * The parameters a function binds by position, for the function expression
 * that starts at `at` (`functionStartsAt`) or the parameter list opened at
 * `open`: a plain or defaulted name is the argument itself (`prop` null), a
 * name in an object pattern is that property of it. A rest parameter and a
 * deeper pattern are no one argument, and are left out.
 */
function parametersAt(arr, m, at, open = null) {
  let list = open;
  if (list === null) {
    let start = isWord(arr[at], 'async') ? at + 1 : at;
    if (isWord(arr[start], 'function')) {
      start += isPunct(arr[start + 1], '*') ? 2 : 1;
      if (arr[start]?.t === 'id') start += 1;
    } else if (!isPunct(arr[start], '(')) return [{ index: 0, token: arr[start], defaulted: false, prop: null }];
    list = start;
  }
  if (!isPunct(arr[list], '(') || m[list] === undefined) return [];
  const parameters = [];
  listRanges(arr, m, list).forEach(([from, to], index) => {
    if (arr[from].t === 'id' && (to === from + 1 || isPunct(arr[from + 1], '='))) parameters.push({ index, token: arr[from], defaulted: to > from + 1, prop: null });
    if (!isPunct(arr[from], '{') || m[from] === undefined) return;
    for (const [pf, pt] of listRanges(arr, m, from)) {
      if (arr[pf].t !== 'id' && arr[pf].t !== 's') continue;
      const bound = isPunct(arr[pf + 1], ':') ? pf + 2 : pf;
      if (arr[bound]?.t === 'id' && (bound + 1 === pt || isPunct(arr[bound + 1], '='))) parameters.push({ index, token: arr[bound], defaulted: bound + 1 < pt, prop: arr[pf].v });
    }
  });
  return parameters;
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
        functions.push({ name: token.v, token, from: token.i, to: end < arr.length ? arr[end].i : Infinity, parameters: parametersAt(arr, m, i + 2) });
        continue;
      }
      const body = isPunct(arr[i + 1], '(') && m[i + 1] !== undefined ? m[i + 1] + 1 : null;
      if (token.t === 'id' && body !== null && isPunct(arr[body], '{') && m[body] !== undefined && !STATEMENT_HEADS.has(token.v)) {
        functions.push({ name: token.v, token, from: token.i, to: arr[m[body]].i, parameters: parametersAt(arr, m, i + 1, i + 1) });
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

/** The `(` of the call the name at `i` makes, `name(…)` or `name?.(…)`, or null when it is not called there. */
function callOpen(arr, m, i) {
  const open = isPunct(arr[i + 1], '?.') ? i + 2 : i + 1;
  return isPunct(arr[open], '(') && m[open] !== undefined ? open : null;
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
const NULLISH_DIRECTORY = 'gives git a nullish directory, which runs it where the test process is';
const relativeReason = (text) => `runs git in a directory relative to the test process (${text || 'an empty path'})`;

/**
 * Null, or why the expression in `[from, to)`, which says where git runs,
 * can be relative to the test process: that process runs inside the
 * checkout, so every literal that can become the directory has to be
 * absolute. Read are the literals the expression can evaluate to on its own
 * (`'.'`, `dir || 'fixtures'`), the first segment of a `join()` or
 * `resolve()` (later segments only extend it), and each name it can take its
 * value from (`directoryNameProblem`). A spelled `null`, `undefined` or
 * `void` is no directory either: Node then starts git where the process is.
 * A call's result, a property and anything else the source does not spell
 * stay on the declaration's word.
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
      if (isWord(token, 'null', 'undefined', 'void')) return NULLISH_DIRECTORY;
      const problem = directoryNameProblem(w, token);
      if (problem !== null) return problem;
    } else if (token.t === 'id' && !isPunct(arr[i - 1], '.', '?.') && isPunct(arr[i + 1], '.', '?.') && arr[i + 2]?.t === 'id' && !isPunct(arr[i + 3], '(', '.', '?.', '[')) {
      // `options.cwd`: where `options` is a parameter, the property each caller's object spells.
      const problem = parameterProblem(w, token, arr[i + 2].v);
      if (problem !== null) return problem;
      i += 2;
    }
  }
  return null;
}

/**
 * What a name the directory is read from can hold: every value the file
 * assigns to it (by spelling, as everywhere here) and, where the name is a
 * parameter of a named function, what each call of that function passes
 * there (`parameterProblem`). A name declared with no value and never
 * assigned holds `undefined`, which is no directory.
 */
function directoryNameProblem(w, token) {
  if (!w.directoryNames.has(token.v)) {
    w.directoryNames.add(token.v);
    const assigned = assignmentsOf(w, token.v);
    if (assigned.length === 0 && declaredBare(w, token.v)) return `${NULLISH_DIRECTORY} (${token.v} is declared and never assigned)`;
    for (const { arr, m, at } of assigned) {
      const problem = directoryProblem(w, arr, m, at, expressionEnd(arr, m, at));
      if (problem !== null) return problem;
    }
  }
  return parameterProblem(w, token, null);
}

/** True when the file declares `name` with no initializer: `let name;`, or one name in such a list. */
function declaredBare(w, name) {
  return w.arrays.some(({ arr }) => arr.some((token, i) => isWord(token, name) && isPunct(arr[i + 1], ';', ',')
    && (isWord(arr[i - 1], 'let', 'var') || (isPunct(arr[i - 1], ',') && bareDeclarationBefore(arr, i - 1)))));
}

/** True when the `,` at `comma` continues a `let a, b` list of bare names. */
function bareDeclarationBefore(arr, comma) {
  let i = comma;
  while (isPunct(arr[i], ',') && arr[i - 1]?.t === 'id') i -= 2;
  return isWord(arr[i], 'let', 'var');
}

/**
 * Null, or why a caller hands git no fixture directory through the use of a
 * parameter at `token`: the argument itself (`prop` null, for `dir` or a
 * `{ cwd }` pattern's own property) or its property `prop` (`options.cwd`).
 * Every call of the function, by spelling, is read:
 *
 * - an argument that is passed is a directory expression like any other;
 * - one that is left out is `undefined` unless the parameter has a default
 *   (which the assignments already read), so git runs where the process is;
 * - one behind a spread, or an object that is no literal, is not spelled.
 *
 * A parameter of a function with no name here (a callback) is whatever its
 * caller passes, which stays on the declaration's word.
 */
function parameterProblem(w, token, memberProp) {
  const binder = scopesOf(w.ctx).binderAt(token.v, token.i);
  if (binder === null) return null;
  for (const fn of w.functions) {
    const parameter = fn.parameters.find((candidate) => candidate.token === binder.token);
    if (parameter === undefined) continue;
    // `options.cwd` off a `{ cwd }` pattern's name is a property of a property: not followed.
    if (memberProp !== null && parameter.prop !== null) return null;
    const prop = memberProp ?? parameter.prop;
    const key = `${fn.token.i}:${parameter.index}:${prop}`;
    if (w.directoryParameters.has(key)) return null;
    w.directoryParameters.add(key);
    // A default stands in for a property the pattern names; nothing does for a property read off the argument.
    const defaulted = parameter.defaulted && memberProp === null;
    return callersProblem(w, fn.name, parameter.index, prop, defaulted);
  }
  return null;
}

function callersProblem(w, name, index, prop, defaulted) {
  const omitted = `${name}() is called without the directory its git call reads, which runs git where the test process is`;
  for (const { arr, m } of w.arrays) {
    for (let i = 0; i + 1 < arr.length; i += 1) {
      const open = isWord(arr[i], name) && !w.definitions.has(arr[i]) ? callOpen(arr, m, i) : null;
      if (open === null) continue;
      const passed = listRanges(arr, m, open);
      if (passed.slice(0, index + 1).some(([from]) => isPunct(arr[from], '...'))) continue;
      if (index >= passed.length) {
        if (!defaulted) return omitted;
        continue;
      }
      let [from, to] = passed[index];
      if (prop !== null) {
        if (!isPunct(arr[from], '{') || m[from] !== to - 1) continue;
        const entries = listRanges(arr, m, from);
        if (entries.some(([at]) => isPunct(arr[at], '...'))) continue;
        const entry = entries.find(([at, until]) => (arr[at].t === 'id' || arr[at].t === 's') && arr[at].v === prop && (until === at + 1 || isPunct(arr[at + 1], ':')));
        if (entry === undefined) {
          if (!defaulted) return omitted;
          continue;
        }
        [from, to] = [entry[1] === entry[0] + 1 ? entry[0] : entry[0] + 2, entry[1]];
      }
      const problem = directoryProblem(w, arr, m, from, to);
      if (problem !== null) return problem;
    }
  }
  return null;
}

/** One git call: the literal program, a named directory no relative literal can become, and nothing of this repository inside it. */
function gitCallProblem(w, { arr, m, open, whole }) {
  if (!whole) return COMMAND_LINE;
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
 * call's arguments are read. A use of the plain name that is no call (handed
 * on, stored, exported) has callers this file does not show, and so does
 * `.call`, `.apply` or `.bind` on the name or on a property of that
 * spelling: their arguments are not where a call's are. Two mentions prove
 * nothing either way and are left alone: any other property of that spelling
 * (`facts.repo` beside `function repo()`), and a bare mention of a helper
 * the file only imports (`GIT_HELPERS`: its import, a mock of it). Such a
 * helper takes its directory second (`execGit(args, dir)`), which is read as
 * a git call's own directory is.
 */
function runnerProblem(w, name) {
  for (const { arr, m } of w.arrays) {
    for (let i = 0; i < arr.length; i += 1) {
      const token = arr[i];
      if (!isWord(token, name) || w.definitions.has(token)) continue;
      const open = callOpen(arr, m, i);
      const indirect = isPunct(arr[i + 1], '.', '?.') && isWord(arr[i + 2], 'call', 'apply', 'bind');
      if (open !== null) {
        reaches(w, token.i);
        const problem = (GIT_HELPERS.includes(name) ? helperDirectoryProblem(w, arr, m, open) : null) ?? rangeProblem(w, arr, m, open + 1, m[open]);
        if (problem !== null) return problem;
      } else if (isPunct(arr[i + 1], ':') && isPunct(arr[i - 1], '{', ',')) {
        continue; // an object key of that spelling
      } else if (indirect || !(GIT_HELPERS.includes(name) || isPunct(arr[i - 1], '.', '?.'))) {
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

/** The state one file is read with: its token arrays, its named functions and what has been followed so far. */
function reading(arrays, ctx) {
  const functions = namedFunctions(arrays);
  return {
    arrays, ctx, functions,
    definitions: new Set(functions.map((fn) => fn.token)),
    names: new Set(), runners: new Set(GIT_HELPERS), iterables: new Set(), directoryNames: new Set(), directoryParameters: new Set(),
    pending: GIT_HELPERS.map((runner) => ({ runner })), // { name } to read the assignments of, { runner } to read the calls of
  };
}

/**
 * True when a spawn call of the file can start git though no call names it
 * literally: the program is a name that holds `'git'`, or a parameter a
 * caller passes it as (`capture('git', …)` into `(command, args) =>
 * spawnSync(command, args)`). The git rule applies to such a file as to one
 * that writes `spawnSync('git', …)`, declaring or not.
 */
export function startsGitThroughName({ tokens, match, ctx }) {
  const arrays = tokenArrays(tokens, match);
  // No literal in the file spells git: no name can hold it.
  const spelled = arrays.some(({ arr }) => arr.some((token) => (token.t === 's' && isGitProgram(token.v)) || (token.t === 'tpl' && isGitProgram(token.quasis[0]))));
  return spelled && gitCalls(reading(arrays, ctx)).length > 0;
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
  const w = reading(arrays, ctx);
  const calls = gitCalls(w, { shell: true });
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
