import { XCircle, ChevronDown, ChevronRight, Crosshair } from 'lucide-react';
import { getSuccessRateColor, getSuccessRateBg } from './learningPresentation';

export default function LearningRoutingSection({ routing, expanded, onToggle }) {
  if (!routing?.matrix?.length) return null;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex items-center gap-2 w-full text-left mb-3"
      >
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        <Crosshair size={16} className="text-orange-400" />
        <span className="font-medium text-white">Routing Accuracy</span>
        <span className="text-xs text-gray-500">
          ({routing.matrix.length} task types)
        </span>
        {routing.totalMisroutes > 0 && (
          <span className="text-xs text-port-error">
            ({routing.totalMisroutes} misroute{routing.totalMisroutes !== 1 ? 's' : ''})
          </span>
        )}
      </button>
      {expanded && (
        <div className="space-y-4">
          {/* Misroutes Alert */}
          {routing.misroutes?.length > 0 && (
            <div className="bg-port-error/10 border border-port-error/30 rounded-lg p-4">
              <h4 className="text-sm font-medium text-port-error mb-2 flex items-center gap-2">
                <XCircle size={14} />
                Misroutes Detected
              </h4>
              <p className="text-xs text-gray-400 mb-3">
                These task type + model tier combinations have &lt;40% success with 3+ attempts. Routing never changes on its own — pin a model or tier on the task or schedule to act on this.
              </p>
              <div className="space-y-1">
                {routing.misroutes.map((m, idx) => (
                  <div key={idx} className="flex flex-wrap items-center justify-between gap-2 p-2 bg-port-bg rounded text-sm">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="text-white">{m.taskType}</span>
                      <span className="text-gray-500">on</span>
                      <span className="text-orange-400 font-medium">{m.tier}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-port-error font-mono">{m.successRate}%</span>
                      <span className="text-xs text-gray-500">({m.failed} failed / {m.total})</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tier Overview */}
          {routing.tierOverview?.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {routing.tierOverview.map((tier, idx) => {
                const tierLabels = {
                  'light': 'Light', 'medium': 'Medium', 'heavy': 'Heavy', 'ultra': 'Ultra',
                  'default': 'Default', 'user-specified': 'User'
                };
                return (
                  <div key={idx} className="bg-port-card border border-port-border rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm text-white">{tierLabels[tier.tier] || tier.tier}</span>
                      <span className={`text-sm font-mono ${getSuccessRateColor(tier.successRate)}`}>
                        {tier.successRate}%
                      </span>
                    </div>
                    <div className="w-full bg-port-border rounded-full h-1.5 mb-1">
                      <div
                        className={`h-1.5 rounded-full ${getSuccessRateBg(tier.successRate)}`}
                        style={{ width: `${tier.successRate}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>{tier.total} tasks across {tier.taskTypes} types</span>
                      {tier.misroutes > 0 && (
                        <span className="text-port-error">{tier.misroutes} misroute{tier.misroutes !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Full Matrix */}
          <div className="bg-port-card border border-port-border rounded-lg overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <caption className="sr-only">Routing Accuracy</caption>
              <thead className="bg-port-bg">
                <tr>
                  <th scope="col" className="text-left p-3 text-gray-500 font-medium">Task Type</th>
                  <th scope="col" className="text-left p-3 text-gray-500 font-medium">Tier</th>
                  <th scope="col" className="text-right p-3 text-gray-500 font-medium">Success</th>
                  <th scope="col" className="text-right p-3 text-gray-500 font-medium">Pass</th>
                  <th scope="col" className="text-right p-3 text-gray-500 font-medium">Fail</th>
                </tr>
              </thead>
              {routing.matrix.map((entry) => (
                <tbody key={entry.taskType}>
                  {entry.tiers.map((tier, tIdx) => (
                    <tr key={`${entry.taskType}-${tier.tier}`} className="border-t border-port-border">
                      {tIdx === 0 ? (
                        <th scope="rowgroup" className="p-3 text-gray-300 max-w-[200px] align-top text-left font-normal" rowSpan={entry.tiers.length}>
                          <div className="[overflow-wrap:anywhere]">{entry.taskType}</div>
                          {entry.suggestion && (
                            <div className="text-xs text-gray-500 mt-1" title={entry.suggestion.reason || undefined}>
                              {entry.suggestion.tier && <>Suggests <span className="text-port-accent">{entry.suggestion.tier}</span></>}
                              {entry.suggestion.tier && entry.suggestion.avoidTiers.length > 0 && ' · '}
                              {entry.suggestion.avoidTiers.length > 0 && <>avoid <span className="text-orange-400">{entry.suggestion.avoidTiers.join(', ')}</span></>}
                            </div>
                          )}
                        </th>
                      ) : null}
                      <td className="p-3 text-orange-400">{tier.tier}</td>
                      <td className={`p-3 text-right font-mono ${getSuccessRateColor(tier.successRate)}`}>
                        {tier.successRate}%
                      </td>
                      <td className="p-3 text-right text-port-success">{tier.succeeded}</td>
                      <td className="p-3 text-right text-port-error">{tier.failed}</td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
