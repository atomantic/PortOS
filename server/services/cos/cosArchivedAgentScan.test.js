import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Counts archived metadata.json reads through the shared reader while both
// Learning tab endpoints run against a real temp archive.
const fixture = vi.hoisted(() => ({ state: { agents: {} }, index: new Map(), root: '', epoch: 0, reads: new Map() }));
vi.mock('./cosState.js', () => ({
  AGENTS_DIR: fixture.root,
  loadState: async () => fixture.state,
  saveState: async () => {},
  withStateLock: async (fn) => fn(),
}));
vi.mock('./cosAgentIndex.js', () => ({
  loadAgentIndex: async () => fixture.index,
  getAgentDir: (agentId, date) => join(fixture.root, date, agentId),
  archivedRecordCacheEpoch: () => fixture.epoch,
  invalidateArchivedRecord: () => { fixture.epoch++; },
}));
const ledgerRoot = await vi.hoisted(async () => {
  const { mkdtempSync: mk } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return mk(joinPath(tmp(), 'portos-archive-scan-ledger-'));
});
vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  const { makePathsProxy } = await import('../../lib/mockPathsDataRoot.js');
  const proxied = makePathsProxy(actual, { dataRoot: ledgerRoot });
  return {
    ...proxied,
    tryReadFileStrict: async (path, ...rest) => {
      if (path.endsWith('metadata.json')) fixture.reads.set(path, (fixture.reads.get(path) || 0) + 1);
      return actual.tryReadFileStrict(path, ...rest);
    },
  };
});

const { getFeedbackStats } = await import('./cosAgentFeedback.js');
const { getReviewerVerdictStats } = await import('../reviewerVerdicts.js');
const { invalidateArchivedRecord } = await import('./cosAgentIndex.js');
const { scanArchivedAgents } = await import('./cosArchivedAgentScan.js');

fixture.root = mkdtempSync(join(tmpdir(), 'portos-archive-scan-'));
afterAll(() => {
  rmSync(fixture.root, { recursive: true, force: true });
  rmSync(ledgerRoot, { recursive: true, force: true });
});

function archive(agentId, record) {
  const dir = join(fixture.root, '2026-10-01', agentId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(record));
  fixture.index.set(agentId, '2026-10-01');
}
const openLearningTab = () => Promise.all([getFeedbackStats(), getReviewerVerdictStats()]);
const takeReads = () => { const counts = Object.fromEntries([...fixture.reads].map(([p, n]) => [p.split(/[\\/]/).at(-2), n])); fixture.reads.clear(); return counts; };
const verdict = { reviewer: 'codex', verdict: 'clean', round: 1, changedLines: 10, recordedAt: '2026-10-01T09:00:00Z' };

beforeEach(() => {
  fixture.index = new Map();
  fixture.reads.clear();
  fixture.epoch++;
});

describe('Learning tab archive reads (#16593)', () => {
  it('reads each archived record once per change, shared by feedback and verdict stats', async () => {
    archive('agent-rated', { id: 'agent-rated', metadata: { taskDescription: 'Example' }, feedback: { rating: 'positive', submittedAt: '2026-10-01T10:00:00Z' } });
    archive('agent-reviewed', { id: 'agent-reviewed', metadata: { reviewVerdicts: [verdict] } });
    archive('agent-plain', { id: 'agent-plain', metadata: {} });

    const [feedback, verdicts] = await openLearningTab();
    expect(feedback.total).toBe(1);
    expect(verdicts).toMatchObject({ reports: 1, unreadableRuns: 0 });
    expect(takeReads()).toEqual({ 'agent-rated': 1, 'agent-reviewed': 1, 'agent-plain': 1 });

    await openLearningTab();
    expect(takeReads()).toEqual({});

    // A rating written to an archived record invalidates it, so the next open sees it.
    archive('agent-plain', { id: 'agent-plain', metadata: {}, feedback: { rating: 'negative', submittedAt: '2026-10-01T11:00:00Z' } });
    invalidateArchivedRecord('agent-plain');
    const [after] = await openLearningTab();
    expect(after).toMatchObject({ total: 2, negative: 1 });
    expect(takeReads()['agent-plain']).toBe(1);

    // A newly archived record is read without re-reading the rest.
    archive('agent-new', { id: 'agent-new', metadata: { reviewVerdicts: [verdict] } });
    const [, newVerdicts] = await openLearningTab();
    expect(newVerdicts.reports).toBe(2);
    expect(takeReads()).toEqual({ 'agent-new': 1 });
  });

  it('retains only the fields the stats use, not whole archived metadata', async () => {
    archive('agent-rated', { id: 'agent-rated', summary: 'x'.repeat(4096), metadata: { taskDescription: 'Fix the example bug', taskType: 'user', output: 'y'.repeat(4096), reviewVerdicts: [verdict] }, feedback: { rating: 'positive', submittedAt: '2026-10-01T10:00:00Z' } });
    const { byId } = await scanArchivedAgents();
    expect(byId.get('agent-rated')).toEqual({
      date: '2026-10-01',
      verdicts: [verdict],
      feedbackAgent: { id: 'agent-rated', feedback: { rating: 'positive', submittedAt: '2026-10-01T10:00:00Z' }, metadata: { taskDescription: 'Fix the example bug' }, feedbackTaskType: 'user-task' },
    });
  });

  it('keeps an unreadable record distinct from an empty archive and retries it', async () => {
    const dir = join(fixture.root, '2026-10-01', 'agent-broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'metadata.json'), '{not json');
    fixture.index.set('agent-broken', '2026-10-01');

    const [feedback, verdicts] = await openLearningTab();
    expect(feedback.total).toBe(0);
    expect(verdicts.unreadableRuns).toBe(1);
    expect(takeReads()).toEqual({ 'agent-broken': 1 });

    expect((await getReviewerVerdictStats()).unreadableRuns).toBe(1);
    expect(takeReads()).toEqual({ 'agent-broken': 1 });
  });
});
