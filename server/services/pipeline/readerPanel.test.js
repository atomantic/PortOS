import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the I/O + cross-service edges so the orchestration logic (seed contract,
// snapshot shape, staleness branch) is testable without a DB or the LLM. The
// pure mining (panelDisagreement.js) is left REAL — it's the logic under test.
const seedReviewFromFindings = vi.fn(async () => ({}));
const atomicWrite = vi.fn(async () => {});
const ensureDir = vi.fn(async () => {});
const tryReadFile = vi.fn(async () => null);
const computeSourceContentHash = vi.fn(async () => 'hash-current');
const rm = vi.fn(async () => {});

vi.mock('fs/promises', () => ({ rm: (...a) => rm(...a) }));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/tmp/panel-test-data' },
  atomicWrite: (...a) => atomicWrite(...a),
  ensureDir: (...a) => ensureDir(...a),
  tryReadFile: (...a) => tryReadFile(...a),
  safeJSONParse: (s) => (s == null ? null : JSON.parse(s)),
}));
vi.mock('../../lib/stageRunner.js', () => ({ runStagedLLM: vi.fn() }));
vi.mock('./readerPanelDigest.js', () => ({
  computeSourceContentHash: (...a) => computeSourceContentHash(...a),
  renderDigestText: (d) => JSON.stringify(d),
}));
vi.mock('./manuscriptReview.js', () => ({
  seedReviewFromFindings: (...a) => seedReviewFromFindings(...a),
}));

const { finalizePanel, getReaderPanel, clearReaderPanel } = await import('./readerPanel.js');

// Build a persona response with a given per-question citation set.
function persona(id, cites = {}) {
  const answers = {};
  for (const q of ['momentum_loss', 'earned_ending', 'cut_candidate', 'missing_scene', 'thinnest_character', 'best_scene', 'worst_scene', 'would_recommend', 'haunts_you', 'next_book']) {
    answers[q] = { text: `${id}-${q}`, issues: cites[q] || [] };
  }
  return { persona: id, answers, verdict: `${id} verdict` };
}

const digest = { sourceContentHash: 'hash-run', generatedAt: '2026-07-04T00:00:00Z', issueNumbers: [4], issueCount: 1 };

beforeEach(() => {
  seedReviewFromFindings.mockClear();
  atomicWrite.mockClear();
  ensureDir.mockClear();
  rm.mockClear();
  tryReadFile.mockReset().mockResolvedValue(null);
  computeSourceContentHash.mockReset().mockResolvedValue('hash-current');
});

describe('finalizePanel', () => {
  const responses = ['editor', 'genre-reader', 'writer'].map((id) => persona(id, { momentum_loss: [4] }));

  it('seeds ≥3-persona consensus into review in fresh mode under the reader-panel checkId', async () => {
    const snap = await finalizePanel('ser-1', digest, responses, { runId: 'run-1' });
    expect(seedReviewFromFindings).toHaveBeenCalledTimes(1);
    const [seriesId, findings, opts] = seedReviewFromFindings.mock.calls[0];
    expect(seriesId).toBe('ser-1');
    expect(opts).toMatchObject({ mode: 'fresh', checkId: 'reader-panel.consensus', runId: 'run-1' });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ issueNumber: 4, checkId: 'reader-panel.consensus' });

    // Snapshot persisted with the mined disagreements + provenance.
    expect(atomicWrite).toHaveBeenCalledTimes(1);
    expect(snap.status).toBe('complete');
    expect(snap.seededFindings).toBe(1);
    expect(snap.checkId).toBe('reader-panel.consensus');
    expect(snap.sourceContentHash).toBe('hash-run');
    expect(snap.disagreements.consensus).toHaveLength(1);
    expect(snap.personas).toHaveLength(3);
  });

  it('still reconciles (fresh, zero findings) when the panel found no consensus', async () => {
    const noConsensus = [persona('editor', { momentum_loss: [4] }), persona('writer', {})];
    const snap = await finalizePanel('ser-2', digest, noConsensus, { runId: 'run-2' });
    expect(seedReviewFromFindings).toHaveBeenCalledTimes(1);
    const [, findings, opts] = seedReviewFromFindings.mock.calls[0];
    expect(findings).toEqual([]);
    expect(opts.mode).toBe('fresh');
    expect(snap.seededFindings).toBe(0);
  });
});

describe('clearReaderPanel', () => {
  it('fresh-seeds an empty finding set AND removes the stored snapshot', async () => {
    await clearReaderPanel('ser-3', { runId: 'run-3' });
    expect(seedReviewFromFindings).toHaveBeenCalledWith('ser-3', [], { runId: 'run-3', mode: 'fresh', checkId: 'reader-panel.consensus' });
    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm.mock.calls[0][0]).toContain('ser-3.json');
  });
});

describe('getReaderPanel / staleness', () => {
  it('returns status none when no panel has been convened', async () => {
    tryReadFile.mockResolvedValue(null);
    const panel = await getReaderPanel('ser-4');
    expect(panel.status).toBe('none');
    expect(computeSourceContentHash).not.toHaveBeenCalled();
  });

  it('flags stale when current content hash differs from the stored hash', async () => {
    tryReadFile.mockResolvedValue(JSON.stringify({ seriesId: 'ser-5', status: 'complete', sourceContentHash: 'hash-old', personas: [] }));
    computeSourceContentHash.mockResolvedValue('hash-new');
    const panel = await getReaderPanel('ser-5');
    expect(panel.stale).toBe(true);
  });

  it('is not stale when the hash matches', async () => {
    tryReadFile.mockResolvedValue(JSON.stringify({ seriesId: 'ser-6', status: 'complete', sourceContentHash: 'hash-x', personas: [] }));
    computeSourceContentHash.mockResolvedValue('hash-x');
    const panel = await getReaderPanel('ser-6');
    expect(panel.stale).toBe(false);
  });

  it('rejects a path-traversal series id', async () => {
    await expect(getReaderPanel('../etc/passwd')).rejects.toThrow(/Invalid series id/);
  });
});
