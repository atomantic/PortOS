import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import * as api from '../../../services/api';
import {
  FileText, FolderOpen,
  ChevronDown, ChevronRight, ArrowLeft, Tag, Link2, Edit3, Save,
  Trash2, X, RefreshCw
} from 'lucide-react';
import toast from '../../ui/Toast';
import { timeAgo, formatBytes } from '../../../utils/formatters';
import { WIKI_CATEGORIES } from '../constants.jsx';

const WIKI_FOLDERS = WIKI_CATEGORIES.map(c => ({ key: c.folder, label: c.label, icon: c.icon, color: c.textClass }));
const RAW_FOLDERS = [{ key: 'raw', label: 'Raw Sources', icon: FolderOpen, color: 'text-gray-400' }];

export default function BrowseTab({ vaultId, notes, rawNotes, allNotes, onRefresh }) {
  const location = useLocation();
  const [selectedNote, setSelectedNote] = useState(null);
  const [noteContent, setNoteContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingNote, setLoadingNote] = useState(false);
  const [expandedFolders, setExpandedFolders] = useState(new Set(['wiki/sources', 'wiki/entities', 'wiki/concepts']));
  const [activeSection, setActiveSection] = useState('wiki');
  const [tags, setTags] = useState([]);
  const [showTags, setShowTags] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const editorRef = useRef(null);

  // Handle deep-link from overview
  useEffect(() => {
    if (location.state?.openNote) {
      handleSelectNote(location.state.openNote);
    }
  }, [location.state]);

  const handleSelectNote = async (notePath) => {
    setLoadingNote(true);
    setEditing(false);
    const data = await api.getNote(vaultId, notePath).catch(() => null);
    if (data && !data.error) {
      setSelectedNote(data);
      setNoteContent(data.content);
    }
    setLoadingNote(false);
  };

  const handleSaveNote = async () => {
    if (!selectedNote) return;
    setSaving(true);
    const data = await api.updateNote(vaultId, selectedNote.path, noteContent).catch(() => null);
    setSaving(false);
    if (data) {
      setSelectedNote(data);
      setEditing(false);
      toast.success('Note saved');
      onRefresh();
    }
  };

  const handleDeleteNote = async (notePath) => {
    await api.deleteNote(vaultId, notePath).catch(() => null);
    toast.success('Note deleted');
    setConfirmDelete(null);
    if (selectedNote?.path === notePath) setSelectedNote(null);
    onRefresh();
  };

  const loadTags = async () => {
    const data = await api.getNotesVaultTags(vaultId).catch(() => null);
    if (data?.tags) setTags(data.tags);
  };

  const toggleFolder = (folder) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  const notesForFolder = useCallback((folderKey) => {
    if (folderKey === 'raw') return rawNotes;
    return notes.filter(n => n.folder === folderKey);
  }, [notes, rawNotes]);

  const folders = activeSection === 'wiki' ? WIKI_FOLDERS : RAW_FOLDERS;

  const rootWikiNotes = activeSection === 'wiki'
    ? allNotes.filter(n =>
        (n.folder === 'wiki' || n.path === 'wiki/index.md' || n.path === 'wiki/log.md') &&
        !WIKI_FOLDERS.some(f => n.folder === f.key)
      )
    : [];

  return (
    <div className="flex -m-4" style={{ height: 'calc(100vh - 220px)' }}>
      {/* Left panel */}
      <div className="w-80 border-r border-port-border flex flex-col shrink-0">
        {/* Section toggle */}
        <div className="p-3 border-b border-port-border flex items-center gap-2">
          <button
            onClick={() => setActiveSection('wiki')}
            className={`flex-1 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              activeSection === 'wiki' ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400 hover:text-white'
            }`}
          >
            Wiki ({notes.length})
          </button>
          <button
            onClick={() => setActiveSection('raw')}
            className={`flex-1 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              activeSection === 'raw' ? 'bg-port-accent text-white' : 'bg-port-bg text-gray-400 hover:text-white'
            }`}
          >
            Raw ({rawNotes.length})
          </button>
          <button
            onClick={() => { loadTags(); setShowTags(!showTags); }}
            className={`p-1.5 rounded ${showTags ? 'text-port-accent' : 'text-gray-500 hover:text-white'}`}
            title="Tags"
          >
            <Tag size={14} />
          </button>
        </div>

        {/* Tags */}
        {showTags && tags.length > 0 && (
          <div className="px-3 py-2 border-b border-port-border flex flex-wrap gap-1 max-h-24 overflow-auto">
            {tags.map(t => (
              <span key={t.tag} className="px-1.5 py-0.5 rounded text-xs bg-port-accent/20 text-port-accent">
                #{t.tag} <span className="text-gray-500">{t.count}</span>
              </span>
            ))}
          </div>
        )}

        {/* Folder tree */}
        <div className="flex-1 overflow-auto">
          {folders.map(folder => {
            const folderNotes = notesForFolder(folder.key);
            const Icon = folder.icon;
            const expanded = expandedFolders.has(folder.key);
            return (
              <div key={folder.key}>
                <button
                  onClick={() => toggleFolder(folder.key)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-port-card/50"
                >
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  <Icon size={14} className={folder.color} />
                  <span className="flex-1 text-left">{folder.label}</span>
                  <span className="text-xs text-gray-600">{folderNotes.length}</span>
                </button>
                {expanded && (
                  <div className="ml-4">
                    {folderNotes.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-gray-600 italic">Empty</div>
                    ) : folderNotes.map(note => (
                      <button
                        key={note.path}
                        onClick={() => handleSelectNote(note.path)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
                          selectedNote?.path === note.path
                            ? 'bg-port-accent/10 text-port-accent'
                            : 'text-gray-300 hover:text-white hover:bg-port-card/30'
                        }`}
                      >
                        <FileText size={12} className="shrink-0 text-gray-500" />
                        <span className="flex-1 truncate">{note.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {rootWikiNotes.map(note => (
            <button
              key={note.path}
              onClick={() => handleSelectNote(note.path)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
                selectedNote?.path === note.path
                  ? 'bg-port-accent/10 text-port-accent'
                  : 'text-gray-300 hover:text-white hover:bg-port-card/30'
              }`}
            >
              <FileText size={12} className="shrink-0 text-gray-500" />
              <span className="flex-1 truncate">{note.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Right panel: note viewer */}
      <div className="flex-1 flex flex-col min-w-0">
        {loadingNote ? (
          <div className="flex items-center justify-center h-full">
            <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
          </div>
        ) : selectedNote ? (
          <>
            {/* Note header */}
            <div className="px-4 py-3 border-b border-port-border flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <h2 className="text-white font-medium truncate">{selectedNote.name}</h2>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  {selectedNote.folder && (
                    <span className="flex items-center gap-1">
                      <FolderOpen size={10} />
                      {selectedNote.folder}
                    </span>
                  )}
                  <span>Modified {timeAgo(selectedNote.modifiedAt)}</span>
                  <span>{formatBytes(selectedNote.size)}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                {editing ? (
                  <>
                    <button
                      onClick={handleSaveNote}
                      disabled={saving}
                      className="flex items-center gap-1 px-3 py-1.5 rounded bg-port-accent text-white text-sm hover:bg-port-accent/80 disabled:opacity-50"
                    >
                      <Save size={14} />
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={() => { setEditing(false); setNoteContent(selectedNote.content); }}
                      className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-white"
                    >
                      <X size={16} />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setEditing(true)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded bg-port-card text-gray-300 text-sm hover:text-white hover:bg-port-border"
                  >
                    <Edit3 size={14} />
                    Edit
                  </button>
                )}
                <button
                  onClick={() => setConfirmDelete(selectedNote.path)}
                  className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-port-error"
                  title="Delete note"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            {/* Delete confirmation */}
            {confirmDelete === selectedNote.path && (
              <div className="px-4 py-2 bg-port-error/10 border-b border-port-error/30 flex items-center gap-3 text-sm">
                <span className="text-port-error">Delete this note permanently?</span>
                <button onClick={() => handleDeleteNote(selectedNote.path)} className="px-2 py-1 rounded bg-port-error text-white text-xs">Delete</button>
                <button onClick={() => setConfirmDelete(null)} className="px-2 py-1 rounded bg-port-card text-gray-300 text-xs">Cancel</button>
              </div>
            )}

            {/* Note content */}
            <div className="flex-1 overflow-auto flex">
              <div className="flex-1 min-w-0">
                {editing ? (
                  <textarea
                    ref={editorRef}
                    value={noteContent}
                    onChange={e => setNoteContent(e.target.value)}
                    className="w-full h-full p-4 bg-port-bg text-gray-200 font-mono text-sm resize-none focus:outline-none"
                    spellCheck={false}
                    onKeyDown={e => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                        e.preventDefault();
                        handleSaveNote();
                      }
                    }}
                  />
                ) : (
                  <div className="p-4 prose prose-invert prose-sm max-w-none">
                    <pre className="whitespace-pre-wrap text-sm text-gray-300 font-mono leading-relaxed">
                      {selectedNote.body || selectedNote.content}
                    </pre>
                  </div>
                )}
              </div>

              {/* Sidebar: metadata */}
              {!editing && (
                <div className="w-56 border-l border-port-border p-3 space-y-4 shrink-0 overflow-auto hidden lg:block">
                  {selectedNote.frontmatter && Object.keys(selectedNote.frontmatter).length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-gray-400 uppercase mb-1">Properties</h4>
                      <div className="space-y-1">
                        {Object.entries(selectedNote.frontmatter).map(([key, val]) => (
                          <div key={key} className="text-xs">
                            <span className="text-gray-500">{key}:</span>{' '}
                            <span className="text-gray-300">{Array.isArray(val) ? val.join(', ') : String(val)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedNote.tags?.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-gray-400 uppercase mb-1">Tags</h4>
                      <div className="flex flex-wrap gap-1">
                        {selectedNote.tags.map(tag => (
                          <span key={tag} className="px-1.5 py-0.5 rounded text-xs bg-port-accent/20 text-port-accent">#{tag}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedNote.wikilinks?.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-gray-400 uppercase mb-1 flex items-center gap-1">
                        <Link2 size={10} /> Links ({selectedNote.wikilinks.length})
                      </h4>
                      <div className="space-y-0.5">
                        {selectedNote.wikilinks.map(link => (
                          <button
                            key={link}
                            onClick={() => {
                              const match = allNotes.find(n => n.name.toLowerCase() === link.toLowerCase());
                              if (match) handleSelectNote(match.path);
                              else toast.error(`"${link}" not found`);
                            }}
                            className="block w-full text-left text-xs text-port-accent hover:text-white truncate"
                          >
                            {link}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedNote.backlinks?.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-gray-400 uppercase mb-1 flex items-center gap-1">
                        <ArrowLeft size={10} /> Backlinks ({selectedNote.backlinks.length})
                      </h4>
                      <div className="space-y-0.5">
                        {selectedNote.backlinks.map(bl => (
                          <button
                            key={bl.path}
                            onClick={() => handleSelectNote(bl.path)}
                            className="block w-full text-left text-xs text-port-accent hover:text-white truncate"
                          >
                            {bl.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <FileText size={48} className="mb-3 opacity-30" />
            <p className="text-sm">Select a page to view</p>
          </div>
        )}
      </div>
    </div>
  );
}
