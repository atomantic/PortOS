import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

function addedExportNames() {
  // Pull-request CI supplies its exact merge-ref base. A workflow_dispatch
  // full run has no origin/main ref in actions/checkout's depth-2 clone; use
  // the previous commit there so this guard still examines the new exports.
  const hasOriginMain = spawnSync('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/main'], { cwd: ROOT, stdio: 'ignore' }).status === 0;
  const base = process.env.CI_BASE_SHA || execFileSync('git', hasOriginMain ? ['merge-base', 'HEAD', 'origin/main'] : ['rev-parse', 'HEAD^1'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const diff = execFileSync('git', ['diff', '--unified=0', base, '--', 'server/services', 'server/lib'], { cwd: ROOT, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  return addedExportNamesFromDiff(diff);
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: GIT_MAX_BUFFER })
    .toString('utf8').split('\0').filter(Boolean)
    .filter(file => /\.(?:[cm]?[jt]sx?|json|md)$/.test(file))
    .filter(file => existsSync(join(ROOT, file)))
    .map(file => [file, readFileSync(join(ROOT, file), 'utf8')]);
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

  it('keeps newly added server function exports reachable', () => {
    // Existing test-only and undocumented public exports predate this guard.
    // Gate additions while that legacy inventory is reduced separately.
    expect(deadExports(trackedFiles(), addedExportNames())).toEqual([]);
  });
});
