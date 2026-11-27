/**
 * orchestrator.foundationGate.test.js
 *
 * orchestrator foundation-quality gate. Split from seriesAutopilot.test.js (#16214); shared mocks and
 * fixtures live in seriesAutopilot.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./seriesAutopilot.testFixtures.js'));
const { state, patchRunMetadata, arcSpies, judgeFoundation, applyFoundationFix, snapshotFoundationState, restoreFoundationState, readFoundationCharacterProgress, recordModelOutcome, waitFor, seedComplete } = h;

vi.mock('../../runner.js', (importOriginal) => h.runnerFactory(importOriginal));
vi.mock('../../../lib/fileUtils.js', () => h.fileUtilsFactory());
vi.mock('crypto', () => h.cryptoFactory());
vi.mock('../../instanceIdentity.js', () => h.instanceIdentityFactory());
vi.mock('../../instances.js', () => h.instancesFactory());
vi.mock('../../sharing/peerSync.js', () => h.peerSyncFactory());
vi.mock('../../cos/cosState.js', () => h.cosStateFactory());
vi.mock('../../domainUsage.js', () => h.domainUsageFactory());
vi.mock('../arcPlanner.js', (importOriginal) => h.arcPlannerFactory(importOriginal));
vi.mock('../manuscriptReview.js', () => h.manuscriptReviewFactory());
vi.mock('../editorial/checkRunner.js', () => h.checkRunnerSpies);
vi.mock('../../settings.js', (importOriginal) => h.settingsFactory(importOriginal));
vi.mock('../visualStages.js', () => h.visualSpies);
vi.mock('../../cos/cosTaskStore.js', () => h.cosTaskStoreFactory());
vi.mock('../scriptVerify.js', () => h.scriptVerifyFactory());
vi.mock('../canonReadiness.js', () => h.canonReadinessFactory());
vi.mock('../foundationJudge.js', (importOriginal) => h.foundationJudgeFactory(importOriginal));
vi.mock('./modelPerformance.js', () => h.modelPerformanceFactory());
vi.mock('../../notifications.js', () => h.notificationsFactory());

// Mocked bindings, so a test can drive the budget and persisted settings per call.
const { getDomainBudgetStatus } = await import('../../domainUsage.js');
const { getSettings } = await import('../../settings.js');

// Real services + the unit under test (imported AFTER the mocks above).
const seriesSvc = await import('../series.js');
const autopilot = await import('../seriesAutopilot.js');
const { stagePinsIgnored } = await import('../../../lib/stagePinPolicy.js');

const runFinished = (sId) => () => autopilot.__testing.runs.get(sId)?.finished === true;

beforeEach(() => {
  h.resetFixtures({ autopilot, getDomainBudgetStatus, getSettings });
});

describe('autopilot conductor', () => {
  it('rejects start when the cos domain is off (no run created)', async () => {
    state.cosMode = 'off';
    const { seriesId } = await seedComplete();
    const res = await autopilot.startSeriesAutopilot(seriesId, {});
    expect(res).toMatchObject({ rejected: true, mode: 'off' });
    expect(autopilot.__testing.runs.has(seriesId)).toBe(false);
  });

  it('dry-run emits a plan without calling any generator', async () => {
    state.cosMode = 'dry-run';
    const { seriesId } = await seedComplete();
    const { runId } = await autopilot.startSeriesAutopilot(seriesId, {});
    expect(runId).toBeTruthy();
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('complete');
    expect(last?.dryRun).toBe(true);
    // plan rides the terminal frame too, so a late SSE subscriber (the common
    // case for a fast dry-run) still gets it via lastPayload replay.
    expect(Array.isArray(last?.plan)).toBe(true);
    expect(last.plan.length).toBeGreaterThan(0);
    expect(arcSpies.generateArcOverview).not.toHaveBeenCalled();
    expect(arcSpies.verifyArc).not.toHaveBeenCalled();
  });

  it('drives a ready series to done in execute mode', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(arcSpies.verifyArc).toHaveBeenCalled();
    expect(arcSpies.verifyVolume).toHaveBeenCalled();
    expect(arcSpies.analyzeManuscriptCompleteness).toHaveBeenCalled();
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('done');
  });

  it('runs on the series-configured provider/model and names it on the start frame', async () => {
    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { llm: { provider: 'codex', model: 'gpt-x' } });
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    const run = autopilot.__testing.runs.get(seriesId);
    // Stamped once at start, so every delegated call threads the same soft default.
    expect(run.options.providerOverride).toBe('codex');
    expect(run.options.modelOverride).toBe('gpt-x');
    // Delegated arc verify receives it as a SOFT default (a stage pin still wins).
    expect(arcSpies.verifyArc).toHaveBeenCalledWith(
      seriesId,
      expect.objectContaining({ providerDefault: 'codex', modelDefault: 'gpt-x' }),
    );
    // The same values ride the retained start frame, so a client attaching
    // mid-run can name what the run is spending on.
    expect(run.startPayload).toMatchObject({ type: 'start', provider: 'codex', model: 'gpt-x' });
  });

  // `overrideStagePins` reaches stageRunner through an async-context flag rather
  // than an option key, precisely so it survives every delegated hop. Assert it
  // from INSIDE a delegated service — a wrapper that only covered the direct
  // staged calls would pass a check on run.options and still miss the child
  // runners this feature exists to reach.
  it('propagates overrideStagePins into delegated services as an async-context flag', async () => {
    const { seriesId } = await seedComplete();
    let seenInsideDelegate = null;
    arcSpies.verifyArc.mockImplementationOnce(async () => {
      seenInsideDelegate = stagePinsIgnored();
      return { issues: state.verifyFindings };
    });
    await autopilot.startSeriesAutopilot(seriesId, { providerOverride: 'claude', overrideStagePins: true });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.options.overrideStagePins).toBe(true);
    expect(seenInsideDelegate).toBe(true);
    // The flag is scoped to the run's own async subtree — it must not linger.
    expect(stagePinsIgnored()).toBe(false);
  });

  it('leaves stage pins in force for an ordinary run', async () => {
    const { seriesId } = await seedComplete();
    let seenInsideDelegate = null;
    arcSpies.verifyArc.mockImplementationOnce(async () => {
      seenInsideDelegate = stagePinsIgnored();
      return { issues: state.verifyFindings };
    });
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.options.overrideStagePins).toBe(false);
    expect(seenInsideDelegate).toBe(false);
  });

  it('lets a per-run provider override beat the series-configured provider', async () => {
    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { llm: { provider: 'codex', model: 'gpt-x' } });
    await autopilot.startSeriesAutopilot(seriesId, { providerOverride: 'claude' });
    await waitFor(runFinished(seriesId));
    const run = autopilot.__testing.runs.get(seriesId);
    expect(run.options.providerOverride).toBe('claude');
    // codex's model must NOT ride along to claude.
    expect(run.options.modelOverride).toBeUndefined();
  });

  // arc verify is a JUDGE-role call, and the live failure was that a run which
  // picked ONE provider/model with `autoSelectModels` on kept creation on that
  // route while the verifier was re-pointed at the learned one. Asserted at the
  // delegated verify call — where the wrong provider actually got spent — for
  // both a run that chose a route and one that left the judge to the evidence.
  it.each([
    ['keeps arc verify on the run route the user chose', { providerOverride: 'claude', modelOverride: 'claude-model' }, 'claude', 'claude-model'],
    ['lets a learned judge route fill in for a run that chose none', {}, 'codex', 'gpt-x'],
  ])('%s', async (_name, routeOptions, provider, model) => {
    state.modelRecommendations = {
      verifyArcSpine: { judge: { providerOverride: 'codex', modelOverride: 'gpt-x' } },
      verifyArc: { judge: { providerOverride: 'codex', modelOverride: 'gpt-x' } },
    };
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { ...routeOptions, autoSelectModels: true });
    await waitFor(runFinished(seriesId));
    expect(arcSpies.verifyArc).toHaveBeenCalledWith(
      seriesId,
      expect.objectContaining({ providerDefault: provider, modelDefault: model }),
    );
  });

  it('pauses for review when arc verify never converges', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('verifyArcSpine');
    // bounded: verifyArc called exactly maxRounds times, resolve called rounds-1.
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(2);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(1);
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    expect(series.autopilot?.residualFindings?.[0]?.problem).toBe('plot hole');
  });

  it('includes per-volume verification before drafting beats', async () => {
    state.volumeVerifyFindings = [{ severity: 'high', problem: 'the midpoint promise never pays off', location: 'issue 3' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('verifyArc');
    expect(arcSpies.verifyVolume).toHaveBeenCalledTimes(1);
    expect(arcSpies.verifyVolume).toHaveBeenCalledWith(seriesId, expect.any(String), expect.objectContaining({ synopsisOnly: true }));
    expect(last?.residualFindings?.[0]).toMatchObject({
      problem: 'the midpoint promise never pays off',
      location: expect.stringContaining('volume 1'),
    });
  });

  // The resolver has to plan at the altitude the verifier judged at (#3789).
  it('scopes the arc-spine gate\'s resolver to spineOnly', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.scope).toBe('verifyArcSpine');
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(1);
    expect(arcSpies.resolveVerifyIssues.mock.calls[0][1]).toMatchObject({ spineOnly: true });
  });

  it('leaves the full arc gate\'s resolver able to correct episodes', async () => {
    // Spine passes on round 1 (no arc findings), so the pause below comes from
    // the post-episode full gate — where episode corrections are the only way
    // an episode-scoped finding can converge.
    state.volumeVerifyFindings = [{ severity: 'high', problem: 'the midpoint promise never pays off', location: 'issue 3' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.scope).toBe('verifyArc');
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(1);
    expect(arcSpies.resolveVerifyIssues.mock.calls[0][1]).toMatchObject({ spineOnly: false });
  });

  // Foundation-quality gate (#2176).
  it('foundation gate: a clean foundation (default mock ≥ threshold) passes through to completion', async () => {
    state.foundationScore = 10;
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(judgeFoundation).toHaveBeenCalled();
    // clean on round 1 → no fix attempted
    expect(applyFoundationFix).not.toHaveBeenCalled();
  });

  it('repairs the arc spine before the foundation judge sees the synopsis plan', async () => {
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: [{ severity: 'high', problem: 'missing setup', location: 'V1' }] }))
      .mockImplementationOnce(async () => ({ issues: [] }));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(1);
    expect(judgeFoundation).toHaveBeenCalledTimes(1);
  });

  it('foundation gate: iterates on the weakest dimension then pauses (maxRounds) when it never clears', async () => {
    state.foundationScore = 3; // below the 7.5 default threshold every round
    state.foundationFixApplied = true;
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 2 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('foundationGate');
    expect(last?.reason).toMatch(/Foundation quality/);
    // bounded: judged maxRounds times, a fix applied between rounds.
    expect(judgeFoundation).toHaveBeenCalledTimes(2);
    expect(applyFoundationFix).toHaveBeenCalledTimes(1);
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    expect(series.autopilot?.residualFindings?.length).toBeGreaterThan(0);
  });

  it('foundation gate: uses the critic route for judging and the creative route for repairs', async () => {
    state.foundationScore = 3;
    state.foundationFixApplied = true;
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {
      providerOverride: 'codex-tui',
      modelOverride: 'gpt-5.6-luna',
      effortOverride: 'max',
      judgeLlm: {
        providerOverride: 'codex-tui',
        modelOverride: 'gpt-5.6-sol',
        effortOverride: 'xhigh',
      },
      maxFoundationRounds: 2,
    });
    await waitFor(runFinished(seriesId));
    expect(judgeFoundation).toHaveBeenCalledWith(seriesId, expect.objectContaining({
      providerDefault: 'codex-tui', modelDefault: 'gpt-5.6-sol', effortDefault: 'xhigh',
    }));
    expect(applyFoundationFix).toHaveBeenCalledWith(seriesId, expect.any(String), expect.objectContaining({
      providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
    }));
    expect((await seriesSvc.getSeries(seriesId)).autopilot?.resumeOptions).toMatchObject({
      providerOverride: 'codex-tui',
      modelOverride: 'gpt-5.6-luna',
      effortOverride: 'max',
      judgeLlm: {
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh',
      },
    });
  });

  it('foundation gate: applies and persists a stage-specific creative route', async () => {
    state.foundationScore = 3;
    state.foundationFixApplied = true;
    const { seriesId } = await seedComplete();
    const stageLlm = {
      foundationGate: {
        creative: {
          providerOverride: 'codex-tui',
          modelOverride: 'gpt-5.6-sol',
          effortOverride: 'xhigh',
        },
      },
    };
    await autopilot.startSeriesAutopilot(seriesId, {
      providerOverride: 'codex-tui',
      modelOverride: 'gpt-5.6-luna',
      effortOverride: 'max',
      stageLlm,
      maxFoundationRounds: 2,
    });
    await waitFor(runFinished(seriesId));
    expect(applyFoundationFix).toHaveBeenCalledWith(seriesId, expect.any(String), expect.objectContaining({
      providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh',
    }));
    expect((await seriesSvc.getSeries(seriesId)).autopilot?.resumeOptions).toMatchObject({ stageLlm });
  });

  it('foundation gate: repairs a below-floor character dimension even when the weighted score passes', async () => {
    state.foundationScore = 8.5;
    state.foundationDimensionScores = { worldbuilding: 10, character: 5, structure: 10, craft: 10 };
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 2 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('foundationGate');
    expect(last?.reason).toMatch(/character below the 6 dimension floor/);
    expect(applyFoundationFix).toHaveBeenCalledWith(seriesId, 'character', expect.any(Object));
  });

  it('foundation gate: repairs the dimension below the requested bar before polishing an already-ready world', async () => {
    state.foundationScore = 7.8;
    state.foundationDimensionScores = { worldbuilding: 8, character: 8, structure: 7, craft: 8 };
    applyFoundationFix.mockImplementationOnce(async (_seriesId, dimension) => {
      state.foundationScore = 8;
      state.foundationDimensionScores = { worldbuilding: 8, character: 8, structure: 8, craft: 8 };
      return { dimension, applied: true };
    });
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { foundationThreshold: 8, maxFoundationRounds: 2 });
    await waitFor(runFinished(seriesId));

    expect(applyFoundationFix).toHaveBeenCalledTimes(1);
    expect(applyFoundationFix).toHaveBeenCalledWith(seriesId, 'structure', expect.any(Object));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('foundation gate: lets a newly surfaced target run before applying divergence patience', async () => {
    const snap = (weightedScore, scores) => ({
      seriesId: 'ser-example', status: 'complete', weightedScore,
      dimensions: {
        worldbuilding: { score: scores.worldbuilding, gap: 'g', fix: 'f' },
        character: { score: scores.character, gap: 'g', fix: 'f' },
        structure: { score: scores.structure, gap: 'g', fix: 'f' },
        craft: { score: scores.craft, gap: 'g', fix: 'f' },
      },
    });
    judgeFoundation
      .mockImplementationOnce(async () => snap(7.4, {
        worldbuilding: 7.4, character: 7.4, structure: 7.4, craft: 7.4,
      }))
      .mockImplementationOnce(async () => snap(6.6, {
        worldbuilding: 8, character: 7, structure: 5, craft: 7,
      }))
      .mockImplementationOnce(async () => snap(6.8, {
        worldbuilding: 8, character: 7, structure: 7, craft: 5,
      }))
      .mockImplementationOnce(async () => snap(8, {
        worldbuilding: 8, character: 8, structure: 8, craft: 8,
      }));

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 4 });
    await waitFor(runFinished(seriesId));

    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(applyFoundationFix.mock.calls.slice(0, 3).map(([, dimension]) => dimension))
      .toEqual(['worldbuilding', 'structure', 'craft']);
  });

  it('foundation gate: reverts a repair that leaves its target unchanged, then retries it from the checkpoint', async () => {
    const snapshot = (weightedScore, worldbuilding = 8) => ({
      seriesId: 'ser-example', status: 'complete', weightedScore,
      dimensions: {
        worldbuilding: { score: worldbuilding, gap: 'The active-node evidence rule is undefined.', fix: 'Define it.' },
        character: { score: 6, gap: 'Aruun privacy is mislabeled as a relapse.', fix: 'Separate privacy from safety disclosure.' },
        structure: { score: 7, gap: 'The charter handoff is thin.', fix: 'Stage the handoff.' },
        craft: { score: 8, gap: 'The panel grammar is thin.', fix: 'Add panel rules.' },
      },
    });
    judgeFoundation
      .mockImplementationOnce(async () => snapshot(7.2))
      .mockImplementationOnce(async () => snapshot(7.1, 7.75));
    const checkpoint = { seriesId: 'ser-example', marker: 'before-character-repair' };
    snapshotFoundationState.mockResolvedValueOnce(checkpoint);

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 4 });
    await waitFor(runFinished(seriesId));

    // The rejected edits are rolled back to the checkpoint that was taken before
    // them — but one bad proposal does not end a 4-round budget, so the same
    // dimension is repaired again, and the retry is told what was reverted.
    // The pre-repair verdict rides along so the restored content keeps its
    // matching cached judgment instead of forcing a re-judge on resume.
    expect(restoreFoundationState).toHaveBeenCalledWith(
      seriesId,
      checkpoint,
      { judge: expect.objectContaining({ weightedScore: 7.2 }) },
    );
    const characterRepairs = applyFoundationFix.mock.calls.filter(([, dimension]) => dimension === 'character');
    expect(characterRepairs.length).toBeGreaterThan(1);
    expect(characterRepairs[0][2].finding.gap).toBe('Aruun privacy is mislabeled as a relapse.');
    expect(characterRepairs[0][2].finding.retryReason).toBeUndefined();
    expect(characterRepairs[1][2].finding).toMatchObject({
      // The ORIGINAL gap — the foundation is back at the pre-repair checkpoint.
      gap: 'Aruun privacy is mislabeled as a relapse.',
      retryReason: expect.stringMatching(/REVERTED/),
    });
    // The rewound judgment is reused instead of paying for an identical re-judge.
    expect(judgeFoundation).toHaveBeenCalledTimes(3);
  });

  it('foundation gate: a retry quotes the rejected re-judge gap, and a kept repair drops that note', async () => {
    const snapshot = (weightedScore, character, characterGap) => ({
      seriesId: 'ser-example', status: 'complete', weightedScore,
      dimensions: {
        worldbuilding: { score: 8, gap: 'w', fix: 'f' },
        character: { score: character, gap: characterGap, fix: 'Separate the motives.' },
        structure: { score: 7.5, gap: 's', fix: 'f' },
        craft: { score: 8, gap: 'c', fix: 'f' },
      },
    });
    judgeFoundation
      .mockImplementationOnce(async () => snapshot(7.2, 6, 'The lead motive is blurred.'))
      // Tied target, unchanged gap, lower aggregate: rejected and rewound.
      .mockImplementationOnce(async () => snapshot(7.1, 6, 'The lead motive is still blurred.'))
      // Improved target: the retry is kept while character remains the weakest.
      .mockImplementationOnce(async () => snapshot(7.4, 6.5, 'The rival motive is thin.'))
      .mockImplementationOnce(async () => snapshot(9, 9, 'none'));

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 4 });
    await waitFor(runFinished(seriesId));

    const characterRepairs = applyFoundationFix.mock.calls.filter(([, dimension]) => dimension === 'character');
    expect(characterRepairs).toHaveLength(3);
    expect(characterRepairs[1][2].finding.retryReason)
      .toContain('reported: The lead motive is still blurred.');
    expect(characterRepairs[2][2].finding.retryReason).toBeUndefined();
    expect(characterRepairs[2][2].finding.gap).toBe('The rival motive is thin.');
  });

  it('foundation gate: keeps a tied character repair that objectively filled blank cast fields', async () => {
    // The 2026-08-11 stall: the character repair authored every blank visual
    // field on the core cast, the judge held character at 5 (its prompt showed
    // each authored field as a presence marker, not the design), and unrelated
    // worldbuilding noise dropped the aggregate — so a complete character pass
    // was reverted. Filled fields on disk now outrank the tied score.
    const snapshot = (weightedScore, worldbuilding) => ({
      seriesId: 'ser-example', status: 'complete', weightedScore,
      dimensions: {
        worldbuilding: { score: worldbuilding, gap: 'External societies read as negotiation venues.', fix: 'Add daily practices.' },
        character: { score: 5, gap: 'Every core character has blank visual fields.', fix: 'Author the visual foundation.' },
        structure: { score: 5, gap: 'The climax occurs in two places.', fix: 'Reconcile issue 11 and 12.' },
        craft: { score: 8, gap: 'The exemplars are all one culture.', fix: 'Add an external-culture exemplar.' },
      },
    });
    judgeFoundation
      .mockImplementationOnce(async () => snapshot(6.5, 8))
      .mockImplementationOnce(async () => snapshot(6.1, 7))
      .mockImplementationOnce(async () => ({
        seriesId: 'ser-example', status: 'complete', weightedScore: 8,
        dimensions: {
          worldbuilding: { score: 8, gap: 'g', fix: 'f' },
          character: { score: 8, gap: 'g', fix: 'f' },
          structure: { score: 8, gap: 'g', fix: 'f' },
          craft: { score: 8, gap: 'g', fix: 'f' },
        },
      }));
    // 25 blank fields across the repairable cast before the repair, none after.
    readFoundationCharacterProgress
      .mockResolvedValueOnce({ blanks: 25, integrityFindings: 4 })
      .mockResolvedValueOnce({ blanks: 0, integrityFindings: 4 });

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 3 });
    await waitFor(runFinished(seriesId));

    expect(restoreFoundationState).not.toHaveBeenCalled();
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(applyFoundationFix.mock.calls.map(([, dimension]) => dimension)).toEqual(['character', 'character']);
  });

  it('foundation gate: keeps a tied character repair that only closed cast-integrity gaps (#6415)', async () => {
    // The psychology profile (#6414) is in none of the blank-counted field sets,
    // so a repair that authored a lead's theory of control and its six drives
    // used to register as literally zero objective progress and get rewound on a
    // tied score. The deterministic cast-integrity count is the measure that
    // sees it.
    const snapshot = (weightedScore, worldbuilding) => ({
      seriesId: 'ser-example', status: 'complete', weightedScore,
      dimensions: {
        worldbuilding: { score: worldbuilding, gap: 'External societies read as negotiation venues.', fix: 'Add daily practices.' },
        character: { score: 5, gap: 'The lead states no theory of control.', fix: 'Author the control belief and drives.' },
        structure: { score: 5, gap: 'The climax occurs in two places.', fix: 'Reconcile issue 11 and 12.' },
        craft: { score: 8, gap: 'The exemplars are all one culture.', fix: 'Add an external-culture exemplar.' },
      },
    });
    judgeFoundation
      .mockImplementationOnce(async () => snapshot(6.5, 8))
      .mockImplementationOnce(async () => snapshot(6.1, 7))
      .mockImplementationOnce(async () => ({
        seriesId: 'ser-example', status: 'complete', weightedScore: 8,
        dimensions: {
          worldbuilding: { score: 8, gap: 'g', fix: 'f' },
          character: { score: 8, gap: 'g', fix: 'f' },
          structure: { score: 8, gap: 'g', fix: 'f' },
          craft: { score: 8, gap: 'g', fix: 'f' },
        },
      }));
    // Blanks are UNCHANGED — only the integrity gaps closed.
    readFoundationCharacterProgress
      .mockResolvedValueOnce({ blanks: 12, integrityFindings: 7 })
      .mockResolvedValueOnce({ blanks: 12, integrityFindings: 0 });

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 3 });
    await waitFor(runFinished(seriesId));

    expect(restoreFoundationState).not.toHaveBeenCalled();
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('foundation gate: pauses only after repeated rejected repairs exhaust the same target', async () => {
    const stalled = {
      seriesId: 'ser-example', status: 'complete', weightedScore: 7,
      dimensions: {
        worldbuilding: {
          score: 7,
          gap: 'The setting lacks a concrete scarcity mechanism and authority conflict.',
          fix: 'Define the scarcity mechanism and authority conflict.',
        },
        character: { score: 10, gap: 'clean', fix: 'none' },
        structure: { score: 10, gap: 'clean', fix: 'none' },
        craft: { score: 10, gap: 'clean', fix: 'none' },
      },
    };
    judgeFoundation.mockImplementation(async () => stalled);
    let checkpointSeq = 0;
    snapshotFoundationState.mockImplementation(async (sId) => {
      checkpointSeq += 1;
      return { seriesId: sId, marker: `checkpoint-${checkpointSeq}` };
    });
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 5 });
    await waitFor(runFinished(seriesId));

    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last).toMatchObject({ type: 'paused', scope: 'foundationGate', pauseKind: 'regression' });
    // Every rejected attempt was rolled back — to the checkpoint taken just
    // before IT, so no retry ever builds on a rejected edit — and the pause says so.
    expect(applyFoundationFix.mock.calls.length).toBeGreaterThan(1);
    expect(restoreFoundationState.mock.calls.map(([, cp]) => cp.marker))
      .toEqual(applyFoundationFix.mock.calls.map((_call, index) => `checkpoint-${index + 1}`));
    expect(last?.reason).toMatch(/reverted to the pre-repair checkpoint/);
    for (const [, , options] of applyFoundationFix.mock.calls) {
      expect(options.finding.gap).toBe(stalled.dimensions.worldbuilding.gap);
    }
    // The residual describes the RESTORED foundation the user is handed back.
    expect(last?.residualFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        location: expect.stringContaining('worldbuilding'),
        problem: stalled.dimensions.worldbuilding.gap,
      }),
    ]));
  });

  it('foundation gate: stops immediately when a rejected repair cannot be rolled back', async () => {
    const stalled = {
      seriesId: 'ser-example', status: 'complete', weightedScore: 7,
      dimensions: {
        worldbuilding: { score: 7, gap: 'The scarcity mechanism is undefined.', fix: 'Define it.' },
        character: { score: 10, gap: 'clean', fix: 'none' },
        structure: { score: 10, gap: 'clean', fix: 'none' },
        craft: { score: 10, gap: 'clean', fix: 'none' },
      },
    };
    judgeFoundation.mockImplementation(async () => stalled);
    restoreFoundationState.mockResolvedValueOnce({ restored: false, reason: 'universe.premise' });

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 5 });
    await waitFor(runFinished(seriesId));

    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last).toMatchObject({ type: 'paused', scope: 'foundationGate', pauseKind: 'regression' });
    expect(last?.reason).toMatch(/checkpoint verification failed after rollback: universe\.premise/);
    // An unverified checkpoint is the one case that must NOT be retried.
    expect(applyFoundationFix).toHaveBeenCalledTimes(1);
  });

  it('foundation gate: accepts a retry that improves its target after an earlier attempt was reverted', async () => {
    const snapshot = (weightedScore, worldbuilding) => ({
      seriesId: 'ser-example', status: 'complete', weightedScore,
      dimensions: {
        worldbuilding: { score: worldbuilding, gap: 'The scarcity mechanism is undefined.', fix: 'Define it.' },
        character: { score: 10, gap: 'clean', fix: 'none' },
        structure: { score: 10, gap: 'clean', fix: 'none' },
        craft: { score: 10, gap: 'clean', fix: 'none' },
      },
    });
    judgeFoundation
      // Round 1: worldbuilding is the weak target.
      .mockImplementationOnce(async () => snapshot(7, 5))
      // Round 2: the repair moved nothing and cost aggregate score → reverted.
      .mockImplementationOnce(async () => snapshot(6.6, 5))
      // Round 3 re-judges the SECOND attempt (the rewound round reuses the
      // round-1 verdict), which earned its keep and clears the gate.
      .mockImplementationOnce(async () => snapshot(9, 9));

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 5 });
    await waitFor(runFinished(seriesId));

    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(restoreFoundationState).toHaveBeenCalledTimes(1);
    expect(applyFoundationFix.mock.calls.filter(([, d]) => d === 'worldbuilding')).toHaveLength(2);
  });

  it('foundation gate: a third attempt carries BOTH earlier rejections for its dimension (#3835)', async () => {
    // The evidence-loss #3829/#3832 closed for the arc gate: the foundation gate
    // kept only the LAST rejection per dimension, so a dimension that rejected
    // two different repairs handed the next one evidence of only the second and
    // the editor was free to re-author the first.
    const snap = (weightedScore, characterScore, characterGap) => ({
      seriesId: 'ser-example', status: 'complete', weightedScore,
      dimensions: {
        worldbuilding: { score: 9, gap: 'The ration authority is unnamed.', fix: 'Name it.' },
        character: { score: characterScore, gap: characterGap, fix: `repair ${characterGap}` },
        structure: { score: 9, gap: 'The charter handoff is thin.', fix: 'Stage the handoff.' },
        craft: { score: 9, gap: 'The panel grammar is thin.', fix: 'Add panel rules.' },
      },
    });
    const standing = 'The visitor has no defined body scale or metabolic support needs.';
    const firstRejected = 'The mentor subplot vanishes entirely after the second issue.';
    const surfaced = 'Every core cast member shares one identical grief reflex.';
    const secondRejected = 'The finale resolves offstage inside a single unread letter.';
    judgeFoundation
      // R1: character is the weak target → repair #1.
      .mockImplementationOnce(async () => snap(6, 5, standing))
      // R2: repair #1 left character WORSE → reverted, rejection banked → repair #2.
      .mockImplementationOnce(async () => snap(5.5, 4, firstRejected))
      // R3: repair #2 earned its keep (5 → 6) → repair #3 from the new state.
      .mockImplementationOnce(async () => snap(6.5, 6, surfaced))
      // R4: repair #3 regressed → reverted, second rejection banked → repair #4.
      .mockImplementationOnce(async () => snap(6, 5, secondRejected))
      // R5: repair #4 cleared the gate.
      .mockImplementationOnce(async () => snap(9, 9, 'clean'));

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 5 });
    await waitFor(runFinished(seriesId));

    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    const characterRepairs = applyFoundationFix.mock.calls.filter(([, d]) => d === 'character');
    expect(characterRepairs).toHaveLength(4);
    const avoided = characterRepairs[3][2].avoidFindings.map((f) => f.problem);
    // BOTH rejected candidates, not just the most recent one — and the accepted
    // repair in between did not wipe the first: a candidate the gate rejected is
    // still a candidate it rejected.
    expect(avoided).toEqual(expect.arrayContaining([secondRejected, firstRejected]));
    // The gap this call is being ASKED to close is filtered out — telling the
    // editor both "fix this" and "never author this" is contradictory.
    expect(avoided).not.toContain(surfaced);
  });

  it('foundation gate: stamps its per-dimension rollback history on the pause marker (#3835)', async () => {
    const stalled = {
      seriesId: 'ser-example', status: 'complete', weightedScore: 6,
      dimensions: {
        worldbuilding: { score: 9, gap: 'The ration authority is unnamed.', fix: 'Name it.' },
        character: { score: 5, gap: 'The mentor subplot vanishes entirely after the second issue.', fix: 'Restore it.' },
        structure: { score: 9, gap: 'The charter handoff is thin.', fix: 'Stage the handoff.' },
        craft: { score: 9, gap: 'The panel grammar is thin.', fix: 'Add panel rules.' },
      },
    };
    judgeFoundation.mockImplementation(async () => stalled);

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 5 });
    await waitFor(runFinished(seriesId));

    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('paused');
    // Keyed by dimension so a resumed gate hands each editor back its OWN
    // history — a rejected character rewrite is no reason for the structure
    // editor to avoid anything.
    const { foundationDiscardedFindings } = (await seriesSvc.getSeries(seriesId)).autopilot;
    expect(Object.keys(foundationDiscardedFindings)).toEqual(['character']);
    expect(foundationDiscardedFindings.character).toEqual(expect.arrayContaining([
      expect.objectContaining({ problem: stalled.dimensions.character.gap }),
    ]));
  });

  it('foundation gate: seeds a resumed run with the dimension history the pause carried (#3835)', async () => {
    const carried = [{ severity: 'high', location: 'character (weight 25%, scored 4)', problem: 'The mentor subplot vanishes entirely after the second issue.' }];
    const snap = (weightedScore, characterScore) => ({
      seriesId: 'ser-example', status: 'complete', weightedScore,
      dimensions: {
        worldbuilding: { score: 9, gap: 'The ration authority is unnamed.', fix: 'Name it.' },
        character: { score: characterScore, gap: 'The visitor has no defined body scale or metabolic support needs.', fix: 'Author it.' },
        structure: { score: 9, gap: 'The charter handoff is thin.', fix: 'Stage the handoff.' },
        craft: { score: 9, gap: 'The panel grammar is thin.', fix: 'Add panel rules.' },
      },
    });
    judgeFoundation
      .mockImplementationOnce(async () => snap(6, 5))
      .mockImplementationOnce(async () => snap(9, 9));

    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, {
      autopilot: {
        status: 'paused', currentStep: 'foundationGate',
        foundationDiscardedFindings: { character: carried },
      },
    });
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 5 });
    await waitFor(runFinished(seriesId));

    // A resume starts a fresh gate with an empty bank, so without the carry the
    // very repair the paused run reverted is free to come straight back.
    const [, , options] = applyFoundationFix.mock.calls.find(([, d]) => d === 'character');
    expect(options.avoidFindings.map((f) => f.problem)).toEqual([carried[0].problem]);
  });

  it('foundation gate: gives a newly exposed gap at the same score its own repair window', async () => {
    const snap = (gap, score = 7) => ({
      seriesId: 'ser-example', status: 'complete', weightedScore: score,
      dimensions: {
        worldbuilding: { score, gap, fix: `repair ${gap}` },
        character: { score: 10, gap: 'clean', fix: 'none' },
        structure: { score: 10, gap: 'clean', fix: 'none' },
        craft: { score: 10, gap: 'clean', fix: 'none' },
      },
    });
    judgeFoundation
      .mockImplementationOnce(async () => snap('The visitor has no defined body scale or metabolic support needs.'))
      .mockImplementationOnce(async () => snap('The neighboring societies lack governance, factions, and translation methods.'))
      .mockImplementationOnce(async () => snap('The home settlement has no concrete infrastructure failure chain or ration authority.'))
      .mockImplementationOnce(async () => snap('clean', 10));

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 4 });
    await waitFor(runFinished(seriesId));

    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(applyFoundationFix).toHaveBeenCalledTimes(3);
    expect(applyFoundationFix.mock.calls.map(([, dimension]) => dimension))
      .toEqual(['worldbuilding', 'worldbuilding', 'worldbuilding']);
  });

  it('foundation gate: pauses immediately when the weakest dimension cannot be auto-fixed', async () => {
    state.foundationScore = 3;
    state.foundationFixApplied = false; // owning service can't apply a fix
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 3 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.pauseKind).toBe('inapplicable');
    // one judge, one (failed) fix attempt, then pause — no burning the rest.
    expect(judgeFoundation).toHaveBeenCalledTimes(1);
    expect(applyFoundationFix).toHaveBeenCalledTimes(1);
  });

  it('foundation gate: a reverted structure repair surfaces the arc blockers it was judged on', async () => {
    // The repair reverted itself because the arc verifier still found blockers.
    // The pause's `residual` is the dimension-level gap list, so those blockers
    // reach the user nowhere unless the revert reports them — leaving "left 2
    // blocker(s)" in prose as the only trace of why a rewrite was thrown away.
    const blockers = [
      { severity: 'high', location: 'V2', problem: 'ration authority contradicts the founding charter' },
      { severity: 'medium', location: 'V3', problem: 'the eclipse lands before the calendar allows it' },
    ];
    state.foundationScore = 7;
    state.foundationDimensionScores = { worldbuilding: 8, character: 8, structure: 3, craft: 8 };
    applyFoundationFix.mockImplementationOnce(async (_sId, dimension, options) => {
      options.onRunCreated('structure-reverted');
      return {
        dimension,
        applied: false,
        reverted: true,
        actions: 4,
        reason: 'structure repair left 2 arc-verification blocker(s); reverted to the pre-repair plan',
        discarded: blockers,
        rejectedRunIds: ['structure-reverted'],
      };
    });
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 3 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.pauseKind).toBe('inapplicable');
    expect(last?.discardedFindings).toEqual(blockers);
    expect(patchRunMetadata).toHaveBeenCalledWith('structure-reverted', expect.objectContaining({
      seriesId, autopilotSystem: 'series', pipelineRole: 'creative',
    }));
    expect(recordModelOutcome).toHaveBeenCalledWith('structure-reverted', expect.objectContaining({
      role: 'creative', stage: 'foundationGate', outcome: 'rejected', target: 'structure',
    }));
    expect(recordModelOutcome).not.toHaveBeenCalledWith('structure-reverted', expect.objectContaining({ outcome: 'invalid' }));
  });

  it('foundation gate: an inapplicable fix with nothing reverted reports no discarded set', async () => {
    state.foundationScore = 3;
    state.foundationFixApplied = false;
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 3 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.discardedFindings).toEqual([]);
  });

  it('foundation gate: a repair that throws pauses the run instead of erroring it away', async () => {
    state.foundationScore = 3;
    applyFoundationFix.mockRejectedValueOnce(new Error('TUI run timed out after 600000ms'));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 3 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    // The whole point: an LLM transport failure is transient and has nothing to
    // do with the foundation, so it must NOT discard the run the way `error` does.
    expect(last?.type).toBe('paused');
    expect(last?.pauseKind).toBe('providerFailed');
    expect(last?.reason).toMatch(/TUI run timed out after 600000ms/);
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    // Survives the sanitizer — an unlisted kind would be silently nulled and the
    // UI badge would vanish.
    expect(series.autopilot?.pauseKind).toBe('providerFailed');
  });

  it('foundation gate: disabled via option runs no judge and proceeds', async () => {
    state.foundationScore = 3;
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { foundationGate: false });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(judgeFoundation).not.toHaveBeenCalled();
  });
});
