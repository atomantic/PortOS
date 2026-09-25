import { useState } from 'react';
import { pairPeerSyncSecret } from '../../services/api';
import toast from '../ui/Toast';

// A stored peer password is used once to provision the generated peer-only
// credential. Once the peer confirms it, the password can be removed.
function storedPasswordHint(peer) {
  if (!peer.auth?.hasPassword) return null;
  if (!peer.hasSyncSecret) {
    return 'The saved instance password lets PortOS pair this peer. After it confirms the generated credential, remove the password here.';
  }
  if (peer.peerAuthAccepted) {
    return 'This peer accepts the pair credential. Remove the stored password — it is no longer needed.';
  }
  return 'The instance password stays in use until this peer confirms the generated credential.';
}

export default function PeerSyncSecretEditor({ peer, onRefresh }) {
  const [pairing, setPairing] = useState(false);
  const passwordHint = storedPasswordHint(peer);
  const hasPassword = Boolean(peer.auth?.hasPassword);

  const pair = async () => {
    if (pairing || !hasPassword) return;
    setPairing(true);
    const result = await pairPeerSyncSecret(peer.id).catch(() => null);
    setPairing(false);
    if (!result) return;
    onRefresh();
    toast.success('Peer sync paired');
  };

  const status = !peer.hasSyncSecret
    ? 'Record pushes paused until this peer is paired'
    : peer.peerAuthAccepted
      ? 'Peer confirmed the matching sync credential'
      : 'Pair credential saved here; peer confirmation is still pending';

  return (
    <div className="mt-2 text-xs space-y-2 min-w-0">
      <p className={peer.hasSyncSecret && peer.peerAuthAccepted ? 'text-port-success' : 'text-port-warning'} role="status">
        {status}
      </p>
      {!hasPassword && !peer.peerAuthAccepted && (
        <p className="text-port-warning">
          Save this peer’s instance password here to pair automatically.
        </p>
      )}
      {passwordHint && <p className="text-port-warning">{passwordHint}</p>}
      {(!peer.peerAuthAccepted || hasPassword) && (
        <button
          type="button"
          onClick={pair}
          disabled={pairing || !hasPassword}
          className="text-port-accent underline disabled:opacity-50 disabled:cursor-not-allowed"
          title={!hasPassword ? 'Save this peer’s instance password first' : undefined}
        >
          {pairing
            ? 'Pairing…'
            : (!peer.hasSyncSecret ? 'Generate & pair' : (peer.peerAuthAccepted ? 'Rotate pair secret' : 'Retry pairing'))}
        </button>
      )}
    </div>
  );
}
