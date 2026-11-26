import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { formatDateNumeric } from '../../../../utils/formatters';

export default function LearningErrorsSection({ insights, expanded, onToggle }) {
  if (!insights?.commonErrors?.length) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left mb-3"
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <AlertTriangle size={16} className="text-port-error" />
        <span className="font-medium text-white">Error Patterns</span>
        <span className="text-xs text-gray-500">
          ({insights.commonErrors.length} categories)
        </span>
      </button>
      {expanded && (
        <div className="space-y-3">
          <div className="bg-port-card border border-port-border rounded-lg divide-y divide-port-border">
            {insights.commonErrors.map((error, idx) => (
              <div key={idx} className="p-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm text-port-error font-medium">{error.category}</span>
                  <span className="text-xs text-gray-500">{error.count} occurrences</span>
                </div>
                {error.affectedTypes?.length > 0 && (
                  <div className="text-xs text-gray-500">
                    Affects: {error.affectedTypes.join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Recent Unknown Error Samples */}
          {insights.recentUnknownErrors?.length > 0 && (
            <div className="bg-port-card border border-port-warning/30 rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-port-warning/10 border-b border-port-border">
                <span className="text-sm font-medium text-port-warning flex items-center gap-2">
                  <AlertTriangle size={14} />
                  Recent Uncategorized Errors ({insights.recentUnknownErrors.length})
                </span>
                <p className="text-xs text-gray-500 mt-1">
                  Errors that didn&apos;t match known patterns — useful for identifying missing error categories
                </p>
              </div>
              <div className="divide-y divide-port-border max-h-64 overflow-y-auto">
                {insights.recentUnknownErrors.slice(-10).reverse().map((err, idx) => (
                  <div key={idx} className="p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs text-gray-500 font-mono">{err.taskType}</span>
                      <span className="text-xs text-gray-600">{formatDateNumeric(err.recordedAt)}</span>
                    </div>
                    <div className="text-sm text-gray-300 font-mono break-all">{err.message || 'No message'}</div>
                    {err.details && (
                      <div className="text-xs text-gray-500 mt-1 font-mono break-all line-clamp-2">{err.details}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
