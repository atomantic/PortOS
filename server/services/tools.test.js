import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for tools.js
 *
 * Covers: parallel file loading, in-flight dedup (Promise singleton),
 * cache invalidation on mutations.
 */

const mockToolFiles = new Map();

vi.mock('fs/promises', () => ({
  readdir: vi.fn(async () => [...mockToolFiles.keys()]),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  PATHS: { tools: '/fake/tools' },
  readJSONFile: vi.fn(async (path) => {
    const filename = path.split('/').pop();
    return mockToolFiles.get(filename) ?? null;
  }),
}));

import { readdir } from 'fs/promises';
import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { getTools, getEnabledTools, registerTool, updateTool, deleteTool } from './tools.js';

beforeEach(async () => {
  vi.clearAllMocks();
  mockToolFiles.clear();
  // Reset the module-level cache by triggering invalidation via deleteTool.
  // We call it with a non-existent id (unlink is mocked to resolve) so the
  // only side-effect is the invalidateCache() call inside deleteTool.
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
    mockToolFiles.set('new-tool.json', { id: 'new-tool', name: 'New', category: 'test', enabled: true });
    await getTools();
    expect(readdir).toHaveBeenCalledTimes(1);
  });
});
