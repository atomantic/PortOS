// The media-backed tabs of the catalog ingredient editor (Sheets, Design,
// Looks, Plates, Greybox, World, Photoreal, References/Images) plus the
// untabbed catalog route's media panel. Each panel renders once the media read
// has landed; renders stay blocked while the profile draft is unsaved.
//
// Grouped props: `mediaState` { media, setMedia, missingMedia, ready, loading,
// error, refresh }; `actions` from useIngredientMediaActions; `saved` from
// useIngredientSavedPatches; `rows` from mediaRowView; `gates` the page's
// busy/dirty flags and their setters.

import { Suspense } from 'react';
import BrailleSpinner from '../../BrailleSpinner';
import CatalogUnlockNotice from '../CatalogUnlockNotice';
import { isSheetMedia, isPlateMedia, lookIdOf } from '../../../lib/creativeLibraries';
import { listSheetPointers } from '../../../lib/sheetPointers';
import { formsOf } from '../../../lib/catalogForms';
import { lazyWithReload } from '../../../utils/lazyWithReload';

const CatalogSheetsPanel = lazyWithReload(() => import('../CatalogSheetsPanel'));
const CatalogPlatesPanel = lazyWithReload(() => import('../CatalogPlatesPanel'));
const LookAroundPanel = lazyWithReload(() => import('../LookAroundPanel'));
const GreyboxPanel = lazyWithReload(() => import('../GreyboxPanel'));
const WorldPanel = lazyWithReload(() => import('../WorldPanel'));
const PhotorealPanel = lazyWithReload(() => import('../PhotorealPanel'));
const CatalogLooksPanel = lazyWithReload(() => import('../CatalogLooksPanel'));
const CatalogDesignPanel = lazyWithReload(() => import('../CatalogDesignPanel'));
const CatalogRelatedImages = lazyWithReload(() => import('../CatalogRelatedImages'));
const MediaPanel = lazyWithReload(() => import('./MediaPanel'));

const MEDIA_FALLBACK = <BrailleSpinner text="Loading media panel" />;

export default function IngredientMediaTabs({ record, draft, activeTab, hasTabs, generateProfilePath, mediaState, actions, saved, gates, rows, renderBlockedReason, canonRemoval, genDescription, onUnlocked }) {
  const { name, payload } = draft;
  const { media, setMedia, missingMedia, ready: mediaReady, loading: mediaLoading, error: mediaError, refresh: refreshMedia } = mediaState;
  const { readOnly, saving, unlocking, lookSaving, characterActionBusy } = gates;
  const { protectMedia, isReferenceTabRow } = rows;
  const universeRef = record.universeContext?.owner || null;
  const mediaTab = hasTabs ? activeTab : 'references';
  return (
    <>
      <div hidden={activeTab !== 'sheets' && activeTab !== 'looks' && activeTab !== 'design'}>
        <CatalogUnlockNotice key={record.id} record={record} disabled={saving || lookSaving || unlocking || characterActionBusy || readOnly} onPendingChange={gates.setUnlocking}
          onUnlocked={onUnlocked} />
      </div>

      {mediaTab !== 'profile' && (mediaError || !mediaReady) && <div role="status" className="text-sm text-gray-400">
        {mediaError || 'Loading media…'}{mediaError && <button type="button" onClick={refreshMedia} disabled={mediaLoading} className="ml-2 text-port-accent underline">Retry media</button>}
      </div>}
      <Suspense fallback={MEDIA_FALLBACK}>
      {activeTab === 'sheets' && mediaReady && (
        <CatalogSheetsPanel
          ingredientId={record.id}
          payload={payload}
          universeRef={universeRef}
          sheetMedia={media.filter(isSheetMedia).map(protectMedia)}
          missingMedia={missingMedia}
          onDetach={readOnly ? undefined : actions.detach}
          onSetPortrait={readOnly ? undefined : actions.setPortrait}
          portraitKey={media.find((m) => m.kind === 'portrait')?.mediaKey || null}
          blockedReason={renderBlockedReason('sheet')}
          savedStamp={record.updatedAt || null}
          onSheetFile={actions.sheetFile}
          onPointerSheetReady={saved.refreshSheetPointers}
          onRemovePointerSheet={readOnly ? undefined : saved.removePointerSheet}
          removingPointerSheet={saved.removingPointerSheet}
          onMediaChanged={readOnly ? undefined : refreshMedia}
        />
      )}

      {activeTab === 'design' && mediaReady && (
        <CatalogDesignPanel
          key={record.id}
          ingredientId={record.id}
          name={name}
          forms={formsOf(record.payload)}
          media={media.map(protectMedia)}
          blockedReason={renderBlockedReason('design round')}
          onChanged={refreshMedia}
          onSetPortrait={actions.setPortrait}
        />
      )}

      {activeTab === 'looks' && mediaReady && (
        <CatalogLooksPanel
          key={record.id}
          ingredientId={record.id}
          initialUniverseId={universeRef?.refId || ''}
          wardrobes={rows.wardrobes}
          lookMedia={media.filter((m) => rows.liveLookIds.has(lookIdOf(m))).map(protectMedia)}
          candidates={rows.lookCandidates.map(protectMedia)}
          missingMedia={missingMedia}
          editLocked={saving || unlocking || readOnly}
          blockedReason={renderBlockedReason('look')}
          savedStamp={record.updatedAt || null}
          onSaveWardrobes={saved.saveWardrobes}
          onSetRole={readOnly ? undefined : actions.setRole}
          onDetach={readOnly ? undefined : actions.detach}
          onLookFile={actions.lookFile}
        />
      )}

      {activeTab === 'plates' && mediaReady && (
        <CatalogPlatesPanel
          plates={media.filter(isPlateMedia).map(protectMedia)}
          candidates={media.filter((m) => m.kind === 'reference' && isReferenceTabRow(m)).map(protectMedia)}
          missingMedia={missingMedia}
          onSetRole={readOnly ? undefined : actions.setRole}
          onDetach={readOnly ? undefined : actions.detach}
        />
      )}

      {activeTab === 'plates' && mediaReady && record.type === 'place' && (
        <LookAroundPanel key={record.id} ingredientId={record.id} media={media} readOnly={readOnly} onSaved={refreshMedia} />
      )}

      {activeTab === 'greybox' && mediaReady && (
        <GreyboxPanel
          key={record.id}
          record={record}
          media={media}
          readOnly={readOnly}
          disabled={saving}
          onBusyChange={gates.setGreyboxBusy}
          onSaved={saved.greyboxSaved}
          onCaptured={refreshMedia}
        />
      )}

      {activeTab === 'world' && mediaReady && (
        <WorldPanel
          key={record.id}
          record={record}
          readOnly={readOnly}
          disabled={saving}
          onBusyChange={gates.setGreyboxBusy}
          onSaved={saved.greyboxSaved}
        />
      )}

      {activeTab === 'photoreal' && mediaReady && (
        <PhotorealPanel
          key={record.id}
          record={record}
          media={media}
          readOnly={readOnly}
          disabled={saving}
          onBusyChange={gates.setGreyboxBusy}
          onSaved={saved.greyboxSaved}
          onRendered={refreshMedia}
        />
      )}

      {mediaReady && (activeTab === 'profile' ? !hasTabs : activeTab === 'references' || activeTab === 'images') && (
        <MediaPanel
          readOnly={readOnly}
          referenceLibrary={record.type === 'character' ? { ingredientId: record.id, forms: formsOf(record.payload), media: media.map(protectMedia), onChanged: refreshMedia,
            revision: record.updatedAt, blockedReason: renderBlockedReason('reference'),
            pendingRenders: actions.pendingRenders,
            onPendingRenderComplete: actions.pendingComplete,
            onPendingRenderFailed: actions.pendingFailed,
            onMediaUpdated: updated => setMedia(previous => previous.map(row => {
              if (row.mediaKey !== updated.mediaKey || (row.ingredientId || record.id) !== (updated.ingredientId || record.id)) return row;
              if (row.kind === updated.kind) return updated;
              return ['bad', 'rejected'].includes(updated.library?.review?.status)
                ? { ...row, library: { ...(row.library || {}), guide: false } } : row;
            })) } : null}
          pendingRenders={actions.pendingRenders}
          onPendingRenderComplete={actions.pendingComplete}
          onPendingRenderFailed={actions.pendingFailed}
          media={(hasTabs ? media.filter(isReferenceTabRow) : media).map(protectMedia)}
          canonImageRefs={[payload.primaryImageRef, ...(Array.isArray(payload.imageRefs) ? payload.imageRefs : [])].filter((ref) =>
            !media.some((m) => (m.kind === 'portrait' || m.kind === 'reference') && m.mediaKey === ref))}
          primaryImageRef={payload.primaryImageRef}
          canonRemoval={canonRemoval}
          missingMedia={missingMedia}
          onAttach={actions.attach}
          onSetPortrait={actions.setPortrait}
          onDetach={readOnly ? undefined : actions.detach}
          onUploadFile={actions.upload}
          onRecordVoice={actions.recordVoice}
          hideGenerate={record.type === 'character'}
          generateProfilePath={generateProfilePath}
          genIngredientId={record.id}
          genName={name}
          genDescription={genDescription}
          genUniverseId={universeRef?.refId || null}
          onGenerated={actions.generated}
        />
      )}

      {mediaReady && (activeTab === 'references' || activeTab === 'images' || (!hasTabs && activeTab === 'profile')) && (
        <CatalogRelatedImages key={record.id} ingredientId={record.id} name={record.name}
          excludedFilenames={[
            payload.primaryImageRef,
            ...listSheetPointers(payload).map(({ filename }) => filename),
            ...(Array.isArray(payload.imageRefs) ? payload.imageRefs : []),
            ...media.filter((m) => m.kind === 'portrait' || m.kind === 'reference').map((m) => m.mediaKey),
          ]} />
      )}
      </Suspense>
    </>
  );
}
