import { useMemo, useState } from 'react';
import { Folder, FolderPlus, FilePlus, FileText, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import toast from '../ui/Toast';
import {
  createWritersRoomFolder,
  deleteWritersRoomFolder,
  createWritersRoomWork,
  deleteWritersRoomWork,
} from '../../services/apiWritersRoom';

const KIND_LABELS = {
  novel: 'Novel',
  'short-story': 'Short Story',
  screenplay: 'Screenplay',
  essay: 'Essay',
  treatment: 'Treatment',
  other: 'Other',
};

export default function LibraryPane({ folders, works, activeWorkId, onSelectWork, onRefresh }) {
  const [openFolders, setOpenFolders] = useState({});
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creatingWork, setCreatingWork] = useState(null); // folderId or 'unfiled'
  const [workTitle, setWorkTitle] = useState('');
  const [workKind, setWorkKind] = useState('short-story');
  // Two-click confirm: first click arms the button, second deletes.
  // Cleared automatically after 4s to avoid leaving a pending arm.
  const [armedDelete, setArmedDelete] = useState(null);

  const grouped = useMemo(() => {
    const byFolder = new Map();
    byFolder.set(null, []);
    folders.forEach((f) => byFolder.set(f.id, []));
    works.forEach((w) => {
      const key = w.folderId && byFolder.has(w.folderId) ? w.folderId : null;
      byFolder.get(key).push(w);
    });
    for (const arr of byFolder.values()) {
      arr.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }
    return byFolder;
  }, [folders, works]);

  const toggleFolder = (id) => setOpenFolders((s) => ({ ...s, [id]: !s[id] }));

  const submitFolder = async (e) => {
    e.preventDefault();
    if (!folderName.trim()) return;
    const folder = await createWritersRoomFolder({ name: folderName.trim() }).catch((err) => {
      toast.error(`Failed to create folder: ${err.message}`);
      return null;
    });
    if (!folder) return;
    setFolderName('');
    setCreatingFolder(false);
    setOpenFolders((s) => ({ ...s, [folder.id]: true }));
    onRefresh?.();
  };

  const submitWork = async (e) => {
    e.preventDefault();
    if (!workTitle.trim()) return;
    const folderId = creatingWork === 'unfiled' ? null : creatingWork;
    const work = await createWritersRoomWork({ title: workTitle.trim(), kind: workKind, folderId }).catch((err) => {
      toast.error(`Failed to create work: ${err.message}`);
      return null;
    });
    if (!work) return;
    setWorkTitle('');
    setWorkKind('short-story');
    setCreatingWork(null);
    onRefresh?.();
    onSelectWork?.(work.id);
  };

  const armDelete = (key) => {
    setArmedDelete(key);
    setTimeout(() => setArmedDelete((current) => (current === key ? null : current)), 4000);
  };

  const handleDeleteFolder = async (id) => {
    if (armedDelete !== `folder:${id}`) {
      armDelete(`folder:${id}`);
      return;
    }
    setArmedDelete(null);
    await deleteWritersRoomFolder(id).catch((err) => toast.error(`Delete failed: ${err.message}`));
    onRefresh?.();
  };

  const handleDeleteWork = async (id, title) => {
    if (armedDelete !== `work:${id}`) {
      armDelete(`work:${id}`);
      toast(`Click again to delete "${title}"`);
      return;
    }
    setArmedDelete(null);
    await deleteWritersRoomWork(id).catch((err) => toast.error(`Delete failed: ${err.message}`));
    if (activeWorkId === id) onSelectWork?.(null);
    onRefresh?.();
  };

  const renderWorkRow = (work) => {
    const isActive = work.id === activeWorkId;
    return (
      <li key={work.id} className="group">
        <button
          onClick={() => onSelectWork?.(work.id)}
          className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm transition-colors ${
            isActive ? 'bg-port-accent/20 text-port-accent' : 'text-gray-300 hover:bg-port-card hover:text-white'
          }`}
        >
          <FileText size={14} aria-hidden="true" className="shrink-0" />
          <span className="truncate flex-1">{work.title}</span>
          <span className="text-[10px] text-gray-500 uppercase">{work.wordCount} w</span>
        </button>
        <button
          onClick={() => handleDeleteWork(work.id, work.title)}
          className={`hidden group-hover:flex absolute right-1 top-1.5 p-0.5 ${
            armedDelete === `work:${work.id}` ? 'text-port-error' : 'text-gray-500 hover:text-port-error'
          }`}
          aria-label={`Delete ${work.title}`}
          title={armedDelete === `work:${work.id}` ? 'Click again to confirm' : 'Delete'}
        >
          <Trash2 size={12} />
        </button>
      </li>
    );
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-xs uppercase text-gray-400 tracking-wider">Library</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setCreatingFolder(true); setCreatingWork(null); }}
            className="p-1 text-gray-400 hover:text-port-accent"
            title="New folder"
            aria-label="New folder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={() => { setCreatingWork('unfiled'); setCreatingFolder(false); }}
            className="p-1 text-gray-400 hover:text-port-accent"
            title="New work"
            aria-label="New work"
          >
            <FilePlus size={14} />
          </button>
        </div>
      </div>

      {creatingFolder && (
        <form onSubmit={submitFolder} className="flex items-center gap-1">
          <input
            autoFocus
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder="Folder name"
            className="flex-1 bg-port-card border border-port-border rounded px-2 py-1 text-xs"
          />
          <button type="submit" className="text-xs px-2 py-1 bg-port-accent text-white rounded">Add</button>
          <button type="button" onClick={() => { setCreatingFolder(false); setFolderName(''); }}
            className="text-xs px-2 py-1 text-gray-400">Cancel</button>
        </form>
      )}

      {creatingWork && (
        <form onSubmit={submitWork} className="space-y-1 bg-port-card border border-port-border rounded p-2">
          <input
            autoFocus
            value={workTitle}
            onChange={(e) => setWorkTitle(e.target.value)}
            placeholder="Title"
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs"
          />
          <select
            value={workKind}
            onChange={(e) => setWorkKind(e.target.value)}
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs"
          >
            {Object.entries(KIND_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <div className="flex items-center gap-1">
            <button type="submit" className="text-xs px-2 py-1 bg-port-accent text-white rounded flex-1">Create</button>
            <button type="button" onClick={() => setCreatingWork(null)} className="text-xs px-2 py-1 text-gray-400">Cancel</button>
          </div>
        </form>
      )}

      <ul className="space-y-1">
        {folders.length === 0 && grouped.get(null).length === 0 && !creatingFolder && !creatingWork && (
          <li className="text-xs text-gray-500 px-2 py-3 text-center">
            No works yet. Click <FilePlus size={12} className="inline" /> to start.
          </li>
        )}

        {/* Unfiled works */}
        {grouped.get(null).length > 0 && (
          <li>
            <div className="text-[10px] uppercase text-gray-500 px-2 py-1">Unfiled</div>
            <ul className="space-y-0.5 pl-1 relative">{grouped.get(null).map(renderWorkRow)}</ul>
          </li>
        )}

        {folders.map((folder) => {
          const isOpen = openFolders[folder.id];
          const folderWorks = grouped.get(folder.id) || [];
          return (
            <li key={folder.id} className="group/folder">
              <div className="flex items-center gap-1">
                <button
                  onClick={() => toggleFolder(folder.id)}
                  className="flex-1 flex items-center gap-1 px-2 py-1 text-gray-300 hover:text-white text-sm"
                >
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Folder size={14} className="text-gray-400" />
                  <span className="flex-1 text-left truncate">{folder.name}</span>
                  <span className="text-[10px] text-gray-500">{folderWorks.length}</span>
                </button>
                <button
                  onClick={() => { setCreatingWork(folder.id); setCreatingFolder(false); }}
                  className="hidden group-hover/folder:flex p-1 text-gray-500 hover:text-port-accent"
                  aria-label="Add work to folder"
                  title="New work in folder"
                >
                  <FilePlus size={12} />
                </button>
                <button
                  onClick={() => handleDeleteFolder(folder.id)}
                  className={`hidden group-hover/folder:flex p-1 ${
                    armedDelete === `folder:${folder.id}` ? 'text-port-error' : 'text-gray-500 hover:text-port-error'
                  }`}
                  aria-label="Delete folder"
                  title={armedDelete === `folder:${folder.id}` ? 'Click again to confirm' : 'Delete folder'}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {isOpen && (
                <ul className="space-y-0.5 pl-5 relative">
                  {folderWorks.length === 0 && (
                    <li className="text-xs text-gray-500 px-2 py-1">Empty</li>
                  )}
                  {folderWorks.map(renderWorkRow)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
