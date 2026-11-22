/**
 * The test memo's scope analysis: the parameters and `for…of` variables of
 * one file, and what each can hold (`createScopes`). Every helper is a
 * top-level function over one per-file `scopeState`; `createScopes` builds
 * that state once and returns the query API the evaluator uses.
 */

import {
  ARRAY_ITERATORS, ARRAY_MATCHERS, ARRAY_READS, BEFORE_FUNCTION_EXPRESSION, BLOCK_KEYWORDS, COMPARING_MATCHERS,
  ELEMENT_CALLBACKS, ELEMENT_PRESERVING, FS_MODULES, OPERAND_KEYWORDS, READDIR_CALLEES,
} from './constants.js';
import { evaluate, importedConstant } from './evaluator.js';
import {
  DB_MIGRATION_LISTED, LISTED, LISTED_NAME, MIGRATION_LISTED, isGuardModule, isListedDomain, isVariableText, variableCombinations,
} from './pathValues.js';
import { OPENERS, assignsAt, boundNames, enclosingOpen, expressionEnd, groupsAt, isPunct, isWord, listRanges, tokenArrays } from './tokens.js';

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
export function createScopes(ctx) {
  const arrays = tokenArrays(ctx.tokens, ctx.match);
  const s = {
    ctx,
    arrays,
    binders: new Map(), // name -> Binder[]
    declared: new Map(), // name -> source offsets of const/let/var/function/class declarations
    ownDeclarations: new Map(), // name -> declarations that introduce the trusted meaning itself (a `const` arrow, a `require` of fs)
    loopVariables: new Set(), // the tokens a `for…of` head declares: binders, counted as such
    arrowArity: new Map(), // `const name = (a, b) => …`: name -> parameter count (Infinity with a rest parameter, or declared twice)
    // Local names of node's directory listers. A `readdir` of any other origin (a wrapper, a store
    // method) can return anything, so only an import or require of fs vouches for the name.
    listers: new Set(),
    scanners: new Map(),
    fsNamespaces: new Set(),
    /**
     * The text of every string and template in the file. The tokenizer can take code for one (a regex
     * literal it reads as division swallows what follows up to the next quote), and `eval` runs one: a
     * use of a name that would change what is proven about it may be hiding there.
     */
    stringText: arrays.flatMap(({ arr }) => arr.flatMap((token) => (token.t === 's' ? [token.v] : token.t === 'tpl' ? token.quasis : []))).join('\n'),
    /** A lone backslash is no JavaScript outside a literal: an escaped identifier (`r\u0065ad`) or code the tokenizer lost. */
    confused: arrays.some(({ arr }) => arr.some((token) => isPunct(token, '\\'))),
    dynamicScopeOffsets: undefined,
  };
  for (const { arr, m } of arrays) {
    const functionParens = new Set();
    for (let i = 0; i < arr.length; i += 1) bindAt(s, arr, m, i, functionParens);
  }
  collectFsTrust(s);
  return {
    binderAt: (name, offset) => binderAt(s, name, offset),
    domainOf: (binder) => domainOf(s, binder),
    pathOf: (binder) => pathOf(s, binder),
    writtenIn: (name, inside, declaration) => writtenIn(s, name, inside, declaration),
    shadowed: (name) => shadowed(s, name),
    hiddenWrite: (name) => hiddenWrite(s, name),
    declaredTwice: (name) => (s.declared.get(name) ?? []).length > 1,
    hasBinder: (name) => s.binders.has(name),
  };
}

/** The file's scope analysis, built on first use and shared by every copy of its evaluation context. */
export const scopesOf = (ctx) => (ctx.shared.scopes ??= createScopes(ctx.shared.root));

// ---------------------------------------------------------------------------
// Binders: parameters, loop variables and declarations.
// ---------------------------------------------------------------------------

function declare(s, token) {
  if (!s.loopVariables.has(token)) s.declared.set(token.v, [...(s.declared.get(token.v) ?? []), token.i]);
}

function bind(s, token, extent, detail) {
  s.binders.set(token.v, [...(s.binders.get(token.v) ?? []), { name: token.v, token, ...extent, ...detail, domain: undefined }]);
}

/** What a function is to the code around it: a name every caller uses, an argument, or neither. */
function roleOf(arr, m, head, nameToken = null) {
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
}

function bindParameters(s, arr, m, open, extent, role) {
  listRanges(arr, m, open).forEach(([from, to], index) => bindParameter(s, arr, m, [from, to], extent, role, index));
}

function bindParameter(s, arr, m, [from, to], extent, role, index) {
  // Only a plain positional parameter has a domain; a default initializer or destructured
  // object parameter may still resolve to a complete path (`migrationsDir = DEFAULT_MIGRATIONS_DIR`).
  const plain = to === from + 1 && arr[from].t === 'id';
  if (plain) { bind(s, arr[from], extent, { kind: 'param', role, index }); return; }
  if (arr[from]?.t === 'id' && isPunct(arr[from + 1], '=') && from + 2 < to) {
    bind(s, arr[from], extent, { kind: 'opaque', defaultExpr: { arr, m, from: from + 2, to } });
    return;
  }
  if (isPunct(arr[from], '{') && m[from] !== undefined) { bindDestructured(s, arr, m, [from, to], extent, role, index); return; }
  for (const token of boundNames(arr, m, from, to)) bind(s, token, extent, { kind: 'opaque' });
}

/** `{ a, b = dflt, c: d = dflt }`: each named property is a binder; anything else the pattern binds is opaque. */
function bindDestructured(s, arr, m, [from, to], extent, role, index) {
  const handled = new Set();
  const bindProperty = (token, prop, defaultFrom, pt) => {
    handled.add(token);
    bind(s, token, extent, { kind: 'destructured', role, index, prop, ...(defaultFrom === null ? {} : { defaultExpr: { arr, m, from: defaultFrom, to: pt } }) });
  };
  for (const [pf, pt] of listRanges(arr, m, from)) {
    if (arr[pf]?.t !== 'id') continue;
    if (pf + 1 === pt) bindProperty(arr[pf], arr[pf].v, null, pt);
    else if (isPunct(arr[pf + 1], '=') && pf + 2 < pt) bindProperty(arr[pf], arr[pf].v, pf + 2, pt);
    else if (isPunct(arr[pf + 1], ':') && arr[pf + 2]?.t === 'id' && isPunct(arr[pf + 3], '=') && pf + 4 < pt) bindProperty(arr[pf + 2], arr[pf].v, pf + 4, pt);
  }
  for (const token of boundNames(arr, m, from, to)) if (!handled.has(token)) bind(s, token, extent, { kind: 'opaque' });
}

/** Parameters of an arrow whose list opens at `open` (null: one bare name); a rest parameter can take any number. */
function parameterCount(arr, m, open) {
  if (open === null) return 1;
  const ranges = listRanges(arr, m, open);
  return ranges.some(([from]) => isPunct(arr[from], '...')) ? Infinity : ranges.length;
}

function bodyExtent(arr, m, from, bodyStart) {
  if (isPunct(arr[bodyStart], '{') && m[bodyStart] !== undefined) return { from, to: arr[m[bodyStart]].i };
  const end = expressionEnd(arr, m, bodyStart);
  return { from, to: end < arr.length ? arr[end].i : Infinity };
}

/** The declaration or binder the token at `i` introduces, if any. */
function bindAt(s, arr, m, i, functionParens) {
  const token = arr[i];
  if (isWord(token, 'const', 'let', 'var')) declareVariables(s, arr, m, i);
  else if (isWord(token, 'class') && arr[i + 1]?.t === 'id') declare(s, arr[i + 1]);
  else if (isWord(token, 'function') && !isPunct(arr[i - 1], '.', '?.')) bindFunction(s, arr, m, i, functionParens);
  else if (isPunct(token, '=>')) bindArrow(s, arr, m, i);
  else if (isWord(token, 'for') && !isPunct(arr[i - 1], '.', '?.')) bindLoop(s, arr, m, i);
  else if (isPunct(token, ')') && isPunct(arr[i + 1], '{') && m[i] !== undefined && m[i + 1] !== undefined && !functionParens.has(m[i])) bindOpaqueHead(s, arr, m, i);
}

function declareVariables(s, arr, m, i) {
  // Every declarator: `const a = 1, readdirSync = fake` declares the second name too.
  for (let at = i + 1; ;) {
    if (arr[at]?.t === 'id') declare(s, arr[at]);
    else if (isPunct(arr[at], '{', '[') && m[at] !== undefined) for (const token of boundNames(arr, m, at + 1, m[at])) declare(s, token);
    else break;
    const end = expressionEnd(arr, m, at);
    if (!isPunct(arr[end], ',')) break;
    at = end + 1;
  }
}

function bindFunction(s, arr, m, i, functionParens) {
  let open = isPunct(arr[i + 1], '*') ? i + 2 : i + 1;
  const nameToken = arr[open]?.t === 'id' ? arr[open] : null;
  if (nameToken !== null) { declare(s, nameToken); open += 1; }
  if (!isPunct(arr[open], '(') || m[open] === undefined || !isPunct(arr[m[open] + 1], '{')) return;
  functionParens.add(open);
  bindParameters(s, arr, m, open, bodyExtent(arr, m, arr[open].i, m[open] + 1), roleOf(arr, m, i, nameToken));
}

function bindArrow(s, arr, m, i) {
  const open = isPunct(arr[i - 1], ')') && m[i - 1] !== undefined ? m[i - 1] : null;
  if (open === null && arr[i - 1]?.t !== 'id') return;
  const head = open ?? i - 1;
  const extent = bodyExtent(arr, m, arr[head].i, i + 1);
  const role = roleOf(arr, m, head);
  // A `let` can be given another function later, so only a `const` arrow has a known parameter list.
  if (role.kind === 'named' && role.constant) s.arrowArity.set(role.nameToken.v, s.arrowArity.has(role.nameToken.v) ? Infinity : parameterCount(arr, m, open));
  if (open !== null) bindParameters(s, arr, m, open, extent, role);
  else bind(s, arr[head], extent, { kind: 'param', role, index: 0 });
}

function bindLoop(s, arr, m, i) {
  const open = isWord(arr[i + 1], 'await') ? i + 2 : i + 1;
  if (!isPunct(arr[open], '(') || m[open] === undefined) return;
  let of = open + 1;
  while (of < m[open] && !isWord(arr[of], 'of', 'in')) of = OPENERS[arr[of].v] && arr[of].t === 'p' && m[of] !== undefined ? m[of] + 1 : of + 1;
  if (of >= m[open]) return; // `for (;;)`: its `let i = 0` is an ordinary binding
  const from = isWord(arr[open + 1], 'const', 'let', 'var') ? open + 2 : open + 1;
  // `const` or `let`: one binding per turn. A `var` (or a name declared elsewhere) outlives the loop,
  // and a callback registered in it reads whatever the name is assigned afterwards.
  const plain = of === from + 1 && arr[from].t === 'id' && arr[of].v === 'of' && isWord(arr[open + 1], 'const', 'let');
  const extent = bodyExtent(arr, m, arr[open].i, m[open] + 1);
  for (const name of boundNames(arr, m, from, of)) {
    s.loopVariables.add(name);
    bind(s, name, extent, plain ? { kind: 'loop', iter: { arr, m, from: of + 1, to: m[open] } } : { kind: 'opaque' });
  }
}

/** A method (`name(a) {`) or a catch clause: nothing in this file says what it is called with. */
function bindOpaqueHead(s, arr, m, i) {
  const callee = arr[m[i] - 1];
  if (callee?.t !== 'id' || BLOCK_KEYWORDS.has(callee.v)) return;
  for (const name of boundNames(arr, m, m[i] + 1, i)) bind(s, name, { from: arr[m[i]].i, to: arr[m[i + 1]].i }, { kind: 'opaque' });
}

function binderAt(s, name, offset) {
  const candidates = s.binders.get(name);
  if (candidates === undefined) return null;
  let found = null;
  for (const binder of candidates) if (binder.from <= offset && offset < binder.to && (found === null || binder.from > found.from)) found = binder;
  return found;
}

// ---------------------------------------------------------------------------
// Trusted sources: node's directory listers and the migration scanners.
// ---------------------------------------------------------------------------

/** An import is a declaration of its local names; the ones this pass trusts are trusted as that import. */
const TRUSTED_IMPORTS = Object.freeze({ path: ['delimiter'], 'node:path': ['delimiter'], vitest: ['it', 'test', 'describe', 'expect'], crypto: ['randomUUID'], 'node:crypto': ['randomUUID'] });

const isFsSpecifier = (token) => token?.t === 's' && FS_MODULES.has(token.v);

function scannerFor(ctx, imported, spec) {
  if (ctx.mocksSpecifier?.(spec)) return null;
  if (imported === 'scanMigrationFiles' && /(?:^|\/)migration(?:Files|Ledger)\.js$/.test(spec)) return MIGRATION_LISTED;
  if (imported === 'scanDatabaseMigrationFiles' && /(?:^|\/)migrationFiles\.js$/.test(spec)) return DB_MIGRATION_LISTED;
  return null;
}

function collectFsTrust(s) {
  const main = s.ctx.tokens;
  for (let i = 0; i < main.length; i += 1) {
    if (isWord(main[i], 'import') && !isPunct(main[i + 1], '(', '.')) trustImport(s, i);
    else if (isWord(main[i], 'const', 'let', 'var')) trustFsRequire(s, i);
  }
  // A file that mocks fs, or spies on its readdir, decides what a listing returns; so does one that
  // writes to the namespace object or hands it on (`fs.readdirSync = fake`, `Object.assign(fs, …)`).
  if (s.ctx.replaced.fs || !fsNamespacesIntact(s)) { s.listers.clear(); s.fsNamespaces.clear(); }
}

function trustImport(s, i) {
  const main = s.ctx.tokens;
  const match = s.ctx.match;
  let from = i + 1;
  while (from < main.length && !isWord(main[from], 'from') && !isPunct(main[from], ';')) from = isPunct(main[from], '{') && match[from] !== undefined ? match[from] + 1 : from + 1;
  if (!isWord(main[from], 'from') || main[from + 1]?.t !== 's') return;
  const spec = main[from + 1].v;
  const fromFs = isFsSpecifier(main[from + 1]);
  for (let at = i + 1; at < from; at += 1) {
    if (isPunct(main[at], '{') && match[at] !== undefined) {
      for (const [a, b] of listRanges(main, match, at)) if (main[b - 1]?.t === 'id' && main[a]?.t === 'id') importLocal(s, main[b - 1], main[a].v, spec);
      if (fromFs) addFsNames(s, at, 'as', true);
      at = match[at];
    } else if (main[at].t === 'id' && main[at].v !== 'as') {
      // A default import, or the name after `* as`.
      importLocal(s, main[at], 'default', spec);
      if (fromFs) { s.fsNamespaces.add(main[at].v); s.ownDeclarations.set(main[at].v, 1); }
    }
  }
}

function trustFsRequire(s, i) {
  const main = s.ctx.tokens;
  const pattern = isPunct(main[i + 1], '{') && s.ctx.match[i + 1] !== undefined;
  const eq = pattern ? s.ctx.match[i + 1] + 1 : i + 2;
  if (!isPunct(main[eq], '=') || !isWord(main[eq + 1], 'require') || !isPunct(main[eq + 2], '(') || !isFsSpecifier(main[eq + 3])) return;
  // The `const` is itself the declaration that gives the name its meaning.
  if (pattern) addFsNames(s, i + 1, ':', true);
  else if (main[i + 1]?.t === 'id') { s.fsNamespaces.add(main[i + 1].v); s.ownDeclarations.set(main[i + 1].v, 1); }
}

function addFsNames(s, open, alias, own) {
  const main = s.ctx.tokens;
  for (const [from, to] of listRanges(main, s.ctx.match, open)) {
    const local = isWord(main[from + 1], alias) || isPunct(main[from + 1], alias) ? main[from + 2] : main[from];
    if (local?.t !== 'id' || main[from].t !== 'id' || to - from > 3) continue;
    if (READDIR_CALLEES.has(main[from].v)) s.listers.add(local.v);
    else if (main[from].v === 'promises' || main[from].v === 'default') s.fsNamespaces.add(local.v);
    else continue;
    if (own) s.ownDeclarations.set(local.v, 1);
  }
}

function importLocal(s, token, imported, spec) {
  declare(s, token);
  const scanner = scannerFor(s.ctx, imported, spec);
  if (scanner !== null) s.scanners.set(token.v, scanner);
  const trusted = Object.hasOwn(TRUSTED_IMPORTS, spec) ? TRUSTED_IMPORTS[spec] : isGuardModule(s.ctx.fileRel, spec) ? ['pathWithin'] : [];
  if (s.ctx.imports?.has(token.v) || (token.v === imported && trusted.includes(imported))) s.ownDeclarations.set(token.v, 1);
}

/**
 * Every use of a namespace is a call through it (`fs.readdirSync(…)`, `fs.promises.readdir(…)`). Anything
 * else can replace a member or alias the object, and the namespaces share their objects, so one
 * such use takes the trust from all of them.
 */
function fsNamespacesIntact(s) {
  return [...s.fsNamespaces].every((name) => s.arrays.every(({ arr }) => arr.every((use, at) => use.t !== 'id' || use.v !== name
    || isPunct(arr[at - 1], '.', '?.') || isWord(arr[at - 1], 'import', 'as', 'const', 'let', 'var') || calledThrough(arr, at))));
}

function calledThrough(arr, at) {
  let last = at;
  while (isPunct(arr[last + 1], '.') && arr[last + 2]?.t === 'id') last += 2;
  return last > at && isPunct(arr[last + 1], '(');
}

/** True when `name` is bound anywhere in the file beyond the declaration its trusted meaning comes from: a use may then mean something else. */
function shadowed(s, name) {
  return s.binders.has(name) || (s.declared.get(name) ?? []).length > (s.ownDeclarations.get(name) ?? 0);
}

/** True when the call whose callee ends at `callee` (a dotted path from `head`) is node's readdir. */
function listsDirectory(s, arr, head, callee) {
  if (shadowed(s, arr[head].v)) return false;
  if (callee === head) return s.listers.has(arr[head].v);
  return s.fsNamespaces.has(arr[head].v) && READDIR_CALLEES.has(arr[callee].v) && (callee === head + 2 || (callee === head + 4 && arr[head + 2].v === 'promises'));
}

// ---------------------------------------------------------------------------
// Writes: where a name stops holding what it was given.
// ---------------------------------------------------------------------------

/** `arr[from..to]` with the grouping parentheses around it: `((p))`. */
function grouped(arr, m, from, to) {
  let [a, b] = [from, to];
  while (m[a - 1] === b + 1 && groupsAt(arr, a - 1)) { a -= 1; b += 1; }
  return [a, b];
}

/** `x++`, `--(x)`, `delete x[0]`, `(x.length) = 5`: the operand `arr[from..to]` is changed where it stands. */
function changes(arr, m, from, to) {
  const [a, b] = grouped(arr, m, from, to);
  return isPunct(arr[b + 1], '++', '--') || isPunct(arr[a - 1], '++', '--') || isWord(arr[a - 1], 'delete') || assignsAt(arr, b + 1);
}

/** `for (x[0] of rows)`, `for ((x.length) in sizes)`: the head assigns the operand `arr[from..to]` on every turn. */
const loopAssigns = (arr, m, from, to) => isWord(arr[grouped(arr, m, from, to)[1] + 1], 'of', 'in');

/** True when `arr[at]` is written: assigned, updated, or a target of a destructuring assignment. */
function writesTo(arr, m, at) {
  if (isPunct(arr[at - 1], '.', '?.')) return false; // a property of that name
  let after = at + 1;
  while (isPunct(arr[after], ')')) after += 1; // `(p) = other`
  if (assignsAt(arr, after) || changes(arr, m, at, at)) return true;
  // `for (p of rows)`, `for ((p) of rows)`: the head assigns on every turn.
  if (isWord(arr[after], 'of', 'in') && !isWord(arr[at - 1], 'const', 'let', 'var') && inForHead(arr, m, at)) return true;
  // `({ p } = other)`, `[p] = other`: the pattern closes before the `=`.
  return inAssignedPattern(arr, m, at);
}

/** True when `name` is written at a source offset `inside` accepts, other than at the token `declaration`. */
function writtenIn(s, name, inside, declaration = null) {
  return s.arrays.some(({ arr, m }) => arr.some((use, at) => use.t === 'id' && use.v === name && use !== declaration && inside(use.i) && writesTo(arr, m, at)));
}

/** True when `arr[at]` is directly inside the parentheses of a `for` head. */
function inForHead(arr, m, at) {
  let open = enclosingOpen(arr, m, at);
  while (open !== null && isPunct(arr[open], '(') && isPunct(arr[open - 1], '(')) open = enclosingOpen(arr, m, open); // grouping parentheses
  return open !== null && isPunct(arr[open], '(') && (isWord(arr[open - 1], 'for') || (isWord(arr[open - 1], 'await') && isWord(arr[open - 2], 'for')));
}

/** True when `arr[at]` sits in a pattern that is assigned to: `[a, names[0]] = pair`, `for ({ p } of rows)`. */
function inAssignedPattern(arr, m, at) {
  for (let open = enclosingOpen(arr, m, at); open !== null; open = enclosingOpen(arr, m, open)) {
    // `[(p)] = pair`: a target may stand in grouping parentheses.
    if (groupsAt(arr, open)) continue;
    if (!isPunct(arr[open], '{', '[')) return false;
    if (assignsAt(arr, m[open] + 1)) return true;
    if (isWord(arr[m[open] + 1], 'of', 'in') && !isWord(arr[open - 1], 'const', 'let', 'var') && inForHead(arr, m, open)) return true;
  }
  return false;
}

const namedPattern = (name, after) => new RegExp(`(?:^|[^\\w$.])${name.replace(/[$]/g, '\\$&')}\\s*(?:${after})`, 'g');
const hiddenUse = (s, name, after) => namedPattern(name, after).test(s.stringText);
/** A write to `name` spelled inside a string or template: `eval("name = …")`, or code read as text. */
const hiddenWrite = (s, name) => s.confused || hiddenUse(s, name, '=(?!=)|\\+\\+|--|[-+*/%|&^?]{1,3}=|\\)\\s*=(?!=)');

/**
 * True when the source calls `name` more often than the tokens show. A regex literal read as
 * division can end in `//` and take the rest of its line for a comment, call and all; a comment
 * that happens to spell a call costs that file the resolution, nothing more.
 */
function hiddenCall(s, name) {
  const written = (s.ctx.src.match(namedPattern(name, '\\(')) ?? []).length;
  const seen = s.arrays.reduce((count, { arr }) => count + arr.filter((token, at) => token.t === 'id' && token.v === name && isPunct(arr[at + 1], '(') && !isPunct(arr[at - 1], '.', '?.')).length, 0);
  return written > seen;
}

function hasDynamicScope(s, from, to) {
  if (s.dynamicScopeOffsets === undefined) {
    s.dynamicScopeOffsets = [];
    for (const { arr } of s.arrays) for (const token of arr) {
      if (isWord(token, 'arguments', 'eval')) s.dynamicScopeOffsets.push(token.i);
    }
    // Template expressions are visited after their containing array, not in source order.
    s.dynamicScopeOffsets.sort((a, b) => a - b);
  }
  const offsets = s.dynamicScopeOffsets;
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (offsets[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < offsets.length && offsets[lo] < to;
}

/** True when the binder holds what it was given wherever its name is used inside its extent. */
function settled(s, binder) {
  // Two binders of one name where one is inside the other, or a declaration of the name inside
  // the body: which one a use means depends on scoping this pass does not model.
  const inside = (offset) => binder.from <= offset && offset < binder.to;
  const ambiguous = s.binders.get(binder.name).some((other) => other !== binder && (inside(other.from) || (other.from <= binder.from && binder.from < other.to)))
    || (s.declared.get(binder.name) ?? []).some(inside);
  // `p = other()`, `p++` or `({ p } = other)` in the body: the variable no longer holds what it was given.
  // `arguments[0] = x` rebinds a parameter in a sloppy-mode script, and `eval` can do anything.
  const rewritten = writtenIn(s, binder.name, inside, binder.token ?? null) || hasDynamicScope(s, binder.from, binder.to)
    || hiddenWrite(s, binder.name);
  return !ambiguous && !rewritten;
}

// ---------------------------------------------------------------------------
// Array domains: the values a listed or literal array can hold.
// ---------------------------------------------------------------------------

/**
 * The values of the array expression in `arr[from, to)`: a literal of
 * strings, a directory listing, a `const` bound to one, with any chain of
 * element-preserving methods after it. `.map()` and every other method
 * produce new elements, which says nothing about them.
 */
function elementsOf(s, arr, m, from, to, depth = 0) {
  let i = from;
  while (i < to && isWord(arr[i], 'await')) i += 1;
  if (i >= to || depth > 6) return null;
  // A ternary `cond ? a : b` where both branches have the same listed/array domain.
  const ternary = ternaryAt(arr, m, i, to);
  if (ternary !== null) {
    const left = elementsOf(s, arr, m, ternary.question + 1, ternary.colon, depth + 1);
    const right = elementsOf(s, arr, m, ternary.colon + 1, to, depth + 1);
    return unionOf([left, right]);
  }
  const head = headElements(s, arr, m, i, to, depth);
  return head === null ? null : preservedElements(s, arr, m, head.next, to, head.domain);
}

/** The first top-level `?` in `arr[i, to)` and the `:` that closes it, or null. */
function ternaryAt(arr, m, i, to) {
  let question = -1;
  let open = 0;
  for (let k = i; k < to; k += 1) {
    if (arr[k].t === 'p' && OPENERS[arr[k].v] && m[k] !== undefined) { k = m[k]; continue; }
    if (isPunct(arr[k], '?')) { if (question === -1) question = k; open += 1; }
    else if (isPunct(arr[k], ':') && question !== -1) {
      open -= 1;
      if (open === 0) return { question, colon: k };
    }
  }
  return null;
}

/** The domain of the operand at `i` and the index after it, or null when it has none. */
function headElements(s, arr, m, i, to, depth) {
  const head = arr[i];
  if (isPunct(head, '(') && m[i] !== undefined && m[i] < to) return { domain: elementsOf(s, arr, m, i + 1, m[i], depth + 1), next: m[i] + 1 };
  if (isPunct(head, '[') && m[i] !== undefined && m[i] < to) {
    const domain = literalElements(s, arr, m, i);
    return domain === null ? null : { domain, next: m[i] + 1 };
  }
  return head.t === 'id' ? namedElements(s, arr, m, i, to, depth) : null;
}

function literalElements(s, arr, m, open) {
  const domain = [];
  for (const [a, b] of listRanges(arr, m, open)) {
    // `['f0', , 'f1']`: the empty slot is `undefined` to whatever iterates the array.
    if (a === b) return null;
    const { value, end } = evaluate(arr, m, a, s.ctx);
    if (value.k !== 'str' || end !== b) return null;
    domain.push(value.v);
  }
  return domain;
}

function namedElements(s, arr, m, i, to, depth) {
  const head = arr[i];
  // `fs.readdirSync(`, `fs.promises.readdir(`, `Object.freeze(`: the callee is the last name of the dotted path.
  let callee = i;
  while (isPunct(arr[callee + 1], '.') && arr[callee + 2]?.t === 'id') callee += 2;
  const open = callee + 1;
  const calls = isPunct(arr[open], '(') && m[open] !== undefined && m[open] < to;
  if (calls && listsDirectory(s, arr, i, callee)) {
    // `withFileTypes` yields Dirent objects, not names.
    if (arr.slice(open + 1, m[open]).some((token) => isWord(token, 'withFileTypes'))) return null;
    return { domain: LISTED, next: m[open] + 1 };
  }
  if (calls && callee === i && s.scanners.has(head.v) && !shadowed(s, head.v)) return { domain: s.scanners.get(head.v), next: m[open] + 1 };
  if (calls && callee === i + 2 && head.v === 'Object' && arr[callee].v === 'freeze' && !shadowed(s, 'Object')) {
    return { domain: elementsOf(s, arr, m, open + 1, m[open], depth + 1), next: m[open] + 1 };
  }
  return { domain: arrayBinding(s, head, depth), next: i + 1 };
}

/** `domain` through the chain of element-preserving calls in `arr[from, to)`, or null at any other. */
function preservedElements(s, arr, m, from, to, domain) {
  let i = from;
  while (domain !== null && i < to) {
    if (!isPunct(arr[i], '.', '?.') || arr[i + 1]?.t !== 'id' || !ELEMENT_PRESERVING.has(arr[i + 1].v) || !isPunct(arr[i + 2], '(') || m[i + 2] === undefined) return null;
    // A filter callback is handed the array and can replace an element it has not reached yet.
    if (arr[i + 1].v === 'filter' && !callbackIsBlind(s, arr, m, i + 3)) return null;
    i = m[i + 2] + 1;
  }
  return domain;
}

/**
 * True when the callback at `start` (an iteration method's first argument) cannot reach the array
 * it is handed after the index: an arrow with at most `limit` parameters, written inline or
 * declared once as a `const` in this file. A `function` has `arguments`.
 */
function callbackIsBlind(s, arr, m, start, limit = 2) {
  let at = start;
  if (isWord(arr[at], 'async')) at += 1;
  const count = isPunct(arr[at], '(') && m[at] !== undefined && isPunct(arr[m[at] + 1], '=>') ? parameterCount(arr, m, at)
    : arr[at]?.t === 'id' && isPunct(arr[at + 1], '=>') ? 1
      : arr[at]?.t === 'id' && isPunct(arr[at + 1], ')') ? namedArity(s, arr[at].v)
        : Infinity;
  return count <= limit;
}

/** Parameters of the callback `name`: the global `Boolean`, or a `const` arrow declared once and bound nowhere else. */
function namedArity(s, name) {
  if (name === 'Boolean') return shadowed(s, name) ? Infinity : 1;
  return (s.declared.get(name) ?? []).length === 1 && !s.binders.has(name) ? s.arrowArity.get(name) ?? Infinity : Infinity;
}

/** True when the dotted callee ending at `arr[at]` hangs off the test API: `it.each`, `describe.skip.each`. */
function onTestApi(s, arr, at) {
  let root = at;
  while (isPunct(arr[root - 1], '.') && arr[root - 2]?.t === 'id') root -= 2;
  return isWord(arr[root], 'it', 'test', 'describe') && !shadowed(s, arr[root].v);
}

/** The elements of a module-level `const` array, when nothing in the file can add one to it. */
function arrayBinding(s, token, depth) {
  const { ctx } = s;
  const name = token.v;
  const start = ctx.bindings.get(name);
  if (binderAt(s, name, token.i) !== null) return null;
  // A frozen array another module exports (`literalExports`): nothing can add to it.
  if (start === undefined) {
    const imported = importedConstant(name, ctx, (other) => shadowed(s, other));
    return imported?.k === 'array' ? imported.values : null;
  }
  // One declaration of the name in the whole file: an inner `const { NAMES } = row` would be another array.
  if (s.binders.has(name) || !isWord(ctx.tokens[start - 3], 'const') || (s.declared.get(name) ?? []).length !== 1) return null;
  const end = expressionEnd(ctx.tokens, ctx.match, start);
  // `Object.freeze([...])` as the whole initializer: `Object.freeze([...]).slice()` is an unfrozen copy.
  const frozen = isWord(ctx.tokens[start], 'Object') && isPunct(ctx.tokens[start + 1], '.') && isWord(ctx.tokens[start + 2], 'freeze') && isPunct(ctx.tokens[start + 3], '(')
    && ctx.match[start + 3] === end - 1 && !shadowed(s, 'Object');
  // A frozen array cannot change. Any other must only be read: an export or an alias can reach `push()`.
  if (!frozen && (isWord(ctx.tokens[start - 4], 'export') || hiddenUse(s, name, '\\??\\.|\\[|\\)')
    || !s.arrays.every(({ arr, m }) => arr.every((use, at) => use.t !== 'id' || use.v !== name || use === ctx.tokens[start - 2] || readsArray(s, arr, m, at))))) return null;
  return elementsOf(s, ctx.tokens, ctx.match, start, end, depth + 1);
}

/** True when the use of an array name at `arr[at]` only reads it. */
function readsArray(s, arr, m, at) {
  const prev = arr[at - 1];
  const next = arr[at + 1];
  // `({ map: NAMES.map } = other)`, `[NAMES[0]] = pair`: a target, whatever is named.
  if (inAssignedPattern(arr, m, at)) return false;
  if (isPunct(prev, '.', '?.')) return true; // a property of that name on something else
  if (isPunct(prev, '...') || isWord(prev, 'of') || (isPunct(prev, '?') && isPunct(next, ':') && inForHead(arr, m, at))) return true;
  if (isPunct(next, '.', '?.')) return readsThroughMethod(s, arr, m, at);
  if (isPunct(next, '[') && m[at + 1] !== undefined) {
    // One element, read: not called (`NAMES['push'](x)`), not written (`NAMES[0] = x`, `NAMES[0] += x`,
    // `[NAMES[0]] = pair`, `for (NAMES[0] of xs)`), not removed (`delete NAMES[0]`, which leaves an
    // empty slot). `NAMES[0] === x` is a read.
    if (isPunct(arr[m[at + 1] + 1], '(', '?.') || changes(arr, m, at, m[at + 1])) return false;
    return !loopAssigns(arr, m, at, m[at + 1]);
  }
  if (isPunct(prev, '(', ',') && isPunct(next, ')', ',')) return handedToReader(s, arr, m, at);
  return false;
}

/** `NAMES.method…`: a method that only reads, and is not replaced (`NAMES.map = other`). */
function readsThroughMethod(s, arr, m, at) {
  const method = arr[at + 2];
  // `NAMES.length++`, `++(NAMES.length)` and `(NAMES.length) = 5` add empty slots.
  if (method?.t !== 'id' || !ARRAY_READS.has(method.v) || changes(arr, m, at, at + 2) || loopAssigns(arr, m, at, at + 2)) return false;
  const open = isPunct(arr[at + 3], '?.') ? at + 4 : at + 3; // `NAMES.forEach?.(cb)`
  if (!ARRAY_ITERATORS.has(method.v) || !isPunct(arr[open], '(') || m[open] === undefined) return true;
  // `names.forEach((name, i, all) => all.push(x))`: the callback is handed the array.
  return callbackIsBlind(s, arr, m, open + 1, method.v.startsWith('reduce') ? 3 : 2);
}

/**
 * Handed to something that only reads it: `expect(NAMES)`, `new Set(NAMES)`, `Array.from(NAMES)`,
 * `Object.freeze(NAMES)`, `JSON.stringify(NAMES)`, `it.each(NAMES)`, a matcher.
 */
function handedToReader(s, arr, m, at) {
  const open = enclosingOpen(arr, m, at);
  const callee = open !== null && isPunct(arr[open], '(') ? arr[open - 1] : null;
  // Alone: a second argument can be a callback that is handed the array, or bound to it as `this`.
  if (callee?.t !== 'id' || listRanges(arr, m, open).length !== 1) return false;
  if (!isPunct(arr[open - 2], '.')) return handedToPlainCall(s, arr, m, open, callee);
  const owner = arr[open - 3];
  const global = (name) => isWord(owner, name) && !isPunct(arr[open - 4], '.', '?.') && !shadowed(s, name);
  return (callee.v === 'each' && onTestApi(s, arr, open - 1)) || ARRAY_MATCHERS.has(callee.v)
    || (global('Array') && (callee.v === 'from' || callee.v === 'isArray'))
    || (global('Object') && callee.v === 'freeze') || (global('JSON') && callee.v === 'stringify');
}

function handedToPlainCall(s, arr, m, open, callee) {
  if (shadowed(s, callee.v)) return false;
  if (callee.v === 'Set') return isWord(arr[open - 2], 'new');
  // `expect(NAMES).toHaveLength(2)`, `expect(NAMES).not.toContain(x)`: compared, there and then.
  const matcher = m[open] + (isPunct(arr[m[open] + 1], '.') && isWord(arr[m[open] + 2], 'not') ? 4 : 2);
  return callee.v === 'expect' && isPunct(arr[matcher - 1], '.') && arr[matcher]?.t === 'id' && COMPARING_MATCHERS.has(arr[matcher].v) && isPunct(arr[matcher + 1], '(');
}

/** Start of the member/call chain that ends just before `end`, or null. */
function operandStart(arr, m, end) {
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
}

function unionOf(parts) {
  if (parts.includes(null)) return null;
  if (parts.every((part) => !isListedDomain(part))) return [...new Set(parts.flat())];
  return parts.every((part) => part === parts[0] && isListedDomain(part)) ? parts[0] : null;
}

// ---------------------------------------------------------------------------
// Call sites: what every caller passes a parameter.
// ---------------------------------------------------------------------------

/** The `[from, to)` of argument `index` of the call opened at `open`, or null: too few arguments, or a spread before it. */
function argumentRange(arr, m, open, index) {
  const ranges = listRanges(arr, m, open);
  if (index >= ranges.length || ranges.slice(0, index + 1).some(([from]) => isPunct(arr[from], '...'))) return null;
  return ranges[index];
}

/** What argument `index` of the call opened at `open` can be. */
function argumentDomain(s, arr, m, open, index) {
  const range = argumentRange(arr, m, open, index);
  if (range === null) return null;
  const [from, to] = range;
  const { value, end } = evaluate(arr, m, from, s.ctx);
  if (end !== to) return null;
  if (value.k === 'str') return [value.v];
  // A listed name passed on unchanged.
  if (value === LISTED_NAME) return LISTED;
  // Text built from other resolved variables (`read(\`${stem}.json\`)`): one value per combination of theirs.
  const texts = isVariableText(value) ? variableCombinations(value.vars)?.map((chosen) => evaluate(arr, m, from, { ...s.ctx, overrides: chosen, bindingValues: new Map(), resolving: new Set() }).value) : null;
  return texts?.every((text) => text.k === 'str') ? texts.map((text) => text.v) : null;
}

/** Every use of the function named by `nameToken` but its declaration, or null when the name can mean something else. */
function usesOf(s, nameToken) {
  const name = nameToken.v;
  if ((s.declared.get(name) ?? []).length !== 1 || s.binders.has(name) || hiddenUse(s, name, '[(`.]|\\?\\.') || hiddenCall(s, name)) return null;
  const uses = [];
  for (const { arr, m } of s.arrays) {
    for (let at = 0; at < arr.length; at += 1) {
      const use = arr[at];
      if (use.t !== 'id' || use.v !== name || use === nameToken) continue;
      if (isPunct(arr[at - 1], '.', '?.') || (isPunct(arr[at + 1], ':') && isPunct(arr[at - 1], '{', ','))) continue; // another object's property
      uses.push({ arr, m, at });
    }
  }
  return uses;
}

/** Every value parameter `index` of the function named by `nameToken` is called with, or null when a use is not a plain call. */
function callSiteDomain(s, nameToken, index) {
  const uses = usesOf(s, nameToken);
  if (uses === null) return null;
  const parts = [];
  for (const { arr, m, at } of uses) {
    const prev = arr[at - 1];
    const next = arr[at + 1];
    if (isPunct(next, '(') && m[at + 1] !== undefined) parts.push(argumentDomain(s, arr, m, at + 1, index));
    else if (index === 0 && isPunct(prev, '(') && isPunct(next, ')') && arr[at - 2]?.t === 'id' && ELEMENT_CALLBACKS.has(arr[at - 2].v) && isPunct(arr[at - 3], '.', '?.')) {
      // `NAMES.map(read)`: called with each element, and with the array, which it must not be able to take.
      if (!callbackIsBlind(s, arr, m, at)) return null;
      const start = operandStart(arr, m, at - 3);
      parts.push(start === null ? null : elementsOf(s, arr, m, start, at - 3));
    } else return null; // exported, aliased, stored or handed on: its callers are not all in view
    if (parts.at(-1) === null) return null;
  }
  return unionOf(parts);
}

/** The one complete path every call passes as parameter `index` (or destructured property `prop`) of `nameToken`, or null. */
function callSitePath(s, nameToken, index, prop = null) {
  const uses = usesOf(s, nameToken);
  if (uses === null) return null;
  let passed = null;
  for (const { arr, m, at } of uses) {
    if (!isPunct(arr[at + 1], '(') || m[at + 1] === undefined) return null; // not every caller is in view
    const range = argumentRange(arr, m, at + 1, index);
    const expr = range === null ? null : prop === null ? range : propertyRange(arr, m, range, prop);
    if (expr === null) return null;
    const { value, end } = evaluate(arr, m, expr[0], s.ctx);
    if (end !== expr[1] || value.k !== 'path' || value.partial) return null;
    if (passed !== null && JSON.stringify(passed) !== JSON.stringify(value)) return null;
    passed = value;
  }
  return passed;
}

/** The value range of property `prop` in the object literal that is the whole argument `[from, to)`, or null. */
function propertyRange(arr, m, [from, to], prop) {
  if (!isPunct(arr[from], '{') || m[from] === undefined || m[from] + 1 !== to) return null;
  const entry = listRanges(arr, m, from).find(([pf, pt]) => arr[pf]?.t === 'id' && arr[pf].v === prop && (pf + 1 === pt || isPunct(arr[pf + 1], ':')));
  if (entry === undefined) return null;
  return [entry[0] + 1 === entry[1] ? entry[0] : entry[0] + 2, entry[1]];
}

/** The first parameter of a callback handed to an array method or to `it.each(table)`. */
function callbackDomain(s, { arr, m, at }, index) {
  if (index !== 0) return null;
  const open = isPunct(arr[at], '(') ? at : enclosingOpen(arr, m, at);
  if (open === null || !isPunct(arr[open], '(')) return null;
  const position = listRanges(arr, m, open).findIndex(([from, to]) => from <= at + 1 && at + 1 < to);
  const callee = arr[open - 1];
  if (position === 0 && callee?.t === 'id' && ELEMENT_CALLBACKS.has(callee.v) && isPunct(arr[open - 2], '.', '?.')) {
    // The callback is handed the array too, and could replace an element it has not been called with yet.
    const start = callbackIsBlind(s, arr, m, at + 1) ? operandStart(arr, m, open - 2) : null;
    return start === null ? null : elementsOf(s, arr, m, start, open - 2);
  }
  // `it.each(TABLE)('title', (row) => …)`: one call per row; a row that is itself an array is spread, and is no string.
  if (position >= 1 && isPunct(callee, ')') && m[open - 1] !== undefined && isWord(arr[m[open - 1] - 1], 'each') && onTestApi(s, arr, m[open - 1] - 1)) {
    return elementsOf(s, arr, m, m[open - 1] + 1, open - 1);
  }
  return null;
}

/**
 * The path a helper's parameter holds when every call passes the same complete one (`read(FIXTURES)`),
 * or null. Asked only for a parameter named like a module-level path (`identifierValue`).
 */
function pathOf(s, binder) {
  if (binder.path !== undefined) return binder.path;
  binder.path = null; // a value that flows back into itself resolves to nothing
  if (!settled(s, binder)) return null;
  if (binder.defaultExpr !== undefined) {
    const { value, end } = evaluate(binder.defaultExpr.arr, binder.defaultExpr.m, binder.defaultExpr.from, s.ctx);
    if (end === binder.defaultExpr.to && value.k === 'path' && !value.partial && !value.unfollowed) binder.path = value;
  }
  if (binder.path === null && binder.kind === 'param' && binder.role.kind === 'named') {
    binder.path = callSitePath(s, binder.role.nameToken, binder.index);
  } else if (binder.path === null && binder.kind === 'destructured' && binder.prop !== null && binder.role.kind === 'named') {
    binder.path = callSitePath(s, binder.role.nameToken, binder.index, binder.prop);
  }
  return binder.path;
}

function domainOf(s, binder) {
  if (binder.domain !== undefined) return binder.domain;
  binder.domain = null; // a value that flows back into itself resolves to nothing
  if (!settled(s, binder)) return null;
  const logged = s.ctx.shared.trustLog.length;
  if (binder.kind === 'loop') binder.domain = elementsOf(s, binder.iter.arr, binder.iter.m, binder.iter.from, binder.iter.to);
  else if (binder.kind === 'param' && binder.role.kind === 'named') binder.domain = callSiteDomain(s, binder.role.nameToken, binder.index);
  else if (binder.kind === 'param' && binder.role.kind === 'callback') binder.domain = callbackDomain(s, binder.role, binder.index);
  binder.trusts = s.ctx.shared.trustLog.slice(logged);
  return binder.domain;
}
