import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'lora-datasets-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

const { loraDatasetStore, updateDataset } = await import('./loraDatasets.js');

const seed = (id, extra = {}) => loraDatasetStore.saveOne(id, {
  schemaVersion: 1, id, triggerWord: 'example_character',
  character: { universeId: 'uni-1', entryId: 'char-1', entryKind: 'characters', name: 'Example Character' },
  ...extra,
});

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_DATA_ROOT, { recursive: true });
});

describe('retained dataset records', () => {
  it('loads a record written before the training retirement, keeping its trained state', async () => {
    await seed('ds-1', {
      status: 'trained',
      images: [{ id: 'img-1', file: 'img-1.png', status: 'ready', caption: 'example_character, standing' }],
      training: { loraFilename: 'example.safetensors', lastRunId: 'run-1' },
    });
    const loaded = await loraDatasetStore.loadOne('ds-1');
    expect(loaded.status).toBe('trained');
    expect(loaded.images).toHaveLength(1);
    expect(loaded.training).toMatchObject({ loraFilename: 'example.safetensors', lastRunId: 'run-1' });
  });

  it('updateDataset merges a mutation, stamps updatedAt', async () => {
    await seed('ds-2', { status: 'training' });
    const next = await updateDataset('ds-2', (current) => ({ ...current, status: 'trained' }));
    expect(next.status).toBe('trained');
    expect(next.updatedAt).toEqual(expect.any(String));
    expect((await loraDatasetStore.loadOne('ds-2')).status).toBe('trained');
  });

  it('updateDataset aborts without writing when the mutator returns null', async () => {
    await seed('ds-3', { status: 'training' });
    const result = await updateDataset('ds-3', () => null);
    expect(result.status).toBe('training');
    expect(result.updatedAt).toBeNull();
  });

  it('updateDataset 404s for a missing dataset', async () => {
    await expect(updateDataset('missing', (c) => c)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
