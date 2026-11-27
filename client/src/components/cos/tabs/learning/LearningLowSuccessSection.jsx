import { SkipForward, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { runsLabel } from './learningPresentation';

export default function LearningLowSuccessSection({ skipped, expanded, onToggle, resettingType, onResetTaskType }) {
  if (!skipped?.skippedCount) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left mb-3"
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <SkipForward size={16} className="text-port-warning" />
        <span className="font-medium text-white">Low-Success History</span>
        <span className="text-xs text-port-warning">({skipped.skippedCount})</span>
      </button>
      {expanded && (
        <div className="bg-port-warning/10 border border-port-warning/30 rounded-lg p-4">
          <p className="text-sm text-gray-400 mb-3">
            These task types have low historical success rates. This is a recommendation to review their outcomes, not a scheduler pause.
          </p>
          <div className="space-y-2">
            {skipped.skippedTypes.map((item, idx) => (
              <div key={idx} className="flex flex-wrap items-center justify-between gap-2 p-2 bg-port-bg rounded">
                <div className="min-w-0">
                  <span className="text-sm text-white">{item.taskType}</span>
                  <span className="text-xs text-gray-500 ml-2">
                    ({runsLabel(item, 'attempts')})
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-port-error font-mono">{item.successRate}%</span>
                  <button
                    type="button"
                    aria-label={`Reset ${item.taskType}`}
                    onClick={() => onResetTaskType(item.taskType)}
                    disabled={resettingType === item.taskType}
                    className="flex items-center gap-1 px-2 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded transition-colors disabled:opacity-50 min-h-[40px]"
                    title="Clear historical learning metrics; scheduling is unchanged"
                  >
                    <RotateCcw size={12} className={resettingType === item.taskType ? 'animate-spin' : ''} />
                    Reset
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-gray-500 mt-3">
            Reset clears historical metrics. It does not resume or change scheduling.
          </p>
        </div>
      )}
    </div>
  );
}
