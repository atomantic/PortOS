import { Gauge } from 'lucide-react';
import Banner from '../ui/Banner';
import { formatCount } from '../../utils/formatters';

// Static class names so Tailwind keeps them; order mirrors the server's fixed category order.
const CATEGORY_STYLE = {
  identity: 'bg-port-accent',
  instructions: 'bg-port-success',
  continuation_note: 'bg-port-warning',
  memories: 'bg-port-error',
  journal_digest: 'bg-port-accent/60',
  rollups: 'bg-port-success/60',
  recent_trajectory: 'bg-port-warning/60',
  tool_definitions: 'bg-port-error/60',
  output_reserve: 'bg-port-border',
  free: 'bg-port-bg',
};

const OCCUPANCY_LABEL = {
  provider_usage: 'Provider measured',
  provider_usage_plus_estimate: 'Provider measured + estimate',
  local_estimate: 'Estimated',
};
const WINDOW_LABEL = { pinned: 'Pinned window', advertised: 'Advertised window', fallback: 'Fallback window', unknown: 'Unknown window' };

const pct = (value) => (value == null ? '—' : `${value}%`);

export default function PersistentMindContextBreakdown({ breakdown }) {
  if (!breakdown) return null;
  const { categories = [], contextUsed, contextMax, contextPercent } = breakdown;
  const detailed = categories.filter((category) => category.detail?.length);
  return (
    <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-breakdown-heading">
      <h3 id="mind-breakdown-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text">
        <Gauge size={16} aria-hidden="true" /> Context window breakdown
      </h3>
      <p className="mt-1 text-xs text-port-text-muted">
        {formatCount(contextUsed)} of {contextMax == null ? 'an unknown number of' : formatCount(contextMax)} tokens
        {contextPercent == null ? '' : ` (${contextPercent}% including the output reserve)`} on the next wake.
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
        <span className="rounded border border-port-border px-2 py-0.5 text-port-text">{OCCUPANCY_LABEL[breakdown.occupancySource] || 'Estimated'}</span>
        <span className="rounded border border-port-border px-2 py-0.5 text-port-text">{WINDOW_LABEL[breakdown.windowSource] || WINDOW_LABEL.unknown}</span>
        {breakdown.promptCache && (
          <span className="rounded border border-port-border px-2 py-0.5 text-port-text">
            Cache read {formatCount(breakdown.promptCache.cacheReadTokens)} · write {formatCount(breakdown.promptCache.cacheWriteTokens)}
          </span>
        )}
      </div>
      {breakdown.pinDisagreesWithAdvertised && (
        <div className="mt-3">
          <Banner tone="info" title="Pinned window differs from the model's advertised window">
            numCtx pins {formatCount(breakdown.pinnedWindow)} tokens; the model advertises {formatCount(breakdown.advertisedWindow)}.
          </Banner>
        </div>
      )}
      {breakdown.highOccupancy && (
        <div className="mt-3">
          <Banner tone="warning" title="Context window nearly full">
            The next wake would use {pct(contextPercent)} of the window. Large tool schemas, rollups or protected memories are the usual cause.
          </Banner>
        </div>
      )}
      <div
        className="mt-3 flex h-3 w-full overflow-hidden rounded border border-port-border"
        role="img"
        aria-label={`Context occupancy: ${categories.filter((c) => c.id !== 'free').map((c) => `${c.label} ${c.tokens} tokens`).join(', ')}`}
      >
        {categories.filter((category) => category.tokens > 0).map((category) => (
          <div key={category.id} className={CATEGORY_STYLE[category.id] || 'bg-port-border'} style={{ width: `${Math.max(0.5, category.percent ?? 0)}%` }} title={`${category.label}: ${formatCount(category.tokens)} tokens`} />
        ))}
      </div>
      <ul className="mt-3 grid gap-1 text-xs sm:grid-cols-2" aria-label="Context categories">
        {categories.map((category) => (
          <li key={category.id} className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-port-text"><span className={`inline-block h-2 w-2 rounded-sm border border-port-border ${CATEGORY_STYLE[category.id] || 'bg-port-border'}`} aria-hidden="true" />{category.label}</span>
            <span className="font-mono text-port-text-muted">{formatCount(category.tokens)} · {pct(category.percent)}</span>
          </li>
        ))}
      </ul>
      {detailed.length > 0 && (
        <details className="mt-3 rounded border border-port-border p-3">
          <summary className="cursor-pointer text-xs font-semibold text-port-text">Per-family tool &amp; memory detail</summary>
          <table className="mt-2 w-full text-xs">
            <tbody>
              {detailed.flatMap((category) => category.detail.map((part) => (
                <tr key={`${category.id}:${part.id}`}>
                  <td className="py-0.5 text-port-text-muted">{category.label}</td>
                  <td className="py-0.5 text-port-text">{part.label}{part.tools != null ? ` (${part.tools} tools)` : ''}</td>
                  <td className="py-0.5 text-right font-mono text-port-text-muted">{formatCount(part.tokens)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
