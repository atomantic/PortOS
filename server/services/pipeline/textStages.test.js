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
    enabled: true,
    defaultModel: 'mock-model',
  })),
  getProviderById: vi.fn(async (id) => (id === 'mock-provider' ? {
    id, name: 'Mock', type: 'api', enabled: true, defaultModel: 'mock-model',
  } : null)),
}));

vi.mock('../runner.js', () => ({
  createRun: vi.fn(async () => ({ runId: `run-${++uuidCounter}` })),
  // Stub executeApiRun: call onData with a canned response immediately, then
  // onComplete with success. Mirrors what universeBuilderExpand.test.js doesn't
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
  // stageRunner now reads stage.provider/stage.model — return null so it
  // falls through to the active provider in the mocked providers module.
  getStage: vi.fn(() => null),
}));

const issuesSvc = await import('./issues.js');
const seriesSvc = await import('./series.js');
const seasonsSvc = await import('./seasons.js');
const textStages = await import('./textStages.js');

// Strip the `RENDERED:<stage>:` prefix that the mocked buildPrompt prepends
// so the asserted-against context is the bare JSON tree.
const ctxFromCall = (call) => JSON.parse(call.prompt.replace(/^RENDERED:[^:]+:/, ''));

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
      characters: [{ name: 'Lina', physicalDescription: 'foundry surveyor' }],
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
    // earlier stages but NOT teleplay (parallel) and NOT comicScript itself.
    await issuesSvc.updateStage(issue.id, 'idea', { status: 'ready', output: 'BEATS' });
    await issuesSvc.updateStage(issue.id, 'prose', { status: 'ready', output: 'PROSE' });
    await issuesSvc.updateStage(issue.id, 'teleplay', { status: 'ready', output: 'TVS' });
    await textStages.generateStage(issue.id, 'comicScript');
    const promptArg = llmCalls[0].prompt;
    expect(promptArg).toContain('idea');
    expect(promptArg).toContain('prose');
    // Context only carries stages BEFORE comicScript in TEXT_STAGE_IDS order;
    // teleplay comes AFTER comicScript and must not appear.
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

  it('prompt context carries lengthTargets from a named non-default profile (extended)', async () => {
    const { series } = await seed();
    // Create an issue with the 'extended' profile — distinct from 'standard' so
    // any accidental fallback to standard is detectable via pageTarget (32 vs 22).
    const issue = await issuesSvc.createIssue({
      seriesId: series.id,
      title: 'The Surge',
      lengthProfile: 'extended',
    });
    await textStages.generateStage(issue.id, 'idea');
    const ctx = JSON.parse(llmCalls[0].prompt.replace(/^RENDERED:[^:]+:/, ''));
    const lt = ctx.lengthTargets;
    expect(lt.profile).toBe('extended');
    expect(lt.pageTarget).toBe(32);
    expect(lt.minutesTarget).toBe(36);
    expect(lt.proseWordsMin).toBe(4500);
    expect(lt.proseWordsMax).toBe(6500);
    expect(lt.beatsMin).toBe(12);
    expect(lt.beatsMax).toBe(16);
  });

  // ---- idea-stage context augment (arc / volume / neighbor) ----
  // Covers buildIdeaContextAugment via the public generateStage entry so we
  // exercise the same path the LLM caller hits, not an internal helper.

  it('idea context: omits arc / volume / neighbors when issue is ungrouped + series has no arc', async () => {
    const { issue } = await seed();
    await textStages.generateStage(issue.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.arc).toBe(null);
    expect(ctx.volume).toBe(null);
    expect(ctx.priorIssue).toBe(null);
    expect(ctx.nextIssue).toBe(null);
    expect(ctx.priorVolume).toBe(null);
    expect(ctx.positionInVolume).toBe(null);
    expect(ctx.arcRole).toBe(null);
  });

  it('idea context: surfaces arc block only when arc has generated text (shape-only arc is ignored)', async () => {
    const { series, issue } = await seed();
    // Shape-only arc — sanitizer preserves it but it carries no text. Must NOT
    // surface as `arc` context (the prompt asks for protagonist arc + themes).
    await seriesSvc.updateSeries(series.id, { arc: { shape: 'man-in-hole' } });
    await textStages.generateStage(issue.id, 'idea');
    expect(ctxFromCall(llmCalls[0]).arc).toBe(null);

    llmCalls.length = 0;
    await seriesSvc.updateSeries(series.id, {
      arc: { logline: 'whole-arc pitch', protagonistArc: 'falls and rises', themes: ['legacy'], shape: 'man-in-hole' },
    });
    await textStages.generateStage(issue.id, 'idea');
    const ctx2 = ctxFromCall(llmCalls[0]);
    expect(ctx2.arc).toMatchObject({
      logline: 'whole-arc pitch',
      protagonistArc: 'falls and rises',
      themesCsv: 'legacy',
    });
  });

  it('idea context: volume + position-in-volume + arcRole when issue is grouped', async () => {
    const { series } = await seed();
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'L' } });
    const sea = await seasonsSvc.createSeason(series.id, {
      title: 'V1', logline: 'volume logline', synopsis: 'volume synopsis',
      endingHook: 'the bridge falls', episodeCountTarget: 8,
    });
    const i1 = await issuesSvc.createIssue({
      seriesId: series.id, title: 'Pilot', seasonId: sea.id, arcPosition: 1, arcRole: 'pilot',
    });
    const i2 = await issuesSvc.createIssue({
      seriesId: series.id, title: 'Complication', seasonId: sea.id, arcPosition: 2, arcRole: 'complication',
    });
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'Midpoint', seasonId: sea.id, arcPosition: 3, arcRole: 'midpoint',
    });

    await textStages.generateStage(i2.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.volume).toMatchObject({
      number: sea.number,
      title: 'V1',
      logline: 'volume logline',
      endingHook: 'the bridge falls',
      episodeCountTarget: 8,
    });
    expect(ctx.arcRole).toBe('complication');
    expect(ctx.positionInVolume).toEqual({ ordinal: 2, total: 3 });
    expect(ctx.priorIssue).toMatchObject({ title: 'Pilot', arcRole: 'pilot', arcPosition: 1 });
    expect(ctx.nextIssue).toMatchObject({ title: 'Midpoint', arcRole: 'midpoint', arcPosition: 3 });
  });

  it('idea context: neighbor exposes beats when expanded, synopsis when not', async () => {
    const { series } = await seed();
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'L' } });
    const sea = await seasonsSvc.createSeason(series.id, { title: 'V1', logline: 'l' });
    // Prior issue: has expanded beats (idea.output filled).
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'Prior', seasonId: sea.id, arcPosition: 1,
      stages: { idea: { input: 'prior seed', output: 'beat 1\nbeat 2', status: 'ready' } },
    });
    // Current issue (the one we're generating beats for).
    const cur = await issuesSvc.createIssue({
      seriesId: series.id, title: 'Current', seasonId: sea.id, arcPosition: 2,
    });
    // Next issue: synopsis-only (idea.input only).
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'Next', seasonId: sea.id, arcPosition: 3,
      stages: { idea: { input: 'next synopsis only', status: 'edited' } },
    });

    await textStages.generateStage(cur.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.priorIssue).toMatchObject({ title: 'Prior', beats: expect.stringContaining('beat 1') });
    expect(ctx.priorIssue).not.toHaveProperty('synopsis');
    expect(ctx.nextIssue).toMatchObject({ title: 'Next', synopsis: 'next synopsis only' });
    expect(ctx.nextIssue).not.toHaveProperty('beats');
  });

  it('idea context: first issue of a volume sees priorVolume.endingHook, no priorIssue', async () => {
    const { series } = await seed();
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(series.id, {
      title: 'V1', logline: 'one', endingHook: 'the city ignites',
    });
    const v2 = await seasonsSvc.createSeason(series.id, { title: 'V2', logline: 'two' });
    // Issue in v1 to populate it (not the issue we're generating for).
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'V1 Ep 1', seasonId: v1.id, arcPosition: 1,
    });
    // First issue of v2 — should see priorVolume but no priorIssue.
    const v2head = await issuesSvc.createIssue({
      seriesId: series.id, title: 'V2 Ep 1', seasonId: v2.id, arcPosition: 1,
    });

    await textStages.generateStage(v2head.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.priorIssue).toBe(null);
    expect(ctx.priorVolume).toEqual({ number: v1.number, title: 'V1', endingHook: 'the city ignites' });
  });

  it('idea context: middle-of-volume issue has no priorVolume even if a prior volume exists', async () => {
    const { series } = await seed();
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'L' } });
    const v1 = await seasonsSvc.createSeason(series.id, { title: 'V1', endingHook: 'hook1' });
    const v2 = await seasonsSvc.createSeason(series.id, { title: 'V2' });
    await issuesSvc.createIssue({ seriesId: series.id, title: 'V1 Ep 1', seasonId: v1.id, arcPosition: 1 });
    await issuesSvc.createIssue({ seriesId: series.id, title: 'V2 Ep 1', seasonId: v2.id, arcPosition: 1 });
    const mid = await issuesSvc.createIssue({
      seriesId: series.id, title: 'V2 Ep 2', seasonId: v2.id, arcPosition: 2,
    });
    await textStages.generateStage(mid.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.priorVolume).toBe(null);
    expect(ctx.priorIssue).toMatchObject({ title: 'V2 Ep 1' });
  });

  it('idea context: last issue of a volume has no nextIssue', async () => {
    const { series } = await seed();
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'L' } });
    const sea = await seasonsSvc.createSeason(series.id, { title: 'V1' });
    await issuesSvc.createIssue({ seriesId: series.id, title: 'A', seasonId: sea.id, arcPosition: 1 });
    const last = await issuesSvc.createIssue({
      seriesId: series.id, title: 'B', seasonId: sea.id, arcPosition: 2,
    });
    await textStages.generateStage(last.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.nextIssue).toBe(null);
    expect(ctx.priorIssue).toMatchObject({ title: 'A' });
  });

  it('idea context: a regenerated issue sees the CURRENT state of neighbors, not the original', async () => {
    // Confirms the user's stated workflow: re-running beat generation on
    // issue N pulls whatever beats issue N+1 currently has, even if those
    // beats were written after the original generation of N.
    const { series } = await seed();
    await seriesSvc.updateSeries(series.id, { arc: { logline: 'L' } });
    const sea = await seasonsSvc.createSeason(series.id, { title: 'V1' });
    const a = await issuesSvc.createIssue({ seriesId: series.id, title: 'A', seasonId: sea.id, arcPosition: 1 });
    const b = await issuesSvc.createIssue({ seriesId: series.id, title: 'B', seasonId: sea.id, arcPosition: 2 });

    // First pass: A regenerated when B is empty.
    await textStages.generateStage(a.id, 'idea');
    expect(ctxFromCall(llmCalls[0]).nextIssue).toMatchObject({ title: 'B' });
    expect(ctxFromCall(llmCalls[0]).nextIssue).not.toHaveProperty('beats');

    // Now fill B with beats and regenerate A — the new context for A must
    // include B's beats, not the empty state we saw the first pass.
    await issuesSvc.updateStage(b.id, 'idea', { status: 'ready', output: 'beat alpha\nbeat omega' });
    llmCalls.length = 0;
    await textStages.generateStage(a.id, 'idea');
    expect(ctxFromCall(llmCalls[0]).nextIssue).toMatchObject({
      title: 'B',
      beats: expect.stringContaining('beat alpha'),
    });
  });

  // -- end idea-stage context augment --

  it('prompt context carries derived lengthTargets for the custom profile', async () => {
    const { series } = await seed();
    // 44 pages is 2× the standard 22-page baseline, so all derived ranges
    // should also double. minutesTarget is stored as-is (not derived).
    const issue = await issuesSvc.createIssue({
      seriesId: series.id,
      title: 'The Override',
      lengthProfile: 'custom',
      pageTarget: 44,
      minutesTarget: 50,
    });
    await textStages.generateStage(issue.id, 'idea');
    const ctx = JSON.parse(llmCalls[0].prompt.replace(/^RENDERED:[^:]+:/, ''));
    const lt = ctx.lengthTargets;
    expect(lt.profile).toBe('custom');
    expect(lt.pageTarget).toBe(44);
    expect(lt.minutesTarget).toBe(50);
    // scale = 44/22 = 2 → proseWords: 2500×2=5000, 4000×2=8000; beats: 8×2=16, 12×2=24
    expect(lt.proseWordsMin).toBe(5000);
    expect(lt.proseWordsMax).toBe(8000);
    expect(lt.beatsMin).toBe(16);
    expect(lt.beatsMax).toBe(24);
  });
});
