/**
 * The test memo's closure analysis and key computation over an abstract
 * filesystem (`createTestMemoAnalyzer`): resolves each file's extracted facts
 * (`fileFacts.js`) against the tree, folds a test's closure into a verdict,
 * and computes its floor and recorded keys, related-selection reach and the
 * workspace base every key shares.
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { FIXTURE_OWNERS, getAlwaysRunTests } from '../ciPlanRules.js';
import { isGuardTest } from '../guardScanners.js';
import {
  BROWSER_SERVED_SHARED_INPUTS, DIRECTORY_INPUT_LIMIT, GIT_PACKAGE, GUARD_SUFFIX_REASON, IGNORED_INPUT_PREFIXES, JS_EXT, RECORD_DIGEST_LENGTH,
  SKIP_TREE_DIRS, TEST_MEMO_ENV, TEST_MEMO_NEVER, UNRECORDED_SERVER_CALL, WORKSPACE_BASE_INPUTS, WORKSPACE_SELECTION_MODULES, WORKSPACE_SETUP_ENTRIES,
} from './constants.js';
import { collectBindings, evaluate, literalExports } from './evaluator.js';
import { extractFileFacts } from './fileFacts.js';
import { normalizeRel, openReadReason } from './pathValues.js';
import { isBuiltin, packageNameOf, resolveRelativeSpecifier } from './specifiers.js';
import { expressionEnd, isPunct, isWord, matchBrackets, tokenizeModule } from './tokens.js';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * The git rule and the oversized-tree rule apply to the test itself and to
 * repository tooling under `scripts/`; a product or library module's git use
 * is controlled by the test that calls it.
 */
const gitRuleApplies = (rel, testRel) => rel === testRel || rel.startsWith('scripts/');

const outsideRepository = (rel) => rel.startsWith('../') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel);
const ignoredInput = (rel) => IGNORED_INPUT_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix));
const localState = (target) => target === 'data' || target.startsWith('data/');
const underGit = (rel) => rel === '.git' || rel.startsWith('.git/');

/**
 * The analyzer over an abstract filesystem (`read(rel) -> Buffer|null`,
 * `kind(rel) -> 'file'|'dir'|null`, `list(rel) -> string[]`), so the whole
 * thing is unit-testable from an in-memory tree.
 *
 * `listFiles` returns every working-tree file git does not ignore
 * (repo-relative posix paths), or null when it cannot say. It is asked at
 * most once per analyzer and only lets a directory input past
 * `DIRECTORY_INPUT_LIMIT` be keyed instead of failing closed (`listedTree`).
 *
 * `acceptVerdictsFrom` lists other run settings (`{ label, env, caseFilter }`,
 * `env` overriding this run's values) whose green verdict also proves this
 * run's cases. Each memoizable verdict then carries `acceptedKeys`: the key
 * those settings would compute for the same inputs, differing only in the
 * environment lines. They are lookup keys only; entries are written under
 * `key` alone. The caller owns the claim that the other run's cases include
 * this run's (`browserProfileAcceptedVerdicts`).
 */
export function createTestMemoAnalyzer({ fs, workspaceRel, env = {}, platform = process.platform, arch = process.arch, nodeVersion = process.versions.node, toolVersion = () => null, caseFilter = [], acceptVerdictsFrom = [], listFiles = null }) {
  const host = { nodeVersion, platform, arch };
  const a = {
    fs,
    workspaceRel,
    toolVersion,
    listFiles,
    hashes: new Map(),
    facts: new Map(),
    trees: new Map(),
    listedTrees: new Map(),
    dataTrees: new Map(),
    packages: new Map(),
    exportedLiterals: new Map(), // module -> its literal exports (`literalExports`)
    exportedPaths: new Map(), // module -> its complete path exports (`export const X = join(__dirname, ...)`)
    byName: null,
    listing: undefined, // undefined until first asked; null when git cannot list the tree
    setupReplaced: null,
    environmentLines: environmentLinesFor(env, caseFilter, host),
    // Node, platform and arch stay this run's: only the env and case filter may differ.
    acceptedEnvironments: acceptVerdictsFrom.map(({ label, env: overrides, caseFilter: otherFilter }) => (
      { label, lines: environmentLinesFor({ ...env, ...overrides }, otherFilter, host) })),
  };
  return {
    analyzeTest: (testRel, options) => analyzeTest(a, testRel, options),
    closureOf: (entry, testRel, stop, options) => closureOf(a, entry, testRel, stop, options),
    fileHash: (rel) => fileHash(a, rel),
    moduleDigest: (rel) => moduleDigest(a, rel),
    workspaceBase: (roots, setupEntries) => workspaceBase(a, roots, setupEntries),
    factsFor: (rel) => factsFor(a, rel),
  };
}

function environmentLinesFor(runEnv, runCaseFilter, { nodeVersion, platform, arch }) {
  return [
    `node ${nodeVersion} ${platform} ${arch}`,
    ...TEST_MEMO_ENV.map((name) => `env ${name} ${runEnv[name] === undefined ? '<unset>' : runEnv[name]}`),
    // Arguments that decide which cases of a file run (a browser profile's name
    // pattern). A green verdict covers only the cases that ran, so the filter is
    // an input; an unfiltered run adds no line and keeps its keys.
    ...runCaseFilter.map((arg) => `case-filter ${arg}`),
  ];
}

function fileHash(a, rel) {
  if (a.hashes.has(rel)) return a.hashes.get(rel);
  const bytes = a.fs.read(rel);
  const digest = bytes === null ? null : sha256(bytes);
  a.hashes.set(rel, digest);
  return digest;
}

/** The truncated content digest a v2 memo record stores per loaded module; null for a missing file. */
const moduleDigest = (a, rel) => fileHash(a, rel)?.slice(0, RECORD_DIGEST_LENGTH) ?? null;

// ---------------------------------------------------------------------------
// Trees: directory inputs, from a walk or the repository listing.
// ---------------------------------------------------------------------------

/**
 * Sorted files under `dirRel`, or null when the collected set exceeds the
 * limit. `nameRe` keeps only direct children whose basename matches; other
 * names are not counted, so a directory past the limit can still contribute
 * a small explicit set (the Python requirement pins under `scripts/`).
 */
function tree(a, dirRel, nameRe = null) {
  const cacheKey = nameRe ? `${dirRel}\0${nameRe.source}\0${nameRe.flags}` : dirRel;
  if (a.trees.has(cacheKey)) return a.trees.get(cacheKey);
  const files = [];
  const walk = (dir) => {
    for (const name of a.fs.list(dir).sort()) {
      if (SKIP_TREE_DIRS.has(name) || (dir === '' && name === 'data')) continue;
      const rel = dir === '' ? name : `${dir}/${name}`;
      const kind = a.fs.kind(rel);
      if (kind === 'dir') {
        if (!nameRe) walk(rel);
      } else if (kind === 'file' && (!nameRe || nameRe.test(name))) files.push(rel);
      if (files.length > DIRECTORY_INPUT_LIMIT) throw new RangeError('tree too large');
    }
  };
  let result = files;
  try { walk(dirRel); } catch (error) { if (!(error instanceof RangeError)) throw error; result = null; }
  a.trees.set(cacheKey, result);
  return result;
}

/**
 * The files of a directory past the limit, from the repository listing
 * instead of a walk. Null (the caller fails closed) when there is no
 * listing; for a directory the listing has no file in (an ignored tree:
 * installs, build output, machine-local state); and for one holding an
 * entry the listing does not enumerate (a submodule or nested repository
 * is a single entry whatever it contains).
 *
 * The listing includes untracked files a commit would pick up, so a new
 * source file moves the key before it is ever staged. A listed path that
 * is gone from the working tree is left out, which changes the set.
 * Git-ignored files are outside the key here, as `.env` files and installs
 * are outside every key.
 */
function listedTree(a, dirRel) {
  if (!a.listFiles) return null;
  if (a.listedTrees.has(dirRel)) return a.listedTrees.get(dirRel);
  if (a.listing === undefined) {
    const all = a.listFiles();
    a.listing = Array.isArray(all) ? [...new Set(all.map((rel) => rel.replace(/\/+$/, '')))].sort() : null;
  }
  let files = null;
  if (a.listing !== null) {
    const prefix = `${dirRel}/`;
    files = [];
    for (const rel of a.listing) {
      if (!rel.startsWith(prefix)) continue;
      const kind = a.fs.kind(rel);
      if (kind === 'dir') { files = null; break; }
      if (kind === 'file') files.push(rel);
    }
    if (files !== null && files.length === 0) files = null;
  }
  a.listedTrees.set(dirRel, files);
  return files;
}

/**
 * The files a data tree starts from: a walk under the limit, the listing
 * past it. Never the repository root, which stays "the tree" and belongs
 * to the always-run scanners.
 */
const dataTreeFiles = (a, dirRel) => (dirRel === '' ? null : tree(a, dirRel) ?? listedTree(a, dirRel));

/**
 * What a directory contributes when it is served or bundled rather than
 * executed by the test process (a suite that hands `client/` to Vite as its
 * root): every file by its bytes, plus what those files import from outside
 * the tree, transitively, since whatever serves or bundles the tree follows
 * the same specifiers (`client/src/App.jsx` imports
 * `server/lib/navManifest.js`). Only literal import edges are followed, the
 * trust the recorded key gives a side module. A served file's own
 * filesystem reads, git use and `test-memo: never` marker are not facts
 * about the test process and are left out, which is why a reader that could
 * load the tree natively is refused (`nativeUnresolved`). Null when the
 * tree cannot be enumerated (`dataTreeFiles`). Cached per directory: every
 * client-root suite shares one walk.
 */
function dataTree(a, dirRel) {
  if (a.dataTrees.has(dirRel)) return a.dataTrees.get(dirRel);
  const start = dataTreeFiles(a, dirRel);
  if (start === null) { a.dataTrees.set(dirRel, null); return null; }
  const files = new Set();
  const absent = new Set();
  const packageVersions = new Map();
  const pending = [...start];
  while (pending.length) {
    const rel = pending.pop();
    if (files.has(rel)) continue;
    files.add(rel);
    if (!JS_EXT.test(rel)) continue;
    const f = factsFor(a, rel);
    for (const target of f.edgeTargets) if (!files.has(target)) pending.push(target);
    for (const missing of f.absent) absent.add(missing);
    for (const [name, version] of f.packages) packageVersions.set(name, version);
  }
  const result = { files, absent, packages: packageVersions };
  a.dataTrees.set(dirRel, result);
  return result;
}

/** Fold a keyed data tree (`dataTree`) into `into`; the members' own resolution wins where both name a package. */
function foldDataTree(into, dir, data) {
  into.trees?.add(dir);
  for (const file of data.files) into.inputs.add(file);
  for (const missing of data.absent) into.absent.add(missing);
  for (const [name, version] of data.packages) if (!into.dataPackages.has(name)) into.dataPackages.set(name, version);
}

const SERVED_ROOT_MANIFESTS = ['package.json', 'package-lock.json', 'postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs'];
const CSS_REFERENCE = /@(?:import|plugin|config|reference)\s+(?:url\(\s*)?(['"])([^'"]+)\1/g;

/** The files a CSS file pulls in by a relative `@import`/`@plugin`/`@config`/`@reference`, which no request names. */
function cssReferences(a, rel) {
  const text = a.fs.read(rel)?.toString('utf8') ?? '';
  const out = [];
  for (const [, , spec] of text.matchAll(CSS_REFERENCE)) {
    if (!spec.startsWith('.')) continue;
    const target = normalizeRel(posix.join(posix.dirname(rel), spec.replace(/[?#].*$/, '')));
    if (!target.startsWith('..') && a.fs.kind(target) === 'file') out.push(target);
  }
  return out;
}

/**
 * What a handed directory contributes when the green run recorded what the
 * browser fixture's Vite server actually served from it (#17616), in place
 * of `dataTree`'s whole tree: every served file (also outside the root: a
 * client module's `server/lib` import is served through `/@fs/`), what the
 * served CSS references, the shared inputs no request names
 * (`BROWSER_SERVED_SHARED_INPUTS`), the root's own direct non-dot files
 * (configuration a dev server reads from its root), and the manifests and
 * PostCSS configs of the root and every directory above it (installed
 * packages are served from outside the repository, so the lockfile stands
 * for them). Served modules are not walked: as with the recorded key, a
 * module the run never served cannot change what Chrome rendered, and the
 * importer that gains an edge to it is itself served, so its bytes move the
 * key. Their unresolved names and installed versions are kept.
 */
function servedTree(a, dir, servedFiles) {
  const files = new Set();
  const absent = new Set();
  const packages = new Map();
  const pending = [...servedFiles, ...(tree(a, dir, /^[^.]/) ?? [])];
  for (const input of BROWSER_SERVED_SHARED_INPUTS[dir] ?? []) {
    const kind = a.fs.kind(input);
    if (kind === 'file') pending.push(input);
    else if (kind === 'dir') pending.push(...(tree(a, input) ?? listedTree(a, input) ?? []));
  }
  for (let at = dir; ; at = posix.dirname(at)) {
    const base = at === '.' ? '' : at;
    for (const name of SERVED_ROOT_MANIFESTS) {
      const rel = base === '' ? name : `${base}/${name}`;
      if (a.fs.kind(rel) === 'file') pending.push(rel);
    }
    if (base === '') break;
  }
  while (pending.length) {
    const rel = pending.pop();
    if (files.has(rel)) continue;
    files.add(rel);
    if (rel.endsWith('.css')) { pending.push(...cssReferences(a, rel)); continue; }
    if (!JS_EXT.test(rel)) continue;
    const f = factsFor(a, rel);
    for (const missing of f.absent) absent.add(missing);
    for (const [name, version] of f.packages) packages.set(name, version);
  }
  return { files, absent, packages };
}

/**
 * The served files a record vouches for under `dir`, or null when `dir` must
 * be keyed whole: no record names it, or the test serves or bundles through
 * a call of its own (`UNRECORDED_SERVER_CALL`) the fixture's recorder never saw.
 */
function servedFilesFor(a, testRel, served, dir) {
  if (!served || !served.roots.includes(dir) || served.files.some(outsideRepository)) return null;
  return UNRECORDED_SERVER_CALL.test(a.fs.read(testRel)?.toString('utf8') ?? '') ? null : served.files;
}

/** Every file named `name` anywhere in the repository (one cached walk, same skips as `tree`). */
function filesNamed(a, name) {
  if (!a.byName) {
    const byName = new Map();
    const walk = (dir) => {
      for (const entry of a.fs.list(dir)) {
        if (SKIP_TREE_DIRS.has(entry) || (dir === '' && entry === 'data')) continue;
        const rel = dir === '' ? entry : `${dir}/${entry}`;
        const kind = a.fs.kind(rel);
        if (kind === 'dir') walk(rel);
        else if (kind === 'file') byName.set(entry, [...(byName.get(entry) ?? []), rel]);
      }
    };
    a.byName = byName;
    walk('');
  }
  return (a.byName.get(name) ?? []).sort();
}

/** Installed version of the package `spec` reaches from `fromRel`, or null. */
function packageVersion(a, fromRel, spec) {
  const name = packageNameOf(spec);
  const cacheKey = `${posix.dirname(fromRel)}\0${name}`;
  if (a.packages.has(cacheKey)) return a.packages.get(cacheKey);
  const roots = [];
  for (let dir = posix.dirname(fromRel); ; dir = posix.dirname(dir)) {
    roots.push(dir === '.' ? '' : dir);
    if (dir === '.' || dir === '') break;
  }
  roots.push(a.workspaceRel);
  let found = null;
  for (const root of roots) {
    const bytes = a.fs.read(`${root === '' ? '' : `${root}/`}node_modules/${name}/package.json`);
    if (bytes === null) continue;
    try { found = { name, version: String(JSON.parse(bytes.toString('utf8')).version ?? '') }; } catch { found = null; }
    break;
  }
  a.packages.set(cacheKey, found);
  return found;
}

/** The sources the workspace's setup files mock for every test (`replacedSources`); asked once. */
function replacedBySetup(a) {
  if (a.setupReplaced !== null) return a.setupReplaced;
  // Set before the walk: the setup files' own facts ask for it, and what they trust does not matter.
  const replaced = { fs: false, crypto: false, guard: false, modules: new Set() };
  a.setupReplaced = replaced;
  for (const entry of WORKSPACE_SETUP_ENTRIES[a.workspaceRel] ?? []) {
    if (a.fs.kind(entry) !== 'file') continue;
    // The entry and everything it imports: `import './testMocks.js'` registers its mocks all the same.
    for (const rel of closureOf(a, entry, null, null, { followMockOnly: false }).members) {
      const f = factsFor(a, rel);
      for (const source of ['fs', 'crypto', 'guard']) replaced[source] ||= f.replaces?.[source] === true;
      for (const target of f.mocked) replaced.modules.add(target);
    }
  }
  return replaced;
}

// ---------------------------------------------------------------------------
// Resolved facts of one file.
// ---------------------------------------------------------------------------

/** Extracted and resolved facts for one file (cached). */
function factsFor(a, rel) {
  if (a.facts.has(rel)) return a.facts.get(rel);
  const resolved = {
    modules: new Set(), // import edges: narrowed to what a green run loaded by the recorded key
    sideModules: new Set(), // JS read as text, spawned, loaded natively or as a worker: in every key with its closure
    mockOnly: new Set(), // modules only named by a vi.mock-style registration, which loads nothing by itself
    lazyModules: new Set(), // modules only reached through a literal import(): followed for selection only where no current record vouches (`recordedReach`)
    dataModules: new Set(), // side modules only read as data (as text, or listed by a directory read); never spawned, required or run as a worker
    edgeTargets: new Set(), // every file a literal relative import, require or mock-import names, JS or not
    dataTrees: [], // directories past the limit that are keyed from the repository listing (`dataTree`)
    handedProblems: new Set(),
    handedDirs: [], // existing directories this file gives to a tool; inputs of a real-browser test (`gather`)
    nativeUnresolved: false,
    inputs: new Set(), absent: new Set(), packages: new Map(), tools: new Set(),
    unresolvedEdges: [], unresolvedInputs: [], oversized: [], localReads: [], never: false, git: false,
    openReads: new Set(), // reads whose variable segment is not proven to stay under the prefix that was keyed
    replaces: null, trusted: null, // sources this file mocks, and sources its contained paths rely on (`replacedSources`)
    trusts: new Set(), // modules whose constants named a read: void when a member mocks one (`gather`)
    mocked: new Set(), // modules this file replaces with vi.mock / vi.doMock
  };
  a.facts.set(rel, resolved);
  const bytes = a.fs.read(rel);
  if (bytes === null) { resolved.unresolvedEdges.push('missing file'); resolved.unresolvedInputs.push('missing file'); return resolved; }
  if (!JS_EXT.test(rel)) { resolved.inputs.add(rel); return resolved; }
  const raw = extractFileFacts(bytes.toString('utf8'), {
    fileRel: rel, cwdRel: a.workspaceRel, replaced: replacedBySetup(a), exportedConstant: (spec, name) => exportedConstant(a, rel, spec, name),
  });
  copyRawFacts(a, rel, raw, resolved);
  resolveFileFacts({ a, rel, resolved, executedSide: new Set(), oversizedData: [] }, raw);
  return resolved;
}

/** The facts that need no lookup beyond resolving a trusted module's specifier and a handed directory's kind. */
function copyRawFacts(a, rel, raw, resolved) {
  for (const spec of raw.trusts) {
    const target = resolveRelativeSpecifier(rel, spec, a.fs.kind);
    if (target !== null) resolved.trusts.add(target);
  }
  resolved.replaces = raw.replaces ?? null;
  resolved.trusted = raw.trusted ?? null;
  resolved.never = raw.never;
  resolved.git = raw.git;
  resolved.nativeUnresolved = raw.nativeUnresolved;
  resolved.handedProblems = raw.handedProblems;
  resolved.handedDirs = [...new Set(raw.handedDirs)].filter((dirRel) => !dirRel.startsWith('..') && a.fs.kind(dirRel) === 'dir');
  resolved.unresolvedEdges.push(...raw.unresolvedEdges);
  resolved.unresolvedInputs.push(...raw.unresolvedInputs);
  resolved.localReads.push(...raw.localReads);
  for (const tool of raw.tools) resolved.tools.add(tool);
}

/** What another module exports as a literal or a complete path, for `extractFileFacts` run on `rel`. */
function exportedConstant(a, rel, spec, name) {
  const target = resolveRelativeSpecifier(rel, spec, a.fs.kind);
  if (target === null || !JS_EXT.test(target)) return null;
  if (!a.exportedLiterals.has(target)) a.exportedLiterals.set(target, literalExports(a.fs.read(target)?.toString('utf8') ?? '', target));
  const lit = a.exportedLiterals.get(target).get(name);
  if (lit !== undefined) return lit;
  if (!a.exportedPaths.has(target)) a.exportedPaths.set(target, pathExports(a.fs.read(target)?.toString('utf8') ?? '', target, a.workspaceRel));
  return a.exportedPaths.get(target).get(name) ?? null;
}

/** `export const NAME = <complete path>` of a module, evaluated with no imports or scopes trusted. */
function pathExports(src, fileRel, workspaceRel) {
  const exported = new Map();
  let tokens;
  try { tokens = tokenizeModule(src, fileRel); } catch { return exported; }
  const match = matchBrackets(tokens);
  const ctx = {
    fileRel, cwdRel: workspaceRel, tokens, match, bindings: collectBindings(tokens, match),
    bindingValues: new Map(), resolving: new Set(), imports: new Map(), exportedConstant: null,
    replaced: { fs: false, crypto: false, guard: false }, guarded: false, delimiter: false, uuid: false, src,
  };
  ctx.shared = { root: ctx, scopes: undefined, trusted: { fs: false, crypto: false, guard: false }, trustLog: [] };
  for (let i = 0; i + 4 < tokens.length; i += 1) {
    if (!isWord(tokens[i], 'export') || !isWord(tokens[i + 1], 'const') || tokens[i + 2]?.t !== 'id' || !isPunct(tokens[i + 3], '=')) continue;
    const { value, end } = evaluate(tokens, match, i + 4, ctx);
    if (value.k === 'path' && !value.partial && !value.unfollowed && end === expressionEnd(tokens, match, i + 4)) {
      exported.set(tokens[i + 2].v, value);
    }
  }
  return exported;
}

/**
 * Resolve one file's extracted facts against the tree. `r` is the per-file
 * resolution: the analyzer, the file, its `resolved` facts, the side modules
 * an executing reference reaches (`executedSide`) and the data trees past the
 * limit (`oversizedData`), settled once every edge is known.
 */
function resolveFileFacts(r, raw) {
  const { a, resolved } = r;
  for (const name of raw.scopedNames) for (const target of filesNamed(a, name)) addFile(r, target);
  resolveEdges(r, raw.edges);
  for (const { rel: target, walk, read } of raw.paths) addPath(r, target, walk, read);
  for (const { rel: dirRel, walk, guessed, open, via, filter } of raw.dirs) addDir(r, dirRel, walk, guessed === true, open === true, via ?? null, filter ?? null);
  resolveCwdLiterals(r, raw.cwdLiterals);
  // One executing reference outweighs any number of data reads.
  for (const target of r.executedSide) resolved.dataModules.delete(target);
  // A reader with a non-literal require() may load what it read natively, where no
  // recording shows it and the file's own reads count: that stays failed closed.
  // (A non-literal import() is recorded when it runs, and fails the floor key anyway.)
  for (const dirRel of r.oversizedData) {
    if (!resolved.nativeUnresolved && dataTreeFiles(a, dirRel) !== null) resolved.dataTrees.push(dirRel);
    else resolved.oversized.push(dirRel || '<repo root>');
  }
}

function resolveEdges(r, edges) {
  const { a, rel, resolved } = r;
  const registered = new Set();
  const loaded = new Set();
  const eager = new Set();
  for (const { spec, kind } of edges) {
    if (spec.startsWith('/')) { resolved.unresolvedEdges.push(`absolute specifier ${spec}`); continue; }
    if (spec.startsWith('.')) {
      const target = resolveRelativeSpecifier(rel, spec, a.fs.kind);
      if (target === null) {
        // Node cannot load a module whose import is missing, so a file with one
        // is data (served to a browser, templated, mocked away): the key records
        // the absence and changes the day the file appears.
        resolved.absent.add(normalizeRel(posix.join(posix.dirname(rel), spec.replace(/[?#].*$/, ''))));
        continue;
      }
      (kind === 'mock' ? registered : loaded).add(target);
      (kind === 'dynamic' ? resolved.lazyModules : eager).add(target);
      if (kind !== 'mock') resolved.edgeTargets.add(target);
      // require() is a native load the Vite module runner never records.
      addFile(r, target, { edge: kind !== 'require' });
      continue;
    }
    if (isBuiltin(spec) || spec.startsWith('data:')) continue;
    if (GIT_PACKAGE.test(packageNameOf(spec))) resolved.git = true;
    addPackage(r, spec, { mock: kind === 'mock' || kind === 'mock-import' });
  }
  for (const target of registered) if (!loaded.has(target) && resolved.modules.has(target)) resolved.mockOnly.add(target);
  resolved.mocked = registered;
  for (const target of eager) resolved.lazyModules.delete(target);
}

function resolveCwdLiterals(r, cwdLiterals) {
  const { a, rel } = r;
  for (const { value, walk, dir } of cwdLiterals) {
    const bases = value.startsWith('.') ? [posix.dirname(rel), a.workspaceRel] : [a.workspaceRel, '', posix.dirname(rel)];
    for (const base of bases) {
      const target = normalizeRel(posix.join(base, value));
      if (target.startsWith('..')) continue;
      const kind = a.fs.kind(target);
      if (kind === 'file') { addPath(r, target, walk, !walk); break; }
      if (kind === 'dir' && dir) { addDir(r, target, walk); break; }
    }
  }
}

function addPackage(r, spec, { mock = false } = {}) {
  const pkg = packageVersion(r.a, r.rel, spec);
  if (pkg) { r.resolved.packages.set(pkg.name, pkg.version); return; }
  if (mock) { r.resolved.packages.set(packageNameOf(spec), 'absent'); return; }
  r.resolved.unresolvedEdges.push(`package not installed: ${packageNameOf(spec)}`);
}

/** A Python sidecar's sibling imports are inputs too (one directory, resolvable names only). */
function addPythonImports(r, target, seen = new Set()) {
  if (seen.has(target)) return;
  seen.add(target);
  r.resolved.inputs.add(target);
  const text = r.a.fs.read(target)?.toString('utf8') ?? '';
  const dir = posix.dirname(target);
  for (const line of text.split('\n')) {
    for (const name of pythonImportNames(r, target, line)) {
      const relative = name.startsWith('.');
      const head = name.replace(/^\.+/, '').split('.')[0];
      const candidate = [`${dir}/${head}.py`, `${dir}/${head}/__init__.py`].find((rel) => r.a.fs.kind(rel) === 'file');
      if (candidate) addPythonImports(r, candidate, seen);
      else if (relative) r.resolved.unresolvedInputs.push(`python import ${name} in ${target} does not resolve`);
    }
  }
}

/** The module names one line of a Python file imports. */
function pythonImportNames(r, target, line) {
  const m = /^\s*(?:from\s+(\.*[\w.]*)\s+import\b|import\s+([\w.]+(?:\s*,\s*[\w.]+)*))/.exec(line);
  const names = m ? (m[1] !== undefined ? [m[1]] : m[2].split(',')).map((part) => part.trim()).filter(Boolean) : [];
  // `importlib.import_module('x')` is a sibling import; a non-literal name may reach any module.
  if (/^\s*#/.test(line)) return names;
  for (const call of line.matchAll(/\bimport_module\s*\(\s*(?:(['"])([\w.]+)\1(?=\s*[,)])|)/g)) {
    if (call[2] !== undefined) names.push(call[2]);
    else r.resolved.unresolvedInputs.push(`python import_module with a non-literal name in ${target}`);
  }
  return names;
}

function addFile(r, target, { edge = false, data = false } = {}) {
  const { resolved } = r;
  if (JS_EXT.test(target) && !edge) (data ? resolved.dataModules : r.executedSide).add(target);
  if (JS_EXT.test(target)) (edge ? resolved.modules : resolved.sideModules).add(target);
  else if (target.endsWith('.py')) addPythonImports(r, target);
  else resolved.inputs.add(target);
}

function addDir(r, dirRel, walk, guessed = false, open = false, via = null, filter = null) {
  const { a, resolved } = r;
  // An open read may land outside the prefix. `gather` carries that fact into keying and selection.
  if (open) resolved.openReads.add(openReadReason(dirRel, via));
  if (localState(dirRel)) { resolved.localReads.push(dirRel); return; }
  if (ignoredInput(dirRel)) return;
  if (underGit(dirRel)) { resolved.unresolvedInputs.push('reads repository state under .git'); return; }
  const kind = a.fs.kind(dirRel);
  // `join(HERE, 'LICENSE')`: a name with no extension reads as a directory until the tree says otherwise.
  if (kind === 'file' && !guessed) addFile(r, dirRel, { data: !walk });
  if (kind !== 'dir') return;
  const files = tree(a, dirRel) ?? (filter !== null ? listedTree(a, dirRel) : null);
  // Past the limit: a tree only read as data may still be keyed, decided once this file's edges are
  // all known. Not a guessed one: the variable segment may leave the prefix (`join(HERE, p)` called
  // with '../../client/x.js'), and under the limit that guess was only ever an approximation.
  if (files === null) { if (walk || guessed) resolved.oversized.push(dirRel || '<repo root>'); else r.oversizedData.push(dirRel); return; }
  for (const file of files) {
    if (filter !== null && !filter(posix.basename(file))) continue;
    addFile(r, file, { data: !walk });
  }
}

function addPath(r, target, walk, read = false) {
  const { a, resolved } = r;
  if (underGit(target)) { resolved.unresolvedInputs.push('reads repository state under .git'); return; }
  if (localState(target)) { resolved.localReads.push(target); return; }
  if (ignoredInput(target)) return;
  const inModules = target.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (inModules) { addPackage(r, inModules[1]); return; }
  const kind = a.fs.kind(target);
  if (kind === 'file') { addFile(r, target, { data: read }); return; }
  if (kind === 'dir') { addDir(r, target, walk); return; }
  const viaExt = resolveRelativeSpecifier('x', `./${target}`, a.fs.kind);
  if (viaExt) addFile(r, viaExt, { data: read });
}

// ---------------------------------------------------------------------------
// Closures: folding members into one verdict.
// ---------------------------------------------------------------------------

/**
 * Fold one directory a real-browser test hands to a tool into `into`
 * (`inputs`, `absent`, `dataPackages`), or return why it cannot be keyed.
 * An install directory stands for its manifest and lockfile. Build output
 * and caches are never inputs, so a suite that serves one fails closed:
 * what it renders was made from sources this key would not see.
 * `servedFiles` (`servedFilesFor`) narrows the tree to what the recorded
 * run served (`servedTree`); without it the whole tree is keyed.
 */
function addHandedDir(a, dir, own, into, servedFiles = null) {
  if (dir === '') return 'hands the repository root to a tool';
  if (underGit(dir)) return 'reads repository state under .git';
  if (localState(dir)) return `reads machine-local state (${dir})`;
  const installs = /^(.*?)\/?node_modules(?:\/|$)/.exec(dir);
  if (installs) {
    for (const name of ['package.json', 'package-lock.json']) {
      const manifest = normalizeRel(posix.join(installs[1], name));
      if (a.fs.kind(manifest) === 'file') into.inputs.add(manifest);
    }
    return null;
  }
  if (ignoredInput(dir)) return `hands build output or a cache to a tool: ${dir}`;
  if (own.nativeUnresolved) return `hands ${dir} to a tool and has a non-literal require()`;
  const data = servedFiles ? servedTree(a, dir, servedFiles) : dataTree(a, dir);
  if (data === null) return `directory input too large: ${dir}`;
  foldDataTree(into, dir, data);
  if (servedFiles) into.servedRoots?.add(dir);
  return null;
}

/**
 * True when the code `roots` run reaches Chrome: a root, or (when walking)
 * a module it imports or a script it executes, names the browser. JS that
 * is only read as data does not count: a product module that lists a
 * template directory also lists that directory's browser tests, and that
 * must not turn every importer into a real-browser test.
 */
function reachesChrome(a, roots, walk) {
  const seen = new Set();
  const pending = [...roots];
  while (pending.length) {
    const rel = pending.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const f = factsFor(a, rel);
    if (f.tools.has('chrome')) return true;
    if (walk) for (const dep of f.modules) pending.push(dep);
    for (const side of f.sideModules) if (!f.dataModules.has(side)) pending.push(side);
  }
  return false;
}

/** Fold the facts of `members` (and, when walking, of everything they reach) into one verdict. */
function gather(a, roots, { walk, testRel = null, stop = null, followMockOnly = true, served = null }) {
  const g = {
    members: new Set(),
    inputs: new Set(),
    absent: new Set(),
    packageVersions: new Map(),
    dataPackages: new Map(),
    trees: new Set(), // directories keyed whole (`dataTree`) or by what a recorded run served (`servedTree`)
    servedRoots: new Set(), // the handed directories keyed by `servedTree`
    tools: new Set(),
    unresolvedEdges: [],
    unresolvedInputs: [],
    replacedBy: { fs: null, crypto: null, guard: null }, // the first member that mocks each trusted source
    trusting: [], // members whose contained paths rely on one
    namedTrusts: [],
    mocked: new Set(replacedBySetup(a).modules),
    hasOpenReads: false,
    never: false,
    git: false,
  };
  // A side module (read as text, spawned, loaded natively or as a worker)
  // is never narrowed by the recording: it and its own closure are walked
  // in full even when the roots are a recorded set.
  const stack = [...roots].map((rel) => ({ rel, walkEdges: walk }));
  while (stack.length) {
    const { rel, walkEdges } = stack.pop();
    if (g.members.has(rel) || stop?.has(rel)) continue;
    g.members.add(rel);
    const f = factsFor(a, rel);
    if (walkEdges) for (const dep of f.modules) if (!g.members.has(dep) && (followMockOnly || !f.mockOnly.has(dep))) stack.push({ rel: dep, walkEdges: true });
    for (const side of f.sideModules) {
      if (f.dataModules.has(side) && f.unresolvedEdges.length === 0) g.inputs.add(side);
      else if (!g.members.has(side)) stack.push({ rel: side, walkEdges: true });
    }
    foldMember(a, g, rel, f, testRel);
  }
  collectRunningMocks(a, g, roots, { walk, stop });
  reportVoidedTrusts(a, g);
  // A real-browser test renders what a dev server, bundler or static server
  // reads for it, none of which the module runner records. Every directory
  // the test file hands to such a tool is therefore an input, whole. Every
  // other test keeps the older reading (a directory passed along is a value).
  if (testRel !== null && g.members.has(testRel) && reachesChrome(a, roots, walk)) addBrowserInputs(a, g, testRel, served);
  for (const [name, version] of g.dataPackages) if (!g.packageVersions.has(name)) g.packageVersions.set(name, version);
  const { members, inputs, absent, packageVersions: packages, tools, trees, servedRoots, unresolvedEdges, unresolvedInputs, hasOpenReads, never, git } = g;
  return { members, inputs, absent, packages, tools, trees, servedRoots, unresolvedEdges, unresolvedInputs, hasOpenReads, never, git };
}

/** Fold one closure member's own facts into the gathering `g`. */
function foldMember(a, g, rel, f, testRel) {
  for (const input of f.inputs) g.inputs.add(input);
  for (const tool of f.tools) g.tools.add(tool);
  const ownsTrees = testRel === null || gitRuleApplies(rel, testRel);
  // Machine-local state (data/, the home directory) is outside every key:
  // the test and repository tooling fail closed on reading it; a product
  // module's runtime data path is redirected or mocked by its tests.
  if (f.localReads.length && ownsTrees) g.unresolvedInputs.push(`${rel}: reads machine-local state (${f.localReads[0]})`);
  for (const missing of f.absent) g.absent.add(missing);
  for (const [name, version] of f.packages) g.packageVersions.set(name, version);
  for (const reason of f.unresolvedEdges) g.unresolvedEdges.push(`${rel}: ${reason}`);
  for (const reason of f.unresolvedInputs) g.unresolvedInputs.push(`${rel}: ${reason}`);
  // A tree past the limit under a variable path is the whole repository as
  // far as the key can tell. For the test and for repository tooling that
  // fails closed. A library member (`server/lib/testHelper.js` and its
  // source walkers) reads such a tree only when a test calls it, and every
  // test that does is a tree scanner, which carries the guard suffix and is
  // never memoized (`server/test/guards/repo/repo-scan-guards.test.js` enforces the name).
  // A data-read tree the repository listing can enumerate is keyed instead
  // (`dataTree`), under the same membership rule.
  for (const dir of f.oversized) if (ownsTrees) g.unresolvedInputs.push(`${rel}: directory input too large: ${dir}`);
  // A variable path segment nothing bounds can name any file, so the prefix that was keyed is a
  // guess, whichever member reads it: a library module's read lands wherever its caller or its
  // own data says, which no key line follows (#16660). Unlike the two rules above, no caller
  // proves it: such a module resolves the name, or joins it with `pathWithin()`.
  if (f.openReads.size > 0) g.hasOpenReads = true;
  for (const reason of f.openReads) g.unresolvedInputs.push(`${rel}: ${reason}`);
  // A library's explicit guard is part of the read proof. Keep the existing scope for
  // directory-listing and UUID inference, including recorded dynamic imports.
  if (f.trusted) {
    const { fs, crypto, guard } = f.trusted;
    if (guard || (ownsTrees && (fs || crypto))) g.trusting.push({ rel, trusted: { fs: ownsTrees && fs, crypto: ownsTrees && crypto, guard } });
  }
  if (f.trusts.size) g.namedTrusts.push(rel);
  for (const dir of ownsTrees ? f.dataTrees : []) {
    const data = dataTree(a, dir);
    if (data === null) { g.unresolvedInputs.push(`${rel}: directory input too large: ${dir}`); continue; }
    foldDataTree(g, dir, data);
  }
  if (f.never) g.never = true;
  if (f.git && ownsTrees) g.git = true;
}

/**
 * A mock registered by any member (a helper the test imports) replaces the module for the test too:
 * what a listing, a generated id or the guard returns is then that member's to decide.
 * Only a member that runs registers one: a test file another member lists or reads as text does not.
 */
function collectRunningMocks(a, g, roots, { walk, stop }) {
  const running = [...roots].map((rel) => ({ rel, walkEdges: walk }));
  const ran = new Set();
  while ((g.trusting.length || g.namedTrusts.length) && running.length) {
    const { rel, walkEdges } = running.pop();
    if (ran.has(rel) || stop?.has(rel)) continue;
    ran.add(rel);
    const f = factsFor(a, rel);
    for (const target of f.mocked) g.mocked.add(target);
    if (f.replaces) for (const source of Object.keys(g.replacedBy)) if (f.replaces[source]) g.replacedBy[source] ??= rel;
    if (walkEdges) for (const dep of f.modules) running.push({ rel: dep, walkEdges: true });
    for (const side of f.sideModules) if (!f.dataModules.has(side)) running.push({ rel: side, walkEdges: true });
  }
}

const TRUSTED_SOURCE_NAMES = Object.freeze({ fs: 'a directory listing', crypto: 'randomUUID()', guard: 'pathWithin()' });

/** A member that relies on a source another member mocks, or names a read through a constant the test mocks, proves nothing. */
function reportVoidedTrusts(a, g) {
  for (const { rel, trusted } of g.trusting) {
    for (const source of Object.keys(g.replacedBy)) {
      const replacer = g.replacedBy[source];
      if (trusted[source] && replacer !== null && replacer !== rel) g.unresolvedInputs.push(`${rel}: relies on ${TRUSTED_SOURCE_NAMES[source]}, which ${replacer} mocks`);
    }
  }
  // A mock can change the imported constant that named a read.
  for (const rel of g.namedTrusts) {
    for (const target of factsFor(a, rel).trusts) if (g.mocked.has(target)) g.unresolvedInputs.push(`${rel}: names a path through ${target}, which the test mocks`);
  }
}

function addBrowserInputs(a, g, testRel, served) {
  const own = factsFor(a, testRel);
  for (const problem of own.handedProblems) g.unresolvedInputs.push(`${testRel}: ${problem}`);
  for (const dir of own.handedDirs) {
    const problem = addHandedDir(a, dir, own, g, servedFilesFor(a, testRel, served, dir));
    if (problem) g.unresolvedInputs.push(`${testRel}: ${problem}`);
  }
}

function closureOf(a, entry, testRel = entry, stop = null, { followMockOnly = true } = {}) {
  return gather(a, [entry], { walk: true, testRel, stop, followMockOnly });
}

// ---------------------------------------------------------------------------
// Keys.
// ---------------------------------------------------------------------------

function snapshotInputs(a, testRel) {
  const base = posix.basename(testRel);
  const dir = posix.dirname(testRel);
  return [`${dir}/__snapshots__/${base}.snap`, `${dir}/__snapshots__/${base.replace(/\.(?:test|spec)\.[jt]sx?$/, '')}.snap`]
    .filter((rel) => a.fs.kind(rel) === 'file');
}

function fixtureInputs(a, testRel) {
  const inputs = new Set();
  const problems = [];
  for (const owner of FIXTURE_OWNERS) {
    if (!owner.tests.includes(testRel)) continue;
    const files = tree(a, owner.dir, owner.fileRe);
    if (files === null) problems.push(`fixture directory too large: ${owner.dir}`);
    else for (const file of files) inputs.add(file);
  }
  return { inputs, problems };
}

/**
 * The workspace-level inputs every key shares: the Vitest config closure and
 * manifest. The walk skips `WORKSPACE_SELECTION_MODULES` and the targets of
 * a bare `vi.mock`/`vi.doMock`/`vi.unmock` registration: setup's global
 * `vi.mock('./services/instances.js', …)` loads instances.js only when a
 * test imports it, and then it is in that test's own closure (a non-literal
 * edge fails the floor key closed) or record. `recorded` is the same walk stopped at the setup entries the
 * config reaches (`WORKSPACE_SETUP_ENTRIES`), for a recorded key whose
 * module list names every one of `recorded.entries`. It keeps the full
 * walk's `unresolved`, so a setup-phase problem fails both keys closed.
 */
function workspaceBase(a, roots, setupEntries = []) {
  const full = walkWorkspaceBase(a, roots, []);
  const entries = setupEntries.filter((rel) => full.files.has(rel));
  if (!entries.length) return { ...full, recorded: null };
  const narrowed = walkWorkspaceBase(a, roots, entries);
  return { ...full, recorded: { ...narrowed, unresolved: full.unresolved, entries } };
}

function walkWorkspaceBase(a, roots, setupStops) {
  const stop = new Set([...WORKSPACE_SELECTION_MODULES, ...setupStops]);
  const files = new Set();
  const packageVersions = new Map();
  const unresolved = [];
  for (const root of roots) {
    if (stop.has(root)) continue;
    if (a.fs.kind(root) !== 'file') { unresolved.push(`missing workspace input ${root}`); continue; }
    if (!JS_EXT.test(root)) { files.add(root); continue; }
    const closure = closureOf(a, root, null, stop, { followMockOnly: false });
    for (const rel of closure.members) files.add(rel);
    for (const rel of closure.inputs) files.add(rel);
    for (const [name, version] of closure.packages) packageVersions.set(name, version);
    unresolved.push(...closure.unresolvedEdges, ...closure.unresolvedInputs);
  }
  return { files, packages: packageVersions, unresolved };
}

/** Why a test is not memoizable, in order; `declared` when the first reasons are a decision someone wrote down. */
function verdictReasons(testRel, gathered, extra, baseClosure, requireEdges) {
  const reasons = [];
  if (getAlwaysRunTests().includes(testRel)) reasons.push('always-run guard');
  else if (isGuardTest(testRel)) reasons.push(GUARD_SUFFIX_REASON);
  if (TEST_MEMO_NEVER[testRel]) reasons.push(TEST_MEMO_NEVER[testRel]);
  if (gathered.never) reasons.push('test-memo: never marker');
  // Set before the analyzer's own findings are appended: these three are a decision someone wrote down.
  const declared = reasons.length > 0;
  if (gathered.git) reasons.push('spawns git');
  if (baseClosure.unresolved.length) reasons.push(`workspace config: ${baseClosure.unresolved[0]}`);
  if (requireEdges) reasons.push(...gathered.unresolvedEdges);
  reasons.push(...gathered.unresolvedInputs, ...extra.problems);
  return { reasons, declared };
}

function verdict(a, testRel, gathered, extra, baseClosure, { requireEdges }) {
  const { reasons, declared } = verdictReasons(testRel, gathered, extra, baseClosure, requireEdges);
  if (reasons.length) return { key: null, memoizable: false, reason: reasons[0], reasons, declared };
  const lines = [];
  // Suites that key the same tree from inside it hash the same file set, and an
  // entry names one test: without this line they would overwrite each other's entry.
  if (gathered.trees.size) lines.push(`test ${testRel}`);
  // A served-narrowed key never equals the whole-tree key of the same inputs.
  for (const dir of [...(gathered.servedRoots ?? [])].sort()) lines.push(`served ${dir}`);
  const files = new Set([...gathered.members, ...gathered.inputs, ...extra.inputs, ...snapshotInputs(a, testRel), ...baseClosure.files]);
  for (const rel of [...files].sort()) {
    const digest = fileHash(a, rel);
    if (digest === null) return { key: null, memoizable: false, reason: `unreadable input ${rel}`, reasons: [`unreadable input ${rel}`] };
    lines.push(`file ${rel} ${digest}`);
  }
  for (const rel of [...gathered.absent].sort()) lines.push(`absent ${rel}`);
  const versions = new Map([...baseClosure.packages, ...gathered.packages]);
  for (const name of [...versions.keys()].sort()) lines.push(`pkg ${name} ${versions.get(name)}`);
  for (const tool of [...gathered.tools].sort()) lines.push(`tool ${tool} ${a.toolVersion(tool) ?? 'absent'}`);
  const keyWith = (head) => sha256([...head, ...lines].join('\n'));
  return {
    key: keyWith(a.environmentLines),
    acceptedKeys: a.acceptedEnvironments.map(({ label, lines: head }) => ({ label, key: keyWith(head) })),
    memoizable: true,
    reasons: [],
  };
}

const NARROW = 0;
const DATA = 1;
const FULL = 2;

/**
 * What can change a recorded test's outcome, for related selection: the
 * test, every module its green run loaded, the names those modules import,
 * and their non-JS inputs. A module the run did not load is reached by
 * name only: under unchanged recorded code it was mocked away or on an
 * untaken path. A literal `import()` edge is followed only from the test
 * itself and below a member whose bytes no longer match the record's
 * digest: a lazy edge gained since the run is in such a member, so its
 * whole closure counts, as it does for an unrecorded test. Side modules
 * keep their whole closure because the module runner never records them.
 * An unresolved edge fails closed in a stale member or below a side module
 * that executes (spawned, `require()`d, run as a worker); JS only read as
 * data (`dataModules`: read as text, or listed by a directory read) counts
 * by its own bytes, and with its closure (which cannot fail closed, the
 * trust the recorded key gives it) only when the reader has a non-literal
 * import that could evaluate it. Only a record whose members all still exist gets here (the
 * recorded key fails closed on a missing one).
 *
 * A handed directory the record's served files vouch for counts by those
 * files (`servedTree`), so an edit to a page the fixture never served does
 * not select it; any other handed directory counts whole.
 *
 * @param {{ modules: string[], digests: string[], served?: { roots: string[], files: string[] }|null }} record
 * @returns {{ reach: Set<string>, failClosed: string|null }}
 */
function recordedReach(a, testRel, record) {
  const recordedDigest = new Map(record.modules.map((rel, index) => [rel, record.digests[index]]));
  const reach = new Set();
  // The directories a real-browser test hands to a tool (`gather`); a problem there already failed the recorded key.
  const own = factsFor(a, testRel);
  if (reachesChrome(a, [testRel, ...record.modules], false)) {
    for (const dir of own.handedDirs) {
      addHandedDir(a, dir, own, { inputs: reach, absent: new Set(), dataPackages: new Map() }, servedFilesFor(a, testRel, record.served, dir));
    }
  }
  const walked = new Map(); // rel -> highest mode walked; a wider later visit re-walks it
  const stack = [testRel, ...record.modules].map((rel) => ({ rel, mode: NARROW }));
  let failClosed = null;
  while (stack.length) {
    const next = stack.pop();
    const { rel } = next;
    reach.add(rel);
    if (fileHash(a, rel) === null) continue;
    const stale = recordedDigest.has(rel) && moduleDigest(a, rel) !== recordedDigest.get(rel);
    const mode = stale ? FULL : next.mode;
    // Reached only through unchanged recorded code yet absent from the record:
    // the green run never loaded it (mocked away or on an untaken path), so
    // nothing below it can change the outcome. Its own name stays in reach.
    if (mode === NARROW && !recordedDigest.has(rel) && rel !== testRel) continue;
    if ((walked.get(rel) ?? -1) >= mode) continue;
    walked.set(rel, mode);
    const f = factsFor(a, rel);
    for (const input of f.inputs) reach.add(input);
    if (gitRuleApplies(rel, testRel)) for (const dir of f.dataTrees) for (const file of dataTree(a, dir)?.files ?? []) reach.add(file);
    if (mode === FULL && f.unresolvedEdges.length && failClosed === null) failClosed = `${rel}: ${f.unresolvedEdges[0]}`;
    const lazy = mode !== NARROW || rel === testRel;
    for (const dep of f.modules) if (lazy || !f.lazyModules.has(dep)) stack.push({ rel: dep, mode });
    for (const side of f.sideModules) {
      // Read as data by a module with only literal edges: just those bytes count.
      // A reader with a non-literal import may evaluate what it read (a data: URL), so the closure counts.
      if (f.dataModules.has(side) && f.unresolvedEdges.length === 0) reach.add(side);
      else stack.push({ rel: side, mode: mode === DATA || f.dataModules.has(side) ? DATA : FULL });
    }
  }
  return { reach, failClosed };
}

/**
 * Both keys for one test. `recorded` is the module list a previous green
 * run loaded (repo-relative), or null when none is on record. `digests`
 * (aligned with `recorded`, from a v2 record) also narrows related
 * selection to `recordedReach` when the recorded key is memoizable — the
 * gate the record was written under, so selection never trusts a record
 * the memo itself would not. `served` (`{ roots, files }`, from the same
 * record) is what a real-browser run's fixture served from each root; it
 * narrows the recorded key and reach of a handed root (`servedTree`).
 *
 * @returns {{ floor: Verdict, recorded: Verdict|null, closure: Set<string>, inputs: Set<string>, edgesResolved: boolean, hasOpenReads: boolean, narrowed: object|null }}
 */
function analyzeTest(a, testRel, { baseClosure, recorded = null, digests = null, served = null }) {
  const closure = closureOf(a, testRel);
  const fixtures = fixtureInputs(a, testRel);
  const floor = verdict(a, testRel, closure, fixtures, baseClosure, { requireEdges: true });
  const recordedVerdict = recorded === null ? null : recordedKeyVerdict(a, testRel, recorded, fixtures, baseClosure, served);
  const narrowed = recordedVerdict?.memoizable && Array.isArray(digests) && digests.length === recorded.length
    ? recordedReach(a, testRel, { modules: recorded, digests, served })
    : null;
  return {
    floor,
    recorded: recordedVerdict,
    closure: closure.members,
    inputs: closure.inputs,
    edgesResolved: closure.unresolvedEdges.length === 0,
    hasOpenReads: closure.hasOpenReads,
    narrowed,
  };
}

function recordedKeyVerdict(a, testRel, recorded, fixtures, baseClosure, served) {
  const outside = recorded.find(outsideRepository);
  if (outside !== undefined) return { key: null, memoizable: false, reason: `loaded a module outside the repository: ${outside}`, reasons: [] };
  const gathered = gather(a, new Set([testRel, ...recorded]), { walk: false, testRel, served });
  // A record missing a setup entry (a per-file environment pragma, a
  // Vitest that stopped recording them) keeps the full static base.
  const base = baseClosure.recorded?.entries.every((rel) => gathered.members.has(rel)) ? baseClosure.recorded : baseClosure;
  return verdict(a, testRel, gathered, fixtures, base, { requireEdges: false });
}

/**
 * Keys for `testFiles` (repo-relative posix paths) in one workspace.
 * `records` maps a test to the module list its last green run loaded.
 * `digests` maps a test to that record's per-module digests (a v2 record),
 * which lets related selection narrow it. `served` maps a test to the files
 * its real-browser fixture served (`analyzeTest`).
 */
export function computeTestMemoKeys(testFiles, { fs, workspace, env, platform, arch, nodeVersion, toolVersion, caseFilter, listFiles, records = new Map(), digests = new Map(), served = new Map() }) {
  const analyzer = createTestMemoAnalyzer({ fs, workspaceRel: workspace, env, platform, arch, nodeVersion, toolVersion, caseFilter, listFiles });
  const baseClosure = analyzer.workspaceBase(WORKSPACE_BASE_INPUTS[workspace] ?? [], WORKSPACE_SETUP_ENTRIES[workspace] ?? []);
  const out = new Map();
  for (const test of testFiles) {
    out.set(test, analyzer.analyzeTest(test, { baseClosure, recorded: records.get(test) ?? null, digests: digests.get(test) ?? null, served: served.get(test) ?? null }));
  }
  return out;
}

/**
 * Tests related to `sources` under closure-based selection. A test with a
 * narrowing record (`analyzeTest`'s `narrowed`) is related when a source is
 * in its `recordedReach`, or when that walk failed closed. Any other test is
 * related when a source is in its static+dynamic module closure or among the
 * non-JS inputs it reaches (a JSON or CSS import, a fixture), or when its
 * closure has unresolved edges or unbounded reads (it may reach anything).
 */
export function relatedTests(keys, sources) {
  const changed = new Set(sources);
  const reaches = (set) => [...set].some((rel) => changed.has(rel));
  return [...keys.entries()]
    .filter(([, info]) => (info.narrowed
      ? info.narrowed.failClosed !== null || reaches(info.narrowed.reach)
      : !info.edgesResolved || info.hasOpenReads || reaches(info.closure) || reaches(info.inputs)))
    .map(([test]) => test);
}

/** A disk-backed `fs` for `createTestMemoAnalyzer`, rooted at `repoRoot`. */
export function createDiskFs(repoRoot, nodeFs, nodePath) {
  const abs = (rel) => nodePath.join(repoRoot, ...rel.split('/').filter(Boolean));
  const stat = (rel) => {
    try { return nodeFs.statSync(abs(rel)); } catch { return null; }
  };
  return {
    read(rel) {
      const s = stat(rel);
      if (!s || !s.isFile()) return null;
      try { return nodeFs.readFileSync(abs(rel)); } catch { return null; }
    },
    kind(rel) {
      const s = stat(rel);
      return !s ? null : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null;
    },
    list(rel) {
      try { return nodeFs.readdirSync(abs(rel)); } catch { return []; }
    },
  };
}
