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
const checkRunnerSpies = {
  runEditorialChecks: vi.fn(async () => ({ runId: 'ec', findings: [], perCheck: [], canceled: false })),
  buildEditorialCheckPlan: vi.fn(async () => ({ seriesId: 's', checks: [], enabledCount: 0, consumesReverseOutline: reverseOutlineConsumed })),
  enabledChecksConsumeReverseOutline: vi.fn(() => reverseOutlineConsumed),
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
  reverseOutlineState = { status: 'complete', stale: false };
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
