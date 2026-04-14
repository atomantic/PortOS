import { useState, useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';

export function UsagePage() {
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

  const formatNumber = (num) => {
    if (num == null) return '—';
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return String(num);
  };

  if (loading) {
    return <div className="text-center py-8"><BrailleSpinner text="Loading usage data" /></div>;
  }

  if (!usage) {
    return <div className="text-center py-8 text-gray-500">No usage data available</div>;
  }

  const maxActivity = Math.max(1, ...(usage.last7Days?.map(d => d.sessions) || []));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Usage Metrics</h1>

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

export default UsagePage;
