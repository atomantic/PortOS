/**
 * issueStages.test.js
 *
 * Per-stage lock, canonExtraction marker, updateStage and runHistory snapshots. Split from issues.test.js (#16214); shared mocks and state live in
 * issues.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./issues.testFixtures.js'));

vi.mock('../../lib/fileUtils.js', () => h.fileUtilsFactory());
vi.mock('../../lib/conflictJournal.js', (importOriginal) => h.conflictJournalFactory(importOriginal));
vi.mock('crypto', () => h.cryptoFactory());
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());
vi.mock('./seriesCoverImage.js', () => h.coverRefresh);

const { coverRefresh } = h;
const svc = await import('./issues.js');
const cj = await import('../../lib/conflictJournal.js');

describe('pipeline issues service', () => {
  beforeEach(() => {
    h.resetFixtures(cj);
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

  describe('canonExtraction marker', () => {
    it('defaults to null on a fresh stage', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'C' });
      expect(i.stages.prose.canonExtraction).toBeNull();
    });

    it('round-trips a sanitized marker through updateStage', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'C' });
      const { stage } = await svc.updateStage(i.id, 'prose', {
        canonExtraction: {
          status: 'partial',
          error: 'object: safety refused',
          failedKinds: ['object', 'bogus'],
          extracted: { characters: 3, places: 1, objects: 0 },
          provider: 'codex', model: 'default',
          at: '2026-05-30T00:00:00.000Z',
        },
      });
      expect(stage.canonExtraction.status).toBe('partial');
      expect(stage.canonExtraction.failedKinds).toEqual(['object']); // unknown kind filtered
      expect(stage.canonExtraction.extracted).toEqual({ characters: 3, places: 1, objects: 0 });
      expect(stage.canonExtraction.provider).toBe('codex');
    });

    it('drops a marker with an invalid status (treated as never-attempted)', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'C' });
      const { stage } = await svc.updateStage(i.id, 'prose', {
        canonExtraction: { status: 'whoops' },
      });
      expect(stage.canonExtraction).toBeNull();
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

  it('refreshes the series thumbnail when a rendered issue cover is cleared', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    await svc.updateStage(i.id, 'comicPages', {
      status: 'ready',
      cover: { finalImage: { filename: 'old-cover.png', fromProof: false } },
    });
    coverRefresh.refreshSeriesCoverImage.mockClear();

    await svc.updateStage(i.id, 'comicPages', { status: 'empty', cover: null });

    expect(coverRefresh.refreshSeriesCoverImage).toHaveBeenCalledOnce();
    expect(coverRefresh.refreshSeriesCoverImage).toHaveBeenCalledWith('ser-1');
  });

  it('reads each requested issue once and writes only the final changed versions with history', async () => {
    const edited = await svc.createIssue({
      seriesId: 'ser-batch', title: 'Edited',
      stages: { prose: { runHistory: [{ runId: 'prior', output: 'draft' }] } },
    });
    const skipped = await svc.createIssue({ seriesId: 'ser-batch', title: 'Skipped' });
    await svc.createIssue({ seriesId: 'ser-other', title: 'Other' });
    const store = svc.issueStore();
    const reads = vi.spyOn(store, 'loadOne');
    const all = vi.spyOn(store, 'loadAll');
    const series = vi.spyOn(store, 'loadAllForSeries');
    const writes = vi.spyOn(store, 'saveOneNow');
    const results = await svc.updateStagesWithLatest('ser-batch', [
      { issueId: edited.id, stageId: 'prose', computeFn: () => ({ output: 'new' }) },
      { issueId: skipped.id, stageId: 'idea', computeFn: () => ({}) },
      { issueId: edited.id, stageId: 'prose', computeFn: (stage) => ({ output: stage.output + ' version' }) },
    ]);
    expect(reads.mock.calls).toEqual([[edited.id], [skipped.id]]);
    expect(all).not.toHaveBeenCalled();
    expect(series).not.toHaveBeenCalled();
    expect(writes.mock.calls.map(([id]) => id)).toEqual([edited.id]);
    expect(results.map(({ stage }) => stage.output)).toEqual(['new', '', 'new version']);
    expect((await svc.getIssue(edited.id)).stages.prose).toMatchObject({
      output: 'new version', runHistory: [{ runId: 'prior', output: 'draft' }],
    });
  });

  it('refreshes once when a batch replaces a rendered issue cover', async () => {
    const issue = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    await svc.updateStage(issue.id, 'comicPages', {
      status: 'ready',
      cover: { finalImage: { filename: 'old-cover.png', fromProof: false } },
    });
    coverRefresh.refreshSeriesCoverImage.mockClear();

    await svc.updateStagesWithLatest('ser-1', [
      {
        issueId: issue.id,
        stageId: 'comicPages',
        computeFn: (stage) => ({
          cover: {
            ...stage.cover,
            finalImage: { filename: 'new-cover.png', fromProof: false },
          },
        }),
      },
    ]);

    expect(coverRefresh.refreshSeriesCoverImage).toHaveBeenCalledOnce();
    expect(coverRefresh.refreshSeriesCoverImage).toHaveBeenCalledWith('ser-1');
  });

  it('refreshes once when a batch clears a rendered issue cover', async () => {
    const issue = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    await svc.updateStage(issue.id, 'comicPages', {
      status: 'ready',
      cover: { finalImage: { filename: 'old-cover.png', fromProof: false } },
    });
    coverRefresh.refreshSeriesCoverImage.mockClear();

    await svc.updateStagesWithLatest('ser-1', [{
      issueId: issue.id,
      stageId: 'comicPages',
      computeFn: () => ({ cover: null }),
    }]);

    expect(coverRefresh.refreshSeriesCoverImage).toHaveBeenCalledOnce();
    expect(coverRefresh.refreshSeriesCoverImage).toHaveBeenCalledWith('ser-1');
  });

  it('does not refresh after a batch patch that preserves the rendered cover filename', async () => {
    const issue = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    await svc.updateStage(issue.id, 'comicPages', {
      status: 'ready',
      cover: {
        script: 'old concept',
        finalImage: { filename: 'same-cover.png', fromProof: false },
      },
    });
    coverRefresh.refreshSeriesCoverImage.mockClear();

    await svc.updateStagesWithLatest('ser-1', [{
      issueId: issue.id,
      stageId: 'comicPages',
      computeFn: (stage) => ({ cover: { ...stage.cover, script: 'new concept' } }),
    }]);

    expect(coverRefresh.refreshSeriesCoverImage).not.toHaveBeenCalled();
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

    it('snapshots an input-only episode synopsis before replacement', async () => {
      const i = await svc.createIssue({ seriesId: 'ser-1', title: 'Pilot' });
      await svc.updateStage(i.id, 'idea', {
        status: 'edited', input: 'Authored episode synopsis', output: '',
      });
      await svc.updateStageWithLatest(i.id, 'idea', () => ({
        status: 'empty', input: '', output: '', lastRunId: 'canon-reset-1',
      }), { snapshotPrior: true });
      const fresh = await svc.getIssue(i.id);
      expect(fresh.stages.idea.runHistory).toHaveLength(1);
      expect(fresh.stages.idea.runHistory[0]).toMatchObject({
        runId: 'pre-canon-reset-1', input: 'Authored episode synopsis', output: '',
      });
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
});
