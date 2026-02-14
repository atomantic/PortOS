import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../../../services/api';
import socket from '../../../services/socket';
import {
  Send,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  CheckCheck,
  Edit2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Trash2,
  Save,
  X,
  Brain
} from 'lucide-react';
import toast from 'react-hot-toast';

import {
  DESTINATIONS,
  STATUS_COLORS,
  getConfidenceColor,
  formatRelativeTime
} from '../constants';

export default function InboxTab({ onRefresh, settings }) {
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [entries, setEntries] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [showNeedsReview, setShowNeedsReview] = useState(true);
  const [showFiled, setShowFiled] = useState(true);
  const [fixingId, setFixingId] = useState(null);
  const [fixDestination, setFixDestination] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const inputRef = useRef(null);

  const fetchInbox = useCallback(async () => {
    const data = await api.getBrainInbox().catch(() => ({ entries: [], counts: {} }));
    setEntries(data.entries || []);
    setCounts(data.counts || {});
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchInbox();
  }, [fetchInbox]);

  // Listen for background classification results
  useEffect(() => {
    const handleClassified = (data) => {
      if (data.status === 'filed') {
        toast.success(`Classified as ${data.destination}: ${data.title}`);
      } else if (data.error) {
        toast.error(`Classification failed: ${data.error}`);
      } else {
        toast(`Low confidence (${Math.round((data.confidence || 0) * 100)}%) — needs review`, { icon: '🤔' });
      }
      fetchInbox();
      onRefresh?.();
    };

    socket.on('brain:classified', handleClassified);
    return () => socket.off('brain:classified', handleClassified);
  }, [fetchInbox, onRefresh]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!inputText.trim() || sending) return;

    setSending(true);
    const result = await api.captureBrainThought(inputText.trim()).catch(err => {
      toast.error(err.message || 'Failed to capture thought');
      return null;
    });
    setSending(false);

    if (result) {
      toast.success(result.message || 'Thought captured');
      setInputText('');
      fetchInbox();
      onRefresh?.();
    }
  };

  const handleResolve = async (entryId, destination) => {
    const result = await api.resolveBrainReview(entryId, destination).catch(err => {
      toast.error(err.message || 'Failed to resolve');
      return null;
    });

    if (result) {
      toast.success(`Filed to ${destination}`);
      fetchInbox();
      onRefresh?.();
    }
  };

  const handleRetry = async (entryId) => {
    const result = await api.retryBrainClassification(entryId).catch(err => {
      toast.error(err.message || 'Failed to retry');
      return null;
    });

    if (result) {
      toast.success(result.message || 'Reclassified');
      fetchInbox();
      onRefresh?.();
    }
  };

  const handleFix = async (entryId) => {
    if (!fixDestination) {
      toast.error('Select a destination');
      return;
    }

    const result = await api.fixBrainClassification(entryId, fixDestination).catch(err => {
      toast.error(err.message || 'Failed to fix');
      return null;
    });

    if (result) {
      toast.success(`Moved to ${fixDestination}`);
      setFixingId(null);
      setFixDestination('');
      fetchInbox();
      onRefresh?.();
    }
  };

  const handleEdit = (entry) => {
    setEditingId(entry.id);
    setEditText(entry.capturedText);
  };

  const handleSaveEdit = async (entryId) => {
    if (!editText.trim()) {
      toast.error('Text cannot be empty');
      return;
    }

    const result = await api.updateBrainInboxEntry(entryId, editText.trim()).catch(err => {
      toast.error(err.message || 'Failed to update');
      return null;
    });

    if (result) {
      toast.success('Entry updated');
      setEditingId(null);
      setEditText('');
      fetchInbox();
      onRefresh?.();
    }
  };

  const handleCancelEdit = () => {
    setEditingId(null);
    setEditText('');
  };

  const handleDelete = async (entryId) => {
    await api.deleteBrainInboxEntry(entryId).catch(err => {
      toast.error(err.message || 'Failed to delete');
      return null;
    });

    toast.success('Entry deleted');
    setConfirmingDeleteId(null);
    fetchInbox();
    onRefresh?.();
  };

  const handleMarkDone = async (entryId) => {
    const result = await api.markBrainInboxDone(entryId).catch(err => {
      toast.error(err.message || 'Failed to mark done');
      return null;
    });

    if (result) {
      toast.success('Marked as done');
      fetchInbox();
      onRefresh?.();
    }
  };

  const classifyingEntries = entries.filter(e => e.status === 'classifying');
  const needsReviewEntries = entries.filter(e => e.status === 'needs_review');
  const filedEntries = entries.filter(e => e.status === 'filed' || e.status === 'corrected');
  const doneEntries = entries.filter(e => e.status === 'done');
  const errorEntries = entries.filter(e => e.status === 'error');

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-port-accent animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto">
      {/* Capture input */}
      <form onSubmit={handleSubmit} className="mb-6">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="One thought at a time..."
            className="flex-1 px-4 py-3 bg-port-card border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-port-accent"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || !inputText.trim()}
            className="px-4 py-3 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            title={sending ? "Capturing..." : "Capture thought"}
          >
            {sending ? (
              <RefreshCw className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Capture a thought. AI will classify and route it automatically.
          {settings?.confidenceThreshold && (
            <span> Confidence threshold: {Math.round(settings.confidenceThreshold * 100)}%</span>
          )}
        </p>
      </form>

      {/* Classifying section */}
      {classifyingEntries.length > 0 && (
        <div className="mb-4">
          <div className="flex items-center gap-2 text-port-accent font-medium mb-2">
            <Brain size={16} className="animate-pulse" />
            Classifying ({classifyingEntries.length})
          </div>
          <div className="space-y-2">
            {classifyingEntries.map(entry => (
              <div
                key={entry.id}
                className="p-3 bg-port-card border border-port-accent/30 rounded-lg"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-white flex-1">{entry.capturedText}</p>
                  <div className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-port-accent animate-spin" />
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {formatRelativeTime(entry.capturedAt)}
                    </span>
                  </div>
                </div>
                <p className="text-xs text-port-accent mt-1">AI is classifying this thought...</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Needs Review section */}
      {needsReviewEntries.length > 0 && (
        <div className="mb-4">
          <button
            onClick={() => setShowNeedsReview(!showNeedsReview)}
            className="flex items-center gap-2 text-port-warning font-medium mb-2"
          >
            {showNeedsReview ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <AlertCircle size={16} />
            Needs Review ({needsReviewEntries.length})
          </button>

          {showNeedsReview && (
            <div className="space-y-2">
              {needsReviewEntries.map(entry => (
                <div
                  key={entry.id}
                  className="p-3 bg-port-card border border-port-warning/30 rounded-lg"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    {editingId === entry.id ? (
                      <div className="flex-1 flex gap-2">
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm resize-none"
                          rows={3}
                          autoFocus
                        />
                        <div className="flex flex-col gap-1">
                          <button
                            onClick={() => handleSaveEdit(entry.id)}
                            className="p-1 text-port-success hover:bg-port-success/20 rounded transition-colors"
                            title="Save changes"
                          >
                            <Save size={14} />
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            className="p-1 text-gray-400 hover:bg-port-border/50 rounded transition-colors"
                            title="Cancel editing"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="text-white flex-1">{entry.capturedText}</p>
                        <div className="flex gap-1">
                          <button
                            onClick={() => handleEdit(entry)}
                            className="p-1 text-gray-400 hover:text-white transition-colors"
                            title="Edit text"
                          >
                            <Edit2 size={14} />
                          </button>
                          <button
                            onClick={() => setConfirmingDeleteId(entry.id)}
                            className="p-1 text-gray-400 hover:text-port-error transition-colors"
                            title="Delete entry"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </>
                    )}
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {formatRelativeTime(entry.capturedAt)}
                    </span>
                  </div>

                  {entry.classification?.reasons && (
                    <p className="text-xs text-gray-500 mb-2">
                      {entry.classification.reasons.join(' • ')}
                    </p>
                  )}

                  {confirmingDeleteId === entry.id ? (
                    <div className="flex items-center gap-2 p-2 bg-port-error/10 border border-port-error/30 rounded">
                      <span className="text-xs text-white flex-1">Delete this entry? This cannot be undone.</span>
                      <button
                        onClick={() => handleDelete(entry.id)}
                        className="px-2 py-1 text-xs bg-port-error text-white rounded hover:bg-port-error/80 transition-colors"
                        title="Confirm delete"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmingDeleteId(null)}
                        className="px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
                        title="Cancel delete"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : editingId !== entry.id && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-gray-500">Route to:</span>
                      {['people', 'projects', 'ideas', 'admin'].map(dest => {
                        const destInfo = DESTINATIONS[dest];
                        const Icon = destInfo.icon;
                        return (
                          <button
                            key={dest}
                            onClick={() => handleResolve(entry.id, dest)}
                            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${destInfo.color} hover:opacity-80 transition-opacity`}
                            title={`Route to ${destInfo.label}`}
                          >
                            <Icon size={12} />
                            {destInfo.label}
                          </button>
                        );
                      })}
                      <button
                        onClick={() => handleMarkDone(entry.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-port-success transition-colors"
                        title="Mark as done without filing"
                      >
                        <CheckCheck size={12} />
                        Done
                      </button>
                      <button
                        onClick={() => handleRetry(entry.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-white transition-colors"
                        title="Retry AI classification"
                      >
                        <RefreshCw size={12} />
                        Retry AI
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Error entries */}
      {errorEntries.length > 0 && (
        <div className="mb-4">
          <div className="text-port-error font-medium mb-2 flex items-center gap-2">
            <AlertCircle size={16} />
            Errors ({errorEntries.length})
          </div>
          <div className="space-y-2">
            {errorEntries.map(entry => (
              <div
                key={entry.id}
                className="p-3 bg-port-card border border-port-error/30 rounded-lg"
              >
                <div className="flex items-start justify-between gap-2 mb-1">
                  {editingId === entry.id ? (
                    <div className="flex-1 flex gap-2">
                      <textarea
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm resize-none"
                        rows={3}
                        autoFocus
                      />
                      <div className="flex flex-col gap-1">
                        <button
                          onClick={() => handleSaveEdit(entry.id)}
                          className="p-1 text-port-success hover:bg-port-success/20 rounded transition-colors"
                          title="Save changes"
                        >
                          <Save size={14} />
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          className="p-1 text-gray-400 hover:bg-port-border/50 rounded transition-colors"
                          title="Cancel editing"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="text-white flex-1">{entry.capturedText}</p>
                      <div className="flex gap-1">
                        <button
                          onClick={() => handleEdit(entry)}
                          className="p-1 text-gray-400 hover:text-white transition-colors"
                          title="Edit text"
                        >
                          <Edit2 size={14} />
                        </button>
                        <button
                          onClick={() => setConfirmingDeleteId(entry.id)}
                          className="p-1 text-gray-400 hover:text-port-error transition-colors"
                          title="Delete entry"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </>
                  )}
                </div>
                <p className="text-xs text-port-error mb-2">{entry.error?.message || 'Unknown error'}</p>
                {confirmingDeleteId === entry.id ? (
                  <div className="flex items-center gap-2 p-2 bg-port-error/10 border border-port-error/30 rounded">
                    <span className="text-xs text-white flex-1">Delete this entry? This cannot be undone.</span>
                    <button
                      onClick={() => handleDelete(entry.id)}
                      className="px-2 py-1 text-xs bg-port-error text-white rounded hover:bg-port-error/80 transition-colors"
                      title="Confirm delete"
                    >
                      Delete
                    </button>
                    <button
                      onClick={() => setConfirmingDeleteId(null)}
                      className="px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
                      title="Cancel delete"
                    >
                      Cancel
                    </button>
                  </div>
                ) : editingId !== entry.id && (
                  <button
                    onClick={() => handleRetry(entry.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-white transition-colors"
                    title="Retry AI classification"
                  >
                    <RefreshCw size={12} />
                    Retry
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filed entries */}
      <div>
        <button
          onClick={() => setShowFiled(!showFiled)}
          className="flex items-center gap-2 text-port-success font-medium mb-2"
        >
          {showFiled ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <CheckCircle size={16} />
          Filed ({filedEntries.length})
        </button>

        {showFiled && (
          <div className="space-y-2">
            {filedEntries.map(entry => {
              const destInfo = DESTINATIONS[entry.classification?.destination || 'unknown'];
              const DestIcon = destInfo.icon;
              const confidence = entry.classification?.confidence || 0;
              const isCorrected = entry.status === 'corrected';

              return (
                <div
                  key={entry.id}
                  className={`p-3 bg-port-card border rounded-lg ${
                    isCorrected ? 'border-blue-500/30' : 'border-port-border'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex-1">
                      <p className="text-white">{entry.capturedText}</p>
                      {entry.classification?.title && (
                        <p className="text-sm text-gray-400 mt-1">
                          → {entry.classification.title}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setConfirmingDeleteId(entry.id)}
                        className="p-1 text-gray-400 hover:text-port-error transition-colors"
                        title="Delete entry"
                      >
                        <Trash2 size={14} />
                      </button>
                      <span className="text-xs text-gray-500 whitespace-nowrap">
                        {formatRelativeTime(entry.capturedAt)}
                      </span>
                    </div>
                  </div>

                  {confirmingDeleteId === entry.id && (
                    <div className="flex items-center gap-2 p-2 bg-port-error/10 border border-port-error/30 rounded mb-2">
                      <span className="text-xs text-white flex-1">Delete this entry? This cannot be undone.</span>
                      <button
                        onClick={() => handleDelete(entry.id)}
                        className="px-2 py-1 text-xs bg-port-error text-white rounded hover:bg-port-error/80 transition-colors"
                        title="Confirm delete"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmingDeleteId(null)}
                        className="px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
                        title="Cancel delete"
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${destInfo.color}`}>
                      <DestIcon size={12} />
                      {destInfo.label}
                    </span>

                    <span className={`text-xs ${getConfidenceColor(confidence)}`}>
                      {Math.round(confidence * 100)}%
                    </span>

                    {isCorrected && (
                      <span className="text-xs text-blue-400">
                        (corrected from {entry.correction?.previousDestination})
                      </span>
                    )}

                    {entry.filed?.destinationId && (
                      <button
                        onClick={() => {
                          // Navigate to the record in memory tab
                          window.location.href = `/brain/memory?type=${entry.filed.destination}&id=${entry.filed.destinationId}`;
                        }}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-white transition-colors"
                        title="View in Memory"
                      >
                        <ExternalLink size={12} />
                        View
                      </button>
                    )}

                    {/* Done button */}
                    <button
                      onClick={() => handleMarkDone(entry.id)}
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-port-success transition-colors"
                      title="Mark as done"
                    >
                      <CheckCheck size={12} />
                      Done
                    </button>

                    {/* Fix button */}
                    {fixingId === entry.id ? (
                      <div className="flex items-center gap-2">
                        <select
                          value={fixDestination}
                          onChange={(e) => setFixDestination(e.target.value)}
                          className="px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
                          title="Select new destination"
                        >
                          <option value="">Select...</option>
                          {['people', 'projects', 'ideas', 'admin']
                            .filter(d => d !== entry.filed?.destination)
                            .map(d => (
                              <option key={d} value={d}>{DESTINATIONS[d].label}</option>
                            ))}
                        </select>
                        <button
                          onClick={() => handleFix(entry.id)}
                          className="px-2 py-1 text-xs rounded bg-port-accent/20 text-port-accent hover:bg-port-accent/30"
                          title="Move to selected destination"
                        >
                          Move
                        </button>
                        <button
                          onClick={() => { setFixingId(null); setFixDestination(''); }}
                          className="px-2 py-1 text-xs text-gray-400 hover:text-white"
                          title="Cancel fix"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setFixingId(entry.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-400 hover:text-white transition-colors"
                        title="Fix/move to different destination"
                      >
                        <Edit2 size={12} />
                        Fix
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {filedEntries.length === 0 && (
              <p className="text-gray-500 text-sm">No filed entries yet. Start capturing thoughts above.</p>
            )}
          </div>
        )}
      </div>

      {/* Done entries */}
      {doneEntries.length > 0 && (
        <div className="mt-4">
          <button
            onClick={() => setShowDone(!showDone)}
            className="flex items-center gap-2 text-gray-400 font-medium mb-2"
          >
            {showDone ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <CheckCheck size={16} />
            Done ({doneEntries.length})
          </button>

          {showDone && (
            <div className="space-y-2">
              {doneEntries.map(entry => {
                const destInfo = DESTINATIONS[entry.classification?.destination || 'unknown'];
                const DestIcon = destInfo.icon;

                return (
                  <div
                    key={entry.id}
                    className="p-3 bg-port-card border border-port-border/50 rounded-lg opacity-60"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex-1">
                        <p className="text-gray-400 line-through">{entry.capturedText}</p>
                        {entry.classification?.title && (
                          <p className="text-sm text-gray-500 mt-1">
                            → {entry.classification.title}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1">
                        <button
                          onClick={() => setConfirmingDeleteId(entry.id)}
                          className="p-1 text-gray-500 hover:text-port-error transition-colors"
                          title="Delete entry"
                        >
                          <Trash2 size={14} />
                        </button>
                        <span className="text-xs text-gray-600 whitespace-nowrap">
                          {formatRelativeTime(entry.doneAt || entry.capturedAt)}
                        </span>
                      </div>
                    </div>

                    {confirmingDeleteId === entry.id && (
                      <div className="flex items-center gap-2 p-2 bg-port-error/10 border border-port-error/30 rounded mb-2">
                        <span className="text-xs text-white flex-1">Delete this entry? This cannot be undone.</span>
                        <button
                          onClick={() => handleDelete(entry.id)}
                          className="px-2 py-1 text-xs bg-port-error text-white rounded hover:bg-port-error/80 transition-colors"
                          title="Confirm delete"
                        >
                          Delete
                        </button>
                        <button
                          onClick={() => setConfirmingDeleteId(null)}
                          className="px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
                          title="Cancel delete"
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <span className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${destInfo.color}`}>
                        <DestIcon size={12} />
                        {destInfo.label}
                      </span>
                      {entry.filed?.destinationId && (
                        <button
                          onClick={() => {
                            window.location.href = `/brain/memory?type=${entry.filed.destination}&id=${entry.filed.destinationId}`;
                          }}
                          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border text-gray-500 hover:text-white transition-colors"
                          title="View in Memory"
                        >
                          <ExternalLink size={12} />
                          View
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
