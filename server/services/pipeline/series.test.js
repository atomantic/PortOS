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

const svc = await import('./series.js');

describe('pipeline series service', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it('listSeries returns [] for fresh state', async () => {
    expect(await svc.listSeries()).toEqual([]);
  });

  it('createSeries assigns ser- prefixed id and persists the bible fields', async () => {
    const s = await svc.createSeries({
      name: 'Salt Run',
      logline: 'A foundry city goes silent.',
      premise: 'Long-form premise about a salt-mining city...',
      universeId: 'world-123',
      styleNotes: 'moebius linework, washed sepia',
      targetFormat: 'comic+tv',
      issueCountTarget: 6,
      characters: [
        { name: 'Lina', description: 'A young foundry surveyor.' },
        { name: '', description: 'Skipped — no name' },
      ],
    });
    expect(s.id).toMatch(/^ser-/);
    expect(s.name).toBe('Salt Run');
    expect(s.logline).toBe('A foundry city goes silent.');
    expect(s.universeId).toBe('world-123');
    expect(s.targetFormat).toBe('comic+tv');
    expect(s.issueCountTarget).toBe(6);
    // Empty-name character dropped; Lina gets a chr- id.
    expect(s.characters).toHaveLength(1);
    expect(s.characters[0].name).toBe('Lina');
    expect(s.characters[0].id).toMatch(/^chr-/);
  });

  it('createSeries requires a non-empty name', async () => {
    await expect(svc.createSeries({})).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    await expect(svc.createSeries({ name: '   ' })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('updateSeries merges fields without clobbering omitted ones', async () => {
    const s = await svc.createSeries({ name: 'Salt Run', logline: 'L1', premise: 'P1', styleNotes: 'S1' });
    const updated = await svc.updateSeries(s.id, { logline: 'L2' });
    expect(updated.logline).toBe('L2');
    expect(updated.premise).toBe('P1');
    expect(updated.styleNotes).toBe('S1');
    // ISO strings have ms precision; >= rather than > avoids flake when create
    // and update land in the same ms tick.
    expect(updated.updatedAt >= s.updatedAt).toBe(true);
  });

  it('updateSeries throws ERR_NOT_FOUND for unknown id', async () => {
    await expect(svc.updateSeries('ser-nope', { name: 'x' })).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it('deleteSeries drops the record and is idempotent only on second call', async () => {
    const s = await svc.createSeries({ name: 'Salt Run' });
    await svc.deleteSeries(s.id);
    await expect(svc.deleteSeries(s.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
    expect(await svc.listSeries()).toEqual([]);
  });

  it('listSeries sorts newest updated first', async () => {
    const a = await svc.createSeries({ name: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const b = await svc.createSeries({ name: 'B' });
    const list = await svc.listSeries();
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('targetFormat falls back to comic+tv when invalid', async () => {
    const s = await svc.createSeries({ name: 'X', targetFormat: 'nonsense' });
    expect(s.targetFormat).toBe('comic+tv');
  });

  it('caps characters at CHARACTERS_PER_SERIES_MAX', async () => {
    const many = Array.from({ length: svc.CHARACTERS_PER_SERIES_MAX + 10 }, (_, i) => ({ name: `c${i}` }));
    const s = await svc.createSeries({ name: 'X', characters: many });
    expect(s.characters).toHaveLength(svc.CHARACTERS_PER_SERIES_MAX);
  });
});
