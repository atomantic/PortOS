/**
 * state.test.js
 *
 * state.js event bus, progress fold and milestone map. Split from seriesAutopilot.test.js (#16214); shared mocks and
 * fixtures live in seriesAutopilot.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./seriesAutopilot.testFixtures.js'));
const { state, waitFor, seedComplete } = h;

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

// Real services + the unit under test (imported AFTER the mocks above).
const autopilot = await import('../seriesAutopilot.js');

const runFinished = (sId) => () => autopilot.__testing.runs.get(sId)?.finished === true;

beforeEach(() => {
  h.resetFixtures({ autopilot, getDomainBudgetStatus, getSettings });
});

describe('autopilotEvents in-process bus (#2185)', () => {
  it('mirrors the SSE frames a real run broadcasts onto the bus keyed by seriesId', async () => {
    state.cosMode = 'dry-run';
    const { seriesId } = await seedComplete();
    const frames = [];
    const handler = (p) => frames.push(p);
    autopilot.autopilotEvents.on(seriesId, handler);
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    autopilot.autopilotEvents.off(seriesId, handler);
    // The bus received the same terminal frame the SSE client sees (lastPayload).
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(frames).toContainEqual(last);
    expect(frames.some((f) => f.type === 'start')).toBe(true);
    expect(frames.some((f) => f.type === 'complete')).toBe(true);
  });

  it('exposes the terminal frame types a server-side consumer settles on', () => {
    expect([...autopilot.AUTOPILOT_TERMINAL_TYPES]).toEqual(['complete', 'paused', 'canceled', 'error']);
  });
});

// ---------------------------------------------------------------------------
// Milestone map — the plan an EXECUTE run projects + the progress
// snapshot the panel measures against it.
// ---------------------------------------------------------------------------
describe('noteProgress (pure fold)', () => {
  const { noteProgress, emptyProgress } = autopilot;

  it('marks the running step and clears its complete flag when the run RE-ENTERS a gate', () => {
    const run = { progress: emptyProgress() };
    noteProgress(run, { type: 'step:start', kind: 'foundationGate', ordinal: 3 });
    noteProgress(run, { type: 'step:complete', kind: 'foundationGate' });
    expect(run.progress).toMatchObject({
      currentStep: 'foundationGate', currentStepComplete: true, completed: { foundationGate: 1 },
    });
    // The arc repair sends it back through the same gate — the map must show it
    // working again rather than reading as the step it just finished.
    noteProgress(run, { type: 'step:start', kind: 'foundationGate', ordinal: 5 });
    expect(run.progress).toMatchObject({ currentStep: 'foundationGate', currentStepComplete: false });
  });

  it('files each gate verification under the step it was measured in', () => {
    const run = { progress: emptyProgress() };
    noteProgress(run, { type: 'step:start', kind: 'verifyArcSpine' });
    noteProgress(run, { type: 'verify:round', scope: 'arcSpine', round: 2, findings: 5, blocking: 0 });
    noteProgress(run, { type: 'step:start', kind: 'foundationGate' });
    noteProgress(run, { type: 'foundation:round', round: 1, weightedScore: 8.1, threshold: 7.5, weakest: 'craft' });
    expect(run.progress.verified).toEqual({
      verifyArcSpine: { round: 2, findings: 5, blocking: 0 },
      foundationGate: { round: 1, weightedScore: 8.1, threshold: 7.5, weakest: 'craft' },
    });
  });

  it('drops gate telemetry that arrives outside a step rather than filing it nowhere', () => {
    const run = { progress: emptyProgress() };
    expect(noteProgress(run, { type: 'verify:round', scope: 'arc', findings: 1, blocking: 1 })).toBe(false);
    expect(run.progress.verified).toEqual({});
  });

  it('counts sub-step skips without advancing the milestone', () => {
    const run = { progress: emptyProgress() };
    noteProgress(run, { type: 'step:skip', kind: 'visualDraft', reason: 'locked' });
    expect(run.progress).toMatchObject({ skipped: { visualDraft: 1 }, completed: {} });
  });

  it('ignores frames the map does not track — including every terminal', () => {
    const run = { progress: emptyProgress() };
    for (const type of ['note', 'check:complete', 'complete', 'paused', 'canceled', 'error']) {
      expect(noteProgress(run, { type })).toBe(false);
    }
    expect(run.progress).toEqual(emptyProgress());
  });
});

describe('milestone map telemetry', () => {
  const collectFrames = (seriesId) => {
    const frames = [];
    autopilot.autopilotEvents.on(seriesId, (p) => frames.push(p));
    return frames;
  };

  it('carries the projected plan on an EXECUTE start frame, not only a dry-run', async () => {
    const { seriesId } = await seedComplete();
    const frames = collectFrames(seriesId);
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    const start = frames.find((f) => f.type === 'start');
    expect(start.mode).toBe('execute');
    // Same projection the dry-run emits — the panel draws it as the milestone map.
    expect(start.plan.map((p) => p.kind)).toEqual(
      expect.arrayContaining(['verifyArcSpine', 'verifyArc', 'pilotReview']),
    );
    expect(start.planTotals.estActions).toBeGreaterThan(0);
  });

  it('publishes a progress snapshot as the run advances', async () => {
    const { seriesId } = await seedComplete();
    const frames = collectFrames(seriesId);
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    const progressFrames = frames.filter((f) => f.type === 'progress');
    expect(progressFrames.length).toBeGreaterThan(0);
    const final = progressFrames.at(-1);
    expect(final.completed.verifyArcSpine).toBe(1);
    expect(final.completed.pilotReview).toBe(1);
    // …and what each gate actually validated, keyed by step kind.
    expect(final.verified.verifyArcSpine).toMatchObject({ blocking: 0 });
  });

  it('publishes DETACHED snapshots — a later step cannot rewrite a delivered frame', async () => {
    const { seriesId } = await seedComplete();
    const frames = collectFrames(seriesId);
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    const progressFrames = frames.filter((f) => f.type === 'progress');
    const first = progressFrames[0];
    const last = progressFrames.at(-1);
    // The fold mutates the maps it owns; if the frames shared them, the first
    // frame would report the final run's counts and the map would jump.
    expect(first.completed).not.toBe(last.completed);
    expect(Object.keys(first.completed).length).toBeLessThan(Object.keys(last.completed).length);
  });

  it('never emits a progress frame after the terminal one (SSE replays only the last payload)', async () => {
    const { seriesId } = await seedComplete();
    const frames = collectFrames(seriesId);
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    const terminalAt = frames.findIndex((f) => autopilot.AUTOPILOT_TERMINAL_TYPES.has(f.type));
    expect(terminalAt).toBeGreaterThan(-1);
    expect(frames.slice(terminalAt + 1).some((f) => f.type === 'progress')).toBe(false);
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('does not let a progress frame take the SSE replay slot from a real frame', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    // A client attaching late replays `lastPayload`; a snapshot there would hide
    // what the run was doing (and, at the end, that it finished at all).
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).not.toBe('progress');
  });

  it('serves the snapshot to a client attaching mid-run, and nothing once the run is over', async () => {
    const { seriesId } = await seedComplete();
    let midRun = null;
    // Sample the accessor from inside the run — the mid-run attach the status
    // route serves — rather than after it, when the record is finished.
    autopilot.autopilotEvents.on(seriesId, (f) => {
      if (f.type === 'step:complete' && !midRun) midRun = autopilot.activeRunProgress(seriesId);
    });
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(midRun.currentStep).toBeTruthy();
    expect(autopilot.activeRunProgress(seriesId)).toBe(null);
  });
});
