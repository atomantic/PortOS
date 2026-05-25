import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();
// One-shot write delay hook for the concurrency regression test: when set, the
// first atomicWrite whose (path, data) matches is held for `ms` before landing,
// letting a test force a specific read→write interleaving deterministically.
let pendingWriteDelay = null;

vi.mock('../../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => {
    if (pendingWriteDelay && pendingWriteDelay.match(path, data)) {
      const { ms } = pendingWriteDelay;
      pendingWriteDelay = null; // one-shot
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    fileStore.set(path, data);
  }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

const svc = await import('./issues.js');
const seriesSvc = await import('./series.js');
const seasonsSvc = await import('./seasons.js');
const { recordEvents } = await import('../sharing/recordEvents.js');

describe('pipeline issues service', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    pendingWriteDelay = null;
  });

  it('createIssue assigns iss- id and auto-numbers within a series', async () => {
    const a = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    const b = await svc.createIssue({ seriesId: 'ser-1', title: 'Second' });
    const c = await svc.createIssue({ seriesId: 'ser-2', title: 'Other series first' });
    expect(a.id).toMatch(/^iss-/);
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(c.number).toBe(1); // independent counter per series
  });

  describe('volume-ordered numbering', () => {
    const setupTwoVolumeSeries = async () => {
      const series = await seriesSvc.createSeries({ name: 'Saga' });
      const v1 = await seasonsSvc.createSeason(series.id, { title: 'Volume 1', number: 1 });
      const v2 = await seasonsSvc.createSeason(series.id, { title: 'Volume 2', number: 2 });
      return { series, v1, v2 };
    };

    it('issues number contiguously across volumes in season order', async () => {
      const { series, v1, v2 } = await setupTwoVolumeSeries();
      // V1 first (10 issues), then V2 (3 issues) — V2 should start at #11.
      for (let i = 1; i <= 10; i += 1) {
        await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: i, title: `V1 E${i}` });
      }
      for (let i = 1; i <= 3; i += 1) {
        await svc.createIssue({ seriesId: series.id, seasonId: v2.id, arcPosition: i, title: `V2 E${i}` });
      }
      const list = await svc.listIssues({ seriesId: series.id });
      const v1Numbers = list.filter((i) => i.seasonId === v1.id).map((i) => i.number).sort((a, b) => a - b);
      const v2Numbers = list.filter((i) => i.seasonId === v2.id).map((i) => i.number).sort((a, b) => a - b);
      expect(v1Numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(v2Numbers).toEqual([11, 12, 13]);
    });

    it('adding an issue to V1 shifts V2 numbers up', async () => {
      const { series, v1, v2 } = await setupTwoVolumeSeries();
      // Seed V1 with 2, V2 with 2.
      await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 1, title: 'V1 E1' });
      await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 2, title: 'V1 E2' });
      const v2first = await svc.createIssue({ seriesId: series.id, seasonId: v2.id, arcPosition: 1, title: 'V2 E1' });
      const v2second = await svc.createIssue({ seriesId: series.id, seasonId: v2.id, arcPosition: 2, title: 'V2 E2' });
      expect(v2first.number).toBe(3);
      expect(v2second.number).toBe(4);
      // Add a third issue to V1 — V2 should shift from #3..4 to #4..5.
      await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 3, title: 'V1 E3' });
      const after = await svc.listIssues({ seriesId: series.id });
      const v2NumbersAfter = after.filter((i) => i.seasonId === v2.id).map((i) => i.number).sort((a, b) => a - b);
      expect(v2NumbersAfter).toEqual([4, 5]);
    });

    it('deleting an issue compacts the sequence', async () => {
      const { series, v1, v2 } = await setupTwoVolumeSeries();
      const a = await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 1, title: 'V1 E1' });
      await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 2, title: 'V1 E2' });
      await svc.createIssue({ seriesId: series.id, seasonId: v2.id, arcPosition: 1, title: 'V2 E1' });
      await svc.deleteIssue(a.id);
      const after = await svc.listIssues({ seriesId: series.id });
      expect(after.map((i) => i.number)).toEqual([1, 2]);
    });

    it('changes to a later volume do not move earlier volumes', async () => {
      const { series, v1, v2 } = await setupTwoVolumeSeries();
      const v1a = await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 1, title: 'V1 E1' });
      const v1b = await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 2, title: 'V1 E2' });
      await svc.createIssue({ seriesId: series.id, seasonId: v2.id, arcPosition: 1, title: 'V2 E1' });
      // Append another V2 issue — V1's persisted numbers must not change.
      await svc.createIssue({ seriesId: series.id, seasonId: v2.id, arcPosition: 2, title: 'V2 E2' });
      const after = await svc.listIssues({ seriesId: series.id });
      const refetchedV1a = after.find((i) => i.id === v1a.id);
      const refetchedV1b = after.find((i) => i.id === v1b.id);
      expect(refetchedV1a.number).toBe(1);
      expect(refetchedV1b.number).toBe(2);
    });

    it('reordering season numbers triggers full series renumber', async () => {
      const { series, v1, v2 } = await setupTwoVolumeSeries();
      await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 1, title: 'V1 E1' });
      await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 2, title: 'V1 E2' });
      await svc.createIssue({ seriesId: series.id, seasonId: v2.id, arcPosition: 1, title: 'V2 E1' });
      await svc.createIssue({ seriesId: series.id, seasonId: v2.id, arcPosition: 2, title: 'V2 E2' });
      // Swap volume order: make v2 come first.
      await seasonsSvc.updateSeason(series.id, v2.id, { number: 1 });
      await seasonsSvc.updateSeason(series.id, v1.id, { number: 2 });
      const after = await svc.listIssues({ seriesId: series.id });
      const v2Nums = after.filter((i) => i.seasonId === v2.id).map((i) => i.number).sort((a, b) => a - b);
      const v1Nums = after.filter((i) => i.seasonId === v1.id).map((i) => i.number).sort((a, b) => a - b);
      expect(v2Nums).toEqual([1, 2]);
      expect(v1Nums).toEqual([3, 4]);
    });
  });

  it('createIssue requires seriesId and title', async () => {
    await expect(svc.createIssue({ title: 'x' })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    await expect(svc.createIssue({ seriesId: 'ser-1' })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('every stage is initialized to "empty"', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    for (const id of svc.STAGE_IDS) {
      expect(i.stages[id].status).toBe('empty');
      expect(i.stages[id].output).toBe('');
      // Per-stage lock defaults to false so existing issues stay regenerable.
      expect(i.stages[id].locked).toBe(false);
    }
  });

  describe('per-stage lock', () => {
    it('round-trips locked:true through updateStage', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'L' });
      const { stage } = await svc.updateStage(i.id, 'comicScript', { locked: true });
      expect(stage.locked).toBe(true);
    });

    it('updateStage with non-boolean locked coerces back to false', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'L' });
      await svc.updateStage(i.id, 'idea', { locked: true });
      // Anything that isn't strictly `true` clears the lock — guards against
      // a truthy-but-not-boolean payload silently locking the stage.
      const after = await svc.updateStage(i.id, 'idea', { locked: 'yes' });
      expect(after.stage.locked).toBe(false);
    });

    it('assertStageUnlocked throws ERR_STAGE_LOCKED when stage is locked', () => {
      const issue = { stages: { idea: { locked: true } } };
      expect(() => svc.assertStageUnlocked(issue, 'idea')).toThrow(/locked/);
      try { svc.assertStageUnlocked(issue, 'idea'); } catch (err) {
        expect(err.code).toBe(svc.ERR_STAGE_LOCKED);
        expect(err.status).toBe(400);
      }
    });

    it('assertStageUnlocked is a no-op when stage is unlocked or missing', () => {
      expect(() => svc.assertStageUnlocked({ stages: { idea: { locked: false } } }, 'idea')).not.toThrow();
      expect(() => svc.assertStageUnlocked({ stages: {} }, 'idea')).not.toThrow();
      expect(() => svc.assertStageUnlocked(null, 'idea')).not.toThrow();
    });
  });

  it('updateStage patches only the named stage', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    const { issue, stage } = await svc.updateStage(i.id, 'idea', {
      status: 'ready',
      output: '# Beat sheet ...',
      lastRunId: 'run-123',
    });
    expect(stage.status).toBe('ready');
    expect(stage.output).toBe('# Beat sheet ...');
    expect(stage.lastRunId).toBe('run-123');
    expect(stage.updatedAt).toBeTruthy();
    // Prose should still be empty.
    expect(issue.stages.prose.status).toBe('empty');
    expect(issue.stages.prose.output).toBe('');
  });

  it('updateStage rejects unknown stage ids', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    await expect(svc.updateStage(i.id, 'bogus', { status: 'ready' })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('updateStage on a visual stage preserves arrays', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    const { stage } = await svc.updateStage(i.id, 'comicPages', {
      status: 'ready',
      pages: [{ panels: [{ imageJobId: 'j1' }] }],
    });
    expect(stage.pages).toHaveLength(1);
    expect(stage.pages[0].panels[0].imageJobId).toBe('j1');
  });

  describe('runHistory snapshots', () => {
    const seedFirstRun = async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Pilot' });
      await svc.updateStage(i.id, 'idea', {
        status: 'ready', output: 'first beats', input: 'seed', lastRunId: 'run-1',
      });
      return i;
    };

    it('first generate does not snapshot — there is no prior content', async () => {
      const i = await seedFirstRun();
      const fresh = await svc.getIssue(i.id);
      expect(fresh.stages.idea.runHistory).toEqual([]);
    });

    it('second generate snapshots the prior version into runHistory', async () => {
      const i = await seedFirstRun();
      await svc.updateStage(i.id, 'idea', {
        status: 'ready', output: 'rewritten beats', lastRunId: 'run-2',
      });
      const fresh = await svc.getIssue(i.id);
      expect(fresh.stages.idea.output).toBe('rewritten beats');
      expect(fresh.stages.idea.lastRunId).toBe('run-2');
      expect(fresh.stages.idea.runHistory).toHaveLength(1);
      expect(fresh.stages.idea.runHistory[0]).toMatchObject({
        runId: 'run-1', output: 'first beats', input: 'seed',
      });
      expect(fresh.stages.idea.runHistory[0].createdAt).toBeTruthy();
    });

    it('newest snapshot is prepended (most-recent-first ordering)', async () => {
      const i = await seedFirstRun();
      await svc.updateStage(i.id, 'idea', { status: 'ready', output: 'v2', lastRunId: 'run-2' });
      await svc.updateStage(i.id, 'idea', { status: 'ready', output: 'v3', lastRunId: 'run-3' });
      const fresh = await svc.getIssue(i.id);
      expect(fresh.stages.idea.runHistory.map((e) => e.runId)).toEqual(['run-2', 'run-1']);
    });

    it('runHistory caps at STAGE_RUN_HISTORY_MAX', async () => {
      const i = await seedFirstRun();
      // Six more generates → seven total; cap is 5, so we should see runs 2..6 (most-recent-first).
      for (let n = 2; n <= 7; n += 1) {
        await svc.updateStage(i.id, 'idea', { status: 'ready', output: `v${n}`, lastRunId: `run-${n}` });
      }
      const fresh = await svc.getIssue(i.id);
      expect(fresh.stages.idea.runHistory).toHaveLength(svc.STAGE_RUN_HISTORY_MAX);
      expect(fresh.stages.idea.runHistory[0].runId).toBe('run-6');
      expect(fresh.stages.idea.runHistory.at(-1).runId).toBe('run-2');
    });

    it('save-edit (PATCH without lastRunId) does NOT snapshot', async () => {
      const i = await seedFirstRun();
      // Simulate the editor blur-save: input/output PATCH, no lastRunId.
      await svc.updateIssue(i.id, {
        stages: { idea: { status: 'edited', input: 'tweaked', output: 'hand-edited beats' } },
      });
      const fresh = await svc.getIssue(i.id);
      expect(fresh.stages.idea.output).toBe('hand-edited beats');
      expect(fresh.stages.idea.runHistory).toEqual([]);
    });

    it('status:"generating" transition (no lastRunId) does NOT snapshot', async () => {
      const i = await seedFirstRun();
      await svc.updateStage(i.id, 'idea', { status: 'generating' });
      const fresh = await svc.getIssue(i.id);
      expect(fresh.stages.idea.runHistory).toEqual([]);
    });

    it('error after a failed generate (no new lastRunId) does NOT snapshot', async () => {
      const i = await seedFirstRun();
      await svc.updateStage(i.id, 'idea', { status: 'error', errorMessage: 'LLM exploded' });
      const fresh = await svc.getIssue(i.id);
      expect(fresh.stages.idea.runHistory).toEqual([]);
    });

    it('visual stages do NOT snapshot — only text stages have runHistory entries', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'P' });
      await svc.updateStage(i.id, 'storyboards', { status: 'ready', output: 'v1', lastRunId: 'run-a' });
      await svc.updateStage(i.id, 'storyboards', { status: 'ready', output: 'v2', lastRunId: 'run-b' });
      const fresh = await svc.getIssue(i.id);
      expect(fresh.stages.storyboards.runHistory).toEqual([]);
    });

    it('restoreStageFromHistory re-activates a snapshot and snapshots the current state', async () => {
      const i = await seedFirstRun();
      await svc.updateStage(i.id, 'idea', { status: 'ready', output: 'v2', lastRunId: 'run-2' });
      // History now: [run-1]; active: run-2/'v2'.
      const restored = await svc.restoreStageFromHistory(i.id, 'idea', 'run-1');
      expect(restored.stage.output).toBe('first beats');
      expect(restored.stage.input).toBe('seed');
      expect(restored.stage.lastRunId).toBe('run-1');
      expect(restored.stage.status).toBe('edited');
      // Restore snapshots the just-displaced run-2 and dedups run-1 out of
      // the prior history (it's the new active runId, so leaving it in would
      // create a duplicate after the next regenerate).
      expect(restored.stage.runHistory.map((e) => e.runId)).toEqual(['run-2']);
    });

    it('restore → regenerate does not leave duplicate runIds in runHistory', async () => {
      const i = await seedFirstRun();
      await svc.updateStage(i.id, 'idea', { status: 'ready', output: 'v2', lastRunId: 'run-2' });
      // History: [run-1], active: run-2.
      await svc.restoreStageFromHistory(i.id, 'idea', 'run-1');
      // History: [run-2], active: run-1 (run-1 filtered out of prior history when displaced).
      await svc.updateStage(i.id, 'idea', { status: 'ready', output: 'v3', lastRunId: 'run-3' });
      const fresh = await svc.getIssue(i.id);
      const ids = fresh.stages.idea.runHistory.map((e) => e.runId);
      // Must contain run-1 (just displaced) and run-2 (from earlier displacement),
      // each exactly once. Active is run-3.
      expect(fresh.stages.idea.lastRunId).toBe('run-3');
      expect(ids).toEqual(['run-1', 'run-2']);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('restoreStageFromHistory rejects when runId is not in current history', async () => {
      const i = await seedFirstRun();
      await expect(svc.restoreStageFromHistory(i.id, 'idea', 'never-existed'))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });

    it('restoreStageFromHistory rejects non-text stage', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'P' });
      await expect(svc.restoreStageFromHistory(i.id, 'storyboards', 'r1'))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });

    it('sanitizes hand-loaded runHistory: drops malformed entries and caps length', async () => {
      // Simulate a hand-edited pipeline-issues.json on disk by creating an
      // issue with a fat input.stages payload that includes a junk runHistory.
      const oversize = Array.from({ length: 20 }, (_, n) => ({
        runId: `r${n}`, createdAt: '2026-01-01T00:00:00Z', output: 'x', input: '',
      }));
      const i = await svc.createIssue({
        seriesId: 'ser-1',
        title: 'P',
        stages: {
          idea: {
            status: 'ready', output: 'cur', lastRunId: 'cur',
            runHistory: [
              { /* missing runId */ output: 'no-id' },
              null,
              'not-an-object',
              ...oversize,
            ],
          },
        },
      });
      expect(i.stages.idea.runHistory).toHaveLength(svc.STAGE_RUN_HISTORY_MAX);
      // Order is preserved through sanitize — junk entries are dropped, then
      // the cap takes the first N from what survives.
      expect(i.stages.idea.runHistory.map((e) => e.runId)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
    });
  });

  it('listIssues filters by seriesId and orders by number', async () => {
    await svc.createIssue({ seriesId: 'ser-1', title: 'Issue 1' });
    await svc.createIssue({ seriesId: 'ser-2', title: 'Other 1' });
    await svc.createIssue({ seriesId: 'ser-1', title: 'Issue 2' });
    const list1 = await svc.listIssues({ seriesId: 'ser-1' });
    expect(list1.map((i) => i.number)).toEqual([1, 2]);
    expect(list1.every((i) => i.seriesId === 'ser-1')).toBe(true);
  });

  describe('listIssues pagination', () => {
    it('returns raw array when paginated is false (legacy default)', async () => {
      await svc.createIssue({ seriesId: 'ser-1', title: 'A' });
      await svc.createIssue({ seriesId: 'ser-1', title: 'B' });
      const result = await svc.listIssues({ seriesId: 'ser-1' });
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('returns paginated envelope when paginated:true', async () => {
      await svc.createIssue({ seriesId: 'ser-1', title: 'A' });
      await svc.createIssue({ seriesId: 'ser-1', title: 'B' });
      await svc.createIssue({ seriesId: 'ser-1', title: 'C' });
      const result = await svc.listIssues({ seriesId: 'ser-1', offset: 0, limit: 2, paginated: true });
      expect(result.total).toBe(3);
      expect(result.offset).toBe(0);
      expect(result.limit).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].title).toBe('A');
      expect(result.items[1].title).toBe('B');
    });

    it('respects offset when paginated:true', async () => {
      await svc.createIssue({ seriesId: 'ser-1', title: 'A' });
      await svc.createIssue({ seriesId: 'ser-1', title: 'B' });
      await svc.createIssue({ seriesId: 'ser-1', title: 'C' });
      const result = await svc.listIssues({ seriesId: 'ser-1', offset: 2, limit: 10, paginated: true });
      expect(result.total).toBe(3);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('C');
    });

    it('offset beyond total returns empty items but correct total', async () => {
      await svc.createIssue({ seriesId: 'ser-1', title: 'A' });
      const result = await svc.listIssues({ seriesId: 'ser-1', offset: 100, limit: 10, paginated: true });
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(0);
    });
  });

  describe('listRecentIssues', () => {
    it('orders descending by updatedAt across all series', async () => {
      const a = await svc.createIssue({ seriesId: 'ser-1', title: 'A' });
      const b = await svc.createIssue({ seriesId: 'ser-2', title: 'B' });
      const c = await svc.createIssue({ seriesId: 'ser-3', title: 'C' });
      // Bump A so it becomes unambiguously the most recent — its update
      // timestamp will be 10ms later than B and C's creates, which may
      // share the same ms-resolution timestamp with each other.
      await new Promise((r) => setTimeout(r, 10));
      await svc.updateStage(a.id, 'idea', { status: 'ready', output: 'fresh' });
      const recent = await svc.listRecentIssues({ limit: 10 });
      expect(recent[0].id).toBe(a.id);
      expect(recent).toHaveLength(3);
      // B and C may tie on ms-resolution timestamps; only assert their
      // membership in the remaining positions, not the order between them.
      expect(new Set(recent.slice(1).map((i) => i.id))).toEqual(new Set([b.id, c.id]));
    });

    it('clamps limit: < 1 → 1, > 50 → 50, non-numeric → default 10', async () => {
      for (let i = 0; i < 12; i += 1) {
        // Stagger to keep updatedAt monotonic.
        await svc.createIssue({ seriesId: 'ser-1', title: `T${i}` });
        await new Promise((r) => setTimeout(r, 2));
      }
      expect((await svc.listRecentIssues({ limit: 0 })).length).toBe(1);
      expect((await svc.listRecentIssues({ limit: -5 })).length).toBe(1);
      expect((await svc.listRecentIssues({ limit: 999 })).length).toBe(12);
      expect((await svc.listRecentIssues({ limit: 'abc' })).length).toBe(10);
      expect((await svc.listRecentIssues({})).length).toBe(10);
    });

    it('respects the upper clamp of 50', async () => {
      // Verifying the cap without creating 51 issues — pass an explicit
      // huge limit and confirm it clamps to 50 (one of the bounds), and
      // a limit of 50 returns up to 50.
      for (let i = 0; i < 3; i += 1) {
        await svc.createIssue({ seriesId: 'ser-1', title: `Y${i}` });
      }
      const r = await svc.listRecentIssues({ limit: 9999 });
      expect(r.length).toBeLessThanOrEqual(50);
    });
  });

  describe('list endpoints opt into runHistory strip', () => {
    // List payloads (sidebar, per-series list) never render runHistory,
    // and each text stage can hold up to 5 × ~600KB entries. Routes
    // pass `withHistory: false` so a maxed-out issue doesn't ship ~12MB
    // per read. The default stays `true` because `exportSeries` (and
    // other internal callers) round-trip the full record into bucket
    // exports; defaulting to strip would silently lose history on
    // receiving peers. Detail reads (`getIssue`) keep the full shape.
    const seedWithHistory = async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'With history' });
      await svc.updateStage(i.id, 'idea', { status: 'ready', input: 'seed', output: 'v1', lastRunId: 'r1' });
      await svc.updateStage(i.id, 'idea', { status: 'ready', input: 'seed', output: 'v2', lastRunId: 'r2' });
      return i;
    };

    it('listIssues default preserves runHistory (regression guard for exportSeries)', async () => {
      await seedWithHistory();
      const list = await svc.listIssues({ seriesId: 'ser-1' });
      expect(list).toHaveLength(1);
      expect(list[0].stages.idea.runHistory).toHaveLength(1);
      expect(list[0].stages.idea.runHistory[0].runId).toBe('r1');
    });

    it('listIssues withHistory:false strips runHistory but keeps active stage fields', async () => {
      await seedWithHistory();
      const list = await svc.listIssues({ seriesId: 'ser-1', withHistory: false });
      expect(list).toHaveLength(1);
      expect(list[0].stages.idea.runHistory).toEqual([]);
      // Active stage fields survive the strip.
      expect(list[0].stages.idea.output).toBe('v2');
      expect(list[0].stages.idea.lastRunId).toBe('r2');
    });

    it('listIssues paginated + withHistory:false strips runHistory from items', async () => {
      await seedWithHistory();
      const result = await svc.listIssues({
        seriesId: 'ser-1', offset: 0, limit: 10, paginated: true, withHistory: false,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].stages.idea.runHistory).toEqual([]);
    });

    it('listRecentIssues default preserves runHistory', async () => {
      await seedWithHistory();
      const recent = await svc.listRecentIssues({ limit: 10 });
      expect(recent).toHaveLength(1);
      expect(recent[0].stages.idea.runHistory).toHaveLength(1);
    });

    it('listRecentIssues withHistory:false strips runHistory', async () => {
      await seedWithHistory();
      const recent = await svc.listRecentIssues({ limit: 10, withHistory: false });
      expect(recent).toHaveLength(1);
      expect(recent[0].stages.idea.runHistory).toEqual([]);
    });

    it('getIssue (detail read) keeps the full runHistory', async () => {
      const i = await seedWithHistory();
      const fresh = await svc.getIssue(i.id);
      expect(fresh.stages.idea.runHistory).toHaveLength(1);
      expect(fresh.stages.idea.runHistory[0].runId).toBe('r1');
    });
  });

  it('updateIssue partial patch preserves other fields', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    await svc.updateStage(i.id, 'idea', { status: 'ready', output: 'Beats here' });
    const updated = await svc.updateIssue(i.id, { status: 'shipped' });
    expect(updated.status).toBe('shipped');
    expect(updated.title).toBe('First');
    expect(updated.stages.idea.output).toBe('Beats here');
  });

  it('updateIssue stage patch merges per-stage fields instead of replacing', async () => {
    // A partial stage patch from the client (e.g. saving genConfig from a
    // settings drawer) must not erase the rest of that stage. The header
    // gen-config save in particular was deleting `scenes` and `cover` until
    // updateIssue was taught to per-stage-merge.
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Merge me' });
    await svc.updateStage(i.id, 'storyboards', {
      status: 'edited',
      scenes: [{ slugline: 'INT. LAB', description: 'a scene' }],
    });
    await svc.updateStage(i.id, 'comicPages', {
      status: 'edited',
      pages: [{ panels: [{ description: 'panel one' }] }],
      cover: { script: 'cover concept', imageJobId: null, prompt: null },
    });

    // Patch only genConfig on storyboards — scenes must survive.
    const afterStoryboards = await svc.updateIssue(i.id, {
      stages: { storyboards: { genConfig: { imageMode: 'codex' } } },
    });
    expect(afterStoryboards.stages.storyboards.scenes).toHaveLength(1);
    expect(afterStoryboards.stages.storyboards.scenes[0].slugline).toBe('INT. LAB');
    expect(afterStoryboards.stages.storyboards.genConfig).toEqual({
      imageMode: 'codex', imageModelId: null, refineProvider: null, refineModel: null,
    });

    // Patch only cover on comicPages — pages must survive.
    const afterCover = await svc.updateIssue(i.id, {
      stages: { comicPages: { cover: { script: 'new concept' } } },
    });
    expect(afterCover.stages.comicPages.pages).toHaveLength(1);
    expect(afterCover.stages.comicPages.cover.script).toBe('new concept');
  });

  it('deep-merges cover sub-fields so a partial `{ cover: { script } }` patch preserves imageJobId/prompt', async () => {
    // Race regression: ComicScriptStage's textarea blur fires after a
    // "Render cover" mutation has persisted imageJobId. A naive shallow merge
    // would overwrite the imageJobId back to null. The deep-merge of `cover`
    // sub-fields keeps the freshly-queued render visible.
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Deep merge' });
    await svc.updateStage(i.id, 'comicPages', {
      status: 'edited',
      cover: { script: 'old', imageJobId: 'job-abc12345', prompt: 'p1' },
    });
    const updated = await svc.updateIssue(i.id, {
      stages: { comicPages: { cover: { script: 'new' } } },
    });
    expect(updated.stages.comicPages.cover).toMatchObject({
      script: 'new',
      imageJobId: 'job-abc12345',
      prompt: 'p1',
    });
  });

  it('deep-merges genConfig sub-fields so a partial `{ genConfig: { imageMode } }` patch preserves the rest', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Gen merge' });
    // Start with local mode + a pinned model — imageModelId is valid for local mode.
    await svc.updateStage(i.id, 'storyboards', {
      status: 'edited',
      genConfig: { imageMode: 'local', imageModelId: 'flux-1', refineProvider: null, refineModel: null },
    });
    // Partial patch only changes imageMode — imageModelId should survive the deep merge.
    const updated = await svc.updateIssue(i.id, {
      stages: { storyboards: { genConfig: { imageMode: 'local' } } },
    });
    expect(updated.stages.storyboards.genConfig).toMatchObject({
      imageMode: 'local',
      imageModelId: 'flux-1',
    });
  });

  it('sanitizeGenConfig clears imageModelId when imageMode is not local', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Gen mode clear' });
    // A codex-mode config with an imageModelId (stale client state) must not
    // persist the model id — it is meaningless for codex/auto and would mislead
    // the UI into showing a "pinned" model that generation ignores.
    await svc.updateStage(i.id, 'storyboards', {
      status: 'edited',
      genConfig: { imageMode: 'codex', imageModelId: 'flux-1', refineProvider: null, refineModel: null },
    });
    const issue = await svc.getIssue(i.id);
    expect(issue.stages.storyboards.genConfig.imageModelId).toBeNull();
  });

  it('treats `cover: null` as an explicit clear, not a deep merge', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Clear cover' });
    await svc.updateStage(i.id, 'comicPages', {
      status: 'edited',
      cover: { script: 'concept', imageJobId: null, prompt: null },
    });
    const updated = await svc.updateIssue(i.id, {
      stages: { comicPages: { cover: null } },
    });
    expect(updated.stages.comicPages.cover).toBeNull();
  });

  it('clears errorMessage when a stage patch transitions out of error state', async () => {
    // Regression: per-stage merge previously preserved `errorMessage` across
    // a `{ status: 'edited', input, output }` save. The pre-merge replace-
    // behavior implicitly wiped error state, and users expect that. Patches
    // that target `error`/`generating` keep the message (still active).
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Error clear' });
    await svc.updateStage(i.id, 'idea', {
      status: 'error',
      errorMessage: 'previous run failed',
    });
    expect((await svc.getIssue(i.id)).stages.idea.errorMessage).toBe('previous run failed');
    // Manual edit that flips status away from `error` — error message must clear.
    const edited = await svc.updateIssue(i.id, {
      stages: { idea: { status: 'edited', input: 'manual seed' } },
    });
    expect(edited.stages.idea.errorMessage).toBe('');
    expect(edited.stages.idea.input).toBe('manual seed');
  });

  it('preserves errorMessage when a patch leaves stage in error/generating state', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Error keep' });
    await svc.updateStage(i.id, 'idea', {
      status: 'error',
      errorMessage: 'still failing',
    });
    // Subsequent retry sets status back to generating — error should remain
    // visible until the retry transitions to ready or edited.
    const retry = await svc.updateIssue(i.id, {
      stages: { idea: { status: 'generating' } },
    });
    expect(retry.stages.idea.errorMessage).toBe('still failing');
  });

  it('drops cover field from non-comicPages visual stages on persist', async () => {
    // Contract: `cover` is only meaningful on comicPages — the route schema
    // documents this and the sanitizer enforces it. A misrouted patch should
    // not silently leave a phantom cover on storyboards / episodeVideo.
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Cover gate' });
    const patched = await svc.updateIssue(i.id, {
      stages: {
        comicPages: { cover: { script: 'should stay', imageJobId: null, prompt: null } },
        storyboards: { cover: { script: 'should be dropped', imageJobId: null, prompt: null } },
        episodeVideo: { cover: { script: 'should be dropped too', imageJobId: null, prompt: null } },
      },
    });
    expect(patched.stages.comicPages.cover).toMatchObject({ script: 'should stay' });
    expect(patched.stages.storyboards.cover).toBeNull();
    expect(patched.stages.episodeVideo.cover).toBeNull();
  });

  it('sanitizer rounds fractional pageTarget/minutesTarget to match computeIssueTargets', async () => {
    // Regression: sanitizer was using Math.floor while computeIssueTargets uses
    // Math.round (via clampInt), so persisted values could disagree with the
    // prompt-rendered targets. e.g. pageTarget: 22.7 → stored as 22 but
    // rendered as 23. Both must agree on 23.
    const i = await svc.createIssue({
      seriesId: 'ser-1',
      title: 'Rounding regression',
      lengthProfile: 'custom',
      pageTarget: 22.7,
      minutesTarget: 23.5,
    });
    expect(i.pageTarget).toBe(23);
    expect(i.minutesTarget).toBe(24);
  });

  it('deleteIssue 404s on second call', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    await svc.deleteIssue(i.id);
    await expect(svc.deleteIssue(i.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  describe('soft-delete (tombstones for peer sync)', () => {
    it('deleteIssue soft-deletes (record stays on disk with deleted=true)', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
      await svc.deleteIssue(i.id);
      expect((await svc.listIssues({ seriesId: 'ser-1' })).map((x) => x.id)).not.toContain(i.id);
      const all = await svc.listIssues({ seriesId: 'ser-1', includeDeleted: true });
      const tomb = all.find((x) => x.id === i.id);
      expect(tomb).toMatchObject({ deleted: true });
      expect(tomb.deletedAt).toBeTruthy();
    });

    it('getIssue 404s for tombstoned; includeDeleted exposes it', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Hidden' });
      await svc.deleteIssue(i.id);
      await expect(svc.getIssue(i.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      const tomb = await svc.getIssue(i.id, { includeDeleted: true });
      expect(tomb).toMatchObject({ id: i.id, deleted: true });
    });

    it('updateIssue 404s on a tombstone (no zombie edits)', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Locked' });
      await svc.deleteIssue(i.id);
      await expect(svc.updateIssue(i.id, { title: 'Zombie' })).rejects.toMatchObject({
        code: svc.ERR_NOT_FOUND,
      });
    });

    it('insertIssueWithId overwrites a tombstoned record (re-import undeletes)', async () => {
      const id = 'iss-550e8400-e29b-41d4-a716-44665544abce';
      await svc.insertIssueWithId({ id, seriesId: 'ser-1', title: 'First' });
      await svc.deleteIssue(id);
      const restored = await svc.insertIssueWithId({ id, seriesId: 'ser-1', title: 'Restored' });
      expect(restored).toMatchObject({ id, title: 'Restored', deleted: false });
    });

    it('insertIssueWithId resurrection fires emitRecordUpdated on the parent series', async () => {
      const id = 'iss-550e8400-e29b-41d4-a716-44665544abcd';
      await svc.insertIssueWithId({ id, seriesId: 'ser-resurrect', title: 'ToResurrect' });
      await svc.deleteIssue(id);

      const emitSpy = vi.spyOn(recordEvents, 'emit');

      await svc.insertIssueWithId({ id, seriesId: 'ser-resurrect', title: 'Resurrected' });

      expect(emitSpy).toHaveBeenCalledWith('updated', { recordKind: 'series', recordId: 'ser-resurrect' });
      emitSpy.mockRestore();
    });

    it('insertIssueWithId fresh insert does NOT fire emitRecordUpdated', async () => {
      const id = 'iss-550e8400-e29b-41d4-a716-44665544abe0';
      const emitSpy = vi.spyOn(recordEvents, 'emit');

      await svc.insertIssueWithId({ id, seriesId: 'ser-fresh', title: 'Brand New' });

      // insertIssueWithId (unlike createIssue) does not fire emitRecordUpdated
      // on a fresh insert — only on tombstone resurrection.
      expect(emitSpy).not.toHaveBeenCalledWith('updated', { recordKind: 'series', recordId: 'ser-fresh' });
      emitSpy.mockRestore();
    });

    it('insertIssueWithId still rejects DUPLICATE on a LIVE record', async () => {
      const id = 'iss-550e8400-e29b-41d4-a716-44665544abcf';
      await svc.insertIssueWithId({ id, seriesId: 'ser-1', title: 'First' });
      await expect(svc.insertIssueWithId({ id, seriesId: 'ser-1', title: 'Second' }))
        .rejects.toMatchObject({ code: svc.ERR_DUPLICATE });
    });

    it('renumberInline skips tombstones — surviving issues stay contiguous', async () => {
      const a = await svc.createIssue({ seriesId: 'ser-renum', title: 'A' });
      const b = await svc.createIssue({ seriesId: 'ser-renum', title: 'B' });
      const c = await svc.createIssue({ seriesId: 'ser-renum', title: 'C' });
      await svc.deleteIssue(b.id);
      const live = await svc.listIssues({ seriesId: 'ser-renum' });
      expect(live.map((i) => i.title)).toEqual(['A', 'C']);
      expect(live.map((i) => i.number)).toEqual([1, 2]);
      // Tombstone keeps its old number but is hidden from listIssues.
      const all = await svc.listIssues({ seriesId: 'ser-renum', includeDeleted: true });
      expect(all.find((i) => i.id === b.id).deleted).toBe(true);
      // Adding a new issue picks up after the live tail (3), not 4 from the tombstone.
      const d = await svc.createIssue({ seriesId: 'ser-renum', title: 'D' });
      expect(d.number).toBe(3);
    });

    describe('mergeIssuesFromSync', () => {
      it('applies an inbound soft-delete from a peer', async () => {
        const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Synced' });
        const ts = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeIssuesFromSync([{
          ...i,
          deleted: true,
          deletedAt: ts,
          updatedAt: ts,
        }]);
        expect(r).toEqual({ applied: true, count: 1 });
        await expect(svc.getIssue(i.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
      });

      it('LWW: an inbound edit with later updatedAt resurrects over a local tombstone', async () => {
        const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Original' });
        await svc.deleteIssue(i.id);
        const editTs = new Date(Date.now() + 60_000).toISOString();
        const r = await svc.mergeIssuesFromSync([{
          ...i,
          title: 'Edited After Delete',
          deleted: false,
          deletedAt: null,
          updatedAt: editTs,
        }]);
        expect(r.applied).toBe(true);
        const live = await svc.getIssue(i.id);
        expect(live).toMatchObject({ title: 'Edited After Delete', deleted: false });
      });

      it('synced RESURRECTION compacts collisions — issue restored mid-series gets a unique number', async () => {
        // Regression: local delete already compacts numbering (A=1, C=2 after
        // deleting B). When B's tombstone is overridden by a later remote edit
        // (B comes back to life), B re-enters with its OLD number (2) and
        // collides with C. mergeIssuesFromSync must trigger a renumber on
        // both delete-transitions AND resurrection-transitions.
        const a = await svc.createIssue({ seriesId: 'ser-resurrect', title: 'A' });
        const b = await svc.createIssue({ seriesId: 'ser-resurrect', title: 'B' });
        const c = await svc.createIssue({ seriesId: 'ser-resurrect', title: 'C' });
        expect([a.number, b.number, c.number]).toEqual([1, 2, 3]);
        await svc.deleteIssue(b.id);
        // Local compacts to A=1, C=2.
        const afterDelete = await svc.listIssues({ seriesId: 'ser-resurrect' });
        expect(afterDelete.map((i) => i.number)).toEqual([1, 2]);
        // Remote sends B with a later updatedAt — resurrection.
        const editTs = new Date(Date.now() + 60_000).toISOString();
        await svc.mergeIssuesFromSync([{
          ...b,
          deleted: false,
          deletedAt: null,
          updatedAt: editTs,
        }]);
        const live = await svc.listIssues({ seriesId: 'ser-resurrect' });
        // All three live, contiguous numbering, no duplicates.
        expect(live.map((i) => i.title).sort()).toEqual(['A', 'B', 'C']);
        const numbers = live.map((i) => i.number).sort((x, y) => x - y);
        expect(numbers).toEqual([1, 2, 3]);
        expect(new Set(numbers).size).toBe(3);
      });

      it('synced delete-transition compacts surviving issues for that series', async () => {
        const a = await svc.createIssue({ seriesId: 'ser-sync-renum', title: 'A' });
        const b = await svc.createIssue({ seriesId: 'ser-sync-renum', title: 'B' });
        const c = await svc.createIssue({ seriesId: 'ser-sync-renum', title: 'C' });
        expect([a.number, b.number, c.number]).toEqual([1, 2, 3]);
        const ts = new Date(Date.now() + 60_000).toISOString();
        await svc.mergeIssuesFromSync([{
          ...b,
          deleted: true,
          deletedAt: ts,
          updatedAt: ts,
        }]);
        const live = await svc.listIssues({ seriesId: 'ser-sync-renum' });
        expect(live.map((i) => i.title)).toEqual(['A', 'C']);
        expect(live.map((i) => i.number)).toEqual([1, 2]);
      });
    });

    describe('pruneTombstonedIssues', () => {
      it('removes tombstones older than the cutoff and leaves newer ones + live records', async () => {
        const live = await svc.createIssue({ seriesId: 'ser-prune', title: 'Live' });
        const oldT = await svc.createIssue({ seriesId: 'ser-prune', title: 'Old' });
        const newT = await svc.createIssue({ seriesId: 'ser-prune', title: 'New' });
        await svc.deleteIssue(oldT.id);
        await svc.deleteIssue(newT.id);
        // Back-date the old tombstone via merge so the GC sees it as 100s ago.
        const oldDeletedAt = new Date(Date.now() - 100_000).toISOString();
        const oldIssue = await svc.getIssue(oldT.id, { includeDeleted: true });
        await svc.mergeIssuesFromSync([{
          ...oldIssue,
          deletedAt: oldDeletedAt,
          updatedAt: new Date(Date.now() + 10_000).toISOString(),
        }]);
        const cutoff = Date.now() - 50_000;
        const result = await svc.pruneTombstonedIssues(cutoff);
        expect(result.pruned).toBe(1);
        const remaining = await svc.listIssues({ seriesId: 'ser-prune', includeDeleted: true });
        const ids = remaining.map((i) => i.id);
        expect(ids).toContain(live.id);
        expect(ids).toContain(newT.id);
        expect(ids).not.toContain(oldT.id);
      });

      it('keeps tombstones with unparseable deletedAt (conservative — never silently delete)', async () => {
        const issue = await svc.createIssue({ seriesId: 'ser-corrupt', title: 'C' });
        await svc.deleteIssue(issue.id);
        const tomb = await svc.getIssue(issue.id, { includeDeleted: true });
        await svc.mergeIssuesFromSync([{
          ...tomb,
          deletedAt: 'not-a-date',
          updatedAt: new Date(Date.now() + 10_000).toISOString(),
        }]);
        const result = await svc.pruneTombstonedIssues(Date.now() + 60_000_000);
        expect(result.pruned).toBe(0);
      });

      it('returns { pruned: 0 } for a non-finite cutoff (defensive)', async () => {
        expect(await svc.pruneTombstonedIssues(NaN)).toEqual({ pruned: 0 });
        expect(await svc.pruneTombstonedIssues(Infinity)).toEqual({ pruned: 0 });
        expect(await svc.pruneTombstonedIssues('nope')).toEqual({ pruned: 0 });
      });
    });
  });

  describe('isStageReady', () => {
    it('returns true for ready/edited stages with non-empty output', () => {
      expect(svc.isStageReady({ status: 'ready', output: 'beats' })).toBe(true);
      expect(svc.isStageReady({ status: 'edited', output: 'user typed' })).toBe(true);
    });
    it('returns false for empty/whitespace output regardless of status', () => {
      expect(svc.isStageReady({ status: 'ready', output: '' })).toBe(false);
      expect(svc.isStageReady({ status: 'ready', output: '   ' })).toBe(false);
    });
    it('returns false for non-terminal statuses', () => {
      expect(svc.isStageReady({ status: 'error', output: 'partial' })).toBe(false);
      expect(svc.isStageReady({ status: 'generating', output: 'mid' })).toBe(false);
      expect(svc.isStageReady({ status: 'empty', output: '' })).toBe(false);
    });
    it('returns false for null/undefined stage', () => {
      expect(svc.isStageReady(null)).toBe(false);
      expect(svc.isStageReady(undefined)).toBe(false);
    });
  });

  describe('insertIssueWithId', () => {
    it('preserves the caller-supplied id', async () => {
      const i = await svc.insertIssueWithId({ id: 'iss-fixed-xyz', seriesId: 'ser-1', title: 'Imported' });
      expect(i.id).toBe('iss-fixed-xyz');
      expect(i.seriesId).toBe('ser-1');
    });

    it('rejects malformed id', async () => {
      await expect(svc.insertIssueWithId({ id: 'wrong-prefix', seriesId: 'ser-1', title: 'X' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });

    it('rejects duplicate id', async () => {
      await svc.insertIssueWithId({ id: 'iss-dup', seriesId: 'ser-1', title: 'First' });
      await expect(svc.insertIssueWithId({ id: 'iss-dup', seriesId: 'ser-1', title: 'Second' }))
        .rejects.toMatchObject({ code: svc.ERR_DUPLICATE });
    });

    it('requires seriesId and title', async () => {
      await expect(svc.insertIssueWithId({ id: 'iss-no-series', title: 'X' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
      await expect(svc.insertIssueWithId({ id: 'iss-no-title', seriesId: 'ser-1' }))
        .rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    });
  });

  describe('audio stage sanitizer', () => {
    const makeIssue = (audio) => svc.createIssue({
      seriesId: 'ser-1',
      title: 'Pilot',
      stages: { audio },
    });

    it('seeds an empty audio stage by default', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'P' });
      expect(i.stages.audio).toEqual({
        status: 'empty', input: '', output: '', lastRunId: null,
        errorMessage: '', updatedAt: null, lines: [], music: null, locked: false,
        runHistory: [],
      });
    });

    it('round-trips lines[] with auto-assigned ids when omitted', async () => {
      const i = await makeIssue({
        status: 'edited',
        lines: [
          { text: 'Hello there.' },
          { id: 'line-custom', text: 'Goodbye.', characterId: 'chr-1' },
        ],
      });
      expect(i.stages.audio.lines).toHaveLength(2);
      expect(i.stages.audio.lines[0].id).toBe('line-001');
      expect(i.stages.audio.lines[1].id).toBe('line-custom');
      expect(i.stages.audio.lines[1].characterId).toBe('chr-1');
    });

    it('drops lines without text (empty / whitespace / missing)', async () => {
      const i = await makeIssue({
        lines: [
          { text: 'kept' },
          { text: '   ' },
          { text: '' },
          { /* missing entirely */ },
          null,
          'not-an-object',
          { text: 'also kept' },
        ],
      });
      expect(i.stages.audio.lines.map((l) => l.text)).toEqual(['kept', 'also kept']);
    });

    it('caps lines[] at 1000', async () => {
      const huge = Array.from({ length: 1500 }, (_, n) => ({ text: `line ${n}` }));
      const i = await makeIssue({ lines: huge });
      expect(i.stages.audio.lines).toHaveLength(1000);
    });

    it('sanitizes music: drops unknown source, keeps allowed values', async () => {
      const ok = await makeIssue({ music: { source: 'upload', trackFilename: 'bg.mp3', label: 'My track' } });
      expect(ok.stages.audio.music).toEqual({
        source: 'upload', trackFilename: 'bg.mp3', label: 'My track',
      });

      const bogus = await makeIssue({ music: { source: 'made-up' } });
      // source allow-list dropped → only label/trackFilename matter; with both
      // empty and source nulled, music falls to null entirely.
      expect(bogus.stages.audio.music).toBe(null);
    });

    it('updateStage round-trips audio lines through the audio branch', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'P' });
      const { stage } = await svc.updateStage(i.id, 'audio', {
        status: 'edited',
        lines: [{ id: 'line-001', text: 'fresh text', characterId: 'chr-9' }],
      });
      expect(stage.lines).toHaveLength(1);
      expect(stage.lines[0].text).toBe('fresh text');
      expect(stage.lines[0].characterId).toBe('chr-9');
    });
  });

  describe('bulkReassignSeason', () => {
    const setup = async () => {
      const series = await seriesSvc.createSeries({ name: 'Saga' });
      const a = await seasonsSvc.createSeason(series.id, { title: 'Vol A', number: 1 });
      const b = await seasonsSvc.createSeason(series.id, { title: 'Vol B', number: 2 });
      for (let i = 1; i <= 3; i += 1) {
        await svc.createIssue({ seriesId: series.id, seasonId: a.id, arcPosition: i, title: `A${i}` });
      }
      for (let i = 1; i <= 2; i += 1) {
        await svc.createIssue({ seriesId: series.id, seasonId: b.id, arcPosition: i, title: `B${i}` });
      }
      return { series, a, b };
    };

    it('moves every issue from one season to another and renumbers contiguously', async () => {
      const { series, a, b } = await setup();
      const result = await svc.bulkReassignSeason(series.id, a.id, b.id);
      expect(result.reassigned).toBe(3);
      const list = await svc.listIssues({ seriesId: series.id });
      const bIssues = list.filter((i) => i.seasonId === b.id);
      expect(bIssues).toHaveLength(5);
      // Numbers should be contiguous 1..5 across the (now sole) season.
      const numbers = list.map((i) => i.number).sort((x, y) => x - y);
      expect(numbers).toEqual([1, 2, 3, 4, 5]);
    });

    it('reassigning to null leaves issues un-grouped', async () => {
      const { series, a } = await setup();
      const result = await svc.bulkReassignSeason(series.id, a.id, null);
      expect(result.reassigned).toBe(3);
      const list = await svc.listIssues({ seriesId: series.id });
      const orphans = list.filter((i) => !i.seasonId);
      expect(orphans).toHaveLength(3);
    });

    it('returns { reassigned: 0 } and does not write when no issues match', async () => {
      const { series } = await setup();
      const result = await svc.bulkReassignSeason(series.id, 'sea-ghost', null);
      expect(result.reassigned).toBe(0);
    });

    it('skips tombstoned issues — soft-deleted records keep their seasonId + updatedAt', async () => {
      // Regression test: bulkReassignSeason must NOT bump a tombstone's
      // `updatedAt`, otherwise the receiver's tombstone wins the LWW race
      // against the originator's tombstone and the deleted issue can
      // resurrect on every peer.
      const { series, a, b } = await setup();
      const list = await svc.listIssues({ seriesId: series.id });
      const victim = list.find((i) => i.seasonId === a.id);
      await svc.deleteIssue(victim.id);
      const tombBefore = await svc.getIssue(victim.id, { includeDeleted: true });
      const result = await svc.bulkReassignSeason(series.id, a.id, b.id);
      // Live issues in season A moved (originally 3, one tombstoned → 2 live moved).
      expect(result.reassigned).toBe(2);
      // Tombstone preserved verbatim — seasonId unchanged, updatedAt unchanged,
      // still tombstoned.
      const tombAfter = await svc.getIssue(victim.id, { includeDeleted: true });
      expect(tombAfter).toMatchObject({
        seasonId: a.id,
        deleted: true,
        updatedAt: tombBefore.updatedAt,
      });
    });

    it('only touches issues in the matching series — other series untouched', async () => {
      const { series, a, b } = await setup();
      const other = await seriesSvc.createSeries({ name: 'Other' });
      const otherSeason = await seasonsSvc.createSeason(other.id, { title: 'X', number: 1 });
      await svc.createIssue({ seriesId: other.id, seasonId: otherSeason.id, title: 'Other-1' });

      await svc.bulkReassignSeason(series.id, a.id, b.id);

      const otherList = await svc.listIssues({ seriesId: other.id });
      expect(otherList).toHaveLength(1);
      expect(otherList[0].seasonId).toBe(otherSeason.id);
    });

    // Per-season editorial lock — refuses to move issues OUT of or INTO a
    // locked season. Pairs with `seasons.updateSeason`'s LOCKED_SEASON gate.
    it('refuses to reassign OUT of a locked source season', async () => {
      const { series, a, b } = await setup();
      await seasonsSvc.updateSeason(series.id, a.id, { locked: true });
      await expect(svc.bulkReassignSeason(series.id, a.id, b.id))
        .rejects.toMatchObject({ code: svc.ERR_SEASON_LOCKED });
      // Issues stayed put — unchanged seasonId.
      const list = await svc.listIssues({ seriesId: series.id });
      expect(list.filter((i) => i.seasonId === a.id)).toHaveLength(3);
    });

    it('refuses to reassign INTO a locked target season', async () => {
      const { series, a, b } = await setup();
      await seasonsSvc.updateSeason(series.id, b.id, { locked: true });
      await expect(svc.bulkReassignSeason(series.id, a.id, b.id))
        .rejects.toMatchObject({ code: svc.ERR_SEASON_LOCKED });
    });

    it('allows reassignment when neither season is locked', async () => {
      const { series, a, b } = await setup();
      // Sanity — explicitly lock and unlock to prove the gate clears.
      await seasonsSvc.updateSeason(series.id, a.id, { locked: true });
      await seasonsSvc.updateSeason(series.id, a.id, { locked: false });
      const result = await svc.bulkReassignSeason(series.id, a.id, b.id);
      expect(result.reassigned).toBe(3);
    });
  });

  describe('concurrent write serialization', () => {
    it('two concurrent writes do not clobber each other — both fields survive in final state', async () => {
      // This is the key regression test for the queueIssueWrite tail.
      // If the write queue is bypassed or broken, both calls read the same
      // pre-write snapshot and the last one to land wins — exactly one of
      // the two writes is silently dropped.
      const issue = await svc.createIssue({ seriesId: 'ser-1', title: 'Concurrency target' });

      // Fire two writes concurrently without awaiting individually.
      // updateStage writes to `idea.output`; updateIssue writes to top-level `status`.
      // A clobbering race would lose whichever write landed second (its pre-image
      // read captured an empty idea.output or no status change).
      await Promise.all([
        svc.updateStage(issue.id, 'idea', { status: 'ready', output: 'beat sheet content' }),
        svc.updateIssue(issue.id, { status: 'needs-review' }),
      ]);

      const final = await svc.getIssue(issue.id);
      // Both mutations must survive — if either is missing, the write tail is broken.
      expect(final.stages.idea.output).toBe('beat sheet content');
      expect(final.status).toBe('needs-review');
    });

    it('a series-wide renumber cannot clobber a concurrent stage save on an affected issue', async () => {
      // Regression for the per-record-split race (migrations 035/036): renumbers
      // serialize on the per-series tail while stage/single-issue saves used the
      // per-id tail — two independent mutexes over the same issue. A renumber that
      // rewrites an issue's number from a stale in-memory snapshot could clobber a
      // concurrent stage edit on it. Both now share the series tail.
      const series = await seriesSvc.createSeries({ name: 'Renumber race' });
      const v1 = await seasonsSvc.createSeason(series.id, { title: 'Volume 1', number: 1 });
      const v2 = await seasonsSvc.createSeason(series.id, { title: 'Volume 2', number: 2 });
      await svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 1, title: 'V1 E1' });
      const target = await svc.createIssue({ seriesId: series.id, seasonId: v2.id, arcPosition: 1, title: 'V2 E1' });
      expect(target.number).toBe(2); // numbered after the single V1 issue

      // Force the clobbering interleave deterministically: hold the STAGE write
      // of `target` (the one carrying the edit) until after the renumber's write
      // of `target` lands. Without a shared mutex the stage save read the issue
      // at #2, so its delayed write lands a stale {#2, output} over the renumber's
      // {#3, no output} — losing the renumber. Sharing the series tail forces the
      // stage save to run AFTER the renumber and re-read the freshest (#3) record,
      // so both the number and the edit survive.
      pendingWriteDelay = {
        ms: 50,
        match: (path, data) => path.includes(target.id) && data?.stages?.idea?.output === 'STAGE-EDIT',
      };

      // (a) stage edit on the V2 issue, (b) a new V1 issue that renumbers the V2
      // issue from #2 to #3 (rewriting target's record).
      await Promise.all([
        svc.updateStage(target.id, 'idea', { status: 'ready', output: 'STAGE-EDIT' }),
        svc.createIssue({ seriesId: series.id, seasonId: v1.id, arcPosition: 2, title: 'V1 E2' }),
      ]);

      const after = await svc.getIssue(target.id);
      expect(after.stages.idea.output).toBe('STAGE-EDIT'); // stage edit survived the renumber
      expect(after.stages.idea.status).toBe('ready');
      expect(after.number).toBe(3);                        // renumber also applied
    });
  });
});
