import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  createUniverse: vi.fn(),
  expandUniverse: vi.fn(),
  getUniverse: vi.fn(),
  refineWorldPrompts: vi.fn(),
  updateUniverse: vi.fn(),
  WORLD_CATEGORY_KEY_MAX: 64,
  WORLD_CATEGORIES: ['characters', 'places', 'objects'],
  WORLD_LOCKABLE_FIELDS: [
    'starterPrompt', 'logline', 'premise', 'styleNotes',
    'influencesEmbrace', 'influencesAvoid',
  ],
  ensureInfluences: (value) => ({
    embrace: Array.isArray(value?.embrace) ? value.embrace : [],
    avoid: Array.isArray(value?.avoid) ? value.avoid : [],
  }),
  isInfluenceLockField: (field) => field === 'influencesEmbrace' || field === 'influencesAvoid',
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../services/apiUniverseBuilder.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...apiMocks,
}));
vi.mock('../ui/Toast', () => ({ default: toastMock }));

import useUniverseExpand from './useUniverseExpand.js';

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.expandUniverse.mockResolvedValue({
    logline: 'Expanded logline',
    categories: {},
    compositeSheets: [],
    characters: [{ name: 'New Character' }],
    places: [],
    objects: [],
  });
});

const buildProps = (draft) => ({
  selectedId: null,
  draft,
  setDraft: vi.fn(),
  setSaving: vi.fn(),
  setWorlds: vi.fn(),
  goToWorld: vi.fn(),
  activeProviderId: null,
  markDraftSaved: vi.fn(),
  setCanonDirty: vi.fn(),
  pendingCanonAdditionsRef: { current: { characters: [], places: [], objects: [] } },
  clearPendingCanonAdditions: vi.fn(),
  setRenderOpts: vi.fn(),
});

describe('useUniverseExpand', () => {
  it('forwards locked rows and records only newly merged canon additions', async () => {
    const props = buildProps({
      name: '',
      starterPrompt: 'A test world',
      logline: 'Original',
      premise: '',
      styleNotes: '',
      categories: {
        heroes: {
          kind: 'characters',
          variations: [
            { label: 'Locked Hero', prompt: 'Keep me', locked: true },
            { label: 'Replace Me', prompt: 'Unlocked' },
          ],
        },
      },
      compositeSheets: [],
      characters: [],
      places: [],
      objects: [],
      influences: { embrace: [], avoid: [] },
      locked: {},
      llm: { provider: 'codex', model: 'gpt-5' },
    });
    const { result } = renderHook(() => useUniverseExpand(props));
    await act(async () => { await result.current.handleExpand(); });

    expect(apiMocks.expandUniverse).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'codex',
      model: 'gpt-5',
      preservedVariations: {
        heroes: [{ label: 'Locked Hero', prompt: 'Keep me', locked: true }],
      },
    }), { silent: true });
    expect(props.setCanonDirty).toHaveBeenCalledWith(true);
    expect(props.pendingCanonAdditionsRef.current.characters).toEqual([{ name: 'New Character' }]);
    expect(props.setDraft).toHaveBeenCalled();
  });

  it('rejects an empty starter prompt before calling a provider', async () => {
    const props = buildProps({ starterPrompt: '', categories: {}, compositeSheets: [] });
    const { result } = renderHook(() => useUniverseExpand(props));
    await act(async () => { await result.current.handleExpand(); });

    expect(apiMocks.expandUniverse).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith('Add a starter prompt to expand');
  });

  const namedDraft = (extra = {}) => ({
    name: 'Factual World',
    starterPrompt: 'A test world',
    logline: '', premise: '', styleNotes: '',
    categories: {}, compositeSheets: [],
    characters: [], places: [], objects: [],
    influences: { embrace: [], avoid: [] },
    locked: {}, llm: {},
    factual: true,
    visualProfile: { palette: 'teal' },
    imageMode: 'local',
    imageModelId: 'model-a',
    ...extra,
  });

  it('create-path auto-save after expand ships factual, visualProfile and render pins', async () => {
    const props = buildProps(namedDraft());
    apiMocks.createUniverse.mockResolvedValue({ id: 'u1', updatedAt: 't1' });
    const { result } = renderHook(() => useUniverseExpand(props));
    await act(async () => { await result.current.handleExpand(); });

    expect(apiMocks.createUniverse).toHaveBeenCalledWith(expect.objectContaining({
      factual: true,
      visualProfile: { palette: 'teal' },
      imageMode: 'local',
      imageModelId: 'model-a',
    }), { silent: true });
    expect(props.markDraftSaved).toHaveBeenCalledWith(expect.objectContaining({
      id: 'u1', updatedAt: 't1', factual: true, visualProfile: { palette: 'teal' },
    }));
  });

  it('existing-universe auto-save after expand syncs the baseline with id and updatedAt', async () => {
    const props = { ...buildProps(namedDraft()), selectedId: 'u2' };
    apiMocks.getUniverse.mockResolvedValue({ characters: [], places: [], objects: [] });
    apiMocks.updateUniverse.mockResolvedValue({ id: 'u2', updatedAt: 't2' });
    const { result } = renderHook(() => useUniverseExpand(props));
    await act(async () => { await result.current.handleExpand(); });

    expect(apiMocks.updateUniverse).toHaveBeenCalledWith('u2', expect.objectContaining({
      factual: true, visualProfile: { palette: 'teal' },
    }), { silent: true });
    expect(props.markDraftSaved).toHaveBeenCalledWith(expect.objectContaining({
      id: 'u2', updatedAt: 't2', factual: true, visualProfile: { palette: 'teal' },
    }));
  });
});
