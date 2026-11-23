import { useState, useEffect, useCallback } from 'react';
import {
  recalculateBehavioralFeedbackWeights,
  getRecentBehavioralFeedback,
  getDigitalTwinDocuments,
  updateSoulDocument,
} from '../../services/apiDigitalTwin.js';
import socket from '../../services/socket';
import toast from '../ui/Toast';
import { timeAgo } from '../../utils/formatters';

const VALIDATION_LABEL = {
  sounds_like_me: 'Sounds like me',
  not_quite: 'Not quite',
  doesnt_sound_like_me: 'Not me',
};

// Document weights are integers 1-10; suggested deltas are fractional.
const clampWeight = (w) => Math.min(10, Math.max(1, Math.round(w)));

export default function FeedbackWeightsPanel() {
  const [recalculating, setRecalculating] = useState(false);
  const [result, setResult] = useState(null); // { adjustments, message? } | null = not calculated yet
  const [recent, setRecent] = useState(null); // null = loading, 'failed' = fetch error, array = loaded
  const [showRecent, setShowRecent] = useState(false);
  const [applying, setApplying] = useState(null);

  const loadRecent = useCallback(() => getRecentBehavioralFeedback(null, 10).catch(() => null), []);

  useEffect(() => {
    if (!showRecent) return undefined;
    let active = true;
    const refresh = () => loadRecent().then(entries => { if (active) setRecent(Array.isArray(entries) ? entries : 'failed'); });
    refresh();
    socket.on('digital-twin:changed', refresh);
    return () => {
      active = false;
      socket.off('digital-twin:changed', refresh);
    };
  }, [showRecent, loadRecent]);

  const recalculate = async () => {
    setRecalculating(true);
    const next = await recalculateBehavioralFeedbackWeights().catch(() => null);
    setRecalculating(false);
    if (next) setResult(next);
  };

  const apply = async (filename, delta) => {
    setApplying(filename);
    const docs = await getDigitalTwinDocuments().catch(() => null);
    const doc = Array.isArray(docs) ? docs.find(d => d.filename === filename) : null;
    if (!doc) {
      setApplying(null);
      if (docs) toast.error(`Document ${filename} not found`);
      return;
    }
    const weight = clampWeight((doc.weight || 5) + delta);
    const ok = await updateSoulDocument(doc.id, { weight }).then(() => true).catch(() => false);
    setApplying(null);
    if (ok) toast.success(`${filename} weight set to ${weight}`);
  };

  const entries = result ? Object.entries(result.adjustments || {}) : [];

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-gray-500">
          Suggested document weights come from which documents were in context when you rated a response.
        </div>
        <button
          type="button"
          onClick={recalculate}
          disabled={recalculating}
          className="px-3 py-1.5 text-xs rounded bg-port-accent text-white hover:bg-port-accent/80 disabled:opacity-50 shrink-0"
        >
          {recalculating ? 'Recalculating…' : 'Recalculate Weights'}
        </button>
      </div>

      {result && result.message && (
        <div className="p-3 rounded-lg bg-port-bg text-sm text-gray-400">{result.message}</div>
      )}
      {result && !result.message && entries.length === 0 && (
        <div className="p-3 rounded-lg bg-port-bg text-sm text-gray-400">
          No document has a clear enough signal to adjust yet.
        </div>
      )}
      {entries.length > 0 && (
        <div className="space-y-2">
          {entries.map(([filename, adj]) => (
            <div key={filename} className="flex items-center justify-between gap-3 p-3 rounded-lg bg-port-bg">
              <div className="min-w-0">
                <div className="text-sm text-white truncate">{filename}</div>
                <div className="text-xs text-gray-500">
                  {adj.positive} positive / {adj.negative} negative of {adj.total} ratings • {Math.round(adj.confidence * 100)}% confidence
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={`text-sm font-bold ${adj.delta > 0 ? 'text-port-success' : 'text-port-error'}`}>
                  {adj.delta > 0 ? '+' : ''}{adj.delta}
                </span>
                <button
                  type="button"
                  onClick={() => apply(filename, adj.delta)}
                  disabled={applying === filename}
                  className="px-2 py-1 text-xs rounded border border-port-border text-gray-300 hover:text-white disabled:opacity-50"
                >
                  Apply
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowRecent(v => !v)}
          className="text-xs text-gray-400 hover:text-white"
        >
          {showRecent ? '▾' : '▸'} Recent feedback
        </button>
        {showRecent && (
          <div className="mt-2 space-y-1">
            {recent === null && <div className="text-xs text-gray-500">Loading…</div>}
            {recent === 'failed' && <div className="text-xs text-port-error">Could not load recent feedback.</div>}
            {Array.isArray(recent) && recent.length === 0 && <div className="text-xs text-gray-500">No feedback yet.</div>}
            {Array.isArray(recent) && recent.map(e => (
              <div key={e.id} className="flex items-center justify-between gap-3 text-xs p-2 rounded bg-port-bg">
                <span className="text-gray-300 truncate">{e.context || e.contentType}</span>
                <span className="text-gray-500 shrink-0">
                  {VALIDATION_LABEL[e.validation] || e.validation} • {timeAgo(e.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
