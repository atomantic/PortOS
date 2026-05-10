import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

// Inline generator that flips the stage to ready without doing any real work.
// We're testing the coordinator, not the LLM call site.
const generated = [];
vi.mock('./textStages.js', async () => {
  const issuesSvc = await import('./issues.js');
  return {
    generateStage: vi.fn(async (issueId, stageId) => {
      generated.push(stageId);
      const { issue, stage } = await issuesSvc.updateStage(issueId, stageId, {
        status: 'ready',
        output: `OUTPUT-${stageId}`,
        lastRunId: `run-${stageId}`,
      });
      return { issue, stage, runId: `run-${stageId}` };
    }),
  };
});

const seriesSvc = await import('./series.js');
const issuesSvc = await import('./issues.js');
const autoRunner = await import('./autoRunner.js');

// Drain any in-flight microtasks/promises spawned by startAutoRunTextStages.
const flush = () => new Promise((r) => setImmediate(r));

const waitFor = async (predicate, { timeoutMs = 1000, intervalMs = 5 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
};

describe('pipeline auto-runner', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    generated.length = 0;
    // Clear the in-memory run map between tests.
    autoRunner.__testing.runs.clear();
    vi.clearAllMocks();
  });

  async function seed() {
    const series = await seriesSvc.createSeries({ name: 'Series', logline: 'L', premise: 'P' });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, title: 'Issue' });
    return { series, issue };
  }

  it('runs idea → prose → (comicScript + tvScript in parallel) end to end', async () => {
    const { issue } = await seed();
    const { runId, alreadyRunning } = await autoRunner.startAutoRunTextStages(issue.id);
    expect(runId).toBeTruthy();
    expect(alreadyRunning).toBe(false);

    await waitFor(() => generated.length === 4);
    // idea must come before prose (sequential); the two script stages may
    // resolve in either order but both must follow prose.
    expect(generated[0]).toBe('idea');
    expect(generated[1]).toBe('prose');
    expect(new Set(generated.slice(2))).toEqual(new Set(['comicScript', 'tvScript']));

    // Issue status flips to needs-review when all stages complete (user must
    // review before marking shipped).
    const final = await issuesSvc.getIssue(issue.id);
    expect(final.status).toBe('needs-review');
  });

  it('skips a stage that is already ready (no force)', async () => {
    const { issue } = await seed();
    await issuesSvc.updateStage(issue.id, 'idea', { status: 'ready', output: 'PREFILLED-IDEA' });
    await autoRunner.startAutoRunTextStages(issue.id);
    await waitFor(() => generated.length === 3);
    expect(generated).not.toContain('idea');
    expect(generated).toContain('prose');
    expect(generated).toContain('comicScript');
    expect(generated).toContain('tvScript');
  });

  it('reruns a ready stage when force=true', async () => {
    const { issue } = await seed();
    await issuesSvc.updateStage(issue.id, 'idea', { status: 'ready', output: 'PREFILLED-IDEA' });
    await autoRunner.startAutoRunTextStages(issue.id, { force: true });
    await waitFor(() => generated.length === 4);
    expect(generated).toContain('idea');
  });

  it('returns alreadyRunning=true on concurrent start', async () => {
    const { issue } = await seed();
    const first = await autoRunner.startAutoRunTextStages(issue.id);
    const second = await autoRunner.startAutoRunTextStages(issue.id);
    expect(second.alreadyRunning).toBe(true);
    expect(second.runId).toBe(first.runId);
    await waitFor(() => generated.length === 4);
  });

  it('cancelAutoRun stops the chain between stages', async () => {
    const { issue } = await seed();
    // Generator needs a real timer delay so the test can poll generated,
    // fire cancel, and have the coordinator's cancelRequested check land
    // BEFORE the next stage kicks off. setImmediate microtask yielding
    // isn't enough — vitest's setTimeout polling won't get a chance to run
    // between micro-tasks.
    const textStages = await import('./textStages.js');
    textStages.generateStage.mockImplementation(async (issueId, stageId) => {
      generated.push(stageId);
      await new Promise((r) => setTimeout(r, 50));
      const { issue: i, stage } = await issuesSvc.updateStage(issueId, stageId, {
        status: 'ready', output: `O-${stageId}`, lastRunId: `r-${stageId}`,
      });
      return { issue: i, stage, runId: `r-${stageId}` };
    });

    autoRunner.startAutoRunTextStages(issue.id);
    // Wait until at least the first stage starts, then cancel.
    await waitFor(() => generated.length >= 1);
    autoRunner.cancelAutoRun(issue.id);
    // Coordinator must broadcast a terminal frame (canceled or complete)
    // before we assert. `isAutoRunActive` stays true for the SSE cleanup
    // grace window (5s), so we read the broadcast frame directly.
    await waitFor(() => {
      const run = autoRunner.__testing.runs.get(issue.id);
      const t = run?.lastPayload?.type;
      return t === 'canceled' || t === 'complete' || t === 'error';
    });
    expect(generated.length).toBeLessThan(4);
    const finalRun = autoRunner.__testing.runs.get(issue.id);
    expect(finalRun?.lastPayload?.type).toBe('canceled');
  });
});
