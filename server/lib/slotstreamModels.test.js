import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listSlotstreamCachedModels,
  pickSlotstreamCachedModel,
  planSlotstreamMemory,
  SLOTSTREAM_MEMORY_FLOOR_GB,
} from './slotstreamModels.js';

describe('planSlotstreamMemory', () => {
  it('auto-sizes below total RAM and reports peak plus warm decode', () => {
    const plan = planSlotstreamMemory({ totalBytes: 48 * 1024 ** 3 });
    expect(plan.auto).toBe(true);
    expect(plan.totalRamGb).toBe(48);
    expect(plan.targetGb).toBeGreaterThanOrEqual(SLOTSTREAM_MEMORY_FLOOR_GB);
    expect(plan.targetGb).toBeLessThan(48);
    expect(plan.expectedPeakGb).toBe(plan.targetGb);
    expect(plan.expectedWarmDecodeToks).toBeGreaterThanOrEqual(1);
  });

  it('honours an explicit memory-cap override instead of hiding it', () => {
    const plan = planSlotstreamMemory({ totalBytes: 48 * 1024 ** 3, overrideGb: 22 });
    expect(plan.auto).toBe(false);
    expect(plan.targetGb).toBe(22);
    expect(plan.expectedPeakGb).toBe(22);
  });

  it('does not drop below the technique floor even on a small host', () => {
    const plan = planSlotstreamMemory({ totalBytes: 8 * 1024 ** 3 });
    expect(plan.targetGb).toBeGreaterThanOrEqual(SLOTSTREAM_MEMORY_FLOOR_GB);
  });
});

describe('listSlotstreamCachedModels', () => {
  let dir = null;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('treats a missing cache directory as empty, not unreadable', async () => {
    const cache = await listSlotstreamCachedModels({ cacheDir: join(tmpdir(), 'portos-slotstream-missing-cache') });
    expect(cache).toEqual({ models: [], error: null });
  });

  it('lists checkpoint directories and ignores files', async () => {
    dir = join(tmpdir(), `portos-slotstream-cache-${Date.now()}`);
    await mkdir(join(dir, 'qwen-moe'), { recursive: true });
    await writeFile(join(dir, 'qwen-moe', 'model.safetensors'), 'weights');
    await writeFile(join(dir, 'notes.txt'), 'not a checkpoint');
    const cache = await listSlotstreamCachedModels({ cacheDir: dir });
    expect(cache.error).toBeNull();
    expect(cache.models).toEqual([expect.objectContaining({ id: 'qwen-moe' })]);
  });

  it('hides a directory a download has not finished filling', async () => {
    // Reporting one would clear the card's empty-cache warning and offer
    // `--model` a directory that exits before it binds a port.
    dir = join(tmpdir(), `portos-slotstream-cache-partial-${Date.now()}`);
    await mkdir(join(dir, 'in-progress'), { recursive: true });
    await writeFile(join(dir, 'in-progress', 'config.json'), '{}');
    await writeFile(join(dir, 'in-progress', 'model.safetensors.partial'), 'half');
    await mkdir(join(dir, 'abandoned'), { recursive: true });
    await writeFile(join(dir, 'abandoned', 'model.safetensors.partial'), 'half');
    await mkdir(join(dir, 'empty'), { recursive: true });
    await mkdir(join(dir, 'complete'), { recursive: true });
    await writeFile(join(dir, 'complete', 'model.safetensors'), 'weights');

    const cache = await listSlotstreamCachedModels({ cacheDir: dir });
    expect(cache.error).toBeNull();
    expect(cache.models.map((m) => m.id)).toEqual(['complete']);
  });
});

describe('pickSlotstreamCachedModel', () => {
  it('prefers an explicit request over the cache order', () => {
    expect(pickSlotstreamCachedModel([{ id: 'a' }, { id: 'b' }], 'b')).toBe('b');
  });

  it('returns null when the cache was unreadable or empty', () => {
    expect(pickSlotstreamCachedModel(null)).toBeNull();
    expect(pickSlotstreamCachedModel([])).toBeNull();
  });
});
