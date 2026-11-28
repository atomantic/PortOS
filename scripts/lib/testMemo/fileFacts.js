/**
 * Per-file extraction for the test memo (`extractFileFacts`): module edges,
 * path and directory inputs, cwd-relative literals, spawned tools and the
 * reasons one source file fails closed, before any filesystem lookup. Each
 * sink and phase is a helper over one per-file extraction state.
 */

import { posix } from 'node:path';
import { staticEdges } from '../sourceTokens.js';
import {
  CALL_SITE_CHECKED_READERS, DIR_READ_CALLEES, GIT_FIXTURE_MARKER, GIT_SPAWN, JS_EXT, MOCK_CALLEES, MOCK_REGISTER_CALLEES, NEVER_MARKER,
  NON_READ_CALLEES, PATH_JOIN, PATH_LIKE_LITERAL, READ_CALLEES, SOURCE_READERS, SPAWN_CALLEES,
} from './constants.js';
import {
  bindingValue, collectBindings, evaluate, evaluateArgs, importsNamed, mockedSpecifiers, namedImports, namedInImportList, replacedSources, widestPathExpression,
} from './evaluator.js';
import { CLIMBS, isCryptoModule, isGuardModule, normalizeRel, openReadReason, unfollowedReason, variableCombinations } from './pathValues.js';
import { gitFixtureDeclaration, startsGitThroughName } from './gitFixture.js';
import { packageNameOf } from './specifiers.js';
import { isPunct, isWord, matchBrackets, tokenArrays, tokenizeModule } from './tokens.js';

const PYTHON_NAME = /^(?:py|python3?|py(?:thon)?(?:Bin|Path|Cmd|Exe))$/i;

/**
 * Everything one source file contributes, before any filesystem lookup:
 * module edges, path inputs, directory inputs, cwd-relative literals, and the
 * reasons it fails closed. Pure, but for `exportedConstant(spec, name)`: the
 * analyzer's reading of another module's literal exports (`literalExports`),
 * so an imported constant names its files; without it an import is unknown.
 */
export function extractFileFacts(src, { fileRel, cwdRel, replaced = null, exportedConstant = null }) {
  const facts = emptyFacts(src);
  let tokens;
  try { tokens = tokenizeModule(src, fileRel); } catch (error) {
    facts.unresolvedEdges.push(`unparseable source: ${error.message}`);
    facts.unresolvedInputs.push(`unparseable source: ${error.message}`);
    return facts;
  }
  const match = matchBrackets(tokens);
  const ctx = fileContext(src, tokens, match, { fileRel, cwdRel, replaced, exportedConstant }, facts);
  for (const spec of staticEdges(tokens, match)) facts.edges.push({ spec, kind: 'static' });
  // `valueTrusts`: the modules the values `valuesAt` last returned came through.
  const x = { fileRel, facts, tokens, match, ctx, valueTrusts: [], ...callNames(ctx) };
  scanCodeText(x);
  // These reads are keyed at their call sites, including calls nested in template holes.
  if (/\bread(?:Server|Client)Source\b/.test(src)) scanSourceReaders(x);
  const checkedBodies = checkedReaderBodies(x);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!checkedBodies.some(([from, to]) => from < i && i < to)) scanToken(x, i);
  }
  if (GIT_FIXTURE_MARKER.test(src)) noteGitFixture(x, src);
  if (!facts.git && facts.gitFixtureProblem === null && startsGitThroughName(x)) facts.git = true;
  return facts;
}

function emptyFacts(src) {
  return {
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
    gitFixture: false, // the file declares its git repositories fixtures and nothing in it says otherwise (`gitFixture.js`)
    gitFixtureProblem: null, // why a declaration it does make was refused
    trusts: new Set(), // specifiers of the modules whose constants named a read: a member that mocks one voids it (`gather`)
  };
}

/** The evaluation context of one file; also records the sources it mocks (`replaces`) and those its reads rely on (`trusted`). */
function fileContext(src, tokens, match, { fileRel, cwdRel, replaced, exportedConstant }, facts) {
  const ctx = { fileRel, cwdRel, tokens, match, bindings: collectBindings(tokens, match), bindingValues: new Map(), resolving: new Set() };
  ctx.imports = namedImports(tokens, match);
  // Asked once per imported constant a read names; a whole-file scan each time cost the planner seconds (#17617).
  let mocked = null;
  ctx.mocksSpecifier = (spec) => (mocked ??= mockedSpecifiers(tokens, match)).has(spec);
  ctx.exportedConstant = exportedConstant && ((spec, name) => (
    ctx.mocksSpecifier(spec) ? null : exportedConstant(spec, name)
  ));
  // A source this file or the workspace setup (`replaced`) mocks is trusted for nothing.
  const own = replacedSources(src, fileRel, { tokens, match });
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
  return ctx;
}

/**
 * `const load = createRequire(import.meta.url)` makes `load(...)` a native require;
 * `const pyBin = resolveTestPython()` makes `pyBin` the python interpreter.
 */
function callNames(ctx) {
  const boundTo = (callee) => new Set([...ctx.bindings].filter(([, at]) => ctx.tokens[at]?.t === 'id' && ctx.tokens[at].v === callee && ctx.tokens[at + 1]?.v === '(').map(([name]) => name));
  return { requireNames: new Set(['require', ...boundTo('createRequire')]), pythonNames: boundTo('resolveTestPython') };
}

/** Facts read from the whole token text: a git spawn, `import.meta.glob`, the Chrome the browser suites resolve. */
function scanCodeText({ tokens, facts }) {
  const code = tokens.map((t) => (t.t === 's' ? `'${t.v}'` : t.t === 'tpl' ? `\`${t.quasis.join('${}')}\`` : t.t === 'id' || t.t === 'p' ? t.v : '0')).join(' ');
  if (GIT_SPAWN.test(code)) facts.git = true;
  if (/\bimport \. meta \. glob\b/.test(code)) facts.unresolvedEdges.push('import.meta.glob');
  // The browser suites resolve Chrome through CHROME_PATH or playwright-core.
  if (/\bCHROME_PATH\b/.test(code) || facts.edges.some((edge) => packageNameOf(edge.spec) === 'playwright-core')) facts.tools.add('chrome');
  // The suites pass a resolved path to execFile, so there may be no literal command.
  if (/\bawait findFfmpeg \(/.test(code)) facts.tools.add('ffmpeg');
}

/**
 * A file that declares its git repositories fixtures: the declaration stands
 * only when at least one git call was read and none contradicts it.
 */
function noteGitFixture({ tokens, match, ctx, facts }, src) {
  const { declared, problem, calls } = gitFixtureDeclaration({ src, tokens, match, ctx });
  if (!declared) return;
  if (calls > 0) facts.git = true;
  facts.gitFixtureProblem = calls === 0 ? 'no git call the analyzer can read' : problem;
  facts.gitFixture = facts.gitFixtureProblem === null;
}

function literalArg(source, brackets, open) {
  const first = source[open + 1];
  const second = source[open + 2];
  if (!first || brackets[open] === undefined) return { kind: 'none' };
  const endsArg = second?.t === 'p' && (second.v === ',' || second.v === ')');
  if (first.t === 's' && endsArg) return { kind: 'literal', value: first.v };
  if (first.t === 'tpl' && first.exprs.length === 0 && endsArg) return { kind: 'literal', value: first.quasis[0] };
  if (first.t === 'p' && first.v === ')') return { kind: 'none' };
  return { kind: 'expr', index: open + 1 };
}

/** The literal last segment of `join(<anything>, 'name')`, followed through one binding; else null. */
function joinedBasename({ tokens, match, ctx }, index) {
  let at = index;
  for (let hop = 0; hop < 4 && tokens[at]?.t === 'id' && ctx.bindings.has(tokens[at].v) && tokens[at + 1]?.v !== '('; hop += 1) at = ctx.bindings.get(tokens[at].v);
  if (tokens[at]?.t === 'id' && tokens[at + 1]?.v === '.' && tokens[at + 2]?.t === 'id') at += 2; // path.join(
  if (tokens[at]?.t !== 'id' || !PATH_JOIN.has(tokens[at].v) || tokens[at + 1]?.v !== '(') return null;
  const last = (evaluateArgs(tokens, match, at + 1, ctx, 0) ?? []).at(-1);
  // Only an explicit file extension proves a file: a bare name may be a directory Node resolves
  // through index.js or package.json main, which a basename match would not collect.
  return last?.k === 'str' && /\.(?:c?js|mjs|json|node)$/.test(last.v) ? posix.basename(last.v) : null;
}

/**
 * The values of the expression at `index`. A path whose variable parts each
 * have a known set of literal values is evaluated once per combination, so
 * `read('../../client/x.js')` contributes that file and not a directory the
 * read never touches. A helper that is never called contributes nothing.
 */
function valuesAt(x, index) {
  const { tokens, match, ctx } = x;
  const logged = ctx.shared.trustLog.length;
  const { value } = evaluate(tokens, match, index, ctx);
  x.valueTrusts = ctx.shared.trustLog.slice(logged);
  if (value.k === 'unknown' || value.k === 'tail') {
    // Unknown text read as a whole path is runtime data and no input. Where it is unknown only because
    // a parameter or a loop variable shares a constant's name (`unscoped`: every name is its
    // module-level binding, as before binders were modelled), what the constant names stays an input:
    // the scope rules may refuse a read, never drop one.
    const before = evaluate(tokens, match, index, { ...ctx, unscoped: true, bindingValues: new Map(), resolving: new Set() }).value;
    x.valueTrusts = ctx.shared.trustLog.slice(logged);
    if (before.k !== 'unknown' && before.k !== 'tail') return [before];
  }
  const combinations = value.k === 'path' && value.partial && value.open ? variableCombinations(value.vars) : null;
  // `a\\b` is one name on POSIX and two segments on Windows, and `C:` is a drive there: no single file to key.
  if (combinations === null || combinations.some((chosen) => [...chosen.values()].some((text) => /\\|^[A-Za-z]:/.test(text)))) return [value];
  // `resolved`: a path with a variable part is a read whoever consumes it, and stays one with the variable filled in.
  return combinations.map((chosen) => ({ ...evaluate(tokens, match, index, { ...ctx, overrides: chosen, bindingValues: new Map(), resolving: new Set() }).value, resolved: true }));
}

/** Only a value that is keyed depends on the modules it came through (`valueTrusts`): note them for `gather`. */
function noteValueTrusts(x) {
  for (const spec of x.valueTrusts) x.facts.trusts.add(spec);
}

/** A contained path relies on the sources that contain it (`trust`). */
function trustContained(facts, value) {
  if (value.partial && !value.open) for (const source of value.trust ?? []) facts.trusted[source] = true;
}

// ---------------------------------------------------------------------------
// Recording one evaluated value as an input.
// ---------------------------------------------------------------------------

function record(x, value, { walk = false, consumer = null, option = null, member = false, recipient = consumer } = {}) {
  const { facts } = x;
  // A search-path entry is where a program the string is handed to is found and run: a directory
  // handed to a spawn (its whole tree is an input), whatever the string is then given to.
  if (value.k === 'search') {
    for (const entry of [...value.entries, value.tail]) if (entry.k === 'path') record(x, entry, { walk: true, consumer: 'spawn' });
    return;
  }
  if (option !== null) { recordOption(x, value, option); return; }
  if (value.k === 'home') {
    if (!(consumer !== null && NON_READ_CALLEES.has(consumer))) facts.localReads.push('~');
    return;
  }
  if (value.k === 'str') { recordCwdLiteral(x, value, walk); return; }
  if (value.k !== 'path') return;
  if (value.unfollowed) {
    // An unsupported operation may produce ordinary text. Refuse only when a
    // sink or an unmodelled call could read through the result.
    if (recipient !== null && (!NON_READ_CALLEES.has(recipient) || SPAWN_CALLEES.has(recipient) || READ_CALLEES.has(recipient))) {
      facts.unresolvedInputs.push(unfollowedReason(value));
    }
    return;
  }
  if (consumer !== null && NON_READ_CALLEES.has(consumer)) return;
  noteValueTrusts(x);
  // A glob pattern is no file: it reads every match under the directory in front of its first wildcard.
  if (consumer !== null && /^glob/i.test(consumer) && !value.partial && /[*?[\]{}]/.test(value.v)) { recordGlob(facts, value, walk); return; }
  if (value.partial || value.isDir) { recordDirectory(facts, value, { walk, consumer, member }); return; }
  facts.paths.push({ rel: value.v, walk: walk || JS_EXT.test(value.v), read: consumer !== null && READ_CALLEES.has(consumer) });
}

/** A `cwd:`/`root:`/`dir:`/`base:` option: where a tool is rooted, which a real-browser key keys whole (`handedDirs`). */
function recordOption(x, value, option) {
  if (value.k !== 'path' || option === 'cwd') return;
  if (value.unfollowed) x.facts.handedProblems.add(unfollowedReason(value));
  else if (value.partial && value.open) x.facts.handedProblems.add(openReadReason(value.v, value.via));
  else { noteValueTrusts(x); trustContained(x.facts, value); x.facts.handedDirs.push(value.v); }
}

function recordCwdLiteral(x, value, walk) {
  if (value.v.startsWith('/') || /^[a-z]+:/i.test(value.v)) return;
  noteValueTrusts(x);
  x.facts.cwdLiterals.push({ value: value.v, walk, dir: false });
}

function recordGlob(facts, value, walk) {
  const literal = value.v.slice(0, value.v.search(/[*?[\]{}]/));
  const rel = normalizeRel(literal === '' || literal.endsWith('/') ? literal : posix.dirname(literal));
  facts.dirs.push({ rel, walk, guessed: true, open: CLIMBS.test(value.v.slice(literal.length)), via: null });
}

function recordDirectory(facts, value, { walk, consumer, member }) {
  // A complete directory handed to an unknown function (`resolveInstallRoot(join(__dirname, '..'))`)
  // or passed nowhere (`cwd || process.cwd()`) is a value. A partial path (variable
  // segments) or a directory handed to a read/spawn sink is a read of that tree.
  const read = value.partial || value.resolved === true || (consumer !== null && (READ_CALLEES.has(consumer) || SPAWN_CALLEES.has(consumer)));
  if (!read) {
    // `resolveClientBundler(repoRoot)` resolves the client workspace's bundler packages.
    if (consumer === 'resolveClientBundler') facts.handedDirs.push(normalizeRel(posix.join(value.v, 'client/node_modules')));
    else if (consumer !== null || member) facts.handedDirs.push(value.v);
    return;
  }
  const open = value.partial && value.open;
  trustContained(facts, value);
  for (const rel of open && value.outer !== undefined ? [value.v, value.outer] : [value.v]) facts.dirs.push({ rel, walk, guessed: value.partial, open, via: value.via ?? null, ...(value.filter ? { filter: value.filter } : {}) });
}

// ---------------------------------------------------------------------------
// Scanning the token stream for sinks and anchors.
// ---------------------------------------------------------------------------

function anchorInside(ctx, list) {
  return list.some((t) => (t.t === 'id' && (t.v === '__dirname' || t.v === '__filename' || t.v === 'import' || t.v === 'process'
    || (ctx.bindings.has(t.v) && bindingValue(t.v, ctx).k === 'path'))) || (t.t === 'tpl' && t.exprs.some((inner) => anchorInside(ctx, inner))));
}

function scanSourceReaders({ tokens, match, facts }) {
  for (const { arr, m } of tokenArrays(tokens, match)) {
    for (let i = 0; i < arr.length; i += 1) {
      const { t, v: name } = arr[i];
      const prev = arr[i - 1];
      if (t !== 'id' || !Object.hasOwn(SOURCE_READERS, name) || isWord(prev, 'function')) continue;
      if (isPunct(arr[i + 1], '(')) {
        const arg = literalArg(arr, m, i + 1);
        if (arg.kind === 'literal') facts.paths.push({ rel: normalizeRel(posix.join(SOURCE_READERS[name], arg.value)), walk: false, read: true });
        else if (arg.kind === 'expr') facts.unresolvedInputs.push(`${name}() with a non-literal path`);
      } else if (!isWord(prev, 'const', 'let', 'var') && !namedInImportList(arr, m, i) && !(isPunct(arr[i + 1], ':') && isPunct(prev, '{', ','))) {
        facts.unresolvedInputs.push(`${name} used other than by a direct call`);
      }
    }
  }
}

/**
 * The bodies of the source readers whose every call is checked by name (`scanSourceReaders`): what they
 * read is what their callers name, which those callers already contribute (or fail closed on).
 */
function checkedReaderBodies({ fileRel, tokens, match }) {
  const bodies = [];
  for (const name of CALL_SITE_CHECKED_READERS[fileRel] ?? []) {
    for (let i = 0; i + 2 < tokens.length; i += 1) {
      if (!isWord(tokens[i], 'function') || !isWord(tokens[i + 1], name) || !isPunct(tokens[i + 2], '(') || match[i + 2] === undefined) continue;
      const body = match[i + 2] + 1;
      if (isPunct(tokens[body], '{') && match[body] !== undefined) bodies.push([body, match[body]]);
    }
  }
  return bodies;
}

function scanToken(x, i) {
  const { tokens, ctx } = x;
  const token = tokens[i];
  if (token.t === 's') return; // a bare string is a name (a registry entry, an exclude glob), never a read
  if (token.t === 'tpl') {
    // `${ROOT}/docs/x.md`: the hole holds the anchor, the template is the expression.
    if (token.exprs.some((expr) => anchorInside(ctx, expr))) recordWidest(x, i);
    return;
  }
  if (token.t !== 'id') return;
  const open = isPunct(tokens[i + 1], '(') ? i + 1 : null;
  const isMember = isPunct(tokens[i - 1], '.', '?.');
  const onVi = isMember && isWord(tokens[i - 2], 'vi');
  // Module edges that the static pass cannot see.
  if ((token.v === 'import' || x.requireNames.has(token.v)) && open !== null && !isMember) scanModuleLoad(x, token.v, open);
  else if (onVi && open !== null && MOCK_CALLEES.has(token.v)) scanMockCall(x, token.v, open);
  // Sinks.
  else if (open !== null && SPAWN_CALLEES.has(token.v) && !onVi) scanSpawn(x, token.v, open);
  else if (open !== null && READ_CALLEES.has(token.v)) scanRead(x, token.v, open);
  else if (open !== null && token.v === 'toMatchFileSnapshot') scanFileSnapshot(x, open);
  // Anchors anywhere else: the widest path expression around them is an input.
  else if (isAnchorUse(x, i, open, isMember)) recordWidest(x, i);
}

function recordWidest(x, i) {
  const widest = widestPathExpression(x.tokens, x.match, i, x.ctx.guarded);
  if (widest !== null) for (const value of valuesAt(x, widest.index)) record(x, value, widest);
}

function isAnchorUse({ tokens, ctx }, i, open, isMember) {
  const token = tokens[i];
  const prev = tokens[i - 1];
  const isAnchor = token.v === '__dirname' || token.v === '__filename'
    || (!isMember && token.v === 'import' && tokens[i + 1]?.v === '.' && tokens[i + 2]?.v === 'meta')
    || (!isMember && token.v === 'process' && tokens[i + 1]?.v === '.' && tokens[i + 2]?.v === 'cwd')
    || (!isMember && open === null && ctx.bindings.has(token.v) && bindingValue(token.v, ctx).k === 'path');
  if (!isAnchor) return false;
  // The declared name itself (`const ROOT = …`) is not a use.
  if (isWord(prev, 'const', 'let', 'var')) return false;
  // Nor is a property key that happens to share a binding's name (`{ root: client }` beside `const root`).
  return !(isPunct(tokens[i + 1], ':') && isPunct(prev, '{', ','));
}

/** `import(…)`, `require(…)` or a `createRequire` loader. */
function scanModuleLoad(x, name, open) {
  const kind = name === 'import' ? 'dynamic' : 'require';
  const arg = literalArg(x.tokens, x.match, open);
  if (arg.kind === 'literal') { x.facts.edges.push({ spec: arg.value, kind }); return; }
  if (arg.kind === 'none') return;
  for (const value of valuesAt(x, arg.index)) recordModuleValue(x, value, { name, kind, index: arg.index });
}

function recordModuleValue(x, value, { name, kind, index }) {
  const { facts } = x;
  if (value.k === 'path' || value.k === 'str') noteValueTrusts(x);
  if (value.k === 'path') {
    if (value.unfollowed) { facts.unresolvedInputs.push(unfollowedReason(value)); return; }
    // A complete path: a file, a directory, or a name the loader completes (`./mod` is `./mod.js`).
    if (!value.partial) { facts.paths.push({ rel: value.v, walk: true }); return; }
    facts.dirs.push({ rel: value.v, walk: true, ...(value.filter ? { filter: value.filter } : {}) });
    trustContained(facts, value);
    if (!value.open) return;
    // Unbounded, the module may be anywhere, under the prefix or not: an edge the source does not name.
    if (value.outer !== undefined) facts.dirs.push({ rel: value.outer, walk: true });
  } else {
    // `require(PACKAGE_CONSTANT)`: a module-level string is a specifier like a literal one.
    if (value.k === 'str') { facts.edges.push({ spec: value.v, kind }); return; }
    // `require(join(<unknown dir>, 'ecosystem.config.cjs'))`: the directory is a parameter or an
    // install root, the basename is fixed, so every tracked file of that name is an input
    // (tests only load in-repo files, so keying by tracked basename covers the real target).
    const scoped = kind === 'require' ? joinedBasename(x, index) : null;
    if (scoped !== null) { facts.scopedNames.push(scoped); return; }
  }
  if (kind === 'require') facts.nativeUnresolved = true;
  facts.unresolvedEdges.push(`${name}() with a non-literal specifier`);
}

/** `vi.mock(…)` and its family. */
function scanMockCall(x, name, open) {
  const arg = literalArg(x.tokens, x.match, open);
  if (arg.kind === 'literal') x.facts.edges.push({ spec: arg.value, kind: MOCK_REGISTER_CALLEES.has(name) ? 'mock' : 'mock-import' });
  else if (arg.kind === 'expr' && isWord(x.tokens[arg.index], 'import')) return; // vi.mock(import('./x')): the import() pass records it
  else x.facts.unresolvedEdges.push(`vi.${name}() with a non-literal specifier`);
}

function scanSpawn(x, name, open) {
  const { tokens, match, facts } = x;
  const arg = literalArg(tokens, match, open);
  if (arg.kind === 'literal') noteLiteralProgram(facts, arg.value);
  else if (arg.kind === 'expr') scanSpawnedProgram(x, name, open, arg.index);
  for (let j = open + 1; j < match[open]; j += 1) {
    const literal = tokens[j].t === 's' ? tokens[j].v : tokens[j].t === 'tpl' && tokens[j].exprs.length === 0 ? tokens[j].quasis[0] : null;
    if (literal !== null && JS_EXT.test(literal) && PATH_LIKE_LITERAL.test(literal)) facts.cwdLiterals.push({ value: literal, walk: true, dir: false });
  }
}

function noteLiteralProgram(facts, command) {
  const program = posix.basename(command.split(/\s+/)[0]);
  if (program === 'git') facts.git = true;
  else if (/^python3?$/.test(program)) facts.tools.add('python');
  else if (program === 'ffmpeg' || program === 'ffprobe') facts.tools.add('ffmpeg');
}

function scanSpawnedProgram(x, name, open, index) {
  const { tokens, match, facts } = x;
  const { value } = evaluate(tokens, match, index, x.ctx);
  for (const program of valuesAt(x, index)) if (program.k === 'path') record(x, program, { walk: true, consumer: name });
  // `spawn(process.env.PORTOS_TEST_PYTHON || 'python3', …)`, `spawn(pyBin, …)` with
  // `const pyBin = resolveTestPython()`: the program expression names python.
  if (namesPython(x, open, index)) facts.tools.add('python');
  // An unknown program handed a .py file is an interpreter the key cannot name.
  else if ((value.k === 'unknown' || value.k === 'ext' || value.k === 'tail') && handsPythonSidecar(tokens, match, open)) {
    facts.unresolvedInputs.push('spawns an unknown program with a python sidecar');
  }
}

function namesPython({ tokens, match, pythonNames }, open, index) {
  for (let j = index; j < match[open] && !isPunct(tokens[j], ','); j += 1) {
    const t = tokens[j];
    if ((t.t === 'id' && (t.v === 'PORTOS_TEST_PYTHON' || pythonNames.has(t.v) || PYTHON_NAME.test(t.v))) || (t.t === 's' && /^python3?$/.test(t.v))) return true;
  }
  return false;
}

function handsPythonSidecar(tokens, match, open) {
  for (let j = open + 1; j < match[open]; j += 1) {
    const literal = tokens[j].t === 's' ? tokens[j].v : tokens[j].t === 'tpl' ? tokens[j].quasis.join('') : '';
    if (/\.py$/.test(literal)) return true;
  }
  return false;
}

function scanRead(x, name, open) {
  const arg = literalArg(x.tokens, x.match, open);
  if (arg.kind === 'literal') {
    if (!(arg.value.startsWith('/') || /^[a-z]+:/i.test(arg.value))) x.facts.cwdLiterals.push({ value: arg.value, walk: false, dir: DIR_READ_CALLEES.test(name) });
  } else if (arg.kind === 'expr') {
    // An unanchored variable is a temp path or runtime data, not a repository read.
    for (const value of valuesAt(x, arg.index)) record(x, value, { consumer: name });
  }
}

function scanFileSnapshot(x, open) {
  const arg = literalArg(x.tokens, x.match, open);
  if (arg.kind === 'literal') x.facts.paths.push({ rel: normalizeRel(posix.join(posix.dirname(x.fileRel), arg.value)), walk: false });
  else if (arg.kind === 'expr') for (const value of valuesAt(x, arg.index)) record(x, value, { consumer: 'toMatchFileSnapshot' });
}
