import { AlertTriangle, Brain, Cpu, Gauge } from 'lucide-react';
import { describeMindTurnProgress } from '../../lib/mindTurnProgress.js';
import { formatBytes, timeUntil } from '../../utils/formatters.js';

const number = (value) => Number.isFinite(value) ? value.toLocaleString() : '—';

const RESIDENCY_STATES = {
  loaded: 'Loaded in memory',
  'not-loaded': 'Not loaded',
  'provider-managed': 'Provider-managed',
  unconfigured: 'Not configured',
};

// "Running now" alone answered the wrong question during a turn: a cold local
// model that has not finished loading looks exactly like one mid-inference, and
// that ambiguity is what made a slow start indistinguishable from a hang.
const residencyLabel = (runtime) => {
  const status = runtime?.inference?.residency?.status;
  const state = RESIDENCY_STATES[status] || 'Status unknown';
  if (!runtime?.inference?.active) return state;
  return status === 'provider-managed' || status === 'unconfigured'
    ? 'Running now'
    : `Running now · ${state.toLowerCase()}`;
};

export function PersistentMindThoughtStatus({ state, model, progress }) {
  // A caller with no /mind/runtime snapshot (the CoS Config tab) still gets the
  // state-only reading: the quota/retry phase resolves from the public state
  // alone, while elapsed and heartbeat freshness stay absent rather than guessed.
  const turn = progress || describeMindTurnProgress({ state });
  const scheduled = state?.started && state?.nextWakeAt && ['idle', 'waiting'].includes(state.status);
  const headline = turn.phase === 'blocked'
    ? `${turn.reason || 'Blocked'}${turn.retryAt ? ` · retry ${timeUntil(turn.retryAt)}` : ''}`
    : turn.phase === 'stalled' ? 'Stalled, checking…'
      : turn.phase === 'thinking' ? `Thinking${model ? ` with ${model}` : ''}`
        : scheduled ? `Waiting · next wake ${timeUntil(state.nextWakeAt)}`
          : state?.status === 'waiting' ? 'Waiting for the next wake'
            : state?.status === 'paused' ? 'Mind paused'
              : state?.status === 'idle' ? 'Mind idle'
                : state?.status === 'disabled' ? 'Mind disabled'
                  : 'Mind status unknown';
  // The stage answers "is it actually processing?", the durations answer "for
  // how long?" — a bare headline could not distinguish either from a hang.
  const label = [headline, turn.stage, turn.detail].filter(Boolean).join(' · ');
  const attention = turn.phase === 'stalled' || turn.phase === 'blocked';

  return (
    <span
      data-testid="mind-thought-status"
      data-phase={turn.phase}
      role="status"
      aria-busy={turn.busy}
      className={`inline-flex min-w-0 max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${attention ? 'border-port-warning/60 bg-port-warning/10 text-port-warning' : turn.busy ? 'border-port-accent/60 bg-port-accent/10 text-port-accent' : 'border-port-border text-port-text-muted'}`}
    >
      {attention
        ? <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
        : <Brain size={14} className={turn.busy ? 'shrink-0 animate-pulse motion-reduce:animate-none' : 'shrink-0'} aria-hidden="true" />}
      <span className="truncate" title={label}>{label}</span>
      {turn.phase === 'thinking' && (
        <span className="inline-flex shrink-0 gap-0.5" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="h-1 w-1 animate-bounce rounded-full bg-current motion-reduce:animate-none"
              style={{ animationDelay: `${index * 120}ms` }}
            />
          ))}
        </span>
      )}
    </span>
  );
}

export default function PersistentMindRuntimePanel({ runtime, error, loading, onOpenContext }) {
  const context = runtime?.context;
  const memory = runtime?.system?.memory;
  const processMemory = runtime?.system?.process;
  const residency = runtime?.inference?.residency;
  const usagePercent = Number.isFinite(memory?.usagePercent) ? memory.usagePercent : null;
  const ContextSurface = onOpenContext ? 'button' : 'div';

  return (
    <section aria-label="Persistent mind runtime" className="grid gap-3 md:grid-cols-3">
      <ContextSurface {...(onOpenContext ? { type: 'button', onClick: onOpenContext } : {})} className={`rounded border border-port-border bg-port-card p-3 text-left ${onOpenContext ? 'hover:bg-port-border/20' : ''}`}>
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-port-accent"><Brain size={15} aria-hidden="true" /> Effective context</span>
        <span className="mt-2 block text-lg font-semibold text-port-text">~{number(context?.approximateTokens)} tokens</span>
        <span className="mt-1 block text-xs text-port-text-muted">
          {number(context?.chars)} / {number(context?.maxChars)} characters · {number(context?.memoryCount)} curated memories · summary {context?.summaryState || 'unknown'}
        </span>
      </ContextSurface>

      <div className="rounded border border-port-border bg-port-card p-3">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-port-accent"><Gauge size={15} aria-hidden="true" /> System memory</span>
        <span className="mt-2 block text-lg font-semibold text-port-text">{memory ? `${formatBytes(memory.used)} / ${formatBytes(memory.total)}` : '—'}</span>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-port-border" role="progressbar" aria-label="System memory used" aria-valuemin="0" aria-valuemax="100" aria-valuenow={usagePercent ?? undefined}>
          <div className="h-full rounded-full bg-port-accent transition-[width]" style={{ width: `${usagePercent ?? 0}%` }} />
        </div>
        <span className="mt-1 block text-xs text-port-text-muted">{usagePercent === null ? 'Usage unavailable' : `${usagePercent}% used`} · PortOS RSS {processMemory ? formatBytes(processMemory.rss) : '—'} · heap {processMemory ? formatBytes(processMemory.heapUsed) : '—'}</span>
      </div>

      <div className="rounded border border-port-border bg-port-card p-3">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-port-accent"><Cpu size={15} aria-hidden="true" /> Model activity</span>
        <span className="mt-2 block text-lg font-semibold text-port-text">{residencyLabel(runtime)}</span>
        <span className="mt-1 block break-words text-xs text-port-text-muted">
          {runtime?.inference?.providerId || 'No provider'} · {runtime?.inference?.model || 'No model'}
          {residency?.backend ? ` · ${residency.backend}` : ''}
          {residency?.memoryBytes ? ` · ${formatBytes(residency.memoryBytes)}` : ''}
        </span>
        {runtime?.system?.cpu && <span className="mt-1 block text-xs text-port-text-muted">Host load {runtime.system.cpu.loadAvg1m.toFixed(2)} across {runtime.system.cpu.cores} cores</span>}
      </div>

      {(loading || error) && (
        <p role="status" className={`md:col-span-3 text-xs ${error ? 'text-port-warning' : 'text-port-text-muted'}`}>
          {error ? `Live telemetry delayed: ${error}. Showing the last successful snapshot when available.` : 'Refreshing live telemetry…'}
        </p>
      )}
    </section>
  );
}
