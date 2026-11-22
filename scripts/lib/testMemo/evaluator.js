/**
 * The test memo's path-expression evaluator: reads the expression at a token
 * index as an abstract path value (`pathValues.js`), following bindings,
 * imported literal constants and scope-proven parameter domains
 * (`scopes.js`), and finds the widest path expression around an anchor.
 * Also the literal-export and mocked-source readers other modules key on.
 */

import { posix } from 'node:path';
import { FS_MODULES, PATH_DIRNAME, PATH_IDENTITY, PATH_JOIN, READDIR_CALLEES, SPAWN_CALLEES } from './constants.js';
import {
  DB_MIGRATION_LISTED, DB_MIGRATION_LISTED_NAME, DELIMITER, EXTERNAL, GENERATED_NAME, HOME, LISTED, LISTED_NAME,
  MIGRATION_LISTED, MIGRATION_LISTED_NAME, NODE, UNBOUNDED, UNKNOWN, concatValue, dirValue, dirnameValue, foldJoin,
  guardedJoin, isCryptoModule, isGuardModule, isVariableText, partialPath, pathValue, str, unfollowedPath, urlValue, variableValue,
} from './pathValues.js';
import { createScopes, scopesOf } from './scopes.js';
import { OPENERS, calleeName, calleeStart, enclosingOpen, expressionEnd, groupsAt, isPunct, isWord, listRanges, matchBrackets, tokenizeModule } from './tokens.js';

/** True when the file imports `name`, under that name, from a module `accepts(specifier)` vouches for. */
export function importsNamed(tokens, match, name, accepts) {
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
export function namedImports(tokens, match) {
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
  try { tokens = tokenizeModule(src, fileRel); } catch { return exported; }
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
export function importedConstant(name, ctx, shadowed) {
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
export function mocksModule(tokens, match, accepts, members) {
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
export function namedInImportList(tokens, match, at) {
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
  try { tokens = tokenizeModule(src, fileRel); } catch { return { fs: true, crypto: true, guard: true }; }
  const match = matchBrackets(tokens);
  return {
    fs: mocksModule(tokens, match, (spec) => FS_MODULES.has(spec), [...READDIR_CALLEES]),
    crypto: mocksModule(tokens, match, isCryptoModule, ['randomUUID']),
    guard: mocksModule(tokens, match, (spec) => isGuardModule(fileRel, spec), ['pathWithin']),
  };
}

export function evaluateArgs(tokens, match, open, ctx, depth) {
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

export function evaluate(tokens, match, start, ctx, depth = 0) {
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
  if (token.t === 'tpl') return { value: templateValue(token, ctx, depth), end: start + 1 };
  if (token.t === 'p' && token.v === '(') {
    const inner = evaluate(tokens, match, start + 1, ctx, depth + 1);
    return { value: wholeValue(inner, match[start]), end: closeOf(match, start) };
  }
  if (token.t !== 'id') return { value: UNKNOWN, end: start + 1 };
  const anchored = anchorPrimary(tokens, match, start, ctx, depth);
  if (anchored !== null) return anchored;
  if (isPunct(tokens[start + 1], '(')) return callPrimary(tokens, match, start, ctx, depth);
  return { value: identifierValue(token, ctx, depth), end: start + 1 };
}

/** A template literal: its text with each hole's value concatenated in. */
function templateValue(token, ctx, depth) {
  let acc = str(token.quasis[0]);
  for (let i = 0; i < token.exprs.length; i += 1) {
    const inner = token.exprs[i];
    const hole = evaluate(inner, matchBrackets(inner), 0, ctx, depth + 1);
    acc = concatValue(acc, wholeValue(hole, inner.length));
    acc = concatValue(acc, str(token.quasis[i + 1]));
  }
  return acc;
}

/**
 * A primary that names a place by itself: `new URL(…)`, `__dirname`,
 * `__filename`, `import.meta.*`, the trusted `PATHS.slashdo`, `process.*`.
 * Null when the identifier at `start` is none of them.
 */
function anchorPrimary(tokens, match, start, ctx, depth) {
  const token = tokens[start];
  if (token.v === 'new' && isWord(tokens[start + 1], 'URL') && tokens[start + 2]?.v === '(') {
    return { value: urlValue(evaluateArgs(tokens, match, start + 2, ctx, depth) ?? []), end: closeOf(match, start + 2) };
  }
  if (token.v === '__dirname') return { value: dirValue(posix.dirname(ctx.fileRel)), end: start + 1 };
  if (token.v === '__filename') return { value: pathValue(ctx.fileRel), end: start + 1 };
  if (token.v === 'import' && isPunct(tokens[start + 1], '.') && isWord(tokens[start + 2], 'meta')) return importMetaValue(tokens, start, ctx);
  if (token.v === 'PATHS' && isPunct(tokens[start + 1], '.') && isWord(tokens[start + 2], 'slashdo')) return slashdoPathsValue(start, ctx);
  if (token.v === 'process' && isPunct(tokens[start + 1], '.')) return processValue(tokens, match, start, ctx);
  return null;
}

function importMetaValue(tokens, start, ctx) {
  const member = isPunct(tokens[start + 3], '.') ? tokens[start + 4] : undefined;
  if (isWord(member, 'url', 'filename')) return { value: pathValue(ctx.fileRel), end: start + 5 };
  if (isWord(member, 'dirname')) return { value: dirValue(posix.dirname(ctx.fileRel)), end: start + 5 };
  return { value: UNKNOWN, end: start + 3 };
}

/** `PATHS.slashdo` imported from the repository's paths module, unshadowed and unmocked; else null. */
function slashdoPathsValue(start, ctx) {
  const scopes = scopesOf(ctx);
  const imported = ctx.imports.get('PATHS');
  if (imported === undefined || imported.name !== 'PATHS' || !/(?:^|\/)(?:fileUtils|paths)\.js$/.test(imported.spec)
    || scopes.shadowed('PATHS') || ctx.mocksSpecifier?.(imported.spec)) return null;
  ctx.shared.trustLog.push(imported.spec);
  return { value: dirValue('lib/slashdo'), end: start + 3 };
}

function processValue(tokens, match, start, ctx) {
  if (isWord(tokens[start + 2], 'cwd') && tokens[start + 3]?.v === '(') return { value: dirValue(ctx.cwdRel), end: closeOf(match, start + 3) };
  if (isWord(tokens[start + 2], 'execPath')) return { value: NODE, end: start + 3 };
  if (!isWord(tokens[start + 2], 'env')) return { value: UNKNOWN, end: start + 1 };
  let end = start + 3;
  const name = isPunct(tokens[end], '.') && tokens[end + 1]?.t === 'id' ? tokens[end + 1].v : null;
  if (name !== null) end += 2;
  return { value: name === 'HOME' || name === 'USERPROFILE' ? HOME : variableValue(UNBOUNDED), end };
}

/** A call of a plain name at `start`: a path builder, a temp/home directory, a trusted guard or id, else unknown. */
function callPrimary(tokens, match, start, ctx, depth) {
  const name = tokens[start].v;
  const end = closeOf(match, start + 1);
  if (name === 'homedir') return { value: HOME, end };
  if (['tmpdir', 'mkdtempSync', 'mkdtemp'].includes(name)) return { value: EXTERNAL, end };
  const args = evaluateArgs(tokens, match, start + 1, ctx, depth);
  if (args === null) return { value: UNKNOWN, end };
  if (PATH_JOIN.has(name)) return { value: foldJoin(args, name === 'join'), end };
  if (PATH_DIRNAME.has(name)) return { value: dirnameValue(args[0] ?? UNKNOWN), end };
  if (PATH_IDENTITY.has(name)) return { value: args[0] ?? UNKNOWN, end };
  if (name === 'URL') return { value: urlValue(args), end };
  // Both are trusted as the imported binding only: a parameter or a local of that name is anything.
  if ((name === 'pathWithin' && ctx.guarded) || (name === 'randomUUID' && ctx.uuid && args.length === 0)) return { value: trustedCallValue(name, args, ctx), end };
  return { value: UNKNOWN, end };
}

function trustedCallValue(name, args, ctx) {
  // Shadowed or mocked, the guard guards nothing: its directory is only where the path starts.
  if (scopesOf(ctx).shadowed(name) || (name === 'pathWithin' && ctx.replaced.guard)) {
    return name === 'pathWithin' && args[0]?.k === 'path' ? partialPath(args[0], args[0].v, UNBOUNDED) : UNKNOWN;
  }
  // A guard call is a path this file has the guard's word for, literal segments included: a
  // replaced guard returns what it likes. A UUID counts only where a read is contained by it
  // (`trusts`): a lock file named with one is no read.
  if (name === 'pathWithin') ctx.shared.trusted.guard = true;
  // A UUID is 36 characters of hex and dashes: a name, wherever it is joined.
  return name === 'pathWithin' ? guardedJoin(args) : GENERATED_NAME;
}

/**
 * A bare identifier. An enclosing parameter or loop variable shadows a
 * module-level binding of the same name, and evaluates to what the source
 * proves about it (`createScopes`): an entry of a directory listing, one of a
 * known set of literal values (substituted when `ctx.overrides` names it), or
 * unknown, named after the helper it is a parameter of.
 */
export function identifierValue(token, ctx, depth) {
  if (ctx.unscoped) return bindingValue(token.v, ctx, depth);
  const scopes = scopesOf(ctx);
  const binder = scopes.binderAt(token.v, token.i);
  if (binder === null && token.v === 'delimiter' && ctx.delimiter && !scopes.shadowed('delimiter')) return DELIMITER;
  if (binder === null) return bindingValue(token.v, ctx, depth);
  if (ctx.overrides?.has(binder)) return str(ctx.overrides.get(binder));
  const domain = scopes.domainOf(binder);
  if (domain !== null) ctx.shared.trustLog.push(...binder.trusts);
  if (domain === LISTED) return LISTED_NAME;
  if (domain === MIGRATION_LISTED) return MIGRATION_LISTED_NAME;
  if (domain === DB_MIGRATION_LISTED) return DB_MIGRATION_LISTED_NAME;
  if (domain !== null) return variableValue({ open: true, vars: [binder] });
  const via = binder.kind === 'param' && binder.role?.kind === 'named' ? binder.role.nameToken.v : null;
  const paramPath = scopes.pathOf(binder);
  if (paramPath !== null) return paramPath;
  // Named like a module-level path (`function read(ROOT)` beside `const ROOT = …`): the constant when
  // every call passes one path, which is then that path; otherwise somewhere the source does not say,
  // starting from the constant the name was read as before binders were modelled. Never nothing.
  // A default the calls do not all agree with is that starting point too: the read stays open, never dropped.
  const outer = binder.fallback ?? bindingValue(token.v, ctx, depth);
  if (outer.k === 'path') return partialPath(outer, outer.v, { open: true, via });
  return via === null ? UNKNOWN : variableValue({ open: true, via });
}

/** The evaluated initializer of a `const`/`let`/`var` binding, memoized per file. */
export function bindingValue(name, ctx, depth = 0) {
  const bound = ctx.bindings.get(name);
  if (bound === undefined) {
    const imported = importedConstant(name, ctx, scopesOf(ctx).shadowed);
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
  const scopes = scopesOf(ctx);
  // Nor is it when another scope declares the name again (`const { name } = row`, an import) or binds it
  // as a parameter or loop variable: which one a use means is scoping this pass models only roughly.
  const declarator = ctx.tokens[bound - 2];
  const constant = isWord(ctx.tokens[bound - 3], 'const');
  const rebound = !ctx.unscoped && (initial.k === 'str' || isVariableText(initial)) && (scopes.declaredTwice(name) || scopes.hasBinder(name)
    || (!constant && (scopes.writtenIn(name, () => true, declarator) || scopes.hiddenWrite(name))));
  const value = rebound ? UNKNOWN : initial;
  ctx.bindingValues.set(name, { value, trusts: ctx.shared.trustLog.slice(logged) });
  return value;
}

/** `const|let|var NAME =` initializers by name; a name bound twice is ambiguous and dropped. */
export function collectBindings(tokens, match) {
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
export function widestPathExpression(tokens, match, index, guarded = false) {
  const start = widenPathStart(tokens, match, index, guarded);
  const before = tokens[start - 1];
  if (isPunct(before, '=')) return null;
  if (isPunct(before, ':') && ['id', 's'].includes(tokens[start - 2]?.t) && ['cwd', 'root', 'dir', 'base'].includes(tokens[start - 2].v)) {
    return { index: start, consumer: null, walk: false, bare: start === index, option: tokens[start - 2].v, member: true };
  }
  const parent = enclosingOpen(tokens, match, start);
  const { consumer, walk } = pathConsumer(tokens, match, parent);
  const keyed = isPunct(before, ':') && (tokens[start - 2]?.t === 'id' || tokens[start - 2]?.t === 's') && isPunct(tokens[start - 3], '{', ',');
  const shorthand = start === index && isPunct(before, '{', ',');
  const member = parent !== null && tokens[parent].v === '{' && (keyed || shorthand);
  // Unsupported path values can be passed inside an options object or array.
  const recipient = consumer ?? enclosingRecipient(tokens, match, parent, member);
  return { index: start, consumer, walk, bare: start === index, option: null, member, recipient };
}

/** The start of the widest expression around `index` that still builds a path: `+` chains and path-building calls. */
function widenPathStart(tokens, match, index, guarded) {
  let start = index;
  for (;;) {
    start = plusChainStart(tokens, match, start);
    const parent = enclosingOpen(tokens, match, start);
    if (parent === null || tokens[parent].v !== '(') return start;
    // A group does not consume the path. Look for the call or option around it.
    if (groupsAt(tokens, parent) && parent + 1 === start) { start = parent; continue; }
    if (!buildsPath(calleeName(tokens, parent), guarded)) return start;
    start = calleeStart(tokens, parent);
  }
}

function plusChainStart(tokens, match, from) {
  let start = from;
  while (isPunct(tokens[start - 1], '+')) {
    const operand = tokens[start - 2];
    if (!operand) break;
    if (isPunct(operand, ')') && match[start - 2] !== undefined) start = calleeStart(tokens, match[start - 2]);
    else start -= 2;
  }
  return start;
}

const buildsPath = (name, guarded) => name === 'URL' || PATH_JOIN.has(name) || PATH_DIRNAME.has(name) || PATH_IDENTITY.has(name) || (guarded && name === 'pathWithin');

/** What consumes a path whose expression is directly inside `parent`: a call, or a spawn's argument array. */
function pathConsumer(tokens, match, parent) {
  if (parent !== null && tokens[parent].v === '(') {
    const consumer = calleeName(tokens, parent);
    return { consumer, walk: consumer !== null && SPAWN_CALLEES.has(consumer) };
  }
  if (parent !== null && tokens[parent].v === '[') {
    const outer = enclosingOpen(tokens, match, parent);
    const walk = outer !== null && tokens[outer].v === '(' && SPAWN_CALLEES.has(calleeName(tokens, outer) ?? '');
    return { consumer: walk ? calleeName(tokens, outer) : null, walk };
  }
  return { consumer: null, walk: false };
}

/** The call an object member or array element is handed to, through any nesting of literals; else null. */
function enclosingRecipient(tokens, match, parent, member) {
  if (parent === null || !(member || tokens[parent].v === '[')) return null;
  let outer = enclosingOpen(tokens, match, parent);
  while (outer !== null && isPunct(tokens[outer], '{', '[')) outer = enclosingOpen(tokens, match, outer);
  return outer !== null && isPunct(tokens[outer], '(') ? calleeName(tokens, outer) : null;
}
