/**
 * stepResolver.test.js
 *
 * stepResolver.js pure next-step resolution. Split from seriesAutopilot.test.js (#16214); shared mocks and
 * fixtures live in seriesAutopilot.testFixtures.js.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SERIES_AUTOPILOT_DEFAULTS } from '../../../lib/seriesAutopilotDefaults.js';

// vi.mock factories are hoisted above imports; the shared fixtures module is
// loaded the same way.
const h = await vi.hoisted(() => import('./seriesAutopilot.testFixtures.js'));
const { VALID_SCRIPT, ready } = h;

vi.mock('../../runner.js', (importOriginal) => h.runnerFactory(importOriginal));
vi.mock('../../../lib/fileUtils.js', () => h.fileUtilsFactory());
vi.mock('crypto', () => h.cryptoFactory());
vi.mock('../../instanceIdentity.js', () => h.instanceIdentityFactory());
vi.mock('../../instances.js', () => h.instancesFactory());
vi.mock('../../sharing/peerSync.js', () => h.peerSyncFactory());
vi.mock('../../cosState.js', () => h.cosStateFactory());
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
vi.mock('../../cosTaskStore.js', () => h.cosTaskStoreFactory());
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
const { resolveNextStep, requiredScriptStages, scriptStructurallyReady, visualReady, wantsComic } = autopilot;

beforeEach(() => {
  h.resetFixtures({ autopilot, getDomainBudgetStatus, getSettings });
});

describe('resolveNextStep (pure)', () => {
  const comic = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
  const issue = (over = {}) => ({ id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {}, ...over });

  it('asks for arc generation when there is no arc', () => {
    const bare = { targetFormat: 'comic', seasons: [] };
    expect(resolveNextStep(bare, []).kind).toBe('characterFoundation');
    expect(resolveNextStep(bare, [], { characterFoundationEstablished: true }).kind).toBe('generateArc');
  });

  it('treats a present arc summary (no logline) as having an arc', () => {
    const step = resolveNextStep(
      { targetFormat: 'comic', arc: { summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] },
      [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }],
    );
    expect(step.kind).not.toBe('generateArc');
  });

  it('resolveAutopilotRounds: per-run option wins, else setting, else default', () => {
    const { resolveAutopilotRounds, MAX_ARC_VERIFY_ROUNDS, MAX_EDITORIAL_ROUNDS, MAX_BEAT_CONTINUITY_ROUNDS, MAX_FOUNDATION_ROUNDS } = autopilot;
    // per-run option wins (including an explicit 0 = skip)
    expect(resolveAutopilotRounds(
      { maxArcVerifyRounds: 7, maxEditorialRounds: 0, maxBeatContinuityRounds: 5, maxFoundationRounds: 2 },
      { pipelineEditorialChecks: { maxArcVerifyRounds: 4, maxEditorialRounds: 4, maxBeatContinuityRounds: 1, maxFoundationRounds: 1 } },
    )).toEqual({ maxArcVerifyRounds: 7, maxEditorialRounds: 0, maxBeatContinuityRounds: 5, maxFoundationRounds: 2 });
    // persisted setting fills in when no per-run override
    const fromSetting = resolveAutopilotRounds({}, { pipelineEditorialChecks: { maxArcVerifyRounds: 6, maxBeatContinuityRounds: 3 } });
    expect(fromSetting.maxArcVerifyRounds).toBe(6);
    expect(fromSetting.maxEditorialRounds).toBe(MAX_EDITORIAL_ROUNDS);
    expect(fromSetting.maxBeatContinuityRounds).toBe(3);
    // module default when neither is set
    expect(resolveAutopilotRounds({}, null)).toEqual({
      maxArcVerifyRounds: MAX_ARC_VERIFY_ROUNDS, maxEditorialRounds: MAX_EDITORIAL_ROUNDS, maxBeatContinuityRounds: MAX_BEAT_CONTINUITY_ROUNDS, maxFoundationRounds: MAX_FOUNDATION_ROUNDS,
    });
    // a non-integer at any layer falls through
    expect(resolveAutopilotRounds(
      { maxArcVerifyRounds: 2.5 },
      { pipelineEditorialChecks: { maxArcVerifyRounds: 'x' } },
    ).maxArcVerifyRounds).toBe(MAX_ARC_VERIFY_ROUNDS);
  });

  it('uses the shared defaults when run options and saved settings are absent', () => {
    const defaults = SERIES_AUTOPILOT_DEFAULTS;
    expect(autopilot.resolveAutopilotRounds({}, {})).toEqual({
      maxArcVerifyRounds: defaults.maxArcVerifyRounds,
      maxEditorialRounds: defaults.maxEditorialRounds,
      maxBeatContinuityRounds: defaults.maxBeatContinuityRounds,
      maxFoundationRounds: defaults.maxFoundationRounds,
    });
    expect(autopilot.resolveAutopilotFoundationGate({}, {})).toBe(defaults.foundationGate);
    expect(autopilot.resolveAutopilotCheckPauseThreshold({}, {})).toBe(defaults.checkFindingsPauseThreshold);
    expect(autopilot.resolveAutopilotNotifyOnPause({}, {})).toBe(defaults.notifyOnPause);
    expect(autopilot.resolveAutopilotRevision({}, {})).toEqual({
      revisionEnabled: defaults.revisionEnabled,
      revisionMinCycles: defaults.revisionMinCycles,
      revisionMaxCycles: defaults.revisionMaxCycles,
      revisionPlateauDelta: defaults.revisionPlateauDelta,
    });
    expect(autopilot.resolveAutopilotSelfImprove({}, {})).toBe(defaults.selfImprove);
    expect(autopilot.resolveAutopilotObserver({}, {})).toBe(defaults.observer);
    expect(autopilot.resolveAutopilotAutoSelectModels({}, {})).toBe(defaults.autoSelectModels);
    expect(autopilot.resolveAutopilotOverrideStagePins({}, {})).toBe(defaults.overrideStagePins);
  });

  it('resolveAutopilotReadinessGate: per-run option wins, else setting, else null (#1580)', () => {
    const { resolveAutopilotReadinessGate } = autopilot;
    // per-run override wins over a persisted setting
    expect(resolveAutopilotReadinessGate(
      { readinessGate: 'none' },
      { pipelineEditorialChecks: { readinessGate: 'noOpenHighOrMedium' } },
    )).toBe('none');
    // persisted setting fills in when no per-run override
    expect(resolveAutopilotReadinessGate({}, { pipelineEditorialChecks: { readinessGate: 'noOpenHighOrMedium' } }))
      .toBe('noOpenHighOrMedium');
    // null when neither is set — the caller resolves null to the default gate
    expect(resolveAutopilotReadinessGate({}, null)).toBeNull();
    // an invalid per-run gate falls through to the persisted setting
    expect(resolveAutopilotReadinessGate(
      { readinessGate: 'bogus' },
      { pipelineEditorialChecks: { readinessGate: 'none' } },
    )).toBe('none');
  });

  it('resolveAutopilotCheckPauseThreshold: per-run option wins, else setting, else 0/off (#1613)', () => {
    const { resolveAutopilotCheckPauseThreshold, DEFAULT_CHECK_FINDINGS_PAUSE_THRESHOLD } = autopilot;
    expect(DEFAULT_CHECK_FINDINGS_PAUSE_THRESHOLD).toBe(0);
    // per-run override wins (including an explicit 0 = off)
    expect(resolveAutopilotCheckPauseThreshold(
      { checkFindingsPauseThreshold: 0 },
      { pipelineEditorialChecks: { checkFindingsPauseThreshold: 5 } },
    )).toBe(0);
    expect(resolveAutopilotCheckPauseThreshold(
      { checkFindingsPauseThreshold: 8 },
      { pipelineEditorialChecks: { checkFindingsPauseThreshold: 5 } },
    )).toBe(8);
    // persisted setting fills in when no per-run override
    expect(resolveAutopilotCheckPauseThreshold({}, { pipelineEditorialChecks: { checkFindingsPauseThreshold: 5 } })).toBe(5);
    // 0/off when neither is set
    expect(resolveAutopilotCheckPauseThreshold({}, null)).toBe(0);
    // a non-integer at any layer falls through to the next
    expect(resolveAutopilotCheckPauseThreshold(
      { checkFindingsPauseThreshold: 2.5 },
      { pipelineEditorialChecks: { checkFindingsPauseThreshold: 'x' } },
    )).toBe(0);
  });

  it('resolveAutopilotNotifyOnPause: per-run option wins, else setting, else true/on (#1615)', () => {
    const { resolveAutopilotNotifyOnPause, DEFAULT_NOTIFY_ON_PAUSE } = autopilot;
    expect(DEFAULT_NOTIFY_ON_PAUSE).toBe(true);
    // per-run override wins (including an explicit false = silence)
    expect(resolveAutopilotNotifyOnPause(
      { notifyOnPause: false },
      { pipelineEditorialChecks: { notifyOnPause: true } },
    )).toBe(false);
    expect(resolveAutopilotNotifyOnPause(
      { notifyOnPause: true },
      { pipelineEditorialChecks: { notifyOnPause: false } },
    )).toBe(true);
    // persisted setting fills in when no per-run override
    expect(resolveAutopilotNotifyOnPause({}, { pipelineEditorialChecks: { notifyOnPause: false } })).toBe(false);
    // on by default when neither is set (the one opt-OUT autopilot gate)
    expect(resolveAutopilotNotifyOnPause({}, null)).toBe(true);
    // a non-boolean at any layer falls through to the next
    expect(resolveAutopilotNotifyOnPause(
      { notifyOnPause: 'yes' },
      { pipelineEditorialChecks: { notifyOnPause: 1 } },
    )).toBe(true);
  });

  it('regenerates the arc for an arc-only series with no volumes', () => {
    const arcOnly = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [] };
    expect(resolveNextStep(arcOnly, []).kind).toBe('characterFoundation');
    expect(resolveNextStep(arcOnly, [], { characterFoundationEstablished: true }).kind).toBe('generateArc');
    // once arc generation has been attempted, it does not re-loop into generateArc
    expect(resolveNextStep(arcOnly, [], { arcAttempted: true }).kind).not.toBe('generateArc');
  });

  it('repairs duplicate volume numbers before generating episodes for empty duplicates', () => {
    const duplicate = {
      targetFormat: 'comic', arc: { logline: 'L', summary: 'S' },
      seasons: [{ id: 'se1', number: 1 }, { id: 'dup1', number: 1 }, { id: 'dup2', number: 1 }],
    };
    const step = resolveNextStep(duplicate, [
      { id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} },
    ]);
    expect(step.kind).toBe('repairArcStructure');
  });

  it('dry-run previews duplicate-volume repair without charging episode generation for absorbed records', () => {
    const duplicate = {
      targetFormat: 'comic', arc: { logline: 'L', summary: 'S' },
      // A lock makes the empty first record the survivor; the issue-bearing
      // duplicate is absorbed and its issue must be projected onto that survivor.
      seasons: [{ id: 'se1', number: 1, locked: true }, { id: 'dup1', number: 1 }],
    };
    const plan = autopilot.__testing.buildDryRunPlan(duplicate, [
      { id: 'i1', seasonId: 'dup1', number: 1, arcPosition: 1, stages: {} },
    ], {});
    expect(plan[0]).toMatchObject({ kind: 'repairArcStructure', estActions: 0 });
    expect(plan.some((entry) => entry.kind === 'generateEpisodes')).toBe(false);
  });

  it('dry-run plan includes generateArc for an arc-only series (parity with execute)', () => {
    const plan = autopilot.__testing.buildDryRunPlan(
      { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [] }, [], {},
    );
    expect(plan.slice(0, 2).map((step) => step.kind)).toEqual(['characterFoundation', 'generateArc']);
  });

  it('dry-run plan omits editorialChecks + editorialHealthGate when editorial rounds are 0', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const kinds = (opts) => autopilot.__testing.buildDryRunPlan(series, issues, opts).map((p) => p.kind);
    // With editorial enabled (default), the reverse-outline refresh (#1349), both
    // registry checks + health gate appear.
    expect(kinds({})).toEqual(expect.arrayContaining(['pilotReview', 'reverseOutline', 'editorialChecks', 'editorialHealthGate']));
    // The reverse-outline refresh is enumerated BEFORE the editorial checks it feeds.
    const defaultKinds = kinds({});
    expect(defaultKinds.indexOf('reverseOutline')).toBeLessThan(defaultKinds.indexOf('editorialChecks'));
    // With maxEditorialRounds:0, execute mode skips the whole editorial gate — the
    // plan must omit the reverse-outline refresh and both checks too.
    const skipped = kinds({ maxEditorialRounds: 0 });
    expect(skipped).toContain('editorialReview'); // shown as "skipped (0 rounds)"
    expect(skipped).not.toContain('reverseOutline');
    expect(skipped).not.toContain('editorialChecks');
    expect(skipped).not.toContain('editorialHealthGate');
  });

  it('dry-run plan annotates the editorial-checks step with a per-run subset (#1575)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const noteFor = (opts) => autopilot.__testing.buildDryRunPlan(series, issues, opts)
      .find((p) => p.kind === 'editorialChecks')?.note;
    // No subset → the plan advertises the full enabled set.
    expect(noteFor({})).toMatch(/enabled editorial checks/);
    // A subset → the plan says how many checks will run instead of implying all.
    expect(noteFor({ editorialCheckIds: ['pacing', 'continuity'] })).toMatch(/subset of 2 editorial check/);
    // An empty array is treated as "no override" — back to the full set.
    expect(noteFor({ editorialCheckIds: [] })).toMatch(/enabled editorial checks/);
  });

  it('annotates every dry-run step with an estActions estimate (#1576)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [
      { id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} },
      { id: 'i2', seasonId: 'se1', number: 2, arcPosition: 2, stages: {} },
    ];
    const plan = autopilot.__testing.buildDryRunPlan(series, issues, {});
    // Every step carries a numeric estimate.
    expect(plan.every((p) => Number.isFinite(p.estActions))).toBe(true);
    const byKind = Object.fromEntries(plan.map((p) => [p.kind, p]));
    // verifyArc: each round checks the whole arc + one volume, then resolves
    // between rounds → 3*(1+1)+2 = 8 — plus the per-finding isolation pass the
    // gate can escalate to inside a round (#3780): an attempt costs a resolve +
    // an arc verify + one volume verify = 3, so the 8-call budget buys 2 → +6.
    expect(byKind.verifyArc.estActions).toBe(14);
    // textStages: one child action per not-yet-text-ready issue (2 here).
    expect(byKind.pilotDraft.estActions).toBe(1);
    expect(byKind.textStages.estActions).toBe(1);
    // Pure-gate steps that bill nothing against the cap are zero-cost.
    expect(byKind.editorialHealthGate.estActions).toBe(0);
  });

  it('scales verify/editorial estActions with the per-run round caps (#1576)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const actionsFor = (opts, kind) => autopilot.__testing.buildDryRunPlan(series, issues, opts)
      .find((p) => p.kind === kind)?.estActions;
    // 0 rounds → the loop is skipped → 0 actions.
    expect(actionsFor({ maxArcVerifyRounds: 0 }, 'verifyArc')).toBe(0);
    // 1 round → whole-arc + one-volume verify, no resolve → 2 actions. Isolation
    // needs a second round to verify what it kept, so it projects nothing here.
    expect(actionsFor({ maxArcVerifyRounds: 1 }, 'verifyArc')).toBe(2);
    // 4 rounds → 4 arc verifies + 4 volume verifies + 3 resolves → 11, plus the
    // isolation pass's 2 attempts × 3 calls (#3780) → 17.
    expect(actionsFor({ maxArcVerifyRounds: 4 }, 'verifyArc')).toBe(17);
    // …and a run that declined it gets the round-based estimate back.
    expect(actionsFor({ maxArcVerifyRounds: 4, maxArcIsolationAttempts: 0 }, 'verifyArc')).toBe(11);
    expect(actionsFor({ maxArcVerifyRounds: 4, maxArcResolveRetries: 0 }, 'verifyArc')).toBe(11);
    // Editorial review follows the same convergence shape.
    expect(actionsFor({ maxEditorialRounds: 2 }, 'pilotReview')).toBe(3);
  });

  it('estimates editorialChecks LLM fan-out as issues × enabled LLM checks (#1576)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [
      { id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} },
      { id: 'i2', seasonId: 'se1', number: 2, arcPosition: 2, stages: {} },
      { id: 'i3', seasonId: 'se1', number: 3, arcPosition: 3, stages: {} },
    ];
    const stepFor = (ctx) => autopilot.__testing.buildDryRunPlan(series, issues, {}, ctx)
      .find((p) => p.kind === 'editorialChecks');
    // 2 enabled LLM checks × 3 issues = 6 LLM calls; the pass bills 1 cos action.
    const two = stepFor({ editorialLlmCheckCount: 2 });
    expect(two.estLlmCalls).toBe(6);
    expect(two.estActions).toBe(1);
    expect(two.note).toMatch(/~6 LLM call/);
    // No enabled LLM check → no cos action billed and no LLM calls.
    const none = stepFor({ editorialLlmCheckCount: 0 });
    expect(none.estActions).toBe(0);
    expect(none.estLlmCalls).toBe(0);
  });

  it('summarizePlanCost totals estActions and estLlmCalls across the plan (#1576)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const plan = autopilot.__testing.buildDryRunPlan(series, issues, {}, { editorialLlmCheckCount: 3 });
    const totals = autopilot.__testing.summarizePlanCost(plan);
    const manualActions = plan.reduce((s, p) => s + (p.estActions || 0), 0);
    const manualLlm = plan.reduce((s, p) => s + (p.estLlmCalls || 0), 0);
    expect(totals.estActions).toBe(manualActions);
    expect(totals.estLlmCalls).toBe(manualLlm);
    // Single issue × 3 LLM checks → 3 editorial-check LLM calls in the total.
    expect(totals.estLlmCalls).toBe(3);
    // A non-array (defensive) summarizes to zeroes.
    expect(autopilot.__testing.summarizePlanCost(null)).toEqual({ estActions: 0, estLlmCalls: 0 });
  });

  it('dry-run plan surfaces the effective readiness gate on the health-gate step (#1580)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const gateNote = (opts) => autopilot.__testing.buildDryRunPlan(series, issues, opts)
      .find((p) => p.kind === 'editorialHealthGate')?.note;
    // No override → the plan shows the default gate.
    expect(gateNote({})).toMatch(/gate: noOpenHigh$/);
    // A per-run override is reflected in the plan note.
    expect(gateNote({ readinessGate: 'none' })).toMatch(/gate: none$/);
    expect(gateNote({ readinessGate: 'noOpenHighOrMedium' })).toMatch(/gate: noOpenHighOrMedium$/);
    // An invalid gate falls through to the default.
    expect(gateNote({ readinessGate: 'bogus' })).toMatch(/gate: noOpenHigh$/);
  });

  it('dry-run plan annotates the editorial-checks step with the pause threshold when armed (#1613)', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const noteFor = (opts) => autopilot.__testing.buildDryRunPlan(series, issues, opts)
      .find((p) => p.kind === 'editorialChecks')?.note;
    // Off (default / 0) → no pause annotation.
    expect(noteFor({})).not.toMatch(/pauses at/);
    expect(noteFor({ checkFindingsPauseThreshold: 0 })).not.toMatch(/pauses at/);
    // Armed → the threshold is surfaced in the note.
    expect(noteFor({ checkFindingsPauseThreshold: 5 })).toMatch(/pauses at ≥ 5 high finding/);
  });

  it('asks to generate episodes for a season with no issues', () => {
    const step = resolveNextStep(comic, [], { arcSpineVerified: true });
    expect(step).toMatchObject({ kind: 'generateEpisodes', seasonId: 'se1' });
  });

  it('checks the arc spine before foundation evaluation or drafting', () => {
    const step = resolveNextStep(comic, [issue()]);
    expect(step.kind).toBe('verifyArcSpine');
  });

  it('runs arc verification after the foundation gate, before beats (#2176)', () => {
    const step = resolveNextStep(comic, [issue()], { arcSpineVerified: true, foundationGated: true });
    expect(step.kind).toBe('verifyArc');
  });

  it('skips the foundation gate when disabled via options (#2176)', () => {
    const step = resolveNextStep(comic, [issue()], { arcVerified: true }, { foundationGate: false });
    expect(step).toMatchObject({ kind: 'beatSheet', seasonId: 'se1' });
  });

  it('skips the foundation gate when maxFoundationRounds is 0 (#2176)', () => {
    const step = resolveNextStep(comic, [issue()], { arcVerified: true }, { maxFoundationRounds: 0 });
    expect(step).toMatchObject({ kind: 'beatSheet', seasonId: 'se1' });
  });

  it('asks for beat sheets when an issue has no idea (post-verify)', () => {
    const step = resolveNextStep(comic, [issue()], { arcVerified: true, foundationGated: true });
    expect(step).toMatchObject({ kind: 'beatSheet', seasonId: 'se1' });
  });

  it('skips a season already attempted for beats (no infinite loop)', () => {
    const step = resolveNextStep(comic, [issue()], { arcVerified: true, foundationGated: true, beatsAttempted: new Set(['se1']) });
    // beats skipped → falls through to text stages
    expect(step).toMatchObject({ kind: 'pilotDraft', issueId: 'iss1' });
  });

  it('runs whole-manuscript beat continuity once beats exist, before text (#1510)', () => {
    const step = resolveNextStep(comic, [issue({ stages: { idea: ready() } })], { arcVerified: true, foundationGated: true });
    expect(step).toMatchObject({ kind: 'beatContinuity' });
  });

  it('skips beat continuity for a synopsis-only run (no beats anywhere)', () => {
    // idea has input (synopsis) but no ready output → no beats → fall through to
    // text without a beat-continuity pass (it would just duplicate arc verify).
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: { status: 'empty', input: 'syn', output: '' }, comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true },
    );
    expect(step.kind).not.toBe('beatContinuity');
  });

  it('asks for text stages once beats are continuity-checked but scripts do not exist', () => {
    const step = resolveNextStep(comic, [issue({ stages: { idea: ready() } })], { arcVerified: true, foundationGated: true, beatContinuityChecked: true });
    expect(step).toMatchObject({ kind: 'pilotDraft', issueId: 'iss1' });
  });

  it('asks for structural script verify once comic script is ready', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true },
    );
    expect(step).toMatchObject({ kind: 'scriptVerify', issueId: 'iss1' });
  });

  it('asks for editorial review once all issues are script-checked', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']) },
    );
    expect(step.kind).toBe('editorialReview');
  });

  it('refreshes the reverse outline after editorial review, before editorial checks (#1349)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('reverseOutline');
  });

  it('asks for editorial checks once the reverse outline is refreshed (#1349)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('editorialChecks');
  });

  it('runs the editorial health gate after both editorial passes (#1316)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('editorialHealthGate');
  });

  it('is done once the editorial health gate is clean (no visuals requested)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('done');
  });

  it('is done (no canon/visual) when target is text, even on a comic series', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: true, target: 'text' },
    );
    expect(step.kind).toBe('done');
  });

  it('asks for canon verify before visuals when includeVisual', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: true },
    );
    expect(step.kind).toBe('canonVerify');
  });

  it('asks for visual draft once canon is verified and pages are not rendered', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true },
      { includeVisual: true },
    );
    expect(step).toMatchObject({ kind: 'visualDraft', issueId: 'iss1' });
  });

  it('is done when visuals are already rendered', () => {
    const renderedStages = {
      idea: ready(),
      comicScript: ready(VALID_SCRIPT),
      comicPages: {
        cover: { proofImage: { jobId: 'j' } },
        backCover: { proofImage: { jobId: 'jb' } },
        pages: [{ panels: [{ description: 'x' }], proofImage: { jobId: 'p0' } }],
      },
    };
    const step = resolveNextStep(
      comic,
      [issue({ stages: renderedStages })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true },
      { includeVisual: true },
    );
    expect(step.kind).toBe('done');
  });

  it('does not run script verify for a tv-only target', () => {
    const tv = { targetFormat: 'tv', arc: { logline: 'L' }, seasons: [{ id: 'se1', number: 1 }] };
    const step = resolveNextStep(
      tv,
      [issue({ stages: { idea: ready(), teleplay: ready() } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true },
    );
    expect(step.kind).toBe('pilotReview');
  });

  // CDO Phase 3 (#2185) — the opt-in teaser deliverable is the LAST step, after
  // visuals are drafted, and only when produceTeaser is on.
  const rendered = {
    idea: ready(),
    comicScript: ready(VALID_SCRIPT),
    comicPages: {
      cover: { proofImage: { jobId: 'j' } },
      backCover: { proofImage: { jobId: 'jb' } },
      pages: [{ panels: [{ description: 'x' }], proofImage: { jobId: 'p0' } }],
    },
  };
  const fullyReady = { arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true };

  it('does NOT ask for a teaser by default (produceTeaser off) — stays done', () => {
    const step = resolveNextStep(comic, [issue({ stages: rendered })], fullyReady, { includeVisual: true });
    expect(step.kind).toBe('done');
  });

  it('asks for a teaser once visuals are drafted and produceTeaser is on', () => {
    const step = resolveNextStep(comic, [issue({ stages: rendered })], fullyReady, { includeVisual: true, produceTeaser: true });
    expect(step).toMatchObject({ kind: 'produceTeaser', issueId: 'iss1' });
  });

  it('is done once the teaser has been produced this run', () => {
    const step = resolveNextStep(comic, [issue({ stages: rendered })], { ...fullyReady, teaserProduced: new Set(['iss1']) }, { includeVisual: true, produceTeaser: true });
    expect(step.kind).toBe('done');
  });

  it('never asks for a teaser on a text-only run even with produceTeaser on', () => {
    const step = resolveNextStep(comic, [issue({ stages: rendered })], fullyReady, { target: 'text', produceTeaser: true });
    expect(step.kind).toBe('done');
  });
});

describe('resolveNextStep — unlock pre-pass ordering', () => {
  // A locked arc makes generateArc/resolveVerifyIssues throw and a locked stage
  // makes text generation skip, so the unlock MUST precede every generation step
  // — pin that it sorts ahead of even the very first one.
  const bare = { targetFormat: 'comic', arc: null, seasons: [] };

  it('runs before generateArc when enabled', () => {
    expect(resolveNextStep(bare, [], {}, { unlockForRun: true }).kind).toBe('unlockLocks');
  });
  it('is skipped entirely when not enabled', () => {
    expect(resolveNextStep(bare, [], {}, {}).kind).toBe('characterFoundation');
    expect(resolveNextStep(bare, [], {}, { unlockForRun: false }).kind).toBe('characterFoundation');
  });
  it('runs at most once per run (latched by runState.locksUnlocked)', () => {
    expect(resolveNextStep(bare, [], { locksUnlocked: true }, { unlockForRun: true }).kind).toBe('characterFoundation');
    expect(resolveNextStep(bare, [], { locksUnlocked: true, characterFoundationEstablished: true }, { unlockForRun: true }).kind).toBe('generateArc');
  });
  it('unlocks before repairing duplicate volume structure', () => {
    const duplicate = {
      targetFormat: 'comic', arc: { logline: 'L', summary: 'S' },
      seasons: [{ id: 'se1', number: 1, locked: true }, { id: 'dup1', number: 1, locked: true }],
    };
    expect(resolveNextStep(duplicate, [], {}, { unlockForRun: true }).kind).toBe('unlockLocks');
    expect(resolveNextStep(duplicate, [], { locksUnlocked: true }, { unlockForRun: true }).kind).toBe('repairArcStructure');
  });
});

describe('resolveNextStep — revision cycle ordering (#2171)', () => {
  const comic = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
  const issue = (over = {}) => ({ id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {}, ...over });
  // Health-clean base runState (everything up to and including the health gate).
  const healthClean = {
    arcVerified: true, foundationGated: true, beatContinuityChecked: true, pilotReviewed: true, scriptChecked: new Set(['iss1']),
    editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true,
    editorialHealthReady: true,
  };
  const stages = { idea: ready(), comicScript: ready(VALID_SCRIPT) };

  it('does NOT insert a revision cycle when disabled (default) — proceeds to canonVerify', () => {
    const step = resolveNextStep(comic, [issue({ stages })], healthClean, { includeVisual: true });
    expect(step.kind).toBe('canonVerify');
  });

  it('inserts the revision cycle after the health gate and before canonVerify when enabled', () => {
    const step = resolveNextStep(comic, [issue({ stages })], healthClean, { includeVisual: true, revisionEnabled: true, revisionMaxCycles: 2 });
    expect(step.kind).toBe('revisionCycle');
    expect(step.reason).toMatch(/cycle 1/);
  });

  it('routes back to the revision cycle while cycles remain (cursor is revisionCyclesRun)', () => {
    const step = resolveNextStep(
      comic, [issue({ stages })],
      { ...healthClean, revisionCyclesRun: 1 },
      { includeVisual: true, revisionEnabled: true, revisionMaxCycles: 3 },
    );
    expect(step.kind).toBe('revisionCycle');
    expect(step.reason).toMatch(/cycle 2/);
  });

  it('stops routing to the revision cycle once maxCycles is reached', () => {
    const step = resolveNextStep(
      comic, [issue({ stages })],
      { ...healthClean, revisionCyclesRun: 2 },
      { includeVisual: true, revisionEnabled: true, revisionMaxCycles: 2 },
    );
    expect(step.kind).toBe('canonVerify');
  });

  it('stops routing to the revision cycle once converged (plateau/hedge latched)', () => {
    const step = resolveNextStep(
      comic, [issue({ stages })],
      { ...healthClean, revisionCyclesRun: 1, revisionConverged: true },
      { includeVisual: true, revisionEnabled: true, revisionMaxCycles: 5 },
    );
    expect(step.kind).toBe('canonVerify');
  });

  it('dry-run plan lists the revision cycle after the health gate when enabled', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const plan = autopilot.__testing.buildDryRunPlan(series, issues, { revisionEnabled: true, revisionMaxCycles: 3, includeVisual: false });
    const kinds = plan.map((p) => p.kind);
    expect(kinds).toContain('revisionCycle');
    expect(kinds.indexOf('revisionCycle')).toBeGreaterThan(kinds.indexOf('editorialHealthGate'));
    const rev = plan.find((p) => p.kind === 'revisionCycle');
    expect(rev.count).toBe(3);
  });

  it('dry-run plan omits the revision cycle when disabled', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const plan = autopilot.__testing.buildDryRunPlan(series, issues, { includeVisual: false });
    expect(plan.map((p) => p.kind)).not.toContain('revisionCycle');
  });
});

describe('requiredScriptStages / scriptStructurallyReady', () => {
  it('maps targetFormat to required scripts', () => {
    expect(requiredScriptStages({ targetFormat: 'comic' })).toEqual(['comicScript']);
    expect(requiredScriptStages({ targetFormat: 'tv' })).toEqual(['teleplay']);
    expect(requiredScriptStages({ targetFormat: 'comic+tv' })).toEqual(['comicScript', 'teleplay']);
    expect(requiredScriptStages({})).toEqual(['comicScript', 'teleplay']);
  });

  it('restricts a comic+tv series to one format via options.targetFormats', () => {
    const series = { targetFormat: 'comic+tv' };
    expect(requiredScriptStages(series, { targetFormats: ['comic'] })).toEqual(['comicScript']);
    expect(requiredScriptStages(series, { targetFormats: ['tv'] })).toEqual(['teleplay']);
    expect(requiredScriptStages(series, { targetFormats: ['comic', 'tv'] })).toEqual(['comicScript', 'teleplay']);
  });

  it('ignores a restriction the series cannot satisfy (never strands the run with zero scripts)', () => {
    // A comic-only series asked to produce tv-only falls back to its own format.
    expect(requiredScriptStages({ targetFormat: 'comic' }, { targetFormats: ['tv'] })).toEqual(['comicScript']);
    // Empty / non-array restrictions are no-ops.
    expect(requiredScriptStages({ targetFormat: 'comic+tv' }, { targetFormats: [] })).toEqual(['comicScript', 'teleplay']);
    expect(requiredScriptStages({ targetFormat: 'comic+tv' }, {})).toEqual(['comicScript', 'teleplay']);
  });

  it('passes a parseable comic script and fails an unparseable one', () => {
    expect(scriptStructurallyReady({ stages: { comicScript: ready(VALID_SCRIPT) } })).toBe(true);
    expect(scriptStructurallyReady({ stages: { comicScript: ready('just some prose, no pages') } })).toBe(false);
    expect(scriptStructurallyReady({ stages: {} })).toBe(false);
  });
});

describe('wantsComic (per-run comic gating)', () => {
  it('honors the series format when no restriction is given', () => {
    expect(wantsComic({ targetFormat: 'comic+tv' })).toBe(true);
    expect(wantsComic({ targetFormat: 'comic' })).toBe(true);
    expect(wantsComic({ targetFormat: 'tv' })).toBe(false);
  });

  it('is false for a comic+tv series restricted to tv-only (so comic gates do NOT run)', () => {
    // This is the bug: a ['tv'] run must NOT enter scriptVerify/visual on a
    // comic+tv series, or it would verify a comic script that was never authored.
    expect(wantsComic({ targetFormat: 'comic+tv' }, { targetFormats: ['tv'] })).toBe(false);
    expect(wantsComic({ targetFormat: 'comic+tv' }, { targetFormats: ['comic'] })).toBe(true);
    expect(wantsComic({ targetFormat: 'comic+tv' }, { targetFormats: ['comic', 'tv'] })).toBe(true);
  });

  it('treats a restriction the series cannot satisfy as a no-op (matches requiredScriptStages)', () => {
    // comic-only series asked for tv-only → requiredScriptStages falls back to
    // comic; wantsComic must agree (still wants comic) so the run isn't stranded.
    expect(wantsComic({ targetFormat: 'comic' }, { targetFormats: ['tv'] })).toBe(true);
    expect(wantsComic({ targetFormat: 'comic+tv' }, { targetFormats: [] })).toBe(true);
  });
});

describe('visualReady', () => {
  const cover = { proofImage: { jobId: 'c' } };
  const backCover = { proofImage: { jobId: 'b' } };
  it('is false with no pages, true once cover + back + all paneled pages are enqueued', () => {
    expect(visualReady({ stages: { comicPages: { pages: [] } } })).toBe(false);
    // pages but cover not enqueued
    expect(visualReady({ stages: { comicPages: { pages: [{ panels: [{}], proofImage: { jobId: 'p' } }] } } })).toBe(false);
    // cover + back + page enqueued
    expect(visualReady({
      stages: { comicPages: { cover, backCover, pages: [{ panels: [{}], proofImage: { jobId: 'p' } }] } },
    })).toBe(true);
  });

  it('requires the back cover to be enqueued (always drafted)', () => {
    expect(visualReady({
      stages: { comicPages: { cover, pages: [{ panels: [{}], proofImage: { jobId: 'p' } }] } },
    })).toBe(false);
  });

  it('counts a legacy rendered slot (imageJobId/filename) as enqueued', () => {
    expect(visualReady({
      stages: { comicPages: { cover: { imageJobId: 'legacy' }, backCover: { filename: 'b.png' }, pages: [{ panels: [{}], imageJobId: 'lp' }] } },
    })).toBe(true);
  });

  it('does not block on a page that has no panels', () => {
    expect(visualReady({
      stages: { comicPages: { cover: { finalImage: { filename: 'c.png' } }, backCover, pages: [{ panels: [] }] } },
    })).toBe(true);
  });
});
