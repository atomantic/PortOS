import { Brain, Cpu, Gauge } from 'lucide-react';
import { formatBytes } from '../../utils/formatters.js';

const number = (value) => Number.isFinite(value) ? value.toLocaleString() : '—';

const residencyLabel = (runtime) => {
  if (runtime?.inference?.active) return 'Running now';
  const status = runtime?.inference?.residency?.status;
  if (status === 'loaded') return 'Loaded in memory';
  if (status === 'not-loaded') return 'Not loaded';
  if (status === 'provider-managed') return 'Provider-managed';
  if (status === 'unconfigured') return 'Not configured';
  return 'Status unknown';
};

export function PersistentMindThoughtStatus({ state, model }) {
  const thinking = state?.status === 'thinking' && Boolean(state.activeTurnId);
  const label = thinking
    ? `Thinking${model ? ` with ${model}` : ''}`
    : state?.status === 'waiting' ? 'Waiting for the next wake'
      : state?.status === 'paused' ? 'Mind paused'
        : state?.status === 'idle' ? 'Mind idle'
          : state?.status === 'disabled' ? 'Mind disabled'
            : 'Mind status unknown';

  return (
    <span
      role="status"
      aria-busy={thinking}
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ${thinking ? 'border-port-accent/60 bg-port-accent/10 text-port-accent' : 'border-port-border text-port-text-muted'}`}
    >
      <Brain size={14} className={thinking ? 'animate-pulse motion-reduce:animate-none' : ''} aria-hidden="true" />
      <span>{label}</span>
      {thinking && (
        <span className="inline-flex gap-0.5" aria-hidden="true">
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

  return (
    <section aria-label="Persistent mind runtime" className="grid gap-3 md:grid-cols-3">
      <button type="button" onClick={onOpenContext} className="rounded border border-port-border bg-port-card p-3 text-left hover:bg-port-border/20">
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-port-accent"><Brain size={15} aria-hidden="true" /> Effective context</span>
        <span className="mt-2 block text-lg font-semibold text-port-text">~{number(context?.approximateTokens)} tokens</span>
        <span className="mt-1 block text-xs text-port-text-muted">
          {number(context?.chars)} / {number(context?.maxChars)} characters · {number(context?.memoryCount)} curated memories · summary {context?.summaryState || 'unknown'}
        </span>
      </button>

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
        <p className={`md:col-span-3 text-xs ${error ? 'text-port-warning' : 'text-port-text-muted'}`}>
          {error ? `Live telemetry delayed: ${error}. Showing the last successful snapshot when available.` : 'Refreshing live telemetry…'}
        </p>
      )}
    </section>
  );
}
