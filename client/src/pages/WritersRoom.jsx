import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { NotebookPen, PanelLeftOpen, BookOpen } from 'lucide-react';
import LibraryPane from '../components/writers-room/LibraryPane';
import WorkEditor from '../components/writers-room/WorkEditor';
import ExercisePanel from '../components/writers-room/ExercisePanel';
import CatalogCastPanel from '../components/CatalogCastPanel';
import {
  listWritersRoomFolders,
  listWritersRoomWorks,
  getWritersRoomWork,
} from '../services/apiWritersRoom';
import { useLocalStorageBool } from '../hooks/useLocalStorageBool';

const LIBRARY_COLLAPSED_KEY = 'wr.libraryCollapsed';

export default function WritersRoom() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const [folders, setFolders] = useState([]);
  const [works, setWorks] = useState([]);
  const [activeWork, setActiveWork] = useState(null);
  const [loadingWork, setLoadingWork] = useState(false);
  const [showExercise, setShowExercise] = useState(false);
  // Header + library collapse state. Opening a work auto-collapses both (see
  // selectWork) so the editor gets maximum room — this now applies on mobile
  // too, where the library is an inline block stacked above the editor. The
  // full header shrinks to a slim bar that hosts the "show library" control.
  // Persisted so a manual collapse survives reloads.
  const [libraryCollapsed, setLibraryCollapsed] = useLocalStorageBool(LIBRARY_COLLAPSED_KEY, false);
  const toggleLibrary = useCallback(() => {
    setLibraryCollapsed((prev) => !prev);
  }, [setLibraryCollapsed]);

  // Skip setState when an in-flight library or work fetch resolves after the
  // page unmounts (rapid nav across pages). Reset on mount so React 18
  // StrictMode's mount→cleanup→remount cycle doesn't leave the ref stuck false.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refreshLibrary = useCallback(async () => {
    const [foldersList, worksList] = await Promise.all([
      listWritersRoomFolders().catch(() => []),
      listWritersRoomWorks().catch(() => []),
    ]);
    if (!mountedRef.current) return;
    setFolders(foldersList);
    setWorks(worksList);
  }, []);

  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  // Load the active work when the URL changes
  useEffect(() => {
    if (!workId) {
      setActiveWork(null);
      return;
    }
    let cancelled = false;
    setLoadingWork(true);
    getWritersRoomWork(workId)
      .then((work) => { if (!cancelled) setActiveWork(work); })
      .catch(() => { if (!cancelled) setActiveWork(null); })
      .finally(() => { if (!cancelled) setLoadingWork(false); });
    return () => { cancelled = true; };
  }, [workId]);

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

  const handleWorkChange = (updated) => {
    // Caller (WorkEditor) hands us the freshest manifest + activeDraftBody —
    // the server-side endpoints (PUT draft, POST snapshot, PATCH version,
    // PATCH work) all return the full shape now, so no separate reload is
    // required and there's no inconsistency window between server pointer
    // and client view.
    if (!mountedRef.current) return;
    setActiveWork(updated);
    // Splice the updated row into the library list (title / status / word
    // count) without refetching N manifests on every save.
    setWorks((prev) => {
      const activeDraft = (updated.drafts || []).find((d) => d.id === updated.activeDraftVersionId);
      const summary = {
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
      const idx = prev.findIndex((w) => w.id === updated.id);
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
      {libraryCollapsed ? (
        // Slim header while editing — frees vertical room and hosts the "show
        // library" control. This replaces the old desktop-only floating expand
        // button so it's reachable on mobile, where there's no side rail.
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-port-border bg-port-card">
          <button
            onClick={toggleLibrary}
            className="p-1 text-gray-400 hover:text-white transition-colors"
            title="Show library"
            aria-label="Show library"
          >
            <PanelLeftOpen size={16} />
          </button>
          <NotebookPen className="w-4 h-4 text-port-accent" />
          <span className="text-sm font-semibold text-white">Writers Room</span>
          <Link
            to="/writers-room/guide"
            className="ml-auto flex items-center gap-1 text-xs text-gray-400 hover:text-port-accent transition-colors"
            title="Writing guide: length targets & craft rules"
            aria-label="Writing guide"
          >
            <BookOpen size={14} />
            <span className="hidden sm:inline">Guide</span>
          </Link>
        </div>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3 border-b border-port-border bg-port-card">
          <NotebookPen className="w-5 h-5 text-port-accent" />
          <h1 className="text-xl font-bold text-white">Writers Room</h1>
          <span className="text-xs text-gray-500 hidden lg:inline">Folders, works, drafts, storyboard, and write-for-10 sprints</span>
          <Link
            to="/writers-room/guide"
            className="ml-auto flex items-center gap-1 text-xs text-gray-400 hover:text-port-accent transition-colors"
            title="Writing guide: length targets & craft rules"
          >
            <BookOpen size={15} />
            <span>Guide</span>
          </Link>
        </div>
      )}

      <div
        className="flex-1 flex flex-col md:grid min-h-0 transition-[grid-template-columns] duration-200"
        style={{ gridTemplateColumns: desktopGridCols }}
      >
        {libraryCollapsed ? (
          <div className="hidden md:block overflow-hidden min-w-0" />
        ) : (
          <aside className="border-b md:border-b-0 md:border-r border-port-border bg-port-card/40 px-3 py-3 overflow-y-auto max-h-64 md:max-h-none">
            <LibraryPane
              folders={folders}
              works={works}
              activeWorkId={activeWork?.id}
              onSelectWork={selectWork}
              onRefresh={refreshLibrary}
              onCollapse={toggleLibrary}
            />
          </aside>
        )}

        <main className="min-h-0 flex flex-col flex-1">
          {loadingWork && <div className="p-6 text-sm text-gray-500">Loading work…</div>}
          {!loadingWork && !activeWork && (
            <div className="flex-1 flex items-center justify-center text-center p-8">
              <div className="max-w-md space-y-2 text-gray-400">
                <NotebookPen className="w-10 h-10 mx-auto text-gray-600" />
                <h2 className="text-lg text-white">No work selected</h2>
                <p className="text-sm">Pick a work from the library to start editing, or create a new one. Use the Write for 10 panel for timed sprints.</p>
              </div>
            </div>
          )}
          {!loadingWork && activeWork && (
            <>
              <div className="px-3 pt-3">
                <CatalogCastPanel
                  refKind="work"
                  refId={activeWork.id}
                  refLabel={activeWork.title || 'this work'}
                />
              </div>
              <WorkEditor
                work={activeWork}
                onChange={handleWorkChange}
                onToggleExercise={() => setShowExercise((s) => !s)}
                exerciseOpen={showExercise}
              />
            </>
          )}
        </main>

        {showExercise && (
          <aside className="border-t lg:border-t-0 lg:border-l border-port-border bg-port-card/30 p-3 min-h-0 lg:overflow-y-auto">
            <ExercisePanel activeWork={activeWork} onClose={() => setShowExercise(false)} />
          </aside>
        )}
      </div>
    </div>
  );
}
