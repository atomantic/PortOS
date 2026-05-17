import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory file store mirrors universeBuilder.test.js / universeCanon.test.js
// so a single readState/writeState path roundtrips through the same code the
// real service uses (no live file I/O).
const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
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

// Stub the provider + LLM dispatch so tests don't need a live runner. The
// `runPromptThroughProvider` mock is overridden per-test to return the
// per-kind JSON shape we expect from the LLM.
const getActiveProviderMock = vi.fn();
const getProviderByIdMock = vi.fn();
vi.mock('./providers.js', () => ({
  getActiveProvider: (...a) => getActiveProviderMock(...a),
  getProviderById: (...a) => getProviderByIdMock(...a),
}));

const runPromptThroughProviderMock = vi.fn();
vi.mock('../lib/promptRunner.js', () => ({
  runPromptThroughProvider: (...a) => runPromptThroughProviderMock(...a),
  resolveEffectiveModel: (_provider, model) => model || 'mock-default',
}));

// Pull services AFTER mocks register so module-level imports resolve through
// the mock chain.
const svc = await import('./universeBuilder.js');
const promoteSvc = await import('./universeBuilderPromote.js');
const fileUtils = await import('../lib/fileUtils.js');

const seedUniverseWithBucket = async (categories, canon = {}) => {
  const w = await svc.createUniverse({
    name: 'Test Universe',
    starterPrompt: 'test seed',
    influences: { embrace: ['cel-shading'], avoid: ['lowres'] },
  });
  // Plant categories + canon directly via updateUniverse so the sanitizer
  // tags `kind` correctly (handles 'characters' bucket retirement too).
  return svc.updateUniverse(w.id, { categories, ...canon });
};

const mockLlm = (entry) => {
  runPromptThroughProviderMock.mockResolvedValue({
    text: JSON.stringify(entry),
    runId: 'run-promote-1',
    model: 'mock-default',
  });
};

beforeEach(() => {
  fileStore.clear();
  uuidCounter = 0;
  getActiveProviderMock.mockReset();
  getProviderByIdMock.mockReset();
  runPromptThroughProviderMock.mockReset();
  getActiveProviderMock.mockResolvedValue({
    id: 'provider-mock', name: 'Mock', type: 'api', defaultModel: 'mock-default',
  });
});

describe('universeBuilderPromote — happy path', () => {
  it('promotes a variation from a settings-kinded bucket into universe.settings[]', async () => {
    const w = await seedUniverseWithBucket({
      landscapes: {
        kind: 'settings',
        variations: [
          { label: 'Crystalline canyon', prompt: 'vast crystalline canyon, salt flats' },
          { label: 'Scrap dune sea', prompt: 'rolling dunes of rusted scrap' },
        ],
      },
    });
    mockLlm({
      name: 'Crystalline Canyon',
      description: 'A vast canyon of luminous salt-crystal walls.',
      palette: 'pale violet, salt white, dust amber',
      era: 'post-civilization',
      weather: 'arid, scoured by dust devils',
      recurringDetails: 'wind chimes carved from crystal',
      prompt: 'vast crystalline canyon, salt flats, low horizon',
      tags: ['signature-place'],
    });

    const result = await promoteSvc.promoteVariationToCanon(w.id, {
      category: 'landscapes',
      label: 'Crystalline canyon',
    });

    expect(result.targetKind).toBe('settings');
    expect(result.entry.name).toBe('Crystalline Canyon');
    expect(result.entry.palette).toContain('pale violet');
    expect(result.universe.settings.some((e) => e.name === 'Crystalline Canyon')).toBe(true);
    // The source variation is removed from its bucket.
    const remainingLabels = result.universe.categories.landscapes.variations.map((v) => v.label);
    expect(remainingLabels).toEqual(['Scrap dune sea']);
    expect(result.removed).toEqual({ category: 'landscapes', label: 'Crystalline canyon' });
  });

  it('promotes a variation from a characters-kinded bucket into universe.characters[]', async () => {
    const w = await seedUniverseWithBucket({
      heroes: {
        kind: 'characters',
        variations: [
          { label: 'Ash the Foundling', prompt: 'lone child of the foundry, soot-stained' },
        ],
      },
    });
    mockLlm({
      name: 'Ash',
      physicalDescription: 'A wiry child, 8 years old, soot-stained skin, copper hair, salvaged goggles.',
      personality: 'Watchful, slow to speak, quick to act.',
      background: 'Only survivor of the foundry silence.',
      role: 'protagonist',
      prompt: 'child of the foundry, soot-stained, copper hair',
      tags: ['protagonist'],
    });

    const result = await promoteSvc.promoteVariationToCanon(w.id, {
      category: 'heroes',
      label: 'Ash the Foundling',
    });

    expect(result.targetKind).toBe('characters');
    expect(result.universe.characters.find((c) => c.name === 'Ash')).toBeTruthy();
    expect(result.universe.categories.heroes.variations).toEqual([]);
  });

  it('matches variation labels case-insensitively', async () => {
    const w = await seedUniverseWithBucket({
      colonies: {
        kind: 'settings',
        variations: [{ label: 'Gas-Giant Drifters', prompt: 'balloon settlements in the upper atmosphere' }],
      },
    });
    mockLlm({ name: 'Gas-Giant Drifters', description: 'A balloon-colony civilization.', prompt: 'balloon settlement' });

    const result = await promoteSvc.promoteVariationToCanon(w.id, {
      category: 'colonies',
      label: 'gas-giant drifters', // lowercase
    });

    expect(result.universe.settings.find((s) => s.name === 'Gas-Giant Drifters')).toBeTruthy();
  });

  it('seeds entry.name from the variation label when the LLM omits name', async () => {
    const w = await seedUniverseWithBucket({
      vehicles: {
        kind: 'objects',
        variations: [{ label: 'Scavenger Walker Mech', prompt: 'rusted bipedal salvage mech' }],
      },
    });
    mockLlm({
      // name absent — server should default to variation label
      description: 'A four-story salvage mech.',
      significance: 'Built from the bones of the silent foundry.',
      tags: ['hero-vehicle'],
    });

    const result = await promoteSvc.promoteVariationToCanon(w.id, {
      category: 'vehicles',
      label: 'Scavenger Walker Mech',
    });
    expect(result.entry.name).toBe('Scavenger Walker Mech');
  });

  it('seeds entry.prompt from the variation when LLM omits prompt', async () => {
    const w = await seedUniverseWithBucket({
      vehicles: {
        kind: 'objects',
        variations: [{ label: 'Salvage Mech', prompt: 'rusted bipedal mech, scavenged armor' }],
      },
    });
    mockLlm({ name: 'Salvage Mech', description: 'A walker.' });

    const result = await promoteSvc.promoteVariationToCanon(w.id, {
      category: 'vehicles',
      label: 'Salvage Mech',
    });
    expect(result.entry.prompt).toBe('rusted bipedal mech, scavenged armor');
  });
});

describe('universeBuilderPromote — targetKind override + other-bucket gate', () => {
  it('requires targetKind for `kind: "other"` buckets', async () => {
    const w = await seedUniverseWithBucket({
      myth_archetypes: {
        // No `kind: 'other'` set explicitly — sanitizer defaults to 'other'.
        variations: [{ label: 'Solstice Mask', prompt: 'midnight procession' }],
      },
    });
    await expect(
      promoteSvc.promoteVariationToCanon(w.id, {
        category: 'myth_archetypes',
        label: 'Solstice Mask',
      }),
    ).rejects.toMatchObject({ status: 400, code: 'UNIVERSE_PROMOTE_NO_TARGET_KIND' });
  });

  it('promotes from an other-bucket when targetKind is provided', async () => {
    const w = await seedUniverseWithBucket({
      myth_archetypes: {
        variations: [{ label: 'Solstice Mask', prompt: 'midnight procession with bone masks' }],
      },
    });
    mockLlm({
      name: 'The Solstice Mask',
      description: 'A ritual mask carved from antler bone.',
      significance: 'Worn only when the long night begins.',
      tags: ['ritual'],
    });
    const result = await promoteSvc.promoteVariationToCanon(w.id, {
      category: 'myth_archetypes',
      label: 'Solstice Mask',
      targetKind: 'objects',
    });
    expect(result.targetKind).toBe('objects');
    expect(result.universe.objects.find((o) => o.name === 'The Solstice Mask')).toBeTruthy();
  });

  it('rejects invalid targetKind even for non-other buckets', async () => {
    const w = await seedUniverseWithBucket({
      landscapes: {
        kind: 'settings',
        variations: [{ label: 'Salt flats', prompt: 'horizon-spanning salt flats' }],
      },
    });
    // The bucket kind is 'settings', so the server should ignore an
    // ill-typed targetKind and proceed with the bucket-derived kind. (The
    // route schema would reject the bad value before reaching here in prod.)
    mockLlm({ name: 'Salt Flats', description: 'A flat expanse.', prompt: 'horizon salt flats' });
    const result = await promoteSvc.promoteVariationToCanon(w.id, {
      category: 'landscapes',
      label: 'Salt flats',
      targetKind: 'invalid',
    });
    expect(result.targetKind).toBe('settings');
  });
});

describe('universeBuilderPromote — error paths', () => {
  it('404s when the category does not exist', async () => {
    const w = await seedUniverseWithBucket({
      landscapes: {
        kind: 'settings',
        variations: [{ label: 'A', prompt: 'a' }],
      },
    });
    await expect(
      promoteSvc.promoteVariationToCanon(w.id, { category: 'nonexistent', label: 'A' }),
    ).rejects.toMatchObject({ status: 404, code: 'UNIVERSE_PROMOTE_NO_CATEGORY' });
  });

  it('404s when the variation label does not match', async () => {
    const w = await seedUniverseWithBucket({
      landscapes: {
        kind: 'settings',
        variations: [{ label: 'A', prompt: 'a' }],
      },
    });
    await expect(
      promoteSvc.promoteVariationToCanon(w.id, { category: 'landscapes', label: 'B' }),
    ).rejects.toMatchObject({ status: 404, code: 'UNIVERSE_PROMOTE_VARIATION_NOT_FOUND' });
  });

  it('400s on missing category', async () => {
    await expect(
      promoteSvc.promoteVariationToCanon('any', { label: 'x' }),
    ).rejects.toMatchObject({ status: 400, code: 'UNIVERSE_PROMOTE_NO_CATEGORY' });
  });

  it('400s on missing label', async () => {
    await expect(
      promoteSvc.promoteVariationToCanon('any', { category: 'landscapes' }),
    ).rejects.toMatchObject({ status: 400, code: 'UNIVERSE_PROMOTE_NO_LABEL' });
  });

  it('409s when a canon entry with the same name already exists', async () => {
    const existing = [{
      name: 'Crystalline Canyon',
      slugline: 'EXT. CANYON — DAY',
      description: 'A pre-existing canon entry.',
    }];
    const w = await seedUniverseWithBucket(
      {
        landscapes: {
          kind: 'settings',
          variations: [{ label: 'Crystalline Canyon', prompt: 'salt-crystal walls' }],
        },
      },
      { settings: existing },
    );
    await expect(
      promoteSvc.promoteVariationToCanon(w.id, {
        category: 'landscapes',
        label: 'Crystalline Canyon',
      }),
    ).rejects.toMatchObject({ status: 409, code: 'UNIVERSE_PROMOTE_DUPLICATE' });
    // LLM should NOT be invoked when the duplicate check fails up front —
    // we want a cheap rejection, not a wasted model call.
    expect(runPromptThroughProviderMock).not.toHaveBeenCalled();
  });

  it('throws 502 when the LLM returns invalid JSON', async () => {
    const w = await seedUniverseWithBucket({
      landscapes: {
        kind: 'settings',
        variations: [{ label: 'A', prompt: 'a' }],
      },
    });
    runPromptThroughProviderMock.mockResolvedValue({
      text: 'this is not json',
      runId: 'run-x',
      model: 'mock-default',
    });
    await expect(
      promoteSvc.promoteVariationToCanon(w.id, { category: 'landscapes', label: 'A' }),
    ).rejects.toMatchObject({ status: 502, code: 'LLM_INVALID_JSON' });
  });

  it('cherry-picks the first shape-matching inner object when the LLM array-wraps the response', async () => {
    // jsonExtract.extractJson walks balanced blocks and prefers ones whose
    // value matches the shape predicate (which keys on `name`). So when the
    // LLM wraps a single entry in an array, the inner object wins on shape
    // and is returned directly. The service relies on this contract — there
    // is no longer a defensive array-unwrap branch.
    const w = await seedUniverseWithBucket({
      vehicles: {
        kind: 'objects',
        variations: [{ label: 'Salvage Mech', prompt: 'rusted mech' }],
      },
    });
    runPromptThroughProviderMock.mockResolvedValue({
      text: JSON.stringify([
        { name: 'Salvage Mech', description: 'A walker.', significance: 'A relic.' },
      ]),
      runId: 'run-x', model: 'mock-default',
    });
    const result = await promoteSvc.promoteVariationToCanon(w.id, {
      category: 'vehicles', label: 'Salvage Mech',
    });
    expect(result.entry.name).toBe('Salvage Mech');
    expect(result.entry.description).toBe('A walker.');
  });
});

describe('universeBuilderPromote — control field stripping', () => {
  it('drops hallucinated id / locked / imageRefs from the LLM response', async () => {
    const w = await seedUniverseWithBucket({
      landscapes: {
        kind: 'settings',
        variations: [{ label: 'Salt Flats', prompt: 'horizon salt flats' }],
      },
    });
    mockLlm({
      id: 'set-hallucinated',
      name: 'Salt Flats',
      description: 'A flat expanse.',
      locked: true, // LLM should NEVER set this
      imageRefs: ['phantom.png'],
      primaryImageRef: 'phantom.png',
      sourceSeriesId: 'srs-phantom',
    });
    const result = await promoteSvc.promoteVariationToCanon(w.id, {
      category: 'landscapes',
      label: 'Salt Flats',
    });
    // ID stripped → sanitizer mints a fresh one.
    expect(result.entry.id).not.toBe('set-hallucinated');
    // `locked` stripped → user has to explicitly lock from the canon UI.
    expect(result.entry.locked).toBeUndefined();
    // Image refs stripped → those are operational, owned by the render UI.
    expect(result.entry.imageRefs).toEqual([]);
    expect(result.entry.primaryImageRef).toBe(null);
  });
});

describe('universeBuilderPromote — atomicity', () => {
  it('writes the canon entry and variation removal in a single atomicWrite', async () => {
    const w = await seedUniverseWithBucket({
      landscapes: {
        kind: 'settings',
        variations: [
          { label: 'A', prompt: 'a' },
          { label: 'B', prompt: 'b' },
        ],
      },
    });
    mockLlm({ name: 'Place A', description: 'place a', prompt: 'a' });
    const callsBefore = fileUtils.atomicWrite.mock.calls.length;
    await promoteSvc.promoteVariationToCanon(w.id, {
      category: 'landscapes',
      label: 'A',
    });
    // Canon append AND variation removal must land in one persistence write
    // — not two. A two-write split would expose a half-state window where a
    // crash leaves the variation gone but the canon entry never written
    // (or vice versa). updateUniverse writes once, so the call delta is 1.
    expect(fileUtils.atomicWrite.mock.calls.length - callsBefore).toBe(1);
    // Re-read from the persistence layer (mirrors what a sibling tab would
    // see): canon has the new entry AND the bucket has lost the variation.
    const reread = (await svc.listUniverses())[0];
    expect(reread.settings.find((s) => s.name === 'Place A')).toBeTruthy();
    expect(reread.categories.landscapes.variations.map((v) => v.label)).toEqual(['B']);
  });
});

describe('universeBuilderPromote — prompt content', () => {
  const { buildPromotePrompt } = promoteSvc.__testing;

  it('embeds universe context (logline, embrace influences) into the prompt', () => {
    const prompt = buildPromotePrompt({
      targetKind: 'characters',
      variation: { label: 'Ash', prompt: 'soot-stained child' },
      category: 'heroes',
      universe: {
        logline: 'A foundry city goes silent.',
        styleNotes: 'Moebius palette.',
        influences: { embrace: ['cel-shading', 'dust palette'] },
      },
    });
    expect(prompt).toContain('A foundry city goes silent.');
    expect(prompt).toContain('Moebius palette.');
    expect(prompt).toContain('cel-shading, dust palette');
    expect(prompt).toContain('LABEL: Ash');
    expect(prompt).toContain('PROMPT: soot-stained child');
  });

  it('emits the per-kind output contract', () => {
    const charPrompt = promoteSvc.__testing.buildPromotePrompt({
      targetKind: 'characters',
      variation: { label: 'x', prompt: 'x' },
      category: 'h',
      universe: {},
    });
    expect(charPrompt).toContain('physicalDescription');
    expect(charPrompt).toContain('personality');

    const settingPrompt = promoteSvc.__testing.buildPromotePrompt({
      targetKind: 'settings',
      variation: { label: 'x', prompt: 'x' },
      category: 'h',
      universe: {},
    });
    expect(settingPrompt).toContain('slugline');
    expect(settingPrompt).toContain('palette');

    const objectPrompt = promoteSvc.__testing.buildPromotePrompt({
      targetKind: 'objects',
      variation: { label: 'x', prompt: 'x' },
      category: 'h',
      universe: {},
    });
    expect(objectPrompt).toContain('significance');
  });
});
