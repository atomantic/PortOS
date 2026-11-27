/**
 * Shared mocks and fixtures for the series autopilot orchestrator suites.
 * Split from seriesAutopilot.test.js (#16214).
 *
 * `vi.mock` calls are hoisted per test file, so each suite declares them and
 * delegates the factories here. Values the tests reassign (`cosMode`,
 * `verifyFindings`, ...) live on the exported `state` object because an ES
 * module binding cannot be reassigned from the importing file.
 */
import { vi } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../../lib/mockPathsDataRoot.js';

// ---- File-backed store (like autoRunner.test.js) so the REAL series/issues
// services run against an in-memory map instead of Postgres. ------------------
export const fileStore = new Map();
export const patchRunMetadata = vi.fn(async () => {});
export const runnerFactory = async (importOriginal) => ({
  ...(await importOriginal()),
  patchRunMetadata,
});
export const fileUtilsFactory = async () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data', cos: '/mock/data/cos' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
});

export const cryptoFactory = async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++state.uuidCounter}` };
};

// textStages imports identity; keep these runs independent of this install's identity file.
export const instanceIdentityFactory = () => ({ getInstanceId: vi.fn(async () => 'test-instance'), UNKNOWN_INSTANCE_ID: 'unknown' });
export const instancesFactory = () => mockNoPeers();
export const peerSyncFactory = () => mockNoPeerSync();

// Values the tests reassign between runs; reset in resetFixtures().
export const state = {
  uuidCounter: 0,
  cosMode: 'execute',
  budgetStatus: { withinBudget: true, exceeded: null },
  verifyFindings: [],
  volumeVerifyFindings: [],
  beatContinuityFindings: [],
  editorialFindings: [],
  // Drives whether the reverse-outline refresh step (#1349) thinks a scene-consuming
  // check is enabled. Default false so the existing conductor runs skip it cheaply.
  reverseOutlineConsumed: false,
  // Gate-aware (#1614) signal: drives the consumption check when a gateCtx is
  // passed (the autopilot's Gate 3). `null` = mirror the sources-only signal, so
  // every pre-#1614 test keeps its existing behavior.
  reverseOutlineConsumedGated: null,
  // Drives the perCheck array the editorial-checks pass sees, so a test can inject
  // an errored check and assert it surfaces in the run summary (#1573).
  editorialChecksPerCheck: [],
  // Drives the findings the editorial-checks pass returns, so a test can inject
  // high-severity findings and assert the optional pause gate fires (#1613).
  editorialChecksFindings: [],
  // Reverse outline (#1349) — controllable staleness.
  reverseOutlineState: { status: 'complete', stale: false },
  nextTaskId: 0,
  // Backing store for the gap-task retirement path (clearGapTasks). Tests seed
  // `userTasks` with whatever the queue should already hold when a run starts.
  userTasks: [],
  scriptVerifyFindings: [],
  canonReady: true,
  canonUndescribed: [],
  canonBlockingIssues: [],
  // Foundation-quality gate (#2176). Drive the judged weighted score + the fix
  // router per test. Default: a clean foundation (10) so the gate passes on the
  // first round and existing downstream-step tests are unaffected.
  foundationScore: 10,
  foundationDimensionScores: null,
  foundationFixApplied: true,
  // Learned routing (`autoSelectModels`) reads the run history through this
  // report. Mocked so a test can hand the run a recommendation and assert which
  // roles it is allowed to re-point.
  modelRecommendations: {},
};

// ---- Controllable test doubles for the autonomy + LLM-calling deps. ----------
export const cosStateFactory = () => ({
  loadState: vi.fn(async () => ({ config: { domainAutonomy: { cos: state.cosMode } } })),
});

export const recordDomainUsage = vi.fn(async () => {});
export const domainUsageFactory = () => ({
  getDomainBudgetStatus: vi.fn(async () => state.budgetStatus),
  recordDomainUsage,
});

// arcPlanner: keep the REAL barrel (for compareIssuesByPosition) and override
// only the LLM-calling passes with spies whose return values the tests drive.
export const arcSpies = {
  generateArcOverview: vi.fn(async () => ({ arc: { logline: 'A', summary: 'S' }, seasons: [] })),
  commitSeasonsWithRemap: vi.fn(async (series) => ({ series })),
  generateSeasonEpisodes: vi.fn(async () => ({ episodes: [] })),
  commitEpisodesToIssues: vi.fn(async () => []),
  verifyArc: vi.fn(async () => ({ issues: state.verifyFindings })),
  verifyVolume: vi.fn(async () => ({ issues: state.volumeVerifyFindings })),
  resolveVerifyIssues: vi.fn(async () => ({ applied: true })),
  // Resolve-round rollback. The real snapshot/restore pair is covered
  // against the store in arcPlanner.test.js; here they're stubbed so the
  // conductor tests assert the LOOP's decision — when a round gets reverted.
  snapshotArcState: vi.fn(async (sId) => ({ seriesId: sId, arc: null, seasons: [], episodes: [] })),
  restoreArcState: vi.fn(async () => ({ restored: true, episodesRestored: 0, reassignedIssueCount: 0 })),
  analyzeBeatContinuity: vi.fn(async () => ({ issues: state.beatContinuityFindings })),
  resolveBeatContinuity: vi.fn(async () => ({ applied: true, episodesResolved: [] })),
  analyzeManuscriptCompleteness: vi.fn(async () => ({ issues: state.editorialFindings, runId: 'run-comp' })),
};
export const arcPlannerFactory = async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...arcSpies };
};

export const volumeBeatsSpies = {
  startVolumeBeatsRun: vi.fn(async () => ({ runId: 'vb', alreadyRunning: false })),
  isVolumeBeatsRunActive: vi.fn(() => false),
  cancelVolumeBeatsRun: vi.fn(() => true),
};

export const autoRunnerSpies = {
  startAutoRunTextStages: vi.fn(async () => ({ runId: 'ar', alreadyRunning: false })),
  isAutoRunActive: vi.fn(() => false),
  cancelAutoRun: vi.fn(() => true),
};

export const manuscriptReviewFactory = () => ({
  seedReviewFromFindings: vi.fn(async () => ({ comments: [] })),
  getReview: vi.fn(async () => ({ comments: [] })),
});

export const checkRunnerSpies = {
  runEditorialChecks: vi.fn(async () => ({ runId: 'ec', findings: state.editorialChecksFindings, perCheck: state.editorialChecksPerCheck, canceled: false })),
  buildEditorialCheckPlan: vi.fn(async () => ({ seriesId: 's', checks: [], enabledCount: 0, consumesReverseOutline: state.reverseOutlineConsumed })),
  enabledChecksConsumeReverseOutline: vi.fn((settings, checkIds, gateCtx) =>
    (gateCtx != null && state.reverseOutlineConsumedGated !== null ? state.reverseOutlineConsumedGated : state.reverseOutlineConsumed)),
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

// A generate spy so a test can assert the refresh step regenerates only when
// stale and bills only then.
export const generateReverseOutline = vi.fn(async () => ({ status: 'complete', stale: false, scenes: [{ id: 'sc1' }] }));
export const reverseOutlineFactory = () => ({
  getReverseOutline: vi.fn(async (seriesId) => ({ seriesId, ...state.reverseOutlineState })),
  generateReverseOutline,
});

export const settingsFactory = async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: vi.fn(async () => ({})),
});

export const visualSpies = {
  enqueueComicCover: vi.fn(async () => ({ jobId: 'job-cover', prompt: 'p', variant: 'proof', fromProof: false })),
  enqueueComicBackCover: vi.fn(async () => ({ jobId: 'job-back', prompt: 'p', variant: 'proof', fromProof: false })),
  enqueueVisualComicPage: vi.fn(async (_issueId, { pageIndex }) => ({ jobId: `job-page-${pageIndex}`, prompt: 'p', variant: 'proof', fromProof: false })),
};

export const addTask = vi.fn(async () => ({ id: `task-gap-${++state.nextTaskId}` }));
export const getUserTasks = vi.fn(async () => ({ tasks: state.userTasks }));
export const updateTask = vi.fn(async (taskId, updates) => {
  const task = state.userTasks.find(t => t.id === taskId);
  if (!task) return { error: 'Task not found' };
  Object.assign(task, updates, { metadata: { ...task.metadata, ...updates.metadata } });
  return task;
});
const firstLine = (s) => (s || '').split('\n').map(l => l.trim()).find(l => l) || '';
export const cosTaskStoreFactory = () => ({ addTask, getUserTasks, updateTask, firstLine });

export const verifyComicScript = vi.fn(async () => ({ issues: state.scriptVerifyFindings }));
export const scriptVerifyFactory = () => ({ verifyComicScript });

export const checkSeriesCanonReadiness = vi.fn(async (seriesId) => ({
  seriesId, ready: state.canonReady, issues: [], blockingIssues: state.canonBlockingIssues, undescribed: state.canonUndescribed,
}));
export const canonReadinessFactory = () => ({ checkSeriesCanonReadiness });

export const describeCanonFromProse = vi.fn(async () => {
  state.canonReady = true;
  state.canonUndescribed = [];
  state.canonBlockingIssues = [];
  return { report: { filled: 1, none: [], skippedLocked: [] }, runId: 'run-canon-repair' };
});
export const universeCanonFactory = () => ({ describeCanonFromProse });

export const establishCharacterFoundation = vi.fn(async () => ({ applied: true, ran: true }));
export const judgeFoundation = vi.fn(async () => ({
  seriesId: 'ser-uuid-1', status: 'complete', weightedScore: state.foundationScore,
  dimensions: {
    worldbuilding: { score: state.foundationDimensionScores?.worldbuilding ?? state.foundationScore, gap: 'g', fix: 'f' },
    character: { score: state.foundationDimensionScores?.character ?? state.foundationScore, gap: 'g', fix: 'f' },
    structure: { score: state.foundationDimensionScores?.structure ?? state.foundationScore, gap: 'g', fix: 'f' },
    craft: { score: state.foundationDimensionScores?.craft ?? state.foundationScore, gap: 'g', fix: 'f' },
  },
  weakest: 'worldbuilding',
}));
export const applyFoundationFix = vi.fn(async (_sId, dimension) => ({ dimension, applied: state.foundationFixApplied }));
export const snapshotFoundationState = vi.fn(async (seriesId) => ({ seriesId, marker: 'foundation-checkpoint' }));
export const restoreFoundationState = vi.fn(async () => ({ restored: true, episodesRestored: 0 }));
// The two objective, LLM-free measures behind the character arm's tie-breaker.
// Default: an unchanged cast (the checkpoint read and the post-repair read
// agree), so a tie stays a tie unless a test says the repair moved one of them.
export const readFoundationCharacterProgress = vi.fn(async () => ({ blanks: 0, integrityFindings: 0 }));
export const foundationJudgeFactory = async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    judgeFoundation: (...args) => judgeFoundation(...args),
    applyFoundationFix: (...args) => applyFoundationFix(...args),
    establishCharacterFoundation: (...args) => establishCharacterFoundation(...args),
    snapshotFoundationState: (...args) => snapshotFoundationState(...args),
    restoreFoundationState: (...args) => restoreFoundationState(...args),
    readFoundationCharacterProgress: (...args) => readFoundationCharacterProgress(...args),
  };
};

export const recordModelOutcome = vi.fn(async () => true);
export const getModelPerformanceReport = vi.fn(async () => ({ recommendations: state.modelRecommendations }));
export const modelPerformanceFactory = () => ({ recordModelOutcome, getModelPerformanceReport });

// Pause-escalation notifications (#1615) — spy on the notification center so a
// test can assert a pause posts a banner (and a clean run / opt-out does not).
export const addNotification = vi.fn(async () => ({ id: 'notif-1' }));
export const removeByMetadata = vi.fn(async () => ({ success: true, removed: 0 }));
export const notificationsFactory = () => ({
  addNotification,
  removeByMetadata,
  NOTIFICATION_TYPES: { AUTOPILOT_PAUSED: 'autopilot_paused' },
  PRIORITY_LEVELS: { HIGH: 'high', MEDIUM: 'medium', LOW: 'low', CRITICAL: 'critical' },
});

// A comic script string that parseComicScript turns into >=1 page/panel.
export const VALID_SCRIPT = 'PAGE 1\nPANEL 1\nA scene.';

export const ready = (output = 'x') => ({ status: 'ready', output });

export const waitFor = async (predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
};

// Services are imported lazily: this module loads before the suite's vi.mock
// registrations resolve, and the services must see the mocked fileUtils.
export const seedComplete = async ({ script = VALID_SCRIPT } = {}) => {
  const seriesSvc = await import('../series.js');
  const seasonsSvc = await import('../seasons.js');
  const issuesSvc = await import('../issues.js');
  const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P', targetFormat: 'comic' });
  await seriesSvc.updateSeries(series.id, { arc: { logline: 'A', summary: 'S' } });
  const season = await seasonsSvc.createSeason(series.id, { number: 1, title: 'V1' });
  const seasonId = season.id;
  const issue = await issuesSvc.createIssue({ seriesId: series.id, seasonId, title: 'I1', number: 1 });
  await issuesSvc.updateStage(issue.id, 'idea', ready('beats'));
  await issuesSvc.updateStage(issue.id, 'comicScript', ready(script));
  return { seriesId: series.id, seasonId, issueId: issue.id };
};

/** The `beforeEach` body shared by the orchestrator suites; takes the mocked bindings the suite imported. */
export const resetFixtures = ({ autopilot, getDomainBudgetStatus, getSettings }) => {
  fileStore.clear();
  state.uuidCounter = 0;
  state.cosMode = 'execute';
  state.budgetStatus = { withinBudget: true, exceeded: null };
  state.verifyFindings = [];
  state.volumeVerifyFindings = [];
  state.beatContinuityFindings = [];
  state.editorialFindings = [];
  state.scriptVerifyFindings = [];
  state.canonReady = true;
  state.canonUndescribed = [];
  state.canonBlockingIssues = [];
  state.foundationScore = 10;
  state.foundationDimensionScores = null;
  state.foundationFixApplied = true;
  establishCharacterFoundation.mockClear();
  state.reverseOutlineConsumed = false;
  state.reverseOutlineConsumedGated = null;
  state.reverseOutlineState = { status: 'complete', stale: false };
  state.editorialChecksPerCheck = [];
  state.editorialChecksFindings = [];
  state.nextTaskId = 0;
  state.userTasks = [];
  state.modelRecommendations = {};
  autopilot.__testing.runs.clear();
  vi.clearAllMocks();
  generateReverseOutline.mockImplementation(async () => ({ status: 'complete', stale: false, scenes: [{ id: 'sc1' }] }));
  // Reset the budget mock to read the `budgetStatus` var (clearAllMocks keeps
  // implementations, but a prior test may have set a call-count-keyed one).
  getDomainBudgetStatus.mockImplementation(async () => state.budgetStatus);
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
};
