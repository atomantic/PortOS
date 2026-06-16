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
let editorialFindings = [];
const arcSpies = {
  generateArcOverview: vi.fn(async () => ({ arc: { logline: 'A', summary: 'S' }, seasons: [] })),
  commitSeasonsWithRemap: vi.fn(async (series) => ({ series })),
  generateSeasonEpisodes: vi.fn(async () => ({ episodes: [] })),
  commitEpisodesToIssues: vi.fn(async () => []),
  verifyArc: vi.fn(async () => ({ issues: verifyFindings })),
  resolveVerifyIssues: vi.fn(async () => ({ applied: true })),
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

// Real services + the unit under test (imported AFTER the mocks above).
const seriesSvc = await import('./series.js');
const seasonsSvc = await import('./seasons.js');
const issuesSvc = await import('./issues.js');
const autopilot = await import('./seriesAutopilot.js');
const { resolveNextStep, requiredScriptStages, scriptStructurallyReady, visualReady } = autopilot;

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
  editorialFindings = [];
  scriptVerifyFindings = [];
  canonReady = true;
  canonUndescribed = [];
  nextTaskId = 0;
  autopilot.__testing.runs.clear();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Pure resolver — the highest-value unit (no I/O, table-driven).
// ---------------------------------------------------------------------------
describe('resolveNextStep (pure)', () => {
  const comic = { targetFormat: 'comic', arc: { logline: 'L', summary: 'S' }, seasons: [{ id: 'se1', number: 1 }] };
  const issue = (over = {}) => ({ id: 'iss1', seasonId: 'se1', number: 1, arcPosition: 1, stages: {}, ...over });

  it('asks for arc generation when there is no arc', () => {
    expect(resolveNextStep({ targetFormat: 'comic', seasons: [] }, []).kind).toBe('generateArc');
  });

  it('treats a present arc summary (no logline) as having an arc', () => {
    const step = resolveNextStep({ targetFormat: 'comic', arc: { summary: 'S' }, seasons: [] }, []);
    expect(step.kind).not.toBe('generateArc');
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

  it('asks for text stages once beats exist but scripts do not', () => {
    const step = resolveNextStep(comic, [issue({ stages: { idea: ready() } })], { arcVerified: true });
    expect(step).toMatchObject({ kind: 'textStages', issueId: 'iss1' });
  });

  it('asks for structural script verify once comic script is ready', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true },
    );
    expect(step).toMatchObject({ kind: 'scriptVerify', issueId: 'iss1' });
  });

  it('asks for editorial review once all issues are script-checked', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, scriptChecked: new Set(['iss1']) },
    );
    expect(step.kind).toBe('editorialReview');
  });

  it('is done once editorial review has run (no visuals requested)', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, scriptChecked: new Set(['iss1']), editorialReviewed: true },
      { includeVisual: false },
    );
    expect(step.kind).toBe('done');
  });

  it('is done (no canon/visual) when target is text, even on a comic series', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, scriptChecked: new Set(['iss1']), editorialReviewed: true },
      { includeVisual: true, target: 'text' },
    );
    expect(step.kind).toBe('done');
  });

  it('asks for canon verify before visuals when includeVisual', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, scriptChecked: new Set(['iss1']), editorialReviewed: true },
      { includeVisual: true },
    );
    expect(step.kind).toBe('canonVerify');
  });

  it('asks for visual draft once canon is verified and pages are not rendered', () => {
    const step = resolveNextStep(
      comic,
      [issue({ stages: { idea: ready(), comicScript: ready(VALID_SCRIPT) } })],
      { arcVerified: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, canonVerified: true },
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
        pages: [{ panels: [{ description: 'x' }], proofImage: { jobId: 'p0' } }],
      },
    };
    const step = resolveNextStep(
      comic,
      [issue({ stages: renderedStages })],
      { arcVerified: true, scriptChecked: new Set(['iss1']), editorialReviewed: true, canonVerified: true },
      { includeVisual: true },
    );
    expect(step.kind).toBe('done');
  });

  it('does not run script verify for a tv-only target', () => {
    const tv = { targetFormat: 'tv', arc: { logline: 'L' }, seasons: [{ id: 'se1', number: 1 }] };
    const step = resolveNextStep(
      tv,
      [issue({ stages: { idea: ready(), teleplay: ready() } })],
      { arcVerified: true },
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

  it('passes a parseable comic script and fails an unparseable one', () => {
    expect(scriptStructurallyReady({ stages: { comicScript: ready(VALID_SCRIPT) } })).toBe(true);
    expect(scriptStructurallyReady({ stages: { comicScript: ready('just some prose, no pages') } })).toBe(false);
    expect(scriptStructurallyReady({ stages: {} })).toBe(false);
  });
});

describe('visualReady', () => {
  it('is false with no pages, true once cover + all paneled pages are enqueued', () => {
    expect(visualReady({ stages: { comicPages: { pages: [] } } })).toBe(false);
    // pages but cover not enqueued
    expect(visualReady({ stages: { comicPages: { pages: [{ panels: [{}], proofImage: { jobId: 'p' } }] } } })).toBe(false);
    // cover + page enqueued
    expect(visualReady({
      stages: { comicPages: { cover: { proofImage: { jobId: 'c' } }, pages: [{ panels: [{}], proofImage: { jobId: 'p' } }] } },
    })).toBe(true);
  });

  it('does not block on a page that has no panels', () => {
    expect(visualReady({
      stages: { comicPages: { cover: { finalImage: { filename: 'c.png' } }, pages: [{ panels: [] }] } },
    })).toBe(true);
  });

  it('requires an authored back cover to be enqueued', () => {
    expect(visualReady({
      stages: { comicPages: { cover: { proofImage: { jobId: 'c' } }, backCover: { script: 'back' }, pages: [{ panels: [{}], proofImage: { jobId: 'p' } }] } },
    })).toBe(false);
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

  it('proceeds to visuals once canon is ready', async () => {
    canonReady = true;
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true });
    await waitFor(runFinished(seriesId));
    expect(checkSeriesCanonReadiness).toHaveBeenCalled();
    expect(visualSpies.enqueueComicCover).toHaveBeenCalled();
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
  });

  it('pauses visual draft (no art) when the comic script does not parse into pages', async () => {
    const { seriesId } = await seedComplete({ script: 'just prose, no comic pages here' });
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: true });
    await waitFor(runFinished(seriesId));
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('paused');
    expect(last?.scope).toBe('visualDraft');
    expect(visualSpies.enqueueComicCover).not.toHaveBeenCalled();
  });

  it('does not render visuals when includeVisual is false', async () => {
    const { seriesId } = await seedComplete();
    await autopilot.startSeriesAutopilot(seriesId, { includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(visualSpies.enqueueComicCover).not.toHaveBeenCalled();
    expect(visualSpies.enqueueVisualComicPage).not.toHaveBeenCalled();
  });

  it('files a CoS gap task for an unparseable script when fileGaps is set', async () => {
    const { seriesId } = await seedComplete({ script: 'just prose, no comic pages here' });
    await autopilot.startSeriesAutopilot(seriesId, { fileGaps: true, includeVisual: false });
    await waitFor(runFinished(seriesId));
    expect(addTask).toHaveBeenCalled();
    const [taskData, taskType] = addTask.mock.calls[0];
    expect(taskType).toBe('user');
    expect(taskData.app).toBe('pipeline');
    expect(taskData.description).toMatch(/script-unparseable/);
    const last = autopilot.__testing.runs.get(seriesId)?.lastPayload;
    expect(last?.type).toBe('complete'); // gap filed, run still finishes
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
    expect(autopilot.__testing.runs.get(seriesId)?.lastPayload?.type).toBe('complete');
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
