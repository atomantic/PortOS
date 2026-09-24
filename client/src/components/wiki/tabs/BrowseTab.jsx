import { useState, useCallback } from 'react';
import { useSearchParams } from 'react-router';
import * as api from '../../../services/api';
import {FileText, FolderOpen,
  ChevronDown, ChevronRight, ArrowLeft, Tag, Link2} from 'lucide-react';
import toast from '../../ui/Toast';
import { WIKI_CATEGORIES } from '../constants.jsx';
import OfflineNotesNotice from '../../OfflineNotesNotice.jsx';
import { useNoteSave } from '../../../hooks/useNoteSave.js';
import useMounted from '../../../hooks/useMounted';
import NoteDetailPane from '../../notes/NoteDetailPane.jsx';
import useVaultNote from '../../../hooks/useVaultNote.js';

const WIKI_FOLDERS = WIKI_CATEGORIES.map(c => ({ key: c.folder, label: c.label, icon: c.icon, color: c.textClass }));
const RAW_FOLDERS = [{ key: 'raw', label: 'Raw Sources', icon: FolderOpen, color: 'text-gray-400' }];

export default function BrowseTab({ vaultId, notes, rawNotes, allNotes, onRefresh }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const noteParam = searchParams.get('note');
  const [noteContent, setNoteContent] = useState('');
  const [editing, setEditing] = useState(false);
  const {
    note: selectedNote, setNote: setSelectedNote, loading: loadingNote,
    error: noteUnavailable, retry: retryNote, sequenceRef: noteSequence,
  } = useVaultNote(vaultId, noteParam, {
    onReset: () => { setNoteContent(''); setEditing(false); setConfirmDelete(null); },
    onLoad: note => setNoteContent(note.content),
  });
  const [expandedFolders, setExpandedFolders] = useState(new Set(['wiki/sources', 'wiki/entities', 'wiki/concepts']));
  const [activeSection, setActiveSection] = useState('wiki');
  const [tags, setTags] = useState([]);
  // Tag counts under-report when iCloud hasn't downloaded some notes.
  const [skippedTagNotes, setSkippedTagNotes] = useState(0);
  const [showTags, setShowTags] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const mountedRef = useMounted();

  // Owns the write plus the iCloud force-save escape hatch (#3717).
  const { saving, save, forceOffered, dismissForce } = useNoteSave({
    vaultId,
    notePath: selectedNote?.path || null,
    content: noteContent
  });

  const updateNoteParam = (notePath, options) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      // URLSearchParams percent-encodes slashes in the serialized URL.
      if (notePath) next.set('note', notePath);
      else next.delete('note');
      return next;
    }, options);
  };

  const handleSelectNote = (notePath) => updateNoteParam(notePath);

  // `force` is ONLY ever passed by <ForceSaveNoteRow>'s confirm (#3717) — never
  // by the Save button or ⌘S.
  const handleSaveNote = async (options) => {
    if (!selectedNote) return;
    const sequence = noteSequence.current;
    const data = await save(options);
    if (!data || !mountedRef.current || sequence !== noteSequence.current) return;
    setSelectedNote(data);
    setEditing(false);
    toast.success('Note saved');
    onRefresh();
  };

  const handleDeleteNote = async (notePath) => {
    if (selectedNote?.path !== notePath) return;
    const sequence = noteSequence.current;
    const deleted = await api.deleteNote(vaultId, notePath).then(() => true).catch(() => false);
    if (!deleted || !mountedRef.current || sequence !== noteSequence.current) return;
    toast.success('Note deleted');
    setConfirmDelete(null);
    if (selectedNote?.path === notePath) setSelectedNote(null);
    if (noteParam === notePath) updateNoteParam(null, { replace: true });
    onRefresh();
  };

  const loadTags = async () => {
    const data = await api.getNotesVaultTags(vaultId).catch(() => null);
    if (!mountedRef.current) return;
    if (data?.tags) setTags(data.tags);
    setSkippedTagNotes(data?.skippedUnavailable || 0);
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
    // Responsive list/detail: single column on mobile (tree hides once a note is
    // opened; the detail pane's back button restores it), both panes from md+.
    // Fills its flex parent (min-h-0) rather than a fixed calc() so a wrapped
    // header never clips it.
    <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] grid-rows-1 h-full min-h-0 overflow-hidden">
      {/* Left panel — tree/list. Hidden on mobile while a note is open. */}
      <div className={`border-r border-port-border flex-col min-h-0 overflow-hidden ${noteParam ? 'hidden md:flex' : 'flex'}`}>
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
            className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded ${showTags ? 'text-port-accent' : 'text-gray-500 hover:text-white'}`}
            title="Tags" aria-label="Tags"
          >
            <Tag size={14} />
          </button>
        </div>

        {/* Tags */}
        {showTags && <OfflineNotesNotice count={skippedTagNotes} className="mx-3 mt-2" />}
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

      {/* Right panel: note viewer. Hidden on mobile until a note is opened. */}
      <div className={`flex-col min-w-0 min-h-0 overflow-hidden ${noteParam ? 'flex' : 'hidden md:flex'}`}>
        <NoteDetailPane
          selectedNote={selectedNote} loading={loadingNote} error={noteUnavailable}
          onRetry={retryNote} onBack={() => updateNoteParam(null, { replace: true })}
          backLabel="Back to list" cancelLabel="Cancel"
          editing={editing} onSetEditing={setEditing} noteContent={noteContent}
          onSetContent={setNoteContent} saving={saving} onSave={handleSaveNote}
          confirmingDelete={selectedNote ? confirmDelete === selectedNote.path : false}
          onRequestDelete={setConfirmDelete} onDelete={handleDeleteNote}
          onCancelDelete={() => setConfirmDelete(null)}
          forceOffered={forceOffered} dismissForce={dismissForce}
          renderPreview={content => (
            <div className="prose prose-invert prose-sm max-w-none">
              <pre className="whitespace-pre-wrap break-words text-sm text-gray-300 font-mono leading-relaxed">{content}</pre>
            </div>
          )}
          renderLinks={note => (
            <>
              {note.wikilinks?.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-gray-400 uppercase mb-1 flex items-center gap-1">
                    <Link2 size={10} /> Links ({note.wikilinks.length})
                  </h4>
                  <div className="space-y-0.5">
                    {note.wikilinks.map(link => (
                      <button key={link} onClick={() => {
                        const match = allNotes.find(n => n.name.toLowerCase() === link.toLowerCase());
                        if (match) handleSelectNote(match.path);
                        else toast.error(`"${link}" not found`);
                      }} className="block w-full text-left text-xs text-port-accent hover:text-white truncate">{link}</button>
                    ))}
                  </div>
                </div>
              )}
              {note.backlinks?.length > 0 && (
                <div>
                  <h4 className="text-xs font-medium text-gray-400 uppercase mb-1 flex items-center gap-1">
                    <ArrowLeft size={10} /> Backlinks ({note.backlinks.length})
                  </h4>
                  <div className="space-y-0.5">
                    {note.backlinks.map(bl => (
                      <button key={bl.path} onClick={() => handleSelectNote(bl.path)}
                        className="block w-full text-left text-xs text-port-accent hover:text-white truncate">{bl.name}</button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
          emptyIcon={FileText} emptyLabel="Select a page to view"
        />
      </div>
    </div>
  );
}
