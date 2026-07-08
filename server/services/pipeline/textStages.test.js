import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';
// Real (unmocked) engine + clock renderer, for the end-to-end template-render
// guard at the bottom of this file. promptTemplate.js is pure and storyArc.js
// is not mocked here, so importing them directly is safe alongside the mocks.
import { applyTemplate } from '../../lib/promptTemplate.js';
import { renderTickingClock } from '../../lib/storyArc.js';

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

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

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
  executeApiRun: vi.fn(async ({ runId, provider, model, prompt, onData, onComplete }) => {
    llmCalls.push({ runId, provider: provider.id, model, prompt });
    onData('## Beat sheet\n1. Setup ...\n');
    onComplete({ success: true });
  }),
  executeCliRun: vi.fn(),
  // runStagedLLM always patches metadata post-createRun (to persist the
  // effective timeout). Stub to return a resolved promise so the
  // .catch(...) chain works.
  patchRunMetadata: vi.fn(async () => undefined),
}));

vi.mock('../promptService.js', () => ({
  // Don't truncate — the prior-stages assertion looks at the rendered ctx.
  buildPrompt: vi.fn(async (stageName, ctx) => `RENDERED:${stageName}:${JSON.stringify(ctx)}`),
  // stageRunner now reads stage.provider/stage.model — return null so it
  // falls through to the active provider in the mocked providers module.
  getStage: vi.fn(() => null),
}));

// The draft gate (#2169) dynamic-imports the judge; mock it so the gate tests
// drive per-attempt scores without a real judge LLM call. A no-op for every
// non-gated test (default draftAttempts=1 never enters runDraftGate).
vi.mock('./pipelineJudge.js', () => ({
  judgeIssue: vi.fn(async () => ({ status: 'no-content' })),
}));

const issuesSvc = await import('./issues.js');
const seriesSvc = await import('./series.js');
const seasonsSvc = await import('./seasons.js');
const universeSvc = await import('../universeBuilder.js');
const promptSvc = await import('../promptService.js');
const pipelineJudge = await import('./pipelineJudge.js');
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

  // #1514: the autopilot threads its run provider as a SOFT providerIdDefault, the
  // manual route as a HARD providerId. These run against the REAL stageRunner, so
  // they prove the end-to-end resolution: an unavailable soft default falls through
  // to the active provider (no throw), while an unavailable hard override throws.
  it('soft-falls-through to the active provider when an autopilot providerIdDefault is unavailable', async () => {
    const { issue } = await seed();
    // No stage pin (getStage → null) and 'gone-provider' resolves to null, so a
    // SOFT default must drop to the active provider rather than throwing.
    const result = await textStages.generateStage(issue.id, 'idea', { providerIdDefault: 'gone-provider' });
    expect(result.stage.status).toBe('ready');
    expect(llmCalls[0].provider).toBe('mock-provider'); // active provider used
  });

  it('throws when a manual hard providerId is unavailable (override is a per-call demand)', async () => {
    const { issue } = await seed();
    await expect(textStages.generateStage(issue.id, 'idea', { providerId: 'gone-provider' }))
      .rejects.toMatchObject({ code: 'PROVIDER_OVERRIDE_UNAVAILABLE' });
  });

  it('folds the structured style guide into series.styleNotes in the prompt context', async () => {
    const series = await seriesSvc.createSeries({
      name: 'Salt Run',
      logline: 'A foundry city goes silent.',
      premise: 'Salt-mining city.',
      styleNotes: 'moebius linework',
      styleGuide: { tense: 'present', povPerson: 'first', contentRating: 'PG-13' },
    });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, title: 'The Hush' });
    await textStages.generateStage(issue.id, 'prose', { seedInput: 'beats' });
    const ctx = ctxFromCall(llmCalls[0]);
    // The free-text notes are preserved AND the structured guide directives are
    // prepended, so generation honors house style with no new template variable.
    expect(ctx.series.styleNotes).toContain('moebius linework');
    expect(ctx.series.styleNotes).toContain('present tense');
    expect(ctx.series.styleNotes).toContain('first person');
    expect(ctx.series.styleNotes).toContain('PG-13');
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
    runner.executeApiRun.mockImplementationOnce(async ({ onComplete }) => {
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

  it('refuses regeneration when the per-stage lock is set, and leaves status untouched', async () => {
    const { issue } = await seed();
    await issuesSvc.updateStage(issue.id, 'idea', { locked: true, status: 'ready', output: 'final beats' });
    await expect(textStages.generateStage(issue.id, 'idea'))
      .rejects.toMatchObject({ code: issuesSvc.ERR_STAGE_LOCKED });
    // No status drift to 'generating' — the guard runs before the updateStage call.
    const after = await issuesSvc.getIssue(issue.id);
    expect(after.stages.idea.status).toBe('ready');
    expect(after.stages.idea.output).toBe('final beats');
    expect(after.stages.idea.locked).toBe(true);
  });

  it('prompt context carries worldEntitiesSummary fallback when series has no universe link', async () => {
    const { issue } = await seed();
    await textStages.generateStage(issue.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.worldEntitiesSummary).toBe('(none — series has no linked Universe Builder world)');
  });

  it('renders worldEntitiesSummary roster but does NOT re-list characters already in the full bible', async () => {
    const { series, issue } = await seed();
    const world = await universeSvc.createUniverse({ name: 'Salt Verse' });
    await universeSvc.updateUniverse(world.id, {
      characters: [
        { name: 'Mira', role: 'surveyor', physicalDescription: 'broad-shouldered' },
        { name: 'Jonas', role: 'foreman', personality: 'cunning' },
      ],
      places: [{ name: 'The Foundry', description: 'industrial district' }],
    });
    await seriesSvc.updateSeries(series.id, { universeId: world.id });
    await textStages.generateStage(issue.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    // The characters appear in full in the bible (series.characters)…
    expect((ctx.series.characters || []).map((c) => c.name)).toEqual(expect.arrayContaining(['Mira', 'Jonas']));
    // …so the terse roster must NOT duplicate them — it carries places/objects.
    expect(ctx.worldEntitiesSummary).toContain('The Foundry (industrial district)');
    expect(ctx.worldEntitiesSummary).not.toContain('Mira');
    expect(ctx.worldEntitiesSummary).not.toContain('Jonas');
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

  it('idea context: surfaces the ticking clock as a rendered string when enabled', async () => {
    const { series, issue } = await seed();
    await seriesSvc.updateSeries(series.id, {
      arc: {
        tickingClock: {
          enabled: true,
          label: 'The tide returns',
          kind: 'deadline',
          stakes: 'the foundry floods',
          dueAtArcPosition: 0.9,
        },
      },
    });
    await textStages.generateStage(issue.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(typeof ctx.tickingClock).toBe('string');
    expect(ctx.tickingClock).toContain('The tide returns');
    expect(ctx.tickingClock).toContain('the foundry floods');
    // A clock-only arc carries no logline/themes — the clock must still surface
    // even though the arc text block is omitted.
    expect(ctx.arc).toBe(null);
  });

  it('idea context: omits the ticking clock when it is toggled off', async () => {
    const { series, issue } = await seed();
    await seriesSvc.updateSeries(series.id, {
      arc: { logline: 'L', tickingClock: { enabled: false, label: 'draft clock' } },
    });
    await textStages.generateStage(issue.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.tickingClock).toBe(null);
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

  it('idea context: paddingRisk flagged for a terse synopsis on a long (finale) profile', async () => {
    const { series } = await seed();
    const issue = await issuesSvc.createIssue({
      seriesId: series.id,
      title: 'The Invitation',
      lengthProfile: 'finale',
      stages: { idea: { input: 'the Helioheart invitation arrives', status: 'draft' } },
    });
    await textStages.generateStage(issue.id, 'idea');
    expect(ctxFromCall(llmCalls[0]).paddingRisk).toBe(true);
  });

  it('idea context: paddingRisk NOT flagged for a terse synopsis on a standard profile', async () => {
    const { series } = await seed();
    const issue = await issuesSvc.createIssue({
      seriesId: series.id,
      title: 'The Gala',
      lengthProfile: 'standard',
      stages: { idea: { input: 'the gala', status: 'draft' } },
    });
    await textStages.generateStage(issue.id, 'idea');
    expect(ctxFromCall(llmCalls[0]).paddingRisk).toBe(false);
  });

  it('idea context: paddingRisk tracks the seedInput override, not the stored synopsis', async () => {
    const { series } = await seed();
    // Stored synopsis is rich enough to clear the finale floor → not padding-prone.
    const richStored = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    const issue = await issuesSvc.createIssue({
      seriesId: series.id,
      title: 'The Invitation',
      lengthProfile: 'finale',
      stages: { idea: { input: richStored, status: 'draft' } },
    });
    // Regenerating with a terse override seed must flag padding risk, because the
    // override — not the stored synopsis — is what gets expanded.
    await textStages.generateStage(issue.id, 'idea', { seedInput: 'the invitation arrives' });
    expect(ctxFromCall(llmCalls[0]).paddingRisk).toBe(true);
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

  // ---- prose-stage cross-issue continuity augment (#2177 / CWQE Phase 12) ----
  // Exercises buildProseContextAugment via the public generateStage entry so we
  // hit the same path the LLM caller does. The mocked provider resolves to a
  // large-window API provider, so budgeting never trims in these fixtures.

  it('prose continuity: injects prior issue prose tail + next issue beats for a middle issue', async () => {
    const { series } = await seed();
    const sea = await seasonsSvc.createSeason(series.id, { title: 'V1' });
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'A', seasonId: sea.id, arcPosition: 1,
      stages: { prose: { status: 'ready', output: 'A opens.\n\nA middle.\n\nA closes on a held breath.' } },
    });
    const b = await issuesSvc.createIssue({ seriesId: series.id, title: 'B', seasonId: sea.id, arcPosition: 2 });
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'C', seasonId: sea.id, arcPosition: 3,
      stages: { idea: { status: 'ready', output: 'C beat 1\nC beat 2' } },
    });

    await textStages.generateStage(b.id, 'prose');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.hasNeighborContinuity).toBe(true);
    expect(ctx.priorIssueProseTail).toContain('held breath');
    expect(ctx.nextIssueBeats).toContain('C beat 1');
  });

  it('prose continuity: no prior tail for the first issue of a volume (no fake continuity)', async () => {
    const { series } = await seed();
    const sea = await seasonsSvc.createSeason(series.id, { title: 'V1' });
    const a = await issuesSvc.createIssue({ seriesId: series.id, title: 'A', seasonId: sea.id, arcPosition: 1 });
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'B', seasonId: sea.id, arcPosition: 2,
      stages: { idea: { status: 'ready', output: 'B beat 1' } },
    });
    await textStages.generateStage(a.id, 'prose');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.priorIssueProseTail).toBe('');
    // The next issue's beats still flow in — only the absent side is blank.
    expect(ctx.nextIssueBeats).toContain('B beat 1');
    expect(ctx.hasNeighborContinuity).toBe(true);
  });

  it('prose continuity: prior block does NOT render when the prior issue has no prose yet', async () => {
    const { series } = await seed();
    const sea = await seasonsSvc.createSeason(series.id, { title: 'V1' });
    // Prior issue exists but its prose stage is empty (non-linear generation).
    await issuesSvc.createIssue({ seriesId: series.id, title: 'A', seasonId: sea.id, arcPosition: 1 });
    const b = await issuesSvc.createIssue({ seriesId: series.id, title: 'B', seasonId: sea.id, arcPosition: 2 });
    await textStages.generateStage(b.id, 'prose');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.priorIssueProseTail).toBe('');
    expect(ctx.nextIssueBeats).toBe('');
    expect(ctx.hasNeighborContinuity).toBe(false);
  });

  it('prose continuity: an ungrouped issue (no season) gets no continuity blocks', async () => {
    const { issue } = await seed();
    await textStages.generateStage(issue.id, 'prose');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.priorIssueProseTail).toBe('');
    expect(ctx.nextIssueBeats).toBe('');
    expect(ctx.hasNeighborContinuity).toBe(false);
  });

  it('prose continuity: next-issue beats fall back to synopsis when beats are not expanded', async () => {
    const { series } = await seed();
    const sea = await seasonsSvc.createSeason(series.id, { title: 'V1' });
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'A', seasonId: sea.id, arcPosition: 1,
      stages: { prose: { status: 'ready', output: 'A closes.' } },
    });
    const b = await issuesSvc.createIssue({ seriesId: series.id, title: 'B', seasonId: sea.id, arcPosition: 2 });
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'C', seasonId: sea.id, arcPosition: 3,
      stages: { idea: { status: 'draft', input: 'C synopsis only' } },
    });
    await textStages.generateStage(b.id, 'prose');
    expect(ctxFromCall(llmCalls[0]).nextIssueBeats).toBe('C synopsis only');
  });

  it('prose continuity: the idea stage does NOT get the prose-tail blocks', async () => {
    const { series } = await seed();
    const sea = await seasonsSvc.createSeason(series.id, { title: 'V1' });
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'A', seasonId: sea.id, arcPosition: 1,
      stages: { prose: { status: 'ready', output: 'A closes.' } },
    });
    const b = await issuesSvc.createIssue({ seriesId: series.id, title: 'B', seasonId: sea.id, arcPosition: 2 });
    await textStages.generateStage(b.id, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx).not.toHaveProperty('priorIssueProseTail');
    expect(ctx).not.toHaveProperty('hasNeighborContinuity');
  });

  // -- pure helpers (extraction + tail length) --

  it('extractProseTail returns the whole prose when it is under the cap', () => {
    expect(textStages.__testing.extractProseTail('short prose', 2000)).toBe('short prose');
  });

  it('extractProseTail returns at most maxChars of the tail', () => {
    const long = 'x'.repeat(5000);
    const tail = textStages.__testing.extractProseTail(long, 2000);
    expect(tail.length).toBeLessThanOrEqual(2000);
    // It is the TAIL — the end of the source, not the head.
    expect(long.endsWith(tail)).toBe(true);
  });

  it('extractProseTail starts on a clean paragraph boundary when one is near the top of the slice', () => {
    // Source is over the 200-char cap so it slices; the paragraph break lands
    // in the first third of the 200-char slice window (index ~18), so the tail
    // opens on the clean boundary rather than mid-word.
    const head = 'A'.repeat(100);
    const finalPara = `Final paragraph opens the tail cleanly. ${'x'.repeat(150)}`;
    const src = `${head}\n\n${finalPara}`;
    const tail = textStages.__testing.extractProseTail(src, 200);
    expect(tail.startsWith('Final paragraph')).toBe(true);
  });

  it('extractProseTail returns empty string for absent / blank prose (no fake continuity)', () => {
    expect(textStages.__testing.extractProseTail('', 2000)).toBe('');
    expect(textStages.__testing.extractProseTail('   \n  ', 2000)).toBe('');
    expect(textStages.__testing.extractProseTail(null, 2000)).toBe('');
    expect(textStages.__testing.extractProseTail(undefined, 2000)).toBe('');
  });

  it('extractNextIssueBeats prefers beats, falls back to synopsis, else empty', () => {
    expect(textStages.__testing.extractNextIssueBeats({ stages: { idea: { output: 'BEATS', input: 'SYN' } } })).toBe('BEATS');
    expect(textStages.__testing.extractNextIssueBeats({ stages: { idea: { input: 'SYN' } } })).toBe('SYN');
    expect(textStages.__testing.extractNextIssueBeats({ stages: { idea: {} } })).toBe('');
    expect(textStages.__testing.extractNextIssueBeats(null)).toBe('');
  });

  it('prose continuity: a small-context provider trims the injected block rather than erroring', async () => {
    // A small (but non-degenerate) window: after the fixed output reserve the
    // usable input budget is tight enough that the 25% continuity slice is well
    // under the ~2000-char prose tail, so the budgeter must trim it.
    const providers = await import('../providers.js');
    providers.getActiveProvider.mockResolvedValueOnce({
      id: 'small-local', name: 'Small', type: 'api', enabled: true,
      defaultModel: 'small-model', endpoint: 'http://localhost:1234/v1', contextWindow: 10_000,
    });
    const { series } = await seed();
    const sea = await seasonsSvc.createSeason(series.id, { title: 'V1' });
    // Distinct opening vs closing markers so we can prove the trim keeps the END
    // (the actual close the model must flow from), not the head.
    const bigTail = `PRIOR_OPENING. ${'The tide rolls in. '.repeat(2000)}PRIOR_CLOSING.`;
    await issuesSvc.createIssue({
      seriesId: series.id, title: 'A', seasonId: sea.id, arcPosition: 1,
      stages: { prose: { status: 'ready', output: bigTail } },
    });
    // B is the last issue → no next beats, so the tail gets the whole slice.
    const b = await issuesSvc.createIssue({ seriesId: series.id, title: 'B', seasonId: sea.id, arcPosition: 2 });
    await expect(textStages.generateStage(b.id, 'prose')).resolves.toBeTruthy();
    const ctx = ctxFromCall(llmCalls[0]);
    // Present but trimmed below the raw ~2000-char tail cap — degraded, not dropped or errored.
    expect(ctx.priorIssueProseTail.length).toBeGreaterThan(0);
    expect(ctx.priorIssueProseTail.length).toBeLessThan(2_000);
    // Regression guard: the trim must keep the CLOSING of the prior issue (the
    // seam the prose template tells the model to open from), not its opening.
    expect(ctx.priorIssueProseTail).toContain('PRIOR_CLOSING');
    expect(ctx.priorIssueProseTail).not.toContain('PRIOR_OPENING');
  });

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

  // -- source material (backport) --

  // Seed an issue whose stages already carry content, so we can target one
  // stage and feed it from any other. Mirrors the user's "started from a comic
  // script" case.
  async function seedWithStages() {
    const { series, issue } = await seed();
    await issuesSvc.updateStage(issue.id, 'idea', { status: 'ready', output: 'BEATS-CONTENT' });
    await issuesSvc.updateStage(issue.id, 'prose', { status: 'ready', output: 'PROSE-CONTENT' });
    await issuesSvc.updateStage(issue.id, 'comicScript', { status: 'ready', output: 'SCRIPT-CONTENT' });
    return { series, issueId: issue.id };
  }

  it('default source: prose pulls the idea beat sheet when no sourceStageIds given', async () => {
    const { issueId } = await seedWithStages();
    await textStages.generateStage(issueId, 'prose');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.sourceMaterials).toEqual([
      { stageId: 'idea', label: 'Idea / Beat Sheet', content: 'BEATS-CONTENT' },
    ]);
    expect(ctx.hasSourceMaterials).toBe(true);
  });

  it('backport: generate prose FROM an explicit comic-script source', async () => {
    const { issueId } = await seedWithStages();
    await textStages.generateStage(issueId, 'prose', { sourceStageIds: ['comicScript'] });
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.sourceMaterials).toEqual([
      { stageId: 'comicScript', label: 'Comic Script', content: 'SCRIPT-CONTENT' },
    ]);
  });

  it('drops the target itself + empty/unknown sources and orders by stage order', async () => {
    const { issueId } = await seedWithStages();
    // teleplay is empty; prose === target; bogus is unknown — all dropped.
    await textStages.generateStage(issueId, 'prose', {
      sourceStageIds: ['comicScript', 'prose', 'teleplay', 'bogus', 'idea'],
    });
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.sourceMaterials.map((s) => s.stageId)).toEqual(['idea', 'comicScript']);
  });

  it('backfills the beat sheet (idea) from existing comic-script content', async () => {
    const { issueId } = await seedWithStages();
    await textStages.generateStage(issueId, 'idea', { sourceStageIds: ['comicScript'] });
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.sourceMaterials.map((s) => s.stageId)).toEqual(['comicScript']);
    expect(ctx.hasSourceMaterials).toBe(true);
  });

  it('idea with no explicit source has no default forward source (empty sourceMaterials)', async () => {
    const { issueId } = await seedWithStages();
    await textStages.generateStage(issueId, 'idea');
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.sourceMaterials).toEqual([]);
    expect(ctx.hasSourceMaterials).toBe(false);
  });

  // -- per-issue character scoping (#1511) --

  it('scopes series.characters to the cast named in the issue, dropping the rest of the bible', async () => {
    const { series } = await seed();
    const world = await universeSvc.createUniverse({ name: 'Salt Verse' });
    await universeSvc.updateUniverse(world.id, {
      characters: [
        { name: 'Mira', role: 'surveyor', physicalDescription: 'broad-shouldered' },
        { name: 'Jonas', role: 'foreman', personality: 'cunning' },
        { name: 'Chandelier', role: 'one-off fixture', personality: 'sentient brass' },
      ],
    });
    await seriesSvc.updateSeries(series.id, { universeId: world.id });
    // Issue whose beats name only Mira — Jonas and the one-off Chandelier must
    // drop out of the heavyweight full-record block.
    const issue = await issuesSvc.createIssue({
      seriesId: series.id, title: 'The Hush',
      stages: { idea: { input: 'a quiet survey', output: 'Mira descends into the dry foundry.', status: 'ready' } },
    });
    await textStages.generateStage(issue.id, 'prose');
    const ctx = ctxFromCall(llmCalls[0]);
    const names = ctx.series.characters.map((c) => c.name);
    expect(names).toEqual(['Mira']);
    // The compact roster still carries the whole cast for continuity.
    expect(ctx.worldEntitiesSummary).toContain('Jonas');
    expect(ctx.worldEntitiesSummary).toContain('Chandelier');
  });

  it('keeps the WHOLE cast in the roster even on a large bible, so a non-featured character never vanishes', async () => {
    const { series } = await seed();
    const world = await universeSvc.createUniverse({ name: 'Big Verse' });
    // 12 characters (> the default roster cap of 8). Only "Mira" is named in the
    // issue; "Tail" sits at bible-index 12 and is neither named nor a principal —
    // it must still appear in the compact roster (its only representation now that
    // the full-record block is scoped).
    const cast = Array.from({ length: 11 }, (_, i) => ({ name: `Filler${i + 1}`, role: 'walk-on' }));
    cast.unshift({ name: 'Mira', role: 'surveyor' });
    cast.push({ name: 'Tail', role: 'background' });
    await universeSvc.updateUniverse(world.id, { characters: cast });
    await seriesSvc.updateSeries(series.id, { universeId: world.id });
    const issue = await issuesSvc.createIssue({
      seriesId: series.id, title: 'The Hush',
      stages: { idea: { input: 'a quiet survey', output: 'Mira walks alone.', status: 'ready' } },
    });
    await textStages.generateStage(issue.id, 'prose');
    const ctx = ctxFromCall(llmCalls[0]);
    // Full records scoped to the named character only…
    expect(ctx.series.characters.map((c) => c.name)).toEqual(['Mira']);
    // …but the roster still lists the deep-bible character and shows no truncation.
    expect(ctx.worldEntitiesSummary).toContain('Tail');
    expect(ctx.worldEntitiesSummary).not.toMatch(/Characters:.*\(\+\d+ more\)/);
  });

  it('scopeCharactersForIssue: principals are a floor — always present, plus the named cast', () => {
    const cast = [
      { name: 'Mira', role: 'lead' },   // principal — always in the floor
      { name: 'Jonas', role: 'extra' }, // non-principal — only in because named
    ];
    expect(textStages.__testing.scopeCharactersForIssue(cast, 'Jonas barks an order').map((c) => c.name))
      .toEqual(['Mira', 'Jonas']);
  });

  it('scopeCharactersForIssue: an incidental name match never SUPPRESSES the principals', () => {
    // "will" in ordinary text spuriously matches the "Will Stone" first-name token.
    // The principal (Lena) must still survive — a false-positive can only ADD a
    // record, never drop the leads.
    const cast = [
      { name: 'Will Stone', role: 'side' },
      { name: 'Lena', role: 'lead protagonist' },
    ];
    const got = textStages.__testing.scopeCharactersForIssue(cast, 'the team will regroup').map((c) => c.name);
    expect(got).toContain('Lena');
  });

  it('scopeCharactersForIssue: a first-name reference is ADDED on top of a reliable scope', () => {
    const cast = [
      { name: 'Lena', role: 'lead' },           // principal — reliable signal (floor)
      { name: 'Mira Reyes', role: 'surveyor' }, // referenced by first name only
      { name: 'Bram Vale', role: 'cook' },      // not referenced — excluded
    ];
    // Draft says "Mira", not the full "Mira Reyes" — the full-name matcher misses,
    // the first-name supplement catches it and adds it to the principals floor.
    const got = textStages.__testing.scopeCharactersForIssue(cast, 'Mira crossed the yard alone').map((c) => c.name);
    expect(got).toContain('Mira Reyes');
    expect(got).toContain('Lena');
    expect(got).not.toContain('Bram Vale');
  });

  it('scopeCharactersForIssue: an incidental first-name match on an UNTAGGED cast keeps the whole cast', () => {
    // No principals and no full-name match → no reliable signal. The spurious
    // "will" → "Will Stone" first-name hit must NOT scope the prompt down to one
    // character; fall back to the whole cast instead.
    const cast = [
      { name: 'Will Stone', role: 'side' },
      { name: 'Bram', role: 'clerk' },
    ];
    expect(textStages.__testing.scopeCharactersForIssue(cast, 'the team will regroup').map((c) => c.name))
      .toEqual(['Will Stone', 'Bram']);
  });

  it('scopeCharactersForIssue: a single-word common-word name does NOT scope on an incidental lowercase hit (#1529)', () => {
    // A cast member literally named "Will" + an untagged cast. The old case-insensitive
    // full-name matcher treated lowercase "will" in "the team will regroup" as a reliable
    // match and scoped the prompt down to just "Will". The proper-noun guard rejects the
    // lowercase hit → no reliable signal → whole cast survives.
    const cast = [
      { name: 'Will', role: 'side' },
      { name: 'Bram', role: 'clerk' },
    ];
    expect(textStages.__testing.scopeCharactersForIssue(cast, 'the team will regroup').map((c) => c.name))
      .toEqual(['Will', 'Bram']);
  });

  it('scopeCharactersForIssue: an incidental lowercase common word never pulls in the literally-named character (#1529)', () => {
    // Principal floor gives a reliable signal; the incidental "will" must NOT add the
    // non-principal character named "Will" (lowercase ≠ proper-noun).
    const cast = [
      { name: 'Lena', role: 'lead protagonist' },
      { name: 'Will', role: 'extra' },
    ];
    expect(textStages.__testing.scopeCharactersForIssue(cast, 'the team will regroup').map((c) => c.name))
      .toEqual(['Lena']);
  });

  it('scopeCharactersForIssue: a capitalized single-word name IS a reliable proper-noun match (#1529)', () => {
    const cast = [
      { name: 'Will', role: 'side' },
      { name: 'Bram', role: 'clerk' },
    ];
    // "Will entered" — proper-noun usage scopes to Will; ALL-CAPS beat-sheet form too.
    expect(textStages.__testing.scopeCharactersForIssue(cast, 'Will entered the room').map((c) => c.name))
      .toEqual(['Will']);
    expect(textStages.__testing.scopeCharactersForIssue(cast, 'WILL slams the door').map((c) => c.name))
      .toEqual(['Will']);
  });

  it('scopeCharactersForIssue: aliases stay case-insensitive — only single-word NAMES get the proper-noun guard (#1529)', () => {
    const cast = [
      { name: 'Lena', role: 'lead' },
      { name: 'Grace', role: 'side', aliases: ['Gigi'] },
    ];
    // Lowercase alias "gigi" still matches (aliases keep the old behavior); Grace is in.
    const got = textStages.__testing.scopeCharactersForIssue(cast, 'gigi waved from the dock').map((c) => c.name);
    expect(got).toContain('Grace');
    expect(got).toContain('Lena');
  });

  it('scopeCharactersForIssue: matches non-ASCII names (accented) the ASCII \\b matcher would miss', () => {
    const cast = [
      { name: 'José Marín', role: 'pilot' }, // non-principal — only in via accented first-name match
      { name: 'Élodie', role: 'navigator' },
      { name: 'Mira', role: 'extra' },       // not named, not principal — excluded
    ];
    // Source names José (by first name) and Élodie (accented single name).
    const got = textStages.__testing.scopeCharactersForIssue(cast, 'José and Élodie shared a look').map((c) => c.name);
    expect(got).toContain('José Marín');
    expect(got).toContain('Élodie');
    expect(got).not.toContain('Mira');
  });

  it('scopeCharactersForIssue: with nothing named, the scope is exactly the principals', () => {
    const cast = [
      { name: 'Mira', role: 'main protagonist' },
      { name: 'Jonas', role: 'recurring foreman' },
      { name: 'Extra', role: 'background walk-on' },
    ];
    expect(textStages.__testing.scopeCharactersForIssue(cast, 'nobody named here').map((c) => c.name))
      .toEqual(['Mira', 'Jonas']);
  });

  it('scopeCharactersForIssue: falls back to the whole cast when nothing matches and no role tags exist', () => {
    const cast = [{ name: 'A', role: '' }, { name: 'B' }];
    expect(textStages.__testing.scopeCharactersForIssue(cast, 'unrelated').map((c) => c.name))
      .toEqual(['A', 'B']);
    expect(textStages.__testing.scopeCharactersForIssue([], 'x')).toEqual([]);
  });

  it('buildIssueScopeText concatenates title, seed, synopsis, beats, and source materials', () => {
    const issue = { title: 'The Hush', stages: { idea: { input: 'SYN', output: 'BEATS' } } };
    const sourceMaterials = [{ content: 'SRC-A' }, { content: 'SRC-B' }];
    const text = textStages.__testing.buildIssueScopeText(issue, sourceMaterials, 'SEED-TEXT');
    expect(text).toContain('The Hush');
    expect(text).toContain('SEED-TEXT');
    expect(text).toContain('SYN');
    expect(text).toContain('BEATS');
    expect(text).toContain('SRC-A');
    expect(text).toContain('SRC-B');
  });

  it('buildStageContext reveal-gates canon: hides a later-reveal character before its issue, reveals it at/after (#2178)', () => {
    const series = { name: 'S', logline: 'l', premise: 'p' };
    const canon = {
      characters: [
        { id: 'c1', name: 'Mira', role: 'lead', physicalDescription: 'the detective' },
        {
          id: 'c2', name: 'Vex', role: 'suspect',
          physicalDescription: 'the true killer who poisoned the well',
          background: 'committed the murder in Issue 8',
          revealIssue: 8,
          surfaceDescriptor: 'a reclusive apothecary nobody trusts',
        },
      ],
      places: [], objects: [],
    };
    const world = { characters: canon.characters, places: [], objects: [] };
    // The idea stage keeps the full cast (not roster-scoped), so the surfaced
    // full record is visible directly in `series.characters`.
    const early = textStages.__testing.buildStageContext({
      series, canon, world, issue: { number: 2, title: 'T', stages: {} }, stageId: 'idea',
    });
    const vexEarly = early.series.characters.find((c) => c.name === 'Vex');
    // Surfaced view only — the secret is gone, the surface descriptor stands in.
    expect(vexEarly.physicalDescription).toBe('a reclusive apothecary nobody trusts');
    expect(vexEarly.surfaced).toBe(true);
    expect(vexEarly.background).toBeUndefined();

    const late = textStages.__testing.buildStageContext({
      series, canon, world, issue: { number: 8, title: 'T', stages: {} }, stageId: 'idea',
    });
    const vexLate = late.series.characters.find((c) => c.name === 'Vex');
    expect(vexLate.physicalDescription).toBe('the true killer who poisoned the well');
    expect(vexLate.background).toBe('committed the murder in Issue 8');
  });

  it('buildStageContext reveal-gates the prose roster: surfaced view in worldEntitiesSummary, not the secret (#2178)', () => {
    const series = { name: 'S', logline: 'l', premise: 'p' };
    const canon = {
      characters: [
        { id: 'c1', name: 'Mira', role: 'lead', physicalDescription: 'the detective' },
        {
          id: 'c2', name: 'Vex', role: 'suspect',
          physicalDescription: 'the true killer who poisoned the well',
          revealIssue: 8,
          surfaceDescriptor: 'a reclusive apothecary nobody trusts',
        },
      ],
      places: [], objects: [],
    };
    const world = { characters: canon.characters, places: [], objects: [] };
    // Prose scopes the full-record block to principals/named — Vex (not named)
    // lands in the roster, which must show its surface view, never the secret.
    const ctx = textStages.__testing.buildStageContext({
      series, canon, world, issue: { number: 2, title: 'T', stages: {} }, stageId: 'prose',
    });
    expect(ctx.worldEntitiesSummary).not.toContain('true killer');
    expect(ctx.worldEntitiesSummary).toContain('reclusive apothecary');
  });

  it('buildStageContext drops a hard-spoiler canon entry with no surface descriptor from context (#2178)', () => {
    const series = { name: 'S', logline: 'l', premise: 'p' };
    const canon = {
      characters: [{ id: 'c1', name: 'Ghost', physicalDescription: 'the villain behind it all', spoiler: true }],
      places: [], objects: [],
    };
    const world = { characters: canon.characters, places: [], objects: [] };
    const ctx = textStages.__testing.buildStageContext({
      series, canon, world, issue: { number: 3, title: 'T', stages: {} }, stageId: 'prose',
    });
    expect(ctx.series.characters.find((c) => c.name === 'Ghost')).toBeUndefined();
    expect(ctx.worldEntitiesSummary).not.toContain('villain behind it all');
  });

  it('does NOT scope the idea stage — it gets the full cast (no roster in that template)', async () => {
    const { series } = await seed();
    const world = await universeSvc.createUniverse({ name: 'Seed Verse' });
    await universeSvc.updateUniverse(world.id, {
      characters: [
        { name: 'Bram', role: 'clerk' },
        { name: 'Mira', role: 'surveyor' },
      ],
    });
    await seriesSvc.updateSeries(series.id, { universeId: world.id });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, title: 'Fresh' });
    // Even though the seed names only Mira, the idea stage must keep the WHOLE cast
    // available (it generates from the seed and its template renders no roster).
    await textStages.generateStage(issue.id, 'idea', { seedInput: 'A quiet hour with Mira at the foundry.' });
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.series.characters.map((c) => c.name).sort()).toEqual(['Bram', 'Mira']);
  });

  it('scopes a roster-backed stage (prose) from the UNSAVED seed text', async () => {
    const { series } = await seed();
    const world = await universeSvc.createUniverse({ name: 'Seed Verse' });
    // Both non-principal (no floor) so the only in-scope character must come from
    // the seed text match.
    await universeSvc.updateUniverse(world.id, {
      characters: [
        { name: 'Bram', role: 'clerk' },
        { name: 'Mira', role: 'surveyor' },
      ],
    });
    await seriesSvc.updateSeries(series.id, { universeId: world.id });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, title: 'Fresh' });
    await textStages.generateStage(issue.id, 'prose', { seedInput: 'A quiet hour with Mira at the foundry.' });
    const ctx = ctxFromCall(llmCalls[0]);
    expect(ctx.series.characters.map((c) => c.name)).toEqual(['Mira']);
    // The un-scoped Bram still appears in the prose template's roster.
    expect(ctx.worldEntitiesSummary).toContain('Bram');
  });
});

// End-to-end render guard for the shipped idea template. The tests above assert
// the *context object* buildIdeaContextAugment produces, but mock buildPrompt —
// so a regression in the template itself (e.g. reverting the named-ref fix back
// to `{{.}}`, which renders the literal "[object Object]" inside string-valued
// Mustache sections) would not fail any of them. This block renders the real
// data.reference template through the production engine to pin that contract.
describe('pipeline-idea-expansion template render', () => {
  const ideaTemplate = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../data.reference/prompts/stages/pipeline-idea-expansion.md'),
    'utf-8',
  );

  const renderCtx = (overrides = {}) => ({
    series: { name: 'S', logline: 'L', premise: 'P', styleNotes: '', characters: [] },
    issue: { number: 3, title: 'T' },
    lengthTargets: { profile: 'std', pageTarget: 22, minutesTarget: 22, beatsMin: 8, beatsMax: 12, proseWordsMin: 2000, proseWordsMax: 3000 },
    arcRole: 'midpoint',
    priorIssue: { number: 2, title: 'Prev', arcRole: 'complication', beats: 'PRIOR-BEAT-ONE\nPRIOR-BEAT-TWO' },
    nextIssue: { number: 4, title: 'Next', arcRole: 'all-is-lost', synopsis: 'NEXT-SYNOPSIS-LINE' },
    ...overrides,
  });

  it('renders neighbor beats / synopsis / arc-role as real text, never "[object Object]"', () => {
    const out = applyTemplate(ideaTemplate, renderCtx());
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('**midpoint**');        // this issue's arc role
    expect(out).toContain('**complication**');     // prior neighbor's arc role
    expect(out).toContain('**all-is-lost**');      // next neighbor's arc role
    expect(out).toContain('PRIOR-BEAT-ONE');       // prior neighbor's beat sheet
    expect(out).toContain('NEXT-SYNOPSIS-LINE');   // next neighbor's synopsis
  });

  it('renders the {{#paddingRisk}} scope warning only when the flag is set (#1513)', () => {
    const withRisk = applyTemplate(ideaTemplate, renderCtx({ paddingRisk: true }));
    expect(withRisk).toContain('Scope warning');
    expect(withRisk).toContain('Do NOT do that');
    // Pin the dotted interpolation INSIDE the section — a regression to {{.}} or a
    // broken lengthTargets ref would still render the static text above.
    expect(withRisk).toContain('22-page target');   // {{lengthTargets.pageTarget}}
    expect(withRisk).toContain('8–12 range');        // {{lengthTargets.beatsMin}}–{{lengthTargets.beatsMax}}

    const withoutRisk = applyTemplate(ideaTemplate, renderCtx({ paddingRisk: false }));
    expect(withoutRisk).not.toContain('Scope warning');
  });

  it('frames neighboring issues as hard scope boundaries (#1513)', () => {
    const out = applyTemplate(ideaTemplate, renderCtx());
    // Next-issue block: its events are out of scope, not material to continue into.
    expect(out).toContain('OUT OF SCOPE');
    // The seed scope note (non-backfill runs).
    expect(out).toContain("This seed defines THIS issue's scope.");
  });

  it('suppresses the seed-scope note + padding warning on a backfill run (#1513)', () => {
    // Backfill mode: beats are reverse-engineered from existing source material,
    // so the seed is not the scope — the source is. The seed-scope language must
    // NOT fire (it would tell the model to drop events present only in the source).
    const out = applyTemplate(ideaTemplate, renderCtx({
      paddingRisk: true,
      hasSourceMaterials: true,
      sourceMaterials: [{ label: 'Prose Draft', content: 'PROSE-SOURCE-BODY' }],
    }));
    expect(out).not.toContain("This seed defines THIS issue's scope.");
    expect(out).not.toContain('Scope warning');       // paddingRisk gated under {{^hasSourceMaterials}}
    expect(out).toContain('reverse-engineering this beat sheet');  // backfill block still renders
    expect(out).toContain('PROSE-SOURCE-BODY');
  });

  it('renders the ticking-clock section when enabled and omits it otherwise', () => {
    const clock = renderTickingClock({ enabled: true, label: 'TICK-LABEL', kind: 'deadline', stakes: 'TICK-STAKES' });
    const withClock = applyTemplate(ideaTemplate, renderCtx({ tickingClock: clock }));
    expect(withClock).toContain('Ticking clock the reader is anticipating');
    expect(withClock).toContain('TICK-LABEL');
    expect(withClock).toContain('TICK-STAKES');

    const withoutClock = applyTemplate(ideaTemplate, renderCtx({ tickingClock: renderTickingClock({ enabled: false, label: 'x' }) }));
    expect(withoutClock).not.toContain('Ticking clock the reader is anticipating');
  });
});

describe('multi-candidate draft gate (#2169, CWQE Phase 5)', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    llmCalls.length = 0;
    vi.clearAllMocks();
    // Default: single-shot (no gate) unless a test opts in.
    promptSvc.getStage.mockReturnValue(null);
    pipelineJudge.judgeIssue.mockResolvedValue({ status: 'no-content' });
  });

  async function seedProse() {
    const series = await seriesSvc.createSeries({ name: 'Gate', logline: 'L', premise: 'P' });
    const issue = await issuesSvc.createIssue({ seriesId: series.id, title: 'One' });
    return { series, issue };
  }

  // Score each attempt in order; extra (re-judge) calls reuse the last score.
  function scoreAttempts(scores) {
    let i = 0;
    pipelineJudge.judgeIssue.mockImplementation(async () => {
      const q = scores[Math.min(i, scores.length - 1)];
      i += 1;
      return { status: 'complete', qualityScore: q, overall: q, slopPenalty: 0 };
    });
  }

  describe('resolveDraftGate (pure)', () => {
    it('is off (attempts=1) for a non-judgeable stage even when configured', () => {
      promptSvc.getStage.mockReturnValue({ draftAttempts: 3 });
      expect(textStages.resolveDraftGate('idea', 'pipeline-idea-expansion', {})).toEqual({ attempts: 1, threshold: null });
    });

    it('reads draftAttempts/threshold from stage config and clamps to 1..3 / 0..10', () => {
      promptSvc.getStage.mockReturnValue({ draftAttempts: 9, draftGateThreshold: 42 });
      expect(textStages.resolveDraftGate('prose', 'pipeline-prose', {})).toEqual({ attempts: 3, threshold: 10 });
    });

    it('lets an explicit options override beat the stage config', () => {
      promptSvc.getStage.mockReturnValue({ draftAttempts: 3 });
      expect(textStages.resolveDraftGate('prose', 'pipeline-prose', { draftAttempts: 2, draftGateThreshold: 7 }))
        .toEqual({ attempts: 2, threshold: 7 });
    });

    it('defaults to attempts=1 with no config (the pre-#2169 single-shot path)', () => {
      promptSvc.getStage.mockReturnValue(null);
      expect(textStages.resolveDraftGate('prose', 'pipeline-prose', {})).toEqual({ attempts: 1, threshold: null });
    });
  });

  describe('pickBestAttempt (pure)', () => {
    it('returns the highest-scoring attempt, keeping the earlier on ties', () => {
      const a = { runId: 'r1', qualityScore: 8 };
      const b = { runId: 'r2', qualityScore: 8 };
      const c = { runId: 'r3', qualityScore: 5 };
      expect(textStages.pickBestAttempt([a, b, c])).toBe(a);
    });
    it('falls back to the last attempt when none scored', () => {
      const list = [{ runId: 'r1', qualityScore: null }, { runId: 'r2', qualityScore: null }];
      expect(textStages.pickBestAttempt(list)).toBe(list[1]);
    });
    it('returns null for an empty list', () => {
      expect(textStages.pickBestAttempt([])).toBeNull();
    });
  });

  it('generates and judges each attempt, keeping the best-scoring one (winner is last)', async () => {
    promptSvc.getStage.mockReturnValue({ draftAttempts: 2 });
    scoreAttempts([5, 8]); // second attempt is better → kept, no restore
    const { issue } = await seedProse();
    const result = await textStages.generateStage(issue.id, 'prose', { seedInput: 'beats' });

    expect(llmCalls).toHaveLength(2);               // two fresh generations
    expect(pipelineJudge.judgeIssue).toHaveBeenCalledTimes(2); // judged each, no re-judge (winner=last)
    const gate = result.stage.draftGate;
    expect(gate.attempts).toHaveLength(2);
    expect(gate.winner).toBe(result.stage.lastRunId);
    const winner = gate.attempts.find((a) => a.runId === gate.winner);
    expect(winner.qualityScore).toBe(8);
    expect(winner.rejected).toBe(false);
    expect(gate.attempts.find((a) => a.qualityScore === 5).rejected).toBe(true);
  });

  it('restores the earlier attempt when it out-scores the last, and re-judges the winner', async () => {
    promptSvc.getStage.mockReturnValue({ draftAttempts: 2 }); // no threshold → run all, pick best
    scoreAttempts([8, 5]); // first attempt is better → restore it
    const { issue } = await seedProse();
    const result = await textStages.generateStage(issue.id, 'prose', {});

    expect(llmCalls).toHaveLength(2);
    // 2 attempt judges + 1 re-judge of the restored winner.
    expect(pipelineJudge.judgeIssue).toHaveBeenCalledTimes(3);
    const gate = result.stage.draftGate;
    expect(gate.winner).toBe(result.stage.lastRunId);
    expect(gate.attempts.find((a) => a.runId === gate.winner).qualityScore).toBe(8);
    // The rejected attempt's text stays recoverable in runHistory.
    const after = await issuesSvc.getIssue(issue.id);
    expect(after.stages.prose.runHistory.length).toBeGreaterThan(0);
  });

  it('early-stops re-rolling once an attempt clears the threshold', async () => {
    promptSvc.getStage.mockReturnValue({ draftAttempts: 3, draftGateThreshold: 7 });
    scoreAttempts([9]); // first attempt already clears 7
    const { issue } = await seedProse();
    const result = await textStages.generateStage(issue.id, 'prose', {});

    expect(llmCalls).toHaveLength(1);                 // stopped after the first good draft
    expect(result.stage.draftGate.stoppedEarly).toBe(true);
    expect(result.stage.draftGate.attempts).toHaveLength(1);
  });

  it('bills one cos action per re-roll via chargeAction and stops when it returns false', async () => {
    promptSvc.getStage.mockReturnValue({ draftAttempts: 3 });
    scoreAttempts([4, 4, 4]);
    const charge = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { issue } = await seedProse();
    await textStages.generateStage(issue.id, 'prose', { chargeAction: charge });

    // attempt 1 (baseline, not charged) + attempt 2 (charged true) generated;
    // attempt 3 short-circuits when chargeAction returns false.
    expect(charge).toHaveBeenCalledTimes(2);
    expect(llmCalls).toHaveLength(2);
  });

  it('is a no-op single-shot when draftAttempts is 1 (default) — judge never runs', async () => {
    promptSvc.getStage.mockReturnValue({ draftAttempts: 1 });
    const { issue } = await seedProse();
    const result = await textStages.generateStage(issue.id, 'prose', {});
    expect(llmCalls).toHaveLength(1);
    expect(pipelineJudge.judgeIssue).not.toHaveBeenCalled();
    expect(result.stage.draftGate).toBeNull();
  });
});
