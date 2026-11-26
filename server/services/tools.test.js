import { describe, it, expect, vi, beforeEach } from 'vitest';
import { basename } from 'path';

/**
 * Tests for tools.js
 *
 * Covers: parallel file loading, in-flight dedup (Promise singleton),
 * cache invalidation on mutations.
 */

const mockToolFiles = new Map();

vi.mock('fs/promises', () => ({
  readdir: vi.fn(async () => [...mockToolFiles.keys()]),
  unlink: vi.fn(async (path) => { mockToolFiles.delete(basename(path)); }),
}));

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, tool) => { mockToolFiles.set(basename(path), tool); }),
  PATHS: { tools: '/fake/tools' },
  readJSONFile: vi.fn(async (path) => mockToolFiles.get(basename(path)) ?? null),
}));

import { readdir } from 'fs/promises';
import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { getTool, getTools, getEnabledTools, registerTool, updateTool, deleteTool } from './tools.js';

beforeEach(async () => {
  vi.clearAllMocks();
  mockToolFiles.clear();
  // Reset the module-level cache by triggering invalidation via deleteTool.
  await deleteTool('__reset__');
});

describe('tools.js — getTools', () => {
  it('returns all tools from disk on cold cache', async () => {
    mockToolFiles.set('tool-a.json', { id: 'tool-a', name: 'A', enabled: true });
    mockToolFiles.set('tool-b.json', { id: 'tool-b', name: 'B', enabled: false });

    const tools = await getTools();
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.id).sort()).toEqual(['tool-a', 'tool-b']);
    expect(readdir).toHaveBeenCalledTimes(1);
  });

  it('uses the in-memory cache on second call (no extra disk reads)', async () => {
    mockToolFiles.set('tool-x.json', { id: 'tool-x', name: 'X', enabled: true });

    // First call populates cache
    await getTools();
    readdir.mockClear();
    readJSONFile.mockClear();

    // Second call should hit cache
    const tools = await getTools();
    expect(tools).toHaveLength(1);
    expect(readdir).not.toHaveBeenCalled();
    expect(readJSONFile).not.toHaveBeenCalled();
  });

  it('two concurrent cold-cache calls share one load (in-flight dedup)', async () => {
    // beforeEach already cleared the cache; just seed files and fire concurrently.
    mockToolFiles.set('tool-y.json', { id: 'tool-y', name: 'Y', enabled: true });
    readdir.mockClear();

    const [a, b] = await Promise.all([getTools(), getTools()]);
    // Both should return the same result
    expect(a).toEqual(b);
    // readdir should have been called exactly once — dedup worked
    expect(readdir).toHaveBeenCalledTimes(1);
  });

  it('keeps the post-update list when an invalidated disk load finishes late', async () => {
    const oldTool = { id: 'late', name: 'Before' };
    mockToolFiles.set('late.json', oldTool);
    const started = Promise.withResolvers();
    const staleRead = Promise.withResolvers();
    readJSONFile.mockImplementationOnce(() => {
      started.resolve();
      return staleRead.promise;
    });

    const oldList = getTools();
    await started.promise;
    await updateTool('late', { name: 'After' });
    expect(await getTools()).toEqual([expect.objectContaining({ name: 'After' })]);

    staleRead.resolve(oldTool);
    await oldList;
    expect(await getTools()).toEqual([expect.objectContaining({ name: 'After' })]);
  });

  it('filters by enabled flag in getEnabledTools', async () => {
    // beforeEach already cleared cache and mockToolFiles
    mockToolFiles.clear();
    mockToolFiles.set('on.json', { id: 'on', name: 'On', enabled: true });
    mockToolFiles.set('off.json', { id: 'off', name: 'Off', enabled: false });

    const enabled = await getEnabledTools();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].id).toBe('on');
  });
});

describe('tools.js — registerTool', () => {
  it('calls atomicWrite and invalidates cache', async () => {
    // beforeEach already cleared cache
    mockToolFiles.set('existing.json', { id: 'existing', name: 'Existing', enabled: true });
    // Seed cache
    await getTools();
    readdir.mockClear();

    await registerTool({ id: 'new-tool', name: 'New', category: 'test', enabled: true });
    expect(atomicWrite).toHaveBeenCalled();

    // Cache should be invalidated — next getTools() must re-read disk
    readdir.mockClear();
    await getTools();
    expect(readdir).toHaveBeenCalledTimes(1);
  });
});

describe('tools.js — overlapping mutations', () => {
  it('applies concurrent patches to the newly registered tool', async () => {
    await Promise.all([
      registerTool({ id: 'concurrent', name: 'Tool', category: 'test' }),
      updateTool('concurrent', { description: 'Updated' }),
      updateTool('concurrent', { enabled: false }),
    ]);
    expect(await getTool('concurrent')).toMatchObject({ name: 'Tool', description: 'Updated', enabled: false });
  });

  it('does not recreate a tool after an overlapping deletion', async () => {
    await registerTool({ id: 'deleted', name: 'Tool', category: 'test' });
    await Promise.all([
      updateTool('deleted', { description: 'Updated' }),
      deleteTool('deleted'),
    ]);
    expect(await getTool('deleted')).toBeNull();
  });
});
