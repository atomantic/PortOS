import { useState, useMemo } from 'react';
import { Check, X, Wifi } from 'lucide-react';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import { updatePeer } from '../../services/apiSystem.js';

export default function PeerHostEditor({ peer, onRefresh, tailnetInfo }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  // Auto-detected DNS suggestion from the local tailscale status map:
  // match the peer by IP first (authoritative), fall back to composing
  // <hostname>.<tailnet-suffix> when the peer's hostname is a valid DNS label.
  const hostname = peer.lastHealth?.hostname;
  const suggestion = useMemo(() => {
    if (!tailnetInfo?.suffix) return null;
    const byIp = tailnetInfo.peers?.find(p => p.ips?.includes(peer.address));
    if (byIp?.dnsName) return byIp.dnsName;
    if (hostname && /^[a-z0-9][a-z0-9-]*$/i.test(hostname)) {
      return `${hostname}.${tailnetInfo.suffix}`.toLowerCase();
    }
    return null;
  }, [tailnetInfo, peer.address, hostname]);

  const startEdit = () => {
    setValue(peer.host || suggestion || '');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    const payload = { host: value.trim() === '' ? null : value.trim() };
    const result = await updatePeer(peer.id, payload).catch(() => null);
    setSaving(false);
    if (!result) return;
    onRefresh();
    setEditing(false);
    toast.success(payload.host ? `Host set to ${payload.host}` : 'Host cleared — reverting to IP');
  };

  const applySuggestion = () => setValue(suggestion);

  if (editing) {
    return (
      <div className="mt-1 flex items-center gap-1 flex-wrap">
        <input
          aria-label="Peer hostname"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
          placeholder="host.tailnet.ts.net (empty to clear)"
          className="bg-port-bg border border-port-border rounded px-2 py-0.5 text-xs text-white font-mono focus:outline-hidden focus:border-port-accent flex-1 min-w-[180px]"
          autoFocus
        />
        <button type="button" onClick={save} disabled={saving} aria-label="Save hostname" className="inline-flex items-center justify-center rounded border border-port-success/40 bg-port-bg/60 p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-success hover:bg-port-bg hover:border-port-success/70 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-port-accent disabled:opacity-50 transition-colors"><Check size={14} /></button>
        <button type="button" onClick={() => setEditing(false)} aria-label="Cancel" className="inline-flex items-center justify-center rounded border border-port-border bg-port-bg/60 p-1 pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-400 hover:text-white hover:bg-port-bg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-port-accent transition-colors"><X size={14} /></button>
        {suggestion && suggestion !== value && (
          <button
            type="button"
            onClick={applySuggestion}
            className="inline-flex items-center rounded border border-port-accent/40 bg-port-accent/10 px-2 py-0.5 text-[11px] text-port-accent hover:bg-port-accent/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-port-accent pointer-coarse:min-h-11 pointer-coarse:px-2 pointer-coarse:inline-flex pointer-coarse:items-center transition-colors"
            title={`Use detected DNS: ${suggestion}`}
          >
            use {suggestion}
          </button>
        )}
      </div>
    );
  }

  const clearHost = async () => {
    setSaving(true);
    const result = await updatePeer(peer.id, { host: null }).catch(() => null);
    setSaving(false);
    if (!result) return;
    onRefresh();
    toast.success('Reverted to IP — federation hop will use http://<ip>');
  };

  return (
    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
      {peer.host ? (
        <Pill tone="success" size="xs" bordered={false} mono icon={Wifi} title="Requests to this peer use https://<host>">
          https://{peer.host}
        </Pill>
      ) : (
        <Pill tone="bare" size="xs" bordered={false} mono className="text-gray-500 bg-port-bg" title="Requests use http://<ip> (no DNS set)">
          http only
        </Pill>
      )}
      <button
        type="button"
        onClick={startEdit}
        className="inline-flex items-center rounded border border-port-border bg-port-bg/60 px-2 py-0.5 text-[11px] text-gray-300 hover:text-white hover:border-port-accent/50 hover:bg-port-bg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-port-accent pointer-coarse:min-h-11 pointer-coarse:px-2 pointer-coarse:inline-flex pointer-coarse:items-center transition-colors"
        title={suggestion ? `Auto-detected: ${suggestion}` : 'Set a Tailscale DNS name for HTTPS'}
      >
        {peer.host ? 'edit' : (suggestion ? `use ${suggestion}` : 'set DNS')}
      </button>
      {peer.host && (
        <button
          type="button"
          onClick={clearHost}
          disabled={saving}
          className="inline-flex items-center rounded border border-port-border bg-port-bg/60 px-2 py-0.5 text-[11px] text-gray-400 hover:text-white hover:border-port-border hover:bg-port-bg focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-port-accent disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-2 pointer-coarse:inline-flex pointer-coarse:items-center transition-colors"
          title="Switch this hop back to http://<ip>"
        >
          use IP only
        </button>
      )}
    </div>
  );
}
