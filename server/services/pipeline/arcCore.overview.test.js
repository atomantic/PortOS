import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();
let stageRunnerSpy;

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

// Stub the staged-LLM runner so the test owns the LLM response shape.
// Each test sets `stageRunnerSpy = vi.fn(...)` to control what comes back.
vi.mock('../stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
  // Large window so completeness runs as a single call (mode: 'whole').
  resolveStageContext: vi.fn(() => Promise.resolve({ provider: { id: 'p' }, model: 'm', contextWindow: 1_000_000 })),
}));

const seriesSvc = await import('./series.js');
const worldSvc = await import('../universeBuilder.js');
const planner = await import('./arcPlanner.js');

async function setupSeries(overrides = {}) {
  return seriesSvc.createSeries({
    name: 'Salt Run',
    logline: 'A foundry city goes silent.',
    premise: 'Long-form premise.',
    styleNotes: 'moebius linework',
    issueCountTarget: 24,
    ...overrides,
  });
}

describe('arcPlanner — generateArcOverview', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    stageRunnerSpy = undefined;
  });

  it.each([
    { mode: 'finite', episodeActivity: 'Investigate the case.', endingCondition: 'Solve the central case.' },
    { mode: 'renewable', episodeActivity: 'Repair a different neighborhood machine.', continuingTensions: 'The crew disagree about risk.' },
    null,
  ])('carries saved design through planning, reviews, model rewrites and rollback: %j', async (seriesDesign) => {
    const series = await setupSeries({ arc: { logline: 'Spine', shape: 'man-in-hole', seriesDesign, readerMap: { hooks: [{ label: 'What will the crew discover?' }] } }, seasons: [{ number: 1, title: 'First jobs', synopsis: 'The crew handles its first cases.', episodeCountTarget: 2 }] });
    const saved = series.arc.seriesDesign;
    const episode = seriesDesign?.mode === 'finite'
      ? { number: 1, title: 'The missing ledger', synopsis: 'The investigator finds a ledger that identifies the central suspect.' }
      : { number: 1, title: 'The broken pump', synopsis: 'The crew repairs a pump but remain divided about acceptable risk.' };
    stageRunnerSpy = vi.fn(async () => ({ content: { logline: 'New spine', summary: 'Progress', seriesDesign: { mode: 'finite', endingCondition: 'AI overwrite' }, episodes: [episode], issues: [], edits: {}, changes: [], rationale: '' }, runId: 'r', providerId: 'p', model: 'm' }));
    const overview = await planner.generateArcOverview(series.id);
    expect(overview.arc.seriesDesign).toEqual(saved);
    const refine = await planner.refineArc(series.id, 'Tighten the spine.');
    expect(refine.arc.seriesDesign).toEqual(saved);
    const planned = await planner.generateSeasonEpisodes(series.id, series.seasons[0].id);
    await planner.commitEpisodesToIssues(series.id, series.seasons[0].id, planned.episodes);
    await planner.verifyArc(series.id);
    await planner.verifyVolume(series.id, series.seasons[0].id);
    await planner.resolveVerifyIssues(series.id, { findings: [{ severity: 'medium', problem: 'Clarify the episode connection.', suggestion: 'Connect the existing episodes.' }] });
    for (const [, context] of stageRunnerSpy.mock.calls) {
      if (saved) {
        expect(context.shapeGuidance).toContain(`Mode: ${saved.mode}`);
        expect(context.shapeGuidance).toContain(saved.episodeActivity);
      } else expect(context.shapeGuidance).not.toContain('Series design (author-owned');
    }
    expect(stageRunnerSpy.mock.calls.find(([stage]) => stage === 'pipeline-arc-verify')[1].seasonsTreeJson).toContain(episode.title);
    expect(stageRunnerSpy.mock.calls.find(([stage]) => stage === 'pipeline-volume-verify')[1].volumeIssuesJson).toContain(episode.title);
    const snapshot = await planner.snapshotArcState(series.id);
    await planner.commitSeasonsWithRemap(series, { arc: { ...overview.arc, seriesDesign: { mode: 'finite', endingCondition: 'AI overwrite' } }, seasons: series.seasons });
    await planner.restoreArcState(series.id, snapshot);
    const restored = await seriesSvc.getSeries(series.id);
    expect(restored.arc.seriesDesign).toEqual(saved);
    expect(restored.arc.readerMap).toEqual(series.arc.readerMap);
    expect(restored.arc.shape).toBe('man-in-hole');
    expect(restored.issueCountTarget).toBe(24);
  });

  it('keeps a later author edit through a stale generation commit and resolver snapshot restoration', async () => {
    const series = await setupSeries({ arc: { logline: 'Before', seriesDesign: { mode: 'renewable' } } });
    const snapshot = await planner.snapshotArcState(series.id);
    const authored = await seriesSvc.updateSeries(series.id, { arc: { ...series.arc, seriesDesign: { mode: 'finite', endingCondition: 'Solve the case.' } } });
    await planner.commitSeasonsWithRemap(series, { arc: { ...series.arc, summary: 'Generated summary' }, seasons: [] });
    expect((await seriesSvc.getSeries(series.id)).arc.seriesDesign).toEqual(authored.arc.seriesDesign);
    await seriesSvc.updateSeries(series.id, { locked: { arc: true } });
    await planner.restoreArcState(series.id, snapshot);
    const restored = await seriesSvc.getSeries(series.id);
    expect(restored.arc.seriesDesign).toEqual(authored.arc.seriesDesign);
    expect(restored.locked.arc).toBe(true);
    expect(restored.arc.summary).toBe('');
  });

  it('runs the prompt and returns sanitized arc + seasons preview', async () => {
    const s = await setupSeries({ targetFormat: 'tv' });
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        logline: 'A foundry city falls and rises.',
        summary: 'Three-season arc...',
        themes: ['legacy', 'labor'],
        protagonistArc: 'From surveyor to founder.',
        seasonOutlines: [
          { number: 1, title: 'The Choir Awakens', logline: 'The pilot.', endingHook: 'silence', episodeCountTarget: 8 },
          { number: 2, title: 'Diaspora', logline: 'The middle.', endingHook: 'reunion', episodeCountTarget: 8 },
          { number: 3, title: 'Salt at the Root', logline: 'The finale.', endingHook: '', episodeCountTarget: 8 },
        ],
      },
      runId: 'run-abc',
      providerId: 'claude',
      model: 'opus-4',
    }));

    const out = await planner.generateArcOverview(s.id);
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      'pipeline-arc-overview',
      expect.objectContaining({ series: expect.objectContaining({ name: 'Salt Run', targetFormat: 'tv' }) }),
      expect.objectContaining({ returnsJson: true, source: 'pipeline-arc-overview' }),
    );
    expect(out.arc).toMatchObject({
      logline: 'A foundry city falls and rises.',
      themes: ['legacy', 'labor'],
      status: 'draft',
    });
    expect(out.seasons).toHaveLength(3);
    expect(out.seasons[0].id).toMatch(/^sea-/);
    expect(out.seasons[0].title).toBe('The Choir Awakens');
    expect(out.seasons[0].episodeCountTarget).toBe(8);
    expect(out.runId).toBe('run-abc');
  });

  it('drops malformed season outlines and returns the rest', async () => {
    const s = await setupSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: {
        logline: 'L',
        summary: 'S',
        themes: [],
        protagonistArc: 'A',
        seasonOutlines: [
          { number: 1, title: 'Pilot' },
          { number: 0, title: '' },                  // dropped — no title + zero number
          { number: 2, title: 'Aftermath' },
          'this is not an object',                   // dropped
        ],
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateArcOverview(s.id);
    expect(out.seasons.map((s) => s.title)).toEqual(['Pilot', 'Aftermath']);
  });

  it('preserves an existing arc.shape when regenerating (LLM does not return shape)', async () => {
    const s = await setupSeries({ arc: { shape: 'rags-to-riches', logline: 'seed', status: 'draft' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'New L', summary: 'New S', themes: [], protagonistArc: '', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateArcOverview(s.id);
    expect(out.arc?.shape).toBe('rags-to-riches');
  });

  it('overview context tells the LLM to HONOR the picked shape', async () => {
    const s = await setupSeries({ arc: { shape: 'cinderella', logline: 'seed', status: 'draft' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'L', summary: 'S', themes: [], protagonistArc: 'A', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    await planner.generateArcOverview(s.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    // pickedShapeId drives the prompt's {{#pickedShapeId}} section — truthy = honor mode.
    expect(ctx.pickedShapeId).toBe('cinderella');
    expect(ctx.shapeGuidance).toContain('Cinderella');
    expect(ctx.allowedShapeIdsCsv).toContain('cinderella');
  });

  it('overview context tells the LLM to PROPOSE a shape when none is set', async () => {
    const s = await setupSeries(); // arc null
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'L', summary: 'S', themes: [], protagonistArc: 'A', shape: 'icarus', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateArcOverview(s.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    // Empty pickedShapeId triggers the prompt's {{^pickedShapeId}} branch (propose mode).
    expect(ctx.pickedShapeId).toBe('');
    expect(ctx.shapeGuidance).toMatch(/no shape selected/i);
    // LLM-proposed shape round-trips into the persisted arc.
    expect(out.arc?.shape).toBe('icarus');
  });

  it('returns null arc when every identifying field is empty', async () => {
    const s = await setupSeries();
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: '', summary: '', themes: [], protagonistArc: '', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    const out = await planner.generateArcOverview(s.id);
    expect(out.arc).toBe(null);
    expect(out.seasons).toEqual([]);
  });

  it('feeds the linked world\'s categories + composite sheets into the prompt context', async () => {
    // Create a world with factions + a composite sheet, then a series linked to it.
    const world = await worldSvc.createUniverse({
      name: 'Clandestiny',
      starterPrompt: 'paranormal investigators in a candy-bright city',
      logline: 'World logline',
      premise: 'World premise',
      styleNotes: 'cel-shaded, pastels',
      influences: { embrace: ['Moebius', 'Saga'], avoid: ['gritty'] },
      categories: {
        factions: { variations: [
          { label: 'The Lollipop Bureau', prompt: 'pastel public-facing agency' },
          { label: 'The Velvet Null', prompt: 'minimalist rival' },
        ] },
      },
      // Canon characters (Phase B contract — first-class named entities; the
      // `characters` default category was retired in Phase A schema v4).
      characters: [
        { name: 'Mira Holt', physicalDescription: 'field detective in a chartreuse coat' },
      ],
      objects: [
        { name: 'The Tongue', description: 'an artifact that absorbs language' },
      ],
      compositeSheets: [
        { kind: 'reference_sheet', label: 'Rival agencies branding', prompt: 'comparison sheet' },
      ],
    });
    const s = await setupSeries({
      universeId: world.id,
      premise: 'Mira Holt must recover The Tongue before the foundry city goes silent.',
    });

    stageRunnerSpy = vi.fn(async () => ({
      content: {
        logline: 'L', summary: 'S', themes: [], protagonistArc: 'A',
        seasonOutlines: [{ number: 1, title: 'Pilot' }],
      },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    await planner.generateArcOverview(s.id);

    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.worldName).toBe('Clandestiny');
    expect(ctx.worldCategoriesText).toContain('factions');
    expect(ctx.worldCategoriesText).toContain('The Lollipop Bureau');
    expect(ctx.worldCategoriesText).toContain('The Velvet Null');
    // Phase B: canon entries surface in their own context field so the LLM
    // can reference characters/places/objects by name (independent of
    // categories, which stay as the exploratory-variation surface).
    expect(ctx.worldCanonText).toContain('Mira Holt');
    expect(ctx.worldCanonText).toContain('field detective');
    expect(ctx.worldCanonText).toContain('The Tongue');
    expect(ctx.worldCompositesText).toContain('Rival agencies branding');
    expect(ctx.worldInfluencesEmbrace).toContain('Moebius');
    expect(ctx.worldInfluencesAvoid).toContain('gritty');
  });

  it('excludes abandoned-draft canon that the protected premise and active cast never reference', async () => {
    const world = await worldSvc.createUniverse({
      name: 'Example World',
      starterPrompt: 'Asha Reed follows a signal through the Glass Harbor.',
      characters: [
        { id: 'char-active', name: 'Asha Reed', role: 'lead', relationships: 'Trusts Fen.' },
        { id: 'char-support', name: 'Fen', role: 'scout' },
        { id: 'char-stale', name: 'Director Voss', role: 'antagonist' },
      ],
      places: [
        { id: 'place-active', name: 'Glass Harbor', description: 'a flooded observatory' },
        { id: 'place-stale', name: 'Central Ministry', description: 'an old-draft headquarters' },
      ],
      objects: [
        { id: 'obj-stale', name: 'Compliance Seal', description: 'an old-draft badge' },
      ],
    });
    const s = await setupSeries({
      universeId: world.id,
      premise: 'Asha Reed and Fen trace the Glass Harbor signal.',
      characterArcs: [{ characterId: 'char-active', characterName: 'Asha Reed', startState: 'alone', endState: 'trusting' }],
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'L', summary: 'S', themes: [], protagonistArc: 'A', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));

    await planner.generateArcOverview(s.id);

    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.worldCanonText).toContain('Asha Reed');
    expect(ctx.worldCanonText).toContain('Fen');
    expect(ctx.worldCanonText).toContain('Glass Harbor');
    expect(ctx.worldCanonText).not.toContain('Director Voss');
    expect(ctx.worldCanonText).not.toContain('Central Ministry');
    expect(ctx.worldCanonText).not.toContain('Compliance Seal');
  });

  it('renders an "(no linked world)" placeholder when the series has no universeId', async () => {
    const s = await setupSeries({ universeId: null });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'L', summary: 'S', themes: [], protagonistArc: 'A', seasonOutlines: [] },
      runId: 'r1', providerId: 'p', model: 'm',
    }));
    await planner.generateArcOverview(s.id);
    const ctx = stageRunnerSpy.mock.calls[0][1];
    expect(ctx.worldName).toMatch(/no linked world/i);
    expect(ctx.worldCategoriesText).toMatch(/none/i);
    expect(ctx.worldCanonText).toMatch(/none/i);
  });

  it('throws ERR_VALIDATION + skips the LLM call when arc is locked', async () => {
    const s = await setupSeries();
    await seriesSvc.updateSeries(s.id, { locked: { arc: true } });
    stageRunnerSpy = vi.fn();
    await expect(planner.generateArcOverview(s.id))
      .rejects.toMatchObject({ code: planner.ERR_VALIDATION });
    expect(stageRunnerSpy).not.toHaveBeenCalled();
  });
});
