/**
 * Saved tailcat forwards.
 *
 * A tc address is a bearer capability the operator receives out of band, and it
 * only ever existed in the Add Peer field. When the forward failed to start,
 * that pasted value was gone — so recovering meant going back to the remote for
 * a fresh address before anyone could even retry. PortOS now saves the
 * capability (machine-local) the moment an add begins, and this panel is what
 * makes that recoverable: it names which forward is down, what tailcat actually
 * said, and offers Retry without the address ever coming back to the browser.
 *
 * Rows carry only the redacted address. Nothing here can reveal the capability.
 */

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import { getTailcatForwards, retryTailcatForward, forgetTailcatForward } from '../../services/api';
import { timeAgo } from '../../utils/formatters';

// Pill has no `error` tone; the red lastError line below carries the severity.
const STATUS_TONE = { active: 'success', pending: 'muted', failed: 'warning' };
const STATUS_ICON = { active: CheckCircle2, pending: Clock, failed: AlertCircle };

export default function TailcatForwardsPanel({ onChange }) {
  // `null` = not loaded yet, `[]` = loaded and genuinely empty. Distinct so a
  // pending fetch never renders as "no forwards".
  const [forwards, setForwards] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    // An install that has never added a tailcat peer is the common case — not
    // something to toast about on every Instances load.
    const data = await getTailcatForwards({ silent: true }).catch(() => null);
    setForwards(Array.isArray(data?.forwards) ? data.forwards : []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const retry = async (id) => {
    setBusyId(id);
    const peer = await retryTailcatForward(id).catch(() => null);
    setBusyId(null);
    // Refetch rather than guess: status, liveness and the failure text are all
    // derived server-side, and a local guess would misreport a failed retry.
    await load();
    if (!peer) return;
    onChange?.();
    toast.success(`Tailcat forward started on 127.0.0.1:${peer.port}`);
  };

  const forget = async (id) => {
    setBusyId(id);
    const removed = await forgetTailcatForward(id).catch(() => null);
    setBusyId(null);
    if (!removed) return load();
    // Drop the row locally — a removal has no server-derived state left to read.
    setForwards(prev => (prev || []).filter(f => f.id !== id));
    onChange?.();
    toast.success('Tailcat forward and its saved address removed');
  };

  if (!forwards || forwards.length === 0) return null;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-5">
      <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-1">
        Tailcat forwards ({forwards.length})
      </h2>
      <p className="text-[11px] text-gray-500 mb-3 leading-snug">
        Saved on this machine only, so a forward that fails to start can be retried
        without pasting its <span className="font-mono">tc…</span> address again.
      </p>
      <ul className="space-y-2">
        {forwards.map(forward => {
          const StatusIcon = STATUS_ICON[forward.status] || Clock;
          const busy = busyId === forward.id;
          return (
            <li key={forward.id} className="bg-port-bg border border-port-border rounded-lg p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={STATUS_TONE[forward.status] || 'bare'} size="xs" bordered={false} icon={StatusIcon}>
                  {forward.live ? 'running' : forward.status}
                </Pill>
                <span className="text-sm text-white truncate">
                  {forward.name || forward.tcAddress}
                </span>
                <span className="text-[11px] font-mono text-gray-500">
                  {forward.localPort ? `127.0.0.1:${forward.localPort}` : 'no port yet'}
                  {' → '}:{forward.remotePort}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => retry(forward.id)}
                    disabled={busy}
                    title="Restart this forward using the saved tc address"
                    className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-white disabled:opacity-50 border border-port-border rounded px-2 py-1 transition-colors"
                  >
                    <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
                    {busy ? 'Working...' : 'Retry'}
                  </button>
                  <button
                    type="button"
                    onClick={() => forget(forward.id)}
                    disabled={busy}
                    title="Stop the forward, delete its saved address, and remove its peer"
                    className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-port-error disabled:opacity-50 border border-port-border rounded px-2 py-1 transition-colors"
                  >
                    <Trash2 size={11} /> Forget
                  </button>
                </div>
              </div>
              {forward.status !== 'active' && forward.lastError && (
                <p className="text-[11px] text-port-error mt-2 leading-snug break-words">
                  {forward.lastError}
                  {forward.lastErrorAt && <span className="text-gray-500"> · {timeAgo(forward.lastErrorAt)}</span>}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
