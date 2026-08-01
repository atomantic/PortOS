import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const renderDraft = () => {
  const goToWorld = vi.fn();
  const hook = renderHook(() => useUniverseDraft({ selectedId: 'u1', goToWorld }));
  return { ...hook, goToWorld };
};

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
});
