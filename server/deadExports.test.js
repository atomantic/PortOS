import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  if (file === 'server/lib/browserSuiteGate.js') return true; // Test-only `canRun` guard (#10312) — reached exclusively from *.browser.test.js.
  if (file === 'server/services/_heldCheckoutRecoveryFixture.js') return true; // Test-only fixture shared by the three heldCheckoutRecovery*.test.js suites.
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

  const mentionedBy = new Map();
  for (const [file, source] of files) {
    if (/\.test\.[cm]?[jt]sx?$/.test(file) || /(^|\/)README\.md$/i.test(file)) continue;
    for (const match of source.matchAll(WORD)) {
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

function trackedFilesFrom(root) {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, maxBuffer: GIT_MAX_BUFFER })
    .toString('utf8').split('\0').filter(Boolean)
    .filter(file => /\.(?:[cm]?[jt]sx?|json|md)$/.test(file))
    .filter(file => existsSync(join(root, file)))
    .map(file => [file, readFileSync(join(root, file), 'utf8')]);
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
});
