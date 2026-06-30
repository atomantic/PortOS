import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Sparkles,
  Library,
  Brain
} from 'lucide-react';
import BrailleSpinner from '../../BrailleSpinner';
import toast from '../../ui/Toast';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import { useLocalStorageBool } from '../../../hooks';

import {
  DESTINATIONS,
  getConfidenceColor
} from '../constants';
import { timeAgo } from '../../../utils/formatters';
import VoiceCapture from '../VoiceCapture';

export default function InboxTab({ onRefresh, settings }) {
  const navigate = useNavigate();
  const [inputText, setInputText] = useState('');
  // Sticky "Creative" capture mode (shared localStorage key with Quick Capture):
  // when on, captured thoughts are flagged so they can later be batch-sent to the
  // creative catalog (vs todos/refs that stay out).
  const [creative, setCreative] = useLocalStorageBool('brain.captureCreative', false);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNeedsReview, setShowNeedsReview] = useState(true);
  const [showFiled, setShowFiled] = useState(true);
  const [fixingId, setFixingId] = useState(null);
  const [fixDestination, setFixDestination] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [retryingId, setRetryingId] = useState(null);
  const inputRef = useRef(null);
  const tempIdCounter = useRef(0);

  const fetchInbox = useCallback(async () => {
    const data = await api.getBrainInbox().catch(() => ({ entries: [] }));
    const serverEntries = data.entries || [];
    // Preserve any optimistic entries still pending API confirmation
    setEntries(prev => {
      const pending = prev.filter(e => e.id.startsWith('_pending_'));
      return pending.length ? [...pending, ...serverEntries] : serverEntries;
    });
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
    const text = inputText.trim();
    if (!text) return;

    // Guard against rapid double-clicks before React flushes the cleared input
    const lastText = inputRef.current?.dataset.lastSubmit;
    if (lastText === text) return;
    if (inputRef.current) inputRef.current.dataset.lastSubmit = text;

    const tempId = `_pending_${++tempIdCounter.current}`;
    const optimisticEntry = {
      id: tempId,
      capturedText: text,
      status: 'classifying',
      capturedAt: new Date().toISOString(),
      ...(creative ? { creative: true } : {})
    };
    setInputText('');
    setEntries(prev => [optimisticEntry, ...prev]);

    const result = await api.captureBrainThought(text, undefined, undefined, { creative }).catch(err => {
      toast.error(err.message || 'Failed to capture thought');
      setEntries(prev => prev.filter(e => e.id !== tempId));
      return null;
    });

    if (inputRef.current) inputRef.current.dataset.lastSubmit = '';

    if (result) {
      setEntries(prev => prev.map(e => e.id === tempId ? result.inboxLog : e));
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
    if (retryingId) return;
    setRetryingId(entryId);
    const result = await api.retryBrainClassification(entryId).catch(err => {
      toast.error(err.message || 'Failed to retry');
      return null;
    });
    setRetryingId(null);

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
    let failed = false;
    await api.deleteBrainInboxEntry(entryId).catch(err => {
      toast.error(err.message || 'Failed to delete');
      failed = true;
    });
    if (failed) return;

    toast.success('Entry deleted');
    setConfirmingDeleteId(null);
    setEntries(prev => prev.filter(e => e.id !== entryId));
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

  const handleVoiceTranscript = useCallback((text) => {
    setInputText(prev => prev ? `${prev} ${text}` : text);
  }, []);

  const classifyingEntries = entries.filter(e => e.status === 'classifying');
  const needsReviewEntries = entries.filter(e => e.status === 'needs_review');
  const filedEntries = entries.filter(e => e.status === 'filed' || e.status === 'corrected');
  const doneEntries = entries.filter(e => e.status === 'done');
  const errorEntries = entries.filter(e => e.status === 'error');

  // Creative notes the user flagged at capture, not yet marked done and not yet
  // consumed by a committed catalog ingest — the pool the "Send to Catalog" batch
  // action draws from. `sentToCatalogAt` (stamped on commit, not navigation)
  // drops a note out so it can't be accidentally re-sent. Pending (optimistic)
  // entries are excluded so we never ship a thought the server hasn't confirmed.
  const creativeEntries = entries.filter(
    e => e.creative && e.status !== 'done' && !e.sentToCatalogAt && !String(e.id).startsWith('_pending_')
  );
  // Batch-send creative notes into the catalog ingest flow. We hand the combined
  // text plus the source note ids to /catalog/ingest (router state) where the
  // user runs extract→review→commit — turning loose creative thoughts into typed
  // catalog ingredients. On commit the catalog page stamps these ids consumed.
  const handleSendCreativeToCatalog = () => {
    if (!creativeEntries.length) return;
    const rawText = creativeEntries
      .map(e => e.capturedText)
      .filter(Boolean)
      .join('\n\n---\n\n');
    const creativeNoteIds = creativeEntries.map(e => e.id);
    navigate('/catalog/ingest', { state: { prefill: { title: 'Creative notes from Brain', rawText, creativeNoteIds } } });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  // Compact per-status overview rendered in the desktop rail so the page reads
  // as a dashboard rather than a centered document.
  const overviewStats = [
    { label: 'Needs review', value: needsReviewEntries.length, className: 'text-port-warning' },
    { label: 'Classifying', value: classifyingEntries.length, className: 'text-port-accent' },
    { label: 'Filed', value: filedEntries.length, className: 'text-port-success' },
    { label: 'Done', value: doneEntries.length, className: 'text-gray-400' },
    { label: 'Errors', value: errorEntries.length, className: 'text-port-error' }
  ];

  return (
    // Full-bleed dashboard grid: capture form spans the top, filed/done entries
    // fill the main column, and a persistent stats + Needs-Review rail sits on
    // the right at xl+. Below xl it collapses to a single column (mobile flow:
    // form → Needs Review → entries).
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4 content-start">
      {/* Capture input — spans both columns */}
      <form onSubmit={handleSubmit} className="xl:col-span-2">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="One thought at a time..."
            className="flex-1 px-4 py-3 bg-port-card border border-port-border rounded-lg text-white placeholder-gray-500 focus:outline-hidden focus:border-port-accent"
          />
          <VoiceCapture onTranscript={handleVoiceTranscript} />
          <button
            type="button"
            onClick={() => setCreative(v => !v)}
            aria-pressed={creative}
            aria-label="Toggle creative capture mode"
            className={`px-3 py-3 rounded-lg border transition-colors flex items-center gap-1.5 text-sm ${creative
              ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
              : 'bg-port-card text-gray-400 border-port-border hover:text-gray-200'}`}
            title="Creative mode: flag captures as creative ideas you can send to the Catalog"
          >
            <Sparkles className="w-4 h-4" />
            <span className="hidden sm:inline">Creative</span>
          </button>
          <button
            type="submit"
            disabled={!inputText.trim()}
            className="px-4 py-3 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
            title="Capture thought"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Capture a thought — type or use the mic. AI will classify and route it automatically.
          {creative && <span className="text-purple-300"> Creative mode on — captures are flagged for the Catalog.</span>}
          {settings?.confidenceThreshold && (
            <span> Confidence threshold: {Math.round(settings.confidenceThreshold * 100)}%</span>
          )}
        </p>
      </form>

      {/* Creative batch action — appears once any captured note is flagged
          creative. Sends them all into the catalog ingest review in one hop. */}
      {creativeEntries.length > 0 && (
        <div className="xl:col-span-2 flex items-center justify-between gap-3 p-3 bg-purple-500/10 border border-purple-500/30 rounded-lg">
          <span className="text-sm text-purple-200 flex items-center gap-2">
            <Sparkles className="w-4 h-4 flex-shrink-0" />
            {creativeEntries.length} creative {creativeEntries.length === 1 ? 'note' : 'notes'} ready to become catalog ingredients
          </span>
          <button
            type="button"
            onClick={handleSendCreativeToCatalog}
            className="px-3 py-1.5 bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 border border-purple-500/40 rounded-lg text-sm transition-colors flex items-center gap-1.5 flex-shrink-0"
          >
            <Library className="w-4 h-4" /> Send to Catalog
          </button>
        </div>
      )}

      {/* Needs Review rail — right column on xl+, first after the form on mobile.
          Capped to the viewport and given its own scroll on xl+ so a long
          Needs-Review queue stays reachable instead of growing past the fold
          (the very problem #1173 set out to fix). */}
      <div className="flex flex-col gap-4 xl:col-start-2 xl:row-start-2 xl:sticky xl:top-0 xl:self-start xl:max-h-[calc(100dvh-7rem)] xl:overflow-y-auto">
        {/* Overview stats — desktop rail only (counts also live in the page header) */}
        <div className="hidden xl:block p-3 bg-port-card border border-port-border rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-gray-300">Overview</span>
            <button
              type="button"
              onClick={() => { fetchInbox(); onRefresh?.(); }}
              className="p-1 text-gray-400 hover:text-white transition-colors"
              title="Refresh inbox"
              aria-label="Refresh inbox"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {overviewStats.map(stat => (
              <div key={stat.label} className="flex items-baseline justify-between gap-2">
                <span className="text-xs text-gray-500">{stat.label}</span>
                <span className={`text-sm font-semibold ${stat.className}`}>{stat.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Needs Review section */}
        {needsReviewEntries.length > 0 ? (
          <div>
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
                        {timeAgo(entry.capturedAt)}
                      </span>
                    </div>

                    {entry.classification?.cleanedUp && entry.classification.cleanedUp !== entry.capturedText && (
                      <p className="text-sm text-gray-300 mb-2 pl-3 border-l-2 border-port-accent/30">
                        {entry.classification.cleanedUp}
                      </p>
                    )}

                    {entry.classification?.thoughts && (
                      <p className="text-xs text-port-accent/70 italic mb-2">
                        {entry.classification.thoughts}
                      </p>
                    )}

                    {entry.classification?.reasons && (
                      <p className="text-xs text-gray-500 mb-2">
                        {entry.classification.reasons.join(' • ')}
                      </p>
                    )}

                    {confirmingDeleteId === entry.id ? (
                      <InlineConfirmRow
                        question="Delete this entry? This cannot be undone."
                        confirmTitle="Confirm delete"
                        cancelTitle="Cancel delete"
                        onConfirm={() => handleDelete(entry.id)}
                        onCancel={() => setConfirmingDeleteId(null)}
                      />
                    ) : editingId !== entry.id && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-gray-500">Route to:</span>
                        {['people', 'projects', 'ideas', 'admin', 'memories'].map(dest => {
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
                          disabled={retryingId === entry.id}
                          className={`flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border transition-colors ${retryingId === entry.id ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-white'}`}
                          title="Retry AI classification"
                        >
                          <RefreshCw size={12} className={retryingId === entry.id ? 'animate-spin' : ''} />
                          {retryingId === entry.id ? 'Classifying...' : 'Retry AI'}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="hidden xl:flex items-center gap-2 p-3 bg-port-card border border-port-border rounded-lg text-sm text-gray-500">
            <CheckCircle size={16} className="text-port-success" />
            Nothing needs review.
          </div>
        )}
      </div>

      {/* Main entries column */}
      <div className="flex flex-col min-w-0 xl:col-start-1 xl:row-start-2">
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
                      <BrailleSpinner />
                      <span className="text-xs text-gray-500 whitespace-nowrap">
                        {timeAgo(entry.capturedAt)}
                      </span>
                    </div>
                  </div>
                  <p className="text-xs text-port-accent mt-1">AI is classifying this thought...</p>
                </div>
              ))}
            </div>
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
                    <InlineConfirmRow
                      question="Delete this entry? This cannot be undone."
                      confirmTitle="Confirm delete"
                      cancelTitle="Cancel delete"
                      onConfirm={() => handleDelete(entry.id)}
                      onCancel={() => setConfirmingDeleteId(null)}
                    />
                  ) : editingId !== entry.id && (
                    <button
                      onClick={() => handleRetry(entry.id)}
                      disabled={retryingId === entry.id}
                      className={`flex items-center gap-1 px-2 py-1 text-xs rounded border border-port-border transition-colors ${retryingId === entry.id ? 'text-gray-600 cursor-not-allowed' : 'text-gray-400 hover:text-white'}`}
                      title="Retry AI classification"
                    >
                      <RefreshCw size={12} className={retryingId === entry.id ? 'animate-spin' : ''} />
                      {retryingId === entry.id ? 'Classifying...' : 'Retry'}
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
                        <p className="text-white">
                          {entry.creative && (
                            <Sparkles className="inline w-3.5 h-3.5 text-purple-300 mr-1.5 -mt-0.5" aria-label="Creative note" />
                          )}
                          {entry.capturedText}
                        </p>
                        {entry.classification?.cleanedUp && entry.classification.cleanedUp !== entry.capturedText && (
                          <p className="text-sm text-gray-300 mt-1 pl-3 border-l-2 border-port-accent/30">
                            {entry.classification.cleanedUp}
                          </p>
                        )}
                        {entry.classification?.title && (
                          <p className="text-sm text-gray-400 mt-1">
                            → {entry.classification.title}
                          </p>
                        )}
                        {entry.classification?.thoughts && (
                          <p className="text-xs text-port-accent/70 italic mt-1">
                            {entry.classification.thoughts}
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
                          {timeAgo(entry.capturedAt)}
                        </span>
                      </div>
                    </div>

                    {confirmingDeleteId === entry.id && (
                      <InlineConfirmRow
                        question="Delete this entry? This cannot be undone."
                        className="mb-2"
                        confirmTitle="Confirm delete"
                        cancelTitle="Cancel delete"
                        onConfirm={() => handleDelete(entry.id)}
                        onCancel={() => setConfirmingDeleteId(null)}
                      />
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
                            {['people', 'projects', 'ideas', 'admin', 'memories']
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
                            {timeAgo(entry.doneAt || entry.capturedAt)}
                          </span>
                        </div>
                      </div>

                      {confirmingDeleteId === entry.id && (
                        <InlineConfirmRow
                          question="Delete this entry? This cannot be undone."
                          className="mb-2"
                          confirmTitle="Confirm delete"
                          cancelTitle="Cancel delete"
                          onConfirm={() => handleDelete(entry.id)}
                          onCancel={() => setConfirmingDeleteId(null)}
                        />
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
    </div>
  );
}
