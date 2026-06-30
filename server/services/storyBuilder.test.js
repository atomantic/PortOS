import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../lib/mockPathsDataRoot.js';
import { hashUpstream } from '../lib/storyBuilderIntegrity.js';

// In-memory file store shared by all collection stores (storyBuilder, universe,
// series) — mirrors the arcPlanner.test.js fixture so create paths persist.
const fileStore = new Map();
let stageRunnerSpy;

vi.mock('../lib/fileUtils.js', () => ({
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

vi.mock('../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
}));

// catalogDB is Postgres-backed — mock it so the service test never touches the
// real DB (#1761). listIngredients (the batch resolve) and linkIngredientsToSeries
// (the batch link) are spies the tests program per case; the type→role vocabulary
// itself is covered in catalogDB.test.js.
const catalogMocks = vi.hoisted(() => {
  const listIngredients = vi.fn();
  return {
    listIngredients,
    linkIngredientsToSeries: vi.fn(),
    // resolveIngredientsByIds is the shared resolver storyBuilder now delegates
    // to (#1808). Mirror the real dedupe + pick-order logic but route the batch
    // fetch through the mocked listIngredients so every existing per-case
    // `listIngredients.mockResolvedValue(...)` + call-args assertion still drives
    // it unchanged.
    resolveIngredientsByIds: vi.fn(async (ids) => {
      const list = [...new Set((Array.isArray(ids) ? ids : [])
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim()))];
      if (list.length === 0) return [];
      const { items } = await listIngredients({ ids: list, limit: list.length });
      const byId = new Map((items || []).map((ing) => [ing.id, ing]));
      return list.map((id) => byId.get(id)).filter(Boolean);
    }),
  };
});
vi.mock('./catalogDB.js', () => catalogMocks);

const sb = await import('./storyBuilder.js');
const seriesSvc = await import('./pipeline/series.js');
const universeSvc = await import('./universeBuilder.js');
const issuesSvc = await import('./pipeline/issues.js');

beforeEach(() => {
  fileStore.clear();
  uuidCounter = 0;
  stageRunnerSpy = undefined;
  catalogMocks.listIngredients.mockReset();
  catalogMocks.linkIngredientsToSeries.mockReset();
  // Default: the batch resolve returns nothing (each test overrides as needed),
  // and the batch link echoes back the ingredients it was handed.
  catalogMocks.listIngredients.mockResolvedValue({ items: [] });
  catalogMocks.linkIngredientsToSeries.mockImplementation(async (_seriesId, ings) =>
    (Array.isArray(ings) ? ings.filter((i) => i && i.id) : []));
});

describe('storyBuilder — CRUD', () => {
  it('seed mode mints universe + series shells and starts on the idea step', async () => {
    const s = await sb.createStorySession({ title: 'Salt Run', seedIdea: 'a foundry city goes silent' });
    expect(s.id).toMatch(/^stb-/);
    expect(s.intakeMode).toBe('seed');
    expect(s.universeId).toMatch(/^univ-|^uni-|.+/); // minted
    expect(s.seriesId).toMatch(/^ser-/);
    expect(s.currentStep).toBe('idea');
    // Every step starts pending + unlocked.
    expect(s.steps.idea).toEqual({ status: 'pending', locked: false, lockedAt: null, upstreamHash: null });
    // The shells actually exist.
    const universe = await universeSvc.getUniverse(s.universeId);
    expect(universe.name).toBe('Salt Run');
    const series = await seriesSvc.getSeries(s.seriesId);
    expect(series.premise).toBe('a foundry city goes silent');
  });

  it('import mode does not mint shells and marks only importer-filled steps ready', async () => {
    const universe = await universeSvc.createUniverse({ name: 'U' });
    const series = await seriesSvc.createSeries({ name: 'S', universeId: universe.id });
    const s = await sb.createStorySession({
      title: 'Imported', intakeMode: 'import', universeId: universe.id, seriesId: series.id,
    });
    expect(s.universeId).toBe(universe.id);
    expect(s.seriesId).toBe(series.id);
    // Steps the importer populates open "ready" for review.
    for (const id of sb.IMPORT_READY_STEPS) {
      expect(s.steps[id].status).toBe('ready');
    }
    expect(sb.IMPORT_READY_STEPS).toEqual(['idea', 'plotArc', 'characters', 'issues']);
    // The importer never extracts an aesthetic or a reader map, and production
    // is the downstream render step — they must stay pending, not show empty
    // content under a misleading "Ready" badge (#728).
    expect(s.steps.universeAesthetic.status).toBe('pending');
    expect(s.steps.readerMap.status).toBe('pending');
    expect(s.steps.production.status).toBe('pending');
  });

  it('rejects a blank title', async () => {
    await expect(sb.createStorySession({ title: '   ' })).rejects.toMatchObject({ code: sb.ERR_VALIDATION });
  });

  it('rolls back the just-minted universe when createSeries throws (no orphan)', async () => {
    const createSpy = vi.spyOn(seriesSvc, 'createSeries').mockRejectedValueOnce(new Error('series boom'));
    await expect(sb.createStorySession({ title: 'Doomed', seedIdea: 'idea' })).rejects.toThrow('series boom');
    // The universe minted just before the failed series create is tombstoned —
    // exactly one universe was created in this call, so any live universe is a leak.
    const live = (await universeSvc.listUniverses()).filter((u) => !u.deleted);
    expect(live).toHaveLength(0);
    createSpy.mockRestore();
  });

  it('does NOT delete a caller-supplied universe when createSeries throws', async () => {
    const universe = await universeSvc.createUniverse({ name: 'Pre-existing' });
    const createSpy = vi.spyOn(seriesSvc, 'createSeries').mockRejectedValueOnce(new Error('series boom'));
    await expect(
      sb.createStorySession({ title: 'Doomed', seedIdea: 'idea', universeId: universe.id }),
    ).rejects.toThrow('series boom');
    // The universe the caller passed in must survive — we only roll back what we minted.
    const survivor = await universeSvc.getUniverse(universe.id);
    expect(survivor).toBeTruthy();
    expect(survivor.deleted).toBeFalsy();
    createSpy.mockRestore();
  });

  it('lists, gets, updates, and soft-deletes', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    expect((await sb.listStorySessions()).map((x) => x.id)).toContain(s.id);
    const updated = await sb.updateStorySession(s.id, { title: 'Renamed' });
    expect(updated.title).toBe('Renamed');
    await sb.deleteStorySession(s.id);
    await expect(sb.getStorySession(s.id)).rejects.toMatchObject({ code: sb.ERR_NOT_FOUND });
    expect((await sb.listStorySessions()).map((x) => x.id)).not.toContain(s.id);
  });
});

describe('storyBuilder — catalog ingredient linking (#1761)', () => {
  it('is a no-op when catalogIngredientIds is absent (back-compat)', async () => {
    await sb.createStorySession({ title: 'Plain', seedIdea: 'a seed' });
    expect(catalogMocks.listIngredients).not.toHaveBeenCalled();
    expect(catalogMocks.linkIngredientsToSeries).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty catalogIngredientIds array', async () => {
    await sb.createStorySession({ title: 'Plain', seedIdea: 'a seed', catalogIngredientIds: [] });
    expect(catalogMocks.listIngredients).not.toHaveBeenCalled();
    expect(catalogMocks.linkIngredientsToSeries).not.toHaveBeenCalled();
  });

  it('batch-resolves the ids and delegates linking in pick order', async () => {
    const items = [
      { id: 'cat-c', type: 'character', name: 'Mira', payload: {} },
      { id: 'cat-p', type: 'place', name: 'Foundry', payload: {} },
      { id: 'cat-o', type: 'object', name: 'Key', payload: {} },
      { id: 'cat-x', type: 'scene', name: 'Opening', payload: {} },
    ];
    // Return the batch out of order to prove the resolver restores pick order.
    catalogMocks.listIngredients.mockResolvedValue({ items: [items[2], items[0], items[3], items[1]] });

    const s = await sb.createStorySession({
      title: 'Linked', seedIdea: 'seed',
      catalogIngredientIds: ['cat-c', 'cat-p', 'cat-o', 'cat-x'],
    });

    // ONE batch query (not N getIngredient round-trips).
    expect(catalogMocks.listIngredients).toHaveBeenCalledTimes(1);
    expect(catalogMocks.listIngredients).toHaveBeenCalledWith({ ids: ['cat-c', 'cat-p', 'cat-o', 'cat-x'], limit: 4 });
    // ONE batch link with the resolved ingredients in the user's pick order.
    expect(catalogMocks.linkIngredientsToSeries).toHaveBeenCalledTimes(1);
    expect(catalogMocks.linkIngredientsToSeries).toHaveBeenCalledWith(s.seriesId, items);
  });

  it('skips ids the batch omits (missing / soft-deleted) without throwing', async () => {
    // listIngredients already excludes soft-deleted rows, so the batch only
    // returns the live one — the resolver drops the absent ids.
    catalogMocks.listIngredients.mockResolvedValue({
      items: [{ id: 'cat-live', type: 'character', name: 'Live', payload: {} }],
    });

    const s = await sb.createStorySession({
      title: 'Sparse', seedIdea: 'seed',
      catalogIngredientIds: ['cat-live', 'cat-dead', 'cat-missing'],
    });

    expect(catalogMocks.linkIngredientsToSeries).toHaveBeenCalledTimes(1);
    expect(catalogMocks.linkIngredientsToSeries).toHaveBeenCalledWith(s.seriesId, [
      { id: 'cat-live', type: 'character', name: 'Live', payload: {} },
    ]);
  });

  it('de-dupes repeated ids (off-UI API callers) so the link + seed are not doubled', async () => {
    catalogMocks.listIngredients.mockResolvedValue({
      items: [{ id: 'cat-c', type: 'character', name: 'Mira', payload: { description: 'A foreman.' } }],
    });

    const s = await sb.createStorySession({
      title: 'Dupes', // blank seed so the composed fallback is observable
      catalogIngredientIds: ['cat-c', 'cat-c', 'cat-c'],
    });

    // Resolver collapses the dupes to one id before the batch query.
    expect(catalogMocks.listIngredients).toHaveBeenCalledWith({ ids: ['cat-c'], limit: 1 });
    expect(catalogMocks.linkIngredientsToSeries).toHaveBeenCalledWith(s.seriesId, [
      { id: 'cat-c', type: 'character', name: 'Mira', payload: { description: 'A foreman.' } },
    ]);
    // The composed premise lists the ingredient exactly once, not three times.
    const series = await seriesSvc.getSeries(s.seriesId);
    expect(series.premise.match(/- Mira:/g)).toHaveLength(1);
  });

  it('composes a fallback seed from ingredients when seedIdea is blank', async () => {
    catalogMocks.listIngredients.mockResolvedValue({ items: [
      { id: 'cat-c', type: 'character', name: 'Mira', payload: { description: 'A weary foundry foreman.' } },
      { id: 'cat-p', type: 'place', name: 'Foundry', payload: { summary: 'A silent ironworks.' } },
    ] });

    const s = await sb.createStorySession({
      title: 'Composed', // no seedIdea
      catalogIngredientIds: ['cat-c', 'cat-p'],
    });

    const series = await seriesSvc.getSeries(s.seriesId);
    const universe = await universeSvc.getUniverse(s.universeId);
    expect(series.premise).toContain('Characters:');
    expect(series.premise).toContain('- Mira: A weary foundry foreman.');
    expect(series.premise).toContain('Places:');
    expect(series.premise).toContain('- Foundry: A silent ironworks.');
    // The same composed seed feeds the universe starter prompt.
    expect(universe.starterPrompt).toBe(series.premise);
    // The user-facing seedIdea on the session stays the (empty) original.
    expect(s.seedIdea).toBe('');
  });

  it('keeps the user seedIdea when one is provided (no fallback compose)', async () => {
    const ing = { id: 'cat-c', type: 'character', name: 'Mira', payload: { description: 'desc' } };
    catalogMocks.listIngredients.mockResolvedValue({ items: [ing] });

    const s = await sb.createStorySession({
      title: 'WithSeed', seedIdea: 'the foundry goes silent',
      catalogIngredientIds: ['cat-c'],
    });

    const series = await seriesSvc.getSeries(s.seriesId);
    expect(series.premise).toBe('the foundry goes silent');
    // Still links the ingredient.
    expect(catalogMocks.linkIngredientsToSeries).toHaveBeenCalledWith(s.seriesId, [ing]);
  });

  it('still creates + saves the session when linking fails (best-effort, no orphan)', async () => {
    const ing = { id: 'cat-c', type: 'character', name: 'Mira', payload: {} };
    catalogMocks.listIngredients.mockResolvedValue({ items: [ing] });
    // A transient ref-insert failure must NOT reject the create (that would
    // orphan the just-minted universe/series with no session pointing at them).
    catalogMocks.linkIngredientsToSeries.mockRejectedValue(new Error('ref insert boom'));

    const s = await sb.createStorySession({
      title: 'Resilient', seedIdea: 'seed',
      catalogIngredientIds: ['cat-c'],
    });

    // Session was saved despite the link failure, and the shells exist.
    expect(s.id).toMatch(/^stb-/);
    expect((await sb.listStorySessions()).map((x) => x.id)).toContain(s.id);
    const persistedSeries = await seriesSvc.getSeries(s.seriesId);
    expect(persistedSeries.id).toBe(s.seriesId);
    expect(catalogMocks.linkIngredientsToSeries).toHaveBeenCalledWith(s.seriesId, [ing]);
  });

  it('does not link in import mode', async () => {
    const universe = await universeSvc.createUniverse({ name: 'U' });
    const series = await seriesSvc.createSeries({ name: 'S', universeId: universe.id });
    await sb.createStorySession({
      title: 'Imported', intakeMode: 'import',
      universeId: universe.id, seriesId: series.id,
      catalogIngredientIds: ['cat-c'],
    });
    expect(catalogMocks.listIngredients).not.toHaveBeenCalled();
    expect(catalogMocks.linkIngredientsToSeries).not.toHaveBeenCalled();
  });
});

describe('storyBuilder — lock state machine + gating', () => {
  it('lockStep stamps an upstreamHash and flips status to locked', async () => {
    const s = await sb.createStorySession({ title: 'X', seedIdea: 'seed' });
    const locked = await sb.lockStep(s.id, 'idea');
    expect(locked.steps.idea.locked).toBe(true);
    // lockedAt is a round-trippable ISO-8601 timestamp, not merely truthy.
    expect(new Date(locked.steps.idea.lockedAt).toISOString()).toBe(locked.steps.idea.lockedAt);
    // Shape AND derivation: the stamped hash must be the SAME value the
    // integrity helper produces from the idea step's whitelisted upstream
    // inputs — not just any 64-char hex digest. Asserting against the real
    // `hashUpstream` with the inputs spelled out here means any future drift in
    // the idea step's input set (e.g. a field added to / removed from
    // `buildUpstreamInputs`) surfaces as a failure on this line instead of
    // silently passing a shape-only regex. A buggy impl that always stamped
    // `hashUpstream('idea', null)` would now fail.
    // The idea step's hash now folds in its OWN outputs (#731) — the idea-expand
    // results on the just-minted universe/series — alongside its upstream inputs.
    // Derive the expected own-output projection from the live records so the
    // assertion stays correct if seed-minting defaults change, while still
    // failing loudly if the idea step's INPUT set drifts.
    const universe = await universeSvc.getUniverse(s.universeId);
    const series = await seriesSvc.getSeries(s.seriesId);
    const expectedHash = hashUpstream('idea', {
      intakeMode: 'seed',
      seedIdea: 'seed',
      ownOutputs: {
        starterPrompt: universe.starterPrompt || '',
        seriesLogline: series.logline || '',
        seriesPremise: series.premise || '',
      },
    });
    expect(locked.steps.idea.upstreamHash).toBe(expectedHash);
    // Sanity: the derived hash is still the documented 64-char hex shape.
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('allows jumping to any step out of order (start-from-anywhere)', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    // Navigation is advisory, not gated: the user may jump straight to a later
    // step and backfill the earlier ones. (Lock/stale state is surfaced as a
    // warning in the session view, enforced only at the generators.)
    const moved = await sb.setCurrentStep(s.id, 'plotArc');
    expect(moved.currentStep).toBe('plotArc');
    // Unknown ids still reject.
    await expect(sb.setCurrentStep(s.id, 'bogus')).rejects.toMatchObject({ code: sb.ERR_VALIDATION });
  });

  it('moving backward is always allowed', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await sb.lockStep(s.id, 'idea');
    await sb.setCurrentStep(s.id, 'universeAesthetic');
    const back = await sb.setCurrentStep(s.id, 'idea');
    expect(back.currentStep).toBe('idea');
  });

  it('unlockStep clears the lock and releases the underlying series arc lock', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await sb.lockStep(s.id, 'plotArc');
    let series = await seriesSvc.getSeries(s.seriesId);
    expect(series.locked.arc).toBe(true);
    const after = await sb.unlockStep(s.id, 'plotArc');
    expect(after.steps.plotArc.locked).toBe(false);
    series = await seriesSvc.getSeries(s.seriesId);
    expect(series.locked.arc).toBeUndefined();
  });
});

describe('storyBuilder — integrity / staleness', () => {
  it('flags a locked downstream step stale when an upstream record changes', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    // Give the series an arc + reader map, then lock the readerMap step.
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'spine', summary: 'sum', readerMap: { hooks: [{ label: 'h' }] } },
    });
    await sb.lockStep(s.id, 'readerMap');
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('readerMap');
    // Now change an upstream arc field the readerMap depends on.
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'CHANGED spine', summary: 'sum', readerMap: { hooks: [{ label: 'h' }] } },
    });
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('readerMap');
  });

  it('does not flag unlocked steps as stale', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'a', summary: 'b' } });
    const view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toEqual([]);
  });

  it('flags a locked universeAesthetic stale when the idea step re-runs with a new starterPrompt', async () => {
    // Regression for the codex review finding: universeAesthetic's upstream
    // hash must track universe.starterPrompt (an idea-step OUTPUT that the
    // aesthetic expand reads), not just session.seedIdea. Without this,
    // re-running idea expand with the same seed but a non-deterministic LLM
    // result silently keeps a locked aesthetic step un-flagged.
    const s = await sb.createStorySession({ title: 'X', seedIdea: 'seed' });
    await universeSvc.updateUniverse(s.universeId, { starterPrompt: 'starter v1' });
    await sb.lockStep(s.id, 'universeAesthetic');
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('universeAesthetic');
    // Mutate starterPrompt — same seedIdea but a fresh expansion.
    await universeSvc.updateUniverse(s.universeId, { starterPrompt: 'starter v2' });
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('universeAesthetic');
  });

  it('flags a locked universeAesthetic stale when its OWN output is edited out-of-band (#731)', async () => {
    // The session lock only gates the wizard — the universe record stays
    // editable in Universe Builder. Before #731, mutating universe.logline (an
    // aesthetic-step OUTPUT, not an upstream input) left the locked aesthetic
    // step un-flagged because the hash only tracked upstream inputs. Now the
    // step fingerprints its own outputs, so any post-lock edit flags it stale.
    const s = await sb.createStorySession({ title: 'X', seedIdea: 'seed' });
    await universeSvc.updateUniverse(s.universeId, {
      logline: 'a world of salt and rust', premise: 'the foundry goes silent',
    });
    await sb.lockStep(s.id, 'universeAesthetic');
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('universeAesthetic');
    // Edit the locked step's own logline directly (out-of-band, e.g. Universe Builder).
    await universeSvc.updateUniverse(s.universeId, { logline: 'a CHANGED world of salt and rust' });
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('universeAesthetic');
  });

  it('flags a locked plotArc stale when the arc itself is edited out-of-band (#731)', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum' } });
    await sb.lockStep(s.id, 'plotArc');
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('plotArc');
    // updateSeries respects series.locked.arc set by lockStep, but a direct edit
    // that clears the lock + rewrites the arc still surfaces as stale on read.
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'REWRITTEN spine', summary: 'sum' }, locked: {},
    });
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('plotArc');
  });

  it('flags a locked characters step stale when a character is added out-of-band (#731)', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await universeSvc.updateUniverse(s.universeId, {
      characters: [{ name: 'Ada', physicalDescription: 'the foundry forewoman' }],
    });
    await sb.lockStep(s.id, 'characters');
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('characters');
    await universeSvc.updateUniverse(s.universeId, {
      characters: [
        { name: 'Ada', physicalDescription: 'the foundry forewoman' },
        { name: 'Rook', physicalDescription: 'the rival' },
      ],
    });
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('characters');
  });

  it('flags a locked characters step stale when a character body field is edited out-of-band (#731)', async () => {
    // The cast fingerprint must track the canon body fields (physicalDescription,
    // personality, role, …), not just name — editing a locked character's
    // description in Universe Builder is exactly the out-of-band case #731 targets.
    const s = await sb.createStorySession({ title: 'X' });
    await universeSvc.updateUniverse(s.universeId, {
      characters: [{ name: 'Ada', physicalDescription: 'tall, soot-streaked', personality: 'guarded' }],
    });
    await sb.lockStep(s.id, 'characters');
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('characters');
    // Same name + count, only the body changes.
    await universeSvc.updateUniverse(s.universeId, {
      characters: [{ name: 'Ada', physicalDescription: 'CHANGED — gaunt, grease-stained', personality: 'guarded' }],
    });
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('characters');
  });

  it('flags a locked plotArc step stale when a season is edited out-of-band (#731)', async () => {
    // The plotArc step persists the season breakdown, so editing a season's
    // editorial content (here its synopsis) must flag the locked step stale even
    // though the arc core fields are untouched.
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'spine', summary: 'sum' },
      seasons: [{ number: 1, title: 'Vol 1', synopsis: 'the foundry goes silent' }],
    });
    await sb.lockStep(s.id, 'plotArc');
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('plotArc');
    // Edit only the season synopsis (arc core unchanged); the arc lock that
    // lockStep set is cleared so updateSeries accepts the season edit.
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'spine', summary: 'sum' }, locked: {},
      seasons: [{ number: 1, title: 'Vol 1', synopsis: 'CHANGED — the foundry roars back to life' }],
    });
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('plotArc');
  });
});

describe('storyBuilder — sync-safe staleness (#730)', () => {
  it('sessions are local-only (sync:false) by default and carry no baseline', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    expect(s.sync).toBe(false);
    expect(s.syncedHashes).toBeUndefined();
  });

  it('a peer universe edit does NOT false-positive-stale a synced session', async () => {
    // The exact #730 case: a sync-enabled session locks a step, then a peer's
    // universe edit lands via universe sync (modeled here as a direct
    // out-of-band updateSeries). A LOCAL-only session would flag stale (#731);
    // a synced session keys staleness off its carried baseline, so it does not.
    const s = await sb.createStorySession({ title: 'X' });
    await sb.setStorySessionSync(s.id, true);
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'spine', summary: 'sum', readerMap: { hooks: [{ label: 'h' }] } },
    });
    await sb.lockStep(s.id, 'readerMap');
    let view = await sb.getStorySessionView(s.id);
    expect(view.session.sync).toBe(true);
    expect(view.staleSteps).not.toContain('readerMap');
    // Peer edits the upstream arc out-of-band (universe/series sync) — no
    // session action touched the baseline, so it must NOT flag stale.
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'PEER-CHANGED spine', summary: 'sum', readerMap: { hooks: [{ label: 'h' }] } },
      locked: {},
    });
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('readerMap');
  });

  it('the SAME out-of-band edit DOES flag stale for a local-only session', async () => {
    // Mirror of the case above with sync OFF — confirms we only suppressed the
    // false-positive for synced sessions, not the genuine #731 detection.
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'spine', summary: 'sum', readerMap: { hooks: [{ label: 'h' }] } },
    });
    await sb.lockStep(s.id, 'readerMap');
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'CHANGED spine', summary: 'sum', readerMap: { hooks: [{ label: 'h' }] } },
      locked: {},
    });
    const view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('readerMap');
  });

  it('reconcile re-snapshots the baseline so a genuine drift surfaces', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await sb.setStorySessionSync(s.id, true);
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum' } });
    await sb.lockStep(s.id, 'plotArc');
    // Drift the upstream out-of-band; synced session ignores it until reconcile.
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'DRIFTED', summary: 'sum' }, locked: {} });
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('plotArc');
    // Reconcile adopts the current live records as the new baseline. The locked
    // step's frozen upstreamHash no longer matches → it surfaces as stale.
    await sb.reconcileStorySession(s.id);
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('plotArc');
  });

  it('view reports syncDrift when live records diverge from the synced baseline, and clears it on reconcile (#730)', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await sb.setStorySessionSync(s.id, true);
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum' } });
    await sb.lockStep(s.id, 'plotArc');
    // Baseline freshly captured at lock → no drift yet.
    let view = await sb.getStorySessionView(s.id);
    expect(view.syncDrift).toBe(false);
    // A peer edit moves the live records but not the carried baseline → drift.
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'DRIFTED', summary: 'sum' }, locked: {} });
    view = await sb.getStorySessionView(s.id);
    expect(view.syncDrift).toBe(true);
    // Reconcile adopts the live records as the new baseline → drift clears.
    await sb.reconcileStorySession(s.id);
    view = await sb.getStorySessionView(s.id);
    expect(view.syncDrift).toBe(false);
  });

  it('a local-only session always reports syncDrift:false', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum' } });
    await sb.lockStep(s.id, 'plotArc');
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'CHANGED', summary: 'sum' }, locked: {} });
    const view = await sb.getStorySessionView(s.id);
    expect(view.syncDrift).toBe(false);
  });

  it('turning sync OFF reverts to live-diff staleness and drops the baseline', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await sb.setStorySessionSync(s.id, true);
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum' } });
    await sb.lockStep(s.id, 'plotArc');
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'CHANGED', summary: 'sum' }, locked: {} });
    // Synced: not stale (baseline frozen).
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('plotArc');
    // Flip sync off → baseline gone, live-diff resumes → stale.
    const off = await sb.setStorySessionSync(s.id, false);
    expect(off.sync).toBe(false);
    expect(off.syncedHashes).toBeUndefined();
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).toContain('plotArc');
  });

  it('locking a step does NOT re-baseline OTHER already-locked steps', async () => {
    // Regression: locking step C must re-baseline only C, not move every locked
    // step's baseline to the current (possibly peer-edited) records — otherwise
    // a peer edit suppressed for an earlier-locked step would resurface as stale
    // the moment any unrelated step is locked, the exact #730 false-positive.
    const s = await sb.createStorySession({ title: 'X' });
    await sb.setStorySessionSync(s.id, true);
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum' } });
    await universeSvc.updateUniverse(s.universeId, {
      logline: 'a world of salt', premise: 'the foundry goes silent',
    });
    await sb.lockStep(s.id, 'plotArc'); // baseline[plotArc] = live now
    // Peer edits the arc out-of-band — suppressed for the synced session.
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'PEER spine', summary: 'sum' }, locked: {} });
    let view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('plotArc');
    // Lock an UNRELATED step. The buggy whole-map merge would move
    // baseline[plotArc] to the peer-edited arc → plotArc would flag stale.
    await sb.lockStep(s.id, 'universeAesthetic');
    view = await sb.getStorySessionView(s.id);
    expect(view.staleSteps).not.toContain('plotArc');
    expect(view.staleSteps).not.toContain('universeAesthetic');
  });

  it('reconcile rejects a local-only session (it is a re-baseline, not an enable)', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    expect(s.sync).toBe(false);
    await expect(sb.reconcileStorySession(s.id)).rejects.toMatchObject({ code: sb.ERR_VALIDATION });
  });

  it('sanitizer drops bogus / unknown-step entries from a hand-edited syncedHashes', async () => {
    const cleaned = sb.sanitizeSession({
      id: 'stb-x', title: 'X', sync: true,
      syncedHashes: {
        plotArc: 'a'.repeat(64), // valid
        readerMap: 'not-a-hash', // dropped (not 64-hex)
        bogusStep: 'b'.repeat(64), // dropped (unknown step id)
      },
    });
    expect(cleaned.sync).toBe(true);
    expect(cleaned.syncedHashes).toEqual({ plotArc: 'a'.repeat(64) });
  });
});

describe('storyBuilder — generate delegation', () => {
  it('generateStep(plotArc) persists the arc onto the series', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'arc logline', summary: 'arc summary', shape: 'man-in-hole', seasonOutlines: [] },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.generateStep(s.id, 'plotArc');
    const series = await seriesSvc.getSeries(s.seriesId);
    expect(series.arc.logline).toBe('arc logline');
    expect(series.arc.shape).toBe('man-in-hole');
  });

  it('generateStep(readerMap) works even after the plot arc is locked', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum' } });
    await sb.lockStep(s.id, 'plotArc'); // sets series.locked.arc = true
    stageRunnerSpy = vi.fn(async () => ({
      content: { hooks: [{ label: 'why?' }], payoffs: [], beats: [], cliffhangers: [] },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.generateStep(s.id, 'readerMap');
    const series = await seriesSvc.getSeries(s.seriesId);
    expect(series.arc.readerMap.hooks[0].label).toBe('why?');
    // The locked arc core fields are untouched.
    expect(series.arc.logline).toBe('spine');
    expect(series.locked.arc).toBe(true);
  });

  it('defaults the provider/model from session.llm when no per-call override is given', async () => {
    const s = await sb.createStorySession({ title: 'X', llm: { provider: 'prov-x', model: 'model-y' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'al', summary: 'as', seasonOutlines: [] }, runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.generateStep(s.id, 'plotArc'); // no options → must fall back to session.llm
    // arcPlanner forwards the resolved override into runStagedLLM's options.
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      expect.any(String), expect.any(Object),
      expect.objectContaining({ providerOverride: 'prov-x', modelOverride: 'model-y' }),
    );
  });

  it('an explicit per-call provider override beats session.llm', async () => {
    const s = await sb.createStorySession({ title: 'X', llm: { provider: 'prov-x', model: 'model-y' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'al', summary: 'as', seasonOutlines: [] }, runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.generateStep(s.id, 'plotArc', { providerId: 'override-z', model: 'override-m' });
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      expect.any(String), expect.any(Object),
      expect.objectContaining({ providerOverride: 'override-z', modelOverride: 'override-m' }),
    );
  });

  it('generateStep(idea) skips writing a locked universe.logline', async () => {
    // Regression for the codex review finding: locking the aesthetic step
    // sets universe.locked.{logline,premise,...}=true, but updateUniverse
    // doesn't enforce those locks on scalar writes — so a re-run of the
    // idea step would otherwise silently clobber the locked logline.
    const s = await sb.createStorySession({ title: 'X', seedIdea: 'seed' });
    await universeSvc.updateUniverse(s.universeId, {
      logline: 'frozen logline',
      locked: { logline: true },
    });
    stageRunnerSpy = vi.fn(async () => ({
      content: { expandedIdea: 'new starter prose', logline: 'replacement logline that must NOT land' },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.generateStep(s.id, 'idea');
    const universe = await universeSvc.getUniverse(s.universeId);
    expect(universe.logline).toBe('frozen logline');
    // starterPrompt is NOT locked by the aesthetic step's keys, so this DID land.
    expect(universe.starterPrompt).toBe('new starter prose');
  });
});

describe('storyBuilder — refine delegation', () => {
  it('refineStep(plotArc) persists the refined arc narrative onto the series', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'old', summary: 'old summary', shape: 'man-in-hole' } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'refined logline', summary: 'refined summary', changes: ['x'], rationale: 'y' },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const out = await sb.refineStep(s.id, 'plotArc', { feedback: 'sharpen it' });
    expect(stageRunnerSpy).toHaveBeenCalledWith('story-builder-arc-refine', expect.any(Object), expect.objectContaining({ returnsJson: true }));
    const series = await seriesSvc.getSeries(s.seriesId);
    expect(series.arc.logline).toBe('refined logline');
    expect(series.arc.summary).toBe('refined summary');
    // narrative-only refine preserves the picked shape.
    expect(series.arc.shape).toBe('man-in-hole');
    expect(out.changes).toEqual(['x']);
    expect(out.rationale).toBe('y');
    // The conductor surfaces which provider/model ran so the runner's SSE
    // `complete` event (and the UI toast) can attribute the refine.
    expect(out.providerId).toBe('p');
    expect(out.model).toBe('m');
  });

  it('refineStep(readerMap) persists the reader map and surfaces provider/model attribution', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum', readerMap: { hooks: [{ label: 'old' }] } } });
    stageRunnerSpy = vi.fn(async () => ({
      content: { hooks: [{ label: 'new' }], payoffs: [], beats: [], cliffhangers: [], changes: ['c'], rationale: 'r' },
      runId: 'run-x', providerId: 'prov-x', model: 'model-y',
    }));
    const out = await sb.refineStep(s.id, 'readerMap', { feedback: 'sharpen' });
    const series = await seriesSvc.getSeries(s.seriesId);
    expect(series.arc.readerMap.hooks[0].label).toBe('new');
    expect(out.changes).toEqual(['c']);
    expect(out.rationale).toBe('r');
    // Without this the runner reports an undefined provider/model on the SSE
    // `complete` event for reader-map refines (the bug this guards against).
    expect(out.providerId).toBe('prov-x');
    expect(out.model).toBe('model-y');
  });

  it('refineStep(plotArc) leaves the season breakdown untouched (arc-only persist)', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, {
      arc: { logline: 'old', summary: 'old summary' },
      seasons: [{ number: 1, title: 'Volume One', episodeCountTarget: 6 }],
    });
    const before = await seriesSvc.getSeries(s.seriesId);
    stageRunnerSpy = vi.fn(async () => ({
      content: { logline: 'refined', summary: 'refined summary', changes: [], rationale: '' },
      runId: 'r', providerId: 'p', model: 'm',
    }));
    await sb.refineStep(s.id, 'plotArc', { feedback: 'sharpen' });
    const after = await seriesSvc.getSeries(s.seriesId);
    expect(after.arc.logline).toBe('refined');
    // Seasons are byte-for-byte unchanged — refine never routes through the
    // season remap, so no id churn or issue reassignment.
    expect(after.seasons).toEqual(before.seasons);
  });

  it('refineStep(plotArc) refuses when the arc is locked', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum' } });
    await sb.lockStep(s.id, 'plotArc'); // sets series.locked.arc = true
    stageRunnerSpy = vi.fn();
    await expect(sb.refineStep(s.id, 'plotArc', { feedback: 'x' })).rejects.toMatchObject({ code: 'PIPELINE_ARC_VALIDATION' });
    expect(stageRunnerSpy).not.toHaveBeenCalled();
  });

  it('refineStep(plotArc) re-checks the arc lock at commit time (locked mid-flight) and does not persist', async () => {
    const s = await sb.createStorySession({ title: 'X' });
    await seriesSvc.updateSeries(s.seriesId, { arc: { logline: 'spine', summary: 'sum' } });
    // Simulate the arc being locked DURING the in-flight LLM call: the stage
    // runner locks the arc before returning, so refineArc's pre-call snapshot
    // saw it unlocked but the commit-time re-read must catch it.
    stageRunnerSpy = vi.fn(async () => {
      await sb.lockStep(s.id, 'plotArc');
      return { content: { logline: 'should not land', summary: 'nope', changes: [], rationale: '' }, runId: 'r', providerId: 'p', model: 'm' };
    });
    await expect(sb.refineStep(s.id, 'plotArc', { feedback: 'x' })).rejects.toMatchObject({ code: 'PIPELINE_ARC_VALIDATION' });
    const after = await seriesSvc.getSeries(s.seriesId);
    expect(after.arc.logline).toBe('spine'); // unchanged — refine did not persist
  });
});

describe('generateStep backfill (fromDownstream)', () => {
  // Record the stage + vars of the most recent staged-LLM call so a test can
  // assert which prompt a backfill routed through.
  let seenStage;
  let seenVars;
  function installSpy() {
    seenStage = null; seenVars = null;
    stageRunnerSpy = async (stage, vars) => {
      seenStage = stage; seenVars = vars;
      let content = {};
      if (stage === 'story-builder-idea-expand') content = { title: 'T', logline: 'L', expandedIdea: 'E' };
      else if (stage === 'importer-arc-extract') {
        content = {
          logline: 'Backfilled arc logline', summary: 'Backfilled summary',
          protagonistArc: 'grows', themes: ['legacy'], shape: 'man-in-hole',
          seasons: [{ number: 1, title: 'Vol 1', logline: 'v1', synopsis: 's1', endingHook: 'hook' }],
        };
      } else if (stage === 'pipeline-arc-overview') {
        content = {
          logline: 'Forward arc logline', summary: 'Forward summary',
          protagonistArc: 'grows', themes: ['legacy'], shape: 'man-in-hole',
          seasonOutlines: [{ number: 1, title: 'Vol 1', episodeCountTarget: 6 }],
        };
      }
      return { content, runId: 'run-x', providerId: 'p', model: 'm' };
    };
  }

  // A seed session mints its own universe + series; attach a drafted comic
  // script to one issue, mirroring the "started from a drafted comic" case.
  async function makeSessionWithDraftedIssue() {
    const s = await sb.createStorySession({ title: 'Backfill' });
    const issue = await issuesSvc.createIssue({ seriesId: s.seriesId, title: 'Issue One' });
    await issuesSvc.updateStage(issue.id, 'comicScript', { status: 'ready', output: 'PAGE 1 ... a drafted comic script ...' });
    return { session: s, issue };
  }

  it('plotArc backfill extracts the arc from issue content via importer-arc-extract', async () => {
    installSpy();
    const { session } = await makeSessionWithDraftedIssue();
    const res = await sb.generateStep(session.id, 'plotArc', { fromDownstream: true });
    expect(seenStage).toBe('importer-arc-extract');
    expect(seenVars.source).toContain('drafted comic script');
    const updated = await seriesSvc.getSeries(session.seriesId);
    expect(updated.arc?.logline).toBe('Backfilled arc logline');
    expect(updated.seasons?.length).toBe(1);
    expect(updated.seasons[0].synopsis).toBe('s1');
    expect(res.runId).toBe('run-x');
  });

  it('plotArc forward path still uses pipeline-arc-overview (no fromDownstream)', async () => {
    installSpy();
    const { session } = await makeSessionWithDraftedIssue();
    await sb.generateStep(session.id, 'plotArc', {});
    expect(seenStage).toBe('pipeline-arc-overview');
  });

  it('plotArc backfill refuses when no issue has content', async () => {
    installSpy();
    const s = await sb.createStorySession({ title: 'Empty' });
    await expect(sb.generateStep(s.id, 'plotArc', { fromDownstream: true }))
      .rejects.toThrow(/No issue content/);
  });

  it('idea backfill feeds issue content into the idea-expand prompt', async () => {
    installSpy();
    const { session } = await makeSessionWithDraftedIssue();
    await sb.generateStep(session.id, 'idea', { fromDownstream: true });
    expect(seenStage).toBe('story-builder-idea-expand');
    expect(seenVars.sourceMaterial).toContain('drafted comic script');
  });

  it('idea forward path sends an empty sourceMaterial', async () => {
    installSpy();
    const { session } = await makeSessionWithDraftedIssue();
    await sb.generateStep(session.id, 'idea', {});
    expect(seenStage).toBe('story-builder-idea-expand');
    expect(seenVars.sourceMaterial).toBe('');
  });

  it('idea backfill refuses when no issue has content', async () => {
    installSpy();
    const s = await sb.createStorySession({ title: 'Empty' });
    await expect(sb.generateStep(s.id, 'idea', { fromDownstream: true }))
      .rejects.toThrow(/No issue content/);
  });
});

describe('generateIssuesFromArc (issues step)', () => {
  // Attach one or more seasons to a freshly-minted seed session's series and
  // return the persisted season ids (sanitizer may re-mint them).
  async function seedSeasons(seriesId, seasons) {
    await seriesSvc.updateSeries(seriesId, { seasons });
    const series = await seriesSvc.getSeries(seriesId);
    return series.seasons;
  }

  // The season-episodes LLM pass returns `{ episodes: [...] }`; shapeEpisodes
  // keeps title + number + arcRole + lengthProfile + logline/synopsis.
  function episodesSpy(episodesBySeasonTitle) {
    stageRunnerSpy = vi.fn(async (stage, vars) => {
      if (stage !== 'pipeline-season-episodes') return { content: {}, runId: 'r', providerId: 'p', model: 'm' };
      const episodes = episodesBySeasonTitle[vars?.season?.title] || [];
      return { content: { episodes }, runId: 'r', providerId: 'p', model: 'm' };
    });
  }

  it('creates one issue per episode for every season and seeds idea input', async () => {
    const s = await sb.createStorySession({ title: 'Arc Seed' });
    const seasons = await seedSeasons(s.seriesId, [
      { number: 1, title: 'Vol 1', synopsis: 'foundry goes silent' },
    ]);
    episodesSpy({
      'Vol 1': [
        { number: 1, title: 'Pilot', logline: 'it begins', synopsis: 'cold open', arcRole: 'pilot', lengthProfile: 'standard' },
        { number: 2, title: 'Complication', logline: 'it worsens', synopsis: '', arcRole: 'complication' },
      ],
    });
    const res = await sb.generateIssuesFromArc(s.id);
    expect(res.createdIssues).toHaveLength(2);
    expect(res.seasons).toEqual([
      expect.objectContaining({ seasonId: seasons[0].id, created: 2, skipped: false }),
    ]);
    const issues = await issuesSvc.listIssues({ seriesId: s.seriesId });
    expect(issues.map((i) => i.title).sort()).toEqual(['Complication', 'Pilot']);
    const pilot = issues.find((i) => i.title === 'Pilot');
    expect(pilot.seasonId).toBe(seasons[0].id);
    // logline + synopsis land in stages.idea.input; status is 'edited' when a
    // synopsis exists, 'empty' otherwise.
    expect(pilot.stages.idea.input).toBe('it begins\n\ncold open');
    expect(pilot.stages.idea.status).toBe('edited');
    const comp = issues.find((i) => i.title === 'Complication');
    expect(comp.stages.idea.status).toBe('empty');
    expect(comp.stages.idea.input).toBe('it worsens');
  });

  it('skips a locked season but still seeds the eligible ones (partial batch)', async () => {
    const s = await sb.createStorySession({ title: 'Partial' });
    const seasons = await seedSeasons(s.seriesId, [
      { number: 1, title: 'Vol 1', synopsis: 'open', locked: true },
      { number: 2, title: 'Vol 2', synopsis: 'rises' },
    ]);
    episodesSpy({ 'Vol 2': [{ number: 1, title: 'V2 E1', arcRole: 'pilot' }] });
    const res = await sb.generateIssuesFromArc(s.id);
    expect(res.createdIssues).toHaveLength(1);
    const locked = res.seasons.find((r) => r.seasonId === seasons[0].id);
    const open = res.seasons.find((r) => r.seasonId === seasons[1].id);
    // A locked season is an ineligible-config skip, not a failure.
    expect(locked).toMatchObject({ skipped: true, failed: false, created: 0 });
    expect(locked.reason).toMatch(/locked/i);
    expect(open).toMatchObject({ skipped: false, failed: false, created: 1 });
  });

  it('reports a transient provider/LLM error as failed (not skipped)', async () => {
    const s = await sb.createStorySession({ title: 'Flaky' });
    const seasons = await seedSeasons(s.seriesId, [
      { number: 1, title: 'Vol 1', synopsis: 'open' },
      { number: 2, title: 'Vol 2', synopsis: 'rises' },
    ]);
    // Vol 1's episodes pass throws a plain (non-validation) error — provider
    // down / timeout. Vol 2 succeeds. The batch must not abort, and Vol 1 must
    // be `failed`, not `skipped`.
    stageRunnerSpy = vi.fn(async (stage, vars) => {
      if (vars?.season?.title === 'Vol 1') throw new Error('provider unavailable');
      return { content: { episodes: [{ number: 1, title: 'V2 E1', arcRole: 'pilot' }] }, runId: 'r', providerId: 'p', model: 'm' };
    });
    const res = await sb.generateIssuesFromArc(s.id);
    expect(res.createdIssues).toHaveLength(1);
    const bad = res.seasons.find((r) => r.seasonId === seasons[0].id);
    const good = res.seasons.find((r) => r.seasonId === seasons[1].id);
    expect(bad).toMatchObject({ skipped: false, failed: true, created: 0 });
    expect(bad.reason).toMatch(/provider unavailable/);
    expect(good).toMatchObject({ skipped: false, failed: false, created: 1 });
  });

  it('scopes to a single season when seasonId is given', async () => {
    const s = await sb.createStorySession({ title: 'Scoped' });
    const seasons = await seedSeasons(s.seriesId, [
      { number: 1, title: 'Vol 1', synopsis: 'a' },
      { number: 2, title: 'Vol 2', synopsis: 'b' },
    ]);
    episodesSpy({
      'Vol 1': [{ number: 1, title: 'V1 E1', arcRole: 'pilot' }],
      'Vol 2': [{ number: 1, title: 'V2 E1', arcRole: 'pilot' }],
    });
    const res = await sb.generateIssuesFromArc(s.id, { seasonId: seasons[1].id });
    expect(res.seasons).toHaveLength(1);
    expect(res.seasons[0].seasonId).toBe(seasons[1].id);
    const issues = await issuesSvc.listIssues({ seriesId: s.seriesId });
    expect(issues.map((i) => i.title)).toEqual(['V2 E1']);
  });

  it('forwards the session.llm provider/model into the episodes pass', async () => {
    const s = await sb.createStorySession({ title: 'LLM', llm: { provider: 'prov-x', model: 'model-y' } });
    await seedSeasons(s.seriesId, [{ number: 1, title: 'Vol 1', synopsis: 'a' }]);
    episodesSpy({ 'Vol 1': [{ number: 1, title: 'E1', arcRole: 'pilot' }] });
    await sb.generateIssuesFromArc(s.id);
    expect(stageRunnerSpy).toHaveBeenCalledWith(
      'pipeline-season-episodes', expect.any(Object),
      expect.objectContaining({ providerOverride: 'prov-x', modelOverride: 'model-y' }),
    );
  });

  it('throws when the series has no seasons yet', async () => {
    const s = await sb.createStorySession({ title: 'No Seasons' });
    await expect(sb.generateIssuesFromArc(s.id)).rejects.toMatchObject({ code: sb.ERR_VALIDATION });
  });

  it('throws when the scoped seasonId is unknown', async () => {
    const s = await sb.createStorySession({ title: 'Bad Season' });
    await seedSeasons(s.seriesId, [{ number: 1, title: 'Vol 1', synopsis: 'a' }]);
    await expect(sb.generateIssuesFromArc(s.id, { seasonId: 'season-nope' }))
      .rejects.toMatchObject({ code: sb.ERR_VALIDATION });
  });
});

describe('storyBuilder — cross-machine sync wire (#730)', () => {
  it('listSyncableSessionsForWire excludes local-only sessions and includes only sync:true', async () => {
    const local = await sb.createStorySession({ title: 'Local only' });
    const synced = await sb.createStorySession({ title: 'Synced' });
    await sb.setStorySessionSync(synced.id, true);

    const wire = await sb.listSyncableSessionsForWire();
    const ids = wire.map((s) => s.id);
    expect(ids).toContain(synced.id);
    expect(ids).not.toContain(local.id);
    // The wire form must never carry a peer-local marker.
    expect(wire.every((s) => !('ephemeral' in s))).toBe(true);
    // Deterministic ordering by id for a stable checksum.
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it('sanitizeSessionForWire returns null for a non-sync session and for a non-tombstone ephemeral session', () => {
    expect(sb.sanitizeSessionForWire({ id: 'stb-x', title: 'T', sync: false })).toBeNull();
    expect(sb.sanitizeSessionForWire({ id: 'stb-y', title: 'T', sync: true, ephemeral: true })).toBeNull();
    const ok = sb.sanitizeSessionForWire({ id: 'stb-z', title: 'T', sync: true });
    expect(ok).toMatchObject({ id: 'stb-z', sync: true });
  });

  it('merge adopts a new remote sync session verbatim', async () => {
    const remote = {
      id: 'stb-remote-1', title: 'From peer', intakeMode: 'seed',
      sync: true, syncedHashes: {}, currentStep: 'idea',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const res = await sb.mergeStorySessionsFromSync([remote]);
    expect(res).toEqual({ applied: true, count: 1 });
    const got = await sb.getStorySession('stb-remote-1');
    expect(got.title).toBe('From peer');
    expect(got.sync).toBe(true);
  });

  it('merge is LWW on updatedAt — newer remote wins, older remote is a no-op', async () => {
    const base = {
      id: 'stb-lww', title: 'v1', intakeMode: 'seed', sync: true, syncedHashes: {},
      currentStep: 'idea', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await sb.mergeStorySessionsFromSync([base]);
    // Older remote → ignored.
    const older = await sb.mergeStorySessionsFromSync([{ ...base, title: 'stale', updatedAt: '2025-12-31T00:00:00.000Z' }]);
    expect(older.applied).toBe(false);
    expect((await sb.getStorySession('stb-lww')).title).toBe('v1');
    // Newer remote → wins.
    const newer = await sb.mergeStorySessionsFromSync([{ ...base, title: 'v2', updatedAt: '2026-02-01T00:00:00.000Z' }]);
    expect(newer.applied).toBe(true);
    expect((await sb.getStorySession('stb-lww')).title).toBe('v2');
  });

  it('merge refuses to re-sync a session the local user turned local-only', async () => {
    const synced = await sb.createStorySession({ title: 'Was synced' });
    await sb.setStorySessionSync(synced.id, true);
    // User disables sync locally (now sync:false, local-only).
    await sb.setStorySessionSync(synced.id, false);
    // A stale peer push for the same id must NOT flip it back on or overwrite it.
    const res = await sb.mergeStorySessionsFromSync([{
      id: synced.id, title: 'peer wins?', intakeMode: 'seed', sync: true, syncedHashes: {},
      currentStep: 'idea', createdAt: synced.createdAt, updatedAt: '2030-01-01T00:00:00.000Z',
    }]);
    expect(res.applied).toBe(false);
    const got = await sb.getStorySession(synced.id);
    expect(got.sync).toBe(false);
    expect(got.title).toBe('Was synced');
  });

  it('merge refuses a remote session that is not sync-enabled', async () => {
    const res = await sb.mergeStorySessionsFromSync([{
      id: 'stb-not-synced', title: 'sneaky', sync: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }]);
    expect(res.applied).toBe(false);
    await expect(sb.getStorySession('stb-not-synced')).rejects.toMatchObject({ code: sb.ERR_NOT_FOUND });
  });

  it('merge is first-wins within a batch for a duplicate id', async () => {
    const dupA = {
      id: 'stb-dup', title: 'first', intakeMode: 'seed', sync: true, syncedHashes: {},
      currentStep: 'idea', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z',
    };
    const dupB = { ...dupA, title: 'second', updatedAt: '2026-04-01T00:00:00.000Z' };
    await sb.mergeStorySessionsFromSync([dupA, dupB]);
    // first-wins dedup keeps dupA despite dupB's newer timestamp.
    expect((await sb.getStorySession('stb-dup')).title).toBe('first');
  });

  it('merge converges a tombstone for a synced session', async () => {
    const base = {
      id: 'stb-tomb', title: 'doomed', intakeMode: 'seed', sync: true, syncedHashes: {},
      currentStep: 'idea', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    };
    await sb.mergeStorySessionsFromSync([base]);
    const res = await sb.mergeStorySessionsFromSync([{
      ...base, deleted: true, deletedAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-05-01T00:00:00.000Z',
    }]);
    expect(res.applied).toBe(true);
    await expect(sb.getStorySession('stb-tomb')).rejects.toMatchObject({ code: sb.ERR_NOT_FOUND });
    const withDeleted = await sb.getStorySession('stb-tomb', { includeDeleted: true });
    expect(withDeleted.deleted).toBe(true);
  });
});
