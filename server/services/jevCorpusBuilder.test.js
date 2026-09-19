/**
 * The corpus builder's forge boundary.
 *
 * Three regressions none of the pure `lib/jevCorpus.js` tests can reach:
 * a failed forge read read as an empty repository, a merged pull request
 * counted twice (once as evidence FOR and once against), and a corpus written
 * to disk despite a refusal.
 */

import { mkdtemp, mkdir, writeFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dataRoot = await mkdtemp(join(tmpdir(), 'portos-jev-corpus-'));
const repoPath = await mkdtemp(join(tmpdir(), 'portos-jev-repo-'));

vi.mock('../lib/paths.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: dataRoot } };
});

// promisify(execFile) needs the callback form, so a bare vi.fn() would hang
// every query rather than failing one.
const execFile = vi.fn();
vi.mock('../lib/childProcess.js', () => ({
  execFile: (command, args, options, callback) => execFile(command, args, options, callback),
}));

const { buildScopeAdherenceCorpus } = await import('./jevCorpusBuilder.js');

// Enough distinct goals that the retriever has something to rank, and enough
// prose per clause to clear the parser's minimum.
const GOALS = Array.from({ length: 12 }, (_unused, index) => (
  `PortOS must ${['index', 'render', 'schedule', 'archive'][index % 4]} ${['agents', 'issues', 'media', 'peers'][index % 4]} `
  + `so the operator can review goal ${index} without leaving the machine.`
)).join('\n\n');

/** A forge answer per query, keyed by the `gh` subcommand shape. */
function mockForge({ merged = [], closed = [], notPlanned = [], parked = [], failAll = false } = {}) {
  execFile.mockImplementation((_command, args, _options, callback) => {
    if (failAll) return callback(new Error('gh: not authenticated'));
    const rows = args[0] === 'pr'
      ? (args.includes('merged') ? merged : closed)
      : (args.includes('future') ? parked : notPlanned);
    return callback(null, { stdout: JSON.stringify(rows), stderr: '' });
  });
}

const changes = (count, offset = 0) => Array.from({ length: count }, (_unused, index) => ({
  number: offset + index,
  title: `Change ${offset + index} to the ${['agent', 'issue', 'media', 'peer'][index % 4]} surface`,
  body: `Reworks how PortOS ${['indexes', 'renders', 'schedules', 'archives'][index % 4]} them for goal ${index % 12}.`,
}));

beforeEach(async () => {
  vi.clearAllMocks();
  await writeFile(join(repoPath, 'GOALS.md'), `# Goals\n\n${GOALS}\n`);
  const { resetClauseCorpusCache } = await import('./scopeAdherence.js');
  resetClauseCorpusCache();
});

describe('buildScopeAdherenceCorpus', () => {
  it('builds a split corpus and reports counts, never examples', async () => {
    mockForge({ merged: changes(60), notPlanned: changes(60, 500) });
    const result = await buildScopeAdherenceCorpus({ repoPath });
    expect(result.ok).toBe(true);
    expect(result.trainSize).toBeGreaterThan(0);
    expect(result.goldSize).toBeGreaterThanOrEqual(20);
    expect(result.sources['merged-pr']).toBeGreaterThan(0);
    expect(result.sources['closed-not-planned-issue']).toBeGreaterThan(0);
    // The manifest is a description of the corpus, not the corpus.
    expect(JSON.stringify(result)).not.toContain('Stated product goal');

    const written = await readdir(result.corpusDir);
    expect(written.sort()).toEqual(['gold.jsonl', 'manifest.json', 'train.jsonl']);
  });

  // `null` and `[]` must not collapse: a repository that has merged nothing is
  // not a machine that cannot reach its forge, and the two point at opposite
  // remedies.
  it('distinguishes an unreachable forge from a repository with no history', async () => {
    mockForge({ failAll: true });
    expect(await buildScopeAdherenceCorpus({ repoPath })).toEqual({ ok: false, code: 'jev-corpus-forge-unavailable' });

    mockForge({});
    expect(await buildScopeAdherenceCorpus({ repoPath })).toEqual({ ok: false, code: 'jev-corpus-too-small' });
  });

  // A PR counted as evidence both FOR and AGAINST is pure noise with a label
  // on it. `gh pr list --state closed` includes merged ones, so the merged
  // query's rows have to be dropped from it.
  it('does not count a merged pull request again as a closed-unmerged one', async () => {
    const merged = changes(60);
    mockForge({
      merged,
      // The same rows come back from the closed query, carrying `mergedAt`.
      closed: [...merged.map((row) => ({ ...row, mergedAt: '2026-09-01T00:00:00Z' })), ...changes(5, 900)],
      notPlanned: changes(30, 500),
    });
    const result = await buildScopeAdherenceCorpus({ repoPath });
    expect(result.ok).toBe(true);
    expect(result.sources['closed-unmerged-pr']).toBeGreaterThan(0);
    // Five unmerged rows at k clauses each, and not one row per merged PR.
    expect(result.sources['closed-unmerged-pr']).toBeLessThan(result.sources['merged-pr']);
  });

  it('refuses a repository that states no product intent', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'portos-jev-bare-'));
    mockForge({ merged: changes(60) });
    expect(await buildScopeAdherenceCorpus({ repoPath: bare })).toEqual({ ok: false, code: 'jev-corpus-no-clauses' });
    // A missing repoPath must not silently grade against this install's own.
    expect(await buildScopeAdherenceCorpus({})).toEqual({ ok: false, code: 'jev-corpus-no-clauses' });
  });

  // The gold set is too small to separate three numbers, so no corpus is
  // written at all — a refusal before the write, not a warning beside one.
  it('writes nothing when the corpus cannot support a comparison', async () => {
    const corpora = join(dataRoot, 'jev', 'corpora');
    await mkdir(corpora, { recursive: true });
    // Compared against a snapshot, not against empty: earlier cases in this
    // file legitimately wrote corpora into the same data root.
    const before = (await readdir(corpora)).sort();
    mockForge({ merged: changes(3) });
    expect((await buildScopeAdherenceCorpus({ repoPath })).ok).toBe(false);
    expect((await readdir(corpora)).sort()).toEqual(before);
  });
});
