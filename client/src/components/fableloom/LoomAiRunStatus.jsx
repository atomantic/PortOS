import { CheckCircle2, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { Link } from 'react-router';

const TERMINAL_PHASES = new Set(['complete', 'error']);

const phaseLabel = (run) => {
  if (run.phase === 'start') return 'Starting AI…';
  if (run.phase === 'running') return run.message || 'AI is working…';
  if (run.phase === 'ready') return run.message || 'TUI run is ready';
  if (run.phase === 'applying') return run.message || 'Applying AI changes…';
  if (run.phase === 'complete') return run.message || 'AI update complete';
  if (run.phase === 'error') return run.message || 'AI update failed';
  return run.message || 'AI operation in progress…';
};

export default function LoomAiRunStatus({ run }) {
  if (!run) return null;
  const terminal = TERMINAL_PHASES.has(run.phase);
  const failed = run.phase === 'error';
  const canOpenShell = run.shellReady && run.runId && !terminal;
  const Icon = failed ? XCircle : terminal ? CheckCircle2 : Loader2;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded border px-3 py-2 text-xs flex flex-wrap items-center gap-x-2 gap-y-1 ${
        failed
          ? 'border-port-error/40 text-port-error'
          : terminal
            ? 'border-port-success/40 text-port-success'
            : 'border-port-accent/30 text-port-text-muted'
      }`}
    >
      <Icon size={14} className={!terminal ? 'animate-spin' : ''} />
      <span className="min-w-0 flex-1">{phaseLabel(run)}</span>
      {run.providerName ? <span className="text-port-text-muted">{run.providerName}{run.model ? ` · ${run.model}` : ''}</span> : null}
      {canOpenShell ? (
        <Link
          to={`/shell/${encodeURIComponent(run.runId)}`}
          className="inline-flex items-center gap-1 text-port-accent hover:underline font-medium"
        >
          <ExternalLink size={12} /> Open shell
        </Link>
      ) : null}
    </div>
  );
}
