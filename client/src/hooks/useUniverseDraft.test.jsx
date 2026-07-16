import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  createUniverse: vi.fn(),
  deleteUniverse: vi.fn(),
  getProviders: vi.fn(),
  getSettings: vi.fn(),
  getUniverse: vi.fn(),
  listImageModels: vi.fn(),
  listLorasFull: vi.fn(),
  listUniverses: vi.fn(),
  listWorldRuns: vi.fn(),
  updateUniverse: vi.fn(),
  WORLD_CATEGORY_KEY_MAX: 64,
  WORLD_CATEGORIES: ['characters', 'places', 'objects'],
  WORLD_LOCKABLE_FIELDS: ['starterPrompt', 'logline', 'premise', 'styleNotes'],
  ensureInfluences: (value) => ({
    embrace: Array.isArray(value?.embrace) ? value.embrace : [],
    avoid: Array.isArray(value?.avoid) ? value.avoid : [],
  }),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../services/api', () => apiMocks);
vi.mock('../components/ui/Toast', () => ({ default: toastMock }));

import useUniverseDraft from './useUniverseDraft.js';

const universe = {
  id: 'u1',
  name: 'Example Universe',
  starterPrompt: 'A test world',
  logline: 'Original logline',
  premise: 'Original premise',
  styleNotes: '',
  categories: { heroes: { kind: 'characters', variations: [] } },
  compositeSheets: [],
  influences: { embrace: ['ink'], avoid: [] },
  locked: {},
  llm: { provider: null, model: null },
  characters: [{ name: 'Stale Draft Character' }],
  places: [],
  objects: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.listUniverses.mockResolvedValue([universe]);
  apiMocks.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
  apiMocks.listImageModels.mockResolvedValue([]);
  apiMocks.listLorasFull.mockResolvedValue([]);
  apiMocks.getSettings.mockResolvedValue({ imageGen: {} });
  apiMocks.getUniverse.mockResolvedValue(universe);
  apiMocks.listWorldRuns.mockResolvedValue([{ id: 'run-1' }]);
  apiMocks.updateUniverse.mockImplementation(async (id, payload) => ({ ...universe, id, ...payload }));
});

const renderDraft = () => {
  const goToWorld = vi.fn();
  const hook = renderHook(() => useUniverseDraft({ selectedId: 'u1', goToWorld }));
  return { ...hook, goToWorld };
};

describe('useUniverseDraft', () => {
  it('hydrates the selected universe and its run history', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.loading).toBe(false));
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));

    expect(result.current.draft.name).toBe('Example Universe');
    expect(result.current.runs).toEqual([{ id: 'run-1' }]);
    expect(result.current.isDraftDirty()).toBe(false);
  });

  it('saves general draft edits without replacing canon when canon is clean', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));

    act(() => result.current.updateDraft({ premise: 'Changed premise' }));
    expect(result.current.isDraftDirty()).toBe(true);
    await act(async () => { await result.current.handleSave(); });

    const payload = apiMocks.updateUniverse.mock.calls.at(-1)[1];
    expect(payload.premise).toBe('Changed premise');
    expect(payload).not.toHaveProperty('characters');
    expect(result.current.isDraftDirty()).toBe(false);
  });

  it('merges only pending canon additions onto a fresh server snapshot', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));
    apiMocks.getUniverse.mockResolvedValueOnce({
      ...universe,
      characters: [{ name: 'Server Character' }],
    });

    act(() => {
      result.current.setCanonDirty(true);
      result.current.pendingCanonAdditionsRef.current.characters = [{ name: 'New Character' }];
    });
    await act(async () => { await result.current.handleSave(); });

    const payload = apiMocks.updateUniverse.mock.calls.at(-1)[1];
    expect(payload.characters.map((entry) => entry.name)).toEqual([
      'Server Character',
      'New Character',
    ]);
    expect(payload.characters).not.toContainEqual({ name: 'Stale Draft Character' });
  });
});
