import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listWorldRuns: vi.fn(),
  renderWorld: vi.fn(),
  WORLD_CATEGORY_KEY_MAX: 64,
  WORLD_CATEGORIES: ['characters', 'places', 'objects'],
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../services/api', () => apiMocks);
vi.mock('../components/ui/Toast', () => ({ default: toastMock }));

import useUniverseRender from './useUniverseRender.js';

const draft = {
  characters: [{ id: 'c1', name: 'Hero', description: 'A brave hero' }],
  places: [],
  objects: [],
  categories: {
    heroes: {
      kind: 'characters',
      variations: [{ id: 'v1', label: 'Scout', prompt: 'A desert scout' }],
    },
  },
  compositeSheets: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  apiMocks.renderWorld.mockResolvedValue({
    promptCount: 2,
    collectionName: 'Example Collection',
    entryJobs: [{ jobId: 'job-1', entryRef: { id: 'v1', kind: 'variation' } }],
  });
  apiMocks.listWorldRuns.mockResolvedValue([{ id: 'run-2' }]);
});

const renderUniverseRender = (availableBackends = [{ id: 'local' }]) => {
  const setRuns = vi.fn();
  const hook = renderHook(() => useUniverseRender({
    selectedId: 'u1',
    draft,
    availableBackends,
    defaultMode: 'local',
    runs: [],
    setRuns,
  }));
  return { ...hook, setRuns };
};

describe('useUniverseRender', () => {
  it('adds the all-trunks canon selection for an unscoped all-mode render', async () => {
    const { result, setRuns } = renderUniverseRender();
    act(() => result.current.setRenderOpts((current) => ({ ...current, promptMode: 'all' })));
    await act(async () => { await result.current.handleRender(); });

    const payload = apiMocks.renderWorld.mock.calls[0][1];
    expect(payload.promptMode).toBe('all');
    expect(payload.canonSelection).toEqual({
      characters: 'all',
      places: 'all',
      objects: 'all',
    });
    expect(result.current.pendingHeadByEntryId).toEqual({ v1: 'job-1' });
    expect(setRuns).toHaveBeenCalledWith([{ id: 'run-2' }]);
  });

  it('blocks rendering when no image backend is configured', async () => {
    const { result } = renderUniverseRender([]);
    await act(async () => { await result.current.handleRender(); });

    expect(apiMocks.renderWorld).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('Configure an image-gen backend first');
  });
});
