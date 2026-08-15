/**
 * Universe Builder editor composition (Media Gen → Universe Builder).
 *
 * Stateful record, expansion, gallery, render, URL tab/bucket, and bucket-
 * mutation concerns live in hooks (useUniverseDraft / useUniverseExpand /
 * useUniverseGallery / useUniverseRender / useUniverseTabs /
 * useUniverseBucketActions). Tab-specific presentation lives in the sibling
 * panel modules.
 */

import { useCallback, useEffect, useMemo } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import {
  ArrowLeft, BookOpen, FolderTree, ImagePlus, Layers, Loader2,
  MapPin, Package, Plus, Save, Trash2, Users,
} from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import toast from '../ui/Toast';
import { WORLD_CATEGORY_KEY_MAX } from '../../services/api';
import useUniverseBucketActions from '../../hooks/useUniverseBucketActions';
import useUniverseDraft from '../../hooks/useUniverseDraft';
import useUniverseExpand from '../../hooks/useUniverseExpand';
import useUniverseGallery from '../../hooks/useUniverseGallery';
import { useUniverseNav } from '../../hooks/useUniverseNav';
import useUniverseRender from '../../hooks/useUniverseRender';
import useUniverseTabs from '../../hooks/useUniverseTabs';
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
import { appendImageRefById } from '../../lib/bibleLimits';
import { totalVariationCount } from '../../lib/universeBuilderCounts';
import {
  TAB_BIBLE,
  TAB_CAST,
  TAB_COMPOSITES,
  TAB_OBJECTS,
  TAB_OTHER,
  TAB_PLACES,
  TAB_RENDER,
  TRUNK_TABS,
  getCategoryKeys,
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
    loading,
    markDraftSaved,
    mountedRef,
    newCategoryName,
    pendingCanonAdditionsRef,
    pendingDeleteId,
    providerLabel,
    providerModels,
    providers,
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
    defaultMode: effectiveDefaultMode,
    runs,
    setRuns,
    preflight: flushDraftIfDirty,
    syncEntryIdsFromServer,
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
  // URL-driven tab + bucket state (per CLAUDE.md "Linkable routes for all
  // views"), including the self-healing effects that strip a `?tab=`/`?bucket=`
  // the current categories no longer support.
  const {
    activeBucket, activeTab, bucketsByKind, hasOtherBuckets, setBucket, setTab,
  } = useUniverseTabs(draft.categories);
  // Generate-in-bucket / promote-to-canon / auto-sort, each with its own
  // in-flight gate so two writes built from the same stale snapshot can't
  // clobber each other's canon append.
  const {
    autoSorting, handleAutoSort, handleGenerateInCategory, handlePromoteVariation, promoting,
  } = useUniverseBucketActions({
    selectedId,
    draft,
    draftRef,
    setDraft,
    setWorlds,
    markDraftSaved,
    mountedRef,
    flushDraftIfDirty,
  });

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

  const categoryKeys = getCategoryKeys(draft.categories);
  const totalVariations = totalVariationCount(draft);
  const totalSheets = draft.compositeSheets?.length || 0;

  // Settle one row's render job: optimistically append the new filename to that
  // entry's imageRefs[] so the row swaps from spinner → rendered image without a
  // roundtrip, then shift the jobId out of the row's pending queue and pull the
  // fresh sidecar into galleryByFilename so the lightbox opens with the real
  // prompt/settings rather than label-only metadata. The server's completion
  // hook already stamped the ref durably; the next universe refetch will agree.
  // `applyAppend(draft, appended)` is the only per-surface part — it splices the
  // updated list back into whichever collection owns the row (a category's
  // variations vs. the top-level compositeSheets), and returns the draft
  // unchanged when the collection isn't there.
  const settleEntryJob = useCallback((entryId, filename, completedJobId, selectList, applyAppend) => {
    if (filename) {
      setDraft((d) => {
        const appended = appendImageRefById(selectList(d), entryId, filename);
        // `null` (no such collection) or an unchanged array (unknown id / ref
        // already present) both mean there's nothing to re-render for.
        if (!appended || appended === selectList(d)) return d;
        return applyAppend(d, appended);
      });
      bumpGalleryRefresh();
    }
    clearPendingForEntry(entryId, completedJobId);
  }, [clearPendingForEntry, setDraft, bumpGalleryRefresh]);

  // Shared by every bucket grid (trunk tabs + Other).
  const handleEntryJobCompleted = useCallback((entryId, filename, bucket, completedJobId = null) => {
    settleEntryJob(
      entryId,
      bucket ? filename : null,
      completedJobId,
      (d) => d.categories?.[bucket]?.variations,
      (d, variations) => ({
        ...d,
        categories: { ...d.categories, [bucket]: { ...d.categories[bucket], variations } },
      }),
    );
  }, [settleEntryJob]);

  // Composite boards on the Composites tab.
  const handleSheetJobSettled = useCallback((sheetId, filename, settledJobId = null) => {
    settleEntryJob(
      sheetId,
      filename,
      settledJobId,
      (d) => d.compositeSheets,
      (d, compositeSheets) => ({ ...d, compositeSheets }),
    );
  }, [settleEntryJob]);

  // A failed board render is reported the same way the variation and canon rows
  // report theirs — otherwise the spinner just vanishes and the user is left
  // guessing. A user-initiated cancel is not a failure, so it stays silent.
  const handleSheetJobFailed = useCallback((_sheetId, status) => {
    if (status === 'failed') toast.error('Render failed');
  }, []);

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
            saved={!!selectedId}
            onPersistStyleReference={persistStyleReference}
            onRemoveStyleReference={removeStyleReference}
            onAdoptStyleGuide={adoptStyleGuideFromBoard}
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
              onJobCompletedForEntry={handleEntryJobCompleted}
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
            onJobCompletedForEntry={handleEntryJobCompleted}
          />
        )}

        {activeTab === TAB_COMPOSITES && (
          <>
            <CompositeSheetsEditor
              sheets={draft.compositeSheets || []}
              onChange={updateCompositeSheets}
              canRender={canRender}
              onRender={(sheet) => runRender({ promptMode: 'sheets', sheetSelection: [sheet.label] })}
              onPreview={openPreviewByFilename}
              pendingByEntryId={pendingHeadByEntryId}
              onJobSettled={handleSheetJobSettled}
              onJobFailed={handleSheetJobFailed}
            />
            {/* Add-bucket row stays available here for power users who want to
                introduce a brand-new custom bucket without going through
                expand. New buckets default to kind='other' so they land under
                the Other tab. */}
            <section className="bg-port-card border border-port-border rounded p-3 flex items-center gap-2 flex-wrap">
              <label htmlFor="universe-add-sub-bucket" className="text-xs text-gray-400 mr-1">Add a custom sub-bucket (lands under Other):</label>
              <input
                id="universe-add-sub-bucket"
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
            setRenderPin={setRenderPin}
            selectedId={selectedId}
            bucketsByKind={bucketsByKind}
            renderOpts={renderOpts}
            setRenderOpts={setRenderOpts}
            availableBackends={availableBackends}
            defaultMode={effectiveDefaultMode}
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
