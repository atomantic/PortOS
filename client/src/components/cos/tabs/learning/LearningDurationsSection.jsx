import { Timer, ChevronDown, ChevronRight } from 'lucide-react';
import { formatDurationMin } from '../../../../utils/formatters';
import { useMemo } from 'react';
import { getSuccessRateColor } from './learningPresentation';

/**
 * The real task-type rows in a `/api/cos/learning/durations` payload, slowest
 * first. `_`-prefixed keys are reserved aggregates, not task types: `_overall`,
 * plus the execution-scoped maps from #8001. Skipping the whole prefix (rather
 * than naming `_overall`) is what keeps a new reserved key out of the table —
 * `_byExecution` carries no `avgDurationMs`, so it would render an empty row —
 * and the count beside the heading is this list's length rather than a magic
 * `keys.length - 1` offset. Pure; exported for its test.
 */
export function taskTypeDurationRows(durations) {
  if (!durations) return [];
  return Object.entries(durations)
    .filter(([key]) => !key.startsWith('_'))
    .sort((a, b) => b[1].avgDurationMs - a[1].avgDurationMs);
}

export default function LearningDurationsSection({ durations, expanded, onToggle }) {
  const sortedDurations = useMemo(() => taskTypeDurationRows(durations), [durations]);
  if (sortedDurations.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left mb-3"
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <Timer size={16} className="text-port-accent" />
        <span className="font-medium text-white">Duration Estimates</span>
        <span className="text-xs text-gray-500">
          ({sortedDurations.length} task types)
        </span>
      </button>
      {expanded && (
        <div className="bg-port-card border border-port-border rounded-lg overflow-x-auto">
          <table className="w-full min-w-[460px] text-sm">
            <caption className="sr-only">Duration Estimates</caption>
            <thead className="bg-port-bg">
              <tr>
                <th scope="col" className="text-left p-3 text-gray-500 font-medium">Task Type</th>
                <th scope="col" className="text-right p-3 text-gray-500 font-medium">Avg</th>
                <th scope="col" className="text-right p-3 text-gray-500 font-medium" title="P80 estimate used for progress bars">Est</th>
                <th scope="col" className="text-right p-3 text-gray-500 font-medium">Samples</th>
                <th scope="col" className="text-right p-3 text-gray-500 font-medium">Success</th>
              </tr>
            </thead>
            <tbody>
              {sortedDurations.map(([taskType, data], idx) => (
                <tr key={idx} className="border-t border-port-border">
                  <th scope="row" className="p-3 text-gray-300 truncate max-w-[200px] text-left font-normal">{taskType}</th>
                  <td className="p-3 text-right text-gray-500 font-mono">
                    {data.avgDurationMs ? formatDurationMin(Math.round(data.avgDurationMs / 60000)) || '—' : '—'}
                  </td>
                  <td className="p-3 text-right text-port-accent font-mono" title="P80 estimate used for progress bars and ETAs">
                    {(data.p80DurationMs || data.avgDurationMs) ? formatDurationMin(Math.round((data.p80DurationMs || data.avgDurationMs) / 60000)) || '—' : '—'}
                  </td>
                  <td className="p-3 text-right text-gray-500">
                    {data.completed}
                  </td>
                  <td className={`p-3 text-right font-mono ${getSuccessRateColor(data.successRate)}`}>
                    {data.successRate}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
