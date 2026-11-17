import { ShieldCheck } from 'lucide-react';
import { formatCount } from '../../../utils/formatters';

const rateClass = (rate) => rate == null
  ? 'text-gray-500'
  : rate >= 70 ? 'text-port-success' : rate >= 40 ? 'text-port-warning' : 'text-port-error';

const formatRate = (rate) => (rate == null ? '—' : `${rate}%`);

/**
 * Clean rate per reviewer and per reviewed diff size (`GET /api/code-review/verdict-stats`).
 * Renders nothing until some run has recorded a verdict, so installs whose runs
 * predate verdict recording simply show no panel. Archived runs the server could
 * not read are named beside the rates they are missing from.
 */
export default function ReviewerVerdictSummary({ stats }) {
  if (!stats?.reports) return null;
  const sizes = (stats.bySize || []).filter(bucket => bucket.reports > 0);

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      <div className="flex items-center gap-2">
        <ShieldCheck size={16} className="text-port-accent" />
        <h4 className="text-sm font-medium text-white">Reviewer Verdicts</h4>
      </div>
      <p className="text-xs text-gray-500 mt-1">
        How often each CLI review round came back clean, from {formatCount(stats.runs)} run{stats.runs === 1 ? '' : 's'} that recorded verdicts
      </p>
      {stats.unreadableRuns > 0 && (
        <p className="text-xs text-port-warning mt-1">
          {formatCount(stats.unreadableRuns)} archived run{stats.unreadableRuns === 1 ? '' : 's'} could not be read; these rates leave {stats.unreadableRuns === 1 ? 'it' : 'them'} out.
        </p>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 text-left">
                <th className="py-1 font-normal">Reviewer</th>
                <th className="py-1 font-normal text-right">Clean</th>
                <th className="py-1 font-normal text-right">Rounds</th>
                <th className="py-1 font-normal text-right">Avg rounds/run</th>
              </tr>
            </thead>
            <tbody>
              {stats.byReviewer.map(row => (
                <tr key={row.reviewer} className="border-t border-port-border">
                  <td className="py-1 text-gray-300 font-mono break-all">{row.reviewer}</td>
                  <td className={`py-1 text-right font-mono ${rateClass(row.cleanRate)}`}>{formatRate(row.cleanRate)}</td>
                  <td className="py-1 text-right text-gray-400">{formatCount(row.reports)}</td>
                  <td className="py-1 text-right text-gray-400">{row.avgRounds ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 text-left">
                <th className="py-1 font-normal">Diff size</th>
                <th className="py-1 font-normal text-right">Clean</th>
                <th className="py-1 font-normal text-right">Rounds</th>
              </tr>
            </thead>
            <tbody>
              {sizes.map(row => (
                <tr key={row.bucket} className="border-t border-port-border">
                  <td className="py-1 text-gray-300">{row.label}</td>
                  <td className={`py-1 text-right font-mono ${rateClass(row.cleanRate)}`}>{formatRate(row.cleanRate)}</td>
                  <td className="py-1 text-right text-gray-400">{formatCount(row.reports)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
