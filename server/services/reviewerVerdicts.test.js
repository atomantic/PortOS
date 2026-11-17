import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ state: { agents: {} }, index: new Map(), root: '', epoch: 0 }));
vi.mock('./cosState.js', () => ({ loadState: async () => fixture.state }));
vi.mock('./cosAgentIndex.js', () => ({
  loadAgentIndex: async () => fixture.index,
  getAgentDir: (agentId, date) => join(fixture.root, date, agentId),
  archivedRecordCacheEpoch: () => fixture.epoch,
}));

const { getReviewerVerdictStats } = await import('./reviewerVerdicts.js');

fixture.root = mkdtempSync(join(tmpdir(), 'portos-reviewer-verdicts-'));
afterAll(() => rmSync(fixture.root, { recursive: true, force: true }));

const verdict = (reviewer, value, round, changedLines) => ({ reviewer, verdict: value, round, changedLines, recordedAt: '2026-10-01T09:00:00Z' });
function archive(agentId, record) {
  const dir = join(fixture.root, '2026-10-01', agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(record));
  fixture.index.set(agentId, '2026-10-01');
}

beforeEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
  mkdirSync(fixture.root, { recursive: true });
  fixture.index = new Map();
  fixture.state = { agents: {} };
  // Each test starts from a fresh archive, as a restore would.
  fixture.epoch++;
});

describe('getReviewerVerdictStats', () => {
  it('aggregates clean rate per reviewer and per size bucket across archived and live runs', async () => {
    archive('agent-a', { id: 'agent-a', metadata: { reviewVerdicts: [
      verdict('codex', 'findings', 1, 140), verdict('codex', 'clean', 2, 150), verdict('opencode', 'clean', 1, 140),
    ] } });
    // A run archived before verdicts were recorded, and one with an unreadable file.
    archive('agent-old', { id: 'agent-old', status: 'completed', metadata: { taskDescription: 'Example' } });
    mkdirSync(join(fixture.root, '2026-10-01', 'agent-broken'), { recursive: true });
    writeFileSync(join(fixture.root, '2026-10-01', 'agent-broken', 'metadata.json'), '{not json');
    fixture.index.set('agent-broken', '2026-10-01');
    // Live state wins over its own archived copy, and malformed entries are skipped.
    archive('agent-live', { id: 'agent-live', metadata: { reviewVerdicts: [verdict('codex', 'clean', 1, 5)] } });
    fixture.state.agents['agent-live'] = { id: 'agent-live', status: 'running', metadata: { reviewVerdicts: [
      verdict('codex', 'findings', 1, 5), { reviewer: 'codex', verdict: 'maybe' }, null,
      { reviewer: 'codex', verdict: 'findings', recordedAt: 'x' },
    ] } };
    fixture.state.agents['agent-new'] = { id: 'agent-new', status: 'running', metadata: {} };

    const stats = await getReviewerVerdictStats();

    expect(stats.runs).toBe(2);
    expect(stats.reports).toBe(5);
    expect(stats.unreadableRuns).toBe(1);
    expect(stats.byReviewer).toEqual([
      // agent-a took 2 codex rounds; agent-live reported one unnumbered + one numbered round.
      { reviewer: 'codex', reports: 4, clean: 1, findings: 3, cleanRate: 25, runs: 2, avgRounds: 1.5 },
      { reviewer: 'opencode', reports: 1, clean: 1, findings: 0, cleanRate: 100, runs: 1, avgRounds: 1 },
    ]);
    expect(Object.fromEntries(stats.bySize.map(b => [b.bucket, [b.reports, b.cleanRate]]))).toEqual({
      xs: [1, 0], s: [0, null], m: [3, 67], l: [0, null], unknown: [1, 0],
    });
  });

  it('returns an empty aggregate when no run has recorded verdicts', async () => {
    archive('agent-old', { id: 'agent-old', metadata: {} });
    const stats = await getReviewerVerdictStats();
    expect(stats).toMatchObject({ runs: 0, reports: 0, byReviewer: [], unreadableRuns: 0 });
    expect(stats.bySize.every(b => b.reports === 0 && b.cleanRate === null)).toBe(true);
  });
});

describe('archive cache', () => {
  it('reuses archived verdicts across requests and re-reads after an archive write', async () => {
    archive('agent-a', { id: 'agent-a', metadata: { reviewVerdicts: [verdict('codex', 'findings', 1, 10)] } });
    expect((await getReviewerVerdictStats()).reports).toBe(1);

    // Rewritten on disk without an epoch bump: the cached verdicts still answer.
    archive('agent-a', { id: 'agent-a', metadata: { reviewVerdicts: [verdict('codex', 'clean', 1, 10), verdict('codex', 'clean', 2, 10)] } });
    expect((await getReviewerVerdictStats()).reports).toBe(1);

    // A newly indexed run is read even while the cache holds.
    archive('agent-b', { id: 'agent-b', metadata: { reviewVerdicts: [verdict('opencode', 'clean', 1, 10)] } });
    expect((await getReviewerVerdictStats()).reports).toBe(2);

    fixture.epoch++;
    expect((await getReviewerVerdictStats()).reports).toBe(3);
  });

  it('does not cache an unreadable record, so a later read sees it', async () => {
    const dir = join(fixture.root, '2026-10-01', 'agent-a');
    mkdirSync(join(dir, 'metadata.json'), { recursive: true });
    fixture.index.set('agent-a', '2026-10-01');
    expect(await getReviewerVerdictStats()).toMatchObject({ reports: 0, unreadableRuns: 1 });

    rmSync(join(dir, 'metadata.json'), { recursive: true });
    archive('agent-a', { id: 'agent-a', metadata: { reviewVerdicts: [verdict('codex', 'clean', 1, 10)] } });
    expect(await getReviewerVerdictStats()).toMatchObject({ reports: 1, unreadableRuns: 0 });
  });
});

describe('diff-size buckets', () => {
  it('places each boundary in its bucket, an absent count in unknown, and skips an invalid count', async () => {
    const lines = [0, 20, 21, 100, 101, 500, 501, undefined, -3, 2.5];
    fixture.state.agents['agent-sizes'] = { id: 'agent-sizes', status: 'running', metadata: {
      reviewVerdicts: lines.map((changedLines, i) => verdict('codex', 'clean', i + 1, changedLines)) } };
    const stats = await getReviewerVerdictStats();
    expect(Object.fromEntries(stats.bySize.map(b => [b.bucket, b.reports]))).toEqual({ xs: 2, s: 2, m: 2, l: 1, unknown: 1 });
    expect(stats.reports).toBe(8);
  });
});
