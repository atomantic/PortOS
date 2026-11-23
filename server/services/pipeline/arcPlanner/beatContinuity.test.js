/**
 * beatContinuity.test.js
 *
 * arcPlanner beat-continuity resolve internals. Split from seriesAutopilot.test.js (#16214); shared mocks and
 * fixtures live in seriesAutopilot.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('../seriesAutopilot/seriesAutopilot.testFixtures.js'));
const { ready } = h;

vi.mock('../../runner.js', (importOriginal) => h.runnerFactory(importOriginal));
vi.mock('../../../lib/fileUtils.js', () => h.fileUtilsFactory());
vi.mock('crypto', () => h.cryptoFactory());
vi.mock('../../instanceIdentity.js', () => h.instanceIdentityFactory());
vi.mock('../../instances.js', () => h.instancesFactory());
vi.mock('../../sharing/peerSync.js', () => h.peerSyncFactory());
vi.mock('../../cos/cosState.js', () => h.cosStateFactory());
vi.mock('../../domainUsage.js', () => h.domainUsageFactory());
vi.mock('../arcPlanner.js', (importOriginal) => h.arcPlannerFactory(importOriginal));
vi.mock('../volumeBeatsRunner.js', () => h.volumeBeatsSpies);
vi.mock('../autoRunner.js', () => h.autoRunnerSpies);
vi.mock('../manuscriptReview.js', () => h.manuscriptReviewFactory());
vi.mock('../editorial/checkRunner.js', () => h.checkRunnerSpies);
vi.mock('../reverseOutline.js', () => h.reverseOutlineFactory());
vi.mock('../../settings.js', (importOriginal) => h.settingsFactory(importOriginal));
vi.mock('../manuscriptFix.js', () => h.manuscriptFixFactory());
vi.mock('../visualStages.js', () => h.visualSpies);
vi.mock('../../cos/cosTaskStore.js', () => h.cosTaskStoreFactory());
vi.mock('../scriptVerify.js', () => h.scriptVerifyFactory());
vi.mock('../canonReadiness.js', () => h.canonReadinessFactory());
vi.mock('../../universeCanon.js', () => h.universeCanonFactory());
vi.mock('../foundationJudge.js', (importOriginal) => h.foundationJudgeFactory(importOriginal));
vi.mock('../seriesAutopilot/modelPerformance.js', () => h.modelPerformanceFactory());
vi.mock('../../notifications.js', () => h.notificationsFactory());

// Mocked bindings, so a test can drive the budget and persisted settings per call.
const { getDomainBudgetStatus } = await import('../../domainUsage.js');
const { getSettings } = await import('../../settings.js');

// Real services + the unit under test (imported AFTER the mocks above).
const seriesSvc = await import('../series.js');
const seasonsSvc = await import('../seasons.js');
const issuesSvc = await import('../issues.js');
const autopilot = await import('../seriesAutopilot.js');
const arcPlanner = await import('../arcPlanner.js');
const { stageContentOf } = await import('../textStages.js');

beforeEach(() => {
  h.resetFixtures({ autopilot, getDomainBudgetStatus, getSettings });
});

// ---------------------------------------------------------------------------
// Beat-continuity resolve internals (#1510) — pure shaper + the beat-rewrite
// apply pass (real issues service against the file store, like the conductor).
// ---------------------------------------------------------------------------
describe('beat-continuity resolve (#1510)', () => {
  const { shapeBeatResolutions, applyBeatResolutions, buildBeatContinuityContext } = arcPlanner.__testing;

  it('buildBeatContinuityContext renders beats into the tree and counts beat-bearing issues', async () => {
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

  it('shapeBeatResolutions keeps valid entries, drops malformed, caps the count', () => {
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

  it('rejects the whole candidate before clearing art when a pilot repair targets a later issue', async () => {
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

  it('writes the corrected beats to BOTH idea.input and idea.output so prose adapts from the fix', async () => {
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

  it('clears stale downstream prose/scripts AND comicPages art so they regenerate from the corrected beats', async () => {
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
    expect(autopilot.visualReady(await issuesSvc.getIssue(issueId))).toBe(true);

    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 1, beats: 'corrected beats' }]);
    expect(applied[0].clearedStages).toEqual(expect.arrayContaining(['prose', 'comicScript', 'comicPages']));
    const issue = await issuesSvc.getIssue(issueId);
    expect(issue.stages.idea.output).toBe('corrected beats');     // new beats applied
    expect(issuesSvc.isStageReady(issue.stages.prose)).toBe(false);       // stale text → cleared
    expect(issuesSvc.isStageReady(issue.stages.comicScript)).toBe(false); // stale script → cleared
    expect(autopilot.visualReady(issue)).toBe(false);                     // stale art → re-draw forced
  });

  it('does NOT clear a locked downstream stage when rewriting beats', async () => {
    const { series, issueId } = await seedIssueWithBeats();
    await issuesSvc.updateStage(issueId, 'comicScript', { status: 'ready', output: 'frozen script', locked: true });
    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 1, beats: 'corrected beats' }]);
    expect(applied[0].clearedStages).not.toContain('comicScript');
    const issue = await issuesSvc.getIssue(issueId);
    expect(issue.stages.comicScript.output).toBe('frozen script');  // untouched
  });

  it('skips a locked idea stage', async () => {
    const { series, issueId } = await seedIssueWithBeats({ locked: true });
    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 1, beats: 'corrected' }]);
    expect(applied[0]).toMatchObject({ skipped: 'locked' });
    const issue = await issuesSvc.getIssue(issueId);
    expect(issue.stages.idea.output).toBe('old beats');  // untouched
  });

  it('skips an issue that has no beats yet (corpus is beat-level)', async () => {
    const { series } = await seedIssueWithBeats({ status: 'empty', output: '' });
    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 1, beats: 'corrected' }]);
    expect(applied[0]).toMatchObject({ skipped: 'no-beats' });
  });

  it('drops an unmatched correction rather than rewriting the wrong issue', async () => {
    const { series, issueId } = await seedIssueWithBeats();
    // Only episode 1 exists; a correction for episode 99 matches nothing.
    const applied = await applyBeatResolutions(series.id, series, [{ seasonNumber: 1, episodeNumber: 99, beats: 'corrected' }]);
    expect(applied[0]).toMatchObject({ skipped: 'no-match' });
    const issue = await issuesSvc.getIssue(issueId);
    expect(issue.stages.idea.output).toBe('old beats');  // untouched
  });
});
