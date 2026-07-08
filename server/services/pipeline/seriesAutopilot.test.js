import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

// ---- File-backed store (like autoRunner.test.js) so the REAL series/issues
// services run against an in-memory map instead of Postgres. ------------------
const fileStore = new Map();
vi.mock('../../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data', cos: '/mock/data/cos' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

// ---- Controllable test doubles for the autonomy + LLM-calling deps. ----------
let cosMode = 'execute';
vi.mock('../cosState.js', () => ({
  loadState: vi.fn(async () => ({ config: { domainAutonomy: { cos: cosMode } } })),
}));

let budgetStatus = { withinBudget: true, exceeded: null };
const recordDomainUsage = vi.fn(async () => {});
vi.mock('../domainUsage.js', () => ({
  getDomainBudgetStatus: vi.fn(async () => budgetStatus),
  recordDomainUsage,
}));

// arcPlanner: keep the REAL barrel (for compareIssuesByPosition) and override
// only the LLM-calling passes with spies whose return values the tests drive.
let verifyFindings = [];
let beatContinuityFindings = [];
let editorialFindings = [];
const arcSpies = {
  generateArcOverview: vi.fn(async () => ({ arc: { logline: 'A', summary: 'S' }, seasons: [] })),
  commitSeasonsWithRemap: vi.fn(async (series) => ({ series })),
  generateSeasonEpisodes: vi.fn(async () => ({ episodes: [] })),
  commitEpisodesToIssues: vi.fn(async () => []),
  verifyArc: vi.fn(async () => ({ issues: verifyFindings })),
  resolveVerifyIssues: vi.fn(async () => ({ applied: true })),
  analyzeBeatContinuity: vi.fn(async () => ({ issues: beatContinuityFindings })),
  resolveBeatContinuity: vi.fn(async () => ({ applied: true, episodesResolved: [] })),
  analyzeManuscriptCompleteness: vi.fn(async () => ({ issues: editorialFindings, runId: 'run-comp' })),
};
vi.mock('./arcPlanner.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...arcSpies };
});

const volumeBeatsSpies = {
  startVolumeBeatsRun: vi.fn(async () => ({ runId: 'vb', alreadyRunning: false })),
  isVolumeBeatsRunActive: vi.fn(() => false),
  cancelVolumeBeatsRun: vi.fn(() => true),
};
vi.mock('./volumeBeatsRunner.js', () => volumeBeatsSpies);

const autoRunnerSpies = {
  startAutoRunTextStages: vi.fn(async () => ({ runId: 'ar', alreadyRunning: false })),
  isAutoRunActive: vi.fn(() => false),
  cancelAutoRun: vi.fn(() => true),
};
vi.mock('./autoRunner.js', () => autoRunnerSpies);

vi.mock('./manuscriptReview.js', () => ({
  seedReviewFromFindings: vi.fn(async () => ({ comments: [] })),
  getReview: vi.fn(async () => ({ comments: [] })),
}));
// Drives whether the reverse-outline refresh step (#1349) thinks a scene-consuming
// check is enabled. Default false so the existing conductor runs skip it cheaply.
let reverseOutlineConsumed = false;
// Gate-aware (#1614) signal: drives the consumption check when a gateCtx is
// passed (the autopilot's Gate 3). `null` = mirror the sources-only signal, so
// every pre-#1614 test keeps its existing behavior.
let reverseOutlineConsumedGated = null;
// Drives the perCheck array the editorial-checks pass sees, so a test can inject
// an errored check and assert it surfaces in the run summary (#1573).
let editorialChecksPerCheck = [];
// Drives the findings the editorial-checks pass returns, so a test can inject
// high-severity findings and assert the optional pause gate fires (#1613).
let editorialChecksFindings = [];
const checkRunnerSpies = {
  runEditorialChecks: vi.fn(async () => ({ runId: 'ec', findings: editorialChecksFindings, perCheck: editorialChecksPerCheck, canceled: false })),
  buildEditorialCheckPlan: vi.fn(async () => ({ seriesId: 's', checks: [], enabledCount: 0, consumesReverseOutline: reverseOutlineConsumed })),
  enabledChecksConsumeReverseOutline: vi.fn((settings, checkIds, gateCtx) =>
    (gateCtx != null && reverseOutlineConsumedGated !== null ? reverseOutlineConsumedGated : reverseOutlineConsumed)),
  // Gate-context builder (#1614) — the SUT calls this before the gate-aware
  // consumption re-check. Shape is irrelevant here (the consumption mock above
  // ignores it); it only needs to resolve to a truthy ctx.
  buildReverseOutlineGateContext: vi.fn(async (seriesId) => ({ seriesId, manuscript: 'x', canon: { characters: [] }, reverseOutline: [], reverseOutlinePlotlines: [] })),
  // Real pure impl (the module is fully mocked) so the SUT's error-summarizing
  // matches production behavior without pulling checkRunner's heavy imports.
  summarizeCheckErrors: (perCheck) => {
    const erroredCheckIds = (Array.isArray(perCheck) ? perCheck : []).filter((c) => c?.error).map((c) => c.checkId);
    return { errored: erroredCheckIds.length, erroredCheckIds };
  },
};
vi.mock('./editorial/checkRunner.js', () => checkRunnerSpies);

// Reverse outline (#1349) — controllable staleness + a generate spy so a test can
// assert the refresh step regenerates only when stale and bills only then.
let reverseOutlineState = { status: 'complete', stale: false };
const generateReverseOutline = vi.fn(async () => ({ status: 'complete', stale: false, scenes: [{ id: 'sc1' }] }));
vi.mock('./reverseOutline.js', () => ({
  getReverseOutline: vi.fn(async (seriesId) => ({ seriesId, ...reverseOutlineState })),
  generateReverseOutline,
}));
vi.mock('../settings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('./manuscriptFix.js', () => ({
  generateManuscriptFix: vi.fn(async () => ({})),
  acceptManuscriptFix: vi.fn(async () => ({})),
}));

const visualSpies = {
  enqueueComicCover: vi.fn(async () => ({ jobId: 'job-cover', prompt: 'p', variant: 'proof', fromProof: false })),
  enqueueComicBackCover: vi.fn(async () => ({ jobId: 'job-back', prompt: 'p', variant: 'proof', fromProof: false })),
  enqueueVisualComicPage: vi.fn(async (_issueId, { pageIndex }) => ({ jobId: `job-page-${pageIndex}`, prompt: 'p', variant: 'proof', fromProof: false })),
};
vi.mock('./visualStages.js', () => visualSpies);

let nextTaskId = 0;
const addTask = vi.fn(async () => ({ id: `task-gap-${++nextTaskId}` }));
vi.mock('../cosTaskStore.js', () => ({ addTask }));

let scriptVerifyFindings = [];
const verifyComicScript = vi.fn(async () => ({ issues: scriptVerifyFindings }));
vi.mock('./scriptVerify.js', () => ({ verifyComicScript }));

let canonReady = true;
let canonUndescribed = [];
const checkSeriesCanonReadiness = vi.fn(async (seriesId) => ({
  seriesId, ready: canonReady, issues: [], blockingIssues: [], undescribed: canonUndescribed,
}));
vi.mock('./canonReadiness.js', () => ({ checkSeriesCanonReadiness }));

// Pause-escalation notifications (#1615) — spy on the notification center so a
// test can assert a pause posts a banner (and a clean run / opt-out does not).
const addNotification = vi.fn(async () => ({ id: 'notif-1' }));
const removeByMetadata = vi.fn(async () => ({ success: true, removed: 0 }));
vi.mock('../notifications.js', () => ({
  addNotification,
  removeByMetadata,
  NOTIFICATION_TYPES: { AUTOPILOT_PAUSED: 'autopilot_paused' },
  PRIORITY_LEVELS: { HIGH: 'high', MEDIUM: 'medium', LOW: 'low', CRITICAL: 'critical' },
}));

// Mocked domainUsage binding, so a test can drive the budget per call.
const { getDomainBudgetStatus } = await import('../domainUsage.js');
// Mocked settings binding, so a test can drive the persisted convergence-round
// defaults the autopilot reads at start.
const { getSettings } = await import('../settings.js');

// Real services + the unit under test (imported AFTER the mocks above).
const seriesSvc = await import('./series.js');
const seasonsSvc = await import('./seasons.js');
const issuesSvc = await import('./issues.js');
const autopilot = await import('./seriesAutopilot.js');
const arcPlanner = await import('./arcPlanner.js');
const { stageContentOf } = await import('./textStages.js');
const { resolveNextStep, requiredScriptStages, scriptStructurallyReady, visualReady, wantsComic } = autopilot;

// A comic script string that parseComicScript turns into >=1 page/panel.
const VALID_SCRIPT = 'PAGE 1\nPANEL 1\nA scene.';

const ready = (output = 'x') => ({ status: 'ready', output });
const empty = () => ({ status: 'empty', output: '' });

const waitFor = async (predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
};
const runFinished = (sId) => () => autopilot.__testing.runs.get(sId)?.finished === true;

beforeEach(() => {
  fileStore.clear();
  uuidCounter = 0;
  cosMode = 'execute';
  budgetStatus = { withinBudget: true, exceeded: null };
  verifyFindings = [];
  beatContinuityFindings = [];
  editorialFindings = [];
  scriptVerifyFindings = [];
  canonReady = true;
  canonUndescribed = [];
  reverseOutlineConsumed = false;
  reverseOutlineConsumedGated = null;
  reverseOutlineState = { status: 'complete', stale: false };
  editorialChecksPerCheck = [];
  editorialChecksFindings = [];
  nextTaskId = 0;
  autopilot.__testing.runs.clear();
  vi.clearAllMocks();
  generateReverseOutline.mockImplementation(async () => ({ status: 'complete', stale: false, scenes: [{ id: 'sc1' }] }));
  // Reset the budget mock to read the `budgetStatus` var (clearAllMocks keeps
  // implementations, but a prior test may have set a call-count-keyed one).
  getDomainBudgetStatus.mockImplementation(async () => budgetStatus);
  // Reset settings to empty so a test that set persisted convergence rounds
  // doesn't leak its default into the next test.
  getSettings.mockImplementation(async () => ({}));
});

// ---------------------------------------------------------------------------
// Pure resolver — the highest-value unit (no I/O, table-driven).
// ---------------------------------------------------------------------------
describe('provider/model threading helpers (#1514 provider + #1558 model — both SOFT defaults)', () => {
  const record = { options: { providerOverride: 'codex', modelOverride: 'gpt-x' } };

  it('providerOverrideOpts emits providerDefault + modelDefault (NOT hard overrides) so a stage pin still wins', () => {
    const opts = autopilot.__testing.providerOverrideOpts(record);
    expect(opts.providerDefault).toBe('codex');
    expect(opts.modelDefault).toBe('gpt-x');
    // The whole point of the change: neither the run provider NOR the run model
    // may arrive as a hard override, or it would beat a deliberate per-stage pin.
    expect(opts).not.toHaveProperty('providerOverride');
    expect(opts).not.toHaveProperty('providerId');
    expect(opts).not.toHaveProperty('modelOverride');
  });

  it('providerIdOpts emits providerIdDefault + modelIdDefault for the { providerId }-style services', () => {
    const opts = autopilot.__testing.providerIdOpts(record);
    expect(opts.providerIdDefault).toBe('codex');
    expect(opts.modelIdDefault).toBe('gpt-x');
    expect(opts).not.toHaveProperty('providerId');
    expect(opts).not.toHaveProperty('providerOverride');
    expect(opts).not.toHaveProperty('model');
  });

  it('passes an undefined default through untouched when the run pins no provider/model', () => {
    const none = { options: {} };
    expect(autopilot.__testing.providerOverrideOpts(none).providerDefault).toBeUndefined();
    expect(autopilot.__testing.providerOverrideOpts(none).modelDefault).toBeUndefined();
    expect(autopilot.__testing.providerIdOpts(none).providerIdDefault).toBeUndefined();
    expect(autopilot.__testing.providerIdOpts(none).modelIdDefault).toBeUndefined();
  });
});

describe('resolveNextStep (pure)', () => {
  const comic = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
  const issue = (over = {}) => ({ id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {}, ...over });

  it('asks for arc generation when there is no arc', () => {
    expect(resolveNextStep({ targetFormat: 'comic', seasons: [] }, []).kind).toBe('generateArc');
  });

  it('treats a present arc summary (no logline) as having an arc', () => {
    const step = resolveNextStep(
      { targetFormat: 'comic', arc: { summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] },
      [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }],
    );
    expect(step.kind).not.toBe('generateArc');
  });

  it('resolveAutopilotRounds: per-run option wins, else setting, else default', () => {
    const { resolveAutopilotRounds, MAX_ARC_VERIFY_ROUNDS, MAX_EDITORIAL_ROUNDS, MAX_BEAT_CONTINUITY_ROUNDS } = autopilot;
    // per-run option wins (including an explicit 0 = skip)
    expect(resolveAutopilotRounds(
      { maxArcVerifyRounds: 7, maxEditorialRounds: 0, maxBeatContinuityRounds: 5 },
      { pipelineEditorialChecks: { maxArcVerifyRounds: 4, maxEditorialRounds: 4, maxBeatContinuityRounds: 1 } },
    )).toEqual({ maxArcVerifyRounds: 7, maxEditorialRounds: 0, maxBeatContinuityRounds: 5 });
    // persisted setting fills in when no per-run override
    const fromSetting = resolveAutopilotRounds({}, { pipelineEditorialChecks: { maxArcVerifyRounds: 6, maxBeatContinuityRounds: 3 } });
    expect(fromSetting.maxArcVerifyRounds).toBe(6);
    expect(fromSetting.maxEditorialRounds).toBe(MAX_EDITORIAL_ROUNDS);
    expect(fromSetting.maxBeatContinuityRounds).toBe(3);
    // module default when neither is set
    expect(resolveAutopilotRounds({}, null)).toEqual({
      maxArcVerifyRounds: MAX_ARC_VERIFY_ROUNDS, maxEditorialRounds: MAX_EDITORIAL_ROUNDS, maxBeatContinuityRounds: MAX_BEAT_CONTINUITY_ROUNDS,
    });
    // a non-integer at any layer falls through
    expect(resolveAutopilotRounds(
      { maxArcVerifyRounds: 2.5 },
      { pipelineEditorialChecks: { maxArcVerifyRounds: 'x' } },
    ).maxArcVerifyRounds).toBe(MAX_ARC_VERIFY_ROUNDS);
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
    expect(resolveNextStep(arcOnly, []).kind).toBe('generateArc');
    // once arc generation has been attempted, it does not re-loop into generateArc
    expect(resolveNextStep(arcOnly, [], { arcAttempted: true }).kind).not.toBe('generateArc');
  });

  it('dry-run plan includes generateArc for an arc-only series (parity with execute)', () => {
    const plan = autopilot.__testing.buildDryRunPlan(
      { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [] }, [], {},
    );
    expect(plan[0].kind).toBe('generateArc');
  });

  it('dry-run plan omits editorialChecks + editorialHealthGate when editorial rounds are 0', () => {
    const series = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
    const issues = [{ id: 'i1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
    const kinds = (opts) => autopilot.__testing.buildDryRunPlan(series, issues, opts).map((p) => p.kind);
    // With editorial enabled (default), the reverse-outline refresh (#1349), both
    // registry checks + health gate appear.
    expect(kinds({})).toEqual(expect.arrayContaining(['editorialReview', 'reverseOutline', 'editorialChecks', 'editorialHealthGate']));
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
    // verifyArc: convergence loop at the default 3 rounds → 2*3-1 = 5 actions.
    expect(byKind.verifyArc.estActions).toBe(5);
    // textStages: one child action per not-yet-text-ready issue (2 here).
    expect(byKind.textStages.estActions).toBe(2);
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
    // 1 round → a single verify, no resolve → 1 action.
    expect(actionsFor({ maxArcVerifyRounds: 1 }, 'verifyArc')).toBe(1);
    // 4 rounds → 4 verifies + 3 resolves → 7 actions.
    expect(actionsFor({ maxArcVerifyRounds: 4 }, 'verifyArc')).toBe(7);
    // Editorial review follows the same convergence shape.
    expect(actionsFor({ maxEditorialRounds: 2 }, 'editorialReview')).toBe(3);
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
    const step = resolveNextStep(comic, []);
    expect(step).toMatchObject({ kind: 'generateEpisodes', seasonId: 'se1' });
  });

  it('verifies the arc before drafting issues', () => {
    const step = resolveNextStep(comic, [issue()]);
    expect(step.kind).toBe('verifyArc');
  });

  it('asks for beat sheets when an issue has no idea (post-verify)', () => {
    const step = resolveNextStep(comic, [issue()], { arcVerified: true });
    expect(step).toMatchObject({ kind: 'beatSheet', seasonId: 'se1' });
  });

  it('skips a season already attempted for beats (no infinite loop)', () => {
    const step = resolveNextStep(comic, [issue()], { arcVerified: true, beatsAttempted: new Set(['se1']) });
    // beats skipped → falls through to text stages
    expect(step).toMatchObject({ kind: 'textStages', issueId: 'iss1' });
  });

  it('runs whole-manuscript beat continuity once beats exist, before text (#1510)', () => {
    const step = resolveNextStep(comic, [issue({ stages: { idea: ready() } })], { arcVerified: true });
    expect(step).toMatchObject({ kind: 'beatContinuity' });
  });

  it('skips beat continuity for a synopsis-only run (no beats anywhere)', () => {
    // idea has input (synopsis) but no ready output → no beats → fall through to
    // text without a beat-continuity pass (it would just duplicate arc verify).
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: { status: 'empty', input: 'syn', output: '' }, comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true },
    );
    expect(step.kind).not.toBe('beatContinuity');
  });

  it('asks for text stages once beats are continuity-checked but scripts do not exist', () => {
    const step = resolveNextStep(comic, [issue({ stages: { idea: ready() } })], { arcVerified: true, beatContinuityChecked: true });
    expect(step).toMatchObject({ kind: 'textStages', issueId: 'iss1' });
  });

  it('asks for structural script verify once comic script is ready', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, beatContinuityChecked: true },
    );
    expect(step).toMatchObject({ kind: 'scriptVerify', issueId: 'iss1' });
  });

  it('asks for editorial review once all issues are script-checked', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']) },
    );
    expect(step.kind).toBe('editorialReview');
  });

  it('refreshes the reverse outline after editorial review, before editorial checks (#1349)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('reverseOutline');
  });

  it('asks for editorial checks once the reverse outline is refreshed (#1349)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('editorialChecks');
  });

  it('runs the editorial health gate after both editorial passes (#1316)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('editorialHealthGate');
  });

  it('is done once the editorial health gate is clean (no visuals requested)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('done');
  });

  it('is done (no canon/visual) when target is text, even on a comic series', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: true, target: 'text' },
    );
    expect(step.kind).toBe('done');
  });

  it('asks for canon verify before visuals when includeVisual', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: true },
    );
    expect(step.kind).toBe('canonVerify');
  });

  it('asks for visual draft once canon is verified and pages are not rendered', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true },
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
      { arcVerified: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true },
      { includeVisual: true },
    );
    expect(step.kind).toBe('done');
  });

  it('does not run script verify for a tv-only target', () => {
    const tv = { targetFormat: 'tv', arc: { logline: 'L' }, seasons: [{ id: 'se1', number: 1 }] };
    const step = resolveNextStep(
      tv,
      [issue({ stages: { idea: ready(), teleplay: ready() } })],
      { arcVerified: true, beatContinuityChecked: true },
    );
    expect(step.kind).toBe('editorialReview');
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
  const fullyReady = { arcVerified: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true };

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

describe('resolveAutopilotProduceTeaser (config gate, #2185)', () => {
  it('defaults OFF', () => {
    expect(autopilot.resolveAutopilotProduceTeaser({}, null)).toBe(false);
  });
  it('per-run option wins over the persisted setting', () => {
    expect(autopilot.resolveAutopilotProduceTeaser({ produceTeaser: true }, { pipelineEditorialChecks: { produceTeaser: false } })).toBe(true);
  });
  it('falls back to the persisted setting when no per-run option', () => {
    expect(autopilot.resolveAutopilotProduceTeaser({}, { pipelineEditorialChecks: { produceTeaser: true } })).toBe(true);
  });
});

describe('autopilotEvents in-process bus (#2185)', () => {
  it('mirrors the SSE frames a real run broadcasts onto the bus keyed by seriesId', async () => {
    cosMode = 'dry-run';
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

describe('dry-run plan ↔ resolveNextStep drift guard (#1577)', () => {
  // buildDryRunPlan is kept in sync with resolveNextStep BY HAND (see the comment
  // above buildDryRunPlan). This guard runs BOTH against the same fixtures and
  // asserts they enumerate the SAME step kinds in the SAME order AND the SAME
  // per-step counts — so a future edit that adds/removes/reorders a step, or that
  // diverges a plan `count` formula (textNeeded / visualNeeded / beatsNeeded /
  // ordered.length) from the resolver's actual per-issue/per-season looping, fails
  // here instead of silently advertising a plan execute won't follow.
  //
  // Scope: this verifies plan ↔ RESOLVER parity. `completeStep` re-implements the
  // dispatch's runState effects (it does not drive the real dispatchStep), so a
  // change to dispatch that preserves step kinds/order/counts is out of scope.
  //
  // Fidelity note: the fixtures all have their issues already present (no empty
  // seasons), so no generation step CREATES new downstream work mid-walk. That's
  // the regime where the two are contractually identical — the dry-run plan is a
  // snapshot prediction of the CURRENT records, not a recursive expansion of
  // issues a generateEpisodes step would later add. generateArc / generateEpisodes
  // parity is covered separately by the dedicated cases above.

  const freshRunState = () => ({
    arcAttempted: false, arcVerified: false, beatContinuityChecked: false,
    editorialReviewed: false, reverseOutlineRefreshed: false,
    editorialChecksReviewed: false, editorialHealthReady: false, canonVerified: false,
    episodesAttempted: new Set(), beatsAttempted: new Set(), textAttempted: new Set(),
    scriptChecked: new Set(), visualDrafted: new Set(),
  });

  // Advance runState + fixture exactly as the execute dispatch would once the
  // given step "completes" — flipping the precise predicate each downstream gate
  // reads: runState marks for the boolean/set gates, and issue/season CONTENT for
  // the content gates (beats → idea.output, text → required scripts, visuals →
  // rendered pages) so the resolver actually advances past them.
  const completeStep = (step, issues, runState, edRounds) => {
    switch (step.kind) {
      case 'generateArc':
      case 'generateEpisodes':
        // These steps CREATE downstream work (seasons / issues) that buildDryRunPlan
        // intentionally does NOT predict from a snapshot — so a fixture that reaches
        // them is outside this guard's plan↔resolver-parity scope and would produce a
        // misleading false failure. Generation parity is covered by the dedicated
        // generateArc / generateEpisodes cases above; keep these fixtures populated.
        throw new Error(`drift guard: fixture reached "${step.kind}" — parity guard requires fully-populated fixtures (arc present + every season seeded with issues)`);
      case 'verifyArc':
        runState.arcVerified = true;
        break;
      case 'beatSheet':
        issues.filter((i) => i.seasonId === step.seasonId)
          .forEach((i) => { i.stages = { ...i.stages, idea: ready() }; });
        runState.beatsAttempted.add(step.seasonId);
        break;
      case 'beatContinuity':
        runState.beatContinuityChecked = true;
        break;
      case 'textStages': {
        // Satisfy textReady for every script format (comic + tv) so the mutator
        // stays target-agnostic.
        const issue = issues.find((i) => i.id === step.issueId);
        issue.stages = { ...issue.stages, comicScript: ready(VALID_SCRIPT), teleplay: ready() };
        runState.textAttempted.add(step.issueId);
        break;
      }
      case 'scriptVerify':
        runState.scriptChecked.add(step.issueId);
        break;
      case 'editorialReview':
        runState.editorialReviewed = true;
        // Mirror runEditorial: maxEditorialRounds === 0 marks the whole editorial
        // gate (reverse-outline + checks + health) done in one shot, so the
        // resolver advances straight past them — matching the plan's omission.
        if (edRounds === 0) {
          runState.reverseOutlineRefreshed = true;
          runState.editorialChecksReviewed = true;
          runState.editorialHealthReady = true;
        }
        break;
      case 'reverseOutline':
        runState.reverseOutlineRefreshed = true;
        break;
      case 'editorialChecks':
        runState.editorialChecksReviewed = true;
        break;
      case 'editorialHealthGate':
        runState.editorialHealthReady = true;
        break;
      case 'canonVerify':
        runState.canonVerified = true;
        break;
      case 'visualDraft': {
        const issue = issues.find((i) => i.id === step.issueId);
        issue.stages = {
          ...issue.stages,
          comicPages: {
            cover: { proofImage: { jobId: 'c' } },
            backCover: { proofImage: { jobId: 'b' } },
            pages: [{ panels: [{ description: 'x' }], proofImage: { jobId: 'p' } }],
          },
        };
        runState.visualDrafted.add(step.issueId);
        break;
      }
      default:
        throw new Error(`drift guard: unhandled step kind "${step.kind}" — add a completeStep branch`);
    }
  };

  // Collapse a flat list of emitted step kinds into the plan's shape: one
  // `{ kind, count }` entry per consecutive run. The resolver emits per-issue /
  // per-season steps one at a time (a run of N identical consecutive kinds); the
  // plan represents that same work as a single entry with `count: N`.
  const compress = (kinds) => kinds.reduce((out, kind) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.count += 1;
    else out.push({ kind, count: 1 });
    return out;
  }, []);

  // Walk resolveNextStep the way execute does — apply each step's effect, re-resolve
  // — collecting the ordered sequence of emitted step kinds (with repeats), then
  // compress to the plan's `{ kind, count }` shape.
  const simulateExecuteEntries = (series, issues, options) => {
    const working = issues.map((i) => ({ ...i, stages: { ...i.stages } }));
    const runState = freshRunState();
    const edRounds = Number.isInteger(options?.maxEditorialRounds) ? options.maxEditorialRounds : undefined;
    const emitted = [];
    for (let guard = 0; guard < 200; guard += 1) {
      const step = resolveNextStep(series, working, runState, options);
      if (step.kind === 'done') return compress(emitted);
      emitted.push(step.kind);
      completeStep(step, working, runState, edRounds);
    }
    throw new Error('drift guard: simulation did not converge to done within 200 steps');
  };

  // The plan carries extra annotation fields (note, etc.); compare only kind + count.
  const planEntries = (series, issues, options) =>
    autopilot.__testing.buildDryRunPlan(series, issues, options).map((p) => ({ kind: p.kind, count: p.count }));

  const baseComic = () => ({ targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] });
  const baseTv = () => ({ targetFormat: 'tv', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] });
  const bareIssue = () => [{ id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} }];
  // Two seasons, one bare issue each — exercises per-SEASON multiplicity (beatSheet
  // count 2) AND per-ISSUE multiplicity (textStages / scriptVerify / visualDraft
  // count 2), so the count formulas and the consecutive-run compression are tested.
  const twoSeasonComic = () => ({
    targetFormat: 'comic', arc: { logline: 'L', summary: 'S' },
    seasons: [{ id: 'se1', number: 1 }, { id: 'se2', number: 2 }],
  });
  const twoIssues = () => [
    { id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {} },
    { id: 'iss2', seasonId: 'se2', number: 1, arcPosition: 2, stages: {} },
  ];

  const cases = [
    { name: 'comic + visual (full pipeline)', series: baseComic(), issues: bareIssue(), options: {} },
    { name: 'comic, text-only target (no canon/visual)', series: baseComic(), issues: bareIssue(), options: { target: 'text' } },
    { name: 'comic, editorial rounds 0 (skips editorial gate)', series: baseComic(), issues: bareIssue(), options: { maxEditorialRounds: 0 } },
    { name: 'tv (no comic script / canon / visual)', series: baseTv(), issues: bareIssue(), options: {} },
    { name: 'comic + visual, 2 seasons × 1 issue (per-step multiplicity)', series: twoSeasonComic(), issues: twoIssues(), options: {} },
  ];

  for (const c of cases) {
    it(`enumerates identical step kinds + counts in identical order — ${c.name}`, () => {
      // buildDryRunPlan reads the records as-is; the simulation walks fresh copies,
      // so the two never share mutable state.
      const plan = planEntries(c.series, c.issues, c.options);
      const executed = simulateExecuteEntries(c.series, c.issues, c.options);
      expect(executed.length).toBeGreaterThan(0);
      expect(executed).toEqual(plan);
    });
  }
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

// ---------------------------------------------------------------------------
// Conductor lifecycle + gating (uses real series/issues against file store).
// ---------------------------------------------------------------------------
async function seedComplete({ script = VALID_SCRIPT } = {}) {
  const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
  await seriesSvc.updateSeries(series.id, { arc: { logline: 'A', summary: 'S' } });
  const season = await seasonsSvc.createSeason(series.id, { number: 1, title: 'V1' });
  const seasonId = season.id;
  const issue = await issuesSvc.createIssue({ seriesId: series.id, seasonId, title: 'I1', number: 1 });
  await issuesSvc.updateStage(issue.id, 'idea', ready('beats'));
  await issuesSvc.updateStage(issue.id, 'comicScript', ready(script));
  return { seriesId: series.id, seasonId, issueId: issue.id };
}

describe('trackConvergence (pure divergence/oscillation guard — #1571)', () => {
  const { trackConvergence, DIVERGENCE_PATIENCE } = autopilot;

  // Fold a sequence of per-round blocking counts into the final tracker state.
  const fold = (counts) => counts.reduce(trackConvergence, { best: null, sinceBest: 0 });

  it('seeds best on the first measured round (nothing to compare yet)', () => {
    expect(trackConvergence({ best: null, sinceBest: 0 }, 5)).toEqual({ best: 5, sinceBest: 0 });
  });

  it('resets sinceBest on a new low (a profitable resolve pass)', () => {
    expect(trackConvergence({ best: 5, sinceBest: 1 }, 3)).toEqual({ best: 3, sinceBest: 0 });
  });

  it('accrues sinceBest on a stall (equal to the best)', () => {
    expect(trackConvergence({ best: 4, sinceBest: 0 }, 4)).toEqual({ best: 4, sinceBest: 1 });
  });

  it('accrues sinceBest on a regression (a fix introduced a new blocker)', () => {
    expect(trackConvergence({ best: 2, sinceBest: 0 }, 5)).toEqual({ best: 2, sinceBest: 1 });
  });

  it('a strictly-decreasing run never diverges', () => {
    expect(fold([4, 3, 2, 1]).sinceBest).toBeLessThan(DIVERGENCE_PATIENCE);
  });

  it('a flat stall reaches the patience threshold after two non-improving rounds', () => {
    // round 1 seeds best=3; rounds 2 + 3 don't improve → sinceBest hits patience.
    expect(fold([3, 3]).sinceBest).toBeLessThan(DIVERGENCE_PATIENCE);
    expect(fold([3, 3, 3]).sinceBest).toBeGreaterThanOrEqual(DIVERGENCE_PATIENCE);
  });

  it('catches a 2-cycle oscillation a naive prev-round check would miss (#1571)', () => {
    // 5→4→5→4: after round 2 sets best=4, no later round beats it, so sinceBest
    // climbs past patience even though every other round "decreases" vs the prior.
    expect(fold([5, 4, 5, 4]).sinceBest).toBeGreaterThanOrEqual(DIVERGENCE_PATIENCE);
  });
});

describe('autopilot conductor', () => {
  it('rejects start when the cos domain is off (no run created)', async () => {
    cosMode = 'off';
    const { seriesId } = await seedComplete();
    const res = await autopilot.startSeriesAutopilot(seriesId, {});
    expect(res).toMatchObject({ rejected: true, mode: 'off' });
    expect(autopilot.__testing.runs.has(seriesId)).toBe(false);
  });

  it('dry-run emits a plan without calling any generator', async () => {
    cosMode = 'dry-run';
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
    expect(arcSpies.analyzeManuscriptCompleteness).toHaveBeenCalled();
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('done');
  });

  it('pauses for review when arc verify never converges', async () => {
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('verifyArc');
    // bounded: verifyArc called exactly maxRounds times, resolve called rounds-1.
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(2);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(1);
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    expect(series.autopilot?.residualFindings?.[0]?.problem).toBe('plot hole');
  });

  // Per-series blocking-severity sets (#1616).
  it('arc gate: default blocks a medium finding (pauses)', async () => {
    verifyFindings = [{ severity: 'medium', problem: 'soft beat', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('verifyArc');
  });

  it('arc gate: a per-series arc:[high] override lets a medium finding pass', async () => {
    verifyFindings = [{ severity: 'medium', problem: 'soft beat', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { blockingSeverities: { arc: ['high'] } });
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    // medium no longer blocks arc → the run proceeds past arc to completion.
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('arc gate: an empty arc:[] override never blocks, even on a high finding', async () => {
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { blockingSeverities: { arc: [] } });
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('beatContinuity gate: a per-series beatContinuity:[high] override lets a medium finding pass', async () => {
    beatContinuityFindings = [{ severity: 'medium', problem: 'beat drift', location: 'I1' }];
    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { blockingSeverities: { beatContinuity: ['high'] } });
    await autopilot.startSeriesAutopilot(seriesId, { maxBeatContinuityRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('editorial gate: an empty editorial:[] override never blocks, even on a high finding', async () => {
    editorialFindings = [{ severity: 'high', problem: 'missing scene', issueNumber: 1 }];
    const { seriesId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { blockingSeverities: { editorial: [] } });
    await autopilot.startSeriesAutopilot(seriesId, { maxEditorialRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('editorial gate: default blocks a high finding (pauses)', async () => {
    editorialFindings = [{ severity: 'high', problem: 'missing scene', issueNumber: 1 }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxEditorialRounds: 1 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('editorialReview');
  });

  it('posts an in-app notification when a run pauses, with a resume link (#1615)', async () => {
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
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
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
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
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 6 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('verifyArc');
    expect(last?.pauseKind).toBe('divergence');
    expect(last?.reason).toMatch(/stopped converging/);
    // Bailed at round 3 — NOT all 6 rounds (the whole point: budget saved).
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(3);
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(2);
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    // Persisted through sanitizeAutopilot so the resume banner survives a reload.
    expect(series.autopilot?.pauseKind).toBe('divergence');
  });

  it('a default-cap arc run is unaffected by the divergence guard (maxRounds still wins)', async () => {
    // Default arc cap is 3; the divergence streak can't reach patience (2) before
    // the loop hits maxRounds at round 3, so a stalled default run still reports
    // `maxRounds`, not `divergence` — no behavior change for default runs.
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {}); // default MAX_ARC_VERIFY_ROUNDS = 3
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.pauseKind).toBe('maxRounds');
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(3);
  });

  it('a per-run override beats the persisted maxArcVerifyRounds setting', async () => {
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
    getSettings.mockImplementation(async () => ({ pipelineEditorialChecks: { maxArcVerifyRounds: 4 } }));
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(arcSpies.verifyArc).toHaveBeenCalledTimes(1);
    expect(arcSpies.resolveVerifyIssues).not.toHaveBeenCalled();
  });

  it('runs whole-manuscript beat continuity before text, then proceeds when clean (#1510)', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    expect(arcSpies.analyzeBeatContinuity).toHaveBeenCalled();
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('pauses for review when beat continuity never converges (#1510)', async () => {
    beatContinuityFindings = [{ severity: 'high', problem: 'dropped cliffhanger', location: 'issue:1' }];
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
    beatContinuityFindings = [{ severity: 'high', problem: 'dropped cliffhanger', location: 'issue:1' }];
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
    expect(last?.scope).toBe('textStages');
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
    verifyFindings = [{ severity: 'high', problem: 'x' }];
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
    budgetStatus = { withinBudget: false, exceeded: 'actions' };
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, {});
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.reason).toMatch(/budget/);
    expect(arcSpies.verifyArc).not.toHaveBeenCalled();
  });

  it('a zero-round gate skips even when the budget is exhausted (no budget pause at that gate)', async () => {
    budgetStatus = { withinBudget: false, exceeded: 'actions' };
    const { seriesId } = await seedComplete();
    // maxArcVerifyRounds:0 + maxBeatContinuityRounds:0 ⇒ both gates short-circuit
    // with no spend, so the budget gate must NOT pause at either — the run
    // advances to the next non-exempt step (scriptVerify) and pauses there.
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 0, maxBeatContinuityRounds: 0 });
    await waitFor(runFinished(seriesId));
    expect(arcSpies.verifyArc).not.toHaveBeenCalled();
    expect(arcSpies.analyzeBeatContinuity).not.toHaveBeenCalled();
    const series = await seriesSvc.getSeries(seriesId);
    expect(series.autopilot?.status).toBe('paused');
    expect(series.autopilot?.currentStep).toBe('scriptVerify'); // not 'verifyArc'/'beatContinuity'
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
    reverseOutlineConsumed = true;
    reverseOutlineState = { status: 'complete', stale: true };
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(generateReverseOutline).toHaveBeenCalledTimes(1);
    // force:false lets the call no-op if the outline went fresh in the meantime.
    expect(generateReverseOutline.mock.calls[0][1]).toMatchObject({ force: false });
  });

  it('skips the reverse-outline refresh when no enabled check consumes it (#1349)', async () => {
    reverseOutlineConsumed = false; // gate 1: nothing reads the outline
    reverseOutlineState = { status: 'complete', stale: true }; // stale, but unused
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
    reverseOutlineConsumed = true; // gate 1: a consumer declares the source
    reverseOutlineConsumedGated = false; // gate 3: but every consumer is gated out
    // A complete-but-stale outline WITH scenes — gate 3 only evaluates when
    // there's scene content to gate against (a scene-less outline bootstraps).
    reverseOutlineState = { status: 'complete', stale: true, scenes: [{ id: 'sc1' }] };
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
    reverseOutlineConsumed = true;
    reverseOutlineConsumedGated = false; // would skip a complete outline, but...
    reverseOutlineState = { status: 'none', stale: false }; // ...never generated yet
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(checkRunnerSpies.buildReverseOutlineGateContext).not.toHaveBeenCalled();
    expect(generateReverseOutline).toHaveBeenCalledTimes(1);
  });

  it('forces a regen when a cached refresh is still stale against the live manuscript (#1614)', async () => {
    reverseOutlineConsumed = true;
    reverseOutlineState = { status: 'complete', stale: true, scenes: [{ id: 'sc1' }] };
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
    reverseOutlineConsumed = false; // subset skips every outline-consuming check
    reverseOutlineState = { status: 'complete', stale: true }; // stale, but unused
    getDomainBudgetStatus.mockImplementation(async () => (
      arcSpies.analyzeManuscriptCompleteness.mock.calls.length >= 1
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
    reverseOutlineConsumed = true;
    reverseOutlineState = { status: 'no-content' }; // gate 2: no manuscript to segment
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(generateReverseOutline).not.toHaveBeenCalled();
  });

  it('bills a cos action only when the reverse outline actually regenerates (#1349)', async () => {
    reverseOutlineConsumed = true;
    // Fresh outline — the refresh step is a no-op and charges nothing.
    reverseOutlineState = { status: 'complete', stale: false };
    const a = await seedComplete();
    await autopilot.startSeriesAutopilot(a.seriesId, { includeVisual: false });
    await waitFor(runFinished(a.seriesId));
    const freshCharges = recordDomainUsage.mock.calls.length;
    expect(generateReverseOutline).not.toHaveBeenCalled();

    recordDomainUsage.mockClear();
    generateReverseOutline.mockClear();
    // Same path, but a stale outline — exactly ONE extra cos action vs the fresh run.
    reverseOutlineState = { status: 'complete', stale: true };
    const b = await seedComplete();
    await autopilot.startSeriesAutopilot(b.seriesId, { includeVisual: false });
    await waitFor(runFinished(b.seriesId));
    expect(generateReverseOutline).toHaveBeenCalledTimes(1);
    expect(recordDomainUsage.mock.calls.length).toBe(freshCharges + 1);
  });

  it('pauses at the editorial health gate when a blocking finding remains open (#1316)', async () => {
    const manuscriptReview = await import('./manuscriptReview.js');
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
    verifyFindings = [{ severity: 'high', problem: 'x' }];
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
    verifyFindings = [{ severity: 'high', problem: 'x' }];
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
    canonReady = false;
    canonUndescribed = [{ id: 'c1', name: 'Kai', kind: 'character' }];
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

  it('files only the specific gap (not also the generic stalled) when canon pauses', async () => {
    canonReady = false;
    canonUndescribed = [{ id: 'c1', name: 'Kai', kind: 'character' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true, fileGaps: true });
    await waitFor(runFinished(seriesId));
    const descs = addTask.mock.calls.map((c) => c[0].description);
    expect(descs.some((d) => /canon-undescribed/.test(d))).toBe(true);
    expect(descs.some((d) => /canonVerify-stalled/.test(d))).toBe(false);
  });

  it('proceeds to visuals once canon is ready', async () => {
    canonReady = true;
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true });
    await waitFor(runFinished(seriesId));
    expect(checkSeriesCanonReadiness).toHaveBeenCalled();
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
    expect(last?.scope).toBe('textStages');
    expect(last?.reason).toMatch(/comicScript/);
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
    scriptVerifyFindings = [{ severity: 'high', problem: 'page 2 panel 1 has no description' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true, includeVisual: false });
    await waitFor(runFinished(seriesId));
    // advisory: run still completes
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    const gapKinds = addTask.mock.calls.map((c) => c[0].description);
    expect(gapKinds.some((d) => /script-craft/.test(d))).toBe(true);
  });

  it('qualifies the terminal complete frame + marker with filed script-craft gap counts (#1572)', async () => {
    scriptVerifyFindings = [
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
    scriptVerifyFindings = [{ severity: 'high', problem: 'page 2 panel 1 has no description' }];
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
    editorialChecksPerCheck = [
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
    editorialChecksPerCheck = [{ checkId: 'pacing', count: 0 }, { checkId: 'continuity', count: 1 }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    const done = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(done?.type).toBe('complete');
    expect(done?.editorialCheckErrors).toBe(0);
    expect(done?.editorialCheckErroredIds).toEqual([]);
  });

  it('pauses at editorialChecks when high findings ≥ the armed threshold (#1613)', async () => {
    editorialChecksFindings = [
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
    editorialChecksFindings = [
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
    editorialChecksFindings = [{ severity: 'high', checkId: 'pacing', location: 'ch 1', problem: 'a' }];
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
    verifyFindings = [{ severity: 'high', problem: 'unresolved plot hole' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true, maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    expect(addTask).toHaveBeenCalled();
    expect(addTask.mock.calls[0][0].description).toMatch(/verifyArc-stalled/);
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
