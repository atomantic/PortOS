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

const llmCalls = [];

vi.mock('../providers.js', () => ({
  getActiveProvider: vi.fn(async () => ({
    id: 'mock-provider',
    name: 'Mock',
    type: 'api',
    defaultModel: 'mock-model',
  })),
  getProviderById: vi.fn(async (id) => (id === 'mock-provider' ? {
    id, name: 'Mock', type: 'api', defaultModel: 'mock-model',
  } : null)),
}));

vi.mock('../runner.js', () => ({
  createRun: vi.fn(async () => ({ runId: `run-${++uuidCounter}` })),
  // Stub executeApiRun: call onData with a canned response immediately, then
  // onComplete with success. Mirrors what worldBuilderExpand.test.js doesn't
  // need to do (it mocks the upstream expander), but we test the lower-level
  // text-stage runner here.
  executeApiRun: vi.fn(async (runId, provider, model, prompt, _cwd, _shots, onData, onComplete) => {
    llmCalls.push({ runId, provider: provider.id, model, prompt });
    onData('## Beat sheet\n1. Setup ...\n');
    onComplete({ success: true });
  }),
  executeCliRun: vi.fn(),
}));

vi.mock('../promptService.js', () => ({
  // Don't truncate — the prior-stages assertion looks at the rendered ctx.
  buildPrompt: vi.fn(async (stageName, ctx) => `RENDERED:${stageName}:${JSON.stringify(ctx)}`),
}));

const issuesSvc = await import('./issues.js');
const seriesSvc = await import('./series.js');
const textStages = await import('./textStages.js');

describe('pipeline text stage generator', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    llmCalls.length = 0;
    vi.clearAllMocks();
  });

  async function seed() {
    const series = await seriesSvc.createSeries({
      name: 'Salt Run',
      logline: 'A foundry city goes silent.',
      premise: 'Salt-mining city on a dying tideflat.',
      styleNotes: 'moebius linework',
      characters: [{ name: 'Lina', description: 'foundry surveyor' }],
    });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, title: 'The Hush' });
    return { series, issue };
  }

  it('generateStage moves a stage idle → ready and persists output + runId', async () => {
    const { issue } = await seed();
    const result = await textStages.generateStage(issue.id, 'idea', { seedInput: 'foundry mystery' });
    expect(result.stage.status).toBe('ready');
    expect(result.stage.output).toContain('Beat sheet');
    expect(result.stage.lastRunId).toMatch(/^run-/);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0].prompt).toContain('RENDERED:pipeline-idea-expansion');
  });

  it('stage prompt context includes only PRIOR stages', async () => {
    const { issue } = await seed();
    // Fill idea + prose, then run comicScript. Context should include both
    // earlier stages but NOT tvScript (parallel) and NOT comicScript itself.
    await issuesSvc.updateStage(issue.id, 'idea', { status: 'ready', output: 'BEATS' });
    await issuesSvc.updateStage(issue.id, 'prose', { status: 'ready', output: 'PROSE' });
    await issuesSvc.updateStage(issue.id, 'tvScript', { status: 'ready', output: 'TVS' });
    await textStages.generateStage(issue.id, 'comicScript');
    const promptArg = llmCalls[0].prompt;
    expect(promptArg).toContain('idea');
    expect(promptArg).toContain('prose');
    // Context only carries stages BEFORE comicScript in TEXT_STAGE_IDS order;
    // tvScript comes AFTER comicScript and must not appear.
    expect(promptArg).not.toContain('TVS');
  });

  it('marks stage as error and rethrows when LLM rejects', async () => {
    const { issue } = await seed();
    const runner = await import('../runner.js');
    runner.executeApiRun.mockImplementationOnce(async (runId, _p, _m, _prompt, _cwd, _shots, _onData, onComplete) => {
      onComplete({ error: 'simulated provider 500' });
    });
    await expect(textStages.generateStage(issue.id, 'idea')).rejects.toThrow(/simulated provider 500/);
    const after = await issuesSvc.getIssue(issue.id);
    expect(after.stages.idea.status).toBe('error');
    expect(after.stages.idea.errorMessage).toContain('simulated provider 500');
  });

  it('rejects unsupported stage ids', async () => {
    const { issue } = await seed();
    await expect(textStages.generateStage(issue.id, 'comicPages')).rejects.toThrow(/unsupported stageId/);
  });
});
