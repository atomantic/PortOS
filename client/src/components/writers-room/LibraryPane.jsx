import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FolderPlus, FilePlus, FileText, ChevronDown, ChevronRight, Trash2, GripVertical, PanelLeftClose } from 'lucide-react';
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors } from '@dnd-kit/core';
import toast from '../ui/Toast';
import {
  createWritersRoomFolder,
  deleteWritersRoomFolder,
  createWritersRoomWork,
  deleteWritersRoomWork,
  updateWritersRoomWork,
} from '../../services/apiWritersRoom';
import { KIND_LABELS } from './labels';

const UNFILED_DROP_ID = 'wr-unfiled';

export default function LibraryPane({ folders, works, activeWorkId, onSelectWork, onRefresh, onCollapse }) {
  const [openFolders, setOpenFolders] = useState({});
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [creatingWork, setCreatingWork] = useState(null); // folderId or 'unfiled'
  const [workTitle, setWorkTitle] = useState('');
  const [workKind, setWorkKind] = useState('short-story');
  // Two-click confirm: first click arms the button, second deletes.
  // Cleared automatically after 4s to avoid leaving a pending arm.
  const [armedDelete, setArmedDelete] = useState(null);
  const armTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(armTimerRef.current), []);

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
    clearTimeout(armTimerRef.current);
    armTimerRef.current = setTimeout(
      () => setArmedDelete((current) => (current === key ? null : current)),
      4000,
    );
  };

  const handleDeleteFolder = async (id, name) => {
    if (armedDelete !== `folder:${id}`) {
      armDelete(`folder:${id}`);
      toast(`Click again to delete folder "${name}"`);
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

  // PointerSensor with a small activation distance so a quick click still
  // selects the work — only an actual drag gesture starts a DnD operation.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [draggingWork, setDraggingWork] = useState(null);

  const handleDragStart = useCallback((event) => {
    setDraggingWork(event.active.data.current?.work || null);
  }, []);

  const handleDragEnd = useCallback(async (event) => {
    setDraggingWork(null);
    const { active, over } = event;
    if (!over || !active) return;
    const work = active.data.current?.work;
    if (!work) return;
    const targetFolderId = over.data.current?.folderId ?? null;
    if (work.folderId === targetFolderId) return;
    const updated = await updateWritersRoomWork(work.id, { folderId: targetFolderId }).catch((err) => {
      toast.error(`Move failed: ${err.message}`);
      return null;
    });
    if (!updated) return;
    const targetFolder = folders.find((f) => f.id === targetFolderId);
    toast.success(`Moved "${work.title}" to ${targetFolder ? targetFolder.name : 'Unfiled'}`);
    if (targetFolderId) setOpenFolders((s) => ({ ...s, [targetFolderId]: true }));
    onRefresh?.();
  }, [folders, onRefresh]);

  const renderWorkRow = (work) => (
    <WorkRow
      key={work.id}
      work={work}
      isActive={work.id === activeWorkId}
      armedDelete={armedDelete === `work:${work.id}`}
      onSelect={() => onSelectWork?.(work.id)}
      onDelete={() => handleDeleteWork(work.id, work.title)}
    />
  );

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
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="hidden md:inline-flex p-1 text-gray-400 hover:text-white"
              title="Hide library"
              aria-label="Hide library"
            >
              <PanelLeftClose size={14} />
            </button>
          )}
        </div>
      </div>

      {creatingFolder && (
        <form onSubmit={submitFolder} className="space-y-1 bg-port-card border border-port-border rounded p-2">
          <input
            autoFocus
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            placeholder="Folder name"
            className="w-full bg-port-bg border border-port-border rounded px-2 py-1 text-xs min-w-0"
          />
          <div className="flex items-center gap-1">
            <button type="submit" className="text-xs px-2 py-1 bg-port-accent text-white rounded flex-1">Add</button>
            <button type="button" onClick={() => { setCreatingFolder(false); setFolderName(''); }}
              className="text-xs px-2 py-1 text-gray-400">Cancel</button>
          </div>
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

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <ul className="space-y-1">
          {folders.length === 0 && grouped.get(null).length === 0 && !creatingFolder && !creatingWork && (
            <li className="text-xs text-gray-500 px-2 py-3 text-center">
              No works yet. Click <FilePlus size={12} className="inline" /> to start.
            </li>
          )}

          <UnfiledZone
            works={grouped.get(null)}
            renderWorkRow={renderWorkRow}
            showHeader={folders.length > 0 || grouped.get(null).length > 0}
            isDragging={!!draggingWork}
          />

          {folders.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              works={grouped.get(folder.id) || []}
              isOpen={!!openFolders[folder.id]}
              isDragging={!!draggingWork}
              armedDelete={armedDelete === `folder:${folder.id}`}
              onToggle={() => toggleFolder(folder.id)}
              onCreateWork={() => { setCreatingWork(folder.id); setCreatingFolder(false); }}
              onDelete={() => handleDeleteFolder(folder.id, folder.name)}
              renderWorkRow={renderWorkRow}
            />
          ))}
        </ul>

        <DragOverlay>
          {draggingWork && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-port-card border border-port-accent text-sm text-port-accent shadow-lg">
              <FileText size={14} aria-hidden="true" />
              <span className="truncate max-w-[200px]">{draggingWork.title}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// ---------- DnD-aware subcomponents ----------

function WorkRow({ work, isActive, armedDelete, onSelect, onDelete }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `work:${work.id}`,
    data: { work },
  });
  return (
    <li className={`group relative ${isDragging ? 'opacity-30' : ''}`}>
      <div className="flex items-stretch">
        <button
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          className="shrink-0 px-1 flex items-center cursor-grab active:cursor-grabbing touch-none text-gray-600 hover:text-gray-300"
          title="Drag to move into a folder"
          aria-label={`Drag ${work.title}`}
        >
          <GripVertical size={12} />
        </button>
        <button
          onClick={onSelect}
          className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-left text-sm transition-colors min-w-0 ${
            isActive ? 'bg-port-accent/20 text-port-accent' : 'text-gray-300 hover:bg-port-card hover:text-white'
          }`}
        >
          <FileText size={14} aria-hidden="true" className="shrink-0" />
          <span className="truncate flex-1">{work.title}</span>
          <span className="text-[10px] text-gray-500 uppercase">{work.wordCount} w</span>
        </button>
      </div>
      <button
        onClick={onDelete}
        className={`absolute right-1 top-1.5 p-0.5 transition-opacity ${
          armedDelete
            ? 'opacity-100 text-port-error'
            : 'opacity-40 sm:opacity-0 group-hover:opacity-100 focus:opacity-100 text-gray-500 hover:text-port-error'
        }`}
        aria-label={`Delete ${work.title}`}
        title={armedDelete ? 'Click again to confirm' : 'Delete'}
      >
        <Trash2 size={12} />
      </button>
    </li>
  );
}

function UnfiledZone({ works, renderWorkRow, showHeader, isDragging }) {
  const { setNodeRef, isOver } = useDroppable({ id: UNFILED_DROP_ID, data: { folderId: null } });
  const hasWorks = works.length > 0;
  // Always render the drop target while a drag is in flight so a user can
  // unfile a work even when the section is currently empty.
  if (!hasWorks && !isDragging) return null;
  return (
    <li
      ref={setNodeRef}
      className={`rounded transition-colors ${isOver ? 'bg-port-accent/10 ring-1 ring-port-accent' : ''}`}
    >
      {(showHeader || isDragging) && (
        <div className="text-[10px] uppercase text-gray-500 px-2 py-1">Unfiled</div>
      )}
      {hasWorks ? (
        <ul className="space-y-0.5 pl-1 relative">{works.map(renderWorkRow)}</ul>
      ) : (
        <div className="text-xs text-gray-600 italic px-2 py-1">Drop here to unfile</div>
      )}
    </li>
  );
}

function FolderRow({ folder, works, isOpen, isDragging, armedDelete, onToggle, onCreateWork, onDelete, renderWorkRow }) {
  const { setNodeRef, isOver } = useDroppable({ id: `folder:${folder.id}`, data: { folderId: folder.id } });
  return (
    <li className="group/folder">
      <div
        ref={setNodeRef}
        className={`flex items-center gap-1 rounded transition-colors ${
          isOver && isDragging ? 'bg-port-accent/15 ring-1 ring-port-accent' : ''
        }`}
      >
        <button
          onClick={onToggle}
          className="flex-1 flex items-center gap-1 px-2 py-1 text-gray-300 hover:text-white text-sm min-w-0"
        >
          {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Folder size={14} className="text-gray-400" />
          <span className="flex-1 text-left truncate">{folder.name}</span>
          <span className="text-[10px] text-gray-500">{works.length}</span>
        </button>
        <button
          onClick={onCreateWork}
          className="p-1 text-gray-500 hover:text-port-accent transition-opacity opacity-40 sm:opacity-0 group-hover/folder:opacity-100 focus:opacity-100"
          aria-label="Add work to folder"
          title="New work in folder"
        >
          <FilePlus size={12} />
        </button>
        <button
          onClick={onDelete}
          className={`p-1 transition-opacity ${
            armedDelete
              ? 'opacity-100 text-port-error'
              : 'opacity-40 sm:opacity-0 group-hover/folder:opacity-100 focus:opacity-100 text-gray-500 hover:text-port-error'
          }`}
          aria-label={`Delete folder ${folder.name}`}
          title={armedDelete ? 'Click again to confirm' : 'Delete folder'}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {isOpen && (
        <ul className="space-y-0.5 pl-5 relative">
          {works.length === 0 && (
            <li className="text-xs text-gray-500 px-2 py-1">Empty</li>
          )}
          {works.map(renderWorkRow)}
        </ul>
      )}
    </li>
  );
}
