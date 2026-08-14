/**
 * `runSeriesReview` orchestration — the concurrency + SSE-frame contract (#4108).
 *
 * The main `seriesReview.test.js` suite covers the pure composition helpers; this
 * one drives the whole runner with every collaborator stubbed, so it can assert
 * the two properties the parallelization has to preserve:
 *
 *   1. the seed→read chain stays strictly sequential (feedback-seed →
 *      checks-seed → health/getReview), and
 *   2. the foundation judge + canon readiness actually OVERLAP the editorial
 *      checks pass rather than bracketing it — including that a failure in one
 *      still fails the verdict closed and never surfaces as an unhandled
 *      rejection.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'series-review-run-test-'));

vi.mock('../../lib/fileUtils.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

// Every collaborator is a PARTIAL mock (spread the actual module first) — the
// pipeline modules re-export constants to each other, so a bare factory breaks
// an unrelated transitive import rather than this suite's subject.
// A function DECLARATION, not a const — `vi.mock` calls are hoisted above the
// module body, so a const initializer would not have run yet.
function partial(overrides) {
  return async (importActual) => ({ ...(await importActual()), ...overrides });
}

vi.mock('./series.js', partial({ getSeries: vi.fn(async () => ({ id: 'ser-test', severityWeights: null })) }));
vi.mock('./issues.js', partial({ listIssues: vi.fn(async () => []) }));
vi.mock('../settings.js', partial({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../../lib/stageRunner.js', partial({ runStageScopedInlineLLM: vi.fn(async () => ({ content: {} })) }));

// The four passes whose interleaving this suite is about. Each appends to the
// shared `order` log so the test can read the real execution sequence.
const order = [];
vi.mock('./foundationJudge.js', partial({ judgeFoundation: vi.fn() }));
vi.mock('./canonReadiness.js', partial({ checkSeriesCanonReadiness: vi.fn() }));
vi.mock('./editorial/checkRunner.js', partial({ runEditorialChecks: vi.fn() }));
vi.mock('./editorialScore.js', partial({ getSeriesHealth: vi.fn() }));
vi.mock('./manuscriptReview.js', partial({ getReview: vi.fn(), seedReviewFromFindings: vi.fn() }));
// The fix runner's autonomy gate. An empty config leaves the cos domain off, so
// `runSeriesFix` rejects immediately and writes nothing — the coalescing tests
// below only care about which starts reach a run at all.
vi.mock('../cosState.js', partial({ loadState: vi.fn(async () => ({ config: {} })) }));

const { judgeFoundation } = await import('./foundationJudge.js');
const { checkSeriesCanonReadiness } = await import('./canonReadiness.js');
const { runEditorialChecks } = await import('./editorial/checkRunner.js');
const { getSeriesHealth } = await import('./editorialScore.js');
const { getReview, seedReviewFromFindings } = await import('./manuscriptReview.js');
const { getSeries } = await import('./series.js');
const { listIssues } = await import('./issues.js');
const {
  runSeriesReview, getSeriesReview,
  startSeriesReviewRun, startSeriesFixRun, isSeriesReviewActive, isSeriesFixActive,
} = await import('./seriesReview.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

const tick = (n = 1) => Array.from({ length: n }).reduce((p) => p.then(() => {}), Promise.resolve());

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  judgeFoundation.mockImplementation(async () => {
    order.push('foundation:start');
    await tick(4);
    order.push('foundation:end');
    return { weightedScore: 9, dimensions: {}, oneLineVerdict: 'fine', weakest: null, stale: false };
  });
  checkSeriesCanonReadiness.mockImplementation(async () => {
    order.push('canon:start');
    await tick(2);
    order.push('canon:end');
    return { ready: true, blockingIssues: [], undescribed: [] };
  });
  runEditorialChecks.mockImplementation(async () => {
    order.push('checks:start');
    await tick(6);
    order.push('checks:end');
    return { findings: [], perCheck: [], canceled: false };
  });
  getSeriesHealth.mockImplementation(async () => {
    order.push('health');
    return { score: 100, ready: true, open: 0, openBySeverity: {}, gate: 'clean' };
  });
  getReview.mockImplementation(async () => {
    order.push('getReview');
    return { comments: [] };
  });
  seedReviewFromFindings.mockImplementation(async () => {
    order.push('feedback:seed');
    return { comments: [] };
  });
});

const run = (opts = {}) => runSeriesReview('ser-test', opts);

describe('runSeriesReview — pass concurrency (#4108)', () => {
  it('overlaps the foundation judge and canon readiness with the editorial checks pass', async () => {
    const result = await run();
    expect(result.verdict).toBe('ready');
    // All three are in flight together: both background passes start before the
    // checks pass ends, and the checks pass starts before either finishes.
    expect(order.indexOf('foundation:start')).toBeLessThan(order.indexOf('checks:end'));
    expect(order.indexOf('canon:start')).toBeLessThan(order.indexOf('checks:end'));
    expect(order.indexOf('checks:start')).toBeLessThan(order.indexOf('foundation:end'));
    expect(order.indexOf('checks:start')).toBeLessThan(order.indexOf('canon:end'));
  });

  it('keeps the seed→read chain sequential: feedback-seed → checks-seed → health/getReview', async () => {
    await run({ feedback: 'the middle sags' });
    expect(order.indexOf('feedback:seed')).toBeLessThan(order.indexOf('checks:start'));
    expect(order.indexOf('checks:end')).toBeLessThan(order.indexOf('health'));
    expect(order.indexOf('checks:end')).toBeLessThan(order.indexOf('getReview'));
  });

  it('still carries every dimension into the verdict payload', async () => {
    const result = await run();
    expect(result.foundation).toMatchObject({ weightedScore: 9 });
    expect(result.canon).toMatchObject({ ready: true });
    expect(result.health).toMatchObject({ score: 100, ready: true });
    expect(result.failedStages).toEqual([]);
    expect(result.incomplete).toBe(false);
  });
});

describe('runSeriesReview — SSE frames under interleaving', () => {
  it('emits both background step:start frames before the checks pass starts', async () => {
    const frames = [];
    await run({ onProgress: (e) => frames.push(e) });
    const kinds = frames.filter((f) => f.type === 'step:start').map((f) => f.kind);
    expect(kinds).toEqual(['foundation', 'canon', 'editorialChecks', 'health']);
  });

  it('pairs every step:start with exactly one step:complete', async () => {
    const frames = [];
    await run({ feedback: 'note', onProgress: (e) => frames.push(e) });
    const starts = frames.filter((f) => f.type === 'step:start').map((f) => f.kind).sort();
    const completes = frames.filter((f) => f.type === 'step:complete').map((f) => f.kind).sort();
    expect(starts).toEqual(completes);
    expect(starts).toEqual(['canon', 'editorialChecks', 'feedback', 'foundation', 'health'].sort());
  });

  it('carries the settled values on the background step:complete frames', async () => {
    const frames = [];
    await run({ onProgress: (e) => frames.push(e) });
    expect(frames.find((f) => f.type === 'step:complete' && f.kind === 'foundation')).toMatchObject({ weightedScore: 9, failed: false });
    expect(frames.find((f) => f.type === 'step:complete' && f.kind === 'canon')).toMatchObject({ ready: true, failed: false });
  });

  // A failed canon pass produced NO result, so its frame must not announce
  // `ready: true` — `null?.ready !== false` is true, which would tell the UI the
  // opposite of what the verdict concludes.
  it('never reports a failed background pass as ready/scored', async () => {
    judgeFoundation.mockRejectedValue(new Error('provider down'));
    checkSeriesCanonReadiness.mockRejectedValue(new Error('canon blew up'));
    const frames = [];
    await run({ onProgress: (e) => frames.push(e) });
    expect(frames.find((f) => f.type === 'step:complete' && f.kind === 'canon')).toMatchObject({ ready: false, failed: true });
    expect(frames.find((f) => f.type === 'step:complete' && f.kind === 'foundation')).toMatchObject({ weightedScore: null, failed: true });
  });
});

describe('runSeriesReview — failure and cancellation paths', () => {
  it('fails the verdict closed when the foundation judge throws, in a stable stage order', async () => {
    judgeFoundation.mockRejectedValue(new Error('provider down'));
    checkSeriesCanonReadiness.mockRejectedValue(new Error('canon blew up'));
    const result = await run();
    expect(result.verdict).toBe('issues');
    expect(result.incomplete).toBe(true);
    expect(result.failedStages).toEqual(['foundation', 'canon']);
    expect(result.foundation).toBeNull();
    expect(result.canon).toBeNull();
  });

  it('reports a whole-pass editorial-checks failure without losing the background passes', async () => {
    runEditorialChecks.mockRejectedValue(new Error('context build failed'));
    const result = await run();
    expect(result.failedStages).toEqual(['editorialChecks']);
    expect(result.foundation).toMatchObject({ weightedScore: 9 });
    expect(result.canon).toMatchObject({ ready: true });
  });

  it('spends nothing when the run is already canceled at entry', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await run({ signal: controller.signal });
    expect(result).toBeNull();
    expect(judgeFoundation).not.toHaveBeenCalled();
    expect(checkSeriesCanonReadiness).not.toHaveBeenCalled();
    expect(runEditorialChecks).not.toHaveBeenCalled();
  });

  it('returns null on a canceled run only after the background passes have settled', async () => {
    const controller = new AbortController();
    runEditorialChecks.mockImplementation(async () => {
      order.push('checks:start');
      controller.abort();
      order.push('checks:end');
      return { findings: [], perCheck: [], canceled: true };
    });
    const result = await run({ signal: controller.signal });
    expect(result).toBeNull();
    // Both background passes ran to completion before the null return, so no
    // progress frame can land after the SSE wrapper's `canceled` frame.
    expect(order).toContain('foundation:end');
    expect(order).toContain('canon:end');
  });

  // The hazard the kicked-off-early/awaited-late shape introduces: when the MAIN
  // flow throws, it returns without ever awaiting the background tasks — so a
  // background task that also rejected would surface as an unhandled rejection
  // (fatal on Node ≥15). `runSeriesReview` attaches a catch at kickoff to make
  // that impossible.
  it('never leaves an unhandled background rejection when the main flow throws', async () => {
    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    // `onProgress` is caller-supplied (the SSE broadcast) — a throw from it
    // rejects the background task AND aborts the main flow at the same time.
    const err = await run({
      onProgress: (e) => { if (e.kind === 'foundation' || e.kind === 'editorialChecks') throw new Error('broadcast failed'); },
    }).catch((e) => e);
    // `unhandledRejection` fires when the microtask queue drains, so wait a full
    // macrotask — a microtask-only `tick()` would report a clean run either way.
    await new Promise((r) => setTimeout(r, 10));
    process.off('unhandledRejection', onUnhandled);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('broadcast failed');
    expect(unhandled).toEqual([]);
  });
});

/**
 * The reviewed-source fingerprint (#4111) end to end: a run pins what it
 * reviewed, and the GET recomputes it so a manuscript/canon/foundation edit made
 * through ANY other path invalidates the stored verdict — not just accepting or
 * dismissing a finding.
 */
describe('getSeriesReview — reviewed-source staleness (#4111)', () => {
  const issueWith = (prose) => ({ id: 'iss-1', seriesId: 'ser-test', number: 1, seasonId: null, title: 'One', stages: { prose: { output: prose } } });
  const SERIES = { id: 'ser-test', severityWeights: null };
  const openFinding = { id: 'c1', status: 'open', severity: 'high', issueNumber: 1, problem: 'the middle sags' };

  beforeEach(() => {
    getSeries.mockResolvedValue({ ...SERIES });
    listIssues.mockResolvedValue([issueWith('the original draft')]);
  });

  // The default mocks the rest of the suite relies on.
  afterAll(() => {
    getSeries.mockResolvedValue({ ...SERIES });
    listIssues.mockResolvedValue([]);
  });

  it('stamps the fingerprint on the run and reports the unchanged verdict as fresh', async () => {
    const result = await run();
    expect(typeof result.sourceInputsHash).toBe('string');
    const { review } = await getSeriesReview('ser-test');
    expect(review.sourceInputsHash).toBe(result.sourceInputsHash);
    expect(review.stale).toBe(false);
    expect(review.staleReason).toBeNull();
  });

  it("flips stale with reason 'sources' when the manuscript was edited after the review", async () => {
    await run();
    listIssues.mockResolvedValue([issueWith('a completely rewritten draft')]);
    const { review } = await getSeriesReview('ser-test');
    expect(review.stale).toBe(true);
    expect(review.staleReason).toBe('sources');
  });

  it("keeps the findings-divergence signal working alongside it ('findings')", async () => {
    await run();
    getReview.mockResolvedValue({ comments: [openFinding] });
    const { review } = await getSeriesReview('ser-test');
    expect(review.stale).toBe(true);
    expect(review.staleReason).toBe('findings');
  });

  it("reports 'both' when the findings AND the sources moved", async () => {
    await run();
    getReview.mockResolvedValue({ comments: [openFinding] });
    listIssues.mockResolvedValue([issueWith('a completely rewritten draft')]);
    const { review } = await getSeriesReview('ser-test');
    expect(review.stale).toBe(true);
    expect(review.staleReason).toBe('both');
  });

  it('never source-flags a pre-#4111 snapshot that carries no pinned hash', async () => {
    await run();
    const snapshotFile = join(TEST_DATA_ROOT, 'pipeline-series-review', 'ser-test.json');
    const stored = JSON.parse(readFileSync(snapshotFile, 'utf8'));
    delete stored.sourceInputsHash;
    writeFileSync(snapshotFile, JSON.stringify(stored));
    listIssues.mockResolvedValue([issueWith('a completely rewritten draft')]);
    const { review } = await getSeriesReview('ser-test');
    expect(review.stale).toBe(false);
    expect(review.staleReason).toBeNull();
  });

  // The run's OWN issues read failed, so the verdict was computed against an
  // empty list. Silently re-reading here would pin a hash for issues this
  // verdict never saw — and every later GET would then read "fresh".
  it('does not pin a fingerprint computed from a failed issues read, even if a re-read would succeed', async () => {
    listIssues.mockRejectedValueOnce(new Error('store unavailable'));
    listIssues.mockResolvedValue([issueWith('the original draft')]);
    const result = await run();
    expect(result.sourceInputsHash).toBeNull();
  });

  it('does not report a verdict stale when the findings store itself could not be read', async () => {
    await run();
    getReview.mockRejectedValue(new Error('review store unavailable'));
    const { review } = await getSeriesReview('ser-test');
    expect(review.stale).toBe(false);
    expect(review.staleReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Signature-based coalescing on the SSE runners (#4113).
//
// Before this, ANY second start while a run was in flight was attached to it and
// its own feedback/provider/force/gate (or, for the fix pass, its finding set)
// was silently dropped — the caller got the running run's id back and bound its
// success handler to a verdict computed from someone else's options.
// ---------------------------------------------------------------------------

// The background run is fire-and-forget, so let the event loop drain until the
// runner reports the key idle (bounded, so a hang fails the test rather than the
// suite). A finished run lingers in the map for its replay window but is no
// longer `active`, which is exactly the state the restart assertions need.
const settle = async (isActive, key) => {
  for (let i = 0; i < 500 && isActive(key); i += 1) await new Promise((r) => setTimeout(r, 0));
  expect(isActive(key)).toBe(false);
};

describe('startSeriesReviewRun — conflicting start options (#4113)', () => {
  it('coalesces a second start that would run the SAME review', async () => {
    const first = startSeriesReviewRun('ser-same', { feedback: 'the middle sags' });
    const second = startSeriesReviewRun('ser-same', { feedback: 'the middle sags' });
    expect(second).toEqual({ runId: first.runId, alreadyRunning: true });
    expect(second.conflict).toBeUndefined();
    await settle(isSeriesReviewActive, 'ser-same');
    // One coordinator, not two.
    expect(runEditorialChecks).toHaveBeenCalledTimes(1);
  });

  it('reports a conflict for a start carrying a DIFFERENT note instead of dropping it', async () => {
    const first = startSeriesReviewRun('ser-note', { feedback: 'the middle sags' });
    const second = startSeriesReviewRun('ser-note', { feedback: 'the ending lands flat' });
    expect(second).toMatchObject({ runId: first.runId, alreadyRunning: true, conflict: true });
    await settle(isSeriesReviewActive, 'ser-note');
    // The conflicting start never became a second run — and its note was never
    // seeded, which is the whole point of refusing it out loud.
    expect(runEditorialChecks).toHaveBeenCalledTimes(1);
    expect(seedReviewFromFindings).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a provider override', { providerOverride: 'example-provider' }],
    ['force', { force: true }],
    ['a readiness gate', { readinessGate: 'noOpenHighOrMedium' }],
  ])('reports a conflict for a start carrying %s', async (label, options) => {
    const key = `ser-opt-${label.replace(/[^a-z]/gi, '')}`;
    startSeriesReviewRun(key, {});
    expect(startSeriesReviewRun(key, options)).toMatchObject({ alreadyRunning: true, conflict: true });
    await settle(isSeriesReviewActive, key);
  });

  it('starts a fresh run for divergent options once the first has finished', async () => {
    const first = startSeriesReviewRun('ser-after', {});
    await settle(isSeriesReviewActive, 'ser-after');
    // The finished run is still in its replay window — it must NOT report a
    // conflict, it must be replaced.
    const second = startSeriesReviewRun('ser-after', { force: true });
    expect(second.alreadyRunning).toBe(false);
    expect(second.conflict).toBeUndefined();
    expect(second.runId).not.toBe(first.runId);
    await settle(isSeriesReviewActive, 'ser-after');
    expect(runEditorialChecks).toHaveBeenCalledTimes(2);
  });
});

describe('startSeriesFixRun — conflicting start options (#4113)', () => {
  it('coalesces a second start over the same finding set', async () => {
    const first = startSeriesFixRun('ser-fix-same', { commentIds: ['mrc-1', 'mrc-2'] });
    // Same set, different order — the same work.
    const second = startSeriesFixRun('ser-fix-same', { commentIds: ['mrc-2', 'mrc-1'] });
    expect(second).toEqual({ runId: first.runId, alreadyRunning: true });
    await settle(isSeriesFixActive, 'ser-fix-same');
  });

  it('reports a conflict for a start scoped to a DIFFERENT finding set', async () => {
    const first = startSeriesFixRun('ser-fix-diff', { commentIds: ['mrc-1'] });
    const second = startSeriesFixRun('ser-fix-diff', { commentIds: ['mrc-1', 'mrc-2'] });
    expect(second).toMatchObject({ runId: first.runId, alreadyRunning: true, conflict: true });
    await settle(isSeriesFixActive, 'ser-fix-diff');
  });
});
