import { TrendingUp, TrendingDown, BarChart2, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { runsLabel } from './learningPresentation';

export default function LearningTaskTypesSection({ performance, expanded, onToggle, resettingType, onResetTaskType }) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left mb-3"
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <BarChart2 size={16} className="text-port-accent" />
        <span className="font-medium text-white">Task Type Performance</span>
        <span className="text-xs text-gray-500">
          ({performance?.topPerformers?.length || 0} top, {performance?.needsAttention?.length || 0} need attention)
        </span>
      </button>
      {expanded && (
        <div className="space-y-4">
          {/* Top Performers */}
          {performance?.topPerformers?.length > 0 && (
            <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-port-success/10 border-b border-port-border">
                <span className="text-sm font-medium text-port-success flex items-center gap-2">
                  <TrendingUp size={14} />
                  Top Performers (80%+ success)
                </span>
              </div>
              <div className="divide-y divide-port-border">
                {performance.topPerformers.map((item, idx) => (
                  <div key={idx} className="p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white break-all sm:truncate">{item.taskType}</div>
                      <div className="text-xs text-gray-500">
                        {runsLabel(item, 'tasks')} • {item.avgDurationMin}m avg
                      </div>
                    </div>
                    <div className="flex items-center gap-3 self-stretch sm:self-auto">
                      <div className="flex-1 sm:flex-none sm:w-24 bg-port-border rounded-full h-2">
                        <div
                          className="h-2 rounded-full bg-port-success"
                          style={{ width: `${item.successRate}%` }}
                        />
                      </div>
                      <span className="text-sm font-mono text-port-success w-12 text-right">
                        {item.successRate}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Needs Attention */}
          {performance?.needsAttention?.length > 0 && (
            <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
              <div className="px-4 py-2 bg-port-error/10 border-b border-port-border">
                <span className="text-sm font-medium text-port-error flex items-center gap-2">
                  <TrendingDown size={14} />
                  Needs Attention (&lt;50% success)
                </span>
              </div>
              <div className="divide-y divide-port-border">
                {performance.needsAttention.map((item, idx) => (
                  <div key={idx} className="p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white break-all sm:truncate">{item.taskType}</div>
                      <div className="text-xs text-gray-500">
                        {runsLabel(item, 'tasks')} • {item.avgDurationMin}m avg
                      </div>
                    </div>
                    <div className="flex items-center gap-3 self-stretch sm:self-auto">
                      <div className="flex-1 sm:flex-none sm:w-24 bg-port-border rounded-full h-2">
                        <div
                          className="h-2 rounded-full bg-port-error"
                          style={{ width: `${item.successRate}%` }}
                        />
                      </div>
                      <span className="text-sm font-mono text-port-error w-12 text-right">
                        {item.successRate}%
                      </span>
                      <button
                        type="button"
                        onClick={() => onResetTaskType(item.taskType)}
                        disabled={resettingType === item.taskType}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded transition-colors disabled:opacity-50 min-h-[32px]"
                        title="Clear historical learning metrics; scheduling is unchanged"
                        aria-label={`Reset ${item.taskType}`}
                      >
                        <RotateCcw size={12} className={resettingType === item.taskType ? 'animate-spin' : ''} />
                        Reset
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {performance?.topPerformers?.length === 0 && performance?.needsAttention?.length === 0 && (
            <div className="text-center py-4 text-gray-500 text-sm">
              Need at least 3 completed tasks per type to show performance data
            </div>
          )}
        </div>
      )}
    </div>
  );
}
