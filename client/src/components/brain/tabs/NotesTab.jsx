import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../../../services/api';
import {
  BookOpen,
  FolderOpen,
  Search,
  Plus,
  Trash2,
  Save,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  Tag,
  Link2,
  RefreshCw,
  Edit3,
  X,
  FileText,
  Settings
} from 'lucide-react';
import toast from '../../ui/Toast';
import { timeAgo, formatBytes } from '../../../utils/formatters';

export default function NotesTab({ onRefresh }) {
  // Vault state
  const [vaults, setVaults] = useState([]);
  const [selectedVaultId, setSelectedVaultId] = useState(null);
  const [detectedVaults, setDetectedVaults] = useState([]);
  const [showVaultSetup, setShowVaultSetup] = useState(false);
  const [addingVault, setAddingVault] = useState(false);
  const [customPath, setCustomPath] = useState('');

  // Notes state
  const [notes, setNotes] = useState([]);
  const [totalNotes, setTotalNotes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  // Note viewer/editor state
  const [selectedNote, setSelectedNote] = useState(null);
  const [noteContent, setNoteContent] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingNote, setLoadingNote] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);

  // Filter state
  const [folderFilter, setFolderFilter] = useState('');
  const [folders, setFolders] = useState([]);
  const [expandedFolders, setExpandedFolders] = useState(new Set());
  const [tags, setTags] = useState([]);
  const [showTags, setShowTags] = useState(false);

  // Create note state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newNotePath, setNewNotePath] = useState('');
  const [creating, setCreating] = useState(false);

  // Confirm delete
  const [confirmDelete, setConfirmDelete] = useState(null);

  const searchRef = useRef(null);
  const editorRef = useRef(null);

  // Load vaults on mount
  useEffect(() => {
    loadVaults();
  }, []);

  // Load notes when vault changes
  useEffect(() => {
    if (selectedVaultId) {
      loadNotes();
      loadFolders();
    }
  }, [selectedVaultId, folderFilter]);

  const loadVaults = async () => {
    const data = await api.getNotesVaults().catch(() => []);
    setVaults(data);
    if (data.length > 0 && !selectedVaultId) {
      setSelectedVaultId(data[0].id);
    }
    if (data.length === 0) {
      setShowVaultSetup(true);
      detectAvailableVaults();
    }
    setLoading(false);
  };

  const detectAvailableVaults = async () => {
    const detected = await api.detectNotesVaults().catch(() => []);
    setDetectedVaults(detected);
  };

  const loadNotes = async () => {
    if (!selectedVaultId) return;
    setScanning(true);
    const data = await api.scanNotesVault(selectedVaultId, { folder: folderFilter, limit: 500 }).catch(() => null);
    if (data) {
      setNotes(data.notes);
      setTotalNotes(data.total);
    }
    setScanning(false);
  };

  const loadFolders = async () => {
    if (!selectedVaultId) return;
    const data = await api.getNotesVaultFolders(selectedVaultId).catch(() => null);
    if (data?.folders) setFolders(data.folders);
  };

  const loadTags = async () => {
    if (!selectedVaultId) return;
    const data = await api.getNotesVaultTags(selectedVaultId).catch(() => null);
    if (data?.tags) setTags(data.tags);
  };

  const handleAddVault = async (name, path) => {
    setAddingVault(true);
    const result = await api.addNotesVault({ name, path }).catch(() => null);
    setAddingVault(false);
    if (result) {
      toast.success(`Added vault: ${result.name}`);
      setShowVaultSetup(false);
      await loadVaults();
      setSelectedVaultId(result.id);
    }
  };

  const handleRemoveVault = async (id) => {
    await api.deleteNotesVault(id).catch(() => null);
    toast.success('Vault removed');
    setVaults(prev => prev.filter(v => v.id !== id));
    if (selectedVaultId === id) {
      setSelectedVaultId(vaults.find(v => v.id !== id)?.id || null);
    }
    setConfirmDelete(null);
  };

  const handleSelectNote = async (notePath) => {
    setLoadingNote(true);
    setEditing(false);
    const data = await api.getNote(selectedVaultId, notePath).catch(() => null);
    if (data) {
      setSelectedNote(data);
      setNoteContent(data.content);
    }
    setLoadingNote(false);
  };

  const handleSaveNote = async () => {
    if (!selectedNote) return;
    setSaving(true);
    const data = await api.updateNote(selectedVaultId, selectedNote.path, noteContent).catch(() => null);
    setSaving(false);
    if (data) {
      setSelectedNote(data);
      setEditing(false);
      toast.success('Note saved');
      loadNotes(); // Refresh metadata
    }
  };

  const handleCreateNote = async () => {
    if (!newNotePath.trim()) return;
    setCreating(true);
    const data = await api.createNote(selectedVaultId, newNotePath.trim()).catch(() => null);
    setCreating(false);
    if (data) {
      toast.success(`Created: ${data.name}`);
      setShowCreateForm(false);
      setNewNotePath('');
      loadNotes();
      handleSelectNote(data.path);
    }
  };

  const handleDeleteNote = async (notePath) => {
    await api.deleteNote(selectedVaultId, notePath).catch(() => null);
    toast.success('Note deleted');
    setConfirmDelete(null);
    setNotes(prev => prev.filter(n => n.path !== notePath));
    if (selectedNote?.path === notePath) {
      setSelectedNote(null);
    }
  };

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || !selectedVaultId) return;
    setSearching(true);
    const data = await api.searchNotes(selectedVaultId, searchQuery.trim()).catch(() => null);
    setSearching(false);
    if (data) {
      setSearchResults(data);
    }
  }, [searchQuery, selectedVaultId]);

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults(null);
  };

  const toggleFolder = (folder) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };

  // Vault setup / empty state
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  if (showVaultSetup || vaults.length === 0) {
    return (
      <VaultSetup
        detectedVaults={detectedVaults}
        vaults={vaults}
        customPath={customPath}
        setCustomPath={setCustomPath}
        adding={addingVault}
        onAdd={handleAddVault}
        onDetect={detectAvailableVaults}
        onClose={() => setShowVaultSetup(false)}
      />
    );
  }

  // Build folder tree from notes
  const rootNotes = folderFilter
    ? notes
    : notes.filter(n => !n.folder);
  const folderNotes = folderFilter
    ? []
    : [...new Set(notes.filter(n => n.folder).map(n => n.folder.split('/')[0]))];

  // Determine what to show in list
  const displayNotes = searchResults ? searchResults.results : notes;

  return (
    <div className="flex h-full -m-4" style={{ height: 'calc(100vh - 180px)' }}>
      {/* Left panel: note list */}
      <div className="w-80 border-r border-port-border flex flex-col shrink-0">
        {/* Vault selector and actions */}
        <div className="p-3 border-b border-port-border space-y-2">
          <div className="flex items-center gap-2">
            <select
              value={selectedVaultId || ''}
              onChange={e => {
                setSelectedVaultId(e.target.value);
                setSelectedNote(null);
                setSearchResults(null);
                setFolderFilter('');
              }}
              className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white"
            >
              {vaults.map(v => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            <button
              onClick={() => setShowVaultSetup(true)}
              className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-white"
              title="Manage vaults"
            >
              <Settings size={14} />
            </button>
            <button
              onClick={() => { setShowCreateForm(true); setNewNotePath(''); }}
              className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-port-accent"
              title="New note"
            >
              <Plus size={14} />
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500" />
            <input
              ref={searchRef}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSearch()}
              placeholder="Search notes..."
              className="w-full bg-port-bg border border-port-border rounded pl-7 pr-7 py-1.5 text-sm text-white placeholder-gray-500"
            />
            {searchQuery && (
              <button
                onClick={clearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Create note form */}
          {showCreateForm && (
            <div className="flex items-center gap-1">
              <input
                value={newNotePath}
                onChange={e => setNewNotePath(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateNote()}
                placeholder="folder/note-name"
                className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white placeholder-gray-500"
                autoFocus
              />
              <button
                onClick={handleCreateNote}
                disabled={creating || !newNotePath.trim()}
                className="px-2 py-1 rounded bg-port-accent text-white text-xs disabled:opacity-50"
              >
                {creating ? '...' : 'Create'}
              </button>
              <button
                onClick={() => setShowCreateForm(false)}
                className="p-1 rounded hover:bg-port-card text-gray-400"
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>

        {/* Stats bar */}
        <div className="px-3 py-1.5 border-b border-port-border flex items-center gap-3 text-xs text-gray-500">
          <span>{totalNotes} notes</span>
          {folderFilter && (
            <button
              onClick={() => setFolderFilter('')}
              className="flex items-center gap-1 text-port-accent hover:text-white"
            >
              <X size={10} />
              {folderFilter}
            </button>
          )}
          {searchResults && (
            <span className="text-port-accent">{searchResults.total} results</span>
          )}
          <button
            onClick={() => { loadTags(); setShowTags(!showTags); }}
            className={`ml-auto p-0.5 rounded ${showTags ? 'text-port-accent' : 'text-gray-500 hover:text-white'}`}
            title="Tags"
          >
            <Tag size={12} />
          </button>
          <button
            onClick={loadNotes}
            className="p-0.5 rounded text-gray-500 hover:text-white"
            title="Refresh"
          >
            <RefreshCw size={12} className={scanning ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Tags panel */}
        {showTags && tags.length > 0 && (
          <div className="px-3 py-2 border-b border-port-border flex flex-wrap gap-1 max-h-24 overflow-auto">
            {tags.map(t => (
              <span
                key={t.tag}
                className="px-1.5 py-0.5 rounded text-xs bg-port-accent/20 text-port-accent cursor-pointer hover:bg-port-accent/30"
                onClick={() => { setSearchQuery(`#${t.tag}`); handleSearch(); }}
              >
                #{t.tag} <span className="text-gray-500">{t.count}</span>
              </span>
            ))}
          </div>
        )}

        {/* Note list */}
        <div className="flex-1 overflow-auto">
          {scanning && notes.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
              <RefreshCw size={14} className="animate-spin mr-2" /> Scanning vault...
            </div>
          ) : displayNotes.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-500 text-sm">
              {searchResults ? 'No matches found' : 'No notes yet'}
            </div>
          ) : (
            <div className="divide-y divide-port-border/50">
              {/* Folders first (when not searching) */}
              {!searchResults && !folderFilter && folderNotes.map(folder => (
                <FolderItem
                  key={folder}
                  folder={folder}
                  notes={notes.filter(n => n.folder === folder || n.folder.startsWith(folder + '/'))}
                  expanded={expandedFolders.has(folder)}
                  onToggle={() => toggleFolder(folder)}
                  onSelectNote={handleSelectNote}
                  onFilterFolder={() => setFolderFilter(folder)}
                  selectedPath={selectedNote?.path}
                />
              ))}
              {/* Root notes or filtered/search results */}
              {(searchResults ? displayNotes : rootNotes).map(note => (
                <NoteListItem
                  key={note.path}
                  note={note}
                  isSearch={!!searchResults}
                  selected={selectedNote?.path === note.path}
                  onClick={() => handleSelectNote(note.path)}
                />
              ))}
              {/* Notes in filtered folder */}
              {folderFilter && notes.filter(n => n.folder).map(note => (
                <NoteListItem
                  key={note.path}
                  note={note}
                  selected={selectedNote?.path === note.path}
                  onClick={() => handleSelectNote(note.path)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right panel: note viewer/editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {loadingNote ? (
          <div className="flex items-center justify-center h-full">
            <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
          </div>
        ) : selectedNote ? (
          <>
            {/* Note header */}
            <div className="px-4 py-3 border-b border-port-border flex items-center gap-3">
              <button
                onClick={() => setSelectedNote(null)}
                className="p-1 rounded hover:bg-port-card text-gray-400 hover:text-white md:hidden"
              >
                <ArrowLeft size={16} />
              </button>
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
                <button
                  onClick={() => handleDeleteNote(selectedNote.path)}
                  className="px-2 py-1 rounded bg-port-error text-white text-xs"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmDelete(null)}
                  className="px-2 py-1 rounded bg-port-card text-gray-300 text-xs"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Note content */}
            <div className="flex-1 overflow-auto flex">
              {/* Main content area */}
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
                  <div className="p-4">
                    <MarkdownPreview content={selectedNote.body || selectedNote.content} onLinkClick={handleSelectNote} />
                  </div>
                )}
              </div>

              {!editing && (
                <div className="w-56 border-l border-port-border p-3 space-y-4 shrink-0 overflow-auto hidden lg:block">
                  {selectedNote.frontmatter && Object.keys(selectedNote.frontmatter).length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-gray-400 uppercase mb-1">Properties</h4>
                      <div className="space-y-1">
                        {Object.entries(selectedNote.frontmatter).map(([key, val]) => (
                          <div key={key} className="text-xs">
                            <span className="text-gray-500">{key}:</span>{' '}
                            <span className="text-gray-300">
                              {Array.isArray(val) ? val.join(', ') : String(val)}
                            </span>
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
                          <span key={tag} className="px-1.5 py-0.5 rounded text-xs bg-port-accent/20 text-port-accent">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <LinkSection
                    icon={<Link2 size={10} />}
                    label="Links"
                    items={selectedNote.wikilinks}
                    getKey={link => link}
                    getLabel={link => link}
                    onClickItem={link => {
                      const match = notes.find(n => n.name.toLowerCase() === link.toLowerCase());
                      if (match) handleSelectNote(match.path);
                      else toast.warn(`Note "${link}" not found in vault`);
                    }}
                  />

                  <LinkSection
                    icon={<ArrowLeft size={10} />}
                    label="Backlinks"
                    items={selectedNote.backlinks}
                    getKey={bl => bl.path}
                    getLabel={bl => bl.name}
                    onClickItem={bl => handleSelectNote(bl.path)}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <BookOpen size={48} className="mb-3 opacity-30" />
            <p className="text-sm">Select a note to view</p>
            <p className="text-xs mt-1">or press + to create a new one</p>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function LinkSection({ icon, label, items, getKey, getLabel, onClickItem }) {
  if (!items?.length) return null;
  return (
    <div>
      <h4 className="text-xs font-medium text-gray-400 uppercase mb-1 flex items-center gap-1">
        {icon} {label} ({items.length})
      </h4>
      <div className="space-y-0.5">
        {items.map(item => (
          <button
            key={getKey(item)}
            onClick={() => onClickItem(item)}
            className="block w-full text-left text-xs text-port-accent hover:text-white truncate"
          >
            {getLabel(item)}
          </button>
        ))}
      </div>
    </div>
  );
}

function VaultSetup({ detectedVaults, vaults, customPath, setCustomPath, adding, onAdd, onDetect, onClose }) {
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <BookOpen size={20} className="text-port-accent" />
            Obsidian Vault Manager
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Connect your Obsidian vaults from iCloud to browse, search, and manage your notes.
          </p>
        </div>
        {vaults.length > 0 && (
          <button onClick={onClose} className="p-1.5 rounded hover:bg-port-card text-gray-400 hover:text-white">
            <X size={16} />
          </button>
        )}
      </div>

      {/* Connected vaults */}
      {vaults.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-400 mb-2">Connected Vaults</h3>
          <div className="space-y-2">
            {vaults.map(v => (
              <div key={v.id} className="flex items-center justify-between p-3 rounded-lg bg-port-card border border-port-border">
                <div>
                  <span className="text-white font-medium">{v.name}</span>
                  <span className="text-xs text-gray-500 block truncate">{v.path}</span>
                </div>
                <button
                  onClick={() => onAdd === null ? null : null} // placeholder, actual delete handled separately
                  className="text-gray-500 hover:text-port-error p-1"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Detected vaults from iCloud */}
      {detectedVaults.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-gray-400 mb-2">
            Detected iCloud Vaults
          </h3>
          <div className="space-y-2">
            {detectedVaults.map(dv => {
              const isConnected = vaults.some(v => v.path === dv.path);
              return (
                <div key={dv.path} className="flex items-center justify-between p-3 rounded-lg bg-port-card border border-port-border">
                  <div>
                    <span className="text-white">{dv.name}</span>
                    <span className="text-xs text-gray-500 block truncate">{dv.path}</span>
                  </div>
                  {isConnected ? (
                    <span className="text-xs text-port-success">Connected</span>
                  ) : (
                    <button
                      onClick={() => onAdd(dv.name, dv.path)}
                      disabled={adding}
                      className="px-3 py-1 rounded bg-port-accent text-white text-sm disabled:opacity-50"
                    >
                      {adding ? '...' : 'Connect'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {detectedVaults.length === 0 && vaults.length === 0 && (
        <div className="p-4 rounded-lg bg-port-card border border-port-border text-center">
          <p className="text-gray-400 text-sm mb-2">No Obsidian vaults found in iCloud.</p>
          <button
            onClick={onDetect}
            className="text-port-accent text-sm hover:text-white"
          >
            Scan again
          </button>
        </div>
      )}

      {/* Custom path */}
      <div>
        <h3 className="text-sm font-medium text-gray-400 mb-2">Add Custom Path</h3>
        <div className="flex items-center gap-2">
          <input
            value={customPath}
            onChange={e => setCustomPath(e.target.value)}
            placeholder="/path/to/obsidian/vault"
            className="flex-1 bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-500"
          />
          <button
            onClick={() => {
              if (customPath.trim()) {
                onAdd(null, customPath.trim());
                setCustomPath('');
              }
            }}
            disabled={adding || !customPath.trim()}
            className="px-4 py-2 rounded bg-port-accent text-white text-sm disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function FolderItem({ folder, notes, expanded, onToggle, onSelectNote, onFilterFolder, selectedPath }) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-white hover:bg-port-card/50"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <FolderOpen size={14} className="text-port-warning/60" />
        <span className="flex-1 text-left truncate">{folder}</span>
        <span className="text-xs text-gray-600">{notes.length}</span>
      </button>
      {expanded && (
        <div className="ml-4">
          {notes.slice(0, 20).map(note => (
            <NoteListItem
              key={note.path}
              note={note}
              selected={selectedPath === note.path}
              onClick={() => onSelectNote(note.path)}
              compact
            />
          ))}
          {notes.length > 20 && (
            <button
              onClick={onFilterFolder}
              className="w-full px-3 py-1 text-xs text-port-accent hover:text-white"
            >
              Show all {notes.length} notes...
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NoteListItem({ note, selected, onClick, compact, isSearch }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 ${compact ? 'py-1.5' : 'py-2'} hover:bg-port-card/50 transition-colors ${
        selected ? 'bg-port-accent/10 border-l-2 border-port-accent' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <FileText size={12} className="text-gray-500 shrink-0" />
        <span className={`text-sm truncate ${selected ? 'text-white' : 'text-gray-300'}`}>
          {note.name}
        </span>
      </div>
      {!compact && (
        <div className="flex items-center gap-2 mt-0.5 ml-5">
          {isSearch && note.folder && (
            <span className="text-xs text-gray-600 truncate">{note.folder}/</span>
          )}
          {note.tags?.length > 0 && (
            <span className="text-xs text-gray-600 truncate">
              {note.tags.slice(0, 3).map(t => `#${t}`).join(' ')}
            </span>
          )}
          {isSearch && note.snippets?.[0] && (
            <span className="text-xs text-gray-600 truncate">
              ...{note.snippets[0].text.slice(0, 80)}...
            </span>
          )}
        </div>
      )}
    </button>
  );
}

/**
 * Simple markdown preview renderer
 * Handles headings, bold, italic, code, links, wikilinks, lists, blockquotes
 */
function MarkdownPreview({ content, onLinkClick }) {
  if (!content) return null;

  const lines = content.split('\n');
  const elements = [];
  let inCodeBlock = false;
  let codeLines = [];
  let codeLanguage = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={i} className="bg-port-bg border border-port-border rounded p-3 overflow-x-auto text-sm text-gray-300 font-mono my-2">
            <code>{codeLines.join('\n')}</code>
          </pre>
        );
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLanguage = line.trim().slice(3);
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Empty lines
    if (!line.trim()) {
      elements.push(<div key={i} className="h-3" />);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const sizes = ['text-2xl', 'text-xl', 'text-lg', 'text-base', 'text-sm', 'text-xs'];
      elements.push(
        <div key={i} className={`${sizes[level - 1]} font-bold text-white mt-4 mb-2`}>
          {renderInline(headingMatch[2], onLinkClick)}
        </div>
      );
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      elements.push(<hr key={i} className="border-port-border my-3" />);
      continue;
    }

    // Blockquotes
    if (line.trimStart().startsWith('> ')) {
      elements.push(
        <div key={i} className="border-l-2 border-port-accent/40 pl-3 text-gray-400 text-sm italic my-1">
          {renderInline(line.replace(/^>\s*/, ''), onLinkClick)}
        </div>
      );
      continue;
    }

    // Unordered lists
    const listMatch = line.match(/^(\s*)[*-]\s+(.+)/);
    if (listMatch) {
      const indent = Math.floor(listMatch[1].length / 2);
      elements.push(
        <div key={i} className="text-sm text-gray-300 my-0.5" style={{ paddingLeft: `${indent * 16 + 16}px` }}>
          <span className="text-gray-500 mr-2">&#8226;</span>
          {renderInline(listMatch[2], onLinkClick)}
        </div>
      );
      continue;
    }

    // Ordered lists
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      const indent = Math.floor(olMatch[1].length / 2);
      elements.push(
        <div key={i} className="text-sm text-gray-300 my-0.5" style={{ paddingLeft: `${indent * 16 + 16}px` }}>
          {renderInline(olMatch[2], onLinkClick)}
        </div>
      );
      continue;
    }

    // Checkbox items
    const checkMatch = line.match(/^(\s*)[*-]\s+\[([ xX])\]\s+(.+)/);
    if (checkMatch) {
      const checked = checkMatch[2] !== ' ';
      elements.push(
        <div key={i} className={`text-sm my-0.5 flex items-start gap-2 ${checked ? 'text-gray-500 line-through' : 'text-gray-300'}`} style={{ paddingLeft: '16px' }}>
          <span className="mt-0.5">{checked ? '☑' : '☐'}</span>
          {renderInline(checkMatch[3], onLinkClick)}
        </div>
      );
      continue;
    }

    // Regular paragraph
    elements.push(
      <p key={i} className="text-sm text-gray-300 my-1 leading-relaxed">
        {renderInline(line, onLinkClick)}
      </p>
    );
  }

  // Close unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    elements.push(
      <pre key="unclosed-code" className="bg-port-bg border border-port-border rounded p-3 overflow-x-auto text-sm text-gray-300 font-mono my-2">
        <code>{codeLines.join('\n')}</code>
      </pre>
    );
  }

  return <div className="prose-dark">{elements}</div>;
}

/**
 * Render inline markdown: bold, italic, code, links, wikilinks, tags
 */
function renderInline(text, onLinkClick) {
  if (!text) return null;

  // Split on inline patterns and rebuild
  const parts = [];
  let remaining = text;
  let key = 0;

  while (remaining) {
    // Wikilinks: [[target|display]] or [[target]]
    const wikiMatch = remaining.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
    // Inline code
    const codeMatch = remaining.match(/`([^`]+)`/);
    // Bold
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    // Italic
    const italicMatch = remaining.match(/(?<!\*)\*([^*]+)\*(?!\*)/);
    // External links: [text](url)
    const linkMatch = remaining.match(/\[([^\]]+)\]\(([^)]+)\)/);
    // Tags: #tag
    const tagMatch = remaining.match(/(?:^|\s)(#[a-zA-Z][a-zA-Z0-9_/-]*)/);

    // Find earliest match
    const matches = [
      wikiMatch && { type: 'wiki', match: wikiMatch },
      codeMatch && { type: 'code', match: codeMatch },
      boldMatch && { type: 'bold', match: boldMatch },
      italicMatch && { type: 'italic', match: italicMatch },
      linkMatch && { type: 'link', match: linkMatch },
      tagMatch && { type: 'tag', match: tagMatch }
    ].filter(Boolean).sort((a, b) => a.match.index - b.match.index);

    if (matches.length === 0) {
      parts.push(remaining);
      break;
    }

    const first = matches[0];
    const before = remaining.slice(0, first.match.index);
    if (before) parts.push(before);

    switch (first.type) {
      case 'wiki': {
        const target = first.match[1].trim();
        const display = first.match[2]?.trim() || target;
        parts.push(
          <button
            key={key++}
            onClick={() => onLinkClick?.(target + '.md')}
            className="text-port-accent hover:text-white hover:underline"
          >
            {display}
          </button>
        );
        break;
      }
      case 'code':
        parts.push(
          <code key={key++} className="bg-port-bg border border-port-border rounded px-1 py-0.5 text-xs text-port-accent font-mono">
            {first.match[1]}
          </code>
        );
        break;
      case 'bold':
        parts.push(<strong key={key++} className="text-white font-semibold">{first.match[1]}</strong>);
        break;
      case 'italic':
        parts.push(<em key={key++} className="text-gray-400 italic">{first.match[1]}</em>);
        break;
      case 'link':
        parts.push(
          <a key={key++} href={first.match[2]} target="_blank" rel="noopener noreferrer" className="text-port-accent hover:underline">
            {first.match[1]}
          </a>
        );
        break;
      case 'tag':
        parts.push(
          <span key={key++} className="text-port-accent/70">{first.match[1]}</span>
        );
        break;
    }

    remaining = remaining.slice(first.match.index + first.match[0].length);
  }

  return parts;
}

