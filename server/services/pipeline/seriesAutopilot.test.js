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
let volumeVerifyFindings = [];
let beatContinuityFindings = [];
let editorialFindings = [];
const arcSpies = {
  generateArcOverview: vi.fn(async () => ({ arc: { logline: 'A', summary: 'S' }, seasons: [] })),
  commitSeasonsWithRemap: vi.fn(async (series) => ({ series })),
  generateSeasonEpisodes: vi.fn(async () => ({ episodes: [] })),
  commitEpisodesToIssues: vi.fn(async () => []),
  verifyArc: vi.fn(async () => ({ issues: verifyFindings })),
  verifyVolume: vi.fn(async () => ({ issues: volumeVerifyFindings })),
  resolveVerifyIssues: vi.fn(async () => ({ applied: true })),
  // Resolve-round rollback. The real snapshot/restore pair is covered
  // against the store in arcPlanner.test.js; here they're stubbed so the
  // conductor tests assert the LOOP's decision — when a round gets reverted.
  snapshotArcState: vi.fn(async (sId) => ({ seriesId: sId, arc: null, seasons: [], episodes: [] })),
  restoreArcState: vi.fn(async () => ({ restored: true, episodesRestored: 0, reassignedIssueCount: 0 })),
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
// Backing store for the gap-task retirement path (clearGapTasks). Tests seed
// `userTasks` with whatever the queue should already hold when a run starts.
let userTasks = [];
const getUserTasks = vi.fn(async () => ({ tasks: userTasks }));
const updateTask = vi.fn(async (taskId, updates) => {
  const task = userTasks.find(t => t.id === taskId);
  if (!task) return { error: 'Task not found' };
  Object.assign(task, updates, { metadata: { ...task.metadata, ...updates.metadata } });
  return task;
});
const firstLine = (s) => (s || '').split('\n').map(l => l.trim()).find(l => l) || '';
vi.mock('../cosTaskStore.js', () => ({ addTask, getUserTasks, updateTask, firstLine }));

let scriptVerifyFindings = [];
const verifyComicScript = vi.fn(async () => ({ issues: scriptVerifyFindings }));
vi.mock('./scriptVerify.js', () => ({ verifyComicScript }));

let canonReady = true;
let canonUndescribed = [];
let canonBlockingIssues = [];
const checkSeriesCanonReadiness = vi.fn(async (seriesId) => ({
  seriesId, ready: canonReady, issues: [], blockingIssues: canonBlockingIssues, undescribed: canonUndescribed,
}));
vi.mock('./canonReadiness.js', () => ({ checkSeriesCanonReadiness }));

const describeCanonFromProse = vi.fn(async () => {
  canonReady = true;
  canonUndescribed = [];
  canonBlockingIssues = [];
  return { report: { filled: 1, none: [], skippedLocked: [] }, runId: 'run-canon-repair' };
});
vi.mock('../universeCanon.js', () => ({ describeCanonFromProse }));

// Foundation-quality gate (#2176). Drive the judged weighted score + the fix
// router per test. Default: a clean foundation (10) so the gate passes on the
// first round and existing downstream-step tests are unaffected.
let foundationScore = 10;
let foundationDimensionScores = null;
let foundationFixApplied = true;
const establishCharacterFoundation = vi.fn(async () => ({ applied: true, ran: true }));
const judgeFoundation = vi.fn(async () => ({
  seriesId: 'ser-uuid-1', status: 'complete', weightedScore: foundationScore,
  dimensions: {
    worldbuilding: { score: foundationDimensionScores?.worldbuilding ?? foundationScore, gap: 'g', fix: 'f' },
    character: { score: foundationDimensionScores?.character ?? foundationScore, gap: 'g', fix: 'f' },
    structure: { score: foundationDimensionScores?.structure ?? foundationScore, gap: 'g', fix: 'f' },
    craft: { score: foundationDimensionScores?.craft ?? foundationScore, gap: 'g', fix: 'f' },
  },
  weakest: 'worldbuilding',
}));
const applyFoundationFix = vi.fn(async (_sId, dimension) => ({ dimension, applied: foundationFixApplied }));
const snapshotFoundationState = vi.fn(async (seriesId) => ({ seriesId, marker: 'foundation-checkpoint' }));
const restoreFoundationState = vi.fn(async () => ({ restored: true, episodesRestored: 0 }));
// Objective blank-field count behind the character arm's tie-breaker. Default:
// an unchanged cast (the checkpoint read and the post-repair read agree), so a
// tie stays a tie unless a test says the repair actually filled fields.
const readFoundationCharacterBlanks = vi.fn(async () => 0);
vi.mock('./foundationJudge.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    judgeFoundation: (...args) => judgeFoundation(...args),
    applyFoundationFix: (...args) => applyFoundationFix(...args),
    establishCharacterFoundation: (...args) => establishCharacterFoundation(...args),
    snapshotFoundationState: (...args) => snapshotFoundationState(...args),
    restoreFoundationState: (...args) => restoreFoundationState(...args),
    readFoundationCharacterBlanks: (...args) => readFoundationCharacterBlanks(...args),
  };
});

const recordModelOutcome = vi.fn(async () => true);
// Learned routing (`autoSelectModels`) reads the run history through this
// report. Mocked so a test can hand the run a recommendation and assert which
// roles it is allowed to re-point.
let modelRecommendations = {};
const getModelPerformanceReport = vi.fn(async () => ({ recommendations: modelRecommendations }));
vi.mock('./seriesAutopilot/modelPerformance.js', () => ({ recordModelOutcome, getModelPerformanceReport }));

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
const { commitSeasonsWithRemap: realCommitSeasonsWithRemap } = await import('./arcPlanner/arcCore.js');
const { stageContentOf } = await import('./textStages.js');
const { stagePinsIgnored } = await import('../../lib/stagePinPolicy.js');
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
  volumeVerifyFindings = [];
  beatContinuityFindings = [];
  editorialFindings = [];
  scriptVerifyFindings = [];
  canonReady = true;
  canonUndescribed = [];
  canonBlockingIssues = [];
  foundationScore = 10;
  foundationDimensionScores = null;
  foundationFixApplied = true;
  establishCharacterFoundation.mockClear();
  reverseOutlineConsumed = false;
  reverseOutlineConsumedGated = null;
  reverseOutlineState = { status: 'complete', stale: false };
  editorialChecksPerCheck = [];
  editorialChecksFindings = [];
  nextTaskId = 0;
  userTasks = [];
  modelRecommendations = {};
  autopilot.__testing.runs.clear();
  vi.clearAllMocks();
  generateReverseOutline.mockImplementation(async () => ({ status: 'complete', stale: false, scenes: [{ id: 'sc1' }] }));
  // Reset the budget mock to read the `budgetStatus` var (clearAllMocks keeps
  // implementations, but a prior test may have set a call-count-keyed one).
  getDomainBudgetStatus.mockImplementation(async () => budgetStatus);
  // Reset settings to empty so a test that set persisted convergence rounds
  // doesn't leak its default into the next test.
  getSettings.mockImplementation(async () => ({}));
  // `clearAllMocks` above keeps implementations, and the foundation-gate tests
  // set persistent ones. `mockReset` restores the implementation each was
  // constructed with, so a stalled-foundation test can't leak into the next.
  judgeFoundation.mockReset();
  applyFoundationFix.mockReset();
  snapshotFoundationState.mockReset();
  restoreFoundationState.mockReset();
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

  it('routes judges separately while keeping creation on the run default', () => {
    const split = {
      options: {
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
        judgeLlm: { providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
      },
    };
    expect(autopilot.__testing.providerOverrideOpts(split)).toMatchObject({
      providerDefault: 'codex-tui', modelDefault: 'gpt-5.6-luna', effortDefault: 'max',
    });
    expect(autopilot.__testing.providerOverrideOpts(split, 'judge')).toMatchObject({
      providerDefault: 'codex-tui', modelDefault: 'gpt-5.6-sol', effortDefault: 'xhigh',
    });
  });

  it('drops a creative model when the judge changes provider without choosing one', () => {
    const split = {
      options: {
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
        judgeLlm: { providerOverride: 'claude-code-tui', effortOverride: 'high' },
      },
    };
    expect(autopilot.__testing.roleLlm(split, 'judge')).toEqual({
      providerOverride: 'claude-code-tui', modelOverride: undefined, effortOverride: 'high',
    });
  });

  // Learned routing fills in only where the run routed NOTHING. The run route
  // reaching roleLlm is already resolved (per-run picker, else the series' own
  // `series.llm`), so "the run chose none" means both are blank.
  const recommendations = {
    foundationGate: {
      creative: { providerOverride: 'ollama', modelOverride: 'local-14b' },
      judge: { providerOverride: 'codex', modelOverride: 'judge-model' },
    },
  };

  it('uses learned stage/role routing for a role the run left unrouted', () => {
    const learned = {
      currentStep: 'foundationGate',
      options: {
        autoSelectModels: true,
        modelRecommendations: recommendations,
        judgeLlm: { providerOverride: 'manual-judge', modelOverride: 'manual-model' },
      },
    };
    expect(autopilot.__testing.roleLlm(learned, 'creative')).toEqual({
      providerOverride: 'ollama', modelOverride: 'local-14b', effortOverride: undefined,
    });
    // …but never over a hand-picked one.
    expect(autopilot.__testing.roleLlm(learned, 'judge')).toEqual({
      providerOverride: 'manual-judge', modelOverride: 'manual-model', effortOverride: undefined,
    });
  });

  // The live failure: with `autoSelectModels` on, a run that picked ONE
  // provider/model and left "use a separate model for judging" unchecked kept
  // CREATION on that route while every judge-role call — pipeline-arc-verify
  // above all — was re-pointed at the learned route. Judging inherits the run
  // route, so choosing the run route chooses the judge with it.
  it.each(['creative', 'judge'])('keeps the %s role on the run route the user chose', (role) => {
    const chosen = {
      currentStep: 'foundationGate',
      options: {
        autoSelectModels: true,
        providerOverride: 'antigravity-tui',
        modelOverride: 'gemini-3.6-flash-high',
        effortOverride: 'high',
        modelRecommendations: recommendations,
      },
    };
    expect(autopilot.__testing.roleLlm(chosen, role)).toEqual({
      providerOverride: 'antigravity-tui', modelOverride: 'gemini-3.6-flash-high', effortOverride: 'high',
    });
  });

  // Any ONE dimension is a deliberate choice — an effort-only run route still
  // has to keep its (provider-default) route rather than adopt a learned one.
  it('treats an effort-only run route as chosen for both roles', () => {
    const effortOnly = {
      currentStep: 'foundationGate',
      options: { autoSelectModels: true, effortOverride: 'max', modelRecommendations: recommendations },
    };
    expect(autopilot.__testing.roleLlm(effortOnly, 'creative').effortOverride).toBe('max');
    expect(autopilot.__testing.roleLlm(effortOnly, 'judge')).toEqual({
      providerOverride: undefined, modelOverride: undefined, effortOverride: 'max',
    });
  });

  it('routes one stage and role to an explicit specialist without changing other steps', () => {
    const routed = {
      currentStep: 'foundationGate',
      options: {
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
        judgeLlm: { modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
        stageLlm: {
          foundationGate: {
            creative: { modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh' },
          },
        },
      },
    };
    expect(autopilot.__testing.roleLlm(routed, 'creative')).toEqual({
      providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh',
    });
    expect(autopilot.__testing.roleLlm(routed, 'judge')).toEqual({
      providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-sol', effortOverride: 'xhigh',
    });
    routed.currentStep = 'generateEpisodes';
    expect(autopilot.__testing.roleLlm(routed, 'creative')).toEqual({
      providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
    });
  });

  it('does not carry a role model across a stage-level provider change', () => {
    const routed = {
      currentStep: 'foundationGate',
      options: {
        providerOverride: 'codex-tui', modelOverride: 'gpt-5.6-luna', effortOverride: 'max',
        stageLlm: { foundationGate: { creative: { providerOverride: 'ollama' } } },
      },
    };
    expect(autopilot.__testing.roleLlm(routed, 'creative')).toEqual({
      providerOverride: 'ollama', modelOverride: undefined, effortOverride: 'max',
    });
  });
});

// The precedence itself is covered by server/lib/seriesLlmOverride.test.js —
// what's specific here is that the autopilot delegates to it and renames the
// keys to the run-option ones.
describe('resolveAutopilotLlm — run provider/model resolution', () => {
  const series = { llm: { provider: 'codex', model: 'gpt-x' } };

  it('inherits the series llm under the run-option key names', () => {
    expect(autopilot.resolveAutopilotLlm({}, series))
      .toEqual({ providerOverride: 'codex', modelOverride: 'gpt-x' });
  });

  it('lets a per-run override win, dropping the series model when the provider differs', () => {
    expect(autopilot.resolveAutopilotLlm({ providerOverride: 'claude' }, series))
      .toEqual({ providerOverride: 'claude', modelOverride: undefined });
  });

  it('resolves to nothing with no series llm and no override (active provider downstream)', () => {
    expect(autopilot.resolveAutopilotLlm({}, null))
      .toEqual({ providerOverride: undefined, modelOverride: undefined });
  });

  it('stamps a per-run reasoning effort (#3641) — per-run only, nothing to inherit', () => {
    expect(autopilot.resolveAutopilotLlm({ effortOverride: 'high' }, series))
      .toEqual({ providerOverride: 'codex', modelOverride: 'gpt-x', effortOverride: 'high' });
    // No series-level effort exists, so a blank pick stays unset and each stage
    // falls through to its own pin, then the provider's configured args.
    expect(autopilot.resolveAutopilotLlm({ effortOverride: '' }, series).effortOverride).toBeUndefined();
  });
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
    // verifyArc: each round checks the whole arc + one volume, then resolves
    // between rounds → 3*(1+1)+2 = 8 — plus the per-finding isolation pass the
    // gate can escalate to inside a round (#3780): an attempt costs a resolve +
    // an arc verify + one volume verify = 3, so the 8-call budget buys 2 → +6.
    expect(byKind.verifyArc.estActions).toBe(14);
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
    expect(step).toMatchObject({ kind: 'textStages', issueId: 'iss1' });
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
    expect(step).toMatchObject({ kind: 'textStages', issueId: 'iss1' });
  });

  it('asks for structural script verify once comic script is ready', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true },
    );
    expect(step).toMatchObject({ kind: 'scriptVerify', issueId: 'iss1' });
  });

  it('asks for editorial review once all issues are script-checked', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']) },
    );
    expect(step.kind).toBe('editorialReview');
  });

  it('refreshes the reverse outline after editorial review, before editorial checks (#1349)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('reverseOutline');
  });

  it('asks for editorial checks once the reverse outline is refreshed (#1349)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('editorialChecks');
  });

  it('runs the editorial health gate after both editorial passes (#1316)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('editorialHealthGate');
  });

  it('is done once the editorial health gate is clean (no visuals requested)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('done');
  });

  it('is done (no canon/visual) when target is text, even on a comic series', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: true, target: 'text' },
    );
    expect(step.kind).toBe('done');
  });

  it('asks for canon verify before visuals when includeVisual', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true },
      { includeVisual: true },
    );
    expect(step.kind).toBe('canonVerify');
  });

  it('asks for visual draft once canon is verified and pages are not rendered', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true },
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
      { arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true },
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
  const fullyReady = { arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, reverseOutlineRefreshed: true, editorialChecksReviewed: true, editorialHealthReady: true, canonVerified: true };

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

describe('resolveAutopilotUnlockForRun (config gate)', () => {
  it('defaults OFF — it mutates lock state the user set by hand', () => {
    expect(autopilot.resolveAutopilotUnlockForRun({})).toBe(false);
    expect(autopilot.resolveAutopilotUnlockForRun({ unlockForRun: false })).toBe(false);
  });
  it('is on only when the run explicitly asks for it', () => {
    expect(autopilot.resolveAutopilotUnlockForRun({ unlockForRun: true })).toBe(true);
  });
  // The one autopilot option with NO persisted default: `seriesAutopilotScheduler`
  // resolves unattended runs from the settings slice, so a saved value would arm
  // lock-clearing on every scheduled run of every series.
  it('ignores a persisted setting entirely — per-run only', () => {
    expect(autopilot.resolveAutopilotUnlockForRun({}, { pipelineEditorialChecks: { unlockForRun: true } })).toBe(false);
  });
});

describe('resolveAutopilotAutoSelectModels (config gate)', () => {
  it('defaults off, supports a saved default, and lets a run override it', () => {
    expect(autopilot.resolveAutopilotAutoSelectModels({}, null)).toBe(false);
    expect(autopilot.resolveAutopilotAutoSelectModels({}, { pipelineEditorialChecks: { autoSelectModels: true } })).toBe(true);
    expect(autopilot.resolveAutopilotAutoSelectModels(
      { autoSelectModels: false },
      { pipelineEditorialChecks: { autoSelectModels: true } },
    )).toBe(false);
  });
});

// Persistable (unlike unlockForRun): it re-routes spend but mutates nothing,
// and the scheduler resolves unattended runs from this same settings slice.
describe('resolveAutopilotOverrideStagePins (config gate)', () => {
  it('defaults off, supports a saved default, and lets a run override it', () => {
    expect(autopilot.resolveAutopilotOverrideStagePins({}, null)).toBe(false);
    expect(autopilot.resolveAutopilotOverrideStagePins({}, { pipelineEditorialChecks: { overrideStagePins: true } })).toBe(true);
    expect(autopilot.resolveAutopilotOverrideStagePins(
      { overrideStagePins: false },
      { pipelineEditorialChecks: { overrideStagePins: true } },
    )).toBe(false);
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

describe('resolveAutopilotSelfImprove (config gate)', () => {
  const { resolveAutopilotSelfImprove } = autopilot;

  it('defaults OFF', () => {
    expect(resolveAutopilotSelfImprove({}, null)).toBe(false);
  });
  it('per-run option wins over the persisted setting', () => {
    expect(resolveAutopilotSelfImprove({ selfImprove: true }, { pipelineEditorialChecks: { selfImprove: false } })).toBe(true);
    expect(resolveAutopilotSelfImprove({ selfImprove: false }, { pipelineEditorialChecks: { selfImprove: true } })).toBe(false);
  });
  it('falls back to the persisted setting when no per-run option', () => {
    expect(resolveAutopilotSelfImprove({}, { pipelineEditorialChecks: { selfImprove: true } })).toBe(true);
  });
});

// CWQE Phase 7 (#2171) — iterate-to-quality revision loop.
describe('resolveAutopilotRevision (config gate, #2171)', () => {
  const {
    resolveAutopilotRevision,
    DEFAULT_REVISION_MIN_CYCLES,
    DEFAULT_REVISION_MAX_CYCLES,
    DEFAULT_REVISION_PLATEAU_DELTA,
  } = autopilot;

  it('defaults OFF with the module cycle defaults', () => {
    expect(resolveAutopilotRevision({}, null)).toEqual({
      revisionEnabled: false,
      revisionMinCycles: DEFAULT_REVISION_MIN_CYCLES,
      revisionMaxCycles: DEFAULT_REVISION_MAX_CYCLES,
      revisionPlateauDelta: DEFAULT_REVISION_PLATEAU_DELTA,
    });
  });
  it('per-run option wins over the persisted setting', () => {
    const r = resolveAutopilotRevision(
      { revisionEnabled: true, revisionMaxCycles: 4, revisionPlateauDelta: 0.5 },
      { pipelineEditorialChecks: { revisionEnabled: false, revisionMaxCycles: 2 } },
    );
    expect(r.revisionEnabled).toBe(true);
    expect(r.revisionMaxCycles).toBe(4);
    expect(r.revisionPlateauDelta).toBe(0.5);
  });
  it('falls back to the persisted setting when no per-run option', () => {
    const r = resolveAutopilotRevision({}, { pipelineEditorialChecks: { revisionEnabled: true, revisionMinCycles: 2 } });
    expect(r.revisionEnabled).toBe(true);
    expect(r.revisionMinCycles).toBe(2);
  });
  it('clamps maxCycles up to at least minCycles (misconfig can never strand the loop)', () => {
    const r = resolveAutopilotRevision({ revisionMinCycles: 3, revisionMaxCycles: 1 });
    expect(r.revisionMaxCycles).toBe(3);
  });
  it('floors minCycles at 1 and plateauDelta at 0', () => {
    const r = resolveAutopilotRevision({ revisionMinCycles: 0, revisionPlateauDelta: -5 });
    expect(r.revisionMinCycles).toBe(1);
    expect(r.revisionPlateauDelta).toBe(0);
  });
});

describe('resolveNextStep — revision cycle ordering (#2171)', () => {
  const comic = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
  const issue = (over = {}) => ({ id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {}, ...over });
  // Health-clean base runState (everything up to and including the health gate).
  const healthClean = {
    arcVerified: true, foundationGated: true, beatContinuityChecked: true, scriptChecked: new Set(['iss1']),
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

describe('meanQualityScore (#2171)', () => {
  const { meanQualityScore } = autopilot.__testing;
  it('averages only judged, finite scores', () => {
    expect(meanQualityScore({ scores: [
      { judged: true, qualityScore: 6 },
      { judged: true, qualityScore: 8 },
      { judged: false, qualityScore: null },
    ] })).toBe(7);
  });
  it('is null when nothing is judged', () => {
    expect(meanQualityScore({ scores: [{ judged: false, qualityScore: null }] })).toBe(null);
    expect(meanQualityScore({ scores: [] })).toBe(null);
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
      expect.arrayContaining(['verifyArcSpine', 'verifyArc', 'editorialReview']),
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
    expect(final.completed.editorialReview).toBe(1);
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
    locksUnlocked: false,
    characterFoundationEstablished: false, arcAttempted: false, arcSpineVerified: false, arcVerified: false, foundationGated: false, beatContinuityChecked: false,
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
      case 'unlockLocks':
        runState.locksUnlocked = true;
        break;
      case 'characterFoundation':
        runState.characterFoundationEstablished = true;
        break;
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
      case 'verifyArcSpine':
        runState.arcSpineVerified = true;
        break;
      case 'foundationGate':
        runState.foundationGated = true;
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
    { name: 'comic + unlock-for-run pre-pass', series: baseComic(), issues: bareIssue(), options: { unlockForRun: true } },
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

describe('isIsolatedFixSafe (pure per-finding patch acceptance, #3780)', () => {
  const { isIsolatedFixSafe } = autopilot;
  const f = (problem, location = 'V1', severity = 'high') => ({ severity, location, problem });
  const target = f('volume 1 and volume 2 both stage the first eclipse');
  const other = f('mentor subplot never pays off', 'V3');

  it('keeps a patch that closed its target and left the rest alone', () => {
    expect(isIsolatedFixSafe(target, [target, other], [other])).toBe(true);
  });

  it('keeps an even trade — the target gone, one equally-severe finding in its place', () => {
    // Same shape the round loop's checkpoint already accepts: a tie can be real
    // causal progress, and the divergence guard catches a gate that only trades.
    expect(isIsolatedFixSafe(target, [target, other], [other, f('finale hook is unresolved', 'V4')])).toBe(true);
  });

  it('rejects a patch that only RE-WORDED its target', () => {
    // The verifier restates a standing defect freely; treating fresh prose as
    // closure would bank a patch that fixed nothing and keep its collateral.
    expect(isIsolatedFixSafe(target, [target, other], [
      f('the first eclipse is staged twice — once in each opening volume', 'Volume 2 opening'),
    ])).toBe(false);
  });

  it('rejects a patch that grew the blocking set', () => {
    expect(isIsolatedFixSafe(target, [target, other], [
      other, f('finale hook is unresolved', 'V4'), f('timeline of the siege runs backwards', 'V6'),
    ])).toBe(false);
  });

  it('rejects a same-size swap that made the set MORE severe', () => {
    // Count alone can't see this one: a `medium` traded for a `high` is a worse
    // draft at the same size. Judged by the SAME `isBlockingSetRegression` the
    // whole-round rollback guard uses, so a trade the round tier would revert is
    // never banked by the isolation tier instead.
    const mediumTarget = f('volume 1 and volume 2 both stage the first eclipse', 'V1', 'medium');
    expect(isIsolatedFixSafe(
      mediumTarget,
      [mediumTarget, f('pacing sags mid-volume', 'V2', 'medium')],
      [f('pacing sags mid-volume', 'V2', 'medium'), f('protagonist goal vanishes', 'V5', 'high')],
    )).toBe(false);
  });

  it('keeps a same-size swap that made the set LESS severe', () => {
    // The mirror of the case above — trading a `high` down to a `medium` at an
    // unchanged count is progress, not a regression.
    expect(isIsolatedFixSafe(
      target,
      [target, other],
      [other, f('pacing sags mid-volume', 'V2', 'medium')],
    )).toBe(true);
  });

  it('tolerates missing/garbage inputs', () => {
    expect(isIsolatedFixSafe(target, undefined, undefined)).toBe(true);
    expect(isIsolatedFixSafe(target, null, [target])).toBe(false);
  });
});

describe('isResolveRegression (pure resolve-round damage check)', () => {
  const { isResolveRegression, sameFinding, findingTextOverlap } = autopilot;
  const f = (problem, location = 'V1', severity = 'high') => ({ severity, location, problem });

  it('flags a round that grew the blocking set while leaving what it targeted standing', () => {
    // The observed shape: one finding in, three out, the original still there.
    expect(isResolveRegression([f('both volumes stage the first eclipse')], [
      f('both volumes stage the first eclipse'),
      f('volume 3 drops the mentor subplot', 'V3'),
      f('finale hook never pays off', 'V4'),
    ])).toBe(true);
  });

  it('lets a round stand when it closed everything it targeted, even if latent findings surfaced', () => {
    // Growth alone is not damage — this round did its job and exposed work that
    // was already there. The divergence guard picks it up if the loop stalls.
    expect(isResolveRegression([f('both volumes stage the first eclipse')], [
      f('volume 3 drops the mentor subplot', 'V3'),
      f('finale hook never pays off', 'V4'),
    ])).toBe(false);
  });

  it('never flags a round that held the line or improved', () => {
    const before = [f('a'), f('b', 'V2')];
    expect(isResolveRegression(before, before)).toBe(false);          // stalled → divergence guard's job
    expect(isResolveRegression(before, [f('a')])).toBe(false);        // improved
    expect(isResolveRegression(before, [])).toBe(false);              // cleared
  });

  it('tolerates missing/garbage inputs', () => {
    expect(isResolveRegression(undefined, undefined)).toBe(false);
    expect(isResolveRegression(null, [f('a')])).toBe(false);
  });

  it('still flags the regression when the verifier PARAPHRASES the finding it left standing', () => {
    // The failure mode that let the observed 1 → 3 → 5 divergence through: the
    // second verify call restates the same defect in its own words and at a
    // re-labelled location. A prose fingerprint reads that as a brand-new
    // finding, concludes the round closed what it targeted, and commits the
    // damage. Identity has to survive the re-wording.
    expect(isResolveRegression(
      [f('volume 1 and volume 2 both stage the first eclipse', 'Volume 1 → Volume 2')],
      [
        f('the eclipse is presented as a first-time event in two separate volumes', 'Volume 2 opening'),
        f('mentor subplot never pays off', 'V3'),
        f('finale hook is unresolved', 'V4'),
      ],
    )).toBe(true);
  });

  it('matches a restatement that only re-words the OPENING clause', () => {
    // The narrow shape a leading-prefix fingerprint misses: same defect, same
    // place, but the verifier opens the sentence differently on the second call.
    expect(sameFinding(
      f('the mentor subplot introduced in the opening never pays off', 'V3'),
      f('nothing ever pays off the mentor subplot introduced in the opening', 'V3'),
    )).toBe(true);
  });

  it('matches a re-punctuated, re-cased, re-pluralized restatement', () => {
    expect(sameFinding(
      { severity: 'high', location: 'V1', problem: 'Both volumes stage the first eclipse.' },
      { severity: 'medium', location: 'v1', problem: 'both   volume stages the first eclipse' },
    )).toBe(true);
  });

  it('does not fuse two findings that merely share the structural vocabulary', () => {
    // "volume"/"episode"/"arc" appear in nearly every finding — they must not be
    // what makes two of them look like one, or the guard reverts good rounds.
    expect(findingTextOverlap('volume 3 drops the mentor subplot', 'volume 3 has no ticking clock'))
      .toBeLessThan(0.4);
    expect(sameFinding(f('the mentor subplot is dropped', 'V3'), f('the finale hook is unresolved', 'V4')))
      .toBe(false);
    // A single shared word is a coincidence, not an identity: both of these
    // reduce to {fix} once the structural nouns are dropped, which would
    // otherwise score a perfect 1.0 containment.
    expect(sameFinding(f('fix volume 3', 'volume 3'), f('fix arc one', 'arc one'))).toBe(false);
  });

  it('needs the PROBLEM to agree — a shared location alone is not one finding', () => {
    // Two genuinely different defects routinely sit in the same volume. Fusing
    // them would revert a round that closed what it targeted and merely exposed
    // something else next door — the over-strict rollback this guard must avoid.
    expect(sameFinding(f('the eclipse is staged twice', 'volume 3'), f('the mentor never returns', 'volume 3')))
      .toBe(false);
    // Naming the same place only LOWERS how much of the prose has to agree.
    expect(sameFinding(
      f('the eclipse is staged twice across the opening volumes', 'volume 3'),
      f('eclipse staged as a first-time event in two places, and the mentor thread also stalls here', 'volume 3 — act two'),
    )).toBe(true);
    // Whole-word location containment: a label can't swallow a longer one that
    // starts the same way.
    expect(sameFinding(f('x', 'V1'), f('y', 'V10'))).toBe(false);
    expect(sameFinding(f('x', 'volume 3'), f('y', 'volume 30'))).toBe(false);
  });
});

describe('isTargetedPatchRegression (bounded exact-text damage check)', () => {
  const { isTargetedPatchRegression } = autopilot;
  const f = (problem, location = 'V1', severity = 'medium') => ({ severity, location, problem });

  it('keeps a sparse patch that closed its target when an exhaustive judge exposes unrelated latent blockers', () => {
    expect(isTargetedPatchRegression(
      [f('the recovery order expires before the mandatory rest completes')],
      [
        f('the destination tow has no established local route', 'V3', 'high'),
        f('the inherited seal kit has no supplier setup', 'V2'),
      ],
    )).toBe(false);
  });

  it('rejects a sparse patch when its target survives alongside new blockers or returns more severe', () => {
    const target = f('the recovery order expires before the mandatory rest completes');
    expect(isTargetedPatchRegression([target], [
      target,
      f('the inherited seal kit has no supplier setup', 'V2'),
    ])).toBe(true);
    expect(isTargetedPatchRegression([target], [
      f('mandatory recovery outlasts the resource order', 'V1', 'high'),
    ])).toBe(true);
  });
});

describe('isBlockingSetRegression (arc rollback ordering)', () => {
  const { isBlockingSetRegression } = autopilot;
  const f = (severity, problem) => ({ severity, problem, location: 'V1' });

  it('rejects an equal-count candidate whose severity mix got worse', () => {
    expect(isBlockingSetRegression(
      [f('high', 'recovery chronology'), f('medium', 'stale milestone')],
      [f('high', 'new canon violation'), f('high', 'stale milestone')],
    )).toBe(true);
  });

  it('keeps an equal-count candidate whose severity mix improved or held', () => {
    const before = [f('high', 'canon violation'), f('medium', 'stale milestone')];
    expect(isBlockingSetRegression(before, [
      f('medium', 'narrower handoff'), f('medium', 'stale milestone'),
    ])).toBe(false);
    expect(isBlockingSetRegression(before, before)).toBe(false);
  });

  it('preserves blocker count as the primary ordering signal', () => {
    expect(isBlockingSetRegression(
      [f('high', 'one blocker')],
      [f('medium', 'first blocker'), f('medium', 'second blocker')],
    )).toBe(true);
    expect(isBlockingSetRegression(
      [f('medium', 'first blocker'), f('medium', 'second blocker')],
      [f('high', 'one blocker')],
    )).toBe(false);
  });

  it('tolerates missing inputs', () => {
    expect(isBlockingSetRegression(undefined, undefined)).toBe(false);
    expect(isBlockingSetRegression(undefined, [f('high', 'new blocker')])).toBe(true);
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
      return { issues: verifyFindings };
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
      return { issues: verifyFindings };
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
    modelRecommendations = {
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
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
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
    volumeVerifyFindings = [{ severity: 'high', problem: 'the midpoint promise never pays off', location: 'issue 3' }];
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
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
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
    volumeVerifyFindings = [{ severity: 'high', problem: 'the midpoint promise never pays off', location: 'issue 3' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 2 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.scope).toBe('verifyArc');
    expect(arcSpies.resolveVerifyIssues).toHaveBeenCalledTimes(1);
    expect(arcSpies.resolveVerifyIssues.mock.calls[0][1]).toMatchObject({ spineOnly: false });
  });

  // Foundation-quality gate (#2176).
  it('foundation gate: a clean foundation (default mock ≥ threshold) passes through to completion', async () => {
    foundationScore = 10;
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
    foundationScore = 3; // below the 7.5 default threshold every round
    foundationFixApplied = true;
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
    foundationScore = 3;
    foundationFixApplied = true;
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
    foundationScore = 3;
    foundationFixApplied = true;
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
    foundationScore = 8.5;
    foundationDimensionScores = { worldbuilding: 10, character: 5, structure: 10, craft: 10 };
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 2 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('foundationGate');
    expect(last?.reason).toMatch(/character below the 6 dimension floor/);
    expect(applyFoundationFix).toHaveBeenCalledWith(seriesId, 'character', expect.any(Object));
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
    const snapshot = (weightedScore) => ({
      seriesId: 'ser-example', status: 'complete', weightedScore,
      dimensions: {
        worldbuilding: { score: 8, gap: 'The active-node evidence rule is undefined.', fix: 'Define it.' },
        character: { score: 7, gap: 'Aruun privacy is mislabeled as a relapse.', fix: 'Separate privacy from safety disclosure.' },
        structure: { score: 6, gap: 'The charter handoff is thin.', fix: 'Stage the handoff.' },
        craft: { score: 7, gap: 'The panel grammar is thin.', fix: 'Add panel rules.' },
      },
    });
    judgeFoundation
      .mockImplementationOnce(async () => snapshot(7.2))
      .mockImplementationOnce(async () => snapshot(7.1));
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
    readFoundationCharacterBlanks.mockResolvedValueOnce(25).mockResolvedValueOnce(0);

    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 3 });
    await waitFor(runFinished(seriesId));

    expect(restoreFoundationState).not.toHaveBeenCalled();
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(applyFoundationFix.mock.calls.map(([, dimension]) => dimension)).toEqual(['character', 'character']);
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
    foundationScore = 3;
    foundationFixApplied = false; // owning service can't apply a fix
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
    foundationScore = 7;
    foundationDimensionScores = { worldbuilding: 8, character: 8, structure: 3, craft: 8 };
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
    expect(recordModelOutcome).toHaveBeenCalledWith('structure-reverted', expect.objectContaining({
      role: 'creative', stage: 'foundationGate', outcome: 'rejected', target: 'structure',
    }));
    expect(recordModelOutcome).not.toHaveBeenCalledWith('structure-reverted', expect.objectContaining({ outcome: 'invalid' }));
  });

  it('foundation gate: an inapplicable fix with nothing reverted reports no discarded set', async () => {
    foundationScore = 3;
    foundationFixApplied = false;
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxFoundationRounds: 3 });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.discardedFindings).toEqual([]);
  });

  it('foundation gate: a repair that throws pauses the run instead of erroring it away', async () => {
    foundationScore = 3;
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
    foundationScore = 3;
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { foundationGate: false });
    await waitFor(runFinished(seriesId));
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
    expect(judgeFoundation).not.toHaveBeenCalled();
  });

  // Per-series blocking-severity sets (#1616).
  it('arc gate: default blocks a medium finding (pauses)', async () => {
    verifyFindings = [{ severity: 'medium', problem: 'soft beat', location: 'V1' }];
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { maxArcVerifyRounds: 1 });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('verifyArcSpine');
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

  it('persists run-local visual and gap choices for a paused resume', async () => {
    editorialFindings = [{ severity: 'high', problem: 'missing scene', issueNumber: 1 }];
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
    editorialFindings = [{ severity: 'high', problem: 'missing scene', issueNumber: 1 }];
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
    expect(series.autopilot?.progress?.currentStep).toBe('editorialReview');
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
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
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
    verifyFindings = [{ severity: 'high', problem: 'plot hole', location: 'V1' }];
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

  it('backfills drawn canon from prose before pausing visual production', async () => {
    const { seriesId, issueId } = await seedComplete();
    await seriesSvc.updateSeries(seriesId, { universeId: 'uni-1' });
    await issuesSvc.updateStage(issueId, 'prose', ready('Kai wears a patched saffron pressure coat with a cracked brass respirator.'));
    const noun = { id: 'c1', name: 'Kai', kind: 'character', locked: false };
    canonReady = false;
    canonUndescribed = [noun];
    canonBlockingIssues = [{ issueId, number: 1, title: 'I1', none: [noun] }];

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
    userTasks = [{
      id: 'task-stale', status: 'pending',
      description: `Autopilot foundationGate-stalled gap — series ${seriesId}\n\npaused`,
      metadata: { autopilotGapSeriesId: seriesId },
    }];
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(userTasks[0].status).toBe('completed');
    expect(userTasks[0].metadata.resolution).toBe('auto-expired');
    expect(userTasks[0].metadata.autoExpiredReason).toBe('autopilot-resumed');
  });

  it('retires a legacy gap task that predates the autopilotGapSeriesId tag', async () => {
    const { seriesId } = await seedComplete();
    userTasks = [{
      id: 'task-legacy', status: 'pending',
      description: `Autopilot foundationGate-stalled gap — series ${seriesId}\n\npaused`,
      metadata: {},
    }];
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(userTasks[0].status).toBe('completed');
  });

  it('leaves in-progress gap tasks and other series alone', async () => {
    const { seriesId } = await seedComplete();
    userTasks = [
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
    expect(userTasks.map((t) => t.status)).toEqual(['in_progress', 'pending', 'pending']);
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
    expect(addTask.mock.calls[0][0].description).toMatch(/verifyArcSpine-stalled/);
  });

  // `metadata.app` is workspace routing, not a feature tag: it must name a
  // record in data/apps.json. Filing these at 'pipeline' made every gap task
  // unspawnable once prepareAgentWorkspace started refusing an app that
  // resolves to no repo path (#3180) — the task was filed, then blocked.
  it('files gap tasks with no app so they run in the PortOS workspace', async () => {
    verifyFindings = [{ severity: 'high', problem: 'unresolved plot hole' }];
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
    verifyFindings = [{ severity: 'high', problem: 'unresolved plot hole' }];
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
    foundationScore = 5;
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
