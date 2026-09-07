/**
 * Machine-local Tailcat serve status — start/stop PortOS API :5555 over
 * tailcat, and Copy the tc… address for the other node to Dial-them.
 *
 * The full address is returned by the serve status API on purpose (our own
 * capability). Never log it; never put it on a peer record.
 */

import { useCallback, useEffect, useState } from 'react';
import { Copy, RefreshCw, Square, Play, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import { getTailcatServe, startTailcatServe, retryTailcatServe, stopTailcatServe } from '../../services/api';
import { PORTS } from '../../lib/ports';
import { timeAgo } from '../../utils/formatters';

const STATUS_TONE = { active: 'success', pending: 'muted', failed: 'warning', stopped: 'muted' };
const STATUS_ICON = { active: CheckCircle2, pending: Clock, failed: AlertCircle, stopped: Clock };

export default function TailcatServePanel({ onChange, compact = false }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const data = await getTailcatServe({ silent: true }).catch(() => null);
    setStatus(data && typeof data === 'object' ? data : null);
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (fn, successMsg) => {
    setBusy(true);
    const result = await fn().catch(() => null);
    setBusy(false);
    await load();
    if (!result) return;
    onChange?.();
    if (successMsg) toast.success(successMsg);
  };

  const copyAddress = async () => {
    const addr = status?.tcAddress;
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      toast.success('Tailcat address copied — paste it on the other PortOS as Dial them');
    } catch {
      toast.error('Could not copy to clipboard');
    }
  };

  const label = status?.live
    ? 'serving'
    : (status?.status || 'stopped');
  const tone = status?.live
    ? 'success'
    : (STATUS_TONE[status?.status] || 'muted');
  const StatusIcon = status?.live
    ? CheckCircle2
    : (STATUS_ICON[status?.status] || Clock);

  return (
    <div className={compact
      ? ''
      : 'bg-port-card border border-port-border rounded-xl p-5'}
    >
      {!compact && (
        <>
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-1">
            Tailcat serve (this node)
          </h2>
          <p className="text-[11px] text-gray-500 mb-3 leading-snug">
            Expose this PortOS API (<span className="font-mono">:{PORTS.API}</span>) over
            tailcat so a peer that is a better outbound initiator can Dial them
            toward us. No Tailscale account. Copy the address out of band only.
          </p>
        </>
      )}

      <div className="bg-port-bg border border-port-border rounded-lg p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={tone} size="xs" bordered={false} icon={StatusIcon}>
            {label}
          </Pill>
          <span className="text-[11px] font-mono text-gray-500">
            serve :{status?.localPort || PORTS.API}
            {status?.keyName ? ` · key=${status.keyName}` : ''}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {status?.hasAddress && status?.tcAddress && (
              <button
                type="button"
                onClick={copyAddress}
                disabled={busy}
                title="Copy full tc address for the other node"
                className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-white disabled:opacity-50 border border-port-border rounded px-2 py-1 transition-colors"
              >
                <Copy size={11} /> Copy address
              </button>
            )}
            {!status?.live && (
              <button
                type="button"
                onClick={() => run(
                  () => (status?.enabled || status?.status === 'failed'
                    ? retryTailcatServe()
                    : startTailcatServe({})),
                  'Tailcat serve started',
                )}
                disabled={busy}
                className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-white disabled:opacity-50 border border-port-border rounded px-2 py-1 transition-colors"
              >
                {status?.status === 'failed' || status?.enabled
                  ? <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
                  : <Play size={11} />}
                {busy ? 'Working...' : (status?.status === 'failed' || status?.enabled ? 'Retry' : 'Start serve')}
              </button>
            )}
            {status?.live && (
              <button
                type="button"
                onClick={() => run(() => stopTailcatServe(), 'Tailcat serve stopped')}
                disabled={busy}
                className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-port-error disabled:opacity-50 border border-port-border rounded px-2 py-1 transition-colors"
              >
                <Square size={11} /> Stop
              </button>
            )}
          </div>
        </div>

        {status?.hasAddress && (
          <p className="text-[11px] font-mono text-gray-400 mt-2 break-all select-all">
            {status.tcAddressRedacted || 'tc…'}
            <span className="text-gray-600"> (redacted preview — use Copy for the full address)</span>
          </p>
        )}

        {status?.lastError && status?.status !== 'active' && (
          <p className="text-[11px] text-port-error mt-2 leading-snug break-words">
            {status.lastError}
            {status.lastErrorAt && <span className="text-gray-500"> · {timeAgo(status.lastErrorAt)}</span>}
          </p>
        )}
      </div>
    </div>
  );
}
