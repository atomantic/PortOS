import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { NotebookPen, PanelLeftOpen, BookOpen, ChevronUp, ChevronDown } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import LibraryPane from '../components/writers-room/LibraryPane';
import WorkEditor from '../components/writers-room/WorkEditor';
import ExercisePanel from '../components/writers-room/ExercisePanel';
import CatalogCastPanel from '../components/CatalogCastPanel';
import EmptyState from '../components/EmptyState';
import {
  listWritersRoomFolders,
  listWritersRoomWorks,
  getWritersRoomWork,
} from '../services/apiWritersRoom';
import { useLocalStorageBool } from '../hooks/useLocalStorageBool';
import { usePagedCollection } from '../hooks/usePagedCollection';
import useListResource from '../hooks/useListResource';
import useMounted from '../hooks/useMounted';
import ListLoadError from '../components/ui/ListLoadError';
import LoadFailedState from '../components/ui/LoadFailedState';

const LIBRARY_COLLAPSED_KEY = 'wr.libraryCollapsed';

export default function WritersRoom() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const fetchFolders = useCallback(() => listWritersRoomFolders({ silent: true }), []);
  const foldersResource = useListResource(fetchFolders);
  const { items: folders, setItems: setFolders } = foldersResource;
  const fetchWorks = useCallback(({ cursor, signal }) =>
    listWritersRoomWorks({ limit: 50, cursor }, { signal, silent: true }), []);
  const worksPage = usePagedCollection(fetchWorks);
  const { items: works, setItems: setWorks, reload: reloadWorks } = worksPage;
  const [activeWork, setActiveWork] = useState(null);
  const [creatingWork, setCreatingWork] = useState(null);
  const [loadingWork, setLoadingWork] = useState(false);
  const [workError, setWorkError] = useState(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [showExercise, setShowExercise] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [draftMutation, setDraftMutation] = useState(null);
  const draftMutationRef = useRef(null);
  const activeWorkRef = useRef(activeWork);
  activeWorkRef.current = activeWork;
  const editorDirtyRef = useRef(editorDirty);
  const handleEditorDirty = useCallback((dirty) => {
    editorDirtyRef.current = dirty;
    setEditorDirty(dirty);
  }, []);
  const [headerCollapsed, , toggleHeader] = useLocalStorageBool('wr.headerCollapsed', false);
  // Opening a work collapses the library on mobile and desktop. Header
  // controls have their own persisted disclosure for focused writing.
  const [libraryCollapsed, setLibraryCollapsed] = useLocalStorageBool(LIBRARY_COLLAPSED_KEY, false);
  const toggleLibrary = useCallback(() => {
    setLibraryCollapsed((prev) => !prev);
  }, [setLibraryCollapsed]);

  // Skip setState when an in-flight library or work fetch resolves after the
  // page unmounts (rapid nav across pages).
  const mountedRef = useMounted();

  // The editor and its exercise sibling both write the active draft. Admission
  // is synchronous; the state mirror only renders the pending controls. Keep
  // ownership here so dismissing the exercise panel cannot release its write.
  const beginDraftMutation = useCallback((ownerKey, kind) => {
    const current = activeWorkRef.current;
    if (draftMutationRef.current || !current || `${current.id}:${current.activeDraftVersionId || ''}` !== ownerKey) return null;
    if (kind === 'exercise' && editorDirtyRef.current) return null;
    const transaction = { ownerKey, kind };
    draftMutationRef.current = transaction;
    setDraftMutation(transaction);
    return transaction;
  }, []);
  const endDraftMutation = useCallback((transaction) => {
    if (draftMutationRef.current !== transaction) return;
    draftMutationRef.current = null;
    if (mountedRef.current) setDraftMutation(null);
  }, [mountedRef]);

  const refreshLibrary = useCallback(() => foldersResource.retry(), [foldersResource.retry]);

  // Load the active work when the URL changes
  useEffect(() => {
    setWorkError(null);
    if (!workId) {
      setActiveWork(null);
      return;
    }
    let cancelled = false;
    setLoadingWork(true);
    getWritersRoomWork(workId, { silent: true })
      .then((work) => { if (!cancelled) setActiveWork(work); })
      .catch((err) => { if (!cancelled) { setActiveWork(null); setWorkError(err); } })
      .finally(() => { if (!cancelled) setLoadingWork(false); });
    return () => { cancelled = true; };
  }, [workId, retryNonce]);

  const selectWork = (id) => {
    if (!id) {
      navigate('/writers-room');
      return;
    }
    // Tapping a work auto-collapses the header + library so the editor gets the
    // full screen. The slim header's button re-expands when the user wants to
    // pick another work.
    setLibraryCollapsed(true);
    navigate(`/writers-room/works/${id}`);
  };

  // Whenever no work is open (initial load, after deselect, or after the active
  // work is deleted) show the library — never strand the user on a hidden
  // library with nothing to edit.
  useEffect(() => {
    if (!workId) setLibraryCollapsed(false);
  }, [workId, setLibraryCollapsed]);

  const handleWorkChange = (updated, patch) => {
    // Draft operations replace the owned record; metadata responses merge only
    // their canonical fields so an older manifest cannot restore saved prose.
    if (!mountedRef.current) return;
    const fields = patch?.fields && Object.fromEntries(patch.fields.map((field) => [field, updated[field]]));
    setActiveWork((current) => {
      if (current?.id !== updated.id) return current;
      if (patch?.ownerKey && `${current.id}:${current.activeDraftVersionId || ''}` !== patch.ownerKey) return current;
      return fields ? { ...current, ...fields } : updated;
    });
    // Splice the updated row into the library list (title / status / word
    // count) without refetching N manifests on every save.
    setWorks((prev) => {
      const activeDraft = (updated.drafts || []).find((d) => d.id === updated.activeDraftVersionId);
      const idx = prev.findIndex((w) => w.id === updated.id);
      const summary = (idx >= 0 && fields) || {
        id: updated.id,
        folderId: updated.folderId,
        title: updated.title,
        kind: updated.kind,
        status: updated.status,
        activeDraftVersionId: updated.activeDraftVersionId,
        wordCount: activeDraft?.wordCount ?? 0,
        draftCount: (updated.drafts || []).length,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      };
      const merged = idx < 0 ? summary : { ...prev[idx], ...summary };
      const others = idx < 0 ? prev : [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      // Library is sorted by updatedAt desc — re-sort after the merge so a
      // freshly-saved work surfaces at the top instead of staying mid-list.
      return [merged, ...others].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    });
  };

  // Inline gridTemplateColumns is a no-op while the container is `display: flex`
  // (mobile) and takes effect once `md:grid` flips display at the breakpoint.
  // Collapsed track is 0px (not a thin rail) — the slim header's "show library"
  // button stands in for the rail.
  const libraryTrack = libraryCollapsed ? '0px' : '260px';
  const exerciseSuffix = showExercise ? ' 320px' : '';
  const desktopGridCols = `${libraryTrack} minmax(0, 1fr)${exerciseSuffix}`;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={NotebookPen}
        title="Writers Room"
        actions={(
          <>
            {libraryCollapsed && (
              <button
                onClick={toggleLibrary}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 text-gray-400 hover:text-white transition-colors"
                title="Show library"
                aria-label="Show library"
              >
                <PanelLeftOpen size={16} />
              </button>
            )}
            <Link
              to="/writers-room/guide"
              className="min-h-[44px] min-w-[44px] flex items-center justify-center gap-1 text-xs text-gray-400 hover:text-port-accent transition-colors"
              title="Writing guide: length targets & craft rules"
              aria-label="Writing guide"
            >
              <BookOpen size={14} />
              <span className="hidden sm:inline">Guide</span>
            </Link>
            {activeWork && (
              <button
                type="button"
                onClick={() => {
                  if (!headerCollapsed) setLibraryCollapsed(true);
                  toggleHeader();
                }}
                aria-expanded={!headerCollapsed}
                aria-label={headerCollapsed ? 'Expand writing header' : 'Collapse writing header'}
                title={headerCollapsed ? 'Expand writing header' : 'Collapse writing header'}
                className="shrink-0 min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-white"
              >
                {headerCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
              </button>
            )}
          </>
        )}
      />

      <div
        className="flex-1 flex flex-col md:grid min-h-0 transition-[grid-template-columns] duration-200"
        style={{ gridTemplateColumns: desktopGridCols }}
      >
        {libraryCollapsed ? (
          <div className="hidden md:block overflow-hidden min-w-0" />
        ) : (
          <aside className="border-b md:border-b-0 md:border-r border-port-border bg-port-card/40 px-3 py-3 overflow-y-auto max-h-64 md:max-h-none">
            {foldersResource.state === 'error' ? (
              <ListLoadError what="folders" error={foldersResource.error} onRetry={foldersResource.retry} className="mb-3" />
            ) : null}
            <LibraryPane
              folders={folders}
              works={works}
              activeWorkId={activeWork?.id}
              onSelectWork={selectWork}
              onRefresh={(change) => {
                if (change?.work) {
                  const updated = change.work;
                  const draft = updated.drafts?.find(item => item.id === updated.activeDraftVersionId);
                  setWorks(prev => [{ ...updated, wordCount: draft?.wordCount ?? 0 }, ...prev.filter(item => item.id !== updated.id)]);
                } else if (change?.deletedWorkId) {
                  setWorks(prev => prev.filter(item => item.id !== change.deletedWorkId));
                } else if (change?.folder) {
                  setFolders(prev => [...prev, change.folder]);
                } else if (change?.deletedFolderId) {
                  refreshLibrary();
                  setWorks(prev => prev.map(item => item.folderId === change.deletedFolderId ? { ...item, folderId: null } : item));
                } else { refreshLibrary(); reloadWorks(); }
              }}
              paging={worksPage}
              onCollapse={toggleLibrary}
              creatingWork={creatingWork}
              onCreatingWorkChange={setCreatingWork}
            />
          </aside>
        )}

        <section aria-label="Work editor" className="min-h-0 flex flex-col flex-1">
          {loadingWork && <div className="p-6 text-sm text-gray-500">Loading work…</div>}
          {!loadingWork && !activeWork && workError && (
            <div role="status" className="flex-1 flex items-center justify-center p-8">
              {workError.status === 404 || workError.status === 400 ? (
                <EmptyState
                  icon={NotebookPen}
                  title="This work no longer exists"
                  message="The link may be stale or the work was deleted."
                  actionLabel="Back to library"
                  onAction={() => selectWork(null)}
                />
              ) : (
                <LoadFailedState
                  title="Couldn't open this work"
                  hint={workError.message}
                  onRetry={() => setRetryNonce((n) => n + 1)}
                />
              )}
            </div>
          )}
          {!loadingWork && !activeWork && !workError && !workId && (
            <div className="flex-1 flex items-center justify-center p-8">
              <EmptyState
                icon={NotebookPen}
                title="No work selected"
                message="Create a work or pick one from the library to start writing."
                actionLabel="New work"
                onAction={() => {
                  setLibraryCollapsed(false);
                  setCreatingWork('unfiled');
                }}
              />
            </div>
          )}
          {!loadingWork && activeWork && (
            <>
              <div className={headerCollapsed ? 'hidden' : 'px-3 pt-3'}>
                <CatalogCastPanel
                  refKind="work"
                  refId={activeWork.id}
                  refLabel={activeWork.title || 'this work'}
                />
              </div>
              <WorkEditor
                work={activeWork}
                headerCollapsed={headerCollapsed}
                onChange={handleWorkChange}
                onToggleExercise={() => setShowExercise((s) => !s)}
                exerciseOpen={showExercise}
                onDirtyChange={handleEditorDirty}
                draftMutation={draftMutation}
                beginDraftMutation={beginDraftMutation}
                endDraftMutation={endDraftMutation}
              />
            </>
          )}
        </section>

        {showExercise && (
          <aside className="border-t lg:border-t-0 lg:border-l border-port-border bg-port-card/30 p-3 min-h-0 lg:overflow-y-auto">
            <ExercisePanel
              activeWork={activeWork}
              editorDirty={editorDirty}
              draftMutation={draftMutation}
              beginDraftMutation={beginDraftMutation}
              endDraftMutation={endDraftMutation}
              onWorkChange={handleWorkChange}
              onClose={() => setShowExercise(false)}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
