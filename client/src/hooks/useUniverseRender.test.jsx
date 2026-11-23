import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listWorldRuns: vi.fn(),
  renderWorld: vi.fn(),
  WORLD_CATEGORY_KEY_MAX: 64,
  WORLD_CATEGORIES: ['characters', 'places', 'objects'],
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../services/apiUniverseBuilder.js', () => ({
  listWorldRuns: apiMocks.listWorldRuns,
  renderWorld: apiMocks.renderWorld,
  WORLD_CATEGORY_KEY_MAX: apiMocks.WORLD_CATEGORY_KEY_MAX,
  WORLD_CATEGORIES: apiMocks.WORLD_CATEGORIES,
}));
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

const renderUniverseRender = (availableBackends = [{ id: 'local' }], preflight = async () => true) => {
  const setRuns = vi.fn();
  const selectedIdRef = { current: 'u1' };
  const hook = renderHook(() => useUniverseRender({
    selectedId: 'u1',
    selectedIdRef,
    mountedRef: { current: true },
    draft,
    availableBackends,
    defaultMode: 'local',
    setRuns,
    preflight,
  }));
  return { ...hook, setRuns, selectedIdRef };
};

describe('useUniverseRender', () => {
  it('does not apply run history when the user switched universes during the render call', async () => {
    const { result, setRuns, selectedIdRef } = renderUniverseRender();
    apiMocks.renderWorld.mockImplementation(async () => {
      selectedIdRef.current = 'u2';
      return { promptCount: 1, collectionName: 'C', entryJobs: [] };
    });
    await act(async () => { await result.current.handleRender(); });
    expect(setRuns).not.toHaveBeenCalled();
  });

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

  // /render compiles from the PERSISTED universe, so an unsaved variation the
  // UI already counts would 400 with WORLD_BUILDER_EMPTY ("No prompts to
  // render") — the preflight persists it first.
  it('runs the preflight before POSTing the render', async () => {
    const preflight = vi.fn().mockResolvedValue(true);
    const { result } = renderUniverseRender([{ id: 'local' }], preflight);
    await act(async () => {
      await result.current.handleRender({ promptMode: 'variations', selection: { heroes: 'all' } });
    });

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(apiMocks.renderWorld).toHaveBeenCalledTimes(1);
    expect(preflight.mock.invocationCallOrder[0])
      .toBeLessThan(apiMocks.renderWorld.mock.invocationCallOrder[0]);
  });

  it.each([21, 1.5, 0, '', null])('blocks a saved count of %s before an inline render can preflight', async (count) => {
    localStorage.setItem('universeBuilder.renderOpts', JSON.stringify({ batchPerVariation: count }));
    const preflight = vi.fn().mockResolvedValue(true);
    const { result } = renderUniverseRender([{ id: 'local' }], preflight);
    await act(async () => {
      await result.current.runRender({ promptMode: 'variations', selection: { heroes: ['Scout'] } });
    });

    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('whole number from 1 to 20'));
    expect(preflight).not.toHaveBeenCalled();
    expect(apiMocks.renderWorld).not.toHaveBeenCalled();
  });

  it.each([1, 20])('requests exactly %i render(s) per prompt at the boundary', async (count) => {
    localStorage.setItem('universeBuilder.renderOpts', JSON.stringify({ batchPerVariation: count }));
    const { result } = renderUniverseRender();
    await act(async () => { await result.current.handleRender(); });

    expect(apiMocks.renderWorld).toHaveBeenCalledExactlyOnceWith(
      'u1',
      expect.objectContaining({ batchPerVariation: count }),
      { silent: true },
    );
  });

  it('aborts the render when the preflight fails', async () => {
    const preflight = vi.fn().mockResolvedValue(false);
    const { result } = renderUniverseRender([{ id: 'local' }], preflight);
    await act(async () => {
      await result.current.handleRender({ promptMode: 'variations', selection: { heroes: 'all' } });
    });

    expect(apiMocks.renderWorld).not.toHaveBeenCalled();
  });

  it('skips the preflight entirely when the guards reject the render', async () => {
    const preflight = vi.fn().mockResolvedValue(true);
    const { result } = renderUniverseRender([], preflight);
    await act(async () => { await result.current.handleRender(); });

    expect(preflight).not.toHaveBeenCalled();
  });
});
