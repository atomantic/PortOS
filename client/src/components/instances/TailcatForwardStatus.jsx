/**
 * Shared Tailcat forward status row — used on the federated peer card (primary)
 * and on the orphan/pre-peer TailcatForwardsPanel (secondary).
 *
 * Distinguishes listener-bound ("running") from tunnel-broken ("no route").
 * Never receives a full tc… capability — only the redacted listing fields.
 */

import { RefreshCw, Trash2, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import { DEFAULT_TAILCAT_REMOTE_PORT } from '../../lib/ports';
import Pill from '../ui/Pill';
import { timeAgo } from '../../utils/formatters';

const STATUS_TONE = { active: 'success', pending: 'muted', failed: 'warning' };
const STATUS_ICON = { active: CheckCircle2, pending: Clock, failed: AlertCircle };

export function forwardDisplayState(forward) {
  if (!forward) return { label: 'no forward', tone: 'muted', broken: false };
  const broken = forward.live && !!forward.tunnelError;
  if (broken) return { label: 'no route', tone: 'warning', broken: true };
  if (forward.live) return { label: 'running', tone: STATUS_TONE[forward.status] || 'success', broken: false };
  return {
    label: forward.status || 'unknown',
    tone: STATUS_TONE[forward.status] || 'bare',
    broken: false,
  };
}

export function TailcatForwardStatus({
  forward,
  busy = false,
  onRetry,
  onForget,
  compact = false,
  showForget = true,
}) {
  if (!forward) {
    return (
      <div className="mt-2 text-[11px] text-gray-500 leading-snug">
        No saved Tailcat forward for this peer.
      </div>
    );
  }

  const { label, tone, broken } = forwardDisplayState(forward);
  const StatusIcon = broken ? AlertCircle : (STATUS_ICON[forward.status] || Clock);
  const failure = broken
    ? { message: forward.tunnelError, at: forward.tunnelErrorAt }
    : (forward.status !== 'active' && forward.lastError
      ? { message: forward.lastError, at: forward.lastErrorAt }
      : null);

  return (
    <div className={compact ? 'mt-2' : 'bg-port-bg border border-port-border rounded-lg p-3'}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={tone} size="xs" bordered={false} icon={StatusIcon}>
          {label}
        </Pill>
        <span className="text-[11px] font-mono text-gray-500">
          {forward.localPort ? `127.0.0.1:${forward.localPort}` : 'no port yet'}
          {' → '}:{forward.remotePort}
        </span>
        {(onRetry || onForget) && (
          <div className="ml-auto flex items-center gap-1">
            {onRetry && (
              <button
                type="button"
                onClick={() => onRetry()}
                disabled={busy}
                title="Restart this forward using the saved tc address"
                className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-white disabled:opacity-50 border border-port-border rounded px-2 py-1 transition-colors"
              >
                <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
                {busy ? 'Working...' : 'Retry'}
              </button>
            )}
            {onRetry && forward.remotePort !== DEFAULT_TAILCAT_REMOTE_PORT && (
              <button type="button" disabled={busy} onClick={() => onRetry(DEFAULT_TAILCAT_REMOTE_PORT)}
                className="text-[11px] border border-port-border rounded px-2 py-1 disabled:opacity-50"
                title="Use after the remote PortOS upgrades to the isolated Tailcat ingress">
                Retry on :{DEFAULT_TAILCAT_REMOTE_PORT}
              </button>
            )}
            {showForget && onForget && (
              <button
                type="button"
                onClick={onForget}
                disabled={busy}
                title="Stop the forward, delete its saved address, and remove its peer"
                className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-port-error disabled:opacity-50 border border-port-border rounded px-2 py-1 transition-colors"
              >
                <Trash2 size={11} /> Forget
              </button>
            )}
          </div>
        )}
      </div>
      {failure && (
        <p className="text-[11px] text-port-error mt-2 leading-snug break-words">
          {failure.message}
          {failure.at && <span className="text-gray-500"> · {timeAgo(failure.at)}</span>}
        </p>
      )}
    </div>
  );
}

export default TailcatForwardStatus;
