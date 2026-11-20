/**
 * Tree-wide guard: every top-level, ML, operator and fixture/experiment script must be
 * referenced by something live in the repo (code, a workflow, package.json or a doc),
 * so a script no one can find or run is either documented in docs/SCRIPTS.md or
 * deleted (#16089, #16909).
 *
 * A file is referenced when another tracked file contains its name as a whole
 * token, or, for a Python module, its stem (`import ltx25_reference`). Exempt:
 * `*.test.js`, which the server Vitest run collects through `../scripts/**` globs.
 * Sibling tests (`<stem>.test.js`, `<stem>_test.py`), migrations (`scripts/migrations/*`),
 * changelogs, decision records (ADRs), concluded plans, and research docs do not count:
 * a historical mention or self-test is not a pointer for the next reader.
 * No allowlist: document the script or delete it.
 */
import { basename, dirname } from 'path';
import { describe, expect, it } from 'vitest';
import { guardCorpus, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

export const CANDIDATE_SCRIPT = /^scripts\/(?:[^/]+|(?:ml|ops|fixtures|experiments)\/.+)$/;
export const VITEST_COLLECTED = /\.test\.js$/;
export const HISTORICAL = /^docs\/(?:decisions|plans|research)\/|^scripts\/migrations\//;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isSiblingTest(candidate, file) {
  if (dirname(candidate) !== dirname(file)) return false;
  const fileBase = basename(file);
  const candBase = basename(candidate);
  const candStem = candBase.replace(/\.[^.]+$/, '');
  return (
    fileBase === `${candStem}.test.js` ||
    fileBase === `${candBase}.test.js` ||
    fileBase === `${candStem}_test.py` ||
    fileBase === `${candBase}_test.py`
  );
}

// A whole `[\w.-]+` token equal to a key once its trailing dots are dropped.
// One scan for the known keys instead of tokenizing ~47 MB into per-file sets
// keeps this always-run check cheap (it also beat a linear tokenizer, #16996).
const keyPattern = (keys) => new RegExp(
  `(?<![\\w.-])(?:${[...keys].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?=\\.*(?:[^\\w.-]|$))`,
  'g',
);

/** Map each candidate's referencing key (file name, plus stem for Python) to its owner path. */
export function referenceKeys(candidates) {
  const keys = new Map();
  for (const path of candidates) {
    const name = basename(path);
    keys.set(name, path);
    if (name.endsWith('.py')) keys.set(name.slice(0, -3), path);
  }
  return keys;
}

/** Candidate scripts that no other live tracked file references. */
export function unreferencedScripts(candidates, corpus) {
  const keys = referenceKeys(candidates);
  const pattern = keyPattern(keys.keys());
  const referenced = new Set();
  for (const path of corpus) {
    // Tracked symlinks (.claude/commands/do/*) point into the lib/slashdo submodule; a symlink holds no text of its own.
    if (!guardCorpus().lstat(path).isFile()) continue;
    // A binary asset (git's NUL-in-the-first-8000-bytes heuristic) holds no pointer to a script.
    if (guardCorpus().bytes(path).subarray(0, 8000).includes(0)) continue;
    for (const [token] of guardCorpus().read(path).matchAll(pattern)) {
      const owner = keys.get(token);
      if (owner && owner !== path && !isSiblingTest(owner, path)) referenced.add(owner);
    }
  }
  return candidates.filter((path) => !referenced.has(path));
}

describe('scripts/ reference guard (#16089, #16909)', () => {
  it('identifies sibling tests accurately', () => {
    expect(isSiblingTest('scripts/foo.js', 'scripts/foo.test.js')).toBe(true);
    expect(isSiblingTest('scripts/foo.py', 'scripts/foo_test.py')).toBe(true);
    expect(isSiblingTest('scripts/foo.py', 'scripts/foo.test.js')).toBe(true);
    expect(isSiblingTest('scripts/setup-voice.ps1', 'scripts/setup-voice.ps1.test.js')).toBe(true);
    expect(isSiblingTest('scripts/setup-voice.ps1', 'scripts/setup-voice.test.js')).toBe(true);
    expect(isSiblingTest('scripts/fixtures/minimax_h3_history.py', 'scripts/_minimax_h3_mlx_history.test.js')).toBe(false);
    expect(isSiblingTest('scripts/foo.js', 'server/foo.test.js')).toBe(false);
  });

  it('filters historical documents and migrations out of the live reference corpus', () => {
    expect(HISTORICAL.test('docs/decisions/2026-09-19-federation.md')).toBe(true);
    expect(HISTORICAL.test('docs/plans/archive/2026-07-18-synthid-adversarial-jamming-experiment.md')).toBe(true);
    expect(HISTORICAL.test('docs/research/minimax-h3-continuity.md')).toBe(true);
    expect(HISTORICAL.test('scripts/migrations/444-minimax-h3-cuda-lightx2v.js')).toBe(true);
    expect(HISTORICAL.test('docs/SCRIPTS.md')).toBe(false);
    expect(HISTORICAL.test('server/index.js')).toBe(false);
  });

  it('catches scripts only referenced by their own sibling test or concluded plans, and covers scripts/{fixtures,experiments}/**', () => {
    // Sibling test reference is ignored by isSiblingTest
    expect(isSiblingTest('scripts/orphan.js', 'scripts/orphan.test.js')).toBe(true);
    expect(isSiblingTest('scripts/orphan.py', 'scripts/orphan_test.py')).toBe(true);
    // Historical paths and migrations are rejected by the corpus filter
    expect(HISTORICAL.test('docs/plans/archive/2026-07-18-synthid-adversarial-jamming-experiment.md')).toBe(true);
    expect(HISTORICAL.test('docs/research/minimax-h3-continuity.md')).toBe(true);
    expect(HISTORICAL.test('scripts/migrations/001-init.js')).toBe(true);
    // Candidate pattern covers subdirectories fixtures and experiments
    expect(CANDIDATE_SCRIPT.test('scripts/fixtures/minimax_h3_history.py')).toBe(true);
    expect(CANDIDATE_SCRIPT.test('scripts/experiments/synthid_jamming_eval.py')).toBe(true);
    expect(CANDIDATE_SCRIPT.test('scripts/ml/generate_ltx2.py')).toBe(true);
    expect(CANDIDATE_SCRIPT.test('scripts/ml/requirements/requirements-lyric-align.lock.txt')).toBe(true);
    expect(CANDIDATE_SCRIPT.test('scripts/ops/backfill-codex-image-usage.js')).toBe(true);
    expect(CANDIDATE_SCRIPT.test('scripts/lib/directInvocation.js')).toBe(false);
  });

  it('files Python sidecars and requirements under scripts/ml', () => {
    const rootFiles = trackedFiles(REPO_ROOT).filter((path) => /^scripts\/[^/]+$/.test(path));
    expect(rootFiles.filter((path) => path.endsWith('.py') || /^scripts\/requirements-.*\.txt$/.test(path))).toEqual([]);
  });

  it('every script is referenced by code, a workflow, package.json or a live doc', () => {
    const files = trackedFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(100);
    const candidates = files.filter((path) => CANDIDATE_SCRIPT.test(path) && !VITEST_COLLECTED.test(path));
    expect(candidates.length).toBeGreaterThan(100);
    // scripts/fixtures/** and scripts/experiments/** are covered
    expect(candidates.some((path) => path.startsWith('scripts/fixtures/'))).toBe(true);
    const corpus = files.filter((path) => !HISTORICAL.test(path));
    expect(unreferencedScripts(candidates, corpus), 'document in docs/SCRIPTS.md or delete').toEqual([]);
  }, 60_000); // reads every tracked file once; slower than the default 5 s on a loaded machine
});
