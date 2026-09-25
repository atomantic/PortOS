import { useState } from 'react';
import { updatePeer } from '../../services/api';
import toast from '../ui/Toast';

// A stored peer password is normally that machine's instance password, which
// carries operator authority there. The pair secret replaces it with a
// peer-only credential (#8356); this hint walks the user through the switch.
function storedPasswordHint(peer) {
  if (!peer.auth?.hasPassword) return null;
  if (!peer.hasSyncSecret) {
    return 'The stored password grants operator access on that machine if it is its instance password. Set a sync secret on both machines to use a peer-only credential instead.';
  }
  if (peer.peerAuthAccepted) {
    return 'This peer accepts the pair credential. Remove the stored password — it is no longer needed.';
  }
  return 'Still signing in with the stored password. Update that machine and enter the same sync secret there; the password stops being sent once it accepts the pair credential.';
}

export default function PeerSyncSecretEditor({ peer, onRefresh }) {
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const passwordHint = storedPasswordHint(peer);
  const save = async (value) => {
    if (saving || (value !== null && (value.length < 32 || value.length > 256))) return;
    setSaving(true);
    const result = await updatePeer(peer.id, { syncSecret: value }).catch(() => null);
    setSaving(false);
    if (!result) return;
    setSecret('');
    setEditing(false);
    onRefresh();
    toast.success(value === null ? 'Peer sync secret removed' : 'Peer sync secret saved');
  };
  return (
    <div className="mt-2 text-xs space-y-2 min-w-0">
      <p className={peer.hasSyncSecret ? 'text-port-success' : 'text-port-warning'}>
        {peer.hasSyncSecret ? 'Record push authentication configured' : 'Record pushes paused until a sync secret is configured on both instances'}
      </p>
      {passwordHint && <p className="text-port-warning">{passwordHint}</p>}
      {editing ? (
        <div className="space-y-2">
          <label htmlFor={`peer-sync-secret-${peer.id}`} className="block">Shared sync secret</label>
          <input id={`peer-sync-secret-${peer.id}`} type="password" autoComplete="new-password"
            value={secret} onChange={event => setSecret(event.target.value)} maxLength={256}
            className="w-full max-w-md min-w-0 bg-port-bg border border-port-border rounded px-2 py-1"
            aria-describedby={`peer-sync-secret-help-${peer.id}`} />
          <p id={`peer-sync-secret-help-${peer.id}`} className="text-gray-400">
            Enter the same randomly generated secret (32–256 characters) in this peer’s settings on both machines.
            Use a different secret for each pair. Sync and category switches still control what is accepted.
            Sign in with an instance password to configure peer settings.
          </p>
          <div className="flex flex-wrap gap-3">
            <button disabled={saving || secret.length < 32} onClick={() => save(secret)} className="text-port-success disabled:opacity-50">Save secret</button>
            <button disabled={saving} onClick={() => { setSecret(''); setEditing(false); }} className="text-gray-400 disabled:opacity-50">Cancel</button>
            {peer.hasSyncSecret && <button disabled={saving} onClick={() => save(null)} className="text-port-error disabled:opacity-50">Remove secret</button>}
          </div>
        </div>
      ) : <button onClick={() => setEditing(true)} className="text-port-accent underline">{peer.hasSyncSecret ? 'Change sync secret' : 'Set sync secret'}</button>}
    </div>
  );
}
