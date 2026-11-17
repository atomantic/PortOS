import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPORT = /^export (?:async )?function ([A-Za-z_$][\w$]*)\b/gm;
const WORD = /\b[A-Za-z_$][\w$]*\b/g;
// A release promotion diffs hundreds of commits; Node's 1 MB default overflows (ENOBUFS).
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function excluded(file, name) {
  if (name.startsWith('_')) return true; // Test and integration hooks are intentionally public.
  if (file === 'server/services/beeperClient.js') return true; // Standalone external API client.
  if (file.startsWith('server/integrations/')) return true; // Standalone integration API clients.
  if (file.startsWith('server/lib/aiToolkit/')) return true; // Vendored toolkit public barrel surface.
  if (file === 'server/lib/mockPathsDataRoot.js') return true; // Test-only helper module (#9032) — every export here is meant to be reached exclusively from *.test.js, which this scan intentionally excludes as a "mention".
  if (file === 'server/lib/staticExportSurface.js') return true; // Test-only (#16148) — derives a module's export names for structural guards, reached exclusively from *.test.js.
  if (file === 'server/lib/browserSuiteGate.js') return true; // Test-only `canRun` guard (#10312) — reached exclusively from *.browser.test.js.
  if (file === 'server/services/_heldCheckoutRecoveryFixture.js') return true; // Test-only fixture for the real-Git heldCheckoutRecovery.test.js suite.
  if (/\.test\.fixture\.[cm]?js$/.test(file)) return true; // Test-only suite fixtures (#16215), reached exclusively from their *.test.js suites.
  return false;
}

function deadExports(files, candidateNames = null) {
  const declarations = [];
  const names = new Set();
  for (const [file, source] of files) {
    if (!/^server\/(services|lib)\/.*\.js$/.test(file) || file.endsWith('.test.js')) continue;
    for (const match of source.matchAll(EXPORT)) {
      if (excluded(file, match[1])) continue;
      if (candidateNames && !candidateNames.has(match[1])) continue;
      declarations.push({ file, name: match[1] });
      names.add(match[1]);
    }
  }

  if (names.size === 0) return [];
  // Match only candidate identifiers in C++ regex engine rather than allocating
  // a RegExp match array for every word in the repository.
  const needle = names.size <= 500
    ? new RegExp(`\\b(?:${[...names].map(n => n.replace(/\$/g, '\\$')).join('|')})\\b`, 'g')
    : WORD;
  const mentionedBy = new Map();
  for (const [file, source] of files) {
    if (/\.test\.[cm]?[jt]sx?$/.test(file) || /(^|\/)README\.md$/i.test(file)) continue;
    for (const match of source.matchAll(needle)) {
      if (!names.has(match[0])) continue;
      if (!mentionedBy.has(match[0])) mentionedBy.set(match[0], new Set());
      mentionedBy.get(match[0]).add(file);
    }
  }
  return declarations.filter(({ file, name }) =>
    ![...(mentionedBy.get(name) || [])].some(other => other !== file));
}

// Export names a unified diff introduces. A name the diff also removes is an
// existing export whose declaration line changed (a new parameter, a move) —
// not an addition, so a legacy test-only export stays grandfathered.
function addedExportNamesFromDiff(diff) {
  const added = new Set();
  const removed = new Set();
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const match = /^([+-])export (?:async )?function ([A-Za-z_$][\w$]*)\b/.exec(line);
    if (match) (match[1] === '+' ? added : removed).add(match[2]);
  }
  return new Set([...added].filter(name => !removed.has(name)));
}

function addedExportNames(root = ROOT, baseOverride = null) {
  // Pull-request CI supplies its exact merge-ref base. A workflow_dispatch
  // full run has no origin/main ref in actions/checkout's depth-2 clone; use
  // the previous commit there so this guard still examines the new exports.
  const hasOriginMain = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: root, stdio: 'ignore' }).status === 0;
  const base = baseOverride || (root === ROOT && process.env.CI_BASE_SHA
    ? process.env.CI_BASE_SHA
    : execFileSync('git', hasOriginMain ? ['merge-base', 'HEAD', 'origin/main'] : ['rev-parse', 'HEAD^1'], { cwd: root, encoding: 'utf8' }).trim());
  const diff = execFileSync('git', ['diff', '--unified=0', base, '--', 'server/services', 'server/lib'], { cwd: root, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  const candidates = addedExportNamesFromDiff(diff);
  // `git diff` omits files that have not been staged. Pregate checks the whole
  // working tree, so collect declarations from new service/lib modules too.
  const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], { cwd: root, maxBuffer: GIT_MAX_BUFFER })
    .toString('utf8').split('\0').filter(file => /^server\/(?:services|lib)\/.*\.js$/.test(file) && !file.endsWith('.test.js'));
  for (const file of untracked) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const match of source.matchAll(EXPORT)) {
      if (!excluded(file, match[1])) candidates.add(match[1]);
    }
  }
  return candidates;
}

// Untracked (non-ignored) files count as callers too: addedExportNames diffs the
// working tree, and pregate validates uncommitted work, so a new caller file
// that is not yet `git add`ed must not make its import look orphaned.
function trackedFiles() {
  return trackedFilesFrom(ROOT);
}

// The two full-tree scans below share one listing and one read per file for the
// real tree (the structural-guard budget is per file); fixtures in a temp
// repo change between calls, so they bypass the cache.
const treeCache = { listing: null, sources: new Map() };
function listTree(root) {
  if (root === ROOT && treeCache.listing) return treeCache.listing;
  const listing = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: GIT_MAX_BUFFER })
    .toString('utf8').split('\0').filter(Boolean);
  if (root === ROOT) treeCache.listing = listing;
  return listing;
}
function readTree(root, file) {
  if (root !== ROOT) {
    try { return readFileSync(join(root, file), 'utf8'); } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  if (!treeCache.sources.has(file)) {
    try { treeCache.sources.set(file, readFileSync(join(root, file), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') treeCache.sources.set(file, null); else throw err; }
  }
  return treeCache.sources.get(file);
}

function trackedFilesFrom(root) {
  const out = [];
  for (const file of listTree(root)) {
    if (!/\.(?:[cm]?[jt]sx?|json)$/.test(file)) continue;
    // deadExports() declares from, and counts mentions in, neither of these, and
    // they are most of the tree's bytes: don't read them.
    if (/\.test\.[cm]?[jt]sx?$/.test(file) || /(^|\/)package-lock\.json$/.test(file)) continue;
    const source = readTree(root, file);
    if (source !== null) out.push([file, source]);
  }
  return out;
}

// --- Re-export shims and test hooks (#16230) -------------------------------
// `export { x } from './y.js'` in a non-barrel module is a shim: it stays only
// while some production file imports `x` through it. `_`-prefixed exports are
// test hooks: they stay only while some other file references them. Both scans
// are word-level, so a namespace or dynamic importer that spells the name still
// counts as a caller; a name no regex can decide belongs in an allowlist with
// its reason.
const SPECIFIER = /(?:\bfrom|\bimport\(|\bmock\(|\bdoMock\(|\bimportActual\(|\brequire\()\s*['"](\.[^'"]+)['"]/g;
const STAR_EXPORT = /export\s*\*\s*from\s*['"](\.[^'"]+)['"]/g;
const REEXPORT = /export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g;
const HOOK_DECLARATION = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+(_[\w$]*)/gm;
const HOOK_SCOPE = /^(?:server\/(?:services|lib)\/(?!aiToolkit\/)|client\/src\/lib\/)[^]*\.js$/;
const isTestFile = file => /\.test\.[cm]?[jt]sx?$/.test(file);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// Tests are most of the tree's bytes and only ever matter as referrers of an
// underscore hook (a test importer never keeps a re-export alive), so a test
// file is reduced to its `_`-prefixed words.
function codeFiles(root = ROOT) {
  const out = [];
  for (const file of listTree(root)) {
    if (!/^(?:server|scripts|lib|autofixer|client\/src)\/.*\.[cm]?[jt]sx?$/.test(file)) continue;
    const source = readTree(root, file);
    if (source !== null) out.push([file, isTestFile(file) ? (source.match(/\b_[\w$]*/g) || []).join(' ') : source]);
  }
  return out;
}

// Lazy on purpose: this runs inside the structural-guard time budget, so words
// are tokenized only for the few files that import a shim, not the whole tree.
function referenceIndex(files) {
  const sources = new Map(files);
  const resolve = (from, specifier) => {
    const base = join(dirname(from), specifier).split('\\').join('/');
    return [base, `${base}.js`, `${base}/index.js`].find(candidate => sources.has(candidate));
  };
  const add = (map, key, value) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  };
  const underscoreMentions = new Map();
  const starParents = new Map();
  const direct = new Map();
  for (const [file, source] of files) {
    for (const word of new Set(source.match(/\b_[\w$]*/g) || [])) add(underscoreMentions, word, file);
    for (const match of source.matchAll(SPECIFIER)) {
      const target = resolve(file, match[1]);
      if (target && target !== file) add(direct, target, file);
    }
    if (!/export\s*\*\s*from/.test(source)) continue;
    for (const match of stripComments(source).matchAll(STAR_EXPORT)) {
      const target = resolve(file, match[1]);
      if (target) add(starParents, target, file);
    }
  }
  // `export * from './x.js'` re-publishes x's names, so whoever imports the
  // star-parent imports them through it.
  const importers = (file, seen = new Set([file])) => {
    const out = new Set(direct.get(file) || []);
    for (const parent of starParents.get(file) || []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      for (const other of importers(parent, seen)) out.add(other);
    }
    return out;
  };
  const words = new Map();
  const mentions = (file, name) => {
    if (!words.has(file)) words.set(file, new Set(sources.get(file).match(WORD) || []));
    return words.get(file).has(name);
  };
  return { importers, mentions, underscoreMentions };
}

function exportedNames(clause) {
  return clause.split(',').map(part => part.trim()).filter(Boolean)
    .map(part => part.split(/\s+as\s+/).pop().trim());
}

// A barrel (`index.js`) or an `export * from` shim has no per-name list to audit,
// so it stays only while some production file imports it at all; a zero-importer
// one is reported as `<file>:*`.
function callerlessReExports(files, index = referenceIndex(files)) {
  const offenders = [];
  for (const [file, source] of files) {
    if (!HOOK_SCOPE.test(file) || isTestFile(file)) continue;
    const code = stripComments(source);
    const reExports = [...code.matchAll(REEXPORT)];
    const isBarrel = /(^|\/)index\.js$/.test(file);
    const hasStar = /^export\s*\*\s*from/m.test(code);
    if (!reExports.length && !hasStar) continue;
    const callers = [...index.importers(file)].filter(other => other !== file && !isTestFile(other));
    if ((isBarrel || hasStar) && !callers.length) offenders.push(`${file}:*`);
    if (isBarrel) continue;
    for (const match of reExports) {
      for (const name of exportedNames(match[1])) {
        if (!callers.some(other => index.mentions(other, name))) offenders.push(`${file}:${name}`);
      }
    }
  }
  return offenders;
}

function unreferencedTestHooks(files, index = referenceIndex(files)) {
  const offenders = [];
  for (const [file, source] of files) {
    if (!HOOK_SCOPE.test(file) || isTestFile(file) || !/export[^\n]*\b_|\b_[\w$]*\b[^\n]*\n?}/.test(source) && !source.includes('_')) continue;
    const code = stripComments(source);
    const names = [...code.matchAll(HOOK_DECLARATION)].map(match => match[1]);
    for (const match of code.matchAll(/export\s*\{([^}]*)\}(?!\s*from)/g)) {
      names.push(...exportedNames(match[1]).filter(name => name.startsWith('_')));
    }
    for (const name of names) {
      if (![...(index.underscoreMentions.get(name) || [])].some(other => other !== file)) offenders.push(`${file}:${name}`);
    }
  }
  return offenders;
}

describe('server dead exports', () => {
  it('detects a caller-less exported function and ignores a live export', () => {
    const files = new Map([
      ['server/services/example.js', 'export function orphan() {}\nexport async function used() {}\n'],
      ['server/routes/example.js', 'used();\n'],
    ]);
    expect(deadExports(files)).toEqual([{ file: 'server/services/example.js', name: 'orphan' }]);
  });

  it('counts only exports the diff introduces, not re-declared existing ones', () => {
    const diff = [
      '--- a/server/services/example.js',
      '+++ b/server/services/example.js',
      '-export function reshaped(a) {',
      '+export function reshaped(a, options = {}) {',
      '+export async function brandNew() {',
    ].join('\n');
    expect([...addedExportNamesFromDiff(diff)]).toEqual(['brandNew']);
  });

  it('reports a newly introduced orphan export against candidate names', () => {
    const candidates = addedExportNamesFromDiff('+export function orphan() {');
    const files = new Map([
      ['server/services/example.js', 'export function orphan() {}\n'],
      ['server/routes/example.js', 'export function unrelated() {}\n'],
    ]);

    expect(deadExports(files, candidates)).toEqual([
      { file: 'server/services/example.js', name: 'orphan' },
    ]);
  });

  it('collects untracked declarations and callers before staging with staged and committed parity', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'portos-dead-exports-'));
    const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim();
    const write = (path, content) => {
      const fullPath = join(fixture, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content);
    };
    try {
      git('init', '-q');
      git('config', 'user.email', 'guard@example.invalid');
      git('config', 'user.name', 'Guard Fixture');
      write('.gitignore', 'server/services/ignored.js\n');
      write('server/services/existing.js', 'export function legacy() {}\n');
      git('add', '.');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      write('server/services/existing.js', 'export function legacy(options = {}) {}\n');
      write('server/services/new.js', 'export function orphan() {}\nexport function called() {}\nexport function _fixtureHook() {}\n');
      write('server/services/beeperClient.js', 'export function standaloneClient() {}\n');
      write('server/services/ignored.js', 'export function ignoredByGit() {}\n');
      const candidates = addedExportNames(fixture, base);
      expect([...candidates].sort()).toEqual(['called', 'orphan']);
      expect(deadExports(trackedFilesFrom(fixture), candidates)).toContainEqual({ file: 'server/services/new.js', name: 'orphan' });
      write('server/routes/caller.js', "import { called } from '../services/new.js';\ncalled();\n");
      expect(deadExports(trackedFilesFrom(fixture), addedExportNames(fixture, base))).not.toContainEqual({ file: 'server/services/new.js', name: 'called' });
      git('add', 'server/services/new.js', 'server/routes/caller.js');
      expect(deadExports(trackedFilesFrom(fixture), addedExportNames(fixture, base))).toContainEqual({ file: 'server/services/new.js', name: 'orphan' });
      git('commit', '-qm', 'stage equivalent inputs');
      expect(deadExports(trackedFilesFrom(fixture), addedExportNames(fixture, base))).toContainEqual({ file: 'server/services/new.js', name: 'orphan' });
      expect(git('rev-parse', 'HEAD^')).toBe(base);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('keeps newly added server function exports reachable', () => {
    // Existing test-only and undocumented public exports predate this guard.
    // Gate additions while that legacy inventory is reduced separately.
    const candidates = addedExportNames();
    const orphans = candidates.size > 0 ? deadExports(trackedFiles(), candidates) : [];
    expect(orphans).toEqual([]);
  });
  it('flags a caller-less re-export and keeps one a production file imports', () => {
    const files = [
      ['server/services/shim.js', "export { used, orphan, onlyTested } from './impl.js';\n"],
      ['server/services/impl.js', 'export const used = 1;\nexport const orphan = 2;\nexport const onlyTested = 3;\n'],
      ['server/routes/caller.js', "import { used } from '../services/shim.js';\nused;\n"],
      ['server/services/shim.test.js', "import { onlyTested } from './shim.js';\nonlyTested;\n"],
    ];
    expect(callerlessReExports(files)).toEqual(['server/services/shim.js:orphan', 'server/services/shim.js:onlyTested']);
  });

  it('flags a zero-importer export-star shim and barrel, and keeps imported ones', () => {
    const files = [
      ['server/services/film/dead.js', "export * from './impl.js';\n"],
      ['server/services/barrel/index.js', "export * from './impl.js';\n"],
      ['server/services/film/live.js', "export * from './impl.js';\n"],
      ['server/services/livebarrel/index.js', "export { a } from './impl.js';\n"],
      ['server/routes/caller.js', "import { x } from '../services/film/live.js';\nimport { a } from '../services/livebarrel';\nx; a;\n"],
      ['server/services/film/dead.test.js', "import { x } from './dead.js';\n"],
    ];
    expect(callerlessReExports(files)).toEqual(['server/services/film/dead.js:*', 'server/services/barrel/index.js:*']);
  });

  it('covers client/src/lib shims and hooks', () => {
    const files = [
      ['client/src/lib/shim.js', "export { used, orphan } from '../../../server/lib/impl.js';\nexport function _resetClient() {}\n"],
      ['client/src/components/Caller.jsx', "import { used } from '../lib/shim.js';\nused;\n"],
    ];
    expect(callerlessReExports(files)).toEqual(['client/src/lib/shim.js:orphan']);
    expect(unreferencedTestHooks(files)).toEqual(['client/src/lib/shim.js:_resetClient']);
  });

  it('ignores a re-export name that only appears in a comment or another module', () => {
    const files = [
      ['server/services/shim.js', "// export { ghost } from './impl.js';\nexport { real } from './impl.js';\n"],
      ['server/routes/other.js', "import { real } from '../services/impl.js';\nreal;\n"],
    ];
    expect(callerlessReExports(files)).toEqual(['server/services/shim.js:real']);
  });

  it('flags an unreferenced underscore test hook and keeps one a test references', () => {
    const files = [
      ['server/services/store.js', 'export function _resetStore() {}\nexport const __resetCache = () => {};\nexport function _resetUsed() {}\n'],
      ['server/services/store.test.js', "import { _resetUsed } from './store.js';\n_resetUsed();\n"],
    ];
    expect(unreferencedTestHooks(files)).toEqual(['server/services/store.js:_resetStore', 'server/services/store.js:__resetCache']);
  });

  it('flags an unreferenced underscore name in an export list', () => {
    const files = [['server/lib/seam.js', 'function _seam() {}\nexport { _seam };\n']];
    expect(unreferencedTestHooks(files)).toEqual(['server/lib/seam.js:_seam']);
  });

  it('keeps server re-exports used and test hooks referenced', () => {
    const files = codeFiles();
    const index = referenceIndex(files);
    expect(callerlessReExports(files, index)).toEqual([]);
    expect(unreferencedTestHooks(files, index)).toEqual([]);
  });
});
