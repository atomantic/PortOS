/**
 * issuesShared.test.js
 *
 * Shared helpers: stage readiness, audio sanitizers, line offsets and the per-series write queue. Split from issues.test.js (#16214); shared mocks and state live in
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

const { state } = h;
const svc = await import('./issues.js');
const seriesSvc = await import('./series.js');
const seasonsSvc = await import('./seasons.js');
const cj = await import('../../lib/conflictJournal.js');

describe('pipeline issues service', () => {
  beforeEach(() => {
    h.resetFixtures(cj);
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
        runHistory: [], audioMode: 'per-clip', cues: [],
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

    it('defaults audioMode to per-clip and keeps known values', async () => {
      const def = await makeIssue({ lines: [] });
      expect(def.stages.audio.audioMode).toBe('per-clip');
      for (const mode of ['silent', 'generated', 'uploaded-track', 'per-clip']) {
        const i = await makeIssue({ audioMode: mode });
        expect(i.stages.audio.audioMode).toBe(mode);
      }
    });

    it('coerces unknown / non-string audioMode to per-clip', async () => {
      for (const bogus of ['made-up', 42, null, {}, '']) {
        const i = await makeIssue({ audioMode: bogus });
        expect(i.stages.audio.audioMode).toBe('per-clip');
      }
    });

    it('round-trips cues[] with auto-assigned ids and time/render sentinels', async () => {
      const i = await makeIssue({
        audioMode: 'generated',
        cues: [
          { label: 'Act I', prompt: 'warm pads', engine: 'audioldm2', startSec: 0, endSec: 84.5 },
          { id: 'cue-custom', prompt: 'tense strings', gain: 0.5 },
        ],
      });
      const cues = i.stages.audio.cues;
      expect(cues).toHaveLength(2);
      expect(cues[0]).toEqual({
        id: 'cue-001', label: 'Act I', prompt: 'warm pads', engine: 'audioldm2',
        startSec: 0, endSec: 84.5, trackFilename: null, durationSec: null, gain: null,
      });
      expect(cues[1].id).toBe('cue-custom');
      // null = "not placed / not rendered yet"; gain 0.5 preserved.
      expect(cues[1].startSec).toBeNull();
      expect(cues[1].endSec).toBeNull();
      expect(cues[1].trackFilename).toBeNull();
      expect(cues[1].durationSec).toBeNull();
      expect(cues[1].gain).toBe(0.5);
    });

    it('cue gain distinguishes null (default) from 0 (muted) and clamps the range', async () => {
      const i = await makeIssue({
        cues: [
          { prompt: 'a' },              // gain omitted → null
          { prompt: 'b', gain: 0 },     // intentional mute → 0
          { prompt: 'c', gain: 99 },    // clamped to 4
          { prompt: 'd', gain: -1 },    // negative → null
        ],
      });
      expect(i.stages.audio.cues.map((c) => c.gain)).toEqual([null, 0, 4, null]);
    });

    it('caps cues[] at the max (slice before sanitize, mirroring lines[])', async () => {
      const huge = Array.from({ length: 300 }, (_, n) => ({ prompt: `cue ${n}` }));
      const i = await makeIssue({ cues: huge });
      expect(i.stages.audio.cues).toHaveLength(200);
    });

    it('drops non-object cues', async () => {
      const i = await makeIssue({ cues: [{ prompt: 'keep' }, null, 'nope', 42, { prompt: 'also keep' }] });
      expect(i.stages.audio.cues.map((c) => c.prompt)).toEqual(['keep', 'also keep']);
    });

    it('non-array cues collapses to []', async () => {
      const i = await makeIssue({ cues: 'not-an-array' });
      expect(i.stages.audio.cues).toEqual([]);
    });
  });

  describe('concurrent write serialization', () => {
    it('updateStagesWithLatest validates the whole batch before writing any issue', async () => {
      const first = await svc.createIssue({
        seriesId: 'ser-1',
        title: 'First',
        stages: { prose: { output: 'First draft.', status: 'ready' } },
      });
      const second = await svc.createIssue({
        seriesId: 'ser-1',
        title: 'Second',
        stages: { prose: { output: 'Second draft.', status: 'ready' } },
      });

      await expect(
        svc.updateStagesWithLatest('ser-1', [
          {
            issueId: first.id,
            stageId: 'prose',
            computeFn: () => ({ output: 'First changed.', status: 'edited', lastRunId: 'bulk-1' }),
          },
          {
            issueId: second.id,
            stageId: 'prose',
            computeFn: () => {
              throw Object.assign(new Error('stale second section'), { code: 'TEST_STALE' });
            },
          },
        ], { snapshotPrior: true }),
      ).rejects.toMatchObject({ code: 'TEST_STALE' });

      const afterFirst = await svc.getIssue(first.id);
      const afterSecond = await svc.getIssue(second.id);
      expect(afterFirst.stages.prose.output).toBe('First draft.');
      expect(afterSecond.stages.prose.output).toBe('Second draft.');
    });

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
      state.pendingWriteDelay = {
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

  describe('sanitizeLineOffset (VO per-line offset)', () => {
    it('keeps a valid non-negative number, distinguishing 0 from null', () => {
      expect(svc.sanitizeLineOffset(0)).toBe(0);
      expect(svc.sanitizeLineOffset(3.5)).toBe(3.5);
    });
    it('treats absent / cleared as null (un-placed), not 0', () => {
      expect(svc.sanitizeLineOffset(null)).toBeNull();
      expect(svc.sanitizeLineOffset(undefined)).toBeNull();
    });
    it('collapses negative / non-finite input to null', () => {
      expect(svc.sanitizeLineOffset(-1)).toBeNull();
      expect(svc.sanitizeLineOffset(NaN)).toBeNull();
      expect(svc.sanitizeLineOffset('abc')).toBeNull();
    });
    it('clamps an absurd offset to the 2-hour ceiling', () => {
      expect(svc.sanitizeLineOffset(999999)).toBe(7200);
    });
    it('round-trips through the audio stage sanitizer', async () => {
      const issue = await svc.createIssue({ seriesId: 'ser-1', title: 'E1' });
      const { stage } = await svc.updateStage(issue.id, 'audio', {
        lines: [
          { id: 'line-001', text: 'Hello', offsetSec: 4.2 },
          { id: 'line-002', text: 'World', offsetSec: -5 },   // invalid → null
          { id: 'line-003', text: 'Quiet' },                  // absent → null
        ],
      });
      expect(stage.lines[0].offsetSec).toBe(4.2);
      expect(stage.lines[1].offsetSec).toBeNull();
      expect(stage.lines[2].offsetSec).toBeNull();
    });
  });
});
