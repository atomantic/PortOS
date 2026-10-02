import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../lib/mockPathsDataRoot.js';

// Contract under test: the universeAesthetic generate persists the WHOLE
// expansion through the shared Universe Builder merge, and a re-run on a
// curated universe keeps locks, pinned variations/sheets, and existing canon.
const fileStore = new Map();
vi.mock('../lib/fileUtils.js', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
  tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
  readJSONFileStrict: vi.fn(async (path, fallback) => ({ ok: true, value: fileStore.has(path) ? fileStore.get(path) : fallback })),
  unreadableStoreError: (filePath) => Object.assign(new Error(`Unreadable JSON file: ${filePath}`), { status: 500, code: 'UNREADABLE_STORE' }),
}));
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());
vi.mock('./stageRunner.js', () => ({ runStagedLLM: vi.fn(), extractJson: (raw) => JSON.parse(raw) }));
vi.mock('./catalogDB.js', () => ({
  listIngredients: vi.fn().mockResolvedValue({ items: [] }),
  linkIngredientsToSeries: vi.fn().mockResolvedValue([]),
  resolveIngredientsByIds: vi.fn().mockResolvedValue([]),
}));
const expandMock = vi.hoisted(() => vi.fn());
vi.mock('./universeBuilderExpand.js', () => ({ expandWorldTemplate: expandMock }));

const sb = await import('./storyBuilder.js');
const universeSvc = await import('./universeBuilder.js');

const expansion = (over = {}) => ({
  logline: 'New logline',
  premise: 'New premise',
  styleNotes: 'New style',
  influences: { embrace: ['noir'], avoid: ['neon'] },
  categories: { landscapes: { variations: [{ label: 'Fresh Vista', prompt: 'a vista' }] } },
  compositeSheets: [{ label: 'Fresh Board', prompt: 'board' }],
  characters: [{ name: 'Ashley', role: 'lead' }],
  places: [{ name: 'Foundry City', slugline: 'INT. FOUNDRY CITY - DAY' }],
  objects: [{ name: 'Brass Key' }],
  providerId: 'p', model: 'm',
  ...over,
});

beforeEach(() => {
  fileStore.clear();
  expandMock.mockReset();
});

describe('storyBuilder universeAesthetic generate', () => {
  it('persists categories, composite sheets, and canon on a fresh universe', async () => {
    const s = await sb.createStorySession({ title: 'Salt Run', seedIdea: 'a foundry city' });
    expandMock.mockResolvedValue(expansion());
    await sb.generateStep(s.id, 'universeAesthetic');
    const u = await universeSvc.getUniverse(s.universeId);
    expect(u.logline).toBe('New logline');
    expect(u.categories.landscapes.variations.map((v) => v.label)).toContain('Fresh Vista');
    expect(u.compositeSheets.map((x) => x.label)).toEqual(['Fresh Board']);
    expect(u.characters.map((c) => c.name)).toEqual(['Ashley']);
    expect(u.places).toHaveLength(1);
    expect(u.objects.map((o) => o.name)).toEqual(['Brass Key']);
  });

  it('a re-run keeps locked fields, pinned items, and merges canon by name', async () => {
    const s = await sb.createStorySession({ title: 'Salt Run', seedIdea: 'a foundry city' });
    expandMock.mockResolvedValue(expansion());
    await sb.generateStep(s.id, 'universeAesthetic');
    const first = await universeSvc.getUniverse(s.universeId);
    await universeSvc.updateUniverse(s.universeId, {
      locked: { logline: true },
      logline: 'Pinned logline',
      categories: { landscapes: { variations: [
        { label: 'Pinned Vista', prompt: 'p', locked: true },
        // Saved items default to locked; explicitly unpin the first run's.
        ...first.categories.landscapes.variations.map((v) => ({ ...v, locked: false })),
      ] } },
      compositeSheets: [{ label: 'Pinned Board', prompt: 'b', locked: true }, ...first.compositeSheets.map((x) => ({ ...x, locked: false }))],
    });
    expandMock.mockResolvedValue(expansion({
      logline: 'Overwrite attempt',
      categories: { landscapes: { variations: [{ label: 'Second Vista', prompt: 'v' }] } },
      compositeSheets: [{ label: 'Second Board', prompt: 'b' }],
      characters: [{ name: ' ashley ' }, { name: 'Bobby' }],
    }));
    await sb.generateStep(s.id, 'universeAesthetic');
    // The pinned items rode along with the request so the LLM won't regenerate them.
    expect(expandMock.mock.calls[1][0].preservedVariations.landscapes.map((v) => v.label)).toEqual(['Pinned Vista']);
    expect(expandMock.mock.calls[1][0].preservedCompositeSheets.map((x) => x.label)).toEqual(['Pinned Board']);
    const u = await universeSvc.getUniverse(s.universeId);
    expect(u.logline).toBe('Pinned logline');
    const labels = u.categories.landscapes.variations.map((v) => v.label);
    expect(labels).toContain('Pinned Vista');
    expect(labels).toContain('Second Vista');
    expect(u.compositeSheets.map((x) => x.label)).toEqual(expect.arrayContaining(['Pinned Board', 'Second Board']));
    expect(u.characters.map((c) => c.name).sort()).toEqual(['Ashley', 'Bobby']);
  });
});
