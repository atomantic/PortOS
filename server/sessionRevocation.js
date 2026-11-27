/** Revokes viewer tokens and hosted sessions when PortOS invalidates its sessions. */
export function registerSessionRevocation({ authEvents, io, remoteDesktopBroker, revokeAllHostedSessions }) {
  authEvents.on('sessions:revoked-all', () => remoteDesktopBroker.revokeAll('PortOS sessions revoked'));
  authEvents.on('sessions:revoked-all', () => {
    try {
      revokeAllHostedSessions({ io });
    } catch (err) {
      console.error(`❌ FableLoom hosted-session revocation failed: ${err.message}`);
    }
  });
}
