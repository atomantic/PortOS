import { useState, useEffect } from 'react';
import { X, Save, Plus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import { MEMORY_TYPES, MEMORY_TYPE_COLORS } from '../constants';
import { getAppName } from '../../../utils/formatters';

export default function MemoryEditModal({ memory, apps, onSave, onClose }) {
  const [formData, setFormData] = useState({
    content: memory.content || '',
    summary: memory.summary || '',
    type: memory.type || 'observation',
    category: memory.category || 'other',
    tags: memory.tags || [],
    sourceAppId: memory.sourceAppId || '',
    importance: memory.importance || 0.5,
    confidence: memory.confidence || 0.8
  });
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [fullMemory, setFullMemory] = useState(null);

  // Fetch full memory data if we only have index data
  useEffect(() => {
    const fetchFullMemory = async () => {
      if (!memory.content && memory.id) {
        const full = await api.getMemory(memory.id).catch(() => null);
        if (full) {
          setFullMemory(full);
          setFormData({
            content: full.content || '',
            summary: full.summary || '',
            type: full.type || 'observation',
            category: full.category || 'other',
            tags: full.tags || [],
            sourceAppId: full.sourceAppId || '',
            importance: full.importance || 0.5,
            confidence: full.confidence || 0.8
          });
        }
      }
    };
    fetchFullMemory();
  }, [memory]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!formData.content.trim()) {
      toast.error('Content is required');
      return;
    }

    setSaving(true);
    const result = await api.updateMemory(memory.id, {
      content: formData.content,
      summary: formData.summary || undefined,
      type: formData.type,
      category: formData.category,
      tags: formData.tags,
      sourceAppId: formData.sourceAppId || null,
      importance: formData.importance,
      confidence: formData.confidence
    }).catch(err => {
      toast.error(err.message || 'Failed to update memory');
      return null;
    });
    setSaving(false);

    if (result) {
      toast.success('Memory updated');
      onSave(result);
    }
  };

  const handleAddTag = () => {
    const tag = newTag.trim().toLowerCase();
    if (tag && !formData.tags.includes(tag)) {
      setFormData({ ...formData, tags: [...formData.tags, tag] });
      setNewTag('');
    }
  };

  const handleRemoveTag = (tagToRemove) => {
    setFormData({ ...formData, tags: formData.tags.filter(t => t !== tagToRemove) });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddTag();
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 w-full max-w-2xl max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg sm:text-xl font-bold text-white">Edit Memory</h2>
          <button
            onClick={onClose}
            className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-500 hover:text-white transition-colors rounded-lg"
          >
            <X size={22} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Type */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">Type</label>
            <div className="flex flex-wrap gap-2">
              {MEMORY_TYPES.map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setFormData({ ...formData, type })}
                  className={`px-4 py-2 min-h-[40px] text-sm rounded-lg border transition-colors ${
                    formData.type === type
                      ? MEMORY_TYPE_COLORS[type]
                      : 'border-port-border text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {type}
                </button>
              ))}
            </div>
          </div>

          {/* Content */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Content <span className="text-port-accent">*</span>
            </label>
            <textarea
              value={formData.content}
              onChange={e => setFormData({ ...formData, content: e.target.value })}
              placeholder="Memory content..."
              rows={5}
              className="w-full px-3 py-3 min-h-[120px] bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none resize-none"
              autoFocus
            />
            <p className="text-xs text-gray-500 mt-1">
              Editing content will regenerate the embedding for semantic search.
            </p>
          </div>

          {/* Summary */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">Summary (optional)</label>
            <input
              type="text"
              value={formData.summary}
              onChange={e => setFormData({ ...formData, summary: e.target.value })}
              placeholder="Brief summary..."
              className="w-full px-3 py-3 min-h-[44px] bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
            />
          </div>

          {/* Category and App */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-2">Category</label>
              <select
                value={formData.category}
                onChange={e => setFormData({ ...formData, category: e.target.value })}
                className="w-full px-3 py-3 min-h-[44px] bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
              >
                <option value="other">Other</option>
                <option value="codebase">Codebase</option>
                <option value="workflow">Workflow</option>
                <option value="tools">Tools</option>
                <option value="architecture">Architecture</option>
                <option value="patterns">Patterns</option>
                <option value="conventions">Conventions</option>
                <option value="preferences">Preferences</option>
                <option value="system">System</option>
                <option value="project">Project</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-2">Associated App</label>
              <select
                value={formData.sourceAppId}
                onChange={e => setFormData({ ...formData, sourceAppId: e.target.value })}
                className="w-full px-3 py-3 min-h-[44px] bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
              >
                <option value="">None (General)</option>
                {apps?.map(app => (
                  <option key={app.id} value={app.id}>{app.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">Tags</label>
            <div className="flex flex-wrap gap-2 mb-3">
              {formData.tags.map(tag => (
                <span
                  key={tag}
                  className="flex items-center gap-2 px-3 py-2 min-h-[36px] bg-port-border rounded-lg text-sm text-gray-300"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => handleRemoveTag(tag)}
                    className="p-1 min-w-[24px] min-h-[24px] flex items-center justify-center text-gray-500 hover:text-port-error transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newTag}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Add tag..."
                className="flex-1 px-3 py-3 min-h-[44px] bg-port-bg border border-port-border rounded-lg text-white text-sm focus:border-port-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddTag}
                disabled={!newTag.trim()}
                className="px-4 py-3 min-h-[44px] min-w-[44px] flex items-center justify-center bg-port-border hover:bg-port-border/70 text-gray-300 rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Plus size={20} />
              </button>
            </div>
          </div>

          {/* Importance and Confidence */}
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-2">
                Importance: {(formData.importance * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={formData.importance}
                onChange={e => setFormData({ ...formData, importance: parseFloat(e.target.value) })}
                className="w-full h-8 accent-port-accent"
              />
            </div>
            <div className="flex-1">
              <label className="block text-sm text-gray-400 mb-2">
                Confidence: {(formData.confidence * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={formData.confidence}
                onChange={e => setFormData({ ...formData, confidence: parseFloat(e.target.value) })}
                className="w-full h-8 accent-port-accent"
              />
            </div>
          </div>

          {/* Source Info (read-only) */}
          {(memory.sourceTaskId || memory.sourceAgentId || (fullMemory?.sourceTaskId) || (fullMemory?.sourceAgentId)) && (
            <div className="text-xs text-gray-500 p-3 bg-port-bg rounded-lg">
              <div className="font-medium mb-1">Source Information</div>
              {(memory.sourceTaskId || fullMemory?.sourceTaskId) && (
                <div>Task: {memory.sourceTaskId || fullMemory?.sourceTaskId}</div>
              )}
              {(memory.sourceAgentId || fullMemory?.sourceAgentId) && (
                <div>Agent: {memory.sourceAgentId || fullMemory?.sourceAgentId}</div>
              )}
              {formData.sourceAppId && (
                <div>App: {getAppName(formData.sourceAppId, apps, formData.sourceAppId)}</div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-3 min-h-[44px] text-sm text-gray-400 hover:text-white transition-colors rounded-lg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !formData.content.trim()}
              className="flex items-center justify-center gap-2 px-5 py-3 min-h-[44px] bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Save size={18} />
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
