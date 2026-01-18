import { useState, useEffect } from 'react';
import {
  FileText,
  Plus,
  Trash2,
  Save,
  X,
  Eye,
  Edit2,
  Check,
  ToggleLeft,
  ToggleRight,
  Scale
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from 'react-hot-toast';

import { DOCUMENT_CATEGORIES, formatRelativeTime } from '../constants';

export default function DocumentsTab({ onRefresh }) {
  const [documents, setDocuments] = useState([]);
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newDoc, setNewDoc] = useState({ filename: '', title: '', category: 'core', content: '' });
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(() => {
    loadDocuments();
  }, []);

  const loadDocuments = async () => {
    setLoading(true);
    const docs = await api.getSoulDocuments().catch(() => []);
    setDocuments(docs);
    setLoading(false);
  };

  const loadDocument = async (id) => {
    const doc = await api.getSoulDocument(id);
    setSelectedDoc(doc);
    setEditContent(doc.content);
    setEditMode(false);
  };

  const handleSave = async () => {
    if (!selectedDoc) return;
    setSaving(true);
    await api.updateSoulDocument(selectedDoc.id, { content: editContent });
    toast.success('Document saved');
    await loadDocuments();
    await loadDocument(selectedDoc.id);
    setEditMode(false);
    setSaving(false);
    onRefresh();
  };

  const handleToggleEnabled = async (doc, enabled) => {
    await api.updateSoulDocument(doc.id, { enabled });
    toast.success(enabled ? 'Document enabled' : 'Document disabled');
    await loadDocuments();
    if (selectedDoc?.id === doc.id) {
      await loadDocument(doc.id);
    }
    onRefresh();
  };

  const handleWeightChange = async (doc, weight) => {
    await api.updateSoulDocument(doc.id, { weight });
    toast.success(`Weight set to ${weight}`);
    await loadDocuments();
    if (selectedDoc?.id === doc.id) {
      setSelectedDoc({ ...selectedDoc, weight });
    }
    onRefresh();
  };

  const handleCreate = async () => {
    if (!newDoc.filename || !newDoc.title || !newDoc.content) {
      toast.error('All fields are required');
      return;
    }

    const filename = newDoc.filename.endsWith('.md') ? newDoc.filename : `${newDoc.filename}.md`;

    setSaving(true);
    await api.createSoulDocument({
      ...newDoc,
      filename
    });
    toast.success('Document created');
    await loadDocuments();
    setShowCreate(false);
    setNewDoc({ filename: '', title: '', category: 'core', content: '' });
    setSaving(false);
    onRefresh();
  };

  const handleDelete = async (id) => {
    await api.deleteSoulDocument(id);
    toast.success('Document deleted');
    if (selectedDoc?.id === id) {
      setSelectedDoc(null);
    }
    setDeleteConfirm(null);
    await loadDocuments();
    onRefresh();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading documents...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full gap-4">
      {/* Document List Sidebar */}
      <div className="w-72 flex-shrink-0 bg-port-card rounded-lg border border-port-border overflow-hidden flex flex-col">
        <div className="p-3 border-b border-port-border flex items-center justify-between">
          <h3 className="font-medium text-white">Documents</h3>
          <button
            onClick={() => setShowCreate(true)}
            className="p-1.5 text-gray-400 hover:text-white transition-colors"
            title="Create document"
          >
            <Plus size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {documents.length === 0 ? (
            <div className="p-4 text-center text-gray-500">
              No documents yet
            </div>
          ) : (
            Object.entries(DOCUMENT_CATEGORIES).map(([category, config]) => {
              const categoryDocs = documents.filter(d => d.category === category);
              if (categoryDocs.length === 0) return null;

              return (
                <div key={category} className="border-b border-port-border last:border-b-0">
                  <div className={`px-3 py-2 text-xs font-medium ${config.color} border-l-2`}>
                    {config.label}
                  </div>
                  {categoryDocs.map(doc => (
                    <button
                      key={doc.id}
                      onClick={() => loadDocument(doc.id)}
                      className={`w-full px-3 py-2 text-left hover:bg-port-border transition-colors ${
                        selectedDoc?.id === doc.id ? 'bg-port-accent/10 border-l-2 border-port-accent' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <FileText size={14} className={doc.enabled ? 'text-white' : 'text-gray-500'} />
                        <span className={`text-sm truncate ${doc.enabled ? 'text-white' : 'text-gray-500'}`}>
                          {doc.title}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {formatRelativeTime(doc.lastModified)}
                      </div>
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Document Editor */}
      <div className="flex-1 bg-port-card rounded-lg border border-port-border overflow-hidden flex flex-col">
        {selectedDoc ? (
          <>
            {/* Editor Header */}
            <div className="p-3 border-b border-port-border flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h3 className="font-medium text-white">{selectedDoc.title}</h3>
                <span className={`text-xs px-2 py-0.5 rounded ${DOCUMENT_CATEGORIES[selectedDoc.category]?.color}`}>
                  {DOCUMENT_CATEGORIES[selectedDoc.category]?.label}
                </span>
                {selectedDoc.version && (
                  <span className="text-xs text-gray-500">v{selectedDoc.version}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* Weight Control */}
                <div className="flex items-center gap-2 px-2 py-1 bg-port-bg rounded border border-port-border" title="Document weight (1-10): Higher weight = included first when truncating">
                  <Scale size={14} className="text-gray-500" />
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={selectedDoc.weight || 5}
                    onChange={(e) => handleWeightChange(selectedDoc, parseInt(e.target.value))}
                    className="w-16 h-1 accent-port-accent"
                  />
                  <span className="text-xs text-gray-400 w-4">{selectedDoc.weight || 5}</span>
                </div>
                <button
                  onClick={() => handleToggleEnabled(selectedDoc, !selectedDoc.enabled)}
                  className={`p-1.5 transition-colors ${
                    selectedDoc.enabled ? 'text-green-400' : 'text-gray-500'
                  }`}
                  title={selectedDoc.enabled ? 'Disable for CoS injection' : 'Enable for CoS injection'}
                >
                  {selectedDoc.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
                </button>
                {editMode ? (
                  <>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="p-1.5 text-green-400 hover:text-green-300 transition-colors disabled:opacity-50"
                      title="Save"
                    >
                      <Save size={18} />
                    </button>
                    <button
                      onClick={() => {
                        setEditContent(selectedDoc.content);
                        setEditMode(false);
                      }}
                      className="p-1.5 text-gray-400 hover:text-white transition-colors"
                      title="Cancel"
                    >
                      <X size={18} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setEditMode(true)}
                      className="p-1.5 text-gray-400 hover:text-white transition-colors"
                      title="Edit"
                    >
                      <Edit2 size={18} />
                    </button>
                    <button
                      onClick={() => setDeleteConfirm(selectedDoc.id)}
                      className="p-1.5 text-gray-400 hover:text-red-400 transition-colors"
                      title="Delete"
                    >
                      <Trash2 size={18} />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Editor Content */}
            <div className="flex-1 overflow-auto">
              {editMode ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full h-full p-4 bg-port-bg text-white font-mono text-sm resize-none focus:outline-none"
                  placeholder="Write your soul document here..."
                />
              ) : (
                <pre className="p-4 text-sm text-gray-300 whitespace-pre-wrap font-mono">
                  {selectedDoc.content}
                </pre>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <div className="text-center">
              <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Select a document to view or edit</p>
            </div>
          </div>
        )}
      </div>

      {/* Create Document Modal */}
      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-port-card rounded-lg border border-port-border w-full max-w-lg p-6">
            <h2 className="text-lg font-semibold text-white mb-4">Create Soul Document</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Filename</label>
                <input
                  type="text"
                  value={newDoc.filename}
                  onChange={(e) => setNewDoc({ ...newDoc, filename: e.target.value })}
                  placeholder="DOCUMENT_NAME.md"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Title</label>
                <input
                  type="text"
                  value={newDoc.title}
                  onChange={(e) => setNewDoc({ ...newDoc, title: e.target.value })}
                  placeholder="Document title"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
                />
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Category</label>
                <select
                  value={newDoc.category}
                  onChange={(e) => setNewDoc({ ...newDoc, category: e.target.value })}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white"
                >
                  {Object.entries(DOCUMENT_CATEGORIES).map(([key, config]) => (
                    <option key={key} value={key}>{config.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-1">Content</label>
                <textarea
                  value={newDoc.content}
                  onChange={(e) => setNewDoc({ ...newDoc, content: e.target.value })}
                  placeholder="# Document Title&#10;&#10;Content here..."
                  rows={10}
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white font-mono text-sm"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setShowCreate(false);
                  setNewDoc({ filename: '', title: '', category: 'core', content: '' });
                }}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={saving}
                className="px-4 py-2 bg-port-accent text-white rounded-lg hover:bg-port-accent/80 disabled:opacity-50"
              >
                {saving ? 'Creating...' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-port-card rounded-lg border border-port-border p-6 max-w-md">
            <h2 className="text-lg font-semibold text-white mb-2">Delete Document?</h2>
            <p className="text-gray-400 mb-6">
              This action cannot be undone. The document will be permanently deleted.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
