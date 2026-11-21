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
        <button onClick={save} disabled={saving} aria-label="Save hostname" className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-success hover:text-port-success/80 disabled:opacity-50"><Check size={14} /></button>
        <button onClick={() => setEditing(false)} aria-label="Cancel" className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-gray-500 hover:text-white"><X size={14} /></button>
        {suggestion && suggestion !== value && (
          <button
            onClick={applySuggestion}
            className="text-[10px] text-port-accent hover:text-port-accent/80 underline pointer-coarse:min-h-11 pointer-coarse:px-2 pointer-coarse:inline-flex pointer-coarse:items-center"
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
    <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
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
        onClick={startEdit}
        className="text-[10px] text-gray-500 hover:text-white underline pointer-coarse:min-h-11 pointer-coarse:px-2 pointer-coarse:inline-flex pointer-coarse:items-center"
        title={suggestion ? `Auto-detected: ${suggestion}` : 'Set a Tailscale DNS name for HTTPS'}
      >
        {peer.host ? 'edit' : (suggestion ? `use ${suggestion}` : 'set DNS')}
      </button>
      {peer.host && (
        <button
          onClick={clearHost}
          disabled={saving}
          className="text-[10px] text-gray-500 hover:text-white underline disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:px-2 pointer-coarse:inline-flex pointer-coarse:items-center"
          title="Switch this hop back to http://<ip>"
        >
          use IP only
        </button>
      )}
    </div>
  );
}
