import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw, Clock, AlertTriangle } from 'lucide-react';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';
import Pill from '../components/ui/Pill';
import { formatCompactCount } from '../utils/formatters';

const PERIOD_OPTIONS = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' }
];

// Preserve the em-dash empty-state; delegate K/M abbreviation to the shared helper.
const formatNumber = (num) => (num == null ? '—' : formatCompactCount(num));

const formatCost = (cost) => `$${(cost ?? 0).toFixed(2)}`;

// Reset times arrive either as human text from the Claude CLI ("Jul 15, 3am")
// or as an ISO timestamp from telemetry-based adapters — localize the latter.
const formatResetsAt = (resetsAt) => {
  if (!resetsAt || !/^\d{4}-\d{2}-\d{2}T/.test(resetsAt)) return resetsAt;
  const d = new Date(resetsAt);
  return Number.isNaN(d.getTime()) ? resetsAt : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

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
            <Clock size={11} /> resets {formatResetsAt(limit.resetsAt)}
          </span>
        )}
      </div>
    </div>
  );
}

// One subscription-quota card per enabled provider family. Providers with no
// queryable usage surface (supported: false) render a muted note, never an
// error; a supported adapter that failed transiently shows a soft warning.
function ProviderQuotaCard({ quota }) {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-base font-semibold text-white">{quota.label}</h3>
        {quota.plan && quota.plan !== 'unknown' && (
          <Pill tone="context" size="xs">{quota.plan}</Pill>
        )}
      </div>

      {!quota.supported && (
        <p className="text-sm text-gray-500">{quota.note || 'Usage reporting is not available for this provider.'}</p>
      )}

      {quota.supported && quota.error && (
        <div className="flex items-start gap-2 text-sm text-gray-400 py-1">
          <AlertTriangle size={15} className="text-port-warning mt-0.5 shrink-0" />
          <span>{quota.error}</span>
        </div>
      )}

      {quota.supported && !quota.error && (
        <div className="space-y-2">
          {quota.limits?.length > 0 ? (
            <div>
              {quota.limits.map((limit) => (
                <UsageMeter key={limit.key} limit={limit} />
              ))}
            </div>
          ) : (
            <div className="text-gray-500 text-sm">No rate-limit data reported</div>
          )}

          {quota.activity?.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              {quota.activity.map((a) => (
                <div key={a.period} className="bg-port-bg border border-port-border rounded-lg p-2.5">
                  <div className="text-xs text-gray-400 mb-0.5">{a.period}</div>
                  <div className="text-sm text-white">
                    {formatCompactCount(a.requests)} requests
                    <span className="mx-2 text-gray-600">•</span>
                    {formatCompactCount(a.sessions)} sessions
                  </div>
                </div>
              ))}
            </div>
          )}

          {quota.note && (
            <p className="text-[10px] sm:text-xs text-gray-500">{quota.note}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Subscription usage for every enabled provider family (claude, codex, agy,
// grok). Self-contained fetch/loading/error state so it always renders above
// the PortOS-internal metrics.
function ProviderQuotaSection() {
  const [quotas, setQuotas] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(false);
    const result = await api.getProviderUsage({ refresh }).catch(() => null);
    if (result?.providers) {
      setQuotas(result.providers);
    } else {
      // Keep previously-loaded cards on a transient refresh failure.
      setError(true);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Subscription Usage</h2>
        <button
          onClick={() => load(true)}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-white disabled:opacity-50"
          title="Refresh provider usage"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {loading && !quotas && (
        <div className="py-6"><BrailleSpinner text="Reading provider usage" /></div>
      )}

      {!loading && error && !quotas && (
        <div className="flex items-start gap-2 text-sm text-gray-400 py-2">
          <AlertTriangle size={16} className="text-port-warning mt-0.5 shrink-0" />
          <span>Couldn&rsquo;t read provider usage.</span>
        </div>
      )}

      {quotas && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
          {quotas.map((quota) => (
            <ProviderQuotaCard key={quota.family} quota={quota} />
          ))}
          {quotas.length === 0 && (
            <div className="text-gray-500 text-sm">No enabled providers report subscription usage.</div>
          )}
        </div>
      )}
    </div>
  );
}

// Approximate-rate marker: anything other than an exact model-id rate match.
const approxMark = (rateMatch) => (rateMatch === 'exact' || rateMatch === 'free' ? '' : '~');

function CostReportTable({ report }) {
  if (!report?.providers?.length) {
    return <div className="text-gray-500 text-sm py-4">No per-provider usage recorded in this period.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[560px]">
        <thead>
          <tr className="text-left text-xs text-gray-500 border-b border-port-border">
            <th className="py-2 pr-2 font-medium">Provider / Model</th>
            <th className="py-2 px-2 font-medium text-right">Sessions</th>
            <th className="py-2 px-2 font-medium text-right">Tokens In</th>
            <th className="py-2 px-2 font-medium text-right">Tokens Out</th>
            <th className="py-2 pl-2 font-medium text-right">Est. API Cost</th>
          </tr>
        </thead>
        <tbody>
          {report.providers.map((provider) => (
            <ProviderCostRows key={provider.id} provider={provider} />
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-port-border font-semibold text-white">
            <td className="py-2 pr-2">Total</td>
            <td className="py-2 px-2 text-right">{formatNumber(report.totals.sessions)}</td>
            <td className="py-2 px-2 text-right">{formatNumber(report.totals.tokensIn)}</td>
            <td className="py-2 px-2 text-right">{formatNumber(report.totals.tokensOut)}</td>
            <td className="py-2 pl-2 text-right text-port-success">{formatCost(report.totals.estimatedCost)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ProviderCostRows({ provider }) {
  return (
    <>
      <tr className="border-t border-port-border text-white">
        <td className="py-2 pr-2">
          <span className="font-medium">{provider.name}</span>
          {provider.free && (
            <Pill tone="success" size="xs" className="ml-2 uppercase tracking-wide">Local — free</Pill>
          )}
        </td>
        <td className="py-2 px-2 text-right">{formatNumber(provider.sessions)}</td>
        <td className="py-2 px-2 text-right">{formatNumber(provider.tokensIn)}</td>
        <td className="py-2 px-2 text-right">{formatNumber(provider.tokensOut)}</td>
        <td className="py-2 pl-2 text-right">{formatCost(provider.estimatedCost)}</td>
      </tr>
      {provider.models.map((m) => (
        <tr key={m.model} className="text-gray-400">
          <td className="py-1.5 pr-2 pl-4 sm:pl-6 font-mono text-xs truncate max-w-[220px]" title={m.rateModel ? `Priced as ${m.rateModel} ($${m.inputPer1M}/$${m.outputPer1M} per 1M)` : undefined}>
            {m.model}
          </td>
          <td className="py-1.5 px-2 text-right text-xs">{formatNumber(m.sessions)}</td>
          <td className="py-1.5 px-2 text-right text-xs">{formatNumber(m.tokensIn)}</td>
          <td className="py-1.5 px-2 text-right text-xs">{formatNumber(m.tokensOut)}</td>
          <td className="py-1.5 pl-2 text-right text-xs" title={approxMark(m.rateMatch) ? 'Approximate — no exact published rate for this model id' : undefined}>
            {approxMark(m.rateMatch)}{formatCost(m.estimatedCost)}
          </td>
        </tr>
      ))}
    </>
  );
}

// Time-filter pills + custom range, driven by URL search params so every
// report view is shareable/bookmarkable (linkable-routes convention).
function CostReportFilters({ period, from, to, isCustom, onPeriod, onRange }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {PERIOD_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onPeriod(opt.id)}
          className={`px-3 py-1 rounded-full text-xs sm:text-sm border ${!isCustom && period === opt.id
            ? 'bg-port-accent/20 border-port-accent text-white'
            : 'border-port-border text-gray-400 hover:text-white'}`}
        >
          {opt.label}
        </button>
      ))}
      <div className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${isCustom ? 'border-port-accent bg-port-accent/10' : 'border-port-border'}`}>
        <label htmlFor="usage-from" className="text-xs text-gray-400">From</label>
        <input
          id="usage-from"
          type="date"
          value={from}
          onChange={(e) => onRange(e.target.value, to)}
          className="bg-transparent text-xs text-white outline-none [color-scheme:dark]"
        />
        <label htmlFor="usage-to" className="text-xs text-gray-400">To</label>
        <input
          id="usage-to"
          type="date"
          value={to}
          onChange={(e) => onRange(from, e.target.value)}
          className="bg-transparent text-xs text-white outline-none [color-scheme:dark]"
        />
      </div>
    </div>
  );
}

function InternalUsageMetrics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = searchParams.get('period') || '7d';
  const from = searchParams.get('from') || '';
  const to = searchParams.get('to') || '';
  const isCustom = Boolean(from || to);

  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = isCustom ? { from, to } : { period };
    api.getUsage(params)
      .catch(() => null)
      .then((data) => {
        if (cancelled) return;
        // Keep the previously-loaded metrics on a failed fetch (e.g. an
        // in-progress custom range where from > to briefly 400s) so the
        // filter controls stay on screen for the user to correct the range.
        if (data) setUsage(data);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [period, from, to, isCustom]);

  const setPeriod = (id) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('from');
      next.delete('to');
      if (id === '7d') next.delete('period'); else next.set('period', id);
      return next;
    }, { replace: true });
  };

  const setRange = (nextFrom, nextTo) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('period');
      if (nextFrom) next.set('from', nextFrom); else next.delete('from');
      if (nextTo) next.set('to', nextTo); else next.delete('to');
      return next;
    }, { replace: true });
  };

  if (loading && !usage) {
    return <div className="text-center py-8"><BrailleSpinner text="Loading usage data" /></div>;
  }

  if (!usage) {
    return <div className="text-center py-8 text-gray-500">No usage data available</div>;
  }

  const maxActivity = Math.max(1, ...(usage.last7Days?.map(d => d.sessions) || []));
  const report = usage.report;

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-white">PortOS AI Usage</h2>

      {/* Summary Stats (all-time) */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
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
      </div>

      {/* Cost report — range-filtered per-provider/per-model breakdown */}
      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <h3 className="text-sm font-medium text-gray-400">Est. API Cost Report</h3>
          <span className="text-xl font-bold text-port-success">{formatCost(report?.totals?.estimatedCost)}</span>
        </div>
        <CostReportFilters period={period} from={from} to={to} isCustom={isCustom} onPeriod={setPeriod} onRange={setRange} />
        <CostReportTable report={report} />
        <p className="text-[10px] sm:text-xs text-gray-500">
          Informational estimate of what this usage would have cost under API billing (PortOS runs on subscriptions).
          Token counts are partially estimated; rates as of {report?.pricingAsOf || 'the last update'}, excluding prompt-caching and batch discounts.
          {report?.breakdownSince && <> Per-provider breakdown available from {report.breakdownSince}.</>}
          {' '}Rows marked ~ use an approximated rate.
        </p>
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
    </div>
  );
}

export function UsagePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Usage</h1>
      <ProviderQuotaSection />
      <InternalUsageMetrics />
    </div>
  );
}

export default UsagePage;
