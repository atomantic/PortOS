import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { mockNoPeers, mockNoPeerSync, mockPathsDataRoot } from '../../server/lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-canon-migration-' });
afterAll(cleanup);
vi.mock('../../server/lib/fileUtils.js', async () => makeProxy(await vi.importActual('../../server/lib/fileUtils.js')));
vi.mock('../../server/services/instances.js', () => mockNoPeers());
vi.mock('../../server/services/sharing/peerSync.js', () => mockNoPeerSync());
const providerCall = vi.fn(() => { throw new Error('Migration must not call AI'); });
vi.mock('../../server/services/bibleExtractor.js', () => ({ extractBible: providerCall }));
vi.mock('../../server/services/stageRunner.js', () => ({ runStagedLLM: providerCall }));
vi.mock('../../server/services/pipeline/refineHelpers.js', () => ({ runPromptRefine: providerCall }));

const svc = await import('../../server/services/universeBuilder.js');
const { default: migration } = await import('./422-canon-description-backfill.js');

beforeEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  providerCall.mockClear();
});

const seed = async (name, canon) => {
  const universe = await svc.createUniverse({ name, starterPrompt: 'Synthetic fixture' });
  return svc.updateUniverse(universe.id, canon);
};

describe('migration 422 — persisted canon description repair', () => {
  it('repairs all live universes while preserving locks, authored text, and tombstones; reruns write nothing', async () => {
    const first = await seed('First fixture', {
      characters: [
        { name: 'Courier', physicalDescription: ' ', prompt: '  yellow coat  ', locked: false },
        { name: 'Authored', physicalDescription: 'blue coat', prompt: 'replace me', locked: false },
        { name: 'Legacy', description: 'legacy coat', prompt: 'replace me', locked: false },
      ],
      places: [{ name: 'Locked', description: '', prompt: 'stone room', locked: true }],
      objects: [{ name: 'Unknown', description: '', prompt: ' ', locked: false }],
    });
    const second = await seed('Second fixture', {
      places: [{ name: 'Hall', description: '', prompt: 'stone hall', locked: false }],
      objects: [{ name: 'Key', description: '', prompt: 'brass key', locked: false }],
    });
    const deleted = await seed('Deleted fixture', {
      objects: [{ name: 'Discarded', description: '', prompt: 'unused prompt', locked: false }],
    });
    await svc.deleteUniverse(deleted.id);
    const beforeDeleted = await svc.store().loadOneRaw(deleted.id);

    await expect(migration.up()).resolves.toEqual({ updated: 2, filled: 3 });
    const repaired = await svc.getUniverse(first.id);
    expect(repaired.characters.map((c) => c.physicalDescription)).toEqual(['yellow coat', 'blue coat', 'legacy coat']);
    expect(repaired.places[0].description).toBe('');
    expect(repaired.objects[0].description).toBe('');
    const other = await svc.getUniverse(second.id);
    expect(other.places[0].description).toBe('stone hall');
    expect(other.objects[0].description).toBe('brass key');
    expect(await svc.store().loadOneRaw(deleted.id)).toEqual(beforeDeleted);
    const persisted = await svc.store().listRaw();
    await expect(migration.up()).resolves.toEqual({ updated: 0, filled: 0 });
    expect(await svc.store().listRaw()).toEqual(persisted);
    expect(providerCall).not.toHaveBeenCalled();
  });

  it('skips an install with no universes without creating records', async () => {
    await expect(migration.up()).resolves.toEqual({ updated: 0, filled: 0 });
    expect(await svc.store().listRaw()).toEqual([]);
    expect(providerCall).not.toHaveBeenCalled();
  });
});
