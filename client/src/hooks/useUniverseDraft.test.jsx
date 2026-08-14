import { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// These constant stand-ins mirror the REAL values exported from
// services/apiUniverseBuilder.js (WORLD_CATEGORIES, WORLD_LOCKABLE_FIELDS,
// WORLD_CATEGORY_KEY_MAX). Because the suite mocks the whole api module, a
// convenience list here that drifts from the shipped one would let a body the
// server's `.strict()` Zod schemas reject pass green — the exact failure mode
// this suite's wire-shape assertions exist to catch.
const apiMocks = vi.hoisted(() => ({
  addUniverseStyleReference: vi.fn(),
  createUniverse: vi.fn(),
  deleteUniverse: vi.fn(),
  getProviders: vi.fn(),
  getSettings: vi.fn(),
  getUniverse: vi.fn(),
  listImageModels: vi.fn(),
  listLorasFull: vi.fn(),
  listUniverses: vi.fn(),
  listWorldRuns: vi.fn(),
  removeUniverseStyleReference: vi.fn(),
  updateUniverse: vi.fn(),
  WORLD_CATEGORY_KEY_MAX: 64,
  WORLD_CATEGORIES: ['landscapes', 'environments', 'structures', 'vehicles'],
  WORLD_LOCKABLE_FIELDS: [
    'starterPrompt', 'logline', 'premise', 'styleNotes', 'influencesEmbrace', 'influencesAvoid',
  ],
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
  styleReferences: [],
  locked: {},
  llm: { provider: null, model: null },
  characters: [{ name: 'Stale Draft Character' }],
  places: [],
  objects: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// Stand-in for the server's authoritative styleReferences list, keyed by
// universe id. The delta endpoints append/filter THIS — not a client-held base
// array — which is the whole point of #3109: the client sends only the change,
// so two mutations compose no matter what order their responses arrive in.
let serverReferences;
const serverRefsFor = (id) => serverReferences.get(id) ?? [];

// The server's `updatedAt` clock. Every write bumps it, and the hook keys its
// "is this GET body older than a write I already saw?" watermark on it — so the
// mock has to advance it or the ordering under test isn't modelled at all.
let serverClock;
const tickServerClock = () => {
  serverClock += 1;
  return `2026-01-01T00:00:${String(serverClock).padStart(2, '0')}.000Z`;
};

beforeEach(() => {
  vi.clearAllMocks();
  serverReferences = new Map();
  serverClock = 0;
  apiMocks.listUniverses.mockResolvedValue([universe]);
  apiMocks.getProviders.mockResolvedValue({ providers: [], activeProvider: null });
  apiMocks.listImageModels.mockResolvedValue([]);
  apiMocks.listLorasFull.mockResolvedValue([]);
  apiMocks.getSettings.mockResolvedValue({ imageGen: {} });
  apiMocks.getUniverse.mockResolvedValue(universe);
  apiMocks.listWorldRuns.mockResolvedValue([{ id: 'run-1' }]);
  apiMocks.updateUniverse.mockImplementation(async (id, payload) => ({
    ...universe, id, ...payload, updatedAt: tickServerClock(),
  }));
  apiMocks.createUniverse.mockImplementation(async (payload) => ({
    ...universe, ...payload, id: 'u-new', updatedAt: tickServerClock(),
  }));
  apiMocks.deleteUniverse.mockResolvedValue({ ok: true });
  apiMocks.addUniverseStyleReference.mockImplementation(async (id, { reference, adopt } = {}) => {
    const next = [...serverRefsFor(id), reference];
    serverReferences.set(id, next);
    return {
      ...universe, id, styleReferences: next, ...(adopt || {}), updatedAt: tickServerClock(),
    };
  });
  apiMocks.removeUniverseStyleReference.mockImplementation(async (id, referenceId) => {
    const next = serverRefsFor(id).filter((ref) => ref.id !== referenceId);
    serverReferences.set(id, next);
    return { ...universe, id, styleReferences: next, updatedAt: tickServerClock() };
  });
});

const renderDraft = (options) => {
  const goToWorld = vi.fn();
  const hook = renderHook(() => useUniverseDraft({ selectedId: 'u1', goToWorld }), options);
  return { ...hook, goToWorld };
};

// An unsaved universe: no `selectedId`, so the draft starts from
// createEmptyUniverseDraft() and every mutator takes its "nothing to PATCH
// yet, defer to the next Save" branch.
const renderUnsaved = () => {
  const goToWorld = vi.fn();
  const hook = renderHook(() => useUniverseDraft({ selectedId: null, goToWorld }));
  return { ...hook, goToWorld };
};

// The seeded bucket map every draft starts from — the four WORLD_CATEGORIES
// with no `kind` yet. Spelled out (rather than derived from
// ensureDraftCategories) so a create payload assertion pins the literal wire
// shape instead of restating the implementation.
const seededCategories = () => ({
  landscapes: { variations: [] },
  environments: { variations: [] },
  structures: { variations: [] },
  vehicles: { variations: [] },
});

// A second universe to navigate to, for the tests that exercise a selection
// switch. Overridden per-test where the switch target needs its own references.
const universeTwo = { ...universe, id: 'u2', name: 'Second Universe', styleReferences: [] };

// Same as renderDraft, but with `selectedId` driven by rerender props so a test
// can switch universes mid-flight.
const renderSelectable = () => {
  const goToWorld = vi.fn();
  const hook = renderHook(
    ({ selectedId }) => useUniverseDraft({ selectedId, goToWorld }),
    { initialProps: { selectedId: 'u1' } },
  );
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

  // A failed fetch and an empty response must not land in the same state. The refresh()
  // fan-out used to `.catch(() => [])` / `.catch(() => ({}))` every call, so a transient
  // failure was indistinguishable from a real empty answer — and for settings it was
  // actively destructive, since deriving from a `{}` stand-in reset the user's saved
  // image-gen mode and pipeline image config to defaults.
  describe('refresh() failure handling', () => {
    // NOTE: refresh() runs from a mount-only effect, so a rerender() does NOT re-run it.
    // These tests invoke result.current.refresh() directly — otherwise the second load
    // never happens and the assertions pass vacuously against untouched initial state.
    it('keeps the last-known image-gen mode and config when the settings fetch fails', async () => {
      apiMocks.getSettings.mockResolvedValue({ imageGen: { mode: 'local' }, localImageGen: {} });
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.loading).toBe(false));

      const modeBefore = result.current.defaultMode;
      const cfgBefore = result.current.imageCfg;
      const backendsBefore = result.current.availableBackends;
      expect(modeBefore).toBeTruthy();

      // Second load fails. Nothing derived from settings may change.
      apiMocks.getSettings.mockRejectedValueOnce(new Error('network blip'));
      await act(async () => { await result.current.refresh(); });

      expect(result.current.defaultMode).toBe(modeBefore);
      expect(result.current.imageCfg).toEqual(cfgBefore);
      expect(result.current.availableBackends).toEqual(backendsBefore);
    });

    it('keeps the previously loaded providers and image models when their fetches fail', async () => {
      apiMocks.getProviders.mockResolvedValue({
        providers: [{ id: 'p1', name: 'Provider One' }], activeProvider: 'p1',
      });
      apiMocks.listImageModels.mockResolvedValue([{ id: 'm1' }]);
      apiMocks.listLorasFull.mockResolvedValue([{ id: 'l1' }]);
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.providers).toHaveLength(1));

      apiMocks.getProviders.mockRejectedValueOnce(new Error('down'));
      apiMocks.listImageModels.mockRejectedValueOnce(new Error('down'));
      apiMocks.listLorasFull.mockRejectedValueOnce(new Error('down'));
      await act(async () => { await result.current.refresh(); });

      // Not wiped to [] — a failed read is not evidence that nothing is configured.
      expect(result.current.providers).toEqual([{ id: 'p1', name: 'Provider One' }]);
      expect(result.current.activeProviderId).toBe('p1');
      expect(result.current.imageModels).toEqual([{ id: 'm1' }]);
      expect(result.current.availableLoras).toEqual([{ id: 'l1' }]);
    });

    it('still applies a genuinely empty response (empty is not treated as failure)', async () => {
      apiMocks.getProviders.mockResolvedValue({
        providers: [{ id: 'p1', name: 'Provider One' }], activeProvider: 'p1',
      });
      apiMocks.listImageModels.mockResolvedValue([{ id: 'm1' }]);
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.providers).toHaveLength(1));

      apiMocks.getProviders.mockResolvedValueOnce({ providers: [], activeProvider: null });
      apiMocks.listImageModels.mockResolvedValueOnce([]);
      await act(async () => { await result.current.refresh(); });

      expect(result.current.providers).toEqual([]);
      expect(result.current.activeProviderId).toBe(null);
      expect(result.current.imageModels).toEqual([]);
    });
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

  // The render flow keys its per-row pending-job map on the id the SERVER
  // stamped onto `entryJobs`. A board or variation created in this session has
  // no id until a save mints one, so without adopting it the row can never match
  // its own job — no spinner, no thumbnail until reload, and a pending entry
  // with no consumer to clear it.
  describe('adopting server-minted entry ids on save', () => {
    it('backfills ids onto sheets and variations the save created', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      act(() => {
        result.current.updateCompositeSheets([{ kind: 'reference_sheet', label: 'New board', prompt: 'p', locked: true }]);
        result.current.updateCategory('heroes', [{ label: 'New hero', prompt: 'p' }]);
      });
      // The server sanitizer mints ids for both id-less entries.
      apiMocks.updateUniverse.mockImplementationOnce(async (id, payload) => ({
        ...universe,
        id,
        compositeSheets: payload.compositeSheets.map((s) => ({ ...s, id: 'sheet-minted' })),
        categories: {
          heroes: { ...payload.categories.heroes, variations: [{ ...payload.categories.heroes.variations[0], id: 'var-minted' }] },
        },
        updatedAt: tickServerClock(),
      }));
      await act(async () => { await result.current.handleSave(); });

      expect(result.current.draft.compositeSheets[0].id).toBe('sheet-minted');
      expect(result.current.draft.categories.heroes.variations[0].id).toBe('var-minted');
      // Adopting the ids is not a user edit — the page must not read as dirty.
      expect(result.current.isDraftDirty()).toBe(false);
    });

    // The sanitizer echoes back any id the payload carried, so a row whose id the
    // server confirms must keep it — re-keying it would strand an in-flight job.
    it('keeps an id the saved record confirms', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      act(() => {
        result.current.updateCompositeSheets([{ id: 'mine', kind: 'reference_sheet', label: 'Board', prompt: 'p', locked: true }]);
      });
      await act(async () => { await result.current.handleSave(); });

      expect(result.current.draft.compositeSheets[0].id).toBe('mine');
      expect(result.current.isDraftDirty()).toBe(false);
    });

    // The legacy shape: entries written before ids were persisted get a fresh
    // uuid minted on every read, so this draft's copy is transient. POST /render
    // persists a real set before queueing jobs against it — syncEntryIdsFromServer
    // is what re-points the rows at those ids.
    it('replaces transient ids with the persisted ones after a render migration', async () => {
      apiMocks.getUniverse.mockResolvedValue({
        ...universe,
        compositeSheets: [{ id: 'transient-1', kind: 'reference_sheet', label: 'Legacy board', prompt: 'p', locked: true }],
      });
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.compositeSheets[0]?.id).toBe('transient-1'));
      expect(result.current.isDraftDirty()).toBe(false);

      apiMocks.getUniverse.mockResolvedValueOnce({
        ...universe,
        compositeSheets: [{ id: 'persisted-1', kind: 'reference_sheet', label: 'Legacy board', prompt: 'p', locked: true }],
      });
      await act(async () => { await result.current.syncEntryIdsFromServer(); });

      expect(result.current.draft.compositeSheets[0].id).toBe('persisted-1');
      // Re-pointing an id is not a user edit.
      expect(result.current.isDraftDirty()).toBe(false);
    });
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

  // ---- Art style references (#3109) ----
  //
  // These now assert the DELTA contract: each mutation sends only the change
  // and the server applies it to the freshest persisted list inside the
  // universe record's write queue. That removes the client-side base array
  // whose staleness the previous six review-driven fixes were guarding —
  // sequential-remove ordering, add/remove interleaving, cross-universe
  // corruption, and the A→B→A round trip are all structurally impossible when
  // the client never holds the array. What remains worth pinning is the
  // request SHAPE, the display-side reconciliation (which universe's draft a
  // response is allowed to touch), and the one race the server can't see: a
  // hydration GET that raced a mutation and may carry a pre-write body.

  it('adds a reference and adopted guidance in one request, without clearing unrelated dirty edits', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));
    act(() => result.current.updateDraft({ premise: 'Unsaved concurrent premise' }));

    const reference = {
      id: 'style-ref-1',
      title: 'Ink wash',
      prompt: 'Granular ink wash',
      imageRefs: ['reference.png'],
    };
    await act(async () => {
      await result.current.persistStyleReference({
        reference,
        proposed: {
          styleNotes: 'Tactile and muted',
          influences: { embrace: ['ink wash'], avoid: ['gloss'] },
        },
        adopt: true,
      });
    });

    // The request carries the ADDITION plus the guidance the same write
    // adopts — never a whole-array replace.
    expect(apiMocks.addUniverseStyleReference).toHaveBeenCalledWith('u1', {
      reference,
      adopt: {
        styleNotes: 'Tactile and muted',
        influences: { embrace: ['ink wash'], avoid: ['gloss'] },
      },
    }, { silent: true });
    expect(result.current.draft).toMatchObject({
      premise: 'Unsaved concurrent premise',
      styleNotes: 'Tactile and muted',
      styleReferences: [reference],
    });
    expect(result.current.isDraftDirty()).toBe(true);
  });

  it('adds a reference without adopting guidance when the user declines the style guide', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));

    const reference = { id: 'style-ref-1', title: 'Ink wash', prompt: 'wash', imageRefs: ['a.png'] };
    await act(async () => {
      await result.current.persistStyleReference({
        reference,
        proposed: { styleNotes: 'Ignored', influences: { embrace: ['ignored'], avoid: [] } },
        adopt: false,
      });
    });

    // No `adopt` key at all — a reference-only add must not carry style
    // guidance the user explicitly declined.
    expect(apiMocks.addUniverseStyleReference).toHaveBeenCalledWith(
      'u1',
      { reference, adopt: undefined },
      { silent: true },
    );
    expect(result.current.draft.styleNotes).toBe('');
  });

  it('removes one reference by id rather than patching the surviving list', async () => {
    const reference = { id: 'style-ref-1', title: 'Ink wash', prompt: 'wash', imageRefs: ['a.png'] };
    serverReferences.set('u1', [reference]);
    apiMocks.getUniverse.mockResolvedValueOnce({ ...universe, styleReferences: [reference] });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([reference]));

    await act(async () => { await result.current.removeStyleReference(reference.id); });
    expect(apiMocks.removeUniverseStyleReference).toHaveBeenCalledWith('u1', reference.id, { silent: true });
    expect(result.current.draft.styleReferences).toEqual([]);
  });

  it('removes both references when two removals fire before either request resolves', async () => {
    const refA = { id: 'style-ref-a', title: 'Ref A', prompt: 'moody', imageRefs: ['a.png'] };
    const refB = { id: 'style-ref-b', title: 'Ref B', prompt: 'bright', imageRefs: ['b.png'] };
    serverReferences.set('u1', [refA, refB]);
    apiMocks.getUniverse.mockResolvedValueOnce({ ...universe, styleReferences: [refA, refB] });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([refA, refB]));

    // No client-side queue serializes these anymore — each request names only
    // the id it removes, so whichever order the server applies them in, both
    // removals survive. (Previously each had to carry the surviving array,
    // which is what made ordering load-bearing.)
    await act(async () => {
      await Promise.all([
        result.current.removeStyleReference(refA.id),
        result.current.removeStyleReference(refB.id),
      ]);
    });

    expect(apiMocks.removeUniverseStyleReference.mock.calls.map((call) => call[1]))
      .toEqual([refA.id, refB.id]);
    expect(serverRefsFor('u1')).toEqual([]);
    expect(result.current.draft.styleReferences).toEqual([]);
  });

  it('does not let an in-flight mutation for one universe touch a different, now-selected universe', async () => {
    const refB2 = { id: 'style-ref-b2', title: 'Ref B2', prompt: 'b2', imageRefs: ['b2.png'] };
    const universeTwoWithRef = { ...universeTwo, styleReferences: [refB2] };
    apiMocks.getUniverse.mockImplementation(async (id) => (id === 'u2' ? universeTwoWithRef : universe));

    const { result, rerender } = renderSelectable();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));

    // Start an add for u1 and hold its response open — simulates the user
    // switching universes before it resolves.
    let resolveU1Add;
    apiMocks.addUniverseStyleReference.mockImplementationOnce(
      () => new Promise((resolve) => { resolveU1Add = resolve; }),
    );
    const referenceForU1 = { id: 'style-ref-stale', title: 'Stale', prompt: 'stale', imageRefs: ['stale.png'] };
    const staleSave = result.current.persistStyleReference({ reference: referenceForU1, adopt: false });

    await act(async () => { rerender({ selectedId: 'u2' }); });
    await waitFor(() => expect(result.current.draft.id).toBe('u2'));
    expect(result.current.draft.styleReferences).toEqual([refB2]);

    await act(async () => {
      resolveU1Add({ ...universe, styleReferences: [referenceForU1] });
      await staleSave;
    });

    // u2's displayed draft is untouched by u1's now-resolved response.
    expect(result.current.draft.id).toBe('u2');
    expect(result.current.draft.styleReferences).toEqual([refB2]);

    // And a removal on u2 targets u2's own reference — no cross-universe leak.
    await act(async () => { await result.current.removeStyleReference(refB2.id); });
    expect(apiMocks.removeUniverseStyleReference).toHaveBeenLastCalledWith('u2', refB2.id, { silent: true });
  });

  it('re-reads instead of applying a hydration GET that raced a mutation (would blank the new reference)', async () => {
    const refA = { id: 'style-ref-a', title: 'Ref A', prompt: 'a', imageRefs: ['a.png'] };
    const refX = { id: 'style-ref-x', title: 'Ref X', prompt: 'x', imageRefs: ['x.png'] };
    serverReferences.set('u1', [refA]);
    // The re-hydration fetch on the return to u1 is held open so it can resolve
    // AFTER the mutation, carrying the PRE-mutation body the server would have
    // returned had it read before the add landed. The client can't tell that
    // from the response alone — hence the re-read.
    let serverStyleNotes = '';
    let serverUpdatedAt = universe.updatedAt;
    let u1Fetches = 0;
    let resolveU1Hydration;
    apiMocks.getUniverse.mockImplementation(async (id) => {
      if (id === 'u2') return universeTwo;
      u1Fetches += 1;
      if (u1Fetches === 2) return new Promise((resolve) => { resolveU1Hydration = resolve; });
      return {
        ...universe,
        styleReferences: serverRefsFor('u1'),
        styleNotes: serverStyleNotes,
        updatedAt: serverUpdatedAt,
      };
    });

    const { result, rerender } = renderSelectable();
    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([refA]));

    let resolveU1Add;
    apiMocks.addUniverseStyleReference.mockImplementationOnce(
      () => new Promise((resolve) => { resolveU1Add = resolve; }),
    );
    const pendingAdd = result.current.persistStyleReference({
      reference: refX,
      proposed: { styleNotes: 'Adopted notes', influences: { embrace: ['ink'], avoid: [] } },
      adopt: true,
    });

    // u1 -> u2 -> u1; the return issues re-hydration GET G, held pending.
    await act(async () => { rerender({ selectedId: 'u2' }); });
    await waitFor(() => expect(result.current.draft.id).toBe('u2'));
    await act(async () => { rerender({ selectedId: 'u1' }); });
    await waitFor(() => expect(resolveU1Hydration).toBeTypeOf('function'));

    // The add resolves first — the reordering this guard exists for. It advances
    // the server clock, which is what makes G's older body detectable.
    const addUpdatedAt = tickServerClock();
    await act(async () => {
      serverReferences.set('u1', [refA, refX]);
      serverStyleNotes = 'Adopted notes';
      serverUpdatedAt = addUpdatedAt;
      resolveU1Add({
        ...universe,
        styleReferences: [refA, refX],
        styleNotes: 'Adopted notes',
        influences: { embrace: ['ink'], avoid: [] },
        updatedAt: addUpdatedAt,
      });
      await pendingAdd;
    });

    // ...then G resolves carrying the stale, pre-mutation body. The hook
    // re-reads (fetch 3, which sees the committed write) rather than applying
    // it, so both the reference AND the guidance the same write adopted stand.
    await act(async () => {
      resolveU1Hydration({
        ...universe, styleReferences: [refA], styleNotes: '', updatedAt: universe.updatedAt,
      });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([refA, refX]));
    expect(result.current.draft.styleNotes).toBe('Adopted notes');
    // markDraftSaved banked the re-read values, so the adopted guidance is not
    // silently re-saved as the stale '' on the next general Save.
    expect(result.current.isDraftDirty()).toBe(false);
  });

  it('does not re-read when the hydration GET already contains the mutation', async () => {
    // The other half of the gate: it compares the BODY's clock against the newest
    // write seen, not merely "did a write happen" — so the common overlap, where
    // the GET was served after the write committed, costs no extra round-trip.
    const refX = { id: 'style-ref-x', title: 'Ref X', prompt: 'x', imageRefs: ['x.png'] };
    let serverUpdatedAt = universe.updatedAt;
    apiMocks.getUniverse.mockImplementation(async (id) => (id === 'u2'
      ? universeTwo
      : { ...universe, styleReferences: serverRefsFor('u1'), updatedAt: serverUpdatedAt }));

    const { result, rerender } = renderSelectable();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));
    apiMocks.addUniverseStyleReference.mockImplementationOnce(async (id, { reference }) => {
      serverReferences.set(id, [...serverRefsFor(id), reference]);
      serverUpdatedAt = tickServerClock();
      return { ...universe, id, styleReferences: serverRefsFor(id), updatedAt: serverUpdatedAt };
    });
    await act(async () => {
      await result.current.persistStyleReference({ reference: refX, adopt: false });
    });

    const fetchesBefore = apiMocks.getUniverse.mock.calls.length;
    await act(async () => { rerender({ selectedId: 'u2' }); });
    await waitFor(() => expect(result.current.draft.id).toBe('u2'));
    await act(async () => { rerender({ selectedId: 'u1' }); });
    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([refX]));

    // One GET for u2, one for u1 — no third (re-read) call.
    expect(apiMocks.getUniverse.mock.calls.length).toBe(fetchesBefore + 2);
  });

  it('re-reads after a general Save that a hydration GET raced, not just a reference mutation', async () => {
    // The stale-GET guard keys on the server's clock rather than on anything
    // style-reference-specific, so every writer that stamps its response is
    // covered — including handleSave. Without that, a save → navigate away →
    // back round trip could show the pre-save record.
    let serverPremise = 'Original premise';
    let serverUpdatedAt = universe.updatedAt;
    let u1Fetches = 0;
    let resolveU1Hydration;
    apiMocks.getUniverse.mockImplementation(async (id) => {
      if (id === 'u2') return universeTwo;
      u1Fetches += 1;
      if (u1Fetches === 2) return new Promise((resolve) => { resolveU1Hydration = resolve; });
      return { ...universe, premise: serverPremise, updatedAt: serverUpdatedAt };
    });

    const { result, rerender } = renderSelectable();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));
    act(() => result.current.updateDraft({ premise: 'Saved premise' }));

    // handleSave sets `saving` synchronously before its first await, so the call
    // itself has to be inside act() (unlike the reference mutators).
    let resolveSave;
    let pendingSave;
    apiMocks.updateUniverse.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
    await act(async () => { pendingSave = result.current.handleSave(); });

    await act(async () => { rerender({ selectedId: 'u2' }); });
    await waitFor(() => expect(result.current.draft.id).toBe('u2'));
    await act(async () => { rerender({ selectedId: 'u1' }); });
    await waitFor(() => expect(resolveU1Hydration).toBeTypeOf('function'));

    const savedAt = tickServerClock();
    await act(async () => {
      serverPremise = 'Saved premise';
      serverUpdatedAt = savedAt;
      resolveSave({ ...universe, premise: 'Saved premise', updatedAt: savedAt });
      await pendingSave;
    });
    await act(async () => {
      resolveU1Hydration({ ...universe, premise: 'Original premise', updatedAt: universe.updatedAt });
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.draft.premise).toBe('Saved premise'));
  });

  it('lets an un-raced hydration carry a peer edit the client never wrote', async () => {
    // The mirror of the test above: with no mutation in flight, the GET is
    // authoritative — including for writers the client can't see (peer sync,
    // the image-delete purge). The old design cached a base array here and
    // needed an epoch to avoid shadowing them; now there is nothing to shadow.
    const refPeer = { id: 'style-ref-peer', title: 'Peer', prompt: 'peer', imageRefs: ['peer.png'] };
    let u1Fetches = 0;
    apiMocks.getUniverse.mockImplementation(async (id) => {
      if (id === 'u2') return universeTwo;
      u1Fetches += 1;
      return u1Fetches === 1
        ? { ...universe, styleReferences: [], styleNotes: '' }
        : { ...universe, styleReferences: [refPeer], styleNotes: 'Peer notes' };
    });

    const { result, rerender } = renderSelectable();
    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([]));

    await act(async () => { rerender({ selectedId: 'u2' }); });
    await waitFor(() => expect(result.current.draft.id).toBe('u2'));
    await act(async () => { rerender({ selectedId: 'u1' }); });

    await waitFor(() => expect(result.current.draft.styleReferences).toEqual([refPeer]));
    expect(result.current.draft.styleNotes).toBe('Peer notes');
  });

  it('surfaces a failed add without touching the draft', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));
    apiMocks.addUniverseStyleReference.mockRejectedValueOnce(new Error('at capacity'));

    let ok;
    await act(async () => {
      ok = await result.current.persistStyleReference({
        reference: { id: 'style-ref-1', title: 'T', prompt: 'p', imageRefs: ['a.png'] },
        adopt: false,
      });
    });
    expect(ok).toBe(false);
    expect(toastMock.error).toHaveBeenCalledWith('Reference save failed: at capacity');
    expect(result.current.draft.styleReferences).toEqual([]);
  });

  // ---- Destructive: delete (#3290) ----

  describe('handleDelete', () => {
    it('drops the universe from the list, clears the draft, and navigates away', async () => {
      const { result, goToWorld } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      act(() => result.current.setPendingDeleteId('u1'));

      await act(async () => { await result.current.handleDelete(); });

      expect(apiMocks.deleteUniverse).toHaveBeenCalledWith('u1', { silent: true });
      expect(result.current.universes).toEqual([]);
      expect(result.current.draft.id).toBeUndefined();
      expect(result.current.draft.name).toBe('');
      expect(result.current.pendingDeleteId).toBe(null);
      expect(goToWorld).toHaveBeenCalledWith(null);
      expect(toastMock.success).toHaveBeenCalledWith('World deleted');
    });

    // The failure path is the one that matters: a delete that 500s must leave
    // the user exactly where they were, still looking at the record. Navigating
    // away (or filtering the list) on a failed delete would make a live
    // universe look gone until the next reload.
    it('keeps the universe and stays put when the delete fails', async () => {
      const { result, goToWorld } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      apiMocks.deleteUniverse.mockRejectedValueOnce(new Error('record is locked'));

      await act(async () => { await result.current.handleDelete(); });

      expect(toastMock.error).toHaveBeenCalledWith('Delete failed: record is locked');
      expect(result.current.universes).toEqual([universe]);
      expect(result.current.draft.id).toBe('u1');
      expect(goToWorld).not.toHaveBeenCalled();
      expect(toastMock.success).not.toHaveBeenCalledWith('World deleted');
    });

    it('is a no-op on an unsaved universe', async () => {
      const { result, goToWorld } = renderUnsaved();
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => { await result.current.handleDelete(); });

      expect(apiMocks.deleteUniverse).not.toHaveBeenCalled();
      expect(goToWorld).not.toHaveBeenCalled();
    });
  });

  // ---- Fire-and-forget PATCHes: exact wire bodies (#3290) ----
  //
  // Each of these sends a targeted PATCH whose body the mocked api module can
  // never validate. The server's patchSchema is built from `.strict()` pieces
  // (lockedSchema, influencesSchema) and refuses an empty patch outright, so a
  // body that drifts here 400s in production behind a green suite. These
  // assertions therefore pin the EXACT object handed to updateUniverse, not
  // just "some call happened".

  describe('toggleLock', () => {
    it('PATCHes only the lock map when a field is locked, and again when it is cleared', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => { result.current.toggleLock('logline'); });
      expect(apiMocks.updateUniverse).toHaveBeenLastCalledWith(
        'u1',
        { locked: { logline: true } },
        { silent: true },
      );
      expect(result.current.draft.locked).toEqual({ logline: true });

      // Unlocking DELETES the key rather than writing `false` — the stored map
      // is sparse, and lockedSchema is strict about nothing else riding along.
      await act(async () => { result.current.toggleLock('logline'); });
      expect(apiMocks.updateUniverse).toHaveBeenLastCalledWith(
        'u1',
        { locked: {} },
        { silent: true },
      );
      expect(result.current.draft.locked).toEqual({});
    });

    // Two clicks inside one tick: the lock map has to compose across them.
    // `draftRef` is normally refreshed by a passive effect that runs a commit
    // later, so a naive read of it would let the second toggle re-send the
    // first's write and leave the field locked forever.
    it('composes back-to-back toggles that land before a re-render', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => {
        result.current.toggleLock('logline');
        result.current.toggleLock('logline');
      });

      expect(apiMocks.updateUniverse.mock.calls.map((call) => call[1]))
        .toEqual([{ locked: { logline: true } }, { locked: {} }]);
      expect(result.current.draft.locked).toEqual({});
    });

    // The server replaces `locked` wholesale per PATCH, so if those two writes
    // reached it reversed the record would persist the lock the user just
    // cleared. Holding the first request open proves the second is not even
    // issued until it settles.
    it('holds the second lock write until the first has settled', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      let releaseFirst;
      apiMocks.updateUniverse.mockImplementationOnce(
        () => new Promise((resolve) => { releaseFirst = resolve; }),
      );

      await act(async () => {
        result.current.toggleLock('logline');
        result.current.toggleLock('logline');
      });
      expect(apiMocks.updateUniverse).toHaveBeenCalledTimes(1);

      await act(async () => { releaseFirst({ ...universe, locked: { logline: true } }); });

      expect(apiMocks.updateUniverse).toHaveBeenCalledTimes(2);
      expect(apiMocks.updateUniverse).toHaveBeenLastCalledWith(
        'u1',
        { locked: {} },
        { silent: true },
      );
    });

    // The tail is per universe, not per hook. A request has no timeout, so one
    // stalled write for the universe the user just left must not block every
    // lock on the one they navigated to — silently, since the draft still
    // updates optimistically either way.
    it('does not let a stalled lock write for one universe block another', async () => {
      apiMocks.getUniverse.mockImplementation(async (id) => (id === 'u2' ? universeTwo : universe));
      const { result, rerender } = renderSelectable();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      // u1's lock write never settles.
      apiMocks.updateUniverse.mockImplementationOnce(() => new Promise(() => {}));
      await act(async () => { result.current.toggleLock('logline'); });
      expect(apiMocks.updateUniverse).toHaveBeenCalledTimes(1);

      await act(async () => { rerender({ selectedId: 'u2' }); });
      await waitFor(() => expect(result.current.draft.id).toBe('u2'));
      await act(async () => { result.current.toggleLock('premise'); });

      expect(apiMocks.updateUniverse).toHaveBeenCalledTimes(2);
      expect(apiMocks.updateUniverse).toHaveBeenLastCalledWith(
        'u2',
        { locked: { premise: true } },
        { silent: true },
      );
    });

    it('accepts the per-influence-list lock keys, not just the bible scalars', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => { result.current.toggleLock('influencesEmbrace'); });

      // `influencesEmbrace` / `influencesAvoid` are real LOCKABLE_FIELDS keys;
      // the legacy whole-block `influences` key is not what the UI writes.
      expect(apiMocks.updateUniverse).toHaveBeenLastCalledWith(
        'u1',
        { locked: { influencesEmbrace: true } },
        { silent: true },
      );
    });

    it('ignores a field that is not lockable', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => { result.current.toggleLock('categories'); });

      expect(apiMocks.updateUniverse).not.toHaveBeenCalled();
      expect(result.current.draft.locked).toEqual({});
    });

    it('updates the draft without PATCHing an unsaved universe', async () => {
      const { result } = renderUnsaved();
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => { result.current.toggleLock('premise'); });

      expect(result.current.draft.locked).toEqual({ premise: true });
      expect(apiMocks.updateUniverse).not.toHaveBeenCalled();
    });

    // Regression (#3290): the PATCH used to be issued from inside the setDraft
    // updater. React may invoke an updater more than once per setState — under
    // StrictMode it always does — so a single lock click sent two identical
    // PATCHes. State updaters must be pure; the request belongs beside
    // setRenderPin's, outside the updater.
    it('sends exactly one PATCH per toggle under StrictMode', async () => {
      const { result } = renderDraft({ wrapper: StrictMode });
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => { result.current.toggleLock('logline'); });

      expect(apiMocks.updateUniverse).toHaveBeenCalledTimes(1);
      expect(result.current.draft.locked).toEqual({ logline: true });
    });

    it('surfaces a failed lock save', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      apiMocks.updateUniverse.mockRejectedValueOnce(new Error('write queue busy'));

      await act(async () => { result.current.toggleLock('premise'); });

      expect(toastMock.error).toHaveBeenCalledWith('Lock save failed: write queue busy');
    });
  });

  describe('setRenderPin', () => {
    it('PATCHes both pin fields together and mirrors them onto the draft', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => {
        result.current.setRenderPin({ imageMode: 'local', imageModelId: null });
      });

      expect(apiMocks.updateUniverse).toHaveBeenLastCalledWith(
        'u1',
        { imageMode: 'local', imageModelId: null },
        { silent: true },
      );
      expect(result.current.draft).toMatchObject({ imageMode: 'local', imageModelId: null });
    });

    // Clearing the pin must send explicit nulls, never omit the keys: an
    // all-undefined body JSON.stringifies to `{}`, which the server's
    // "patch must include at least one field" refinement rejects — and
    // key-absent means "preserve" there, so the pin would never clear.
    it('clears the pin with explicit nulls rather than an empty patch', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => {
        result.current.setRenderPin({ imageMode: null, imageModelId: null });
      });

      const body = apiMocks.updateUniverse.mock.calls.at(-1)[1];
      expect(body).toEqual({ imageMode: null, imageModelId: null });
      expect(Object.keys(JSON.parse(JSON.stringify(body)))).toEqual(['imageMode', 'imageModelId']);
    });

    it('updates the draft without PATCHing an unsaved universe', async () => {
      const { result } = renderUnsaved();
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        result.current.setRenderPin({ imageMode: 'agy', imageModelId: 'imagen-3' });
      });

      expect(result.current.draft).toMatchObject({ imageMode: 'agy', imageModelId: 'imagen-3' });
      expect(apiMocks.updateUniverse).not.toHaveBeenCalled();
    });

    it('surfaces a failed pin save', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      apiMocks.updateUniverse.mockRejectedValueOnce(new Error('unknown model'));

      await act(async () => {
        result.current.setRenderPin({ imageMode: 'agy', imageModelId: 'nope' });
      });

      expect(toastMock.error).toHaveBeenCalledWith('Render pin save failed: unknown model');
    });
  });

  describe('assignBucketKind', () => {
    it('PATCHes only the moved bucket, keyed by bucket name', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => { await result.current.assignBucketKind('heroes', 'places'); });

      // A single-key `categories` map: the server merges per bucket key, so
      // sending the whole map would be both wasteful and a clobber risk.
      expect(apiMocks.updateUniverse).toHaveBeenLastCalledWith(
        'u1',
        { categories: { heroes: { kind: 'places', variations: [] } } },
        { silent: true },
      );
      expect(result.current.draft.categories.heroes.kind).toBe('places');
      expect(result.current.universes[0].categories.heroes.kind).toBe('places');
      expect(toastMock.success).toHaveBeenCalledWith('Moved "Heroes" to Places');
    });

    it('tags the bucket locally and defers to Save on an unsaved universe', async () => {
      const { result } = renderUnsaved();
      await waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => { await result.current.assignBucketKind('landscapes', 'places'); });

      expect(apiMocks.updateUniverse).not.toHaveBeenCalled();
      expect(result.current.draft.categories.landscapes).toEqual({ kind: 'places', variations: [] });
      expect(toastMock.success).toHaveBeenCalledWith('Tagged "Landscapes" as Places — save to persist');
    });

    it('ignores an unknown trunk kind or an unknown bucket', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => {
        await result.current.assignBucketKind('heroes', 'sidekicks');
        await result.current.assignBucketKind('no-such-bucket', 'places');
      });

      expect(apiMocks.updateUniverse).not.toHaveBeenCalled();
      expect(result.current.draft.categories.heroes.kind).toBe('characters');
    });

    it('surfaces a failed move and leaves the list untouched', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      apiMocks.updateUniverse.mockRejectedValueOnce(new Error('bucket cap reached'));

      await act(async () => { await result.current.assignBucketKind('heroes', 'objects'); });

      expect(toastMock.error).toHaveBeenCalledWith('Move failed: bucket cap reached');
      // The optimistic local move stands (same contract as toggleLock /
      // setRenderPin); only the shared list is left alone.
      expect(result.current.universes[0].categories.heroes.kind).toBe('characters');
    });
  });

  // ---- Local category + draft editors (#3290) ----

  describe('addCategory', () => {
    it('normalizes the typed name into a bucket key and clears the input', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      act(() => result.current.setNewCategoryName('Ancient Ruins & Relics'));
      act(() => result.current.addCategory());

      expect(result.current.draft.categories.ancient_ruins_and_relics).toEqual({ variations: [] });
      expect(result.current.newCategoryName).toBe('');
      expect(toastMock.error).not.toHaveBeenCalled();
    });

    it('rejects a name that normalizes onto an existing bucket', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      // 'Heroes' normalizes to the `heroes` key the universe already has.
      act(() => result.current.setNewCategoryName('Heroes'));
      act(() => result.current.addCategory());

      expect(toastMock.error).toHaveBeenCalledWith('Category already exists');
      // Untouched — including the input, so the user can correct it in place.
      expect(result.current.draft.categories.heroes).toEqual({ kind: 'characters', variations: [] });
      expect(result.current.newCategoryName).toBe('Heroes');
    });

    it('rejects a name with no usable characters', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      const before = result.current.draft.categories;

      act(() => result.current.setNewCategoryName('!!! ???'));
      act(() => result.current.addCategory());

      expect(toastMock.error).toHaveBeenCalledWith('Use letters or numbers for the category name');
      expect(result.current.draft.categories).toEqual(before);
    });
  });

  describe('removeCategory', () => {
    it('removes a custom bucket outright', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      act(() => result.current.removeCategory('heroes'));

      expect(result.current.draft.categories).not.toHaveProperty('heroes');
      expect(result.current.draft.categories).toEqual(seededCategories());
    });

    // A built-in bucket can't actually be removed — the server re-seeds all
    // four WORLD_CATEGORIES on every read, so removing one empties it instead.
    // Mirroring that here keeps the draft from showing a bucket-shaped hole the
    // next hydration would fill back in.
    it('empties rather than deletes a built-in bucket', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      const variation = { id: 'v1', label: 'Salt flats', prompt: 'a cracked white plain' };
      act(() => result.current.updateCategory('landscapes', [variation]));
      expect(result.current.draft.categories.landscapes.variations).toEqual([variation]);

      act(() => result.current.removeCategory('landscapes'));

      expect(result.current.draft.categories.landscapes).toEqual({ variations: [] });
    });
  });

  it('updateCategory replaces one bucket\'s variations while preserving its kind', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));
    const variation = { id: 'v1', label: 'Scout', prompt: 'a wiry outrider' };

    act(() => result.current.updateCategory('heroes', [variation]));

    expect(result.current.draft.categories.heroes).toEqual({
      kind: 'characters',
      variations: [variation],
    });
    expect(result.current.isDraftDirty()).toBe(true);
    // Local edit only — it rides along on the next general Save.
    expect(apiMocks.updateUniverse).not.toHaveBeenCalled();
  });

  it('updateCompositeSheets replaces the sheet list on the draft', async () => {
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.draft.id).toBe('u1'));
    const sheets = [{ id: 's1', kind: 'reference_sheet', label: 'Cast board', prompt: 'six figures' }];

    act(() => result.current.updateCompositeSheets(sheets));

    expect(result.current.draft.compositeSheets).toEqual(sheets);
    expect(result.current.isDraftDirty()).toBe(true);
    expect(apiMocks.updateUniverse).not.toHaveBeenCalled();
  });

  // ---- Save preflight + canon reconciliation (#3290) ----

  describe('flushDraftIfDirty', () => {
    it('reports success without saving when the draft is clean', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      let flushed;
      await act(async () => { flushed = await result.current.flushDraftIfDirty(); });

      expect(flushed).toBe(true);
      expect(apiMocks.updateUniverse).not.toHaveBeenCalled();
    });

    it('saves a dirty draft first so the server acts on what the user sees', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      act(() => result.current.updateDraft({ premise: 'Pre-flight premise' }));

      let flushed;
      await act(async () => { flushed = await result.current.flushDraftIfDirty(); });

      expect(flushed).toBe(true);
      expect(apiMocks.updateUniverse.mock.calls.at(-1)[1].premise).toBe('Pre-flight premise');
      expect(result.current.isDraftDirty()).toBe(false);
    });

    it('reports failure when the preflight save fails, so the caller aborts', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      act(() => result.current.updateDraft({ premise: 'Doomed premise' }));
      apiMocks.updateUniverse.mockRejectedValueOnce(new Error('disk full'));

      let flushed;
      await act(async () => { flushed = await result.current.flushDraftIfDirty(); });

      expect(flushed).toBe(false);
      expect(toastMock.error).toHaveBeenCalledWith('Save failed: disk full');
    });
  });

  describe('handleCanonChange', () => {
    it('adopts the canon editor\'s arrays wholesale when nothing is pending', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      act(() => result.current.handleCanonChange({
        characters: [{ name: 'Editor Character' }],
        places: [{ name: 'Editor Place' }],
        objects: [],
        updatedAt: '2026-02-02T00:00:00.000Z',
      }));

      expect(result.current.draft.characters).toEqual([{ name: 'Editor Character' }]);
      expect(result.current.draft.places).toEqual([{ name: 'Editor Place' }]);
      expect(result.current.draft.objects).toEqual([]);
      expect(result.current.draft.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    });

    it('preserves unsaved additions when canon is dirty', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      act(() => {
        result.current.setCanonDirty(true);
        result.current.pendingCanonAdditionsRef.current.characters = [{ name: 'Pending Character' }];
      });

      act(() => result.current.handleCanonChange({
        characters: [{ name: 'Editor Character' }],
        places: [],
        objects: [],
        updatedAt: '2026-02-02T00:00:00.000Z',
      }));

      // The editor's list wins on collision; the not-yet-saved addition is
      // appended rather than dropped on the floor.
      expect(result.current.draft.characters.map((entry) => entry.name))
        .toEqual(['Editor Character', 'Pending Character']);
    });

    it('ignores a null payload', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      act(() => result.current.handleCanonChange(null));

      expect(result.current.draft.characters).toEqual([{ name: 'Stale Draft Character' }]);
    });
  });

  // ---- Create-a-second-universe from the name field (#3290) ----

  describe('handleCreateNamed', () => {
    it('creates a blank universe alongside the selected one and navigates to it', async () => {
      const { result, goToWorld } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => { await result.current.handleCreateNamed('  Spin-off World  '); });

      // A named-create is deliberately EMPTY apart from the name — it must not
      // carry the currently open universe's bible over to the new record.
      expect(apiMocks.createUniverse).toHaveBeenCalledWith({
        name: 'Spin-off World',
        starterPrompt: '',
        logline: '',
        premise: '',
        styleNotes: '',
        moodBoardId: null,
        categories: seededCategories(),
        compositeSheets: [],
        influences: { embrace: [], avoid: [] },
        styleReferences: [],
        locked: {},
        llm: { provider: null, model: null },
      }, { silent: true });
      expect(apiMocks.updateUniverse).not.toHaveBeenCalled();
      expect(result.current.universes[0].id).toBe('u-new');
      expect(goToWorld).toHaveBeenCalledWith('u-new');
      expect(toastMock.success).toHaveBeenCalledWith('World created');
    });

    it('rejects an all-whitespace name before touching the server', async () => {
      const { result } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));

      await act(async () => { await result.current.handleCreateNamed('   '); });

      expect(toastMock.error).toHaveBeenCalledWith('Name is required');
      expect(apiMocks.createUniverse).not.toHaveBeenCalled();
    });

    it('falls through to the normal Save on an unsaved universe', async () => {
      const { result, goToWorld } = renderUnsaved();
      await waitFor(() => expect(result.current.loading).toBe(false));
      act(() => result.current.updateDraft({ name: 'Fresh World', premise: 'Typed premise' }));

      await act(async () => { await result.current.handleCreateNamed('Fresh World'); });

      // handleSave's payload, not the blank-draft one — the premise the user
      // already typed has to survive the create.
      const payload = apiMocks.createUniverse.mock.calls.at(-1)[0];
      expect(payload).toMatchObject({ name: 'Fresh World', premise: 'Typed premise' });
      expect(payload.characters).toEqual([]);
      expect(goToWorld).toHaveBeenCalledWith('u-new');
    });

    it('surfaces a failed create and stays on the current universe', async () => {
      const { result, goToWorld } = renderDraft();
      await waitFor(() => expect(result.current.draft.id).toBe('u1'));
      apiMocks.createUniverse.mockRejectedValueOnce(new Error('name taken'));

      await act(async () => { await result.current.handleCreateNamed('Spin-off World'); });

      expect(toastMock.error).toHaveBeenCalledWith('Create failed: name taken');
      expect(result.current.universes).toEqual([universe]);
      expect(result.current.saving).toBe(false);
      expect(goToWorld).not.toHaveBeenCalled();
    });
  });
});

// The universe's own backend pin (Render tab → "This universe's default") has to
// reach the per-entry render config, not just the batch form: the cast / places /
// objects rows POST `/api/image-gen/generate` with an EXPLICIT `mode` taken from
// `imageCfg`, and an explicit mode outranks the record pin on the server ladder.
// Before this, an agy-pinned universe rendered its cast on the install default.
describe('imageCfg — universe render pin', () => {
  const CLOUD_ON = { codex: { enabled: true }, agy: { enabled: true } };

  it('folds the universe pin over the install-wide settings default', async () => {
    apiMocks.getSettings.mockResolvedValue({ imageGen: CLOUD_ON });
    apiMocks.listUniverses.mockResolvedValue([{ ...universe, imageMode: 'agy' }]);
    apiMocks.getUniverse.mockResolvedValue({ ...universe, imageMode: 'agy' });
    const { result } = renderDraft();
    // readPipelineImageSettings prefers codex when it's enabled, so 'agy' can
    // only come from the record pin.
    await waitFor(() => expect(result.current.imageCfg.mode).toBe('agy'));
  });

  it('keeps the install-wide default for an unpinned universe', async () => {
    apiMocks.getSettings.mockResolvedValue({ imageGen: CLOUD_ON });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.imageCfg.mode).toBe('codex');
  });

  // The batch form's default mode and the per-entry cfg must agree — they are
  // the same ladder, and a page that renders its cast on agy while its batch
  // form says codex is the inconsistency this whole change is about.
  it('resolves the batch form default mode through the same ladder', async () => {
    apiMocks.getSettings.mockResolvedValue({ imageGen: { mode: 'codex', ...CLOUD_ON } });
    apiMocks.listUniverses.mockResolvedValue([{ ...universe, imageMode: 'agy' }]);
    apiMocks.getUniverse.mockResolvedValue({ ...universe, imageMode: 'agy' });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.effectiveDefaultMode).toBe('agy'));
    expect(result.current.imageCfg.mode).toBe('agy');
  });

  it('ignores a pin whose backend this install no longer has enabled', async () => {
    apiMocks.getSettings.mockResolvedValue({ imageGen: { codex: { enabled: true } } });
    apiMocks.listUniverses.mockResolvedValue([{ ...universe, imageMode: 'agy' }]);
    apiMocks.getUniverse.mockResolvedValue({ ...universe, imageMode: 'agy' });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.imageCfg.mode).toBe('codex');
  });

  // The rung between the record pin and the install default. Batch renders and
  // character sheets already resolved it server-side, so omitting it here made
  // two surfaces on one page disagree about the backend.
  it("falls through an unpinned universe to the Universe Bible renderDefaults pin", async () => {
    apiMocks.getSettings.mockResolvedValue({
      imageGen: CLOUD_ON,
      renderDefaults: { 'universe-bible': { imageMode: 'agy', imageModel: 'gemini-3.5-pro' } },
    });
    const { result } = renderDraft();
    await waitFor(() => expect(result.current.imageCfg.mode).toBe('agy'));
    expect(result.current.imageCfg.cloudModel).toBe('gemini-3.5-pro');
    // The batch form's default mode runs the same ladder.
    expect(result.current.effectiveDefaultMode).toBe('agy');
  });
});
