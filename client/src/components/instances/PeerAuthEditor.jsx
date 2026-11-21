import { useState } from 'react';
import { Check, X, Lock } from 'lucide-react';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import { updatePeer } from '../../services/apiSystem.js';

export default function PeerAuthEditor({ peer, onRefresh }) {
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const hasAuth = !!peer.auth;

  const startEdit = () => {
    // Prefill the (non-secret) username; the password is never sent to the
    // browser (server redacts it to a hasPassword marker), so it must be
    // re-entered to save — saving replaces the whole credential server-side.
    setUsername(peer.auth?.username || '');
    setPassword('');
    setEditing(true);
  };

  const save = async () => {
    if (!password) return; // a password is required to store a credential
    setSaving(true);
    const result = await updatePeer(peer.id, { auth: { username: username.trim(), password } }).catch(() => null);
    setSaving(false);
    if (!result) return;
    onRefresh();
    setEditing(false);
    toast.success('Peer credential saved');
  };

  const clear = async () => {
    setSaving(true);
    const result = await updatePeer(peer.id, { auth: null }).catch(() => null);
    setSaving(false);
    if (!result) return;
    onRefresh();
    setEditing(false);
    toast.success('Peer credential cleared');
  };

  if (editing) {
    return (
      <div className="mt-1 flex items-center gap-1 flex-wrap">
        <input
          aria-label="Peer username"
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="user (optional)"
          autoComplete="off"
          className="bg-port-bg border border-port-border rounded px-2 py-0.5 text-xs text-white focus:outline-hidden focus:border-port-accent w-28"
        />
        <input
          aria-label="Peer password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
          placeholder={hasAuth ? 're-enter password to update' : 'password'}
          type="password"
          autoComplete="new-password"
          className="bg-port-bg border border-port-border rounded px-2 py-0.5 text-xs text-white focus:outline-hidden focus:border-port-accent flex-1 min-w-[120px]"
          autoFocus
        />
        <button onClick={save} disabled={saving || !password} aria-label="Save credentials" className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-success hover:text-port-success/80 disabled:opacity-50"><Check size={14} /></button>
        <button onClick={() => setEditing(false)} aria-label="Cancel" className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-white"><X size={14} /></button>
        {hasAuth && (
          <button onClick={clear} disabled={saving} className="text-[10px] text-gray-500 hover:text-port-error underline disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-2 pointer-coarse:inline-flex pointer-coarse:items-center">remove</button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
      {hasAuth ? (
        <Pill tone="success" size="xs" bordered={false} icon={Lock} title="Outbound requests to this peer send an HTTP Basic credential">
          credential set{peer.auth?.username ? ` · ${peer.auth.username}` : ''}
        </Pill>
      ) : peer.authRequired ? (
        <Pill tone="warning" size="xs" bordered={false} icon={Lock} title="Peer returned 401/403 — it's behind an auth proxy and needs a credential">
          auth required
        </Pill>
      ) : null}
      <button
        onClick={startEdit}
        className={`text-[10px] underline pointer-coarse:min-h-11 pointer-coarse:px-2 pointer-coarse:inline-flex pointer-coarse:items-center ${peer.authRequired && !hasAuth ? 'text-port-warning hover:text-port-warning/80' : 'text-gray-500 hover:text-white'}`}
        title="Set an HTTP Basic username/password for a peer behind an auth proxy"
      >
        {hasAuth ? 'edit credential' : 'set credential'}
      </button>
    </div>
  );
}
