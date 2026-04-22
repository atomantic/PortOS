import { useState, useEffect, useCallback } from 'react';
import {
  Archive,
  Plus,
  Trash2,
  Eye,
  GitCompare,
  RefreshCw,
  Calendar,
  FileText,
  Target,
  BookOpen,
  Dna,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  X
} from 'lucide-react';
import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import { formatBytes, formatDateTime, timeAgo } from '../../../utils/formatters';

export default function TimeCapsuleTab({ onRefresh: _onRefresh }) {
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  // Create form
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');

  // Detail view
  const [viewingSnapshot, setViewingSnapshot] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);

  // Compare
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState([]);
  const [compareResult, setCompareResult] = useState(null);
  const [comparing, setComparing] = useState(false);

  // Delete confirmation
  const [confirmDelete, setConfirmDelete] = useState(null);

  const loadSnapshots = useCallback(async () => {
    setLoading(true);
    const data = await api.listTimeCapsuleSnapshots().catch(() => []);
    setSnapshots(data);
    setLoading(false);
  }, []);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  const handleCreate = async () => {
    if (!label.trim()) return;
    setCreating(true);
    const snapshot = await api.createTimeCapsuleSnapshot(label.trim(), description.trim()).catch(() => null);
    setCreating(false);
    if (!snapshot) return;
    setSnapshots(prev => [snapshot, ...prev]);
    setLabel('');
    setDescription('');
    setShowForm(false);
    toast.success(`Snapshot "${snapshot.label}" created`);
  };

  const handleDelete = async (id) => {
    const snap = snapshots.find(s => s.id === id);
    const ok = await api.deleteTimeCapsuleSnapshot(id).then(() => true).catch(() => false);
    if (!ok) return;
    setSnapshots(prev => prev.filter(s => s.id !== id));
    setConfirmDelete(null);
    if (viewingSnapshot?.id === id) setViewingSnapshot(null);
    toast.success(`Snapshot "${snap?.label}" deleted`);
  };

  const handleView = async (id) => {
    if (viewingSnapshot?.id === id) {
      setViewingSnapshot(null);
      return;
    }
    setViewLoading(true);
    const data = await api.getTimeCapsuleSnapshot(id).catch(() => null);
    setViewLoading(false);
    if (data) setViewingSnapshot(data);
  };

  const toggleCompareId = (id) => {
    setCompareIds(prev => {
      if (prev.includes(id)) return prev.filter(i => i !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
    setCompareResult(null);
  };

  const handleCompare = async () => {
    if (compareIds.length !== 2) return;
    setComparing(true);
    const result = await api.compareTimeCapsuleSnapshots(compareIds[0], compareIds[1]).catch(() => null);
    setComparing(false);
    if (result) setCompareResult(result);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 text-port-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Archive size={20} />
            Time Capsule
          </h2>
          <p className="text-sm text-gray-500">
            {snapshots.length} snapshot{snapshots.length !== 1 ? 's' : ''} archived
          </p>
        </div>
        <div className="flex gap-2">
          {snapshots.length >= 2 && (
            <button
              onClick={() => {
                setCompareMode(!compareMode);
                setCompareIds([]);
                setCompareResult(null);
              }}
              className={`flex items-center gap-2 px-3 py-2 min-h-[40px] rounded-lg border text-sm transition-colors ${
                compareMode
                  ? 'border-port-accent text-port-accent bg-port-accent/10'
                  : 'border-port-border text-gray-400 hover:text-white hover:border-gray-500'
              }`}
            >
              <GitCompare size={16} />
              Compare
            </button>
          )}
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-4 py-2 min-h-[40px] bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80"
          >
            <Plus size={16} />
            New Snapshot
          </button>
        </div>
      </div>

      {/* Create Form */}
      {showForm && (
        <div className="bg-port-card rounded-lg border border-port-accent/30 p-4">
          <h3 className="font-medium text-white mb-3">Create Snapshot</h3>
          <div className="space-y-3">
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Snapshot label (e.g., Spring 2026, Pre-career-change)"
              className="w-full px-3 py-2 min-h-[40px] bg-port-bg border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
              autoFocus
              onKeyDown={e => e.key === 'Enter' && label.trim() && handleCreate()}
            />
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional notes about this moment in time..."
              rows={2}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-port-accent resize-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => { setShowForm(false); setLabel(''); setDescription(''); }}
                className="px-4 py-2 min-h-[40px] text-gray-400 hover:text-white text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!label.trim() || creating}
                className="flex items-center gap-2 px-4 py-2 min-h-[40px] bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? <RefreshCw size={14} className="animate-spin" /> : <Archive size={14} />}
                {creating ? 'Creating...' : 'Create Snapshot'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Compare Mode Banner */}
      {compareMode && (
        <div className="bg-port-card rounded-lg border border-port-accent/30 p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-gray-400">
            Select 2 snapshots to compare ({compareIds.length}/2 selected)
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => { setCompareMode(false); setCompareIds([]); setCompareResult(null); }}
              className="px-3 py-1.5 min-h-[36px] text-sm text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              onClick={handleCompare}
              disabled={compareIds.length !== 2 || comparing}
              className="flex items-center gap-2 px-4 py-1.5 min-h-[36px] bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {comparing ? <RefreshCw size={14} className="animate-spin" /> : <GitCompare size={14} />}
              Compare
            </button>
          </div>
        </div>
      )}

      {/* Compare Result */}
      {compareResult && (
        <div className="bg-port-card rounded-lg border border-port-border p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-medium text-white flex items-center gap-2">
              <GitCompare size={16} />
              Comparison: {compareResult.snapshot1.label} vs {compareResult.snapshot2.label}
            </h3>
            <button onClick={() => setCompareResult(null)} className="p-1 text-gray-400 hover:text-white">
              <X size={16} />
            </button>
          </div>
          <div className="text-xs text-gray-500 mb-3">
            {formatDateTime(compareResult.snapshot1.createdAt)} &rarr; {formatDateTime(compareResult.snapshot2.createdAt)}
          </div>
          {compareResult.changes.length === 0 ? (
            <p className="text-sm text-gray-500">No differences found between these snapshots.</p>
          ) : (
            <div className="space-y-2">
              {compareResult.changes.map((change, i) => (
                <div key={i} className="flex items-start gap-3 p-2 bg-port-bg rounded-lg text-sm">
                  <span className="text-gray-400 font-medium min-w-[140px] shrink-0">{change.field}</span>
                  {change.before !== undefined && change.after !== undefined ? (
                    <span className="text-gray-300">
                      <span className="text-red-400">{JSON.stringify(change.before)}</span>
                      {' → '}
                      <span className="text-green-400">{JSON.stringify(change.after)}</span>
                    </span>
                  ) : (
                    <span className="text-gray-300">
                      {Array.isArray(change.value) ? change.value.join(', ') : JSON.stringify(change.value)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Empty State */}
      {snapshots.length === 0 && !showForm && (
        <div className="bg-port-card rounded-lg border border-port-border p-8 text-center">
          <Archive className="w-12 h-12 mx-auto mb-4 text-gray-600" />
          <h3 className="text-white font-medium mb-2">No snapshots yet</h3>
          <p className="text-sm text-gray-500 mb-4 max-w-md mx-auto">
            Create your first time capsule to preserve a snapshot of your digital twin.
            Track how your identity evolves over time.
          </p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-2 px-4 py-2 min-h-[40px] bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80"
          >
            <Plus size={16} />
            Create First Snapshot
          </button>
        </div>
      )}

      {/* Snapshot List */}
      {snapshots.length > 0 && (
        <div className="space-y-2">
          {snapshots.map(snap => {
            const isViewing = viewingSnapshot?.id === snap.id;
            const isCompareSelected = compareIds.includes(snap.id);

            return (
              <div key={snap.id}>
                <div className={`bg-port-card rounded-lg border transition-colors ${
                  isCompareSelected ? 'border-port-accent' : 'border-port-border'
                }`}>
                  <div className="flex items-center gap-3 p-3 sm:p-4">
                    {/* Compare checkbox */}
                    {compareMode && (
                      <input
                        type="checkbox"
                        checked={isCompareSelected}
                        onChange={() => toggleCompareId(snap.id)}
                        className="w-5 h-5 shrink-0 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
                      />
                    )}

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-white truncate">{snap.label}</span>
                        <span className="text-xs text-gray-500 shrink-0">{timeAgo(snap.createdAt)}</span>
                      </div>
                      {snap.description && (
                        <p className="text-sm text-gray-500 truncate mb-1">{snap.description}</p>
                      )}
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <FileText size={12} />
                          {snap.summary?.documentCount ?? 0} docs
                        </span>
                        <span className="flex items-center gap-1">
                          <Target size={12} />
                          {snap.summary?.goalsCount ?? 0} goals
                        </span>
                        <span className="flex items-center gap-1">
                          <BookOpen size={12} />
                          {snap.summary?.storiesCount ?? 0} stories
                        </span>
                        {(snap.summary?.genomeMarkers ?? 0) > 0 && (
                          <span className="flex items-center gap-1">
                            <Dna size={12} />
                            {snap.summary.genomeMarkers} markers
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <CheckCircle size={12} />
                          {snap.summary?.testHistoryCount ?? 0} tests
                        </span>
                        <span className="text-gray-600">{formatBytes(snap.sizeBytes)}</span>
                      </div>
                    </div>

                    {/* Actions */}
                    {!compareMode && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleView(snap.id)}
                          className={`p-2 min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg transition-colors ${
                            isViewing ? 'text-port-accent bg-port-accent/10' : 'text-gray-400 hover:text-white hover:bg-port-border'
                          }`}
                          title={isViewing ? 'Close details' : 'View details'}
                        >
                          {viewLoading && viewingSnapshot === null ? (
                            <RefreshCw size={16} className="animate-spin" />
                          ) : isViewing ? (
                            <ChevronUp size={16} />
                          ) : (
                            <ChevronDown size={16} />
                          )}
                        </button>
                        {confirmDelete === snap.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleDelete(snap.id)}
                              className="px-2 py-1 min-h-[40px] text-xs text-red-400 hover:text-red-300 font-medium"
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="px-2 py-1 min-h-[40px] text-xs text-gray-500 hover:text-white"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDelete(snap.id)}
                            className="p-2 min-h-[40px] min-w-[40px] flex items-center justify-center text-gray-400 hover:text-red-400 rounded-lg hover:bg-port-border transition-colors"
                            title="Delete snapshot"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Expanded Detail View */}
                {isViewing && viewingSnapshot && (
                  <div className="bg-port-bg border border-port-border border-t-0 rounded-b-lg p-4 -mt-1">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                      <div>
                        <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Metadata</h4>
                        <div className="space-y-1 text-sm">
                          <div><span className="text-gray-500">Created:</span> <span className="text-gray-300">{formatDateTime(viewingSnapshot.createdAt)}</span></div>
                          <div><span className="text-gray-500">Hash:</span> <span className="text-gray-300 font-mono text-xs">{viewingSnapshot.dataHash}</span></div>
                          <div><span className="text-gray-500">Size:</span> <span className="text-gray-300">{formatBytes(viewingSnapshot.sizeBytes)}</span></div>
                        </div>
                      </div>
                      <div>
                        <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Contents</h4>
                        <div className="space-y-1 text-sm">
                          <div><span className="text-gray-500">Documents:</span> <span className="text-gray-300">{viewingSnapshot.summary?.documentCount} ({viewingSnapshot.summary?.enabledDocuments} enabled)</span></div>
                          <div><span className="text-gray-500">Markdown files:</span> <span className="text-gray-300">{viewingSnapshot.summary?.markdownFiles}</span></div>
                          <div><span className="text-gray-500">Goals:</span> <span className="text-gray-300">{viewingSnapshot.summary?.goalsCount}</span></div>
                          <div><span className="text-gray-500">Stories:</span> <span className="text-gray-300">{viewingSnapshot.summary?.storiesCount}</span></div>
                          <div><span className="text-gray-500">Genome markers:</span> <span className="text-gray-300">{viewingSnapshot.summary?.genomeMarkers}</span></div>
                        </div>
                      </div>
                    </div>

                    {/* Data files included */}
                    {viewingSnapshot.data && (
                      <div>
                        <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Archived Files</h4>
                        <div className="flex flex-wrap gap-1.5">
                          {Object.keys(viewingSnapshot.data).filter(k => k !== 'documents').map(key => (
                            <span key={key} className="px-2 py-1 text-xs bg-port-card border border-port-border rounded text-gray-400">
                              {key}
                            </span>
                          ))}
                          {viewingSnapshot.data.documents && Object.keys(viewingSnapshot.data.documents).map(key => (
                            <span key={key} className="px-2 py-1 text-xs bg-port-card border border-port-border rounded text-gray-400">
                              {key}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Traits snapshot */}
                    {viewingSnapshot.summary?.traits && (
                      <div className="mt-4">
                        <h4 className="text-xs text-gray-500 uppercase tracking-wider mb-2">Personality Traits (at time of snapshot)</h4>
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(viewingSnapshot.summary.traits).filter(([, v]) => typeof v === 'number').map(([key, val]) => (
                            <div key={key} className="bg-port-card border border-port-border rounded px-2 py-1 text-xs">
                              <span className="text-gray-500">{key}:</span>{' '}
                              <span className="text-gray-300">{typeof val === 'number' ? val.toFixed(1) : val}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Info Card */}
      <div className="bg-port-card rounded-lg border border-port-border p-4 text-sm text-gray-500">
        <div className="flex items-start gap-3">
          <Calendar size={16} className="mt-0.5 shrink-0 text-gray-600" />
          <div>
            <p className="text-gray-400 mb-1">Time capsules preserve a complete snapshot of your digital twin — documents, traits, goals, genome markers, autobiography stories, and test history.</p>
            <p>Create snapshots at meaningful moments to track how your identity evolves over time.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
