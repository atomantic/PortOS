import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useMounted from './useMounted';
import toast from '../components/ui/Toast';
import {
  addUniverseStyleReference,
  adoptUniverseStyleGuide,
  createUniverse,
  deleteUniverse,
  getProviders,
  getSettings,
  getUniverse,
  listImageModels,
  listLorasFull,
  listUniverses,
  listWorldRuns,
  removeUniverseStyleReference,
  updateUniverse,
  WORLD_LOCKABLE_FIELDS,
  ensureInfluences,
} from '../services/api';
import {
  applyRecordRenderPin, deriveAvailableBackends, renderPinLadder, renderTargetPin,
  IMAGE_GEN_MODE, RENDER_TARGET,
} from '../lib/imageGenBackends';
import { PIPELINE_IMAGE_DEFAULTS, readPipelineImageSettings } from '../lib/pipelineImageDefaults';
import { sameJsonShape } from '../lib/sameJsonShape';
import { upsertByIdPrepend } from '../lib/upsertByIdPrepend';
import { mergeCanonByName } from '../lib/universeBuilderExpand';
import {
  TRUNK_BY_KIND,
  adoptServerCategoryIds,
  adoptServerEntryIds,
  ensureDraftCategories,
  humanizeCategory,
  normalizeCategoryKey,
} from '../lib/universeBuilderShared';

// Distinguishes "this request failed" from "this request returned nothing". A unique
// object is used rather than null/undefined so it can never collide with a legitimate
// empty payload from any of the endpoints refresh() fans out to.
const FETCH_FAILED = Symbol('fetch-failed');

export const createEmptyUniverseDraft = () => ({
  name: '',
  starterPrompt: '',
  logline: '',
  premise: '',
  styleNotes: '',
  moodBoardId: null,
  categories: ensureDraftCategories(),
  compositeSheets: [],
  influences: { embrace: [], avoid: [] },
  styleReferences: [],
  locked: {},
  llm: { provider: null, model: null },
});

// Stable serialization of the fields the general Save action owns. Canon and
// styleReferences are excluded because targeted editors persist those
// arrays independently.
export const universeDraftSnapshot = (draft = {}) => JSON.stringify({
  name: (draft.name || '').trim(),
  starterPrompt: draft.starterPrompt || '',
  logline: draft.logline || '',
  premise: draft.premise || '',
  styleNotes: draft.styleNotes || '',
  moodBoardId: draft.moodBoardId || null,
  categories: draft.categories || {},
  compositeSheets: draft.compositeSheets || [],
  influences: ensureInfluences(draft.influences),
  locked: draft.locked || {},
  llm: draft.llm || { provider: null, model: null },
});

const emptyPendingCanon = () => ({ characters: [], places: [], objects: [] });

/**
 * Owns the Universe Builder's editable draft and persistence contract.
 *
 * The hook deliberately centralizes the concurrency-sensitive pieces that
 * used to be interleaved with the route markup: the saved-draft baseline,
 * pending canon-addition ledger, selection hydration, keyed category writes,
 * and create/update/delete flows. LLM expansion/refinement and rendering stay
 * separate consumers of this contract.
 */
export default function useUniverseDraft({ selectedId, goToWorld }) {
  const [universes, setWorlds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [imageModels, setImageModels] = useState([]);
  const [availableLoras, setAvailableLoras] = useState([]);
  const [availableBackends, setAvailableBackends] = useState([]);
  const [defaultMode, setDefaultMode] = useState(null);
  const [settingsImageCfg, setSettingsImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);
  // The Universe Bible target's own `settings.renderDefaults` pin — the rung
  // between this universe's pin and the install default. Held as the normalized
  // pin rather than the whole settings blob so the memo below has a stable dep.
  const [targetPin, setTargetPin] = useState(null);
  const [draft, setDraft] = useState(createEmptyUniverseDraft);
  const [runs, setRuns] = useState([]);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [canonDirty, setCanonDirty] = useState(false);

  const mountedRef = useMounted();
  const draftRef = useRef(null);
  const savedDraftSnapshotRef = useRef(universeDraftSnapshot(createEmptyUniverseDraft()));
  const savedStyleSnapshotRef = useRef(ensureInfluences(createEmptyUniverseDraft().influences));
  const pendingCanonAdditionsRef = useRef(emptyPendingCanon());
  // Mirrors `selectedId` synchronously during render (not via a passive
  // effect, which runs one tick later and would leave a window where a resolving
  // request still sees the OLD selection as current). Mutators compare against
  // this — not the `selectedId` closure — to decide whether their result should
  // still touch the currently DISPLAYED draft, so a response for a universe the
  // user has navigated away from is dropped instead of poisoning a different
  // universe's draft. Dropping it loses nothing: the write is already persisted
  // and returning re-reads it.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  // The freshest `updatedAt` this hook has seen CONFIRMED for each universe —
  // stamped from every mutation response, whatever field it wrote. The hydration
  // GET compares its own body against it and re-reads when the body is older,
  // because a GET issued before a write's response landed can still carry the
  // pre-write record: applying it would visibly revert the change the user just
  // made (client-side only — the server has it).
  //
  // Keyed on the server's own clock rather than a per-feature counter so it
  // covers every writer that stamps through `noteUniverseUpdated`, not just
  // style references — a mutation added to this hook is protected by recording
  // its response, with no separate marker to remember. And because it decides
  // only "re-ask the server", never "use my cached value", it also covers
  // writers the client cannot see at all (peer sync, the image-delete purge) —
  // which is exactly what the per-universe value cache it replaced could not
  // do (#3109).
  const lastSeenUpdatedAtRef = useRef(new Map());
  const universeIsStale = useCallback((id, updatedAt) => {
    const seen = lastSeenUpdatedAtRef.current.get(id);
    if (!seen) return false;
    // A body with no `updatedAt` is unorderable — treat it as stale so the
    // re-read decides, rather than letting it silently win.
    if (!updatedAt) return true;
    return Date.parse(updatedAt) < Date.parse(seen);
  }, []);
  const noteUniverseUpdated = useCallback((id, updatedAt) => {
    if (!id || !updatedAt) return;
    const seen = lastSeenUpdatedAtRef.current.get(id);
    // Monotonic — a slow response that resolves after a newer one must not roll
    // the watermark backwards.
    if (seen && Date.parse(seen) >= Date.parse(updatedAt)) return;
    lastSeenUpdatedAtRef.current.set(id, updatedAt);
  }, []);

  useEffect(() => { draftRef.current = draft; }, [draft]);

  const clearPendingCanonAdditions = useCallback(() => {
    pendingCanonAdditionsRef.current = emptyPendingCanon();
  }, []);

  const markDraftSaved = useCallback((snapshotSource) => {
    savedDraftSnapshotRef.current = universeDraftSnapshot(snapshotSource);
    savedStyleSnapshotRef.current = ensureInfluences(snapshotSource?.influences);
  }, []);

  // Mark only the style-guide fields as saved after an atomic reference-adopt
  // PATCH. Replacing the entire baseline here would incorrectly clear dirty
  // state for unrelated edits made while the vision request was in flight.
  const markStyleGuidanceSaved = useCallback((snapshotSource) => {
    const saved = JSON.parse(savedDraftSnapshotRef.current);
    saved.styleNotes = snapshotSource?.styleNotes || '';
    saved.influences = ensureInfluences(snapshotSource?.influences);
    savedDraftSnapshotRef.current = JSON.stringify(saved);
    savedStyleSnapshotRef.current = ensureInfluences(snapshotSource?.influences);
  }, []);

  const isDraftDirty = useCallback(
    () => savedDraftSnapshotRef.current !== universeDraftSnapshot(draftRef.current || draft),
    [draft],
  );

  const refresh = async () => {
    setLoading(true);
    // FETCH_FAILED is a sentinel, not a value: it keeps "the request failed" distinct
    // from "the request succeeded and the answer is empty". Collapsing both to `[]`/`{}`
    // is what made a transient blip look identical to an unconfigured install — and, for
    // settings, silently rewrote the user's saved image-gen mode (see below).
    const [list, providerData, models, loras, settings] = await Promise.all([
      listUniverses().catch(() => FETCH_FAILED),
      getProviders().catch(() => FETCH_FAILED),
      listImageModels().catch(() => FETCH_FAILED),
      listLorasFull().catch(() => FETCH_FAILED),
      getSettings().catch(() => FETCH_FAILED),
    ]);
    if (list !== FETCH_FAILED) setWorlds(list);
    if (providerData !== FETCH_FAILED) {
      setProviders(providerData.providers || []);
      setActiveProviderId(providerData.activeProvider || null);
    }
    if (models !== FETCH_FAILED) setImageModels(models || []);
    if (loras !== FETCH_FAILED) setAvailableLoras(Array.isArray(loras) ? loras : []);
    // Deriving the backend list / default mode / image config from a `{}` stand-in on a
    // failed settings read reset the picker to IMAGE_GEN_MODE.LOCAL and the pipeline
    // image config to defaults — overwriting the user's real configuration because a
    // request happened to fail. Leave all three at their last-known-good values instead.
    if (settings !== FETCH_FAILED) {
      const backends = deriveAvailableBackends(settings, { excludeExternal: true });
      setAvailableBackends(backends);
      const saved = settings?.imageGen?.mode;
      setDefaultMode(backends.find((backend) => backend.id === saved)?.id || backends[0]?.id || IMAGE_GEN_MODE.LOCAL);
      setSettingsImageCfg(readPipelineImageSettings(settings));
      setTargetPin(renderTargetPin(settings, RENDER_TARGET.UNIVERSE_BIBLE));
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  useEffect(() => {
    setPendingDeleteId(null);
    setCanonDirty(false);
    clearPendingCanonAdditions();
    if (!selectedId) {
      const empty = createEmptyUniverseDraft();
      setDraft(empty);
      markDraftSaved(empty);
      setRuns([]);
      return undefined;
    }
    let cancelled = false;
    Promise.all([
      getUniverse(selectedId).catch(() => null),
      listWorldRuns(selectedId).catch(() => []),
    ]).then(async ([fetched, nextRuns]) => {
      if (cancelled) return;
      // This body predates a mutation we already have confirmed — re-read rather
      // than apply it. The second read is issued after that mutation's response,
      // so it necessarily reflects the committed write. Comparing the body's own
      // clock (not merely "did a write happen") means the common case where the
      // GET already contains the write costs no extra request. On a re-read
      // failure, keep the draft as the mutation left it rather than applying the
      // body we just judged stale.
      const universe = (fetched && universeIsStale(selectedId, fetched.updatedAt))
        ? await getUniverse(selectedId).catch(() => null)
        : fetched;
      if (cancelled) return;
      if (universe) {
        noteUniverseUpdated(selectedId, universe.updatedAt);
        const hydrated = {
          ...universe,
          categories: ensureDraftCategories(universe.categories),
          compositeSheets: universe.compositeSheets || [],
          logline: universe.logline || '',
          premise: universe.premise || '',
          styleNotes: universe.styleNotes || '',
          moodBoardId: universe.moodBoardId || null,
          influences: ensureInfluences(universe.influences),
          styleReferences: universe.styleReferences || [],
          locked: universe.locked || {},
          llm: universe.llm || { provider: null, model: null },
        };
        setDraft(hydrated);
        markDraftSaved(hydrated);
      }
      setRuns(nextRuns);
    });
    return () => { cancelled = true; };
  }, [selectedId, universeIsStale, noteUniverseUpdated]);

  const handleSave = async () => {
    if (!draft.name?.trim()) {
      toast.error('Name is required');
      return null;
    }
    setSaving(true);
    const basePayload = {
      name: draft.name.trim(),
      starterPrompt: draft.starterPrompt || '',
      logline: draft.logline || '',
      premise: draft.premise || '',
      styleNotes: draft.styleNotes || '',
      // Linked mood board (#4188) — null clears server-side; the field always
      // ships so Save carries the full intended state like other scalars.
      moodBoardId: draft.moodBoardId || null,
      categories: draft.categories,
      compositeSheets: draft.compositeSheets || [],
      influences: ensureInfluences(draft.influences),
      locked: draft.locked || {},
      llm: draft.llm || {},
      // Per-record render pin (#3231 Phase 3) — included only when set so a
      // pin chosen on a not-yet-saved universe survives the create (the
      // update path is a no-op re-send; setRenderPin already PATCHed it).
      ...(draft.imageMode ? { imageMode: draft.imageMode } : {}),
      ...(draft.imageModelId ? { imageModelId: draft.imageModelId } : {}),
    };
    const needsCanonInPayload = !selectedId || canonDirty;
    let payload = basePayload;
    if (needsCanonInPayload) {
      if (selectedId) {
        const fresh = await getUniverse(selectedId, { silent: true }).catch(() => null);
        if (!fresh) {
          setSaving(false);
          toast.error('Save failed: could not fetch latest canon — please try again');
          return null;
        }
        const additions = pendingCanonAdditionsRef.current;
        payload = {
          ...basePayload,
          characters: mergeCanonByName(fresh.characters || [], additions.characters, 'character'),
          places: mergeCanonByName(fresh.places || [], additions.places, 'place'),
          objects: mergeCanonByName(fresh.objects || [], additions.objects, 'object'),
        };
      } else {
        payload = {
          ...basePayload,
          characters: draft.characters || [],
          places: draft.places || [],
          objects: draft.objects || [],
        };
      }
    }
    const result = selectedId
      ? await updateUniverse(selectedId, payload, { silent: true }).catch((error) => { toast.error(`Save failed: ${error.message}`); return null; })
      : await createUniverse(payload, { silent: true }).catch((error) => { toast.error(`Save failed: ${error.message}`); return null; });
    setSaving(false);
    if (!result) return null;
    if (needsCanonInPayload) {
      setCanonDirty(false);
      clearPendingCanonAdditions();
    }
    // Adopt the ids the server sanitizer minted for entries this save created,
    // so per-entry client state keyed by id (the render queue's pending-job map)
    // can match a board or variation added and used in the same session. Both
    // the draft AND the saved baseline take the ids — backfilling only the draft
    // would read as an unsaved edit and leave the page permanently dirty.
    const savedSheets = adoptServerEntryIds(payload.compositeSheets, result.compositeSheets);
    const savedCategories = adoptServerCategoryIds(payload.categories, result.categories);
    markDraftSaved({ ...payload, compositeSheets: savedSheets, categories: savedCategories });
    if (savedSheets !== payload.compositeSheets || savedCategories !== payload.categories) {
      // Re-derive from the CURRENT draft rather than assigning `savedSheets`
      // wholesale — edits made while the save was in flight must survive, and
      // adopting an id is additive to whatever the row looks like now.
      setDraft((d) => ({
        ...d,
        compositeSheets: adoptServerEntryIds(d.compositeSheets, result.compositeSheets),
        categories: adoptServerCategoryIds(d.categories, result.categories),
      }));
    }
    // Watermark this save so a re-hydration GET it raced (navigate away and back
    // mid-save) re-reads instead of showing the pre-save record — the same guard
    // the style-reference mutators get, which is why it keys on the server's
    // clock rather than on anything style-reference-specific.
    noteUniverseUpdated(result.id, result.updatedAt);
    toast.success(selectedId ? 'World updated' : 'World created');
    setWorlds((previous) => upsertByIdPrepend(previous, result));
    if (result.id !== selectedId) goToWorld(result.id);
    return result;
  };

  // Reconcile the draft's entry ids with the persisted record. `POST /render`
  // migrates a universe whose entries predate persisted ids — before that write,
  // `ensureEntryId` mints a fresh uuid on every read, so this draft is holding
  // transient ids while the queued jobs are keyed by the ones the migration just
  // wrote. Without this the pending-job map and the rows it drives use different
  // keys, and no row picks up its own render.
  //
  // Only the ids move: `adoptServerEntryIds` keeps every local id the server also
  // has, so a row is never re-keyed out from under an in-flight job, and nothing
  // else from the fetched record is merged in (it would clobber edits made since).
  // The saved baseline takes the same ids, or adopting them reads as a user edit
  // and the page stays permanently dirty.
  const syncEntryIdsFromServer = useCallback(async () => {
    const id = selectedIdRef.current;
    if (!id) return;
    const fresh = await getUniverse(id, { silent: true }).catch(() => null);
    // Dropping a response for a universe the user has navigated away from —
    // same rule every other mutator here follows.
    if (!fresh || !mountedRef.current || selectedIdRef.current !== id) return;
    const current = draftRef.current || {};
    if (adoptServerEntryIds(current.compositeSheets, fresh.compositeSheets) === current.compositeSheets
      && adoptServerCategoryIds(current.categories, fresh.categories) === current.categories) return;
    const saved = JSON.parse(savedDraftSnapshotRef.current);
    saved.compositeSheets = adoptServerEntryIds(saved.compositeSheets, fresh.compositeSheets);
    saved.categories = adoptServerCategoryIds(saved.categories, fresh.categories);
    savedDraftSnapshotRef.current = JSON.stringify(saved);
    setDraft((d) => ({
      ...d,
      compositeSheets: adoptServerEntryIds(d.compositeSheets, fresh.compositeSheets),
      categories: adoptServerCategoryIds(d.categories, fresh.categories),
    }));
  }, [mountedRef]);

  // Preflight for any server action that reads the PERSISTED universe (the LLM
  // actions, batch render): persist a dirty draft first, so the server operates
  // on what the user is looking at rather than the last-saved snapshot. Lives
  // here — beside the `isDraftDirty` / `handleSave` pair it is derived from —
  // so every consumer shares one definition of the contract.
  // Returns true when the draft is clean or the save succeeded; false (with
  // handleSave's own error toast already raised) when the save failed.
  const flushDraftIfDirty = async () => {
    if (!isDraftDirty()) return true;
    return !!(await handleSave());
  };

  const handleCreateNamed = async (rawName) => {
    const name = (rawName || '').trim();
    if (!name) {
      toast.error('Name is required');
      return;
    }
    if (!selectedId) {
      await handleSave();
      return;
    }
    setSaving(true);
    const result = await createUniverse({ ...createEmptyUniverseDraft(), name }, { silent: true })
      .catch((error) => { toast.error(`Create failed: ${error.message}`); return null; });
    setSaving(false);
    if (!result) return;
    toast.success('World created');
    setWorlds((previous) => upsertByIdPrepend(previous, result));
    goToWorld(result.id);
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    const deleted = await deleteUniverse(selectedId, { silent: true })
      .then(() => true)
      .catch((error) => { toast.error(`Delete failed: ${error.message}`); return false; });
    if (!deleted) return;
    setWorlds((previous) => previous.filter((universe) => universe.id !== selectedId));
    goToWorld(null);
    setDraft(createEmptyUniverseDraft());
    setPendingDeleteId(null);
    toast.success('World deleted');
  };

  const updateDraft = useCallback((patch) => setDraft((current) => ({ ...current, ...patch })), []);

  // Fold one style-reference mutation's response (the full updated universe)
  // into the DISPLAYED draft — but only when the user is still on the universe
  // that was mutated; otherwise applying it would poison a different,
  // now-selected universe's draft. Nothing is lost by dropping it: the change
  // is already persisted, and the server owns the array now.
  //
  // `capturedStyle` is the style guide as it read when an ADOPT request was
  // issued; passing it is what marks the response as an adopt, so the guide
  // fields are folded in too (and banked as saved) — unless the user edited them
  // while the request was in flight. A plain add or remove passes nothing,
  // because it wrote no guidance to fold in.
  const applyStyleReferenceResult = useCallback((targetId, updated, capturedStyle = null) => {
    noteUniverseUpdated(targetId, updated.updatedAt);
    if (selectedIdRef.current === targetId) {
      if (capturedStyle) markStyleGuidanceSaved(updated);
      setDraft((latest) => {
        const styleUnchangedDuringSave = capturedStyle
          && latest.styleNotes === capturedStyle.styleNotes
          && sameJsonShape(ensureInfluences(latest.influences), capturedStyle.influences);
        return {
          ...latest,
          styleReferences: updated.styleReferences || [],
          updatedAt: updated.updatedAt,
          ...(styleUnchangedDuringSave ? {
            styleNotes: updated.styleNotes || '',
            influences: ensureInfluences(updated.influences),
          } : {}),
        };
      });
    }
    setWorlds((previous) => upsertByIdPrepend(previous, updated));
  }, [noteUniverseUpdated, markStyleGuidanceSaved]);

  // Add one art reference. Sends ONLY the addition — see `addStyleReference` in
  // server/services/universeBuilder/crud.js for why (#3109). The cap is enforced
  // there too, against persisted state rather than a client cache.
  const persistStyleReference = useCallback(async ({ reference, proposed, adopt }) => {
    if (!selectedId || !reference) return false;
    const targetId = selectedId;
    const current = draftRef.current || draft;
    const capturedStyle = {
      styleNotes: current.styleNotes || '',
      influences: ensureInfluences(current.influences),
    };
    const updated = await addUniverseStyleReference(targetId, {
      reference,
      adopt: adopt ? {
        styleNotes: proposed?.styleNotes || '',
        influences: ensureInfluences(proposed?.influences),
      } : undefined,
    }, { silent: true }).catch((error) => {
      toast.error(`Reference save failed: ${error.message}`);
      return null;
    });
    if (!updated) return false;
    applyStyleReferenceResult(targetId, updated, adopt ? capturedStyle : null);
    toast.success(adopt ? 'Art reference added and style guide updated' : 'Art reference added');
    return true;
  }, [applyStyleReferenceResult, draft, selectedId]);

  // Adopt a board-synthesized style guide (#4188 Phase 4) — the reference-less
  // sibling of the persistStyleReference adopt path. Routes through the same
  // applyStyleReferenceResult bookkeeping so the saved snapshot + update
  // watermark advance and styleProbeDirty clears, exactly as an art-reference
  // adopt does; the server re-checks field locks in its queued write.
  const adoptStyleGuideFromBoard = useCallback(async (proposed) => {
    if (!selectedId) return false;
    const targetId = selectedId;
    const current = draftRef.current || draft;
    const capturedStyle = {
      styleNotes: current.styleNotes || '',
      influences: ensureInfluences(current.influences),
    };
    const updated = await adoptUniverseStyleGuide(targetId, {
      styleNotes: proposed?.styleNotes || '',
      influences: ensureInfluences(proposed?.influences),
    }, { silent: true }).catch((error) => {
      toast.error(`Adopting the style guide failed: ${error.message}`);
      return null;
    });
    if (!updated) return false;
    applyStyleReferenceResult(targetId, updated, capturedStyle);
    toast.success('Style guide adopted from mood board');
    return true;
  }, [applyStyleReferenceResult, draft, selectedId]);

  // Remove one art reference by id. Also a delta, so back-to-back removals need
  // no client-side queue — the server's record write queue serializes them.
  const removeStyleReference = useCallback(async (referenceId) => {
    if (!selectedId) return false;
    const targetId = selectedId;
    const updated = await removeUniverseStyleReference(targetId, referenceId, { silent: true })
      .catch((error) => {
        toast.error(`Reference removal failed: ${error.message}`);
        return null;
      });
    if (!updated) return false;
    applyStyleReferenceResult(targetId, updated);
    toast.success('Art reference removed');
    return true;
  }, [applyStyleReferenceResult, selectedId]);

  const handleCanonChange = useCallback((updated) => {
    if (!updated) return;
    setDraft((current) => {
      if (canonDirty) {
        const additions = pendingCanonAdditionsRef.current;
        return {
          ...current,
          characters: mergeCanonByName(updated.characters || [], additions.characters, 'character'),
          places: mergeCanonByName(updated.places || [], additions.places, 'place'),
          objects: mergeCanonByName(updated.objects || [], additions.objects, 'object'),
          updatedAt: updated.updatedAt,
        };
      }
      return {
        ...current,
        characters: updated.characters,
        places: updated.places,
        objects: updated.objects,
        updatedAt: updated.updatedAt,
      };
    });
  }, [canonDirty]);

  // Serializes lock PATCHes, PER UNIVERSE. The server replaces the stored
  // `locked` map wholesale on every arrival, so ORDER is load-bearing: two
  // toggles fired back-to-back that land reversed persist the older map,
  // leaving a field locked on disk while the UI shows it unlocked. Chaining
  // them means the second is not even sent until the first settles. The
  // style-reference mutators need no such tail — they send deltas the server
  // applies in any order (#3109) — which is exactly the difference that makes
  // one necessary here.
  //
  // Keyed by id rather than held as one tail for the hook, because a request
  // has no timeout: a stalled write for the universe the user just left would
  // otherwise block every lock on the one they navigated to, indefinitely and
  // silently (the draft still updates optimistically, so nothing surfaces it).
  const lockWriteTailsRef = useRef(new Map());

  const toggleLock = useCallback((field) => {
    if (!WORLD_LOCKABLE_FIELDS.includes(field)) return;
    // The next lock map is derived from the freshest draft OUTSIDE the state
    // updater, and the PATCH fires from here rather than from inside it. A
    // state updater must be pure: React is free to invoke it more than once
    // for a single setState (StrictMode double-invocation, an interrupted
    // concurrent render), and a request issued from within one is sent once
    // per invocation — one lock click produced two identical PATCHes. Mirrors
    // setRenderPin / assignBucketKind, which already patch outside the updater.
    const current = draftRef.current || draft;
    const nextLocked = { ...(current.locked || {}) };
    if (nextLocked[field]) delete nextLocked[field];
    else nextLocked[field] = true;
    // Advance the mirror synchronously. The effect that syncs `draftRef` runs a
    // commit later, so two toggles inside one tick would otherwise both read the
    // pre-toggle map — the second re-sending the first's write instead of
    // composing on top of it. The functional updater still owns the draft
    // itself, so a concurrent edit to another field is not clobbered.
    draftRef.current = { ...current, locked: nextLocked };
    setDraft((value) => ({ ...value, locked: nextLocked }));
    if (selectedId && current.name?.trim()) {
      const tail = lockWriteTailsRef.current.get(selectedId) || Promise.resolve();
      lockWriteTailsRef.current.set(selectedId, tail
        .then(() => updateUniverse(selectedId, { locked: nextLocked }, { silent: true }))
        .catch((error) => toast.error(`Lock save failed: ${error.message}`)));
    }
  }, [draft, selectedId]);

  // Per-record render pin (#3231 Phase 3) — this universe's default image
  // backend + cloud model. Mirrors toggleLock: reactive local update plus an
  // immediate targeted PATCH (the pin is not part of the autosaved draft
  // payload, so a stale draft flush can't resurrect a cleared pin).
  const setRenderPin = useCallback(({ imageMode, imageModelId }) => {
    setDraft((current) => ({ ...current, imageMode, imageModelId }));
    if (selectedId) {
      updateUniverse(selectedId, { imageMode, imageModelId }, { silent: true })
        .catch((error) => toast.error(`Render pin save failed: ${error.message}`));
    }
  }, [selectedId]);

  const updateCategory = useCallback((category, variations) => setDraft((current) => ({
    ...current,
    categories: {
      ...current.categories,
      [category]: { ...(current.categories?.[category] || {}), variations },
    },
  })), []);

  const assignBucketKind = async (bucket, targetKind) => {
    if (!TRUNK_BY_KIND[targetKind]) return;
    const latestDraft = draftRef.current || draft;
    const current = latestDraft.categories?.[bucket];
    if (!current) return;
    const nextBucket = { ...current, kind: targetKind };
    setDraft((value) => ({
      ...value,
      categories: {
        ...value.categories,
        [bucket]: { ...(value.categories?.[bucket] || current), kind: targetKind },
      },
    }));
    const trunk = TRUNK_BY_KIND[targetKind];
    if (!selectedId) {
      toast.success(`Tagged "${humanizeCategory(bucket)}" as ${trunk.label} — save to persist`);
      return;
    }
    const updated = await updateUniverse(
      selectedId,
      { categories: { [bucket]: nextBucket } },
      { silent: true },
    ).catch((error) => { toast.error(`Move failed: ${error.message}`); return null; });
    if (updated) {
      setWorlds((previous) => upsertByIdPrepend(previous, updated));
      toast.success(`Moved "${humanizeCategory(bucket)}" to ${trunk.label}`);
    }
  };

  const updateCompositeSheets = useCallback((sheets) => {
    setDraft((current) => ({ ...current, compositeSheets: sheets }));
  }, []);

  const addCategory = useCallback(() => {
    const key = normalizeCategoryKey(newCategoryName);
    if (!key) {
      toast.error('Use letters or numbers for the category name');
      return;
    }
    if (draft.categories?.[key]) {
      toast.error('Category already exists');
      return;
    }
    setDraft((current) => ({
      ...current,
      categories: { ...current.categories, [key]: { variations: [] } },
    }));
    setNewCategoryName('');
  }, [draft.categories, newCategoryName]);

  const removeCategory = useCallback((category) => setDraft((current) => {
    const categories = { ...current.categories };
    delete categories[category];
    return { ...current, categories: ensureDraftCategories(categories) };
  }), []);

  const providerLabel = useCallback(
    (id) => providers.find((provider) => provider.id === id)?.name || id || '—',
    [providers],
  );
  const providerModels = useMemo(() => {
    const provider = providers.find((item) => item.id === draft.llm?.provider)
      || providers.find((item) => item.id === activeProviderId);
    return provider?.models || [];
  }, [providers, activeProviderId, draft.llm?.provider]);
  const styleProbeDirty = !sameJsonShape(
    savedStyleSnapshotRef.current,
    ensureInfluences(draft.influences),
  );
  // The render-pin ladder's inputs (see `renderPinLadder`), resolved here at the
  // source — this hook owns every rung — rather than at each consumer, so a new
  // render affordance on this page inherits the pin instead of re-introducing
  // the bug. `targetPin` doubles as the "settings loaded" sentinel: it is only
  // ever set from a successful read, and the backend list must be passed as
  // `null` (not the initial `[]`, which reads as "loaded, nothing enabled" and
  // would suppress every pin) until then.
  const pinSources = [draft, targetPin];
  const pinBackends = targetPin ? availableBackends : null;
  // What every SINGLE-image render on this page uses: cast / places / objects
  // reference renders and clean plates.
  const imageCfg = useMemo(
    () => applyRecordRenderPin(settingsImageCfg, pinSources, pinBackends),
    [settingsImageCfg, targetPin, draft.imageMode, draft.imageModelId, availableBackends],
  );
  // The same ladder for the BATCH form's default mode. The client always sends
  // an explicit body.mode once settings load, so without resolving it here the
  // pins would only ever apply to mode-less API callers.
  const effectiveDefaultMode = renderPinLadder(pinSources, pinBackends).mode || defaultMode;

  return {
    activeProviderId,
    addCategory,
    assignBucketKind,
    availableBackends,
    availableLoras,
    canonDirty,
    clearPendingCanonAdditions,
    defaultMode,
    draft,
    draftRef,
    effectiveDefaultMode,
    flushDraftIfDirty,
    handleCanonChange,
    handleCreateNamed,
    handleDelete,
    handleSave,
    imageCfg,
    imageModels,
    isDraftDirty,
    loading,
    markDraftSaved,
    mountedRef,
    newCategoryName,
    pendingCanonAdditionsRef,
    pendingDeleteId,
    providerLabel,
    providerModels,
    providers,
    // Exposed so a consumer can retry the catalog/settings load after a failed
    // refresh instead of forcing a full page reload.
    refresh,
    adoptStyleGuideFromBoard,
    persistStyleReference,
    removeCategory,
    removeStyleReference,
    runs,
    saving,
    setRenderPin,
    setCanonDirty,
    setDraft,
    setNewCategoryName,
    setPendingDeleteId,
    setRuns,
    setSaving,
    setWorlds,
    styleProbeDirty,
    syncEntryIdsFromServer,
    toggleLock,
    universes,
    updateCategory,
    updateCompositeSheets,
    updateDraft,
  };
}
