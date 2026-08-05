import { useCallback, useState, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { RefreshCw, Clock, AlertTriangle, DatabaseZap } from 'lucide-react';
import * as api from '../services/api';
import BrailleSpinner from '../components/BrailleSpinner';
import PageSkeleton from '../components/ui/PageSkeleton';
import Pill from '../components/ui/Pill';
import { formatCompactCount, timeUntil } from '../utils/formatters';
import { useAsyncAction } from '../hooks/useAsyncAction';
import { useAutoRefetch } from '../hooks/useAutoRefetch';

// How often to re-ask while a provider's quota reading is still being taken. A
// CLI/TUI scrape is a 10-20s spawn, so this is a handful of polls, not a loop.
const PENDING_POLL_MS = 4000;

const PERIOD_OPTIONS = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' }
];

// Preserve the em-dash empty-state; delegate K/M abbreviation to the shared helper.
const formatNumber = (num) => (num == null ? '—' : formatCompactCount(num));

const formatCost = (cost) => `$${(cost ?? 0).toFixed(2)}`;

// Every provider adapter normalizes its reset to ISO before it reaches here, so
// this localizes and adds the relative "in 3h" that makes a reset time useful at
// a glance. The raw-text fallback stays for a reading off an older peer that
// still emits its CLI's own wording.
const formatResetsAt = (resetsAt) => {
  if (!resetsAt || !/^\d{4}-\d{2}-\d{2}T/.test(resetsAt)) return resetsAt;
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return resetsAt;
  const local = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const relative = timeUntil(d, '');
  return relative ? `${local} (${relative})` : local;
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

// Small labelled stat, used for both the per-period activity counts and the
// `metrics[]` a backend returns when its quota can't be queried at all.
function StatTile({ label, value, detail }) {
  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-2.5">
      <div className="text-xs text-gray-400 mb-0.5">{label}</div>
      <div className="text-sm text-white">{value}</div>
      {detail && <div className="text-[10px] sm:text-xs text-gray-500 mt-0.5">{detail}</div>}
    </div>
  );
}

// One subscription-quota card per enabled provider family. Providers with no
// queryable usage surface (supported: false) render a muted note, never an
// error; a supported adapter that failed transiently shows a soft warning.
function ProviderQuotaCard({ quota, onRefresh, refreshing, disabled }) {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-base font-semibold text-white">{quota.label}</h3>
        <div className="flex items-center gap-2 shrink-0">
          {quota.plan && quota.plan !== 'unknown' && (
            <Pill tone="context" size="xs">{quota.plan}</Pill>
          )}
          {/* Per-card refresh: every family's reading is its own multi-second
              CLI/TUI scrape, so re-reading one provider must not respawn all
              of them. */}
          <button
            type="button"
            onClick={() => onRefresh(quota.family)}
            disabled={refreshing || disabled}
            className="text-gray-400 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed"
            title={`Refresh ${quota.label} usage`}
            aria-label={`Refresh ${quota.label} usage`}
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {!quota.supported && (
        <p className="text-sm text-gray-500">{quota.note || 'Usage reporting is not available for this provider.'}</p>
      )}

      {/* The reading is still being taken. It comes BEFORE the error and empty
          branches because a pending card has no limits — rendering it through
          those says "No rate-limit data reported", which is a verdict about the
          provider rather than a statement about a scrape still in flight. */}
      {quota.supported && quota.pending && (
        <div className="flex items-center gap-2 text-sm text-gray-400 py-1">
          <BrailleSpinner />
          <span>{quota.note || 'Reading quota…'}</span>
        </div>
      )}

      {quota.supported && !quota.pending && quota.error && (
        <div className="flex items-start gap-2 text-sm text-gray-400 py-1">
          <AlertTriangle size={15} className="text-port-warning mt-0.5 shrink-0" />
          <span>{quota.error}</span>
        </div>
      )}

      {quota.supported && !quota.pending && !quota.error && (
        <div className="space-y-2">
          {quota.limits?.length > 0 && (
            <div>
              {quota.limits.map((limit) => (
                <UsageMeter key={limit.key} limit={limit} />
              ))}
            </div>
          )}

          {!quota.limits?.length && !quota.metrics?.length && (
            <div className="text-gray-500 text-sm">No rate-limit data reported</div>
          )}

          {/* Backends with no queryable quota report observed counts instead of
              a meter — a percentage we cannot measure must not be invented. */}
          {quota.metrics?.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {quota.metrics.map((m) => (
                <StatTile key={m.key} label={m.label} value={m.value} detail={m.detail} />
              ))}
            </div>
          )}

          {quota.activity?.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
              {quota.activity.map((a) => (
                <StatTile
                  key={a.period}
                  label={a.period}
                  value={(
                    <>
                      {formatCompactCount(a.requests)} requests
                      <span className="mx-2 text-gray-600">•</span>
                      {formatCompactCount(a.sessions)} sessions
                    </>
                  )}
                />
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
  const [refreshingFamilies, setRefreshingFamilies] = useState(() => new Set());

  const load = useCallback(async (refresh = false) => {
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
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh ONE provider card. The whole-section Refresh spawns every family's
  // scrape at once (10-20s each); this asks for the single card the user
  // clicked and swaps it in when the reading lands, leaving every other card's
  // reading — and its age — untouched. A failure toasts through the request
  // helper; the catch here only clears the spinner, it owns no error UI.
  const refreshFamily = useCallback(async (family) => {
    setRefreshingFamilies((prev) => new Set(prev).add(family));
    const result = await api.getProviderUsage({ refresh: true, family, silent: false }).catch(() => null);
    if (result?.providers) {
      const card = result.providers.find((q) => q.family === family);
      // No card back for a family we asked for means it is no longer enabled
      // (its provider was turned off) — drop it rather than leave a reading
      // that can never refresh again. `prev` is always an array here: the
      // button that got us here only renders once quotas have loaded.
      setQuotas((prev) => (card
        ? prev.map((q) => (q.family === family ? card : q))
        : prev.filter((q) => q.family !== family)));
    }
    setRefreshingFamilies((prev) => {
      const next = new Set(prev);
      next.delete(family);
      return next;
    });
  }, []);

  // A quota read never blocks the response: a cold cache answers with `pending`
  // cards and the reading lands behind it. Without this poll those cards would
  // sit on "reading quota…" until the user hit Refresh by hand. Enabled only
  // while something is pending — the section does not otherwise auto-refresh.
  const anyPending = (quotas || []).some((quota) => quota.pending);
  useAutoRefetch(load, PENDING_POLL_MS, { enabled: anyPending, immediate: false, pollOnly: true });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Subscription Usage</h1>
        <button
          onClick={() => load(true)}
          disabled={loading}
          className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-white disabled:opacity-50"
          title="Refresh every provider's usage"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} /> Refresh all
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
            <ProviderQuotaCard
              key={quota.family}
              quota={quota}
              onRefresh={refreshFamily}
              refreshing={refreshingFamilies.has(quota.family)}
              disabled={loading}
            />
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

// How a row's token counts were obtained. `measured` rows are summed from the
// provider CLI's own transcript; `estimate` rows are derived from prompt length
// and captured stdout and understate real usage substantially. Distinguishing
// them is the point of #3124 — a headline figure that mixes the two silently is
// what made the old report unusable.
const SOURCE_LABELS = {
  measured: { label: 'Measured', tone: 'success', title: 'Token counts read from the provider CLI’s own transcript' },
  mixed: { label: 'Part est.', tone: 'warning', title: 'Some counts measured from the provider transcript, some estimated' },
  estimate: { label: 'Estimated', tone: 'context', title: 'Estimated from prompt length and captured output — understates per-turn context and cache traffic' }
};

function SourcePill({ source, className = '' }) {
  const meta = SOURCE_LABELS[source] || SOURCE_LABELS.estimate;
  return (
    <Pill tone={meta.tone} size="xs" className={className} title={meta.title}>{meta.label}</Pill>
  );
}

function CostReportTable({ report }) {
  if (!report?.providers?.length) {
    return <div className="text-gray-500 text-sm py-4">No per-provider usage recorded in this period.</div>;
  }
  return (
    <>
      {/* Mobile view (< sm): Card list for easy mobile reading without horizontal scroll */}
      <div className="block sm:hidden space-y-3">
        {report.providers.map((provider) => (
          <div key={provider.id} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium text-white text-sm truncate">{provider.name}</span>
                {provider.free && (
                  <Pill tone="success" size="xs" className="uppercase tracking-wide shrink-0">Local</Pill>
                )}
                {!provider.free && <SourcePill source={provider.source} className="shrink-0" />}
              </div>
              <span className="text-sm font-semibold text-port-success shrink-0" title={approxMark(provider.rateMatch) ? 'Approximate pricing' : undefined}>
                {approxMark(provider.rateMatch)}{formatCost(provider.estimatedCost)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs text-gray-400 bg-port-card/50 p-2 rounded border border-port-border/50">
              <div>
                <span className="text-gray-500 block text-[10px]">Sessions</span>
                <span className="text-white font-medium">{formatNumber(provider.sessions)}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-[10px]">Tokens (In / Out)</span>
                <span className="text-white font-medium">{formatNumber(provider.tokensIn)} / {formatNumber(provider.tokensOut)}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-[10px]">Cache Read</span>
                <span className="text-gray-300">{formatNumber(provider.cacheReadTokens)}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-[10px]">Cache Write</span>
                <span className="text-gray-300">{formatNumber(provider.cacheWriteTokens)}</span>
              </div>
            </div>

            {provider.models?.length > 0 && (
              <div className="space-y-1.5 pt-1.5 border-t border-port-border/40">
                <div className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Models</div>
                {provider.models.map((m) => (
                  <div key={m.model} className="bg-port-card/30 p-2 rounded text-xs space-y-1">
                    <div className="flex items-center justify-between font-mono text-gray-300 text-[11px]">
                      <span className="truncate pr-2" title={m.model}>{m.model}</span>
                      <span className="text-gray-400 shrink-0 font-sans font-medium">{approxMark(m.rateMatch)}{formatCost(m.estimatedCost)}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-gray-400">
                      <span>{formatNumber(m.sessions)} sess</span>
                      <span>{formatNumber(m.tokensIn)} in · {formatNumber(m.tokensOut)} out</span>
                      <span>Cache: {formatNumber((m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0))}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        <div className="bg-port-bg border border-port-border rounded-lg p-3 flex items-center justify-between text-xs font-semibold text-white">
          <span>Total ({formatNumber(report.totals.sessions)} sessions)</span>
          <span className="text-port-success text-sm">{formatCost(report.totals.estimatedCost)}</span>
        </div>
      </div>

      {/* Desktop view (>= sm): Table layout */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm min-w-[680px]">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-port-border">
              <th className="py-2 pr-2 font-medium">Provider / Model</th>
              <th className="py-2 px-2 font-medium text-right">Sessions</th>
              <th className="py-2 px-2 font-medium text-right">Tokens In</th>
              <th className="py-2 px-2 font-medium text-right hidden md:table-cell">Cache Read</th>
              <th className="py-2 px-2 font-medium text-right hidden md:table-cell">Cache Write</th>
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
              <td className="py-2 px-2 text-right hidden md:table-cell">{formatNumber(report.totals.cacheReadTokens)}</td>
              <td className="py-2 px-2 text-right hidden md:table-cell">{formatNumber(report.totals.cacheWriteTokens)}</td>
              <td className="py-2 px-2 text-right">{formatNumber(report.totals.tokensOut)}</td>
              <td className="py-2 pl-2 text-right text-port-success">{formatCost(report.totals.estimatedCost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

// Cache token counts, with the hidden-on-mobile columns' values folded into a
// title so the numbers stay reachable when the columns collapse.
const cacheTitle = (row) =>
  `Cache read ${(row.cacheReadTokens ?? 0).toLocaleString()} · cache write ${(row.cacheWriteTokens ?? 0).toLocaleString()} tokens`;

function ProviderCostRows({ provider }) {
  return (
    <>
      <tr className="border-t border-port-border text-white">
        <td className="py-2 pr-2">
          <span className="font-medium">{provider.name}</span>
          {provider.free && (
            <Pill tone="success" size="xs" className="ml-2 uppercase tracking-wide">Local — free</Pill>
          )}
          {!provider.free && <SourcePill source={provider.source} className="ml-2" />}
        </td>
        <td className="py-2 px-2 text-right" title={cacheTitle(provider)}>{formatNumber(provider.sessions)}</td>
        <td className="py-2 px-2 text-right" title={cacheTitle(provider)}>{formatNumber(provider.tokensIn)}</td>
        <td className="py-2 px-2 text-right hidden md:table-cell">{formatNumber(provider.cacheReadTokens)}</td>
        <td className="py-2 px-2 text-right hidden md:table-cell">{formatNumber(provider.cacheWriteTokens)}</td>
        <td className="py-2 px-2 text-right">{formatNumber(provider.tokensOut)}</td>
        <td
          className="py-2 pl-2 text-right"
          title={approxMark(provider.rateMatch) ? 'Approximate — provider or legacy usage uses fallback pricing' : undefined}
        >
          {approxMark(provider.rateMatch)}{formatCost(provider.estimatedCost)}
        </td>
      </tr>
      {provider.models.map((m) => (
        <tr key={m.model} className="text-gray-400">
          <td
            className="py-1.5 pr-2 pl-4 sm:pl-6 font-mono text-xs truncate max-w-[220px]"
            title={m.rateModel
              ? `Priced as ${m.rateModel} ($${m.inputPer1M}/$${m.outputPer1M} per 1M in/out; $${m.cacheReadPer1M}/$${m.cacheWritePer1M} per 1M cache read/write)`
              : undefined}
          >
            {m.model}
          </td>
          <td className="py-1.5 px-2 text-right text-xs">{formatNumber(m.sessions)}</td>
          <td className="py-1.5 px-2 text-right text-xs" title={cacheTitle(m)}>{formatNumber(m.tokensIn)}</td>
          <td className="py-1.5 px-2 text-right text-xs hidden md:table-cell">{formatNumber(m.cacheReadTokens)}</td>
          <td className="py-1.5 px-2 text-right text-xs hidden md:table-cell">{formatNumber(m.cacheWriteTokens)}</td>
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

// Derive top providers for the active period (or fallback to usage.topProviders)
function getPeriodTopProviders(usage) {
  if (usage?.report?.providers?.length) {
    const totalTokens = usage.report.providers.reduce(
      (sum, p) => sum + (p.tokensIn || 0) + (p.tokensOut || 0),
      0
    ) || usage.report.providers.reduce((sum, p) => sum + (p.sessions || 0), 0) || 1;

    return usage.report.providers
      .map((p) => {
        const tokens = (p.tokensIn || 0) + (p.tokensOut || 0);
        return {
          id: p.id,
          name: p.name,
          sessions: p.sessions || 0,
          tokens: tokens || (p.tokens ?? 0),
          tokensIn: p.tokensIn,
          tokensOut: p.tokensOut,
          cacheReadTokens: p.cacheReadTokens,
          cacheWriteTokens: p.cacheWriteTokens,
          estimatedCost: p.estimatedCost,
          free: p.free,
          source: p.source,
          rateMatch: p.rateMatch,
          percent: Math.min(100, Math.round(((tokens || p.sessions || 0) / totalTokens) * 100))
        };
      })
      .sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions)
      .slice(0, 5);
  }

  const totalTokens = usage?.topProviders?.reduce((sum, p) => sum + (p.tokens || 0), 0)
    || usage?.topProviders?.reduce((sum, p) => sum + (p.sessions || 0), 0) || 1;

  return (usage?.topProviders || []).map((p) => ({
    id: p.id || p.name,
    name: p.name,
    sessions: p.sessions || 0,
    tokens: p.tokens || 0,
    percent: Math.min(100, Math.round(((p.tokens || p.sessions || 0) / totalTokens) * 100))
  }));
}

// Derive top models for the active period (or fallback to usage.topModels)
function getPeriodTopModels(usage) {
  if (usage?.report?.providers?.length) {
    const allModels = [];
    for (const p of usage.report.providers) {
      for (const m of (p.models || [])) {
        const tokens = (m.tokensIn || 0) + (m.tokensOut || 0);
        allModels.push({
          model: m.model,
          providerName: p.name,
          sessions: m.sessions || 0,
          tokens: tokens || (m.tokens ?? 0),
          tokensIn: m.tokensIn,
          tokensOut: m.tokensOut,
          cacheReadTokens: m.cacheReadTokens,
          cacheWriteTokens: m.cacheWriteTokens,
          estimatedCost: m.estimatedCost,
          rateMatch: m.rateMatch
        });
      }
    }
    if (allModels.length > 0) {
      const totalTokens = allModels.reduce((sum, m) => sum + m.tokens, 0)
        || allModels.reduce((sum, m) => sum + m.sessions, 0) || 1;

      return allModels
        .map((m) => ({
          ...m,
          percent: Math.min(100, Math.round(((m.tokens || m.sessions || 0) / totalTokens) * 100))
        }))
        .sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions)
        .slice(0, 5);
    }
  }

  const totalTokens = usage?.topModels?.reduce((sum, m) => sum + (m.tokens || 0), 0)
    || usage?.topModels?.reduce((sum, m) => sum + (m.sessions || 0), 0) || 1;

  return (usage?.topModels || []).map((m) => ({
    model: m.model,
    sessions: m.sessions || 0,
    tokens: m.tokens || 0,
    percent: Math.min(100, Math.round(((m.tokens || m.sessions || 0) / totalTokens) * 100))
  }));
}

function InternalUsageMetrics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const period = searchParams.get('period') || '7d';
  const from = searchParams.get('from') || '';
  const to = searchParams.get('to') || '';
  const isCustom = Boolean(from || to);

  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [backfill, setBackfill] = useState(null);

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

  useEffect(() => {
    let cancelled = false;
    api.getUsageBackfillStatus({ silent: true })
      .then((status) => { if (!cancelled) setBackfill(status); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const [startBackfill, startingBackfill] = useAsyncAction(async () => {
    const status = await api.startUsageBackfill({ silent: true });
    setBackfill(status);
  }, { errorMessage: 'Failed to start historical usage reconciliation' });

  useEffect(() => {
    if (backfill?.status !== 'running') return undefined;
    let cancelled = false;
    let timer = null;
    const poll = () => {
      api.getUsageBackfillStatus({ silent: true })
        .then(async (status) => {
          if (cancelled) return;
          setBackfill(status);
          if (status?.status === 'complete') {
            const params = isCustom ? { from, to } : { period };
            const refreshed = await api.getUsage(params);
            if (!cancelled) setUsage(refreshed);
          } else if (status?.status === 'running') {
            timer = setTimeout(poll, 1000);
          }
        })
        .catch(() => {});
    };
    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [backfill?.status, isCustom, from, to, period]);


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
    return (
      <PageSkeleton
        label="Loading usage data"
        titleWidthClass="w-44"
        showAction={false}
        layout="grid"
        gridColsClass="grid-cols-2 sm:grid-cols-4"
        cards={4}
      />
    );
  }

  if (!usage) {
    return <div className="text-center py-8 text-gray-500">No usage data available</div>;
  }

  const maxActivity = Math.max(1, ...(usage.last7Days?.map(d => d.sessions) || []));
  const report = usage.report;

  const topProvidersList = getPeriodTopProviders(usage);
  const topModelsList = getPeriodTopModels(usage);

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-white">PortOS AI Usage</h2>

      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-white">
            <DatabaseZap size={16} className="text-port-accent" />
            Reconcile historical usage
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Re-read PortOS run transcripts to replace older token estimates. This changes recorded history but makes no provider calls.
          </p>
          {backfill?.status === 'running' && (
            <p className="text-xs text-port-accent mt-1" role="status">
              Processing {backfill.processed || 0} of {backfill.total || 0} runs…
            </p>
          )}
          {backfill?.status === 'complete' && (
            <p className="text-xs text-port-success mt-1" role="status">
              Corrected {backfill.corrected || 0} run{backfill.corrected === 1 ? '' : 's'}.
            </p>
          )}
          {backfill?.status === 'error' && (
            <p className="text-xs text-port-error mt-1" role="alert">{backfill.error}</p>
          )}
        </div>
        <button
          type="button"
          onClick={startBackfill}
          disabled={startingBackfill || backfill?.status === 'running'}
          className="shrink-0 inline-flex items-center justify-center gap-2 rounded-lg border border-port-border px-3 py-2 text-sm text-white hover:border-port-accent disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {(startingBackfill || backfill?.status === 'running') ? <BrailleSpinner /> : <DatabaseZap size={15} />}
          {backfill?.status === 'running' ? 'Reconciling…' : 'Reconcile now'}
        </button>
      </div>

      {/* Summary Stats (all-time) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(usage.totalSessions)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Sessions</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber(usage.totalMessages)}</div>
          <div className="text-xs sm:text-sm text-gray-400">Messages</div>
        </div>
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 text-center">
          <div className="text-xl sm:text-2xl font-bold text-white">{formatNumber((usage.totalTokens?.input ?? 0) + (usage.totalTokens?.output ?? 0))}</div>
          <div className="text-xs sm:text-sm text-gray-400">Tokens</div>
        </div>
      </div>

      {/* Cost report — range-filtered per-provider/per-model breakdown */}
      <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium text-gray-400">Est. API Cost Report</h3>
            {report?.breakdownSince && (
              <p className="text-[10px] sm:text-xs text-port-warning">
                Provider/model detail starts {report.breakdownSince}; earlier usage is grouped as legacy.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {report?.totals?.source && <SourcePill source={report.totals.source} />}
            <span className="text-xl font-bold text-port-success">{formatCost(report?.totals?.estimatedCost)}</span>
          </div>
        </div>
        <CostReportFilters period={period} from={from} to={to} isCustom={isCustom} onPeriod={setPeriod} onRange={setRange} />
        <CostReportTable report={report} />
        <p className="text-[10px] sm:text-xs text-gray-500">
          Informational estimate of what this usage would have cost under API billing (PortOS runs on subscriptions).
          {' '}<span className="text-gray-400">Measured</span> rows are the provider CLI&rsquo;s own per-message counts, read from its local
          transcript — full per-turn input, output, and prompt-cache reads/writes, each priced at its own rate.
          {' '}<span className="text-gray-400">Estimated</span> rows are runs with no readable transcript (local models, or a provider
          that writes none): input is approximated from the initial prompt only and cache traffic is not counted, so those rows
          understate real usage substantially.
          Rates are as of {report?.pricingAsOf || 'the last update'} and exclude batch and long-context tiers.
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
          <h3 className="text-sm font-medium text-gray-400 mb-2 sm:mb-3 flex items-center justify-between">
            <span>Top Providers</span>
            <span className="text-xs text-gray-500 font-normal">By usage volume</span>
          </h3>
          <div className="space-y-3">
            {topProvidersList.map((provider, i) => (
              <div key={i} className="py-1.5 border-b border-port-border last:border-0 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-white text-sm sm:text-base font-medium truncate">{provider.name}</span>
                    {provider.free && (
                      <Pill tone="success" size="xs" className="uppercase tracking-wide shrink-0">Local</Pill>
                    )}
                    {!provider.free && provider.source && (
                      <SourcePill source={provider.source} className="shrink-0" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-xs">
                    {provider.estimatedCost != null && provider.estimatedCost > 0 && (
                      <span className="text-port-success font-semibold">{formatCost(provider.estimatedCost)}</span>
                    )}
                    <span className="text-gray-400 bg-port-bg border border-port-border px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-mono">
                      {provider.percent}%
                    </span>
                  </div>
                </div>

                {/* Visual Usage Bar */}
                <div className="h-1.5 rounded-full bg-port-bg overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-port-accent to-blue-400 transition-all duration-300"
                    style={{ width: `${Math.max(2, provider.percent)}%` }}
                  />
                </div>

                {/* Detailed Breakdown stats */}
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>{provider.sessions} session{provider.sessions === 1 ? '' : 's'}</span>
                  <div className="flex items-center gap-1 sm:gap-2">
                    <span>{formatNumber(provider.tokens)} tokens</span>
                    {provider.tokensIn != null && provider.tokensOut != null && (
                      <span className="text-[10px] text-gray-500 hidden sm:inline">
                        ({formatNumber(provider.tokensIn)} in / {formatNumber(provider.tokensOut)} out)
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {topProvidersList.length === 0 && (
              <div className="text-gray-500 text-sm">No provider data</div>
            )}
          </div>
        </div>

        {/* Top Models */}
        <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4">
          <h3 className="text-sm font-medium text-gray-400 mb-2 sm:mb-3 flex items-center justify-between">
            <span>Top Models</span>
            <span className="text-xs text-gray-500 font-normal">By token output & volume</span>
          </h3>
          <div className="space-y-3">
            {topModelsList.map((model, i) => (
              <div key={i} className="py-1.5 border-b border-port-border last:border-0 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-white font-mono text-xs sm:text-sm truncate">{model.model}</span>
                    {model.providerName && (
                      <span className="text-[10px] text-gray-500 truncate hidden sm:inline">({model.providerName})</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0 text-xs">
                    {model.estimatedCost != null && model.estimatedCost > 0 && (
                      <span className="text-port-success font-semibold">{formatCost(model.estimatedCost)}</span>
                    )}
                    <span className="text-gray-400 bg-port-bg border border-port-border px-1.5 py-0.5 rounded text-[10px] sm:text-xs font-mono">
                      {model.percent}%
                    </span>
                  </div>
                </div>

                {/* Visual Usage Bar */}
                <div className="h-1.5 rounded-full bg-port-bg overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-300"
                    style={{ width: `${Math.max(2, model.percent)}%` }}
                  />
                </div>

                {/* Detailed Breakdown stats */}
                <div className="flex items-center justify-between text-xs text-gray-400">
                  <span>{model.sessions} session{model.sessions === 1 ? '' : 's'}</span>
                  <div className="flex items-center gap-1 sm:gap-2">
                    <span>{formatNumber(model.tokens)} tokens</span>
                    {model.tokensIn != null && model.tokensOut != null && (
                      <span className="text-[10px] text-gray-500 hidden sm:inline">
                        ({formatNumber(model.tokensIn)} in / {formatNumber(model.tokensOut)} out)
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {topModelsList.length === 0 && (
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
      <ProviderQuotaSection />
      <InternalUsageMetrics />
    </div>
  );
}

export default UsagePage;
