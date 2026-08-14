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
import { mkdtempSync, rmSync } from 'fs';
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

const { judgeFoundation } = await import('./foundationJudge.js');
const { checkSeriesCanonReadiness } = await import('./canonReadiness.js');
const { runEditorialChecks } = await import('./editorial/checkRunner.js');
const { getSeriesHealth } = await import('./editorialScore.js');
const { getReview, seedReviewFromFindings } = await import('./manuscriptReview.js');
const { runSeriesReview } = await import('./seriesReview.js');

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
    expect(frames.find((f) => f.type === 'step:complete' && f.kind === 'foundation')).toMatchObject({ weightedScore: 9 });
    expect(frames.find((f) => f.type === 'step:complete' && f.kind === 'canon')).toMatchObject({ ready: true });
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
