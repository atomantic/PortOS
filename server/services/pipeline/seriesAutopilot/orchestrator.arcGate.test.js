/**
 * orchestrator.arcGate.test.js
 *
 * orchestrator arc, notification and convergence gates. Split from seriesAutopilot.test.js (#16214); shared mocks and
 * fixtures live in seriesAutopilot.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./seriesAutopilot.testFixtures.js'));
const { state, arcSpies, recordModelOutcome, addNotification, removeByMetadata, waitFor, seedComplete } = h;

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

const runFinished = (sId) => () => autopilot.__testing.runs.get(sId)?.finished === true;

beforeEach(() => {
  h.resetFixtures({ autopilot, getDomainBudgetStatus, getSettings });
});

describe('autopilot conductor', () => {
  // Per-series blocking-severity sets (#1616).
  it('arc gate: default blocks a medium finding (pauses)', async () => {
    state.verifyFindings = [{ severity: 'medium', problem: 'soft beat', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('verifyArcSpine');
  });

  it('arc gate: a per-series arc:[high] override lets a medium finding pass', async () => {
    state.verifyFindings = [{ severity: 'medium', problem: 'soft beat', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { blockingSeverities: { arc: ['high'] } });
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    // medium no longer blocks arc → the run proceeds past arc to completion.
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('arc gate: an empty arc:[] override never blocks, even on a high finding', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { blockingSeverities: { arc: [] } });
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('beatContinuity gate: a per-series beatContinuity:[high] override lets a medium finding pass', async () => {
    state.beatContinuityFindings = [{ severity: 'medium', problem: 'beat drift', location: 'I1' }];
    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { blockingSeverities: { beatContinuity: ['high'] } });
    await autopilot.startSeriesAutopilot(seriesId, { maxBeatContinuityRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('editorial gate: an empty editorial:[] override never blocks, even on a high finding', async () => {
    state.editorialFindings = [{ severity: 'high', problem: 'missing scene', issueNumber: 1 }];
    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { blockingSeverities: { editorial: [] } });
    await autopilot.startSeriesAutopilot(seriesId, { maxEditorialRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('editorial gate: default blocks a high finding (pauses)', async () => {
    state.editorialFindings = [{ severity: 'high', problem: 'missing scene', issueNumber: 1 }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxEditorialRounds: 1 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('pilotReview');
  });

  it('posts an in-app notification when a run pauses, with a resume link (#1615)', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));
    expect(addNotification).toHaveBeenCalledTimes(1);
    const notif = addNotification.mock.calls[0][0];
    expect(notif.type).toBe('autopilot_paused');
    expect(notif.priority).toBe('high');
    expect(notif.link).toBe(`/pipeline/series/${seriesId}`);
    expect(notif.metadata?.autopilotPauseSeriesId).toBe(seriesId);
    // prior pause banners for this series are cleared first so resume→pause leaves one
    expect(removeByMetadata).toHaveBeenCalledWith('autopilotPauseSeriesId', seriesId);
  });

  it('persists run-local visual and gap choices for a paused resume', async () => {
    state.editorialFindings = [{ severity: 'high', problem: 'missing scene', issueNumber: 1 }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {
      includeVisual: false,
      fileGaps: true,
      maxEditorialRounds: 1,
    });
    await waitFor(runFinished(seriesId));
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    expect(series.autopilot?.resumeOptions).toEqual({
      includeVisual: false, fileGaps: true, autoSelectModels: false, overrideStagePins: false,
    });
  });

  it('persists the milestone map so a paused run survives a reload (#4140)', async () => {
    state.editorialFindings = [{ severity: 'high', problem: 'missing scene', issueNumber: 1 }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxEditorialRounds: 1 });
    await waitFor(runFinished(seriesId));
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    // The plan half: the same projection the run's `start` frame carried, so the
    // panel can redraw every milestone the run expected to reach.
    expect(series.autopilot?.plan?.length).toBeGreaterThan(0);
    expect(series.autopilot.plan.every((r) => typeof r.kind === 'string' && r.count >= 1)).toBe(true);
    // …and the progress half: where it actually got to, including the step it
    // stopped on (which is what the map draws as blocked).
    expect(series.autopilot?.progress?.currentStep).toBe('pilotReview');
    expect(Object.keys(series.autopilot.progress.completed).length).toBeGreaterThan(0);
  });

  it('keeps the milestone map on a restart-interrupted run (#4140)', async () => {
    // The map is stamped on every marker write that has a plan, not only the
    // terminals — a hard restart never reaches a terminal write, and the boot
    // recovery demotes `running` → `paused` by SPREADING whatever the marker
    // already held. Simulate that: complete a run, rewind its marker to the
    // `running` shape a killed process would have left, and recover.
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    const done = (await seriesSvc.getSeries(seriesId)).autopilot;
    expect(done?.plan?.length).toBeGreaterThan(0);
    await seriesSvc.updateSeries(seriesId, { autopilot: { ...done, status: 'running' } });
    await autopilot.recoverStuckAutopilots();
    const recovered = (await seriesSvc.getSeries(seriesId)).autopilot;
    expect(recovered.status).toBe('paused');
    expect(recovered.plan).toEqual(done.plan);
    expect(recovered.progress).toEqual(done.progress);
  });

  it('does not notify on a clean complete (#1615)', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(addNotification).not.toHaveBeenCalled();
  });

  it('clears any stale pause banner when a (resumed) execute run starts (#1615)', async () => {
    // A resume reuses startSeriesAutopilot; clearing on start means a run that
    // completes/errors without re-pausing doesn't leave a dead resume link.
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    expect(removeByMetadata).toHaveBeenCalledWith('autopilotPauseSeriesId', seriesId);
  });

  it('does not notify when notifyOnPause is opted out for the run (#1615)', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2, notifyOnPause: false });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('paused');
    expect(addNotification).not.toHaveBeenCalled();
  });

  it('uses the persisted maxArcVerifyRounds setting when no per-run override is given', async () => {
    // Strictly-decreasing blocking counts (4→3→2→1) so the loop runs to the cap
    // WITHOUT tripping the divergence guard (#1571) — this asserts the persisted
    // *setting* drives the round cap. mockImplementationOnce is self-consuming, so
    // it can't leak its impl into the next test the way mockImplementation would
    // (beforeEach's clearAllMocks keeps implementations).
    const holes = (n) => Array.from({ length: n }, (_, i) => ({ severity: 'high', problem: `hole ${i}`, location: 'V1' }));
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: holes(4) }))
      .mockImplementationOnce(async () => ({ issues: holes(3) }))
      .mockImplementationOnce(async () => ({ issues: holes(2) }))
      .mockImplementationOnce(async () => ({ issues: holes(1) }));
    getSettings.mockImplementation(async () => ({ pipelineEditorialChecks: { maxArcVerifyRounds: 4 } }));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {}); // no per-run rounds — settings drives it
    await waitFor(runFinished(seriesId));
    // 4 verify rounds (the persisted setting), 3 resolves, then a maxRounds pause.
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(4);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(3);
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.pauseKind).toBe('maxRounds');
  });

  it('stops early with a divergence pause when a verify gate stops converging (#1571)', async () => {
    // Raised cap, but the resolve passes never reduce the blocking count, so the
    // divergence guard bails at round 3 (patience 2) instead of burning all 6
    // rounds + budget. Distinct pauseKind so the UI can say "needs a human", not
    // "ran out of rounds".
    state.verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('verifyArcSpine');
    expect(last?.pauseKind).toBe('divergence');
    expect(last?.reason).toMatch(/stopped converging/);
    // Bailed at round 3 — NOT all 6 rounds (the whole point: budget saved).
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(3);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(2);
    // A tied blocker count can still contain newer, narrower findings. Round 3
    // verified the latest draft, so keep it in place rather than rewinding to
    // either earlier three-finding snapshot.
    expect(arcSpies.restoreArcState).not.toHaveBeenCalled();
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    // Persisted through sanitizeAutopilot so the resume banner survives a reload.
    expect(series.autopilot?.pauseKind).toBe('divergence');
  });

  it('does not pay for another judge when an exact arc repair applied nothing', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const noOp = {
      applied: false,
      rejectedExactEdits: 1,
      runId: 'no-op-resolve',
    };
    arcSpies.resolveVerifyIssues
      .mockResolvedValueOnce(noOp)
      .mockResolvedValueOnce(noOp);
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 3 });
    await waitFor(runFinished(seriesId));

    // The unchanged verifier result seeds the next round. The gate may retry a
    // shorter patch, but it never bills another judge for an identical store.
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(1);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(2);
    expect(recordModelOutcome).toHaveBeenCalledWith('no-op-resolve', expect.objectContaining({
      outcome: 'rejected', scoreBefore: -1, scoreAfter: -1,
    }));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.pauseKind).toBe('maxRounds');
  });

  it('keeps a bounded exact patch when a later judge exposes unrelated latent blockers', async () => {
    const target = { severity: 'medium', problem: 'the recovery order expires before the mandatory rest completes', location: 'V1' };
    const latent = [
      { severity: 'high', problem: 'the destination tow has no established local route', location: 'V3' },
      { severity: 'medium', problem: 'the inherited seal kit has no supplier setup', location: 'V2' },
    ];
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: [target] }))
      .mockImplementationOnce(async () => ({ issues: latent }))
      .mockImplementationOnce(async () => ({ issues: [] }));
    arcSpies.resolveVerifyIssues
      .mockResolvedValueOnce({ applied: true, patchMode: 'exact-text-v1', runId: 'exact-target' })
      .mockResolvedValueOnce({ applied: true, patchMode: 'exact-text-v1', runId: 'exact-latent' });
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 5 });
    await waitFor(runFinished(seriesId));

    expect(arcSpies.restoreArcState).not.toHaveBeenCalled();
    expect(arcSpies.resolveVerifyIssues.mock.calls[1][1].findings).toEqual(latent);
    expect(recordModelOutcome).toHaveBeenCalledWith('exact-target', expect.objectContaining({
      outcome: 'accepted', scoreBefore: -1, scoreAfter: 0,
    }));
  });

  it('does not rewind exact target closure at the round cap when the later judge is more exhaustive', async () => {
    const target = { severity: 'medium', problem: 'the recovery order expires before the mandatory rest completes', location: 'V1' };
    const latent = [
      { severity: 'high', problem: 'the destination tow has no established local route', location: 'V3' },
      { severity: 'medium', problem: 'the inherited seal kit has no supplier setup', location: 'V2' },
    ];
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: [target] }))
      .mockImplementationOnce(async () => ({ issues: latent }));
    arcSpies.resolveVerifyIssues
      .mockResolvedValueOnce({ applied: true, patchMode: 'exact-text-v1', runId: 'exact-before-cap' });
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));

    expect(arcSpies.restoreArcState).not.toHaveBeenCalled();
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last).toMatchObject({
      type: 'paused', pauseKind: 'maxRounds', residualFindings: latent,
    });
  });

  it('reverts an arc-resolve round that introduced blocking findings and pauses on the pre-round residual', async () => {
    // The 2026-08-09 non-convergence, replayed: the loop hands the resolver ONE
    // blocking finding and gets 3 back, then 5 — with the original still
    // standing every round. Before this guard all of that damage was committed
    // and the run paused on 5 findings the user never had. Now round 2's verify
    // sees the regression and puts the pre-resolve arc back; it spends its one
    // corrective pass from there, and when round 3 regresses again the gate is
    // out of retries and pauses on the original 1.
    const original = { severity: 'high', problem: 'volume 1 and volume 2 both stage the first eclipse', location: 'V1' };
    const extra = (i) => ({ severity: 'high', problem: `collateral break ${i}`, location: `V${i + 2}` });
    const round = (n) => ({ issues: [original, ...Array.from({ length: n - 1 }, (_, i) => extra(i))] });
    arcSpies.verifyArc
      .mockImplementationOnce(async () => round(1))
      .mockImplementationOnce(async () => round(3))
      .mockImplementationOnce(async () => round(5));
    arcSpies.resolveVerifyIssues
      .mockImplementationOnce(async () => ({ applied: true, runId: 'arc-regression-1' }))
      .mockImplementationOnce(async () => ({ applied: true, runId: 'arc-regression-2' }));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));

    // Bailed at round 3 — the loop never runs on past the second regression, so
    // rounds 4-6 cost nothing.
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(3);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(2);
    // Only the first-attempt resolve snapshots; the corrective pass reuses the
    // checkpoint it was just rewound to rather than pinning the reverted draft.
    expect(arcSpies.snapshotArcState).toHaveBeenCalledTimes(1);
    // The resolver reported no episode writes, so the rollback is authorized to
    // restore none — the arc and volumes come back, every synopsis stays put.
    expect(arcSpies.restoreArcState).toHaveBeenCalledWith(
      seriesId,
      await arcSpies.snapshotArcState.mock.results[0].value,
      { episodeEdits: [] },
    );
    // The corrective pass is handed the CHECKPOINT's findings (what the restored
    // plan actually has) plus the rejected attempt's own findings to steer away
    // from — not the 3-finding set, which is no longer in the plan at all.
    expect(arcSpies.resolveVerifyIssues.mock.calls[1][1]).toMatchObject({
      findings: [original],
      avoid: round(3).issues,
    });
    expect(recordModelOutcome).toHaveBeenCalledWith('arc-regression-1', expect.objectContaining({
      role: 'creative', stage: 'verifyArcSpine', outcome: 'rejected', scoreBefore: -1, scoreAfter: -3,
    }));
    expect(recordModelOutcome).toHaveBeenCalledWith('arc-regression-2', expect.objectContaining({
      role: 'creative', stage: 'verifyArcSpine', outcome: 'rejected', scoreBefore: -1, scoreAfter: -5,
    }));

    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('verifyArcSpine');
    expect(last?.pauseKind).toBe('regression');
    expect(last?.reason).toMatch(/reverted/);
    // Residual is what the user had BEFORE the round, not the 5 it manufactured.
    expect(last?.residualFindings).toEqual([original]);
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    expect(series.autopilot?.pauseKind).toBe('regression');
    expect(series.autopilot?.residualFindings).toHaveLength(1);
  });

  it('spends one corrective pass on a reverted resolve round and converges from it (#3781)', async () => {
    // The 2026-08-11 verifyArcSpine stall: 3 blockers in, 6 back, reverted —
    // and the run STOPPED there. A resume re-ran the same prompt over the same
    // restored state, so the gate could never clear itself unattended. Now the
    // revert is followed by one more resolve from the checkpoint that names the
    // rejected attempt's own findings as the failure mode to avoid.
    const holes = (n, prefix) => Array.from({ length: n }, (_, i) => ({
      severity: 'high', problem: `${prefix} ${i}`, location: `V${i + 1}`,
    }));
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: holes(3, 'initial') }))
      .mockImplementationOnce(async () => ({ issues: holes(6, 'regressed') }))
      .mockImplementationOnce(async () => ({ issues: [] }));
    arcSpies.resolveVerifyIssues
      .mockImplementationOnce(async () => ({ applied: true, runId: 'arc-rejected' }))
      .mockImplementationOnce(async () => ({ applied: true, runId: 'arc-accepted' }));
    const { seriesId } = await seedComplete();
    const frames = [];
    const handler = (p) => frames.push(p);
    autopilot.autopilotEvents.on(seriesId, handler);
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 3 });
    await waitFor(runFinished(seriesId));
    autopilot.autopilotEvents.off(seriesId, handler);

    // The damaged draft is still reverted — the retry is a second attempt from
    // the checkpoint, never an acceptance of the worse state.
    expect(arcSpies.restoreArcState).toHaveBeenCalledTimes(1);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(2);
    expect(arcSpies.resolveVerifyIssues.mock.calls[1][1]).toMatchObject({
      findings: holes(3, 'initial'),
      avoid: holes(6, 'regressed'),
    });
    // …and the gate clears, so the run advances instead of pausing for a human.
    const rollback = frames.find((f) => f.type === 'resolve:rollback');
    expect(rollback).toMatchObject({ before: 3, after: 6, best: 3, retrying: true });
    expect(frames.some((f) => f.type === 'resolve:round' && f.retry === true)).toBe(true);
    expect(frames.some((f) => f.type === 'paused' && f.pauseKind === 'regression')).toBe(false);
    expect(recordModelOutcome).toHaveBeenCalledWith('arc-rejected', expect.objectContaining({
      outcome: 'rejected', scoreBefore: -3, scoreAfter: -6,
    }));
    expect(recordModelOutcome).toHaveBeenCalledWith('arc-accepted', expect.objectContaining({
      outcome: 'accepted', scoreBefore: -3, scoreAfter: 0,
    }));
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.pauseKind).not.toBe('regression');
  });

  it('reports every arc-spine resolver attempt with what it actually wrote (#3843)', async () => {
    // The 2026-08-13 verifyArcSpine pause, replayed: 5 blockers → 2 → 2 → 2,
    // stopping on "no net progress over 2 consecutive rounds of auto-resolve".
    // Its retained telemetry was 4 `verify:round` frames and ONE `resolve:round`
    // reporting `episodesEdited: 0` — so a reader could see neither that the
    // first round's arc + volume edits are what took 5 to 2 (a spine resolver
    // may not touch episodes at all, so that zero was expected), nor that the
    // two rounds it paused over had attempted anything whatsoever.
    const blockers = (n) => Array.from({ length: n }, (_, i) => ({
      severity: 'high', problem: `spine gap ${i}`, location: `V${i + 1}`,
    }));
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: blockers(5) }))
      .mockImplementationOnce(async () => ({ issues: blockers(2) }));
    arcSpies.resolveVerifyIssues
      .mockImplementationOnce(async () => ({
        applied: true,
        runId: 'arc-spine-1',
        mutations: { arcFieldsEdited: 1, volumesEdited: 2, characterArcsEdited: 0, episodesEdited: 0 },
      }))
      // The two attempts the pause was counting. Both wrote nothing, for
      // different reasons — which is exactly the distinction the gate could not
      // report before.
      .mockImplementationOnce(async () => ({
        applied: false, runId: 'arc-spine-2', rejectedExactEdits: 3, noChangeReason: 'exact-edits-rejected',
      }))
      .mockImplementationOnce(async () => ({
        applied: false, runId: 'arc-spine-3', noChangeReason: 'no-edits-returned',
      }));
    const { seriesId } = await seedComplete();
    const frames = [];
    const handler = (p) => frames.push(p);
    autopilot.autopilotEvents.on(seriesId, handler);
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));
    autopilot.autopilotEvents.off(seriesId, handler);

    // Four rounds, three resolver attempts, and an outcome frame for each one.
    expect(frames.filter((f) => f.type === 'verify:round' && f.scope === 'arcSpine')).toHaveLength(4);
    const attempts = frames.filter((f) => f.type === 'resolve:round' || f.type === 'resolve:no-change');
    expect(attempts).toHaveLength(3);
    // Round 1 wrote the spine. `episodesEdited: 0` stays for existing readers,
    // but it is no longer the only thing the frame says.
    expect(attempts[0]).toMatchObject({
      type: 'resolve:round',
      scope: 'arcSpine',
      round: 1,
      applied: true,
      arcFieldsEdited: 1,
      volumesEdited: 2,
      episodesEdited: 0,
      noChangeReason: null,
    });
    expect(attempts[1]).toMatchObject({
      type: 'resolve:no-change',
      round: 2,
      applied: false,
      arcFieldsEdited: 0,
      volumesEdited: 0,
      episodesEdited: 0,
      rejectedExactEdits: 3,
      noChangeReason: 'exact-edits-rejected',
    });
    expect(attempts[2]).toMatchObject({
      type: 'resolve:no-change',
      round: 3,
      applied: false,
      rejectedExactEdits: 0,
      noChangeReason: 'no-edits-returned',
    });
    // Every frame stays numeric/enum — the diagnosis log must never carry
    // manuscript text or the resolver's own prose.
    for (const frame of attempts) {
      expect(frame).not.toHaveProperty('notes');
      expect(frame).not.toHaveProperty('findings');
    }
    // A round whose resolver wrote nothing re-uses its verification instead of
    // billing another arc + per-volume pass.
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(2);
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.pauseKind).toBe('divergence');
  });

  it('carries a rejected candidate\'s findings past its corrective retry into the next ordinary resolve', async () => {
    // The 2026-08-12 verifyArcSpine stall, replayed: 2 blockers → 1, a rewrite
    // back to 5 (reverted), the corrective retry back to 1, then straight back
    // to 2 with no retries left. The rejected set has to survive for the rest of
    // the gate, not just for the retry that immediately follows the rollback —
    // see `runDiscarded` in runArcVerify.
    const standing = { severity: 'high', problem: 'the succession vow is never paid off', location: 'V1' };
    const closed = { severity: 'high', problem: 'the choir loses its founding member offscreen', location: 'V2' };
    const collateral = (i) => ({ severity: 'high', problem: `collateral break ${i}`, location: `V${i + 3}` });
    const rejected = [standing, ...Array.from({ length: 4 }, (_, i) => collateral(i))];
    arcSpies.verifyArc.mockReset();
    [
      [standing, closed], // round 1 — resolve #1
      [standing],         // round 2 — real progress; resolve #2
      rejected,           // round 3 — regressed to 5, reverted, corrective retry (#3)
      [standing],         // round 4 — retry landed back on the checkpoint; resolve #4
      [],                 // round 5 — clean
    ].forEach((issues) => arcSpies.verifyArc.mockImplementationOnce(async () => ({ issues })));

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));

    // The corrective retry keeps its own rollback's evidence whole, as before.
    expect(arcSpies.resolveVerifyIssues.mock.calls[2][1]).toMatchObject({
      findings: [standing],
      avoid: rejected,
    });
    // …and so does the ORDINARY resolve that follows it, minus the one entry the
    // restored state still has as an active target — the resolver must never be
    // told to both fix and avoid the same finding.
    const ordinary = arcSpies.resolveVerifyIssues.mock.calls[3][1];
    expect(ordinary).toMatchObject({ findings: [standing] });
    expect(ordinary.avoid).toEqual(rejected.filter((f) => f !== standing));
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.pauseKind).not.toBe('regression');
  });

  it('hands a resumed resolver every rewrite the paused gate reverted, not just the last one', async () => {
    // Two DIFFERENT rewrites reverted before the pause. The marker's
    // `discardedFindings` is scoped to the round that was reverted last (the
    // panel renders it under that copy), so a resume that read only that field
    // let the resolver re-author the first rejected rewrite for free. The gate's
    // whole history rides `runDiscardedFindings` instead (#3829).
    const standing = { severity: 'high', problem: 'the succession vow is never paid off', location: 'V1' };
    const first = [
      { severity: 'high', problem: 'the coronation is moved off-page into a letter', location: 'V2' },
      { severity: 'high', problem: 'the regent loses her veto with no scene to spend it', location: 'V3' },
    ];
    const second = [
      { severity: 'high', problem: 'the siege ends in a timeskip nobody witnesses', location: 'V4' },
      { severity: 'high', problem: 'the heir swears a second, contradictory oath', location: 'V5' },
    ];
    arcSpies.verifyArc.mockReset();
    [
      [standing],             // round 1 — the checkpoint; resolve #1
      [standing, ...first],   // round 2 — regressed, reverted, corrective retry (#2)
      [standing, ...second],  // round 3 — regressed again, retries spent → pause
    ].forEach((issues) => arcSpies.verifyArc.mockImplementationOnce(async () => ({ issues })));

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));

    const paused = await seriesSvc.getSeries(seriesId);
    expect(paused.autopilot?.pauseKind).toBe('regression');
    // The panel's field keeps meaning "what the reverted round produced"…
    expect(paused.autopilot?.discardedFindings).toEqual([standing, ...second]);
    // …while the resume evidence carries both rewrites, newest first.
    expect(paused.autopilot?.runDiscardedFindings).toEqual([...second, standing, ...first]);

    // Resume: the gate clears, and its first resolve is told to avoid BOTH
    // rejected rewrites — minus `standing`, which it is being asked to fix.
    arcSpies.resolveVerifyIssues.mockClear();
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: [standing] }))
      .mockImplementationOnce(async () => ({ issues: [] }));
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));

    expect(arcSpies.resolveVerifyIssues.mock.calls[0][1]).toMatchObject({
      findings: [standing],
      avoid: [...second, ...first],
      spineOnly: true,
    });
  });

  it('honors maxArcResolveRetries: 0 by pausing on the first regression', async () => {
    // The pre-#3781 behavior stays reachable per run: no corrective pass, so the
    // first reverted candidate ends the gate without spending a second resolve.
    const holes = (n, prefix) => Array.from({ length: n }, (_, i) => ({
      severity: 'high', problem: `${prefix} ${i}`, location: `V${i + 1}`,
    }));
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: holes(3, 'initial') }))
      .mockImplementationOnce(async () => ({ issues: holes(6, 'regressed') }));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6, maxArcResolveRetries: 0 });
    await waitFor(runFinished(seriesId));

    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(2);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(1);
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.pauseKind).toBe('regression');
    expect(last?.residualFindings).toEqual(holes(3, 'initial'));
  });

  it('carries a paused arc regression\'s discarded findings into the resumed resolver', async () => {
    const residual = {
      severity: 'high', problem: 'the standing custody rule is contradictory', location: 'V1',
    };
    const discarded = [
      { severity: 'medium', problem: 'the rejected rewrite dropped a sacrifice beat', location: 'V1 issue 10' },
      { severity: 'medium', problem: 'the rejected rewrite dropped a consent choice', location: 'V1 issue 9' },
    ];
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: [residual] }))
      .mockImplementationOnce(async () => ({ issues: [] }));

    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, {
      autopilot: {
        status: 'paused',
        currentStep: 'verifyArcSpine',
        pauseKind: 'regression',
        residualFindings: [residual],
        discardedFindings: discarded,
      },
    });
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));

    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledWith(
      seriesId,
      expect.objectContaining({ findings: [residual], avoid: discarded, spineOnly: true }),
    );
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('does not tell a resumed resolver to avoid a discarded finding that is now its active target', async () => {
    const active = {
      severity: 'medium', problem: 'the sacrifice beat is missing from the volume', location: 'V1 issue 10',
    };
    const unrelated = {
      severity: 'medium', problem: 'the rejected rewrite dropped a consent choice', location: 'V1 issue 9',
    };
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: [active] }))
      .mockImplementationOnce(async () => ({ issues: [] }));

    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, {
      autopilot: {
        status: 'paused',
        currentStep: 'verifyArcSpine',
        pauseKind: 'regression',
        residualFindings: [],
        discardedFindings: [active, unrelated],
      },
    });
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));

    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledWith(
      seriesId,
      expect.objectContaining({ findings: [active], avoid: [unrelated], spineOnly: true }),
    );
  });

  it('reverts an equal-count arc candidate whose findings escalated in severity', async () => {
    const before = [
      { severity: 'high', problem: 'recovery clock is contradictory', location: 'V1 issues 8-9' },
      { severity: 'medium', problem: 'character milestone uses stale timing', location: 'V1 character arc' },
    ];
    const after = [
      { severity: 'high', problem: 'human machinery can open the living gate without consent', location: 'V1 issue 11' },
      { severity: 'high', problem: 'character milestone uses stale timing', location: 'V1 character arc' },
    ];
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: before }))
      .mockImplementationOnce(async () => ({ issues: after }));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {
      maxArcVerifyRounds: 6,
      maxArcResolveRetries: 0,
    });
    await waitFor(runFinished(seriesId));

    expect(arcSpies.restoreArcState).toHaveBeenCalledTimes(1);
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.pauseKind).toBe('regression');
    expect(last?.reason).toMatch(/same count but a worse severity mix/);
    expect(last?.residualFindings).toEqual(before);
    expect(last?.discardedFindings).toEqual(after);
  });

  it('reverts the same 1 → 3 → 5 divergence when each verify call re-words the finding', async () => {
    // Same incident as the test above, but replayed the way the verifier
    // actually behaves: round 2 restates the standing defect in fresh prose at a
    // re-labelled location, and round 3 does it again. Matching those on an
    // exact prose fingerprint read them as brand-new findings, so the guard
    // concluded the round had closed what it targeted, committed the damage, and
    // let the loop run on to a 5-finding divergence pause (the observed
    // `verify:round` 1/3/5 with two non-empty `resolve:round` frames between
    // them). It has to be reverted at round 2 here too.
    const restatements = [
      { severity: 'high', problem: 'volume 1 and volume 2 both stage the first eclipse', location: 'V1' },
      { severity: 'high', problem: 'the first eclipse is staged twice — once in each of the opening volumes', location: 'Volume 1 → Volume 2' },
      { severity: 'medium', problem: 'two separate volumes each present the eclipse as its first occurrence', location: 'Volume 2 opening' },
    ];
    const extra = (i) => ({ severity: 'high', problem: `collateral break ${i}`, location: `V${i + 3}` });
    const round = (n, idx) => ({
      issues: [restatements[idx], ...Array.from({ length: n - 1 }, (_, i) => extra(i))],
    });
    // beforeEach's clearAllMocks does NOT drain a queued `mockImplementationOnce`,
    // and the test above deliberately leaves its third round unconsumed — reset
    // (which restores the vi.fn default) so this run starts on round 1.
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc
      .mockImplementationOnce(async () => round(1, 0))
      .mockImplementationOnce(async () => round(3, 1))
      .mockImplementationOnce(async () => round(5, 2));
    // The round reports real work (the observed `resolve:round episodesEdited=1`)
    // — it edited episodes and STILL came back worse, which is the whole point.
    // The reported `idea` is the mutation manifest the rollback is restricted to.
    arcSpies.resolveVerifyIssues.mockImplementationOnce(async () => ({
      applied: true,
      episodesResolved: [{ issueId: 'i1', number: 1, idea: { input: 'rewritten', output: '', status: 'empty' } }],
    }));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));

    // Round 2's regression is reverted and retried once; round 3 regresses
    // again with no retries left, so rounds 4-6 are never billed.
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(3);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(2);
    // Rolled back with the round's own episode write attached, so the restore
    // puts that synopsis back and leaves every other episode alone.
    expect(arcSpies.restoreArcState).toHaveBeenCalledWith(
      seriesId,
      await arcSpies.snapshotArcState.mock.results[0].value,
      { episodeEdits: [{ issueId: 'i1', idea: { input: 'rewritten', output: '', status: 'empty' } }] },
    );
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.pauseKind).toBe('regression');
    // Paused on the ONE finding the user actually had, not the 5 it manufactured.
    expect(last?.residualFindings).toEqual([restatements[0]]);
  });

  it('rolls back blocker-count growth even when the resolver closed its targeted finding', async () => {
    // Finding identity is not a safe acceptance gate: a rewrite can close the
    // one finding it was handed while exposing two different blockers and still
    // leave the draft operationally worse. Preserve the demonstrated lower-count
    // state and let a human decide whether the latent trade is worthwhile.
    const first = { severity: 'high', problem: 'first eclipse staged twice', location: 'V1' };
    const latent = [
      { severity: 'high', problem: 'mentor subplot never pays off', location: 'V3' },
      { severity: 'high', problem: 'finale hook is unresolved', location: 'V4' },
    ];
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: [first] }))
      .mockImplementationOnce(async () => ({ issues: latent }))
      .mockImplementationOnce(async () => ({ issues: latent }));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));

    // The corrective pass gets the same two latent blockers back, so the gate
    // runs out of retries and pauses on the demonstrated single-blocker state.
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(3);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(2);
    expect(arcSpies.restoreArcState).toHaveBeenCalledWith(
      seriesId,
      await arcSpies.snapshotArcState.mock.results[0].value,
      { episodeEdits: [] },
    );
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.pauseKind).toBe('regression');
    expect(last?.residualFindings).toEqual([first]);
  });

  it('restores the best verified snapshot in a 4 → 2 → 4 regression', async () => {
    const holes = (n, prefix) => Array.from({ length: n }, (_, i) => ({
      severity: 'high', problem: `${prefix} ${i}`, location: `V${i + 1}`,
    }));
    const rounds = [holes(4, 'initial'), holes(2, 'best'), holes(4, 'regressed'), holes(5, 'retry regressed')];
    arcSpies.verifyArc.mockReset();
    rounds.forEach((result) => arcSpies.verifyArc.mockImplementationOnce(async () => ({ issues: result })));
    // Both isolation attempts come back worse than the 2-blocker checkpoint too,
    // so nothing is retained and the gate still pauses on the checkpoint (#3780).
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: holes(4, 'isolated 1') }))
      .mockImplementationOnce(async () => ({ issues: holes(4, 'isolated 2') }));
    const initialSnapshot = { marker: 'initial', arc: null, seasons: [], episodes: [] };
    const bestSnapshot = { marker: 'best', arc: null, seasons: [], episodes: [] };
    arcSpies.snapshotArcState
      .mockImplementationOnce(async () => initialSnapshot)
      .mockImplementationOnce(async () => bestSnapshot);

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 12 });
    await waitFor(runFinished(seriesId));

    // Round 3's increase rewinds to the 2-blocker checkpoint and spends the one
    // corrective pass; round 4 regresses again, so the gate splits the residual
    // and tries its two findings one at a time — both are rejected, so it stops.
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(6);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(5);
    // The isolation pass snapshots ONCE and holds it: a rejected attempt is
    // restored to exactly that state, so re-reading the series + every episode
    // to capture an identical snapshot would be pure I/O. Only an accepted patch
    // (none here) moves the store on and forces a fresh one. The corrective pass
    // still rewinds to the checkpoint it already holds.
    expect(arcSpies.snapshotArcState).toHaveBeenCalledTimes(3);
    expect(arcSpies.restoreArcState).toHaveBeenCalledWith(seriesId, bestSnapshot, { episodeEdits: [] });
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.pauseKind).toBe('regression');
    expect(last?.reason).toMatch(/best verified 2-finding state/);
    expect(last?.residualFindings).toEqual(rounds[1]);
    // Both sides of the trade are reported: the count guard is deliberately
    // blind to finding identity, so the rejected candidate's own findings ride
    // along for the human deciding whether the pause was worth it.
    expect(last?.discardedFindings).toEqual(rounds[3]);
    // The persisted marker must agree with the broadcast frame. These are two
    // separate writes off one payload, and a field that reaches only the live
    // stream vanishes on reload — which is when the user actually reviews it.
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.discardedFindings).toEqual(rounds[3]);
  });

  it('keeps an independently safe fix by isolating the residual one finding at a time (#3780)', async () => {
    // The 2026-08-11 verifyArcSpine stall: the gate reached a verified best of 2
    // blockers, then a normal resolve came back with 5 and the corrective retry
    // with 3. Both were rewrites of the WHOLE residual, so both were reverted
    // whole — and the run paused on 2 after 5 of 12 permitted rounds without
    // retaining a single fix. Now the spent corrective budget escalates to
    // per-finding isolation: each finding is resolved alone and kept only if it
    // closes itself without growing the set.
    const eclipse = { severity: 'high', problem: 'volume 1 and volume 2 both stage the first eclipse', location: 'V1' };
    const mentor = { severity: 'high', problem: 'mentor subplot never pays off', location: 'V3' };
    const finale = { severity: 'high', problem: 'finale hook contradicts prologue promise', location: 'V4' };
    const motive = { severity: 'high', problem: 'antagonist motive changes without cause', location: 'V5' };
    const siege = { severity: 'high', problem: 'timeline of the siege runs backwards', location: 'V6' };
    // Ordered log of what the gate actually billed, so the assertions below can
    // see that the round after the isolation pass skips its verify.
    const billed = [];
    arcSpies.verifyArc.mockReset();
    [
      [eclipse, mentor],                          // round 1 — the checkpoint
      [eclipse, mentor, finale],                  // round 2 — regressed, reverted + retried
      [eclipse, mentor, finale, motive],          // round 3 — regressed again, retries spent
      [mentor],                                   // isolate #1 (eclipse) — closed it, kept
      [mentor, siege],                            // isolate #2 (mentor) — still standing, reverted
      // Round 4 bills NO verify: nothing edited the plan between isolate #2's
      // revert and it, so the round reuses isolate #1's verification.
      [mentor],                                   // round 5 — after round 4's resolve
      [],                                         // round 6 — clean
    ].forEach((issues) => arcSpies.verifyArc.mockImplementationOnce(async () => {
      billed.push('verify');
      return { issues };
    }));
    for (let i = 0; i < 6; i += 1) {
      arcSpies.resolveVerifyIssues.mockImplementationOnce(async () => {
        billed.push('resolve');
        return { applied: true, runId: `arc-isolation-${i + 1}` };
      });
    }

    const { seriesId } = await seedComplete();
    const frames = [];
    const handler = (p) => frames.push(p);
    autopilot.autopilotEvents.on(seriesId, handler);
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));
    autopilot.autopilotEvents.off(seriesId, handler);

    // Each isolated attempt resolves exactly one finding, and carries the
    // rejected whole-set candidates' findings as the failure mode to avoid —
    // minus the two the restored checkpoint still has as active repair targets
    // for this pass (#3829). Telling the resolver to avoid `eclipse` while
    // handing it `eclipse` to fix is the contradiction the accumulator filters.
    expect(arcSpies.resolveVerifyIssues.mock.calls[2][1]).toMatchObject({
      findings: [eclipse],
      // Newest evidence first, so it is never the part trimmed at the bound.
      avoid: [motive, finale],
    });
    expect(arcSpies.resolveVerifyIssues.mock.calls[3][1]).toMatchObject({ findings: [mentor] });
    // The rejected attempt is reverted on its own — the kept one is not.
    const isolated = frames.filter((f) => f.type === 'resolve:isolate');
    expect(isolated).toHaveLength(2);
    expect(isolated[0]).toMatchObject({ scope: 'arcSpine', attempt: 1, before: 2, after: 1, kept: true });
    expect(isolated[1]).toMatchObject({ attempt: 2, before: 1, after: 2, kept: false });
    expect(recordModelOutcome).toHaveBeenCalledWith('arc-isolation-3', expect.objectContaining({
      outcome: 'accepted', scoreBefore: -2, scoreAfter: -1,
    }));
    expect(recordModelOutcome).toHaveBeenCalledWith('arc-isolation-4', expect.objectContaining({
      outcome: 'rejected', scoreBefore: -1, scoreAfter: -2,
    }));
    // Two whole-round rollbacks plus the one rejected isolated patch.
    expect(arcSpies.restoreArcState).toHaveBeenCalledTimes(3);
    // Round 3's verify, then the two isolated attempts (resolve→verify each),
    // then round 4's resolve with NO verify in front of it: nothing edited the
    // plan between isolate #2's revert and that round, so it re-uses the
    // verification isolate #1 already billed rather than buying the same answer
    // for another arc + per-volume call.
    expect(billed.slice(4, 11)).toEqual([
      'verify', 'resolve', 'verify', 'resolve', 'verify', 'resolve', 'verify',
    ]);
    // The rollback frame promises the retry the isolation pass is about to make,
    // so the user isn't told the gate is done when it has another move left.
    expect(frames.filter((f) => f.type === 'resolve:rollback').at(-1)).toMatchObject({ best: 2, retrying: true });
    // …and the gate clears from the isolated state instead of pausing on 2.
    expect(frames.some((f) => f.type === 'paused' && f.pauseKind === 'regression')).toBe(false);
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.pauseKind).not.toBe('regression');
  });

  it('banks an isolated patch\'s rejection so the next target in the same pass avoids it (#3829)', async () => {
    // The isolation pass used to compute `avoid` once for the whole pass and
    // throw its own rejections away, so a rewrite rejected on target 1 was free
    // to be re-proposed on target 2 — the gate paid a resolve + a verify to
    // learn something nothing downstream ever heard.
    const eclipse = { severity: 'high', problem: 'volume 1 and volume 2 both stage the first eclipse', location: 'V1' };
    const mentor = { severity: 'high', problem: 'mentor subplot never pays off', location: 'V3' };
    const finale = { severity: 'high', problem: 'finale hook contradicts prologue promise', location: 'V4' };
    const motive = { severity: 'high', problem: 'antagonist motive changes without cause', location: 'V5' };
    const siege = { severity: 'high', problem: 'timeline of the siege runs backwards', location: 'V6' };
    arcSpies.verifyArc.mockReset();
    [
      [eclipse, mentor],                         // round 1 — the checkpoint
      [eclipse, mentor, finale],                 // round 2 — regressed, reverted + retried
      [eclipse, mentor, finale, motive],         // round 3 — regressed again, retries spent
      [eclipse, mentor, siege],                  // isolate #1 (eclipse) — grew the set, reverted
      [eclipse],                                 // isolate #2 (mentor) — closed it, kept
      [],                                        // round 5 — clean
    ].forEach((issues) => arcSpies.verifyArc.mockImplementationOnce(async () => ({ issues })));

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));

    // Isolate #1 carries only what the two whole-set rollbacks discarded.
    expect(arcSpies.resolveVerifyIssues.mock.calls[2][1]).toMatchObject({
      findings: [eclipse], avoid: [motive, finale],
    });
    // Isolate #2 carries its predecessor's verified failure on top of those, and
    // still never sees a finding it is being asked to fix.
    expect(arcSpies.resolveVerifyIssues.mock.calls[3][1]).toMatchObject({
      findings: [mentor], avoid: [siege, motive, finale],
    });
  });

  it('spends no verification on an isolated candidate the resolver discarded before persistence', async () => {
    // Isolating the FINDING never isolated the EDIT: a single-finding response's
    // entries all name that finding, so the resolver could still rewrite the arc
    // and every volume — which is how each "isolated" attempt on 2026-08-12 grew
    // the blocker set from 2 to 4 and then to 7. The resolver now rejects an
    // over-broad candidate before writing anything, and this gate must read that
    // as a spent attempt with nothing to undo and nothing new to verify.
    const holes = (n, prefix) => Array.from({ length: n }, (_, i) => ({
      severity: 'high', problem: `${prefix} ${i}`, location: `V${i + 1}`,
    }));
    arcSpies.verifyArc.mockReset();
    [holes(2, 'best'), holes(4, 'regressed'), holes(4, 'regressed again')]
      .forEach((issues) => arcSpies.verifyArc.mockImplementationOnce(async () => ({ issues })));
    arcSpies.resolveVerifyIssues.mockReset();
    arcSpies.resolveVerifyIssues.mockImplementation(async (_seriesId, opts) => (opts?.isolated
      ? { applied: false, reason: 'it edits 3 records (the arc, volume 1, volume 2) — an isolated repair may change only one', runId: 'arc-isolated-reject' }
      : { applied: true, runId: 'arc-whole-set' }));

    const { seriesId } = await seedComplete();
    const frames = [];
    const handler = (p) => frames.push(p);
    autopilot.autopilotEvents.on(seriesId, handler);
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6, maxArcIsolationAttempts: 2 });
    await waitFor(runFinished(seriesId));
    autopilot.autopilotEvents.off(seriesId, handler);

    // Both isolated attempts ran in the constrained mode and were discarded
    // before persistence, so the gate bought no verification for either — three
    // verifies total, one per whole-set round.
    const isolatedCalls = arcSpies.resolveVerifyIssues.mock.calls.filter(([, o]) => o?.isolated);
    expect(isolatedCalls).toHaveLength(2);
    expect(isolatedCalls[0][1].findings).toHaveLength(1);
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(3);
    // Two whole-round rollbacks only — a candidate that never landed has nothing
    // to restore.
    expect(arcSpies.restoreArcState).toHaveBeenCalledTimes(2);
    const isolated = frames.filter((f) => f.type === 'resolve:isolate');
    expect(isolated).toHaveLength(2);
    expect(isolated[0]).toMatchObject({ kept: false, before: 2, after: 2, episodesEdited: 0 });
    expect(isolated[0].reason).toMatch(/edits 3 records/);
    // Nothing was retained, so the gate still pauses on the best verified state.
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.pauseKind).toBe('regression');
    expect(last?.residualFindings).toEqual(holes(2, 'best'));
  });

  it('does not isolate a single-finding residual (that is the corrective pass again)', async () => {
    // Isolating a one-finding residual re-issues the exact call the corrective
    // pass just made — same finding, same avoid list — so the gate pauses rather
    // than billing a resolve + a verify for it.
    const hole = { severity: 'high', problem: 'volume 1 and volume 2 both stage the first eclipse', location: 'V1' };
    const extra = (i) => ({ severity: 'high', problem: `collateral break ${i}`, location: `V${i + 2}` });
    arcSpies.verifyArc.mockReset();
    [1, 3, 5].forEach((n) => arcSpies.verifyArc.mockImplementationOnce(async () => ({
      issues: [hole, ...Array.from({ length: n - 1 }, (_, i) => extra(i))],
    })));

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));

    // Three verifies, two resolves — the initial pass and the corrective retry.
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(3);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(2);
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.pauseKind).toBe('regression');
  });

  it('honors maxArcResolveRetries: 0 as a full opt-out of isolation too', async () => {
    // The knob means "no corrective spend on a reverted round" — a run that set
    // it must not get the (larger) per-finding fan-out instead.
    const holes = (n, prefix) => Array.from({ length: n }, (_, i) => ({
      severity: 'high', problem: `${prefix} ${i}`, location: `V${i + 1}`,
    }));
    arcSpies.verifyArc.mockReset();
    arcSpies.verifyArc
      .mockImplementationOnce(async () => ({ issues: holes(2, 'initial') }))
      .mockImplementationOnce(async () => ({ issues: holes(4, 'regressed') }));

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6, maxArcResolveRetries: 0 });
    await waitFor(runFinished(seriesId));

    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(2);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(1);
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.pauseKind).toBe('regression');
    expect(last?.residualFindings).toEqual(holes(2, 'initial'));
  });

  it('a blocker increase reaches the regression guard even when it lands on the round cap', async () => {
    // Guard-ordering check: the regression branch is evaluated before the
    // maxRounds exit, so growth ON the final round still rolls back and reports
    // the trade rather than reporting a plain "ran out of rounds" pause. This is
    // also what makes the `!isNewBest` rewind at the bounded exits unreachable.
    const holes = (n, prefix) => Array.from({ length: n }, (_, i) => ({
      severity: 'high', problem: `${prefix} ${i}`, location: `V${i + 1}`,
    }));
    const rounds = [holes(2, 'best'), holes(3, 'worse')];
    arcSpies.verifyArc.mockReset();
    rounds.forEach((result) => arcSpies.verifyArc.mockImplementationOnce(async () => ({ issues: result })));
    const bestSnapshot = { marker: 'best', arc: null, seasons: [], episodes: [] };
    arcSpies.snapshotArcState.mockImplementationOnce(async () => bestSnapshot);

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));

    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.pauseKind).toBe('regression');
    expect(arcSpies.restoreArcState).toHaveBeenCalledWith(seriesId, bestSnapshot, { episodeEdits: [] });
    expect(last?.residualFindings).toEqual(rounds[0]);
    expect(last?.discardedFindings).toEqual(rounds[1]);
  });

  it('a default-cap arc run is unaffected by the divergence guard (maxRounds still wins)', async () => {
    // Default arc cap is 3; the divergence streak can't reach patience (2) before
    // the loop hits maxRounds at round 3, so a stalled default run still reports
    // `maxRounds`, not `divergence` — no behavior change for default runs.
    state.verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {}); // default MAX_ARC_VERIFY_ROUNDS = 3
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.pauseKind).toBe('maxRounds');
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(3);
    // Round 3 verified the latest equal-count draft, so keep it in place — and
    // with nothing rewound there is no discarded candidate to report.
    expect(arcSpies.restoreArcState).not.toHaveBeenCalled();
    expect(last?.discardedFindings).toEqual([]);
  });

  it('a per-run override beats the persisted maxArcVerifyRounds setting', async () => {
    state.verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    getSettings.mockImplementation(async () => ({ pipelineEditorialChecks: { maxArcVerifyRounds: 4 } }));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(1);
    expect(arcSpies.resolveVerifyIssues).not.toHaveBeenCalled();
  });
});
