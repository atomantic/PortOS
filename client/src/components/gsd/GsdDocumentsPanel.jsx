import { useState, useEffect } from 'react';
import { FileText, Pencil, Save, X } from 'lucide-react';
import toast from 'react-hot-toast';
import BrailleSpinner from '../BrailleSpinner';
import MarkdownOutput from '../cos/MarkdownOutput';
import * as api from '../../services/api';

const DOCUMENTS = [
  { key: 'PROJECT.md', label: 'Project' },
  { key: 'ROADMAP.md', label: 'Roadmap' },
  { key: 'STATE.md', label: 'State' },
  { key: 'CONCERNS.md', label: 'Concerns' },
  { key: 'RETROSPECTIVE.md', label: 'Retrospective' },
  { key: 'MILESTONES.md', label: 'Milestones' },
];

export default function GsdDocumentsPanel({ appId, selectedDoc, onSelectDoc }) {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!selectedDoc) return;
    setEditing(false);
    setLoading(true);
    api.getGsdDocument(appId, selectedDoc)
      .then(data => setContent(data?.content || null))
      .catch(() => setContent(null))
      .finally(() => setLoading(false));
  }, [appId, selectedDoc]);

  const enterEditMode = () => {
    setEditContent(content || '');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setEditContent('');
  };

  const handleSave = async () => {
    setSaving(true);
    const result = await api.saveGsdDocument(appId, selectedDoc, editContent).catch(() => null);
    setSaving(false);

    if (!result) {
      toast.error('Failed to save document');
      return;
    }

    if (result.noChanges) {
      toast('No changes to commit', { icon: '\u2139\uFE0F' });
      setEditing(false);
      return;
    }

    toast.success(`Committed ${result.created ? 'new' : 'updated'} ${selectedDoc} (${result.hash})`);
    setContent(editContent);
    setEditing(false);
  };

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Documents</h4>
      <div className="flex flex-col sm:flex-row gap-4">
        {/* Document pills */}
        <div className="flex sm:flex-col gap-1.5 flex-wrap sm:w-36 shrink-0">
          {DOCUMENTS.map(doc => (
            <button
              key={doc.key}
              onClick={() => onSelectDoc(doc.key)}
              className={`px-3 py-1.5 rounded-lg text-xs text-left transition-colors flex items-center gap-1.5 ${
                selectedDoc === doc.key
                  ? 'bg-port-accent/20 text-port-accent border border-port-accent/30'
                  : 'bg-port-card border border-port-border text-gray-400 hover:text-white hover:bg-port-border/50'
              }`}
            >
              <FileText size={12} />
              {doc.label}
            </button>
          ))}
        </div>

        {/* Content area */}
        <div className="flex-1 bg-port-card border border-port-border rounded-lg p-4 min-h-[250px] overflow-auto">
          {!selectedDoc ? (
            <p className="text-gray-500 text-sm">Select a document to view</p>
          ) : loading ? (
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
          ) : content ? (
            <div>
              <div className="flex justify-end mb-2">
                <button
                  onClick={enterEditMode}
                  className="px-3 py-1.5 bg-port-border hover:bg-port-border/80 text-white rounded-lg text-xs flex items-center gap-1"
                >
                  <Pencil size={14} /> Edit
                </button>
              </div>
              <MarkdownOutput content={content} />
            </div>
          ) : (
            <p className="text-gray-500 text-sm">Document not found or empty</p>
          )}
        </div>
      </div>
    </div>
  );
}
