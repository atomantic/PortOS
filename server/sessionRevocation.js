/** Revokes viewer tokens, hosted sessions, and proxied WebSockets on full or targeted PortOS session invalidation. */
export function registerSessionRevocation({
  authEvents,
  io,
  remoteDesktopBroker,
  revokeAllHostedSessions,
  revokeHostedSessionsByOwner,
  closeEidoverseProxySockets,
  closeEidoverseProxySocketsForSessions,
}) {
  const run = (label, fn) => {
    try {
      fn();
    } catch (err) {
      console.error(`❌ ${label} revocation failed: ${err?.message ?? err}`);
    }
  };

  authEvents.on('sessions:revoked-all', () => {
    run('Remote desktop', () => remoteDesktopBroker?.revokeAll?.('PortOS sessions revoked'));
    run('FableLoom hosted-session', () => revokeAllHostedSessions?.({ io }));
    run('Eidoverse proxy', () => closeEidoverseProxySockets?.());
  });

  authEvents.on('sessions:revoked', (sessionIds) => {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return;
    run('Remote desktop', () => remoteDesktopBroker?.revokeByOwnerSessions?.(sessionIds, 'PortOS session revoked'));
    run('FableLoom hosted-session', () => revokeHostedSessionsByOwner?.(sessionIds, { io }));
    run('Eidoverse proxy', () => closeEidoverseProxySocketsForSessions?.(sessionIds));
  });
}
