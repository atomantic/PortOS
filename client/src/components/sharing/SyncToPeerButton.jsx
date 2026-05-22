/**
 * SyncToPeerButton — dropdown of federated PortOS peers that toggles per-record
 * peer-sync subscriptions for universes + series.
 *
 * Sibling of `ShareToButton` (which targets cloud-synced share buckets); this
 * targets *other PortOS instances over Tailnet*. The contract is the same:
 *   - Filled CheckCircle when (recordKind, recordId) is subscribed to that peer.
 *   - Empty Circle otherwise.
 *   - Clicking checked → unsubscribe; clicking unchecked → subscribe (which
 *     triggers an initial push and then auto-pushes on every subsequent edit).
 *
 * Bidirectional sync: when this peer subscribes to a record on our end, the
 * receiver-side `applyIncomingPush` on the peer auto-creates a *reverse*
 * subscription (when their `directions` config allows it). The button doesn't
 * expose the reverse state — the user only manages the *outbound* direction
 * from this UI; the Instances page shows the bidirectional picture.
 *
 * Props:
 *   recordKind: 'universe' | 'series'
 *   recordId: string  (required — the record's id)
 *   label?: string
 *   compact?: boolean
 */

import { useEffect, useRef, useState } from 'react';
import { Cloud, Circle, CheckCircle2, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import {
  getInstances,
  listPeerSubscriptions,
  subscribeToPeer,
  unsubscribeFromPeer,
} from '../../services/api';

export default function SyncToPeerButton({
  recordKind,
  recordId,
  label = 'Sync',
  compact = false,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [peers, setPeers] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]); // [{id, peerId, ...}]
  const [loading, setLoading] = useState(false);
  const [busyPeerId, setBusyPeerId] = useState(null);
  const wrapperRef = useRef(null);

  const refresh = async () => {
    setLoading(true);
    const [instances, subs] = await Promise.all([
      getInstances({ silent: true }).catch(() => null),
      listPeerSubscriptions({ recordKind, recordId }, { silent: true })
        .then((r) => r?.subscriptions || [])
        .catch(() => []),
    ]);
    // Only show enabled, online-or-connectable peers — Tailnet peers that are
    // marked enabled but currently offline are still listed so the user can
    // create the subscription now and let the push pipeline retry on reconnect.
    const visiblePeers = (instances?.peers || []).filter((p) => p.enabled && p.instanceId);
    setPeers(visiblePeers);
    setSubscriptions(subs);
    setLoading(false);
  };

  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const subscriptionForPeer = (peerInstanceId) =>
    subscriptions.find((s) => s.peerId === peerInstanceId) || null;

  const handleToggle = async (peer) => {
    setBusyPeerId(peer.instanceId);
    const existing = subscriptionForPeer(peer.instanceId);
    if (existing) {
      const ok = await unsubscribeFromPeer(existing.id).catch((err) => {
        toast.error(err.message || `Unsync from ${peer.name} failed`);
        return null;
      });
      if (ok) {
        setSubscriptions((prev) => prev.filter((s) => s.id !== existing.id));
        toast.success(`Stopped syncing to ${peer.name}`);
      }
    } else {
      const result = await subscribeToPeer({
        peerId: peer.instanceId,
        recordKind,
        recordId,
      }).catch((err) => {
        toast.error(err.message || `Sync to ${peer.name} failed`);
        return null;
      });
      if (result?.subscription) {
        setSubscriptions((prev) => [...prev, result.subscription]);
        toast.success(`Syncing to ${peer.name} — edits will push automatically`);
      }
    }
    setBusyPeerId(null);
  };

  const nothingToSync = !recordId;

  return (
    <div ref={wrapperRef} className={`relative inline-block ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={nothingToSync}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border border-port-border hover:border-port-accent/40 text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${compact ? 'p-1.5' : ''}`}
        title={nothingToSync ? 'Nothing to sync' : 'Sync to a peer instance'}
      >
        <Cloud size={12} />
        {!compact && <span>{label}</span>}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 bg-port-card border border-port-border rounded-lg shadow-lg overflow-hidden">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-gray-500 border-b border-port-border">
            Subscribe to peer
          </div>
          {loading ? (
            <div className="px-3 py-3 text-xs text-gray-500 flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Loading peers…
            </div>
          ) : peers.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-500">
              No peers configured. <a href="/instances" className="text-port-accent hover:underline">Add one</a>.
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto">
              {peers.map((p) => {
                const subscribed = !!subscriptionForPeer(p.instanceId);
                const busy = busyPeerId === p.instanceId;
                return (
                  <li key={p.instanceId}>
                    <button
                      type="button"
                      onClick={() => handleToggle(p)}
                      disabled={busy}
                      className="w-full text-left px-3 py-2 hover:bg-port-bg disabled:opacity-50 flex items-start gap-2"
                    >
                      <span className="mt-0.5 shrink-0">
                        {busy
                          ? <Loader2 size={14} className="animate-spin text-port-accent" />
                          : subscribed
                            ? <CheckCircle2 size={14} className="text-port-success" />
                            : <Circle size={14} className="text-gray-600" />}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white truncate">{p.name}</div>
                        <div className="text-[10px] text-gray-500 truncate">
                          {p.status === 'online' ? 'online' : p.status || 'offline'}
                          {p.host ? ` · ${p.host}` : p.address ? ` · ${p.address}` : ''}
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {subscriptions.length > 0 && (
            <div className="px-3 py-2 text-[10px] text-gray-500 border-t border-port-border">
              Subscribed peers receive your edits automatically; their edits flow back if their config allows.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
