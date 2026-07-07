import { useState, useEffect } from 'react';
import { RefreshCw, Clock, AlertTriangle } from 'lucide-react';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';
import { formatCompactCount } from '../utils/formatters';

function InternalUsageMetrics() {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadUsage();
  }, []);

  const loadUsage = async () => {
    setLoading(true);
    const data = await api.getUsage().catch(() => null);
    setUsage(data);
    setLoading(false);
  };

  // Preserve the em-dash empty-state; delegate K/M abbreviation to the shared helper.
  const formatNumber = (num) => (num == null ? '—' : formatCompactCount(num));

  if (loading) {
    return <div className="text-center py-8"><BrailleSpinner text="Loading usage data" /></div>;
  }

  if (!usage) {
    return <div className="text-center py-8 text-gray-500">No usage data available</div>;
  }

  const maxActivity = Math.max(1, ...(usage.last7Days?.map(d => d.sessions) || []));

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-white">PortOS AI Usage</h2>

      {/* Summary Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(usage.totalSessions)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Sessions</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(usage.totalMessages)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Messages</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(usage.totalToolCalls)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Tool Calls</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber((usage.totalTokens?.input ?? 0) + (usage.totalTokens?.output ?? 0))}</div>
          <div className="text-xs sm:text-sm text-gray-400">Tokens</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center col-span-2 sm:col-span-1">
          <div className="text-xl sm:text-2xl font-bold text-port-success">${(usage.estimatedCost ?? 0).toFixed(2)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Est. Cost</div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
        {/* 7-Day Activity */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3 sm:mb-4">Last 7 Days</h3>
          <div className="flex items-end gap-1 sm:gap-2 h-24 sm:h-32">
            {usage.last7Days?.map((day, i) => (
              <div key={i} className="flex-1 flex flex-col items-center">
                <div
                  className="w-full bg-port-accent/60 rounded-t"
                  style={{ height: `${(day.sessions / maxActivity) * 100}%`, minHeight: day.sessions > 0 ? 4 : 0 }}
                />
                <div className="text-[10px] sm:text-xs text-gray-500 mt-1 sm:mt-2">{day.label}</div>
                <div className="text-[10px] sm:text-xs text-gray-400">{day.sessions}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Hourly Distribution */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-3 sm:mb-4">Hourly Distribution</h3>
          <div className="flex items-end gap-0.5 h-24 sm:h-32">
            {(() => {
              const maxHour = Math.max(1, ...(usage.hourlyActivity || []));
              return usage.hourlyActivity?.map((count, hour) => (
                <div key={hour} className="flex-1 flex flex-col items-center">
                  <div
                    className="w-full bg-port-accent/40 rounded-t"
                    style={{ height: `${(count / maxHour) * 100}%`, minHeight: count > 0 ? 2 : 0 }}
                    title={`${hour}:00 - ${count} sessions`}
                  />
                </div>
              ));
            })()}
          </div>
          <div className="flex justify-between text-[10px] sm:text-xs text-gray-500 mt-1 sm:mt-2">
            <span>12am</span>
            <span>6am</span>
            <span>12pm</span>
            <span>6pm</span>
            <span>12am</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
        {/* Top Providers */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-2 sm:mb-3">Top Providers</h3>
          <div className="space-y-1 sm:space-y-2">
            {usage.topProviders?.map((provider, i) => (
              <div key={i} className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-2 border-b border-port-border last:border-0 gap-1 sm:gap-0">
                <span className="text-white text-sm sm:text-base">{provider.name}</span>
                <div className="text-xs sm:text-sm text-gray-400">
                  <span>{provider.sessions} sessions</span>
                  <span className="mx-1 sm:mx-2">•</span>
                  <span>{formatNumber(provider.tokens)} tokens</span>
                </div>
              </div>
            ))}
            {(!usage.topProviders || usage.topProviders.length === 0) && (
              <div className="text-gray-500 text-sm">No provider data</div>
            )}
          </div>
        </div>

        {/* Top Models */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-2 sm:mb-3">Top Models</h3>
          <div className="space-y-1 sm:space-y-2">
            {usage.topModels?.map((model, i) => (
              <div key={i} className="flex flex-col sm:flex-row sm:items-center sm:justify-between py-2 border-b border-port-border last:border-0 gap-1 sm:gap-0">
                <span className="text-white font-mono text-xs sm:text-sm truncate max-w-[200px] sm:max-w-none">{model.model}</span>
                <div className="text-xs sm:text-sm text-gray-400">
                  <span>{model.sessions} sessions</span>
                  <span className="mx-1 sm:mx-2">•</span>
                  <span>{formatNumber(model.tokens)} tokens</span>
                </div>
              </div>
            ))}
            {(!usage.topModels || usage.topModels.length === 0) && (
              <div className="text-gray-500 text-sm">No model data</div>
            )}
          </div>
        </div>
      </div>

      {/* Refresh button */}
      <div className="flex justify-end">
        <button
          onClick={loadUsage}
          className="flex items-center gap-2 px-4 py-2 text-gray-400 hover:text-white"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
    </div>
  );
}

// Color a usage meter by how much is consumed: comfortable → warning → critical.
function meterColor(percentUsed) {
  if (percentUsed == null) return 'bg-gray-500';
  if (percentUsed >= 90) return 'bg-port-error';
  if (percentUsed >= 70) return 'bg-port-warning';
  return 'bg-port-success';
}

function UsageMeter({ limit }) {
  const used = limit.percentUsed ?? 0;
  const remaining = limit.percentRemaining;
  return (
    <div className="py-2 border-b border-port-border last:border-0">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-white text-sm sm:text-base">{limit.label}</span>
        <span className="text-xs sm:text-sm text-gray-400">
          {remaining == null ? '—' : `${remaining}% left`}
        </span>
      </div>
      <div className="h-2 rounded-full bg-port-bg overflow-hidden">
        <div
          className={`h-full rounded-full ${meterColor(limit.percentUsed)}`}
          style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] sm:text-xs text-gray-500">{used}% used</span>
        {limit.resetsAt && (
          <span className="text-[10px] sm:text-xs text-gray-500 flex items-center gap-1">
            <Clock size={11} /> resets {limit.resetsAt}
          </span>
        )}
      </div>
    </div>
  );
}

// Claude Code SUBSCRIPTION rate-limit usage, parsed server-side from the CLI
// `/usage` output. Self-contained: owns its own fetch/loading/error state so it
// always renders (above the PortOS-internal token metrics below).
function ClaudeCodeUsagePanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(false);
    const result = await api.getClaudeCodeUsage({ refresh }).catch(() => null);
    if (result) {
      setData(result);
    } else {
      // Keep previously-loaded meters on a transient refresh failure instead of
      // replacing them with the generic error state.
      setError(true);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-white">Claude Code Subscription</h2>
        <button
          onClick={() => load(true)}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-white disabled:opacity-50"
          title="Refresh from the Claude Code CLI"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {loading && !data && (
        <div className="py-6"><BrailleSpinner text="Reading Claude Code usage" /></div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-2 text-sm text-gray-400 py-2">
          <AlertTriangle size={16} className="text-port-warning mt-0.5 shrink-0" />
          <span>
            {data
              ? 'Couldn’t refresh Claude Code usage — showing the last successful reading.'
              : <>Couldn&rsquo;t read Claude Code usage. The <code className="text-gray-300">claude</code> CLI must be installed and signed in on this machine.</>}
          </span>
        </div>
      )}

      {data && (
        <div className="space-y-3">
          {data.limits?.length > 0 ? (
            <div>
              {data.limits.map((limit) => (
                <UsageMeter key={limit.key} limit={limit} />
              ))}
            </div>
          ) : (
            <div className="text-gray-500 text-sm">No rate-limit data reported</div>
          )}

          {data.activity?.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              {data.activity.map((a) => (
                <div key={a.period} className="bg-port-bg border border-port-border rounded-lg p-3">
                  <div className="text-xs text-gray-400 mb-1">{a.period}</div>
                  <div className="text-sm text-white">
                    {formatCompactCount(a.requests)} requests
                    <span className="mx-2 text-gray-600">•</span>
                    {formatCompactCount(a.sessions)} sessions
                  </div>
                </div>
              ))}
            </div>
          )}

          {data.approximate && (
            <p className="text-[10px] sm:text-xs text-gray-500">
              Approximate — based on local sessions on this machine only; does not include other devices or claude.ai.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function UsagePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Usage</h1>
      <ClaudeCodeUsagePanel />
      <InternalUsageMetrics />
    </div>
  );
}

export default UsagePage;
