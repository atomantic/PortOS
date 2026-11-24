/**
 * orchestrator.run.test.js
 *
 * orchestrator run lifecycle, child runs, editorial and visual steps. Split from seriesAutopilot.test.js (#16214); shared mocks and
 * fixtures live in seriesAutopilot.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./seriesAutopilot.testFixtures.js'));
const { state, recordDomainUsage, arcSpies, volumeBeatsSpies, autoRunnerSpies, checkRunnerSpies, generateReverseOutline, visualSpies, addTask, verifyComicScript, checkSeriesCanonReadiness, describeCanonFromProse, applyFoundationFix, VALID_SCRIPT, ready, waitFor, seedComplete } = h;

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
vi.mock('./modelPerformance.js', () => h.modelPerformanceFactory());
vi.mock('../../notifications.js', () => h.notificationsFactory());

// Mocked bindings, so a test can drive the budget and persisted settings per call.
const { getDomainBudgetStatus } = await import('../../domainUsage.js');
const { getSettings } = await import('../../settings.js');
const { loadState } = await import('../../cos/cosState.js');

// Real services + the unit under test (imported AFTER the mocks above).
const seriesSvc = await import('../series.js');
const seasonsSvc = await import('../seasons.js');
const issuesSvc = await import('../issues.js');
const autopilot = await import('../seriesAutopilot.js');
const { commitSeasonsWithRemap: realCommitSeasonsWithRemap } = await import('../arcPlanner/arcCore.js');

const runFinished = (sId) => () => autopilot.__testing.runs.get(sId)?.finished === true;

beforeEach(() => {
  h.resetFixtures({ autopilot, getDomainBudgetStatus, getSettings });
});

it('blocks expansion on an unresolved pilot and confines first-issue production after it passes', async () => {
  const { seriesId, seasonId, issueId } = await seedComplete();
  const later = await issuesSvc.createIssue({ seriesId, seasonId, title: 'Later', number: 2 });
  await issuesSvc.updateStage(later.id, 'idea', ready('later beats'));
  state.editorialFindings = [{ severity: 'high', problem: 'The opening has no personal choice or aftermath' }];
  await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false, maxEditorialRounds: 1 });
  await waitFor(runFinished(seriesId));
  expect(autopilot.__testing.runs.get(seriesId).lastPayload).toMatchObject({ type: 'paused', scope: 'pilotReview' });
  expect(autoRunnerSpies.startAutoRunTextStages).not.toHaveBeenCalled();
  expect((await issuesSvc.getIssue(later.id)).stages.comicScript.output).toBe('');

  state.editorialFindings = [];
  await autopilot.startSeriesAutopilot(seriesId, { productionScope: 'first-issue', includeVisual: false });
  await waitFor(runFinished(seriesId));
  expect(autopilot.__testing.runs.get(seriesId).lastPayload.type).toBe('complete');
  expect(autoRunnerSpies.startAutoRunTextStages).not.toHaveBeenCalled();
  expect(verifyComicScript.mock.calls.map(([id]) => id)).toEqual([issueId]);
  expect(autopilot.__testing.runs.get(seriesId).options.productionScope).toBe('first-issue');
  const plan = autopilot.__testing.buildDryRunPlan(await seriesSvc.getSeries(seriesId), await issuesSvc.listIssues(seriesId), { productionScope: 'first-issue' });
  expect(plan.some((step) => step.kind === 'textStages')).toBe(false);
  expect(plan.find((step) => step.kind === 'editorialChecks').estLlmCalls).toBe(1);
});

it('joins a second start while the first is still resolving', async () => {
  const { seriesId } = await seedComplete();
  loadState.mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { config: {} };
  });

  const [first, second] = await Promise.all([
    autopilot.startSeriesAutopilot(seriesId, { includeVisual: false }),
    autopilot.startSeriesAutopilot(seriesId, { includeVisual: false }),
  ]);

  expect(first.runId).toBeTruthy();
  expect(second.runId).toBe(first.runId);
  expect(second.alreadyRunning).toBe(false);
  await waitFor(runFinished(seriesId));
});

it('normalizes duplicate volume records before the conductor can seed their empty copies', async () => {
  const { seriesId, seasonId } = await seedComplete();
  const current = await seriesSvc.getSeries(seriesId);
  const canonical = current.seasons.find((season) => season.id === seasonId);
  await seriesSvc.updateSeries(seriesId, {
    seasons: [
      ...current.seasons,
      { ...canonical, id: 'duplicate-volume-a', locked: false },
      { ...canonical, id: 'duplicate-volume-b', locked: false },
    ],
  });
  // The suite normally stubs this persistence boundary so conductor tests can
  // isolate LLM behavior. Use the real deterministic commit once here: the
  // arcPlanner store tests cover the collapse itself, while this pins the new
  // resolver → dispatcher ordering around it.
  arcSpies.commitSeasonsWithRemap.mockImplementationOnce(realCommitSeasonsWithRemap);

  await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
  await waitFor(runFinished(seriesId));

  const repaired = await seriesSvc.getSeries(seriesId);
  expect(repaired.seasons).toHaveLength(1);
  expect(repaired.seasons[0].id).toBe(seasonId);
  expect(arcSpies.generateSeasonEpisodes).not.toHaveBeenCalled();
  expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
});

describe('autopilot conductor', () => {
  it('runs whole-manuscript beat continuity before text, then proceeds when clean (#1510)', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    expect(arcSpies.analyzeBeatContinuity).toHaveBeenCalled();
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('pauses for review when beat continuity never converges (#1510)', async () => {
    state.beatContinuityFindings = [{ severity: 'high', problem: 'dropped cliffhanger', location: 'issue:1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxBeatContinuityRounds: 2 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('beatContinuity');
    // bounded: analyze called maxRounds times, resolve called rounds-1.
    expect(arcSpies.analyzeBeatContinuity).toHaveBeenCalledTimes(2);
    expect(arcSpies.resolveBeatContinuity).toHaveBeenCalledTimes(1);
    expect(last?.residualFindings?.[0]?.problem).toBe('dropped cliffhanger');
    // never reached the text stage — the gate is upstream of it.
    expect(autoRunnerSpies.startAutoRunTextStages).not.toHaveBeenCalled();
  });

  it('maxBeatContinuityRounds:0 skips the beat-continuity gate (no LLM spend)', async () => {
    state.beatContinuityFindings = [{ severity: 'high', problem: 'dropped cliffhanger', location: 'issue:1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxBeatContinuityRounds: 0 });
    await waitFor(runFinished(seriesId));
    expect(arcSpies.analyzeBeatContinuity).not.toHaveBeenCalled();
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  // -------------------------------------------------------------------------
  // #1574 — delegated child runners (beats/text) retry on a failed run and
  // escalate to a pause instead of marking the work attempted and silently
  // skipping it. The runner spies are no-ops by default, so the target stage
  // never lands unless a test's mock writes it — exactly the "child LLM call
  // failed" shape the feature guards against.
  // -------------------------------------------------------------------------
  // idea ready but no comicScript → the resolver routes to textStages.
  async function seedNeedsText() {
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'A', summary: 'S' } });
    const season = await seasonsSvc.createSeason(series.id, { number: 1, title: 'V1' });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, seasonId: season.id, title: 'I1', number: 1 });
    await issuesSvc.updateStage(issue.id, 'idea', ready('beats'));
    return { seriesId: series.id, seasonId: season.id, issueId: issue.id };
  }
  // no idea stage → the resolver routes to beatSheet first.
  async function seedNeedsBeats() {
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'A', summary: 'S' } });
    const season = await seasonsSvc.createSeason(series.id, { number: 1, title: 'V1' });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, seasonId: season.id, title: 'I1', number: 1 });
    return { seriesId: series.id, seasonId: season.id, issueId: issue.id };
  }

  it('retries a failed text run once, then escalates with a pause + residual (#1574)', async () => {
    const { seriesId } = await seedNeedsText(); // default text spy never writes comicScript
    await autopilot.startSeriesAutopilot(seriesId, {}); // default MAX_CHILD_RETRIES = 1 → 2 attempts
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('pilotDraft');
    expect(last?.pauseKind).toBe('childFailed');
    expect(last?.reason).toMatch(/did not produce required stage/);
    // one initial attempt + one retry before the escalation pause.
    expect(autoRunnerSpies.startAutoRunTextStages).toHaveBeenCalledTimes(2);
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    // pauseKind survives sanitizeAutopilot so the resume banner can classify it.
    expect(series.autopilot?.pauseKind).toBe('childFailed');
    expect(series.autopilot?.residualFindings?.length).toBeGreaterThan(0);
  });

  it('a text run that succeeds on the retry proceeds without pausing (#1574)', async () => {
    const { seriesId } = await seedNeedsText();
    autoRunnerSpies.startAutoRunTextStages
      .mockImplementationOnce(async () => ({ runId: 'ar', alreadyRunning: false })) // attempt 1: fails
      .mockImplementationOnce(async (id) => { // attempt 2: the stage lands
        await issuesSvc.updateStage(id, 'comicScript', ready(VALID_SCRIPT));
        return { runId: 'ar2', alreadyRunning: false };
      });
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    expect(autoRunnerSpies.startAutoRunTextStages).toHaveBeenCalledTimes(2);
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('maxChildRetries:0 makes a single attempt then pauses (legacy no-retry behavior)', async () => {
    const { seriesId } = await seedNeedsText();
    await autopilot.startSeriesAutopilot(seriesId, { maxChildRetries: 0 });
    await waitFor(runFinished(seriesId));
    expect(autoRunnerSpies.startAutoRunTextStages).toHaveBeenCalledTimes(1);
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('paused');
  });

  it('a per-run maxChildRetries override widens the budget (2 retries → 3 attempts)', async () => {
    const { seriesId } = await seedNeedsText();
    await autopilot.startSeriesAutopilot(seriesId, { maxChildRetries: 2 });
    await waitFor(runFinished(seriesId));
    expect(autoRunnerSpies.startAutoRunTextStages).toHaveBeenCalledTimes(3);
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('paused');
  });

  it('retries a failed beats run once, then escalates with a pause (#1574)', async () => {
    const { seriesId } = await seedNeedsBeats(); // default beats spy never writes idea
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('beatSheet');
    expect(last?.reason).toMatch(/did not produce beats/);
    expect(volumeBeatsSpies.startVolumeBeatsRun).toHaveBeenCalledTimes(2);
  });

  it('pauses (no infinite loop) when episode generation produces no issues', async () => {
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'A', summary: 'S' } });
    await seasonsSvc.createSeason(series.id, { number: 1, title: 'V1' }); // volume with no issues
    // commitEpisodesToIssues mock returns [] → no issues created.
    await autopilot.startSeriesAutopilot(series.id, { includeVisual: false });
    await waitFor(runFinished(series.id));
    const last = autopilot.__testing.runs.get(series.id)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('generateEpisodes');
    expect(arcSpies.generateSeasonEpisodes).toHaveBeenCalledTimes(1); // not looping
  });

  it('pauses without duplicating work when issue placeholders cannot be safely reused', async () => {
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'A', summary: 'S' } });
    await seasonsSvc.createSeason(series.id, { number: 1, title: 'V1' });
    arcSpies.generateSeasonEpisodes.mockResolvedValueOnce({ episodes: [{ number: 1, title: 'I1' }] });
    const error = Object.assign(new Error('Reconcile the existing issue placeholder set before resuming.'), {
      code: 'PIPELINE_ARC_VALIDATION',
    });
    arcSpies.commitEpisodesToIssues.mockRejectedValueOnce(error);

    await autopilot.startSeriesAutopilot(series.id, { includeVisual: false });
    await waitFor(runFinished(series.id));

    const last = autopilot.__testing.runs.get(series.id)?.lastPayload;
    expect(last).toMatchObject({
      type: 'paused',
      scope: 'generateEpisodes',
      pauseKind: 'inapplicable',
      reason: 'Reconcile the existing issue placeholder set before resuming.',
    });
    expect(arcSpies.commitEpisodesToIssues).toHaveBeenCalledTimes(1);
  });

  it('pauses (no infinite loop) when arc generation yields no volumes', async () => {
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'A', summary: 'S' } }); // arc but no seasons
    // generateArcOverview mock returns seasons:[] → commit yields no volumes.
    await autopilot.startSeriesAutopilot(series.id, { includeVisual: false });
    await waitFor(runFinished(series.id));
    const last = autopilot.__testing.runs.get(series.id)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('generateArc');
    expect(last?.reason).toMatch(/no volumes/);
    expect(arcSpies.generateArcOverview).toHaveBeenCalledTimes(1); // not looping
  });

  it('rechecks budget mid arc-verify loop and pauses before resolveVerifyIssues', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'x' }];
    // Budget is fine until verifyArc has run once, then exhausted — so the
    // pre-resolve recheck must pause instead of billing resolveVerifyIssues.
    getDomainBudgetStatus.mockImplementation(async () => (
      arcSpies.verifyArc.mock.calls.length >= 1
        ? { withinBudget: false, exceeded: 'actions' }
        : { withinBudget: true, exceeded: null }
    ));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 3 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.reason).toMatch(/budget/);
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(1);
    expect(arcSpies.resolveVerifyIssues).not.toHaveBeenCalled();
  });

  it('pauses when the cos daily budget is exhausted', async () => {
    state.budgetStatus = { withinBudget: false, exceeded: 'actions' };
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.reason).toMatch(/budget/);
    expect(arcSpies.verifyArc).not.toHaveBeenCalled();
  });

  it('a zero-round gate skips even when the budget is exhausted (no budget pause at that gate)', async () => {
    state.budgetStatus = { withinBudget: false, exceeded: 'actions' };
    const { seriesId } = await seedComplete();
    // maxArcVerifyRounds:0 + maxBeatContinuityRounds:0 + maxFoundationRounds:0 ⇒
    // all three gates short-circuit with no spend, so the budget gate must NOT
    // pause at any — the run advances to the next non-exempt step (scriptVerify)
    // and pauses there.
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 0, maxBeatContinuityRounds: 0, maxFoundationRounds: 0 });
    await waitFor(runFinished(seriesId));
    expect(arcSpies.verifyArc).not.toHaveBeenCalled();
    expect(arcSpies.analyzeBeatContinuity).not.toHaveBeenCalled();
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    expect(series.autopilot?.currentStep).toBe('pilotReview'); // not 'verifyArc'/'beatContinuity'
    expect(series.autopilot?.lastError).toMatch(/budget/);
  });

  it('maxEditorialRounds:0 skips the editorial-checks step too (no budget spend)', async () => {
    checkRunnerSpies.runEditorialChecks.mockClear();
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxEditorialRounds: 0 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    // Skipping the editorial gate must also skip the registry checks pass.
    expect(checkRunnerSpies.runEditorialChecks).not.toHaveBeenCalled();
  });

  it('refreshes the reverse outline before the checks when stale and a check consumes it (#1349)', async () => {
    state.reverseOutlineConsumed = true;
    state.reverseOutlineState = { status: 'complete', stale: true };
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(generateReverseOutline).toHaveBeenCalledTimes(1);
    // force:false lets the call no-op if the outline went fresh in the meantime.
    expect(generateReverseOutline.mock.calls[0][1]).toMatchObject({ force: false });
  });

  it('skips the reverse-outline refresh when no enabled check consumes it (#1349)', async () => {
    state.reverseOutlineConsumed = false; // gate 1: nothing reads the outline
    state.reverseOutlineState = { status: 'complete', stale: true }; // stale, but unused
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(generateReverseOutline).not.toHaveBeenCalled();
  });

  it('skips the refresh when the only consumer is gated out for this series (#1614)', async () => {
    // A check DECLARES the outline as a source (gate 1 passes) but its runtime
    // gate declines for this series — so refreshing the (stale) outline would
    // spend an LLM call no runnable check consumes.
    state.reverseOutlineConsumed = true; // gate 1: a consumer declares the source
    state.reverseOutlineConsumedGated = false; // gate 3: but every consumer is gated out
    // A complete-but-stale outline WITH scenes — gate 3 only evaluates when
    // there's scene content to gate against (a scene-less outline bootstraps).
    state.reverseOutlineState = { status: 'complete', stale: true, scenes: [{ id: 'sc1' }] };
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(checkRunnerSpies.buildReverseOutlineGateContext).toHaveBeenCalled();
    expect(generateReverseOutline).not.toHaveBeenCalled();
  });

  it('bootstraps a never-generated outline without the gate-aware skip (#1614)', async () => {
    // `status:'none'` has no scenes to gate against — the outline-content gates
    // would all falsely decline, so the first generation must NOT be gate-skipped.
    state.reverseOutlineConsumed = true;
    state.reverseOutlineConsumedGated = false; // would skip a complete outline, but...
    state.reverseOutlineState = { status: 'none', stale: false }; // ...never generated yet
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(checkRunnerSpies.buildReverseOutlineGateContext).not.toHaveBeenCalled();
    expect(generateReverseOutline).toHaveBeenCalledTimes(1);
  });

  it('forces a regen when a cached refresh is still stale against the live manuscript (#1614)', async () => {
    state.reverseOutlineConsumed = true;
    state.reverseOutlineState = { status: 'complete', stale: true, scenes: [{ id: 'sc1' }] };
    // First generate() no-ops as cached (hash matched at generate time), but the
    // live manuscript is still stale → the run forces one more regen.
    generateReverseOutline
      .mockImplementationOnce(async () => ({ status: 'complete', cached: true, stale: false }))
      .mockImplementationOnce(async () => ({ status: 'complete', stale: false, scenes: [{ id: 'sc1' }] }));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(generateReverseOutline).toHaveBeenCalledTimes(2);
    expect(generateReverseOutline.mock.calls[0][1]).toMatchObject({ force: false });
    expect(generateReverseOutline.mock.calls[1][1]).toMatchObject({ force: true });
  });

  it('a budget-exhausted run does not pause at the no-op reverse-outline refresh (#1575 self-gating exemption)', async () => {
    // A subset run whose checks don't consume the outline makes the refresh a
    // guaranteed no-op. Budget goes exhausted right after the editorial-review
    // pass spends its last action, so the NEXT step (reverseOutline) sees no
    // budget. The pre-dispatch gate must NOT pause there — the refresh self-gates
    // and would bill nothing — so the run reaches completion (editorialChecks +
    // healthGate are exempt too) instead of a spurious budget pause.
    state.reverseOutlineConsumed = false; // subset skips every outline-consuming check
    state.reverseOutlineState = { status: 'complete', stale: true }; // stale, but unused
    getDomainBudgetStatus.mockImplementation(async () => (
      arcSpies.analyzeManuscriptCompleteness.mock.calls.length >= 1 && verifyComicScript.mock.calls.length >= 1
        ? { withinBudget: false, exceeded: 'actions' }
        : { withinBudget: true, exceeded: null }
    ));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { editorialCheckIds: ['naming'], includeVisual: false });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('complete');
    expect(generateReverseOutline).not.toHaveBeenCalled();
  });

  it('skips the reverse-outline refresh when nothing is drafted yet (#1349)', async () => {
    state.reverseOutlineConsumed = true;
    state.reverseOutlineState = { status: 'no-content' }; // gate 2: no manuscript to segment
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(generateReverseOutline).not.toHaveBeenCalled();
  });

  it('bills a cos action only when the reverse outline actually regenerates (#1349)', async () => {
    state.reverseOutlineConsumed = true;
    // Fresh outline — the refresh step is a no-op and charges nothing.
    state.reverseOutlineState = { status: 'complete', stale: false };
    const a = await seedComplete();
    await autopilot.startSeriesAutopilot(a.seriesId, { includeVisual: false });
    await waitFor(runFinished(a.seriesId));
    const freshCharges = recordDomainUsage.mock.calls.length;
    expect(generateReverseOutline).not.toHaveBeenCalled();

    recordDomainUsage.mockClear();
    generateReverseOutline.mockClear();
    // Same path, but a stale outline — exactly ONE extra cos action vs the fresh run.
    state.reverseOutlineState = { status: 'complete', stale: true };
    const b = await seedComplete();
    await autopilot.startSeriesAutopilot(b.seriesId, { includeVisual: false });
    await waitFor(runFinished(b.seriesId));
    expect(generateReverseOutline).toHaveBeenCalledTimes(1);
    expect(recordDomainUsage.mock.calls.length).toBe(freshCharges + 1);
  });

  it('pauses at the editorial health gate when a blocking finding remains open (#1316)', async () => {
    const manuscriptReview = await import('../manuscriptReview.js');
    // Completeness + checks converge clean, but the post-pass review still holds
    // an open high finding (e.g. surfaced by the registry checks) — the health
    // gate must catch it and pause before visuals.
    manuscriptReview.getReview.mockResolvedValue({
      comments: [{ id: 'c1', status: 'open', severity: 'high', category: 'continuity', issueNumber: 1, problem: 'timeline contradiction' }],
    });
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('editorialHealthGate');
    expect(last?.residualFindings?.[0]?.problem).toBe('timeline contradiction');
    manuscriptReview.getReview.mockResolvedValue({ comments: [] }); // restore
  });

  it('a second start while active resolves to alreadyRunning', async () => {
    // Hold the run open by making the verify loop wait on a never-converging
    // finding plus a slow child so the first run is still active.
    state.verifyFindings = [{ severity: 'high', problem: 'x' }];
    arcSpies.resolveVerifyIssues.mockImplementationOnce(() => new Promise(() => {})); // never resolves
    const { seriesId } = await seedComplete();
    const first = await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 5 });
    expect(first.alreadyRunning).toBe(false);
    const second = await autopilot.startSeriesAutopilot(seriesId, {});
    expect(second.alreadyRunning).toBe(true);
    expect(second.runId).toBe(first.runId);
    autopilot.cancelSeriesAutopilot(seriesId);
  });

  it('emits an immediate cancel:acknowledged frame on cancel (#1617)', async () => {
    // Hold the run open at the arc verify step so cancel lands mid-run and the
    // terminal `canceled` frame can't have fired yet.
    state.verifyFindings = [{ severity: 'high', problem: 'x' }];
    arcSpies.resolveVerifyIssues.mockImplementationOnce(() => new Promise(() => {})); // never resolves
    const { seriesId } = await seedComplete();
    const { runId } = await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 5 });
    // Wait until the run is actually running (first frame emitted).
    await waitFor(() => autopilot.__testing.runs.get(seriesId)?.lastPayload != null);

    // Attach a fake SSE client so we can assert the ack reaches subscribers,
    // not just the cached lastPayload.
    const writes = [];
    autopilot.attachClient(seriesId, {
      writeHead: () => {},
      write: (chunk) => writes.push(chunk),
      end: () => {},
      req: { on: () => {} },
    });

    const canceled = autopilot.cancelSeriesAutopilot(seriesId);
    expect(canceled).toBe(true);
    // Synchronous: broadcastSse sets lastPayload last, before the loop can run.
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('cancel:acknowledged');
    expect(last?.runId).toBe(runId);
    expect(writes.some((w) => w.includes('"type":"cancel:acknowledged"'))).toBe(true);
  });

  it('gracefully pauses without stopping the active provider run', async () => {
    const { seriesId } = await seedComplete();
    const { runId } = await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    const requested = autopilot.pauseSeriesAutopilot(seriesId);
    expect(requested).toBe(true);
    expect(autopilot.isAutopilotPauseRequested(seriesId)).toBe(true);
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload).toMatchObject({
      type: 'pause:acknowledged',
      runId,
    });
    await waitFor(runFinished(seriesId));
    expect(autopilot.isAutopilotPauseRequested(seriesId)).toBe(false);
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last).toMatchObject({ type: 'paused', pauseKind: 'manual' });
    expect(last?.reason).toMatch(/paused by user after the active step completed/i);
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot).toMatchObject({ status: 'paused', pauseKind: 'manual' });
  });

  it('gracefully pauses an arc convergence loop after its active judge without dispatching a repair', async () => {
    let finishJudge;
    const judge = new Promise((resolve) => { finishJudge = resolve; });
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc.mockImplementationOnce(async () => judge);
    const blocker = { severity: 'medium', problem: 'A causal handoff is missing.', location: 'volume:1' };
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 5 });
    await waitFor(() => arcSpies.verifyArc.mock.calls.length === 1);

    expect(autopilot.pauseSeriesAutopilot(seriesId)).toBe(true);
    finishJudge({ issues: [blocker] });
    await waitFor(runFinished(seriesId));

    expect(arcSpies.resolveVerifyIssues).not.toHaveBeenCalled();
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(1);
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last).toMatchObject({
      type: 'paused',
      pauseKind: 'manual',
      residualFindings: [blocker],
    });
    expect(last?.reason).toMatch(/active arc judgment completed/i);
  });

  it('drafts cover + interior pages when includeVisual is set', async () => {
    const { seriesId, issueId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(visualSpies.enqueueComicCover).toHaveBeenCalledTimes(1);
    expect(visualSpies.enqueueVisualComicPage).toHaveBeenCalled();
    // The returned jobIds were persisted onto the comicPages slots.
    const issue = await issuesSvc.getIssue(issueId);
    expect(issue.stages.comicPages.cover.proofImage.jobId).toBe('job-cover');
    expect(issue.stages.comicPages.pages[0].proofImage.jobId).toBe('job-page-0');
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('done');
  });

  it('pauses before visuals when a drawn canon noun is undescribed', async () => {
    state.canonReady = false;
    state.canonUndescribed = [{ id: 'c1', name: 'Kai', kind: 'character' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('canonVerify');
    expect(last?.residualFindings?.[0]?.location).toMatch(/Kai/);
    // gate is BEFORE visual production — no renders kicked off
    expect(visualSpies.enqueueComicCover).not.toHaveBeenCalled();
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
  });

  it('backfills drawn canon from prose before pausing visual production', async () => {
    const { seriesId, issueId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { universeId: 'uni-1' });
    await issuesSvc.updateStage(issueId, 'prose', ready('Kai wears a patched saffron pressure coat with a cracked brass respirator.'));
    const noun = { id: 'c1', name: 'Kai', kind: 'character', locked: false };
    state.canonReady = false;
    state.canonUndescribed = [noun];
    state.canonBlockingIssues = [{ issueId, number: 1, title: 'I1', none: [noun] }];

    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true });
    await waitFor(runFinished(seriesId));

    expect(describeCanonFromProse).toHaveBeenCalledWith('uni-1', expect.objectContaining({
      corpus: expect.stringContaining('saffron pressure coat'),
      targets: [{ id: 'c1', kind: 'character' }],
    }));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(visualSpies.enqueueComicCover).toHaveBeenCalled();
  });

  it('files only the specific gap (not also the generic stalled) when canon pauses', async () => {
    state.canonReady = false;
    state.canonUndescribed = [{ id: 'c1', name: 'Kai', kind: 'character' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true, fileGaps: true });
    await waitFor(runFinished(seriesId));
    const descs = addTask.mock.calls.map((c) => c[0].description);
    expect(descs.some((d) => /canon-undescribed/.test(d))).toBe(true);
    expect(descs.some((d) => /canonVerify-stalled/.test(d))).toBe(false);
  });

  it('proceeds to visuals once canon is ready', async () => {
    state.canonReady = true;
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true });
    await waitFor(runFinished(seriesId));
    expect(checkSeriesCanonReadiness).toHaveBeenCalledWith(seriesId, { sourceStages: ['comicScript'] });
    expect(visualSpies.enqueueComicCover).toHaveBeenCalled();
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('blocks before visuals when the comic script does not parse (structural gate)', async () => {
    // scriptVerify runs before canon/visual, so an unparseable script pauses
    // there and no art is queued.
    const { seriesId } = await seedComplete({ script: 'just prose, no comic pages here' });
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('scriptVerify');
    expect(visualSpies.enqueueComicCover).not.toHaveBeenCalled();
  });

  it('skips visual draft for a locked comicPages stage (does not mutate it)', async () => {
    const { seriesId, issueId } = await seedComplete();
    await issuesSvc.updateStage(issueId, 'comicPages', { locked: true });
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(visualSpies.enqueueComicCover).not.toHaveBeenCalled();
  });

  it('does not render visuals when includeVisual is false', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(visualSpies.enqueueComicCover).not.toHaveBeenCalled();
    expect(visualSpies.enqueueVisualComicPage).not.toHaveBeenCalled();
  });

  it('pauses on an unparseable comic script and files a gap (fileGaps)', async () => {
    const { seriesId } = await seedComplete({ script: 'just prose, no comic pages here' });
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true, includeVisual: false });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused'); // structural gate blocks completion
    expect(last?.scope).toBe('scriptVerify');
    const descs = addTask.mock.calls.map((c) => c[0].description);
    expect(descs.some((d) => /script-unparseable/.test(d))).toBe(true);
    expect(descs.some((d) => /scriptVerify-stalled/.test(d))).toBe(false); // gapFiled → no dup
  });

  it('pauses when a delegated text run leaves required stages empty', async () => {
    // idea ready but comicScript missing → resolver routes textStages; the
    // autoRunner mock is a no-op so comicScript stays empty after the run.
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'A', summary: 'S' } });
    const season = await seasonsSvc.createSeason(series.id, { number: 1, title: 'V1' });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, seasonId: season.id, title: 'I1', number: 1 });
    await issuesSvc.updateStage(issue.id, 'idea', ready('beats'));
    await autopilot.startSeriesAutopilot(series.id, { includeVisual: false });
    await waitFor(runFinished(series.id));
    const last = autopilot.__testing.runs.get(series.id)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('pilotDraft');
    expect(last?.reason).toMatch(/comicScript/);
  });

  it('tags a filed gap task with the series so a later run can find it', async () => {
    const { seriesId } = await seedComplete({ script: 'just prose, no comic pages here' });
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true, includeVisual: false });
    await waitFor(runFinished(seriesId));
    const tagged = addTask.mock.calls.map((c) => c[0]).find((t) => /script-unparseable/.test(t.description));
    expect(tagged.autopilotGapSeriesId).toBe(seriesId);
    expect(tagged.autopilotGapKind).toBe('script-unparseable');
  });

  it('retires a PENDING gap task for this series when a new run starts', async () => {
    const { seriesId } = await seedComplete();
    state.userTasks = [{
      id: 'task-stale', status: 'pending',
      description: `Autopilot foundationGate-stalled gap — series ${seriesId}\n\npaused`,
      metadata: { autopilotGapSeriesId: seriesId },
    }];
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(state.userTasks[0].status).toBe('completed');
    expect(state.userTasks[0].metadata.resolution).toBe('auto-expired');
    expect(state.userTasks[0].metadata.autoExpiredReason).toBe('autopilot-resumed');
  });

  it('retires a legacy gap task that predates the autopilotGapSeriesId tag', async () => {
    const { seriesId } = await seedComplete();
    state.userTasks = [{
      id: 'task-legacy', status: 'pending',
      description: `Autopilot foundationGate-stalled gap — series ${seriesId}\n\npaused`,
      metadata: {},
    }];
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(state.userTasks[0].status).toBe('completed');
  });

  it('leaves in-progress gap tasks and other series alone', async () => {
    const { seriesId } = await seedComplete();
    state.userTasks = [
      {
        id: 'task-running', status: 'in_progress',
        description: `Autopilot foundationGate-stalled gap — series ${seriesId}\n\npaused`,
        metadata: { autopilotGapSeriesId: seriesId },
      },
      {
        id: 'task-other', status: 'pending',
        description: 'Autopilot foundationGate-stalled gap — series ser-somebody-else\n\npaused',
        metadata: { autopilotGapSeriesId: 'ser-somebody-else' },
      },
      { id: 'task-unrelated', status: 'pending', description: 'Fix the login page', metadata: {} },
    ];
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(state.userTasks.map((t) => t.status)).toEqual(['in_progress', 'pending', 'pending']);
  });

  it('does not file gap tasks when fileGaps is off', async () => {
    const { seriesId } = await seedComplete({ script: 'just prose, no comic pages here' });
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(addTask).not.toHaveBeenCalled();
  });

  it('runs the LLM craft script verify and continues (advisory) when it is clean', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(verifyComicScript).toHaveBeenCalledTimes(1);
    const done = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(done?.type).toBe('complete');
    // #1572 — a genuinely clean run reports no filed craft gaps.
    expect(done?.craftGapIssues).toBe(0);
    expect(done?.craftGapFindings).toBe(0);
  });

  it('files a gap for blocking script-craft findings but does not block the run', async () => {
    state.scriptVerifyFindings = [{ severity: 'high', problem: 'page 2 panel 1 has no description' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true, includeVisual: false });
    await waitFor(runFinished(seriesId));
    // advisory: run still completes
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    const gapKinds = addTask.mock.calls.map((c) => c[0].description);
    expect(gapKinds.some((d) => /script-craft/.test(d))).toBe(true);
  });

  it('qualifies the terminal complete frame + marker with filed script-craft gap counts (#1572)', async () => {
    state.scriptVerifyFindings = [
      { severity: 'high', problem: 'page 2 panel 1 has no description' },
      { severity: 'high', problem: 'page 3 panel 2 dialogue is empty' },
    ];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true, includeVisual: false });
    await waitFor(runFinished(seriesId));
    const done = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(done?.type).toBe('complete');
    // One issue verified, two blocking findings on it → 1 gap-issue / 2 findings.
    expect(done?.craftGapIssues).toBe(1);
    expect(done?.craftGapFindings).toBe(2);
    const marker = (await seriesSvc.getSeries(seriesId)).autopilot;
    expect(marker.status).toBe('done');
    expect(marker.craftGapIssues).toBe(1);
    expect(marker.craftGapFindings).toBe(2);
  });

  it('does not tally craft gaps into the complete frame when fileGaps is off (#1572)', async () => {
    state.scriptVerifyFindings = [{ severity: 'high', problem: 'page 2 panel 1 has no description' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    const done = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(done?.type).toBe('complete');
    // Nothing was filed (fileGaps off), so the run stays a clean complete.
    expect(done?.craftGapIssues).toBe(0);
    expect(done?.craftGapFindings).toBe(0);
  });

  it('flags errored editorial checks on the terminal complete frame + marker (#1573)', async () => {
    state.editorialChecksPerCheck = [
      { checkId: 'pacing', count: 0, error: 'provider timeout' },
      { checkId: 'continuity', count: 2 },
    ];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    const done = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(done?.type).toBe('complete');
    expect(done?.editorialCheckErrors).toBe(1);
    expect(done?.editorialCheckErroredIds).toEqual(['pacing']);
    const marker = (await seriesSvc.getSeries(seriesId)).autopilot;
    expect(marker.status).toBe('done');
    expect(marker.editorialCheckErrors).toBe(1);
  });

  it('reports a clean complete (no errored checks) when every editorial check ran (#1573)', async () => {
    state.editorialChecksPerCheck = [{ checkId: 'pacing', count: 0 }, { checkId: 'continuity', count: 1 }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    const done = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(done?.type).toBe('complete');
    expect(done?.editorialCheckErrors).toBe(0);
    expect(done?.editorialCheckErroredIds).toEqual([]);
  });

  it('pauses at editorialChecks when high findings ≥ the armed threshold (#1613)', async () => {
    state.editorialChecksFindings = [
      { severity: 'high', checkId: 'pacing', location: 'ch 1', problem: 'pacing stalls' },
      { severity: 'high', checkId: 'continuity', location: 'ch 2', problem: 'timeline contradiction' },
      { severity: 'medium', checkId: 'pacing', location: 'ch 3', problem: 'minor lull' },
    ];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false, checkFindingsPauseThreshold: 2 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.pauseKind).toBe('checkFindings');
    expect(last?.scope).toBe('editorialChecks');
    // Only the two HIGH findings are carried as residual (the medium is excluded).
    expect(last?.residualFindings).toHaveLength(2);
    expect(last.residualFindings.every((f) => f.severity === 'high')).toBe(true);
    const marker = (await seriesSvc.getSeries(seriesId)).autopilot;
    expect(marker.status).toBe('paused');
    expect(marker.pauseKind).toBe('checkFindings');
  });

  it('does NOT pause on high findings when the threshold is off by default (#1613)', async () => {
    state.editorialChecksFindings = [
      { severity: 'high', checkId: 'pacing', location: 'ch 1', problem: 'a' },
      { severity: 'high', checkId: 'pacing', location: 'ch 2', problem: 'b' },
      { severity: 'high', checkId: 'pacing', location: 'ch 3', problem: 'c' },
    ];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    // No threshold → the checks pass stays advisory and the run completes.
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('does NOT pause when high findings fall below the armed threshold (#1613)', async () => {
    state.editorialChecksFindings = [{ severity: 'high', checkId: 'pacing', location: 'ch 1', problem: 'a' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false, checkFindingsPauseThreshold: 3 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('forwards a per-run editorialCheckIds subset to the checks pass + budget gate (#1575)', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { editorialCheckIds: ['pacing'], includeVisual: false });
    await waitFor(runFinished(seriesId));
    // Both the budget gate (buildEditorialCheckPlan) and the run (runEditorialChecks)
    // must see the same subset so billing and execution agree on the set.
    expect(checkRunnerSpies.runEditorialChecks).toHaveBeenCalledWith(
      seriesId,
      expect.objectContaining({ checkIds: ['pacing'] }),
    );
    expect(checkRunnerSpies.buildEditorialCheckPlan).toHaveBeenCalledWith(
      seriesId,
      expect.objectContaining({ checkIds: ['pacing'] }),
    );
    // The preceding reverse-outline refresh must gate on the SAME subset, so a
    // subset that skips outline-consuming checks doesn't trigger/bill a refresh.
    expect(checkRunnerSpies.enabledChecksConsumeReverseOutline).toHaveBeenCalledWith(
      expect.anything(),
      ['pacing'],
    );
  });

  it('passes checkIds:null (run all enabled) when no subset is given (#1575)', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(checkRunnerSpies.runEditorialChecks).toHaveBeenCalledWith(
      seriesId,
      expect.objectContaining({ checkIds: null }),
    );
    expect(checkRunnerSpies.enabledChecksConsumeReverseOutline).toHaveBeenCalledWith(
      expect.anything(),
      null,
    );
  });

  // #1578 — the checks pass forwards the runner's per-check progress frames up
  // the autopilot SSE stream, so it must hand runEditorialChecks an onProgress
  // callback (without it the only signal during a long pass is the terminal total).
  it('passes an onProgress forwarder to the editorial checks runner (#1578)', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(checkRunnerSpies.runEditorialChecks).toHaveBeenCalledWith(
      seriesId,
      expect.objectContaining({ onProgress: expect.any(Function) }),
    );
  });

  it('files a CoS gap task when a verify gate stalls (fileGaps)', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'unresolved plot hole' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true, maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(addTask).toHaveBeenCalled();
    expect(addTask.mock.calls[0][0].description).toMatch(/verifyArcSpine-stalled/);
  });

  // `metadata.app` is workspace routing, not a feature tag: it must name a
  // record in data/apps.json. Filing these at 'pipeline' made every gap task
  // unspawnable once prepareAgentWorkspace started refusing an app that
  // resolves to no repo path (#3180) — the task was filed, then blocked.
  it('files gap tasks with no app so they run in the PortOS workspace', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'unresolved plot hole' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true, maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(addTask).toHaveBeenCalled();
    for (const [taskData] of addTask.mock.calls) {
      expect(taskData.app).toBeUndefined();
    }
  });

  // fileGap emits its own `gap:filed` frame and SSE replay keeps only the last
  // payload — so a gap filed after the terminal frame leaves a client that
  // attaches post-run replaying `gap:filed` and never learning the run ended.
  it('keeps the terminal frame last when a pause also files a gap task', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'unresolved plot hole' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true, maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(addTask).toHaveBeenCalled();
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('paused');
  });

  // An intentional stop reaches the conductor as a rejection, not as a step
  // result it can inspect: this run's Cancel calls stopRun on the active LLM
  // run, /runs Stop kills the same pty, and a restart tree-kills it — all three
  // surface as RUN_CANCELED out of the prompt runner. Landing that in the error
  // terminal marked the series `error`, spent a post-mortem diagnosing the
  // operator, and filed a `run-error` CoS task for a human pressing Stop.
  const canceledRejection = () => Object.assign(new Error('TUI canceled (signal 15)'), {
    code: 'RUN_CANCELED',
    canceled: true,
  });
  const filedGapKinds = () => addTask.mock.calls.map(([task]) => task.description);

  it('ends as canceled — not error — when a step\'s LLM call is stopped mid-flight', async () => {
    arcSpies.verifyArc.mockRejectedValueOnce(canceledRejection());
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('canceled');
    const series = await seriesSvc.getSeries(seriesId);
    // `paused`, so Resume picks the run back up from the next missing step.
    expect(series.autopilot?.status).toBe('paused');
    expect(series.autopilot?.lastError).toMatch(/canceled/i);
    expect(filedGapKinds().some((d) => /run-error/.test(d))).toBe(false);
  });

  it('still reports a genuine step failure as error and files the run-error gap', async () => {
    arcSpies.verifyArc.mockRejectedValueOnce(new Error('provider returned nothing'));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('error');
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('error');
    expect(filedGapKinds().some((d) => /run-error/.test(d))).toBe(true);
  });

  // The foundation gate catches its own repair failures and pauses on
  // `providerFailed` ("switch the repair provider/model first") — advice that
  // makes no sense for a repair the user themselves stopped.
  it('treats a stopped foundation repair as canceled, not a provider failure', async () => {
    state.foundationScore = 5;
    applyFoundationFix.mockRejectedValueOnce(canceledRejection());
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('canceled');
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    expect(series.autopilot?.pauseKind).toBeNull();
    expect(filedGapKinds().some((d) => /stalled|run-error/.test(d))).toBe(false);
  });

  it('recoverStuckAutopilots demotes a running marker to paused', async () => {
    const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P' });
    await seriesSvc.updateSeries(series.id, { autopilot: { status: 'running', runId: 'dead' } });
    const n = await autopilot.recoverStuckAutopilots();
    expect(n).toBe(1);
    const fresh = await seriesSvc.getSeries(series.id);
    expect(fresh.autopilot?.status).toBe('paused');
  });
});
