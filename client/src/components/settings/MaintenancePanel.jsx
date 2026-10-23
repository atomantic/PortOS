import { useState } from 'react';
import { formatDateTime, formatTimeOfDay } from '../../utils/formatters.js';
import { useMaintenance } from '../../hooks/useMaintenance.js';
import useMounted from '../../hooks/useMounted.js';
import { beginMaintenance, resumeMaintenance } from '../../services/apiSystem.js';
import { copyToClipboard } from '../../lib/clipboard.js';

const recoveryCommands = [
  'pm2 stop portos-server portos-cos',
  'node scripts/recover-maintenance-transaction.mjs --confirm "Reviewed interrupted maintenance transaction"',
  'pm2 start portos-server portos-cos',
].join('\n');
const recoveryCauses = {
  'interrupted-transaction': 'An interrupted journal transaction is holding new work.',
  'unreadable-journal': 'The maintenance journal is unreadable or incompatible. Restore compatible code or repair the journal before recovery; the command refuses invalid state.',
  'process-uncertain': 'This process could not confirm a journal write. Both PortOS processes must restart after recovery.',
};

export default function MaintenancePanel() {
  const { status, refresh } = useMaintenance();
  const mounted = useMounted();
  const [reason, setReason] = useState('Maintenance');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async () => {
    setBusy(true); setError('');
    try {
      if (status.hold) await resumeMaintenance(status.hold, { silent: true });
      else await beginMaintenance(reason.trim(), { silent: true });
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { await refresh(); if (mounted.current) setBusy(false); }
  };
  const unknown = !status || ['unknown', 'unavailable'].includes(status.state);
  return <section className="bg-port-card border border-port-border rounded-xl p-5 space-y-3" aria-labelledby="maintenance-heading">
    <h3 id="maintenance-heading" className="font-semibold text-port-text">Graceful maintenance</h3>
    <p role="status" className="text-sm">{status ? ({ normal: 'Normal — new work can start', draining: 'Draining — letting active work finish', ready: 'Ready — maintenance hold is active', unavailable: 'Recovery needed — new work is held', unknown: 'Readiness unknown' }[status.state]) : 'Loading maintenance status…'}</p>
    <p className="text-sm text-port-text-muted">New agents, mind turns and renders wait. Active work finishes, including saving and cleanup. Queues and existing scheduling policies are preserved.</p>
    {status?.cause && <div className="rounded border border-port-border p-3 space-y-2 text-sm">
      <p>{recoveryCauses[status.cause] || 'The maintenance journal needs recovery.'}</p>
      {status.since && <p>Held since {formatDateTime(status.since)}</p>}
      <p>Inspect the server logs for the original error and resolve disk space or I/O problems first. From the PortOS install directory, stop both PM2 apps and any standalone journal writers, run this command with your recovery reason, then start both apps:</p>
      <pre className="whitespace-pre-wrap break-words rounded bg-port-bg p-3">{recoveryCommands}</pre>
      <button className="underline" onClick={() => copyToClipboard(recoveryCommands, 'Recovery steps copied')}>Copy recovery steps</button>
      <p>The command preserves transaction evidence and keeps a maintenance hold. Inspect any remaining blockers after restarting, then use Resume previous policies when ready. Never delete the journal or lock by hand.</p>
    </div>}
    {status?.hold ? <p className="text-sm">{status.hold.reason} · {status.hold.owner} · {formatDateTime(status.hold.requestedAt)}</p> : !status?.cause && <label htmlFor="maintenance-reason" className="block text-sm">Reason<input id="maintenance-reason" className="block w-full mt-1 p-2 rounded bg-port-bg border border-port-border" value={reason} maxLength={500} onChange={e => setReason(e.target.value)} disabled={busy || unknown} /></label>}
    {status?.blockers?.length > 0 && <ul className="text-sm space-y-1 max-h-56 overflow-auto" aria-label="Maintenance blockers">{status.blockers.map((b, i) => <li key={`${b.kind}:${b.resource}:${i}`}>{b.kind}: {b.resource || 'Preparing'}{b.unsettled ? ' — saving or cleanup needs recovery' : ''} · since {formatTimeOfDay(b.startedAt)}</li>)}</ul>}
    <p className="text-xs text-port-text-muted">{status?.scope || 'Readiness covers admitted PortOS automation and media work. Unrelated applications on this computer are outside this scope.'} A restart never clears a hold or unresolved work. Resuming cancels this hold; it does not certify readiness.</p>
    {(error || status?.error) && <p role="alert" className="text-sm text-port-error">{error || status.error}</p>}
    {!status?.cause && <button className="px-4 py-2 rounded bg-port-accent text-white disabled:opacity-50" disabled={busy || unknown || (!status?.hold && !reason.trim())} onClick={act}>{busy ? 'Saving…' : status?.hold ? 'Resume previous policies' : 'Enter maintenance'}</button>}
    {unknown && <button className="ml-3 text-sm underline" onClick={refresh}>Refresh status</button>}
  </section>;
}
