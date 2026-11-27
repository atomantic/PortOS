import { useState } from 'react';
import { Copy } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { copyToClipboard } from '../../lib/clipboard';
import { timeAgo } from '../../utils/formatters';

export default function SavedAnalysisCard({ analysis, onClear }) {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const confirmRemoval = async () => {
    setClearing(true);
    if (!await onClear()) setClearing(false);
  };

  return (
    <div className="mb-4 p-3 bg-port-bg border border-port-border rounded-lg space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">
          Saved analysis{analysis.analyzedAt ? ` · ${timeAgo(analysis.analyzedAt)}` : ''}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => copyToClipboard(analysis.prompt, 'Analysis prompt copied')}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
            aria-label="Copy saved analysis prompt"
          >
            <Copy className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          {confirming ? (
            <ConfirmButtonPair
              ariaLabel="Remove saved analysis?"
              confirmText="Remove analysis"
              onConfirm={confirmRemoval}
              onCancel={() => setConfirming(false)}
              busy={clearing}
              busyText="Removing…"
            />
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label="Remove saved analysis"
              className="min-h-9 pointer-coarse:min-h-11 pointer-coarse:min-w-11 px-2 py-1 rounded border border-port-border text-xs text-gray-400 hover:text-port-error transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {analysis.rationale ? (
        <p className="text-xs text-gray-300">{analysis.rationale}</p>
      ) : null}
      <textarea
        readOnly
        value={analysis.prompt}
        rows={4}
        aria-label="Saved analysis prompt"
        className="w-full bg-port-card border border-port-border rounded-lg p-2 text-xs text-white resize-y"
      />
      {analysis.negativePrompt ? (
        <textarea
          readOnly
          value={analysis.negativePrompt}
          rows={2}
          aria-label="Saved analysis negative prompt"
          className="w-full bg-port-card border border-port-border rounded-lg p-2 text-xs text-gray-300 resize-y"
        />
      ) : null}
      {(analysis.providerId || analysis.model) ? (
        <p className="text-[10px] text-gray-500 truncate">
          {[analysis.providerId, analysis.model].filter(Boolean).join(' · ')}
        </p>
      ) : null}
    </div>
  );
}
