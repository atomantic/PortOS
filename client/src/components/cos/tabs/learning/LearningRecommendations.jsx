import { AlertTriangle, CheckCircle, XCircle, Zap, Target, ChevronDown, ChevronRight, X, Undo2 } from 'lucide-react';
import { formatDateTime } from '../../../../utils/formatters';
import { useState } from 'react';

export default function LearningRecommendations({ recommendations, dismissed, onDismiss, onRestore, onClearDismissed }) {
  const [showDismissed, setShowDismissed] = useState(false);
  if (!recommendations?.length && !dismissed.length) return null;

  return (
    <div className="bg-gradient-to-r from-port-accent-2/10 to-port-accent/10 border border-port-accent-2/30 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-medium text-white flex items-center gap-2">
          <Zap size={14} className="text-yellow-400" />
          AI Recommendations
        </h4>
        {dismissed.length > 0 && (
          <button
            type="button"
            aria-expanded={showDismissed}
            onClick={() => setShowDismissed(prev => !prev)}
            className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
            title={showDismissed ? 'Hide dismissed' : 'Show dismissed'}
          >
            {showDismissed ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {dismissed.length} dismissed
          </button>
        )}
      </div>
      {recommendations?.length > 0 ? (
        <div className="space-y-2">
          {recommendations.map((rec) => (
            <div
              key={rec.id || rec.message}
              className={`text-sm p-2 rounded flex items-start gap-2 ${
                rec.type === 'warning' ? 'bg-yellow-500/10 text-yellow-400' :
                rec.type === 'action' ? 'bg-red-500/10 text-red-400' :
                rec.type === 'optimization' ? 'bg-port-success/10 text-port-success' :
                rec.type === 'suggestion' ? 'bg-port-accent/10 text-port-accent' :
                'bg-gray-500/10 text-gray-400'
              }`}
            >
              {rec.type === 'warning' && <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
              {rec.type === 'action' && <XCircle size={14} className="mt-0.5 shrink-0" />}
              {rec.type === 'optimization' && <CheckCircle size={14} className="mt-0.5 shrink-0" />}
              {rec.type === 'suggestion' && <Zap size={14} className="mt-0.5 shrink-0" />}
              {rec.type === 'info' && <Target size={14} className="mt-0.5 shrink-0" />}
              <span className="flex-1">{rec.message}</span>
              {rec.id && (
                <button
                  onClick={() => onDismiss(rec)}
                  className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 opacity-60 hover:opacity-100 transition-opacity shrink-0 -my-2 -mr-1 p-2 min-h-[40px] min-w-[40px] flex items-center justify-center"
                  title="Dismiss — won't show again unless this situation worsens significantly"
                  aria-label={`Dismiss recommendation: ${rec.message}`}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-500 italic">No active recommendations.</p>
      )}
      {showDismissed && dismissed.length > 0 && (
        <div className="mt-3 pt-3 border-t border-port-border">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-gray-500">
              Dismissed (will re-alert only if the underlying situation gets significantly worse)
            </span>
            <button
              onClick={onClearDismissed}
              className="text-xs text-port-accent hover:text-port-accent/80"
            >
              Clear all
            </button>
          </div>
          <div className="space-y-1">
            {dismissed.map((d) => (
              <div
                key={d.id}
                className="text-xs p-2 rounded bg-port-bg/50 flex items-center justify-between gap-2 text-gray-500"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-mono truncate">{d.id}</div>
                  {d.dismissedAt && (
                    <div className="text-gray-600 text-[10px]">
                      dismissed {formatDateTime(d.dismissedAt)}
                      {d.snapshot?.value !== undefined && (
                        <span> · snapshot: {d.snapshot.value}{d.snapshot.kind === 'rate' ? '%' : ''}</span>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={`Restore recommendation ${d.id}`}
                  onClick={() => onRestore(d.id)}
                  className="text-port-accent hover:text-port-accent/80 flex items-center gap-1 shrink-0 px-2 py-1 min-h-[40px]"
                  title="Restore this recommendation"
                >
                  <Undo2 size={12} />
                  Restore
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
