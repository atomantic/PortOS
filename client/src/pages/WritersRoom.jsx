import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { NotebookPen, Timer } from 'lucide-react';
import LibraryPane from '../components/writers-room/LibraryPane';
import WorkEditor from '../components/writers-room/WorkEditor';
import ExercisePanel from '../components/writers-room/ExercisePanel';
import toast from '../components/ui/Toast';
import {
  listWritersRoomFolders,
  listWritersRoomWorks,
  getWritersRoomWork,
} from '../services/apiWritersRoom';

export default function WritersRoom() {
  const { workId } = useParams();
  const navigate = useNavigate();
  const [folders, setFolders] = useState([]);
  const [works, setWorks] = useState([]);
  const [activeWork, setActiveWork] = useState(null);
  const [loadingWork, setLoadingWork] = useState(false);
  const [showExercise, setShowExercise] = useState(false);

  // Skip setState when an in-flight library or work fetch resolves after the
  // page unmounts (rapid nav across pages).
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

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
    navigate(`/writers-room/works/${id}`);
  };

  const handleWorkChange = async (updated, opts = {}) => {
    let next = updated;
    if (opts.reload) {
      const fresh = await getWritersRoomWork(updated.id).catch(() => null);
      if (!mountedRef.current) return;
      if (!fresh) {
        // Reload failed — `updated` came from setWritersRoomActiveDraft and
        // lacks activeDraftBody, so setActiveWork(updated) would blank the
        // editor. Skip the swap; the previous activeWork (and its body) stay
        // visible and the user can retry the version-switch click.
        toast.error('Could not load that draft version');
        return;
      }
      next = fresh;
    }
    setActiveWork(next);
    // Splice the updated row into the library list (title / status / word
    // count) without refetching N manifests on every save.
    setWorks((prev) => {
      const activeDraft = (next.drafts || []).find((d) => d.id === next.activeDraftVersionId);
      const summary = {
        id: next.id,
        folderId: next.folderId,
        title: next.title,
        kind: next.kind,
        status: next.status,
        activeDraftVersionId: next.activeDraftVersionId,
        wordCount: activeDraft?.wordCount ?? 0,
        draftCount: (next.drafts || []).length,
        createdAt: next.createdAt,
        updatedAt: next.updatedAt,
      };
      const idx = prev.findIndex((w) => w.id === next.id);
      const merged = idx < 0 ? summary : { ...prev[idx], ...summary };
      const others = idx < 0 ? prev : [...prev.slice(0, idx), ...prev.slice(idx + 1)];
      // Library is sorted by updatedAt desc — re-sort after the merge so a
      // freshly-saved work surfaces at the top instead of staying mid-list.
      return [merged, ...others].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-port-border bg-port-card">
        <NotebookPen className="w-5 h-5 text-port-accent" />
        <h1 className="text-xl font-bold text-white">Writers Room</h1>
        <span className="text-xs text-gray-500 hidden md:inline">Folders, works, drafts, and write-for-10 sprints</span>
        <button
          onClick={() => setShowExercise((s) => !s)}
          className={`ml-auto flex items-center gap-1 px-3 py-1 text-xs rounded ${
            showExercise ? 'bg-port-accent text-white' : 'bg-port-bg border border-port-border text-gray-300 hover:text-white'
          }`}
          aria-pressed={showExercise}
          aria-label="Toggle write-for-10 exercise sidebar"
          title="Toggle exercise sidebar"
        >
          <Timer size={12} /> Write for 10
        </button>
      </div>

      <div className="flex-1 grid grid-cols-1 md:grid-cols-[260px_1fr] lg:grid-cols-[260px_1fr_320px] min-h-0">
        <aside className="border-b md:border-b-0 md:border-r border-port-border bg-port-card/40 px-3 py-3 overflow-y-auto max-h-64 md:max-h-none">
          <LibraryPane
            folders={folders}
            works={works}
            activeWorkId={activeWork?.id}
            onSelectWork={selectWork}
            onRefresh={refreshLibrary}
          />
        </aside>

        <main className="min-h-0 flex flex-col">
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
            <WorkEditor work={activeWork} onChange={handleWorkChange} />
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
