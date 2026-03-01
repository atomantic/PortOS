import { useState, useEffect } from 'react';
import { RefreshCw, FileText, Pencil, Save, X, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../../BrailleSpinner';
import MarkdownOutput from '../../cos/MarkdownOutput';
import * as api from '../../../services/api';

export default function DocumentsTab({ appId, repoPath }) {
  const [documents, setDocuments] = useState([]);
  const [hasPlanning, setHasPlanning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [docContent, setDocContent] = useState(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  const fetchDocuments = async () => {
    setLoading(true);
    const data = await api.getAppDocuments(appId).catch(() => ({ documents: [], hasPlanning: false }));
    setDocuments(data.documents || []);
    setHasPlanning(data.hasPlanning || false);
    setLoading(false);

    // Auto-select first existing document
    const firstExisting = (data.documents || []).find(d => d.exists);
    if (firstExisting && !selectedDoc) {
      loadDocument(firstExisting.filename);
    }
  };

  const loadDocument = async (filename) => {
    setSelectedDoc(filename);
    setEditing(false);
    setLoadingDoc(true);
    const data = await api.getAppDocument(appId, filename).catch(() => null);
    setDocContent(data?.content || null);
    setLoadingDoc(false);
  };

  const enterEditMode = () => {
    setEditContent(docContent || '');
    setEditing(true);
  };

  const enterCreateMode = (filename) => {
    setSelectedDoc(filename);
    setDocContent(null);
    setEditContent('');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditContent('');
  };

  const handleSave = async () => {
    setSaving(true);
    const result = await api.saveAppDocument(appId, selectedDoc, editContent).catch(() => null);
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

    toast.success(`Committed ${result.created ? 'new' : 'updated'} ${selectedDoc} (${result.hash})`);
    setDocContent(editContent);
    setEditing(false);
    fetchDocuments();
  };

  useEffect(() => {
    fetchDocuments();
  }, [appId]);

  if (loading) {
    return <BrailleSpinner text="Loading documents" />;
  }

  const existingDocs = documents.filter(d => d.exists);
  const missingDocs = documents.filter(d => !d.exists);

  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Documents</h3>
          <p className="text-sm text-gray-500">
            Key project documents from {repoPath ? repoPath.split('/').pop() : 'repo'}
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

      {existingDocs.length === 0 && !editing ? (
        <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
          <FileText size={32} className="text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 mb-2">No documents found</p>
          <p className="text-xs text-gray-500 mb-4">
            Looking for: {documents.map(d => d.filename).join(', ')}
          </p>
          {missingDocs.length > 0 && (
            <div className="flex gap-2 justify-center">
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
      ) : (
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Document selector */}
          <div className="sm:w-48 flex sm:flex-col gap-2">
            {existingDocs.map(doc => (
              <button
                key={doc.filename}
                onClick={() => loadDocument(doc.filename)}
                className={`px-3 py-2 rounded-lg text-sm text-left transition-colors ${
                  selectedDoc === doc.filename
                    ? 'bg-port-accent/20 text-port-accent border border-port-accent/30'
                    : 'bg-port-card border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50'
                }`}
              >
                <FileText size={14} className="inline mr-2" />
                {doc.filename}
              </button>
            ))}
            {missingDocs.length > 0 && (
              <div className="hidden sm:block mt-2 space-y-1">
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
          <div className="flex-1 bg-port-card border border-port-border rounded-lg p-4 min-h-[300px] overflow-auto">
            {loadingDoc ? (
              <BrailleSpinner text="Loading document" />
            ) : editing ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-400">Editing {selectedDoc}</span>
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
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  className="w-full h-[500px] bg-[#0d0d0d] text-gray-200 border border-port-border rounded-lg p-3 font-mono text-sm resize-y focus:outline-none focus:border-port-accent/50"
                  spellCheck={false}
                />
              </div>
            ) : docContent ? (
              <div>
                <div className="flex justify-end mb-2">
                  <button
                    onClick={enterEditMode}
                    className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
                  >
                    <Pencil size={14} /> Edit
                  </button>
                </div>
                <MarkdownOutput content={docContent} />
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
