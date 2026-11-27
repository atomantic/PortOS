import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, mockNoPeers, mockNoPeerSync, ownTestBodies,
} from '../../../lib/mockPathsDataRoot.js';
import * as issuesSvc from '../issues.js';
import * as seasonsSvc from '../seasons.js';
import * as seriesSvc from '../series.js';
import { visualReady } from '../seriesAutopilot/stepResolver.js';
import { stageContentOf } from '../textStages.js';
import { applyBeatResolutions } from './beatContinuity.js';
import { buildBeatContinuityContext, shapeBeatResolutions } from './context.js';

vi.mock('../../../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-beat-continuity-'),
}));
vi.mock('../../instances.js', () => mockNoPeers());
vi.mock('../../sharing/peerSync.js', () => mockNoPeerSync());

const owned = ownTestBodies(it);
afterAll(async () => {
  try {
    await owned.drain();
  } finally {
    cleanupTempDataRoots();
  }
});

const ready = (output) => ({ status: 'ready', output });

describe('beat-continuity resolve (#1510)', () => {
  owned.it('buildBeatContinuityContext renders beats into the tree and counts beat-bearing issues', async () => {
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'A', summary: 'Sum' } });
    const season = await seasonsSvc.createSeason(series.id, { number: 1, title: 'V1' });
    const withBeats = await issuesSvc.createIssue({ seriesId: series.id, seasonId: season.id, title: 'I1', number: 1 });
    const synOnly = await issuesSvc.createIssue({ seriesId: series.id, seasonId: season.id, title: 'I2', number: 2 });
    await issuesSvc.updateStage(withBeats.id, 'idea', { status: 'ready', input: 'syn1', output: 'BEATS-A' });
    await issuesSvc.updateStage(synOnly.id, 'idea', { status: 'empty', input: 'syn2', output: '' });
    const fresh = await seriesSvc.getSeries(series.id);
    const ctx = await buildBeatContinuityContext(fresh);
    expect(ctx.beatBearingCount).toBe(1);          // only the one expanded issue
    expect(ctx.seasonsTreeJson).toContain('BEATS-A');
    expect(ctx.seasonsTreeJson).toContain('syn2');  // synopsis fallback for the un-expanded issue
  });

  owned.it('shapeBeatResolutions keeps valid entries, drops malformed, caps the count', () => {
    const out = shapeBeatResolutions([
      { episodeNumber: 1, beats: '  new beats  ', seasonNumber: 2 },
      { episodeNumber: 3, beats: '' },            // empty beats → dropped
      { episodeNumber: 'x', beats: 'b' },         // non-integer number → dropped
      { beats: 'no number' },                     // missing number → dropped
      { episodeNumber: 4, beats: 'b4' },          // seasonNumber absent → null
    ]);
    expect(out).toEqual([
      { seasonNumber: 2, episodeNumber: 1, beats: 'new beats' },
      { seasonNumber: null, episodeNumber: 4, beats: 'b4' },
    ]);
    expect(shapeBeatResolutions('nope')).toEqual([]);
  });

  // A single issue in a fresh series gets the recomputed series-global number 1.
  async function seedIssueWithBeats(over = {}) {
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
    const season = await seasonsSvc.createSeason(series.id, { number: 1, title: 'V1' });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, seasonId: season.id, title: 'I1', number: 1 });
    await issuesSvc.updateStage(issue.id, 'idea', { status: 'ready', input: 'synopsis', output: 'old beats', ...over });
    const fresh = await seriesSvc.getSeries(series.id);
    return { series: fresh, issueId: issue.id };
  }

  owned.it('rejects the whole candidate before clearing art when a pilot repair targets a later issue', async () => {
    const { series, issueId } = await seedIssueWithBeats();
    const later = await issuesSvc.createIssue({ seriesId: series.id, seasonId: series.seasons[0].id, title: 'Later', arcPosition: 2 });
    await issuesSvc.updateStage(later.id, 'idea', ready('later beats'));
    await issuesSvc.updateStage(later.id, 'comicScript', ready('later script'));
    await issuesSvc.updateStage(later.id, 'comicPages', { pages: [{ panels: [{ description: 'keep' }], proofImage: { filename: 'keep.png' } }] });
    const before = await issuesSvc.getIssue(later.id);
    const result = await applyBeatResolutions(series.id, series, [
      { seasonNumber: 1, episodeNumber: 1, beats: 'new pilot beats' },
      { seasonNumber: 1, episodeNumber: 2, beats: 'new later beats' },
    ], { allowedIssueIds: [issueId] });
    expect(result).toEqual([{ issueId: later.id, number: 2, skipped: 'outside-production-scope' }]);
    expect((await issuesSvc.getIssue(issueId)).stages.idea.output).toBe('old beats');
    expect((await issuesSvc.getIssue(later.id)).stages).toEqual(before.stages);
  });

  owned.it('writes the corrected beats to BOTH idea.input and idea.output so prose adapts from the fix', async () => {
    const { series, issueId } = await seedIssueWithBeats();
    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 1, beats: 'corrected beats' }]);
    expect(applied).toEqual([expect.objectContaining({ issueId, number: 1, corrected: true })]);
    const issue = await issuesSvc.getIssue(issueId);
    expect(issue.stages.idea.output).toBe('corrected beats');
    // idea.input must carry the fix too — downstream text generation reads
    // stageContentOf(idea), which prefers idea.input, so a fix only in
    // idea.output would never reach the regenerated prose/scripts.
    expect(issue.stages.idea.input).toBe('corrected beats');
    expect(issue.stages.idea.status).toBe('ready');
    // The real prose source-of-truth resolver must now surface the correction.
    expect(stageContentOf(issue.stages.idea)).toBe('corrected beats');
  });

  owned.it('clears stale downstream prose/scripts AND comicPages art so they regenerate from the corrected beats', async () => {
    const { series, issueId } = await seedIssueWithBeats();
    // Pre-existing downstream drafts (the re-run / resume case): prose, comicScript,
    // and rendered comic art were all generated from the OLD beats.
    await issuesSvc.updateStage(issueId, 'prose', { status: 'ready', output: 'old prose' });
    await issuesSvc.updateStage(issueId, 'comicScript', { status: 'ready', output: 'old script' });
    await issuesSvc.updateStage(issueId, 'comicPages', {
      status: 'ready',
      pages: [{ panels: [{ description: 'p' }], proofImage: { jobId: 'pg0' } }],
      cover: { proofImage: { jobId: 'cov' } },
      backCover: { proofImage: { jobId: 'bc' } },
    });
    // Sanity: art reads as fully drafted before the beat fix.
    expect(visualReady(await issuesSvc.getIssue(issueId))).toBe(true);

    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 1, beats: 'corrected beats' }]);
    expect(applied[0].clearedStages).toEqual(expect.arrayContaining(['prose', 'comicScript', 'comicPages']));
    const issue = await issuesSvc.getIssue(issueId);
    expect(issue.stages.idea.output).toBe('corrected beats');     // new beats applied
    expect(issuesSvc.isStageReady(issue.stages.prose)).toBe(false);       // stale text → cleared
    expect(issuesSvc.isStageReady(issue.stages.comicScript)).toBe(false); // stale script → cleared
    expect(visualReady(issue)).toBe(false);                     // stale art → re-draw forced
  });

  owned.it('does NOT clear a locked downstream stage when rewriting beats', async () => {
    const { series, issueId } = await seedIssueWithBeats();
    await issuesSvc.updateStage(issueId, 'comicScript', { status: 'ready', output: 'frozen script', locked: true });
    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 1, beats: 'corrected beats' }]);
    expect(applied[0].clearedStages).not.toContain('comicScript');
    const issue = await issuesSvc.getIssue(issueId);
    expect(issue.stages.comicScript.output).toBe('frozen script');  // untouched
  });

  owned.it('skips a locked idea stage', async () => {
    const { series, issueId } = await seedIssueWithBeats({ locked: true });
    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 1, beats: 'corrected' }]);
    expect(applied[0]).toMatchObject({ skipped: 'locked' });
    const issue = await issuesSvc.getIssue(issueId);
    expect(issue.stages.idea.output).toBe('old beats');  // untouched
  });

  owned.it('skips an issue that has no beats yet (corpus is beat-level)', async () => {
    const { series } = await seedIssueWithBeats({ status: 'empty', output: '' });
    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 1, beats: 'corrected' }]);
    expect(applied[0]).toMatchObject({ skipped: 'no-beats' });
  });

  owned.it('drops an unmatched correction rather than rewriting the wrong issue', async () => {
    const { series, issueId } = await seedIssueWithBeats();
    // Only episode 1 exists; a correction for episode 99 matches nothing.
    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 99, beats: 'corrected' }]);
    expect(applied[0]).toMatchObject({ skipped: 'no-match' });
    const issue = await issuesSvc.getIssue(issueId);
    expect(issue.stages.idea.output).toBe('old beats');  // untouched
  });
});
