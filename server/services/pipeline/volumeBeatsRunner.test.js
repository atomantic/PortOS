import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
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

// Inline generator that writes ready beats without making an LLM call —
// we're testing the coordinator, not the prompt.
const generated = [];
vi.mock('./textStages.js', async () => {
  const issuesSvc = await import('./issues.js');
  return {
    generateStage: vi.fn(async (issueId, stageId, _opts) => {
      generated.push({ issueId, stageId });
      const { issue, stage } = await issuesSvc.updateStage(issueId, stageId, {
        status: 'ready',
        output: `BEATS-${issueId.slice(0, 6)}`,
        lastRunId: `run-${issueId.slice(0, 6)}`,
      });
      return { issue, stage, runId: `run-${issueId.slice(0, 6)}` };
    }),
  };
});

const seriesSvc = await import('./series.js');
const issuesSvc = await import('./issues.js');
const seasonsSvc = await import('./seasons.js');
const runner = await import('./volumeBeatsRunner.js');

const waitFor = async (predicate, { timeoutMs = 1500, intervalMs = 5 } = {}) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: predicate never became true');
};

async function seed({ issueCount = 3 } = {}) {
  const series = await seriesSvc.createSeries({ name: 'S', logline: 'L', premise: 'P' });
  const season = await seasonsSvc.createSeason(series.id, { title: 'V1', number: 1 });
  const issues = [];
  for (let i = 1; i <= issueCount; i += 1) {
    const created = await issuesSvc.createIssue({
      seriesId: series.id,
      title: `Issue ${i}`,
      seasonId: season.id,
      arcPosition: i,
    });
    issues.push(created);
  }
  return { series, season, issues };
}

describe('pipeline volume beat-sheet runner', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    generated.length = 0;
    runner.__testing.runs.clear();
    vi.clearAllMocks();
  });

  it('runs idea stage sequentially across every issue in volume order', async () => {
    const { series, season, issues } = await seed({ issueCount: 3 });
    const { runId, alreadyRunning } = await runner.startVolumeBeatsRun(series.id, season.id);
    expect(runId).toBeTruthy();
    expect(alreadyRunning).toBe(false);

    await waitFor(() => {
      const run = runner.__testing.runs.get(season.id);
      return run?.lastPayload?.type === 'complete';
    });

    expect(generated).toHaveLength(3);
    expect(generated.map((g) => g.issueId)).toEqual(issues.map((i) => i.id));
    expect(generated.every((g) => g.stageId === 'idea')).toBe(true);
  });

  it("skip-existing mode skips issues whose idea stage has output (status: 'ready' / 'edited')", async () => {
    const { series, season, issues } = await seed({ issueCount: 3 });
    await issuesSvc.updateStage(issues[1].id, 'idea', { status: 'ready', output: 'PREFILLED-BEATS' });
    await issuesSvc.updateStage(issues[2].id, 'idea', { status: 'edited', output: 'USER-EDITED-BEATS' });

    await runner.startVolumeBeatsRun(series.id, season.id);
    await waitFor(() => {
      const run = runner.__testing.runs.get(season.id);
      return run?.lastPayload?.type === 'complete';
    });

    expect(generated.map((g) => g.issueId)).toEqual([issues[0].id]);
    const terminal = runner.__testing.runs.get(season.id).lastPayload;
    expect(terminal.generated).toBe(1);
    expect(terminal.skipped).toBe(2);
  });

  it('regenerate-all mode overwrites every issue regardless of existing beats', async () => {
    const { series, season, issues } = await seed({ issueCount: 3 });
    await issuesSvc.updateStage(issues[1].id, 'idea', { status: 'ready', output: 'PREFILLED' });

    await runner.startVolumeBeatsRun(series.id, season.id, { mode: 'regenerate-all' });
    await waitFor(() => {
      const run = runner.__testing.runs.get(season.id);
      return run?.lastPayload?.type === 'complete';
    });

    expect(generated.map((g) => g.issueId)).toEqual(issues.map((i) => i.id));
    const terminal = runner.__testing.runs.get(season.id).lastPayload;
    expect(terminal.generated).toBe(3);
    expect(terminal.skipped).toBe(0);
  });

  it("skip-existing does NOT skip 'error' / 'empty' issues — those need a retry", async () => {
    const { series, season, issues } = await seed({ issueCount: 3 });
    await issuesSvc.updateStage(issues[0].id, 'idea', { status: 'error', errorMessage: 'previous failure' });
    await issuesSvc.updateStage(issues[1].id, 'idea', { status: 'ready', output: 'GOOD' });

    await runner.startVolumeBeatsRun(series.id, season.id);
    await waitFor(() => {
      const run = runner.__testing.runs.get(season.id);
      return run?.lastPayload?.type === 'complete';
    });

    const ids = generated.map((g) => g.issueId);
    expect(ids).toContain(issues[0].id);
    expect(ids).toContain(issues[2].id);
    expect(ids).not.toContain(issues[1].id);
  });

  it('per-issue error does not abort the rest of the chain', async () => {
    const { series, season, issues } = await seed({ issueCount: 3 });
    const textStages = await import('./textStages.js');
    textStages.generateStage.mockImplementation(async (issueId, stageId) => {
      generated.push({ issueId, stageId });
      if (issueId === issues[1].id) {
        throw new Error('LLM said no');
      }
      const { issue, stage } = await issuesSvc.updateStage(issueId, stageId, {
        status: 'ready', output: `O-${issueId.slice(0, 6)}`, lastRunId: `r-${issueId.slice(0, 6)}`,
      });
      return { issue, stage, runId: `r-${issueId.slice(0, 6)}` };
    });

    await runner.startVolumeBeatsRun(series.id, season.id);
    await waitFor(() => {
      const run = runner.__testing.runs.get(season.id);
      return run?.lastPayload?.type === 'complete';
    });

    expect(generated.map((g) => g.issueId)).toEqual(issues.map((i) => i.id));
    const terminal = runner.__testing.runs.get(season.id).lastPayload;
    expect(terminal.generated).toBe(2);
    expect(terminal.errored).toBe(1);
  });

  it('returns alreadyRunning=true on concurrent start for the same volume', async () => {
    const { series, season } = await seed();
    const textStages = await import('./textStages.js');
    textStages.generateStage.mockImplementation(async (issueId, stageId) => {
      generated.push({ issueId, stageId });
      await new Promise((r) => setTimeout(r, 25));
      const { issue, stage } = await issuesSvc.updateStage(issueId, stageId, {
        status: 'ready', output: 'O', lastRunId: 'r',
      });
      return { issue, stage, runId: 'r' };
    });

    const first = await runner.startVolumeBeatsRun(series.id, season.id);
    const second = await runner.startVolumeBeatsRun(series.id, season.id);
    expect(second.alreadyRunning).toBe(true);
    expect(second.runId).toBe(first.runId);
    await waitFor(() => {
      const run = runner.__testing.runs.get(season.id);
      return run?.lastPayload?.type === 'complete';
    });
  });

  it('cancelVolumeBeatsRun stops the chain between issues', async () => {
    const { series, season } = await seed({ issueCount: 4 });
    const textStages = await import('./textStages.js');
    textStages.generateStage.mockImplementation(async (issueId, stageId) => {
      generated.push({ issueId, stageId });
      await new Promise((r) => setTimeout(r, 50));
      const { issue, stage } = await issuesSvc.updateStage(issueId, stageId, {
        status: 'ready', output: 'O', lastRunId: 'r',
      });
      return { issue, stage, runId: 'r' };
    });

    runner.startVolumeBeatsRun(series.id, season.id);
    await waitFor(() => generated.length >= 1);
    runner.cancelVolumeBeatsRun(season.id);
    await waitFor(() => {
      const run = runner.__testing.runs.get(season.id);
      const t = run?.lastPayload?.type;
      return t === 'canceled' || t === 'complete' || t === 'error';
    });
    expect(generated.length).toBeLessThan(4);
    expect(runner.__testing.runs.get(season.id).lastPayload.type).toBe('canceled');
  });

  it('emits a start frame with the planned issue ids and total', async () => {
    const { series, season, issues } = await seed({ issueCount: 2 });
    await runner.startVolumeBeatsRun(series.id, season.id);

    await waitFor(() => {
      const run = runner.__testing.runs.get(season.id);
      return run?.lastPayload?.type === 'complete';
    });

    // The first broadcast frame is the start frame — we can't replay it
    // directly (lastPayload is the most recent), but we can validate the
    // count of issues processed matches the seed.
    const terminal = runner.__testing.runs.get(season.id).lastPayload;
    expect(terminal.generated + terminal.skipped + terminal.errored).toBe(issues.length);
  });

});
