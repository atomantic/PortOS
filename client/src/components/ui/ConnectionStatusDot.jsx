/**
 * Live-connection status dot — a coloured dot, a caption, and the status word.
 *
 * Generalised from the Moltworld WebSocket banner (`agents/tabs/WorldTab.jsx`),
 * which is where this shape was settled and which now renders through it. It is
 * the ONE liveness surface for a long-lived transport (fork issue #33 decision 4
 * picked it for Beeper too) — actionable faults belong in the feature's own
 * settings card, and PortOS has no global socket-degradation banner by design.
 *
 * `status` is free-form so each transport can name its own states; anything
 * unrecognised renders grey rather than blank, so a new state added on the
 * server can never leave a dot with no colour.
 */

const STATUS_TONE = {
  connected: 'bg-port-success',
  connecting: 'bg-port-warning animate-pulse',
  reconnecting: 'bg-port-warning animate-pulse',
  disconnected: 'bg-gray-600',
  down: 'bg-gray-600',
  error: 'bg-port-error',
};

export default function ConnectionStatusDot({ status, label, className = '' }) {
  const tone = STATUS_TONE[status] || 'bg-gray-600';
  return (
    <span className={`flex items-center gap-2 ${className}`}>
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${tone}`} data-testid="connection-status-dot" data-status={status || 'unknown'} />
      {label && <span className="text-sm text-gray-400">{label}</span>}
      <span className="text-sm text-white font-medium">{status || 'unknown'}</span>
    </span>
  );
}
