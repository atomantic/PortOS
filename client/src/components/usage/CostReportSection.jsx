import { useEffect, useState } from 'react';
import Pill from '../ui/Pill';
import { formatCompactCountOrDash as formatNumber, formatCount, formatUsd } from '../../utils/formatters';
import { USAGE_PERIOD_OPTIONS } from '../../lib/usagePeriods';

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

export function SourcePill({ source, className = '' }) {
  const meta = SOURCE_LABELS[source] || SOURCE_LABELS.estimate;
  return (
    <Pill tone={meta.tone} size="xs" className={className} title={meta.title}>{meta.label}</Pill>
  );
}

/**
 * Where this machine's token counts come from. Each provider app's own session
 * records are the source of truth from the day its history is complete; before
 * that, the larger of the app's history and PortOS's run records is shown.
 */
export function NativeSourcesNote({ sources }) {
  const read = (sources || []).filter((source) => source.hasHistory && source.coverageStart);
  if (!read.length) return null;
  return (
    <p>
      Tokens for {read.map((source) => `${source.label} (from ${source.coverageStart})`).join(', ')} come from each app&rsquo;s own session records on this machine,
      plus PortOS runs the app does not save. Earlier days use whichever of the two counted more.
    </p>
  );
}

// Cache token counts, with the hidden-on-mobile columns' values folded into a
// title so the numbers stay reachable when the columns collapse.
const cacheTitle = (row) =>
  `Cache read ${formatCount(row.cacheReadTokens, { fallback: '0' })} · cache write ${formatCount(row.cacheWriteTokens, { fallback: '0' })} tokens`;

// Imagine units and the 200k subset are not visible in the token columns.
function usageExtras(row) {
  if (!row) return '';
  const parts = [];
  if (row.images > 0) parts.push(`${formatNumber(row.images)} images`);
  if (row.inputImages > 0) parts.push(`${formatNumber(row.inputImages)} input images`);
  if (row.videoSeconds > 0) parts.push(`${formatNumber(row.videoSeconds)}s video`);
  const longTokens = (row.longTokensIn || 0) + (row.longCacheReadTokens || 0) + (row.longCacheWriteTokens || 0);
  if (longTokens > 0) parts.push(`${formatNumber(longTokens)} long-context`);
  const speedTokens = (prefix) => (row[`${prefix}TokensIn`] || 0) + (row[`${prefix}TokensOut`] || 0)
    + (row[`${prefix}CacheReadTokens`] || 0) + (row[`${prefix}CacheWriteTokens`] || 0);
  if (speedTokens('fast') > 0) parts.push(`${formatNumber(speedTokens('fast'))} fast`);
  if (speedTokens('ultrafast') > 0) parts.push(`${formatNumber(speedTokens('ultrafast'))} ultrafast`);
  return parts.join(' · ');
}

export function ProviderCostRows({ provider }) {
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
          {provider.estimatedCost == null ? '—' : `${approxMark(provider.rateMatch)}${formatUsd(provider.estimatedCost)}`}
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
            {usageExtras(m) && (
              <div className="font-sans text-[10px] text-gray-500 truncate">{usageExtras(m)}</div>
            )}
          </td>
          <td className="py-1.5 px-2 text-right text-xs">{formatNumber(m.sessions)}</td>
          <td className="py-1.5 px-2 text-right text-xs" title={cacheTitle(m)}>{formatNumber(m.tokensIn)}</td>
          <td className="py-1.5 px-2 text-right text-xs hidden md:table-cell">{formatNumber(m.cacheReadTokens)}</td>
          <td className="py-1.5 px-2 text-right text-xs hidden md:table-cell">{formatNumber(m.cacheWriteTokens)}</td>
          <td className="py-1.5 px-2 text-right text-xs">{formatNumber(m.tokensOut)}</td>
          <td className="py-1.5 pl-2 text-right text-xs" title={approxMark(m.rateMatch) ? 'Approximate — no exact published rate for this model id' : undefined}>
            {m.estimatedCost == null ? '—' : `${approxMark(m.rateMatch)}${formatUsd(m.estimatedCost)}`}
          </td>
        </tr>
      ))}
    </>
  );
}

export function CostReportTable({ report }) {
  if (!report?.providers?.length) {
    return <div className="text-gray-500 text-sm py-4">No per-provider usage recorded in this period.</div>;
  }
  return (
    <>
      {/* Mobile view (< sm): Card list for easy mobile reading without horizontal scroll */}
      <div className="block sm:hidden space-y-3">
        {report.providers.map((provider) => (
          <div key={provider.rowKey || provider.id} className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium text-white text-sm truncate">{provider.name}</span>
                {provider.free && (
                  <Pill tone="success" size="xs" className="uppercase tracking-wide shrink-0">Local</Pill>
                )}
                {!provider.free && <SourcePill source={provider.source} className="shrink-0" />}
              </div>
              <span className="text-sm font-semibold text-port-success shrink-0" title={approxMark(provider.rateMatch) ? 'Approximate pricing' : undefined}>
                {provider.estimatedCost == null ? '—' : `${approxMark(provider.rateMatch)}${formatUsd(provider.estimatedCost)}`}
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
                      <span className="text-gray-400 shrink-0 font-sans font-medium">{m.estimatedCost == null ? '—' : `${approxMark(m.rateMatch)}${formatUsd(m.estimatedCost)}`}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-gray-400">
                      <span>{formatNumber(m.sessions)} sess</span>
                      <span>{formatNumber(m.tokensIn)} in · {formatNumber(m.tokensOut)} out</span>
                      <span>Cache: {formatNumber((m.cacheReadTokens ?? 0) + (m.cacheWriteTokens ?? 0))}</span>
                    </div>
                    {usageExtras(m) && (
                      <div className="text-[10px] text-gray-500">{usageExtras(m)}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        <div className="bg-port-bg border border-port-border rounded-lg p-3 flex items-center justify-between text-xs font-semibold text-white">
          <span>Total ({formatNumber(report.totals.sessions)} sessions)</span>
          <span className="text-port-success text-sm">{report.totals.costIncomplete ? '≥ ' : ''}{formatUsd(report.totals.estimatedCost)}</span>
        </div>
      </div>

      {/* Desktop view (>= sm): Table layout */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm min-w-[680px]" aria-label="Provider token usage and costs">
          <thead>
            <tr className="text-left text-xs text-gray-400 border-b border-port-border">
              <th scope="col" className="py-2 pr-2 font-medium">Provider / Model</th>
              <th scope="col" className="py-2 px-2 font-medium text-right">Sessions</th>
              <th scope="col" className="py-2 px-2 font-medium text-right">Tokens In</th>
              <th scope="col" className="py-2 px-2 font-medium text-right hidden md:table-cell">Cache Read</th>
              <th scope="col" className="py-2 px-2 font-medium text-right hidden md:table-cell">Cache Write</th>
              <th scope="col" className="py-2 px-2 font-medium text-right">Tokens Out</th>
              <th scope="col" className="py-2 pl-2 font-medium text-right">Est. API Cost</th>
            </tr>
          </thead>
          <tbody>
            {report.providers.map((provider) => (
              <ProviderCostRows key={provider.rowKey || provider.id} provider={provider} />
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
              <td className="py-2 pl-2 text-right text-port-success">{report.totals.costIncomplete ? '≥ ' : ''}{formatUsd(report.totals.estimatedCost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

// Time-filter pills + custom range, driven by URL search params so every
// report view is shareable/bookmarkable (linkable-routes convention).
// A native date input reports "" while its mm/dd/yyyy segments are only
// partly typed, so binding it straight to the URL param wiped the field
// mid-keystroke. Hold the draft locally and commit only complete dates (or an
// explicit clear); re-sync when the committed value changes underneath.
export function RangeDateInput({ id, label, value, onCommit }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const handleChange = (e) => {
    const next = e.target.value;
    setDraft(next);
    if (next === '' && e.target.validity.badInput) return;
    // Typing a year passes through 0002, 0020, 0202 — valid dates, not intent.
    if (next !== '' && Number(next.slice(0, 4)) < 1900) return;
    if (next !== value) onCommit(next);
  };
  return (
    <input
      id={id}
      aria-label={label}
      type="date"
      value={draft}
      onChange={handleChange}
      className="bg-transparent text-xs text-white outline-none [color-scheme:dark]"
    />
  );
}

export function CostReportFilters({ period, from, to, isCustom, onPeriod, onRange }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {USAGE_PERIOD_OPTIONS.map((opt) => (
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
      <div className={`flex flex-wrap items-center gap-1.5 rounded-xl border px-2 py-0.5 ${isCustom ? 'border-port-accent bg-port-accent/10' : 'border-port-border'}`}>
        <div className="flex items-center gap-1.5">
          <label htmlFor="usage-from" className="text-xs text-gray-400">From</label>
          <RangeDateInput id="usage-from" label="From date" value={from} onCommit={(v) => onRange(v, to)} />
        </div>
        <div className="flex items-center gap-1.5">
          <label htmlFor="usage-to" className="text-xs text-gray-400">To</label>
          <RangeDateInput id="usage-to" label="To date" value={to} onCommit={(v) => onRange(from, v)} />
        </div>
      </div>
    </div>
  );
}

export function CostReportCard({ report }) {
  return (
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
          <span className="text-xl font-bold text-port-success">{report?.totals?.costIncomplete ? '≥ ' : ''}{formatUsd(report?.totals?.estimatedCost)}</span>
        </div>
      </div>
      <CostReportTable report={report} />
      <p className="text-[10px] sm:text-xs text-gray-500">
        Informational estimate of what this usage would have cost under API billing (PortOS runs on subscriptions).
        {' '}<span className="text-gray-400">Measured</span> rows come from the provider app&rsquo;s own session records — Claude Code,
        Codex, Grok and Antigravity write per-call input, output and prompt-cache counts for every session on the machine,
        terminal and desktop use included, each priced at its own rate.
        {' '}<span className="text-gray-400">Estimated</span> rows are usage no app recorded: PortOS one-shot runs the app does not
        save, older Antigravity turns without token fields, and local models, approximated from prompt and output text with no
        cache traffic counted — those rows understate real usage.
        {' '}OpenCode-backed runs (including zen) contribute the output tokens from the run&rsquo;s own event stream and stay
        estimated on input. Rates are as of {report?.pricingAsOf || 'the last update'}. They include Grok prompts at or above 200k tokens and transcript-confirmed Fast or Ultrafast on a published API schedule. Batch discounts, OpenAI long-context tiers, and subscription credit multipliers are not part of this estimate.
        {' '}Rows marked ~ use an approximated rate.
      </p>
    </div>
  );
}

// Derive top providers/models for the active period (or fallback to usage.top*)
function combineSummaryRows(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...row, estimatedCost: row.rawEstimatedCost ?? row.estimatedCost ?? 0, costIncomplete: row.estimatedCost == null });
      continue;
    }
    for (const field of ['sessions', 'tokens', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens']) existing[field] = (existing[field] || 0) + (row[field] || 0);
    existing.estimatedCost += row.rawEstimatedCost ?? row.estimatedCost ?? 0;
    existing.costIncomplete ||= row.estimatedCost == null;
    if (existing.free !== row.free) existing.free = null;
    if (existing.source !== row.source) existing.source = 'mixed';
  }
  return [...groups.values()].map((row) => ({ ...row, estimatedCost: Math.round(row.estimatedCost * 100) / 100 }));
}

export function getPeriodTopProviders(usage) {
  if (usage?.report?.providers) {
    const totalTokens = usage.report.providers.reduce(
      (sum, p) => sum + (p.tokensIn || 0) + (p.tokensOut || 0) + (p.cacheReadTokens || 0) + (p.cacheWriteTokens || 0),
      0
    ) || usage.report.providers.reduce((sum, p) => sum + (p.sessions || 0), 0) || 1;

    const rows = usage.report.providers
      .map((p) => {
        const tokens = (p.tokensIn || 0) + (p.tokensOut || 0) + (p.cacheReadTokens || 0) + (p.cacheWriteTokens || 0);
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
          rawEstimatedCost: p.rawEstimatedCost,
          free: p.free,
          source: p.source,
          rateMatch: p.rateMatch,
          percent: Math.min(100, Math.round(((tokens || p.sessions || 0) / totalTokens) * 100))
        };
      });
    return combineSummaryRows(rows, (row) => row.id)
      .map((row) => ({ ...row, percent: Math.min(100, Math.round(((row.tokens || row.sessions || 0) / totalTokens) * 100)) }))
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

export function getPeriodTopModels(usage) {
  if (usage?.report?.providers) {
    const allModels = [];
    for (const p of usage.report.providers) {
      for (const m of (p.models || [])) {
        const tokens = (m.tokensIn || 0) + (m.tokensOut || 0) + (m.cacheReadTokens || 0) + (m.cacheWriteTokens || 0);
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
          rawEstimatedCost: m.rawEstimatedCost,
          providerId: p.id,
          rateMatch: m.rateMatch
        });
      }
    }
    if (allModels.length > 0) {
      const totalTokens = allModels.reduce((sum, m) => sum + m.tokens, 0)
        || allModels.reduce((sum, m) => sum + m.sessions, 0) || 1;

      return combineSummaryRows(allModels, (row) => `${row.providerId}\u0000${row.model}`)
        .map((m) => ({
          ...m,
          percent: Math.min(100, Math.round(((m.tokens || m.sessions || 0) / totalTokens) * 100))
        }))
        .sort((a, b) => b.tokens - a.tokens || b.sessions - a.sessions)
        .slice(0, 5);
    }
    return [];
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
