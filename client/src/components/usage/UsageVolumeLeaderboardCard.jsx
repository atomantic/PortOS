import { formatCompactCountOrDash as formatNumber, formatCount, formatUsd } from '../../utils/formatters';

/**
 * Shared leaderboard card for Top Providers and Top Models usage volume breakdowns.
 */
export function UsageVolumeLeaderboardCard({ title, subtitle, items, emptyMessage, barClassName, renderLabel }) {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
      <h3 className="text-sm font-medium text-gray-400 mb-2 sm:mb-3 flex items-center justify-between">
        <span>{title}</span>
        <span className="text-xs text-gray-500 font-normal">{subtitle}</span>
      </h3>
      <div className="space-y-3">
        {items.map((item, i) => (
          <div key={i} className="py-1.5 border-b border-port-border last:border-0 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                {renderLabel(item)}
              </div>
              <div className="flex items-center gap-2 shrink-0 text-xs">
                {item.estimatedCost != null && item.estimatedCost > 0 && (
                  <span className="text-port-success font-semibold">{item.costIncomplete ? '≥ ' : ''}{formatUsd(item.estimatedCost)}</span>
                )}
                <span className="text-gray-400 bg-port-bg border border-port-border px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-mono">
                  {item.percent}%
                </span>
              </div>
            </div>

            {/* Visual Usage Bar */}
            <div className="h-1.5 rounded-full bg-port-bg overflow-hidden">
              <div
                className={`h-full rounded-full bg-gradient-to-r ${barClassName} transition-all duration-300`}
                style={{ width: `${Math.max(2, item.percent)}%` }}
              />
            </div>

            {/* Detailed Breakdown stats */}
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span>{formatCount(item.sessions)} session{item.sessions === 1 ? '' : 's'}</span>
              <div className="flex items-center gap-1 sm:gap-2">
                <span>{formatNumber(item.tokens)} tokens</span>
                {item.tokensIn != null && item.tokensOut != null && (
                  <span className="text-[10px] text-gray-500 hidden sm:inline">
                    ({formatNumber(item.tokensIn)} fresh in / {formatNumber(item.tokensOut)} out / {formatNumber((item.cacheReadTokens || 0) + (item.cacheWriteTokens || 0))} cache)
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="text-gray-500 text-sm">{emptyMessage}</div>
        )}
      </div>
    </div>
  );
}

export default UsageVolumeLeaderboardCard;
