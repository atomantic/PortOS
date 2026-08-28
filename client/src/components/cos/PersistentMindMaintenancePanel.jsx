import { useId, useState } from 'react';
import { Brain, Database, Eraser, MessagesSquare, ShieldCheck } from 'lucide-react';
import * as api from '../../services/api';
import Banner from '../ui/Banner';

const CLEANUP_OPTIONS = [
  {
    scope: 'context',
    icon: Brain,
    label: 'Rebuild derived context',
    detail: 'Clears cached rollups and failure/backoff residue. Retained history is summarized again on a later wake.',
  },
  {
    scope: 'history',
    icon: MessagesSquare,
    label: 'Clear conversation history',
    detail: 'Permanently removes the retained trajectory and its rollups. Pending messages remain queued for the next start.',
  },
  {
    scope: 'memories',
    icon: Database,
    label: 'Archive curated memories',
    detail: 'Removes all Persistent Mind-owned active memories from future context without hard-deleting them from Brain.',
  },
];

export default function PersistentMindMaintenancePanel({
  selfCleanupEnabled = false,
  onOpenTools,
  onCleaned,
}) {
  const idPrefix = useId();
  const [selected, setSelected] = useState(() => new Set(['context']));
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const toggle = (scope, enabled) => {
    setSelected((current) => {
      const next = new Set(current);
      if (enabled) next.add(scope);
      else next.delete(scope);
      return next;
    });
    setResult(null);
  };

  const cleanup = async () => {
    if (pending || confirmation !== 'CLEAR' || selected.size === 0) return;
    setPending(true);
    setError(null);
    setResult(null);
    await api.cleanupPersistentMind({
      scopes: CLEANUP_OPTIONS.map(({ scope }) => scope).filter((scope) => selected.has(scope)),
      confirmation: 'CLEAR',
    }, { silent: true })
      .then(async (next) => {
        setResult(next);
        setConfirmation('');
        await onCleaned?.(next);
      })
      .catch((nextError) => setError(nextError?.message || 'Could not clean the persistent mind'))
      .finally(() => setPending(false));
  };

  return (
    <div className="space-y-4">
      <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-cleanup-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 id="mind-cleanup-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text">
              <Eraser size={17} aria-hidden="true" /> Clean mindspace
            </h3>
            <p className="mt-1 max-w-3xl text-xs text-port-text-muted">Choose exactly what has become stale. Cleanup stops the mind first to create a consistent boundary; its AI profile, operating prompt, tools, and queued messages are preserved.</p>
          </div>
          <span className="rounded-full border border-port-border px-2.5 py-1 text-xs text-port-text-muted">Machine-local only</span>
        </div>

        <fieldset className="mt-4 grid gap-3 lg:grid-cols-3">
          <legend className="sr-only">Mindspace cleanup scopes</legend>
          {CLEANUP_OPTIONS.map(({ scope, icon: Icon, label, detail }) => {
            const id = `${idPrefix}-${scope}`;
            return (
              <div key={scope} className={`rounded border p-3 transition-colors ${selected.has(scope) ? 'border-port-accent bg-port-accent/5' : 'border-port-border bg-port-bg/30'}`}>
                <span className="flex items-start gap-3">
                  <input id={id} type="checkbox" checked={selected.has(scope)} disabled={pending} onChange={(event) => toggle(scope, event.target.checked)} className="mt-1 h-4 w-4 accent-port-accent disabled:opacity-50" />
                  <span>
                    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm font-medium text-port-text"><Icon size={15} aria-hidden="true" /> {label}</label>
                    <span className="mt-1 block text-xs text-port-text-muted">{detail}</span>
                  </span>
                </span>
              </div>
            );
          })}
        </fieldset>

        <div className="mt-4 rounded border border-port-warning/40 bg-port-warning/10 p-3">
          <label htmlFor={`${idPrefix}-confirmation`} className="text-xs font-medium text-port-text">Type CLEAR to run the selected cleanup</label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input id={`${idPrefix}-confirmation`} value={confirmation} disabled={pending} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" className="min-w-0 flex-1 rounded border border-port-border bg-port-bg px-3 py-2 text-sm text-port-text disabled:opacity-50" />
            <button type="button" onClick={cleanup} disabled={pending || selected.size === 0 || confirmation !== 'CLEAR'} className="inline-flex min-h-10 items-center justify-center gap-2 rounded bg-port-warning px-4 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-50">
              <Eraser size={16} className={pending ? 'animate-pulse' : ''} aria-hidden="true" /> {pending ? 'Cleaning…' : 'Clean selected mindspace'}
            </button>
          </div>
        </div>
      </section>

      {error && (
        <Banner tone="error" title="Cleanup failed">
          {error}. Some cleanup steps may already have completed; reload to inspect the current state before retrying.
        </Banner>
      )}
      {result && (
        <Banner tone="success" title="Mindspace cleaned">
          Archived {result.memoriesArchived || 0} memories, cleared {result.historyEventsCleared || 0} history events and {result.rollupsCleared || 0} context rollups. Persistent Mind is stopped and ready for a deliberate fresh start.
        </Banner>
      )}

      <section className="rounded border border-port-border bg-port-card p-4" aria-labelledby="mind-self-cleanup-heading">
        <h3 id="mind-self-cleanup-heading" className="flex items-center gap-2 text-sm font-semibold text-port-text"><ShieldCheck size={16} aria-hidden="true" /> Self-maintenance authority</h3>
        <p className="mt-1 text-xs text-port-text-muted">
          {selfCleanupEnabled
            ? 'The mind may request the same bounded cleanup during a turn. History cleanup preserves that current turn so its final reply remains attributable.'
            : 'Self-cleanup is off by default. Grant it in Tools if the mind should be able to discard stale state on its own.'}
        </p>
        {!selfCleanupEnabled && onOpenTools && <button type="button" onClick={onOpenTools} className="mt-3 rounded border border-port-border px-3 py-1.5 text-xs font-medium text-port-accent hover:border-port-accent">Open Tools permissions</button>}
      </section>
    </div>
  );
}
