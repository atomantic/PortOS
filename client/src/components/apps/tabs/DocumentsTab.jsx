import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { RefreshCw, FileText, Pencil, Save, X, Plus, AlertTriangle } from 'lucide-react';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import MarkdownOutput from '../../cos/MarkdownOutput';
import * as api from '../../../services/api';

const DOCS_ROOT = 'docs';

/** `docs/decisions/x.md` → `docs/decisions`, `docs/API.md` → `docs` (the group header). */
const dirOf = (path) => path.slice(0, path.lastIndexOf('/')) || path;
const baseOf = (path) => path.slice(path.lastIndexOf('/') + 1);

export default function DocumentsTab({ appId, repoPath }) {
  const [documents, setDocuments] = useState([]);
  const [docs, setDocs] = useState([]);
  const [hasPlanning, setHasPlanning] = useState(false);
  const [loading, setLoading] = useState(true);
  // The listing request FAILED — distinct from a listing that succeeded and is
  // legitimately empty, which renders the "no documents found" state instead.
  const [listFailed, setListFailed] = useState(false);

  // The open document lives in the URL so it is shareable, bookmarkable and
  // reload-safe (client/src/AGENTS.md). A search param rather than a route
  // segment because a document path is itself multi-segment (`docs/a/b.md`).
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedDoc = searchParams.get('doc');
  const selectedDocRef = useRef(selectedDoc);
  selectedDocRef.current = selectedDoc;

  // `null` = failed to load (or nothing selected); `''` is a real, empty file.
  const [docContent, setDocContent] = useState(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  // The document being created — never in the URL, since it doesn't exist yet.
  const [creating, setCreating] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  // dir → explicit open/closed, overriding the default-open rule below
  const [groupOverrides, setGroupOverrides] = useState({});

  const activeDoc = creating || selectedDoc;

  const selectDoc = useCallback((filename) => {
    setCreating(null);
    setEditing(false);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('doc', filename);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Load whatever the URL points at, so a deep link, a sidebar click, and the
  // browser Back button all take the same path.
  useEffect(() => {
    if (!selectedDoc) {
      setDocContent(null);
      return undefined;
    }
    let cancelled = false;
    setLoadingDoc(true);
    api.getAppDocument(appId, selectedDoc, { silent: true })
      .catch(() => null)
      .then(data => {
        if (cancelled) return;
        setDocContent(typeof data?.content === 'string' ? data.content : null);
        setLoadingDoc(false);
      });
    return () => { cancelled = true; };
  }, [appId, selectedDoc]);

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    const data = await api.getAppDocuments(appId, { silent: true }).catch(() => null);
    setLoading(false);

    // A failed refresh keeps the list already on screen rather than blanking it.
    if (!data) {
      setListFailed(true);
      return;
    }
    setListFailed(false);
    setDocuments(data.documents || []);
    setDocs(data.docs || []);
    setHasPlanning(data.hasPlanning || false);

    // Auto-select the first root document, falling back to the docs/ tree
    const firstExisting = (data.documents || []).find(d => d.exists)?.filename || (data.docs || [])[0];
    if (firstExisting && !selectedDocRef.current) {
      selectDoc(firstExisting);
    }
  }, [appId, selectDoc]);

  const enterEditMode = () => {
    setEditContent(docContent || '');
    setEditing(true);
  };

  const enterCreateMode = (filename) => {
    setCreating(filename);
    setDocContent(null);
    setEditContent('');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setCreating(null);
    setEditContent('');
  };

  const handleSave = async () => {
    const saved = activeDoc;
    setSaving(true);
    const result = await api
      .saveAppDocument(appId, saved, editContent, undefined, { silent: true })
      .catch(() => null);
    setSaving(false);

    if (!result) {
      toast.error('Failed to save document');
      return;
    }

    if (result.noChanges) {
      toast('No changes to commit', { icon: 'ℹ️' });
      setEditing(false);
      return;
    }

    toast.success(`Committed ${result.created ? 'new' : 'updated'} ${saved} (${result.hash})`);
    setEditing(false);
    setDocContent(editContent);
    // A newly created document now exists — hand it to the URL-driven path.
    if (creating) selectDoc(saved);
    fetchDocuments();
  };

  useEffect(() => {
    fetchDocuments();
  }, [fetchDocuments]);

  // docs/ entries grouped by their containing directory, preserving the sorted
  // order the server returned so the tree reads top-down.
  const docGroups = useMemo(() => {
    const groups = new Map();
    for (const path of docs) {
      const dir = dirOf(path);
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(path);
    }
    return [...groups.entries()];
  }, [docs]);

  if (loading && documents.length === 0 && !listFailed) {
    return <BrailleSpinner text="Loading documents" />;
  }

  const existingDocs = documents.filter(d => d.exists);
  const missingDocs = documents.filter(d => !d.exists);
  const nothingToShow = existingDocs.length === 0 && docs.length === 0;

  const docButtonClass = (filename) => `px-3 py-2 rounded-lg text-sm text-left transition-colors ${
    activeDoc === filename
      ? 'bg-port-accent/20 text-port-accent border border-port-accent/30'
      : 'bg-port-card border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50'
  }`;

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Documents</h3>
          <p className="text-sm text-gray-500">
            Markdown from {repoPath ? repoPath.split('/').pop() : 'repo'}
            {docs.length > 0 && <span className="ml-2">· {docs.length} in docs/</span>}
            {hasPlanning && <span className="text-port-accent ml-2">.planning/ exists</span>}
          </p>
        </div>
        <button
          onClick={fetchDocuments}
          className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {listFailed && (
        <div className="bg-port-card border border-port-error/40 rounded-lg p-3 flex items-center gap-2 text-sm text-port-error">
          <AlertTriangle size={16} />
          <span>
            Could not load the document list{documents.length > 0 ? ' — showing the last known list' : ''}.
          </span>
          <button
            onClick={fetchDocuments}
            className="ml-auto px-2 py-1 bg-port-border hover:bg-port-border/80 text-white rounded text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {nothingToShow && !editing ? (
        !listFailed && (
          <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
            <FileText size={32} className="text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400 mb-2">No documents found</p>
            <p className="text-xs text-gray-500 mb-4">
              No markdown in the repo root or a docs/ directory
            </p>
            {missingDocs.length > 0 && (
              <div className="flex gap-2 justify-center flex-wrap">
                {missingDocs.map(doc => (
                  <button
                    key={doc.filename}
                    onClick={() => enterCreateMode(doc.filename)}
                    className="px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded-lg text-xs flex items-center gap-1"
                  >
                    <Plus size={14} /> Create {doc.filename}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      ) : (
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Document selector */}
          <div className="sm:w-56 max-h-64 sm:max-h-[600px] overflow-y-auto flex flex-col gap-2 shrink-0">
            {existingDocs.map(doc => (
              <button
                key={doc.filename}
                onClick={() => selectDoc(doc.filename)}
                className={docButtonClass(doc.filename)}
              >
                <FileText size={14} className="inline mr-2" />
                {doc.filename}
              </button>
            ))}

            {docGroups.map(([dir, paths]) => (
              <details
                key={dir}
                open={groupOverrides[dir] ?? (dir === DOCS_ROOT || paths.includes(selectedDoc))}
                onToggle={e => {
                  // Read `open` now — the state updater runs after React has
                  // released the synthetic event's currentTarget.
                  const open = e.target.open;
                  setGroupOverrides(prev => ({ ...prev, [dir]: open }));
                }}
              >
                <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300 py-1">
                  {dir}/ <span className="text-gray-600">({paths.length})</span>
                </summary>
                <div className="mt-1 space-y-1">
                  {paths.map(path => (
                    <button
                      key={path}
                      onClick={() => selectDoc(path)}
                      title={path}
                      className={`w-full truncate ${docButtonClass(path)}`}
                    >
                      <FileText size={12} className="inline mr-2" />
                      {baseOf(path)}
                    </button>
                  ))}
                </div>
              </details>
            ))}

            {missingDocs.length > 0 && (
              <div className="mt-2 space-y-1">
                <div className="text-xs text-gray-600">Create:</div>
                {missingDocs.map(doc => (
                  <button
                    key={doc.filename}
                    onClick={() => enterCreateMode(doc.filename)}
                    className="w-full px-3 py-1.5 rounded-lg text-xs text-left text-gray-500 hover:text-port-accent hover:bg-port-card border border-transparent hover:border-port-border transition-colors flex items-center gap-1"
                  >
                    <Plus size={12} /> {doc.filename}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Document content */}
          <div className="flex-1 min-w-0 bg-port-card border border-port-border rounded-lg p-4 min-h-[300px] overflow-auto">
            {loadingDoc ? (
              <BrailleSpinner text="Loading document" />
            ) : editing ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-400">Editing {activeDoc}</span>
                  <div className="flex gap-2">
                    <button
                      onClick={cancelEdit}
                      disabled={saving}
                      className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
                    >
                      <X size={14} /> Cancel
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="px-3 py-1.5 bg-port-success/20 text-port-success hover:bg-port-success/30 rounded-lg text-xs flex items-center gap-1"
                    >
                      {saving ? <BrailleSpinner size="sm" /> : <Save size={14} />}
                      {saving ? 'Saving...' : 'Save & Commit'}
                    </button>
                  </div>
                </div>
                <textarea
                  aria-label="Document content"
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  className="w-full h-[500px] bg-[var(--port-terminal-bg)] text-[var(--port-terminal-text)] border border-port-border rounded-lg p-3 font-mono text-sm resize-y focus:outline-hidden focus:border-port-accent/50"
                  spellCheck={false}
                />
              </div>
            ) : docContent !== null ? (
              <div>
                <div className="flex items-center justify-between mb-2 gap-2">
                  <span className="text-xs text-gray-500 truncate">{selectedDoc}</span>
                  <button
                    onClick={enterEditMode}
                    className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1 shrink-0"
                  >
                    <Pencil size={14} /> Edit
                  </button>
                </div>
                {docContent
                  ? <MarkdownOutput content={docContent} />
                  : <p className="text-gray-500 text-sm italic">This document is empty.</p>}
              </div>
            ) : selectedDoc ? (
              <p className="text-gray-500 text-sm">Failed to load document</p>
            ) : (
              <p className="text-gray-500 text-sm">Select a document to view</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
