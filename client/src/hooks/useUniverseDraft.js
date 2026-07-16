import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import {
  createUniverse,
  deleteUniverse,
  getProviders,
  getSettings,
  getUniverse,
  listImageModels,
  listLorasFull,
  listUniverses,
  listWorldRuns,
  updateUniverse,
  WORLD_LOCKABLE_FIELDS,
  ensureInfluences,
} from '../services/api';
import { deriveAvailableBackends, IMAGE_GEN_MODE } from '../lib/imageGenBackends';
import { PIPELINE_IMAGE_DEFAULTS, readPipelineImageSettings } from '../lib/pipelineImageDefaults';
import { sameJsonShape } from '../lib/sameJsonShape';
import { upsertByIdPrepend } from '../lib/upsertByIdPrepend';
import { mergeCanonByName } from '../lib/universeBuilderExpand';
import {
  TRUNK_BY_KIND,
  ensureDraftCategories,
  humanizeCategory,
  normalizeCategoryKey,
} from '../lib/universeBuilderShared';

export const createEmptyUniverseDraft = () => ({
  name: '',
  starterPrompt: '',
  logline: '',
  premise: '',
  styleNotes: '',
  categories: ensureDraftCategories(),
  compositeSheets: [],
  influences: { embrace: [], avoid: [] },
  locked: {},
  llm: { provider: null, model: null },
});

// Stable serialization of the fields the general Save action owns. Canon is
// excluded because its targeted editors persist those arrays independently.
export const universeDraftSnapshot = (draft = {}) => JSON.stringify({
  name: (draft.name || '').trim(),
  starterPrompt: draft.starterPrompt || '',
  logline: draft.logline || '',
  premise: draft.premise || '',
  styleNotes: draft.styleNotes || '',
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
  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);
  const [draft, setDraft] = useState(createEmptyUniverseDraft);
  const [runs, setRuns] = useState([]);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [canonDirty, setCanonDirty] = useState(false);

  const mountedRef = useRef(true);
  const draftRef = useRef(null);
  const savedDraftSnapshotRef = useRef(universeDraftSnapshot(createEmptyUniverseDraft()));
  const savedStyleSnapshotRef = useRef(ensureInfluences(createEmptyUniverseDraft().influences));
  const pendingCanonAdditionsRef = useRef(emptyPendingCanon());

  useEffect(() => () => { mountedRef.current = false; }, []);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  const clearPendingCanonAdditions = useCallback(() => {
    pendingCanonAdditionsRef.current = emptyPendingCanon();
  }, []);

  const markDraftSaved = useCallback((snapshotSource) => {
    savedDraftSnapshotRef.current = universeDraftSnapshot(snapshotSource);
    savedStyleSnapshotRef.current = ensureInfluences(snapshotSource?.influences);
  }, []);

  const isDraftDirty = useCallback(
    () => savedDraftSnapshotRef.current !== universeDraftSnapshot(draftRef.current || draft),
    [draft],
  );

  const refresh = async () => {
    setLoading(true);
    const [list, providerData, models, loras, settings] = await Promise.all([
      listUniverses().catch(() => []),
      getProviders().catch(() => ({ providers: [] })),
      listImageModels().catch(() => []),
      listLorasFull().catch(() => []),
      getSettings().catch(() => ({})),
    ]);
    setWorlds(list);
    setProviders(providerData.providers || []);
    setActiveProviderId(providerData.activeProvider || null);
    setImageModels(models || []);
    setAvailableLoras(Array.isArray(loras) ? loras : []);
    const backends = deriveAvailableBackends(settings, { excludeExternal: true });
    setAvailableBackends(backends);
    const saved = settings?.imageGen?.mode;
    setDefaultMode(backends.find((backend) => backend.id === saved)?.id || backends[0]?.id || IMAGE_GEN_MODE.LOCAL);
    setImageCfg(readPipelineImageSettings(settings));
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
    ]).then(([universe, nextRuns]) => {
      if (cancelled) return;
      if (universe) {
        const hydrated = {
          ...universe,
          categories: ensureDraftCategories(universe.categories),
          compositeSheets: universe.compositeSheets || [],
          logline: universe.logline || '',
          premise: universe.premise || '',
          styleNotes: universe.styleNotes || '',
          influences: ensureInfluences(universe.influences),
          locked: universe.locked || {},
          llm: universe.llm || { provider: null, model: null },
        };
        setDraft(hydrated);
        markDraftSaved(hydrated);
      }
      setRuns(nextRuns);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

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
      categories: draft.categories,
      compositeSheets: draft.compositeSheets || [],
      influences: ensureInfluences(draft.influences),
      locked: draft.locked || {},
      llm: draft.llm || {},
    };
    const needsCanonInPayload = !selectedId || canonDirty;
    let payload = basePayload;
    if (needsCanonInPayload) {
      if (selectedId) {
        const fresh = await getUniverse(selectedId).catch(() => null);
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
      ? await updateUniverse(selectedId, payload).catch((error) => { toast.error(`Save failed: ${error.message}`); return null; })
      : await createUniverse(payload).catch((error) => { toast.error(`Save failed: ${error.message}`); return null; });
    setSaving(false);
    if (!result) return null;
    if (needsCanonInPayload) {
      setCanonDirty(false);
      clearPendingCanonAdditions();
    }
    markDraftSaved(payload);
    toast.success(selectedId ? 'World updated' : 'World created');
    setWorlds((previous) => upsertByIdPrepend(previous, result));
    if (result.id !== selectedId) goToWorld(result.id);
    return result;
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
    const result = await createUniverse({ ...createEmptyUniverseDraft(), name })
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

  const toggleLock = useCallback((field) => {
    if (!WORLD_LOCKABLE_FIELDS.includes(field)) return;
    setDraft((current) => {
      const nextLocked = { ...(current.locked || {}) };
      if (nextLocked[field]) delete nextLocked[field];
      else nextLocked[field] = true;
      const next = { ...current, locked: nextLocked };
      if (selectedId && next.name?.trim()) {
        updateUniverse(selectedId, { locked: nextLocked })
          .catch((error) => toast.error(`Lock save failed: ${error.message}`));
      }
      return next;
    });
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
    removeCategory,
    runs,
    saving,
    setCanonDirty,
    setDraft,
    setNewCategoryName,
    setPendingDeleteId,
    setRuns,
    setSaving,
    setWorlds,
    styleProbeDirty,
    toggleLock,
    universes,
    updateCategory,
    updateCompositeSheets,
    updateDraft,
  };
}
