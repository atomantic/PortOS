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
        <button type="button" onClick={save} disabled={saving || !password} aria-label="Save credentials" className="inline-flex items-center justify-center rounded border border-port-success/40 bg-port-bg/60 p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-success hover:bg-port-bg hover:border-port-success/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-port-accent disabled:opacity-50 transition-colors"><Check size={14} /></button>
        <button type="button" onClick={() => setEditing(false)} aria-label="Cancel" className="inline-flex items-center justify-center rounded border border-port-border bg-port-bg/60 p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-400 hover:text-white hover:bg-port-bg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-port-accent transition-colors"><X size={14} /></button>
        {hasAuth && (
          <button type="button" onClick={clear} disabled={saving} className="inline-flex items-center rounded border border-port-error/40 bg-port-bg/60 px-2 py-0.5 text-[11px] text-port-error hover:bg-port-error/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-port-accent disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-2 pointer-coarse:inline-flex pointer-coarse:items-center transition-colors">remove</button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
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
        type="button"
        onClick={startEdit}
        className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-port-accent pointer-coarse:min-h-11 pointer-coarse:px-2 pointer-coarse:inline-flex pointer-coarse:items-center transition-colors ${peer.authRequired && !hasAuth ? 'border-port-warning/50 bg-port-warning/10 text-port-warning hover:bg-port-warning/20' : 'border-port-border bg-port-bg/60 text-gray-300 hover:text-white hover:border-port-accent/50 hover:bg-port-bg'}`}
        title="Set an HTTP Basic username/password for a peer behind an auth proxy"
      >
        {hasAuth ? 'edit credential' : 'set credential'}
      </button>
    </div>
  );
}
