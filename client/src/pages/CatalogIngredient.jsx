/**
 * CatalogIngredient — detail/editor for a single catalog ingredient. Loaded
 * via /catalog/:type/:id (one untabbed scroll) or a library route
 * (/casting/:id/:tab?, /environments/…, /objects/…) where the library's
 * `detailTabs` split it into Profile / Sheets / Looks|Plates / References|Images.
 * The tab lives in the URL; form state lives here so switching tabs keeps an
 * unsaved draft. Full-width page; owns its scroll. The editor's state hooks and
 * panels live in components/catalog/ingredient/.
 */

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router';
import { Image as ImageIcon, UserRound, LayoutGrid, Images, Clapperboard, Shirt, Box, Wand2, Aperture, Map as MapIcon } from 'lucide-react';
import toast from '../components/ui/Toast';
import UnsavedChangesConfirm from '../components/ui/UnsavedChangesConfirm.jsx';
import PageSkeleton from '../components/ui/PageSkeleton';
import TabPills from '../components/ui/TabPills';
import { CatalogImagePreviewProvider } from '../components/catalog/CatalogImagePreviewProvider';
import CatalogLockButton from '../components/catalog/CatalogLockButton';
import CatalogRedesign, { CatalogRedesignButton } from '../components/catalog/CatalogRedesign';
import CatalogUniversePanel from '../components/catalog/CatalogUniversePanel';
import CatalogMergePanel from '../components/catalog/CatalogMergePanel';
import CatalogIdentityPanel from '../components/catalog/CatalogIdentityPanel';
import CatalogIdentityNotice from '../components/catalog/CatalogIdentityNotice';
import IngredientHeader from '../components/catalog/ingredient/IngredientHeader';
import IngredientProfileTab from '../components/catalog/ingredient/IngredientProfileTab';
import { lazyWithReload } from '../utils/lazyWithReload';
const IngredientMediaTabs = lazyWithReload(() => import('../components/catalog/ingredient/IngredientMediaTabs'));
import RevisionsPanel from '../components/catalog/ingredient/RevisionsPanel';
import useIngredientEditor from '../components/catalog/ingredient/useIngredientEditor';
import useIngredientMediaActions from '../components/catalog/ingredient/useIngredientMediaActions';
import useIngredientSavedPatches from '../components/catalog/ingredient/useIngredientSavedPatches';
import useOwnerUniverse from '../components/catalog/ingredient/useOwnerUniverse';
import { mediaRowView, forkSeedOf, ingredientCoverOf } from '../components/catalog/ingredient/ingredientMediaView';
import { FORM_TYPES } from '../components/catalog/ingredient/ingredientDraft';
import { getCatalogType } from '../lib/catalogTypes';
import { libraryForPathname, resolveDetailTab, detailTabPath } from '../lib/creativeLibraries';
import { buildGenerationPromptSeed } from '../lib/catalogImagePrompt';
import { useCatalogTypes } from '../hooks/useCatalogTypes.jsx';

const DETAIL_TAB_ICONS = {
  profile: UserRound,
  design: Wand2,
  sheets: LayoutGrid,
  looks: Shirt,
  plates: Clapperboard,
  greybox: Box,
  photoreal: Aperture,
  world: MapIcon,
  references: Images,
  images: ImageIcon,
};

export default function CatalogIngredient() {
  const { id } = useParams();
  // One owner per ingredient visit: late mutations and child-local drafts must
  // never migrate to another record. Tabs keep the same owner and unsaved form.
  return <IngredientEditor key={id} />;
}

function IngredientEditor() {
  const { id, tab: tabParam } = useParams();
  const navigate = useNavigate();
  // Opened from Casting / Environments / Objects → Back and post-delete return
  // there; otherwise to the catalog.
  const { pathname, search } = useLocation();
  const library = libraryForPathname(pathname);
  const requestedBack = new URLSearchParams(search).get('returnTo') || '';
  // A music video's Cast & Sets links here to revise a look and comes back to its stage.
  const backToVideo = /^\/music-video\/[^/?#]+(?:\/[^/?#]+)?(?:\?|#|$)/.test(requestedBack);
  const backPath = backToVideo || /^\/(?:casting(?:\?|$)|universes\/[^/?#]+(?:\?|$))/.test(requestedBack) ? requestedBack : library?.path || '/catalog';
  const profileActive = !library || resolveDetailTab(library, tabParam) === 'profile';
  const [profileVisited, setProfileVisited] = useState(profileActive);
  useEffect(() => { if (profileActive) setProfileVisited(true); }, [profileActive]);
  // Merged type registry (system + user-defined). Falls back synchronously to
  // the static built-ins so the editor renders before the fetch resolves.
  const { getType: getMergedType } = useCatalogTypes();
  const editor = useIngredientEditor({ id, tabParam, library, backPath, navigate });
  const {
    record, draft, identityReadOnly, identityReason, isDirty, saving, lookSaving, unlocking, characterActionBusy,
    externalDetails, media, mediaReady, mediaError, refreshMedia, reloadDetails,
  } = editor;
  const { name, tags, payload } = draft;
  const owner = useOwnerUniverse(record);
  const actions = useIngredientMediaActions({ id, record, identityReadOnly, media, setMedia: editor.setMedia, refreshMedia });
  const saved = useIngredientSavedPatches(id, editor);
  // A redesign-assistant proposal waiting to be saved onto a new fork.
  const [redesignFork, setRedesignFork] = useState(null);
  const [redesignSession, setRedesignSession] = useState(null);
  const redesignOpen = redesignSession?.id === id ? redesignSession.open : null;
  const discardAndExit = useCallback(() => {
    // The parked route is leaving, so unmounting discards the local draft. Do
    // not clear isDirty before proceeding: the shared guard auto-proceeds when
    // a parked draft settles, which would race this explicit proceed call.
    editor.routeGuard.proceed();
  }, [editor.routeGuard]);

  if (editor.loading || !record) {
    return (
      <PageSkeleton
        header="none"
        label="Loading ingredient"
        padded
        fullHeight
        cards={3}
        sidebar={false}
      />
    );
  }

  // Resolve from the merged registry (system + user types) so a user-typed
  // ingredient picks up its declared fields; fall back to the static 'idea'
  // editor for an unknown/orphaned type.
  const typeDef = getMergedType(record.type) || getCatalogType(record.type) || getCatalogType('idea');
  const fields = typeDef.editorFields || getCatalogType('idea').editorFields;
  // Prompt source for the Media panel's "Generate" affordance — derived from the
  // currently-edited payload + the live `tags` state (NOT record.tags) so unsaved
  // tweaks to the description or tags feed the next render's default prompt. The
  // user can still edit the composed prompt before generating (#1809).
  const genDescription = buildGenerationPromptSeed(payload, typeDef, tags);

  // Ownership, rather than usage-list order, supplies the style context.
  const universeRef = record.universeContext?.owner || null;

  // Library routes split the page into the library's tabs; the plain
  // /catalog/:type/:id route (and a record opened under the wrong library)
  // keeps the single untabbed scroll, which renders as the 'profile' tab plus
  // its media panel.
  const tabs = library && library.type === record.type
    ? library.detailTabs.map((t) => ({ ...t, icon: DETAIL_TAB_ICONS[t.id] }))
    : null;
  const activeTab = tabs ? resolveDetailTab(library, tabParam) : 'profile';
  const rows = mediaRowView(record, media, identityReadOnly);
  const forkSeed = forkSeedOf(record, media, rows.isReferenceTabRow, { ready: mediaReady, error: mediaError, load: refreshMedia });
  const coverUrl = ingredientCoverOf(record, media, mediaReady, payload);
  const renderBlockedReason = (subject) => identityReason || (record.payload?.locked === true
    ? 'Unlock this record above before rendering.'
    : saving || lookSaving || characterActionBusy || unlocking
    ? `Saving — the ${subject} renders from the saved record.`
    : isDirty ? `Save your profile edits first — the ${subject} renders from the saved record.` : null);
  const gates = {
    readOnly: identityReadOnly, isDirty, saving, unlocking, lookSaving, externalDetails: !!externalDetails,
    characterActionBusy, setCharacterActionBusy: editor.setCharacterActionBusy,
    setUnlocking: editor.setUnlocking, setGreyboxBusy: editor.setGreyboxBusy,
  };
  const busyReason = saving || lookSaving || unlocking ? 'Wait for the current save to finish.' : null;

  return (
    <CatalogImagePreviewProvider
      key={record.id}
      ingredientId={record.id}
      onQuickEditQueued={actions.quickEditQueued}
      onVariantSaved={actions.variantSaved}
    >
    <fieldset disabled={editor.mergeBusy} className="flex h-full min-h-0 min-w-0 flex-col">
      <UnsavedChangesConfirm
        guard={editor.routeGuard}
        when={!saving}
        question="Discard your unsaved changes to this ingredient?"
        label={`Discard unsaved changes to ${record.name || 'this ingredient'}`}
        onDiscard={discardAndExit}
      />
      {/* The page renders its own h1 so the routed-heading convention sees it. */}
      <IngredientHeader record={record} name={name} backPath={backPath}
        heading={<h1 className="min-w-0 truncate text-lg sm:text-xl font-bold text-white leading-tight" title={record.name || '(untitled)'}>
          {record.name || '(untitled)'}
        </h1>}
        backLabel={backToVideo ? 'music video' : library?.label || 'Catalog'}
        isDirty={isDirty} overlongVideoDescription={editor.overlongVideoDescription} saving={saving}
        saveDisabled={saving || lookSaving || editor.greyboxBusy || unlocking || characterActionBusy || editor.mergeBusy || identityReadOnly || !!externalDetails || !!editor.overlongVideoDescription}
        onSave={editor.handleSave} readOnly={identityReadOnly} onDelete={editor.handleDelete}>
        <CatalogRedesignButton type={record.type} open={redesignOpen} controls="catalog-redesign"
          onToggle={() => setRedesignSession({ id, open: !redesignOpen })} />
        <CatalogUniversePanel key={`universe-${record.id}`} ingredient={record} context={record.universeContext}
          onContextChange={editor.applyUniverseContext} readOnly={identityReadOnly} forkBlocked={record.sharedIdentity?.reason === 'CATALOG_IDENTITY_FENCED'} unsaved={isDirty || saving || lookSaving}
          seed={forkSeed} redesign={redesignFork ? { fields: redesignFork, clear: () => setRedesignFork(null) } : null} />
        {FORM_TYPES.has(record.type) && <CatalogLockButton key={record.id} record={record}
          disabled={saving || lookSaving || unlocking || characterActionBusy || editor.mergeBusy} onPendingChange={editor.setUnlocking} onChanged={editor.applyLock} />}
      </IngredientHeader>

      {tabs && (
        <TabPills
          tabs={tabs}
          activeTab={activeTab}
          onChange={(tabId) => navigate(`${detailTabPath(library, record.id, tabId)}${search}`)}
          ariaLabel={`${library.label} record sections`}
          className="w-full min-w-0 shrink-0"
        />
      )}

      <div className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6">
      <div className="w-full min-w-0 space-y-5">
        <CatalogIdentityNotice identity={record.sharedIdentity} type={record.type} />
        {externalDetails && <div role="status" className="rounded border border-port-warning/40 bg-port-warning/10 p-3 text-sm text-gray-300">
          This primitive changed in another view. Your draft is preserved; inspect the latest version before saving.
          <button type="button" onClick={editor.loadLatest}
            className="ml-2 text-port-accent hover:underline">Discard local edits and load latest</button>
        </div>}
        <CatalogRedesign key={`redesign-${record.id}`} id="catalog-redesign" open={redesignOpen} ingredient={record} payload={payload}
          disabled={identityReadOnly || payload.locked === true || saving || lookSaving || characterActionBusy || !!externalDetails}
          onApply={draft.patchPayload} onFork={setRedesignFork} />

        {profileVisited && (
          <IngredientProfileTab hidden={activeTab !== 'profile'} record={record} draft={draft} owner={owner} gates={gates}
            typeDef={typeDef} coverUrl={coverUrl} videoDescriptionLimit={editor.videoDescriptionLimit}
            relations={editor.relations} onAddRelation={editor.handleAddRelation} onRemoveRelation={editor.handleRemoveRelation}
            onGenerated={actions.generated} showReferenceSheet={!tabs}
            onCanonChanged={() => reloadDetails().catch(error => toast.error(error.message || 'Could not refresh the character.'))} />
        )}

        {(!tabs || activeTab !== 'profile') && (
          <Suspense fallback={<PageSkeleton header="none" label="Loading media" cards={2} sidebar={false} />}>
            <IngredientMediaTabs record={record} draft={draft} activeTab={activeTab} hasTabs={!!tabs}
              generateProfilePath={record.type === 'character' && tabs ? `${detailTabPath(library, record.id, 'profile')}${search}` : null}
              mediaState={{ media, setMedia: editor.setMedia, missingMedia: editor.missingMedia, ready: mediaReady, loading: editor.mediaLoading, error: mediaError, refresh: refreshMedia }}
              actions={actions} saved={saved} gates={gates} rows={rows} renderBlockedReason={renderBlockedReason}
              canonRemoval={universeRef && FORM_TYPES.has(record.type) ? {
                recordId: record.id, universeId: universeRef.refId, kind: record.type,
                disabled: identityReadOnly || saving || isDirty || lookSaving || unlocking,
                onRemoved: () => { reloadDetails({ withMedia: true }).catch(error => toast.error(error.message)); },
              } : null}
              genDescription={genDescription} onUnlocked={editor.applyLock} />
          </Suspense>
        )}

        {activeTab === 'profile' && (
          <CatalogMergePanel record={record}
            disabledReason={identityReason || busyReason || (isDirty ? 'Save or discard profile edits before consolidating.' : null)}
            onPendingChange={editor.setMergeBusy} onChanged={editor.reloadAfterMerge} />
        )}

        {activeTab === 'profile' && <CatalogIdentityPanel record={record}
          disabledReason={busyReason || (isDirty ? 'Save or discard profile edits before managing identity.' : null)}
          onPendingChange={editor.setMergeBusy} onChanged={editor.reloadAfterMerge} />}

        {activeTab === 'profile' && (
          <RevisionsPanel
            readOnly={identityReadOnly}
            retainedSourceId={record.sharedIdentity?.sourceId}
            revisions={editor.revisions} loading={editor.revisionsLoading} error={editor.revisionsError} onLoad={() => editor.refreshRevisions(true)}
            current={record}
            fields={fields}
            onRestore={editor.handleRestore}
          />
        )}
      </div>
      </div>
    </fieldset>
    </CatalogImagePreviewProvider>
  );
}
