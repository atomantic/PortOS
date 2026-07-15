/**
 * Universe Builder editor composition (Media Gen → Universe Builder).
 *
 * Stateful record, expansion, gallery, and render concerns live in hooks.
 * Tab-specific presentation lives in the sibling panel modules.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, BookOpen, FolderTree, ImagePlus, Layers, Loader2,
  MapPin, Package, Plus, Save, Trash2, Users,
} from 'lucide-react';
import toast from '../ui/Toast';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import {
  WORLD_CATEGORY_KEY_MAX,
  autoSortBuckets,
  ensureInfluences,
  generateCategoryVariations,
  promoteVariationToCanon,
  updateUniverse,
} from '../../services/api';
import useUniverseAction from '../../hooks/useUniverseAction';
import useUniverseDraft from '../../hooks/useUniverseDraft';
import useUniverseExpand from '../../hooks/useUniverseExpand';
import useUniverseGallery from '../../hooks/useUniverseGallery';
import { useUniverseNav } from '../../hooks/useUniverseNav';
import useUniverseRender from '../../hooks/useUniverseRender';
import EntityCombobox from '../EntityCombobox';
import MediaPreview from '../media/MediaPreview';
import OriginBadge from '../sharing/OriginBadge';
import ShareToButton from '../sharing/ShareToButton';
import SyncToPeerButton from '../sharing/SyncToPeerButton';
import TabPills from '../ui/TabPills';
import CompositeSheetsEditor from './CompositeSheetsEditor';
import RenderTab from './RenderTab';
import UniverseBibleTab from './UniverseBibleTab';
import { OtherTab, TrunkView } from './UniverseTrunkPanels';
import { capImageRefs } from '../../lib/bibleLimits';
import { upsertByIdPrepend } from '../../lib/upsertByIdPrepend';
import { mergeVariations } from '../../lib/universeBuilderExpand';
import { totalVariationCount } from '../../lib/universeBuilderCounts';
import {
  BUCKET_CANON,
  TAB_BIBLE,
  TAB_CAST,
  TAB_COMPOSITES,
  TAB_OBJECTS,
  TAB_OTHER,
  TAB_PLACES,
  TAB_RENDER,
  TRUNK_BY_ID,
  TRUNK_TABS,
  getCategoryKeys,
  groupBucketsByKind,
  humanizeCategory,
} from '../../lib/universeBuilderShared';

export { CategoryEditor } from './UniverseCategoryEditor';
export { OtherTab, TrunkView };


// Universe autocomplete combobox: search existing universes or create one when
// the trimmed query doesn't exactly match any. `onCreate` is wired to a
// dedicated create path (not handleSave) so typing a new name while an existing
// universe is selected never accidentally renames it. The match-or-create UX
// lives in the shared `EntityCombobox`; this thin wrapper maps universes into
// its `{ id, name, subtitle }` item shape and preserves the universe-specific
// labels/ids.
export function UniverseSelector({ universes, selectedId, value, onChange, onPick, onCreate, busy }) {
  const items = useMemo(
    () => (Array.isArray(universes) ? universes : []).map((u) => ({
      id: u.id,
      name: u.name,
      subtitle: u.starterPrompt || 'No starter prompt',
    })),
    [universes],
  );
  return (
    <EntityCombobox
      items={items}
      selectedId={selectedId}
      value={value}
      onChange={onChange}
      onPick={(item) => onPick(item.id)}
      onCreate={onCreate}
      busy={busy}
      inputId="universe-name"
      noun="universe"
      placeholder="Search universes or type a new name…"
      emptyNoItems="No universes yet — type a name and Create."
      maxLength={100}
    />
  );
}

export default function UniverseBuilder() {
  // The selected world id lives in the URL so deep-linking + back/forward
  // work. The editor is mounted at /universes/:universeId and /universes/new —
  // strip any trailing /<id> off the current pathname to derive the base for
  // navigation back to the list.
  const params = useParams();
  const location = useLocation();
  // `/universes/new` is the create-mode entry point from the Universes index —
  // treat the `new` sentinel as "no id" (blank draft). Real universe ids are
  // UUIDs, so this can never shadow an actual record.
  const selectedId = params.universeId && params.universeId !== 'new' ? params.universeId : null;
  // `goToWorld` preserves `location.search` (e.g. `?tab=&bucket=&series=`) so
  // the auto-save → create path doesn't snap the user back to the Bible tab
  // after they triggered Generate From Idea from inside Cast/Places/Objects.
  // The stale-bucket effect already strips any bucket that no longer exists
  // under the new universe's categories.
  const goToWorld = useUniverseNav();

  const {
    activeProviderId,
    addCategory,
    assignBucketKind,
    availableBackends,
    availableLoras,
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
  } = useUniverseDraft({ selectedId, goToWorld });
  const {
    canRender,
    clearPendingForEntry,
    handleRender,
    pendingHeadByEntryId,
    renderOpts,
    rendering,
    runRender,
    setRenderOpts,
  } = useUniverseRender({
    selectedId,
    draft,
    availableBackends,
    defaultMode,
    runs,
    setRuns,
  });
  const { expanding, handleExpand, refine } = useUniverseExpand({
    selectedId,
    draft,
    setDraft,
    setSaving,
    setWorlds,
    goToWorld,
    activeProviderId,
    markDraftSaved,
    setCanonDirty,
    pendingCanonAdditionsRef,
    clearPendingCanonAdditions,
    setRenderOpts,
  });
  // Page-level in-flight gate for the promote action. Ref + state pair so
  // the disable check stays synchronous (ref) while still triggering renders
  // (state). Promote writes to `universe[bibleField]` and `categories[key]`
  // as wholesale replacements from a stale snapshot — letting two run in
  // parallel against the same universe would let the second clobber the
  // first's canon append.
  const [promoting, setPromoting] = useState(false);
  const promotingRef = useRef(false);
  const [autoSorting, setAutoSorting] = useState(false);
  const autoSortingRef = useRef(false);
  // Scaffolding shared by handlePromoteVariation + handleAutoSort:
  // selectedId guard, ref re-entrancy, capturedId + toast lifecycle,
  // setWorlds always-update, stale-write detection. See the hook header.
  const runUniverseAction = useUniverseAction({ selectedId, mountedRef, setWorlds });

  // Page-level lightbox + gallery-metadata concern. A single MediaPreview at
  // this level covers EVERY thumb on the page: variations, composite sheets,
  // canon imageRefs, style probes, and character reference sheets — so clicking
  // any image opens the same full-detail modal History / Collections / ImageGen
  // use, with the same actions (Refine / Remix / SendToVideo / Clean /
  // AddToCollection / Download / notes). URL-driven (`?preview=<filename>`).
  // Extracted to useUniverseGallery (#2532) — see the hook for the
  // gallery-sidecar hydration, dedupe-by-namespaced-key, and refetch-trigger
  // rationale. `runs.length` (initial-load + queue-time) and per-job
  // completion (`bumpGalleryRefresh`) both drive the metadata refetch.
  const {
    previewItems, preview, setPreview, previewActions,
    openPreviewByFilename, openVariationPreview,
    annotations, updateAnnotation, bumpGalleryRefresh,
  } = useUniverseGallery({ draft, runsLength: runs.length });

  // Hash-scroll for deep-links — the legacy `/canon` redirect and
  // PipelineSeries' "Manage characters, places, and objects" link both
  // navigate to `/universes/<id>#canon`. React Router doesn't
  // auto-scroll to hashes, so wait until the section is rendered (gated by
  // `draft.id === selectedId`) then scroll. The element id (`canon`) is set
  // on UniverseCanonSection's root <section>.
  useEffect(() => {
    if (!location.hash) return;
    if (!selectedId || draft.id !== selectedId) return;
    const id = location.hash.slice(1);
    // Defer one frame so the lazy section is in the DOM before we query for it.
    const t = setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => clearTimeout(t);
  }, [location.hash, selectedId, draft.id]);

  // Auto-sort with AI — one LLM call classifies every Other-tab bucket into
  // characters/places/objects. Each bucket's `kind` is reassigned via a
  // single atomic patch server-side so the universe ends up consistent or
  // unchanged. Renames the LLM suggests are surfaced in the toast but not
  // auto-applied (the user can rename manually if they want it).
  // Returns true when the draft is clean or save succeeded; false (with
  // handleSave's own error toast already raised) when save failed.
  const flushDraftIfDirty = useCallback(async () => {
    if (!isDraftDirty()) return true;
    const saved = await handleSave();
    return !!saved;
  }, [isDraftDirty]);

  const handleAutoSort = () => runUniverseAction({
    ref: autoSortingRef,
    setBusy: setAutoSorting,
    loadingMessage: 'Auto-sorting buckets with AI…',
    errorPrefix: 'Auto-sort failed',
    notSavedMessage: 'Save the universe first — auto-sort needs the persisted record',
    preflight: flushDraftIfDirty,
    action: (capturedId) => autoSortBuckets(capturedId, {
      providerId: draft.llm?.provider || undefined,
      model: draft.llm?.model || undefined,
    }, { silent: true }),
    onFreshResult: (result) => {
      const updated = result.universe;
      // Merge only the reclassified buckets into the draft — wholesale-
      // replacing `categories` with the server snapshot would discard any
      // user edits to OTHER buckets made while the LLM call was in flight.
      // Compute the merge from draftRef so React strict-mode's double-fire
      // of state updaters doesn't double-stringify the dirty baseline.
      const sortedKeys = new Set((result.results || []).map((r) => r.sourceKey));
      const baseDraft = draftRef.current || draft;
      const nextCategories = { ...(baseDraft.categories || {}) };
      for (const key of sortedKeys) {
        if (updated.categories?.[key]) nextCategories[key] = updated.categories[key];
      }
      const newDraft = {
        ...baseDraft,
        categories: nextCategories,
        schemaVersion: updated.schemaVersion,
        updatedAt: updated.updatedAt,
      };
      setDraft(newDraft);
      markDraftSaved(newDraft);
      const sortedCount = result.results?.length || 0;
      const renames = (result.results || []).filter((r) => r.suggestedKey);
      const summary = sortedCount
        ? `Sorted ${sortedCount} bucket${sortedCount === 1 ? '' : 's'} into canon trunks`
        : 'No buckets were classified';
      const renameHint = renames.length
        ? ` — ${renames.length} rename suggestion${renames.length === 1 ? '' : 's'} available`
        : '';
      return `${summary}${renameHint}`;
    },
  });

  const handleGenerateInCategory = async (cat, count) => {
    // Match the runUniverseAction-based handlers — flush dirty draft so the
    // subsequent auto-save can't clobber unrelated fields with a stale spread.
    const flushed = await flushDraftIfDirty();
    if (!flushed) return;
    const current = draft.categories?.[cat]?.variations || [];
    const existingLabels = current.map((v) => v.label).filter(Boolean);
    const result = await generateCategoryVariations({
      category: cat,
      count,
      existingLabels,
      influences: ensureInfluences(draft.influences),
      logline: draft.logline || '',
      premise: draft.premise || '',
      styleNotes: draft.styleNotes || '',
      providerId: draft.llm?.provider || undefined,
      model: draft.llm?.model || undefined,
    }, { silent: true }).catch((e) => { toast.error(`Generate failed: ${e.message}`); return null; });
    if (!result) return;
    const fresh = Array.isArray(result.variations) ? result.variations : [];
    const merged = mergeVariations(current, fresh);
    const additionCount = merged.length - current.length;
    if (additionCount === 0) {
      toast.error('LLM returned no new variations — try again or adjust the universe context');
      return;
    }
    const nextDraft = {
      ...draft,
      // Preserve the bucket's `kind` (mirror of updateCategory's behavior;
      // see comment there). Generate-more is the second write path that
      // could silently reset the trunk to default/other.
      categories: { ...draft.categories, [cat]: { ...(draft.categories?.[cat] || {}), variations: merged } },
    };
    setDraft(nextDraft);
    if (selectedId && nextDraft.name?.trim()) {
      const updated = await updateUniverse(selectedId, { categories: nextDraft.categories })
        .catch((e) => { toast.error(`Auto-save after generate failed: ${e.message}`); return null; });
      if (updated) {
        setWorlds((prev) => upsertByIdPrepend(prev, updated));
        markDraftSaved(nextDraft);
        toast.success(`Added ${additionCount} variation${additionCount === 1 ? '' : 's'} to ${humanizeCategory(cat)} — saved`);
        return;
      }
    }
    toast.success(`Added ${additionCount} variation${additionCount === 1 ? '' : 's'} to ${humanizeCategory(cat)} — review then Save`);
  };
  // Requires `selectedId` — the server action reads the persisted record,
  // so an unsaved draft can't be promoted from. The page-level `promoting`
  // gate prevents two promotes (across buckets or trunks) from racing each
  // other to stale-snapshot writes against the same universe.
  const handlePromoteVariation = (category, variation, { targetKind } = {}) => {
    if (!variation?.label) return Promise.resolve(null);
    return runUniverseAction({
      ref: promotingRef,
      setBusy: setPromoting,
      loadingMessage: `Promoting "${variation.label}" to canon…`,
      errorPrefix: 'Promote failed',
      notSavedMessage: 'Save the universe first — promote needs the persisted record',
      preflight: flushDraftIfDirty,
      action: (capturedId) => promoteVariationToCanon(capturedId, {
        category,
        label: variation.label,
        targetKind,
        providerId: draft.llm?.provider || undefined,
        model: draft.llm?.model || undefined,
      }, { silent: true }),
      onFreshResult: (result) => {
        const updated = result.universe;
        // Selective merge: only the canon array + the affected category bucket
        // changed server-side. Preserve every other draft field (the user may
        // have typed into logline/premise/influences during the LLM call).
        // Compute outside setDraft so strict-mode's double-invoke doesn't
        // re-stringify the dirty baseline.
        const baseDraft = draftRef.current || draft;
        const newDraft = {
          ...baseDraft,
          characters: updated.characters,
          places: updated.places,
          objects: updated.objects,
          categories: { ...baseDraft.categories, [result.removed.category]: updated.categories?.[result.removed.category] },
          schemaVersion: updated.schemaVersion,
          updatedAt: updated.updatedAt,
        };
        setDraft(newDraft);
        markDraftSaved(newDraft);
        return `Promoted "${variation.label}" → ${result.targetKind} canon`;
      },
    });
  };
  const categoryKeys = getCategoryKeys(draft.categories);
  const totalVariations = totalVariationCount(draft);
  const totalSheets = draft.compositeSheets?.length || 0;

  // URL-driven tab + bucket state (per CLAUDE.md "Linkable routes for all
  // views"). `?tab=cast&bucket=heroes` deep-links into a sub-bucket; both fall
  // back to bible / "" (All) on first load. We also forward existing params
  // (e.g. `?series=` on the embedded Canon section) untouched.
  const [searchParams, setSearchParams] = useSearchParams();
  const bucketsByKind = useMemo(() => groupBucketsByKind(draft.categories), [draft.categories]);
  const hasOtherBuckets = bucketsByKind.other.length > 0;
  const requestedTab = searchParams.get('tab');
  const isValidTab = (tab) => (
    tab === TAB_BIBLE || tab === TAB_CAST || tab === TAB_PLACES || tab === TAB_OBJECTS
    || tab === TAB_COMPOSITES || tab === TAB_RENDER
    || (tab === TAB_OTHER && hasOtherBuckets)
  );
  const activeTab = isValidTab(requestedTab) ? requestedTab : TAB_BIBLE;
  const activeBucket = searchParams.get('bucket') || '';
  const setTab = useCallback((tab, opts = {}) => {
    const currentTab = searchParams.get('tab') || TAB_BIBLE;
    const isSameTab = tab === currentTab;
    const next = new URLSearchParams(searchParams);
    if (tab === TAB_BIBLE) next.delete('tab');
    else next.set('tab', tab);
    // Bucket behavior:
    //   - explicit `opts.bucket` value (string) → set
    //   - explicit `opts.bucket: null` → clear (callers that want to drop the
    //     filter on the same tab pass null intentionally)
    //   - omitted + same tab → preserve current bucket (re-clicking the
    //     active tab shouldn't drop the user's chip/canon filter)
    //   - omitted + tab transition → clear (the old bucket is meaningless on
    //     the new tab's bucket namespace)
    if (opts.bucket === null) next.delete('bucket');
    else if (opts.bucket) next.set('bucket', opts.bucket);
    else if (!isSameTab) next.delete('bucket');
    setSearchParams(next, { replace: !!opts.replace });
  }, [searchParams, setSearchParams]);
  // Explicit user bucket clicks push a history entry so back/forward actually
  // walks tab+bucket navigation (the PR's headline deep-link promise). The
  // stale-bucket-cleanup effect below uses `replace: true` directly so an
  // implicit URL fix-up doesn't fork the history stack.
  const setBucket = useCallback((bucket, opts = {}) => {
    const next = new URLSearchParams(searchParams);
    if (bucket) next.set('bucket', bucket);
    else next.delete('bucket');
    setSearchParams(next, { replace: !!opts.replace });
  }, [searchParams, setSearchParams]);

  // Drop a stale `?tab=` if it points to an unknown value or `tab=other`
  // when the user has emptied the Other bucket bin. Without this, the URL
  // and UI disagree: `activeTab` silently falls back to Bible but the param
  // stays in the address bar — breaking the deep-link promise and confusing
  // back/forward.
  useEffect(() => {
    if (!requestedTab) return;
    if (isValidTab(requestedTab)) return;
    const next = new URLSearchParams(searchParams);
    next.delete('tab');
    setSearchParams(next, { replace: true });
  }, [requestedTab, hasOtherBuckets]);

  // Drop a stale `?bucket=` if the bucket no longer exists under the current
  // tab (e.g. user deleted the bucket, or auto-sort moved it to another kind).
  // `BUCKET_CANON` is a valid pseudo-bucket on every trunk tab — without an
  // explicit allow, the chip's `setBucket(BUCKET_CANON)` flashed in the URL
  // then immediately got stripped by this effect, hiding the canon-only view.
  // Other tab buckets must validate against `bucketsByKind.other`; non-trunk
  // non-Other tabs (Bible / Composites / Render) have no valid bucket scope.
  useEffect(() => {
    if (!activeBucket) return;
    const trunk = TRUNK_BY_ID[activeTab];
    if (trunk && activeBucket === BUCKET_CANON) return;
    const validBuckets = trunk
      ? (bucketsByKind[trunk.kind] || [])
      : (activeTab === TAB_OTHER ? bucketsByKind.other : []);
    if (validBuckets.includes(activeBucket)) return;
    const next = new URLSearchParams(searchParams);
    next.delete('bucket');
    setSearchParams(next, { replace: true });
  }, [activeTab, activeBucket, bucketsByKind, searchParams, setSearchParams]);

  return (
    <div className="flex flex-col h-full">
      <section className="flex-1 flex flex-col gap-3 p-4 min-h-0 overflow-y-auto">
        {/* Back to the universe index (list/table at /universes). */}
        <Link
          to="/universes"
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-port-accent self-start"
        >
          <ArrowLeft size={14} /> All Universes
        </Link>
        {/* Thin action header — autocomplete universe selector doubles as the
            name field; Save + Share + Delete sit beside it so they're reachable
            from any tab. The Bible-tab actions (Generate / Refine, starter
            idea, story-bible fields) live inside the Bible tab itself, per
            Phase C "Bible is its own tab". */}
        {/* relative + z-30: themes that ship a non-none --port-backdrop-filter
            (Lumen Glass, Blueprint Ops) turn every .bg-port-card.border.rounded
            into its own stacking context, trapping the UniverseSelector's
            dropdown beneath later sibling cards (TabPills, section cards).
            Elevating this header lets its stacking context paint above those
            siblings so the dropdown overlays them as intended. */}
        <header className="relative z-30 bg-port-card border border-port-border rounded p-3 flex items-center gap-2 flex-wrap">
          <UniverseSelector
            universes={universes}
            selectedId={selectedId}
            value={draft.name || ''}
            onChange={(name) => updateDraft({ name })}
            onPick={(id) => goToWorld(id)}
            onCreate={() => handleCreateNamed(draft.name)}
            busy={saving || loading}
          />
          <button
            onClick={handleSave}
            disabled={saving || !draft.name?.trim()}
            className="px-3 py-2 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded flex items-center gap-2 min-h-[40px]"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {selectedId ? 'Save' : 'Create'}
          </button>
          {selectedId && (
            <>
              <ShareToButton kind="universe" ids={[selectedId]} label="Share" />
              <SyncToPeerButton recordKind="universe" recordId={selectedId} label="Sync" />
              {draft.origin ? <OriginBadge origin={draft.origin} /> : null}
              {pendingDeleteId === selectedId ? (
                <InlineConfirmRow
                  question={`Delete "${draft.name || 'this world'}"?`}
                  onConfirm={handleDelete}
                  onCancel={() => setPendingDeleteId(null)}
                />
              ) : (
                <button
                  onClick={() => setPendingDeleteId(selectedId)}
                  className="px-3 py-2 rounded flex items-center gap-2 min-h-[40px] bg-port-error/30 hover:bg-port-error/50 text-port-error"
                  title="Delete world"
                >
                  <Trash2 size={16} /> Delete
                </button>
              )}
            </>
          )}
        </header>

        <TabPills
          variant="pills"
          size="sm"
          mobileDropdown
          mobileSelectId="ub-tab-select"
          activeTab={activeTab}
          onChange={setTab}
          tabs={[
            { id: TAB_BIBLE, label: 'Bible', icon: BookOpen },
            { id: TAB_CAST, label: 'Cast', icon: Users, count: (draft.characters?.length || 0) + bucketsByKind.characters.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0) },
            { id: TAB_PLACES, label: 'Places', icon: MapPin, count: (draft.places?.length || 0) + bucketsByKind.places.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0) },
            { id: TAB_OBJECTS, label: 'Objects', icon: Package, count: (draft.objects?.length || 0) + bucketsByKind.objects.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0) },
            hasOtherBuckets && { id: TAB_OTHER, label: 'Other', icon: FolderTree, count: bucketsByKind.other.reduce((n, k) => n + (draft.categories?.[k]?.variations?.length || 0), 0) },
            { id: TAB_COMPOSITES, label: 'Composites', icon: Layers, count: totalSheets },
            { id: TAB_RENDER, label: 'Render', icon: ImagePlus },
          ]}
        />

        {activeTab === TAB_BIBLE && (
          <UniverseBibleTab
            draft={draft}
            updateDraft={updateDraft}
            toggleLock={toggleLock}
            llm={{ providers, providerModels, providerLabel, activeProviderId }}
            handleExpand={handleExpand}
            expanding={expanding}
            saving={saving}
            refine={refine}
            totalVariations={totalVariations}
            categoryKeyCount={categoryKeys.length}
            totalSheets={totalSheets}
            onPreview={openPreviewByFilename}
            onStyleProbeRenderComplete={bumpGalleryRefresh}
            styleProbeDirty={styleProbeDirty}
          />
        )}

        {TRUNK_TABS.map((trunk) => (
          activeTab === trunk.id ? (
            <TrunkView
              key={trunk.id}
              trunk={trunk}
              draft={draft}
              selectedId={selectedId}
              buckets={bucketsByKind[trunk.kind] || []}
              activeBucket={activeBucket}
              setBucket={setBucket}
              canRender={canRender}
              canPromote={!!selectedId && !promoting}
              imageCfg={imageCfg}
              onUniverseChange={handleCanonChange}
              onRemoveBucket={removeCategory}
              onUpdateBucket={updateCategory}
              onGenerateInBucket={handleGenerateInCategory}
              onPromoteVariation={(bucket, v) => handlePromoteVariation(bucket, v)}
              onBulkRenderBucket={(bucket) => runRender({ promptMode: 'variations', selection: { [bucket]: 'all' } })}
              onRenderVariation={(bucket, v) => runRender({ promptMode: 'variations', selection: { [bucket]: [v.label] } })}
              onPreviewVariation={openVariationPreview}
              onCanonPreview={openPreviewByFilename}
              pendingByEntryId={pendingHeadByEntryId}
              externalPendingByEntryId={pendingHeadByEntryId}
              onPendingCleared={clearPendingForEntry}
              onJobCompletedForEntry={(entryId, filename, bucket, completedJobId = null) => {
                if (!filename || !bucket) {
                  clearPendingForEntry(entryId, completedJobId);
                  return;
                }
                // Optimistically append the new filename to the variation's
                // imageRefs[] so the row swaps from spinner → rendered image
                // without a roundtrip. Server already stamped this via the
                // collection hook; the next universe refetch will agree.
                setDraft((d) => {
                  const cat = d.categories?.[bucket];
                  if (!cat?.variations) return d;
                  const variations = cat.variations.map((v) => {
                    if (v.id !== entryId) return v;
                    const refs = Array.isArray(v.imageRefs) ? v.imageRefs : [];
                    if (refs.includes(filename)) return v;
                    return { ...v, imageRefs: capImageRefs([...refs, filename]) };
                  });
                  return { ...d, categories: { ...d.categories, [bucket]: { ...cat, variations } } };
                });
                clearPendingForEntry(entryId, completedJobId);
                // The new sidecar exists now — pull it into galleryByFilename
                // so the lightbox opens with the real prompt/settings rather
                // than label-only metadata.
                bumpGalleryRefresh();
              }}
              onBulkRenderTrunk={() => {
                const selection = Object.fromEntries(
                  (bucketsByKind[trunk.kind] || []).map((b) => [b, 'all']),
                );
                const canonSelection = { [trunk.kind]: 'all' };
                // Empty sheetSelection opts out of composite sheets — without
                // it, the server's `sheetSelection || 'all'` default would
                // queue every sheet alongside the trunk's canon + variations,
                // overshooting the user-facing "N images" count.
                runRender({ promptMode: 'all', selection, canonSelection, sheetSelection: [] });
              }}
              onAddBucket={({ key }) => {
                setDraft((d) => ({
                  ...d,
                  categories: { ...d.categories, [key]: { kind: trunk.kind, variations: [] } },
                }));
              }}
            />
          ) : null
        ))}

        {activeTab === TAB_OTHER && hasOtherBuckets && (
          <OtherTab
            draft={draft}
            buckets={bucketsByKind.other}
            activeBucket={activeBucket}
            setBucket={setBucket}
            canRender={canRender}
            canPromote={!!selectedId && !promoting}
            onUpdateBucket={updateCategory}
            onRemoveBucket={removeCategory}
            onGenerateInBucket={handleGenerateInCategory}
            onPromoteVariation={(bucket, v, opts) => handlePromoteVariation(bucket, v, opts)}
            onBulkRenderBucket={(bucket) => runRender({ promptMode: 'variations', selection: { [bucket]: 'all' } })}
            onRenderVariation={(bucket, v) => runRender({ promptMode: 'variations', selection: { [bucket]: [v.label] } })}
            onPreviewVariation={openVariationPreview}
            onAssignBucketKind={assignBucketKind}
            onAutoSort={handleAutoSort}
            autoSorting={autoSorting}
            pendingByEntryId={pendingHeadByEntryId}
            onPendingCleared={clearPendingForEntry}
            onJobCompletedForEntry={(entryId, filename, bucket, completedJobId = null) => {
              if (!filename || !bucket) {
                clearPendingForEntry(entryId, completedJobId);
                return;
              }
              setDraft((d) => {
                const cat = d.categories?.[bucket];
                if (!cat?.variations) return d;
                const variations = cat.variations.map((v) => {
                  if (v.id !== entryId) return v;
                  const refs = Array.isArray(v.imageRefs) ? v.imageRefs : [];
                  if (refs.includes(filename)) return v;
                  return { ...v, imageRefs: capImageRefs([...refs, filename]) };
                });
                return { ...d, categories: { ...d.categories, [bucket]: { ...cat, variations } } };
              });
              clearPendingForEntry(entryId, completedJobId);
              // Pull the new sidecar into galleryByFilename so the lightbox
              // opens with the real prompt/settings (mirrors the Cast/Places
              // path's onJobCompletedForEntry above).
              bumpGalleryRefresh();
            }}
          />
        )}

        {activeTab === TAB_COMPOSITES && (
          <>
            <CompositeSheetsEditor
              sheets={draft.compositeSheets || []}
              onChange={updateCompositeSheets}
              canRender={canRender}
              onRender={(sheet) => runRender({ promptMode: 'sheets', sheetSelection: [sheet.label] })}
            />
            {/* Add-bucket row stays available here for power users who want to
                introduce a brand-new custom bucket without going through
                expand. New buckets default to kind='other' so they land under
                the Other tab. */}
            <section className="bg-port-card border border-port-border rounded p-3 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-400 mr-1">Add a custom sub-bucket (lands under Other):</span>
              <input
                type="text"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') addCategory(); }}
                placeholder="colonies, factions, species"
                className="w-44 bg-port-bg border border-port-border rounded px-2 py-2 text-white text-sm focus:outline-none focus:border-port-accent"
                maxLength={WORLD_CATEGORY_KEY_MAX}
              />
              <button
                onClick={addCategory}
                disabled={!newCategoryName.trim()}
                className="px-3 py-2 bg-port-accent/15 hover:bg-port-accent/25 disabled:opacity-50 text-port-accent rounded flex items-center gap-1 min-h-[40px]"
              >
                <Plus size={14} /> Add
              </button>
            </section>
          </>
        )}

        {activeTab === TAB_RENDER && (
          <RenderTab
            draft={draft}
            selectedId={selectedId}
            bucketsByKind={bucketsByKind}
            renderOpts={renderOpts}
            setRenderOpts={setRenderOpts}
            availableBackends={availableBackends}
            defaultMode={defaultMode}
            imageModels={imageModels}
            availableLoras={availableLoras}
            handleRender={handleRender}
            rendering={rendering}
            runs={runs}
          />
        )}
      </section>

      {/* Single page-level lightbox for every thumb on the page: variation
          grids, composite sheets, canon imageRefs (characters / places /
          objects), and character reference sheets. UniverseCanonSection used
          to host its own MediaPreview with a reduced action set + character
          description in place of the prompt; that fork is gone — canon
          clicks now bubble up through `openPreviewByFilename` and hit this
          modal, so the canon surface matches History / Collections / ImageGen
          exactly (Refine / Remix / SendToVideo / Clean / AddToCollection /
          Download / notes, all hydrated from the gallery sidecar). URL-driven
          via `usePreviewRoute` so `?preview=<filename>` deep-links open the
          same modal on reload. */}
      {/* Character reference sheets live under /data/image-refs/, but
          Remix / Send-to-Video / Clean / Continue all resolve filenames
          under /data/images/ (the gallery). Suppress those handlers when
          the current preview is a canon-sheet item so the lightbox doesn't
          offer actions that would 404 on the bare filename. */}
      <MediaPreview
        preview={preview}
        setPreview={setPreview}
        items={previewItems}
        annotations={annotations}
        updateAnnotation={updateAnnotation}
        onRemix={preview?.key?.startsWith('canon-sheet:') ? undefined : previewActions.handleRemix}
        onSendToImage={preview?.key?.startsWith('canon-sheet:') ? undefined : previewActions.handleSendToImage}
        onSendToVideo={preview?.key?.startsWith('canon-sheet:') ? undefined : previewActions.handleSendToVideo}
        onClean={preview?.key?.startsWith('canon-sheet:') ? undefined : (item) => previewActions.handleClean(item?.raw || item)}
        onRemoveWatermark={preview?.key?.startsWith('canon-sheet:') ? undefined : (item) => previewActions.handleRemoveWatermark(item?.raw || item)}
        onContinue={preview?.key?.startsWith('canon-sheet:') ? undefined : (item) => previewActions.handleContinue(item?.raw || item)}
      />
    </div>
  );
}
