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

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  // The dropdown is portaled to <body> so it escapes each series/universe
  // card's stacking context (the cards have their own compositing layer, so an
  // in-card `absolute z-30` popover is painted UNDER the next card). Position
  // it `fixed`, anchored to the trigger button's viewport rect.
  const MENU_WIDTH = 288; // w-72
  const [coords, setCoords] = useState(null);
  const updateCoords = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Right-align the menu to the button, clamped to the viewport.
    const left = Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    setCoords({ top: r.bottom + 4, left });
  };

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

  // Per-record subscribability — mirrors server-side guards in peerSync.js
  // (peerAllowsOutbound + peerHasCategory). Without this triple gate the
  // UI would let the user subscribe to a peer that silently rejects every
  // push (with peer-disabled, peer-disallows-outbound, or
  // category-disabled), leaving the row checked but no records ever
  // landing. universe → 'universe' category, series → 'pipeline'.
  const requiredCategory = recordKind === 'universe' ? 'universe' : 'pipeline';
  const peerCanReceiveOutbound = (peer) => {
    if (!peer) return false;
    // Global sync flag off → server's pushRecordToPeer refuses.
    if (peer.syncEnabled === false) return false;
    // Inbound-only direction → outbound pushes silently dropped.
    if (Array.isArray(peer.directions) && peer.directions.length > 0
        && !peer.directions.includes('outbound')) return false;
    // A full-sync peer mirrors every category, so it can always receive.
    if (peer.fullSync === true) return true;
    const cats = peer.syncCategories;
    return !!cats && typeof cats === 'object' && cats[requiredCategory] === true;
  };

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  // Anchor the portaled menu to the trigger while open, and keep it pinned as
  // the page scrolls/resizes (capture-phase scroll catches inner scrollers too).
  useLayoutEffect(() => {
    if (!open) { setCoords(null); return; }
    updateCoords();
    const onMove = () => updateCoords();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      // The menu lives in a portal outside wrapperRef, so check both.
      const inTrigger = wrapperRef.current && wrapperRef.current.contains(e.target);
      const inMenu = menuRef.current && menuRef.current.contains(e.target);
      if (!inTrigger && !inMenu) setOpen(false);
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
      // silent:true — the catch below already owns the error toast, so the
      // apiCore helper must not fire its own (per CLAUDE.md "Custom catch ⇒
      // silent: true" rule). Otherwise the user sees two toasts on failure.
      const ok = await unsubscribeFromPeer(existing.id, { silent: true }).catch((err) => {
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
      }, { silent: true }).catch((err) => {
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
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={nothingToSync}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs border border-port-border hover:border-port-accent/40 text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${compact ? 'p-1.5' : ''}`}
        title={nothingToSync ? 'Nothing to sync' : 'Sync to a peer instance'}
      >
        <Cloud size={12} />
        {!compact && <span>{label}</span>}
      </button>

      {open && coords && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', top: coords.top, left: coords.left, width: MENU_WIDTH }}
          className="z-50 bg-port-card border border-port-border rounded-lg shadow-lg overflow-hidden"
        >
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
                // Disable when the peer can't actually receive outbound
                // pushes for this record kind — global sync off, inbound-
                // only directions, or the per-record category is off. UI
                // mirrors server-side guards in pushRecordToPeer.
                const canSync = peerCanReceiveOutbound(p);
                const categoryLabel = requiredCategory === 'universe' ? 'Universe' : 'Pipeline';
                // Compute the most-specific reason for the inline hint.
                const disabledReason = !canSync
                  ? (p.syncEnabled === false
                      ? 'Sync disabled for this peer'
                      : (Array.isArray(p.directions) && p.directions.length > 0
                          && !p.directions.includes('outbound')
                          ? 'Peer is inbound-only'
                          : `${categoryLabel} sync off`))
                  : null;
                // Allow UNSUBSCRIBE even when the peer can no longer receive
                // outbound pushes — the user may have a stranded subscription
                // from when sync was on, and disabling the row would leave
                // them unable to remove it. Subscribe-from-scratch still
                // requires canSync.
                const rowDisabled = busy || (!canSync && !subscribed);
                const titleHint = subscribed && !canSync
                  ? `Unsubscribe — pushes are currently blocked (${disabledReason || 'sync disabled'}), but you can still remove the subscription.`
                  : (disabledReason ? `${disabledReason}. Enable on the Instances page first.` : undefined);
                return (
                  <li key={p.instanceId}>
                    <button
                      type="button"
                      onClick={() => handleToggle(p)}
                      disabled={rowDisabled}
                      title={titleHint}
                      className="w-full text-left px-3 py-2 hover:bg-port-bg disabled:opacity-50 disabled:cursor-not-allowed flex items-start gap-2"
                    >
                      <span className="mt-0.5 shrink-0">
                        {busy
                          ? <Loader2 size={14} className="animate-spin text-port-accent" />
                          : subscribed
                            ? <CheckCircle2 size={14} className="text-port-success" />
                            : <Circle size={14} className="text-gray-600" />}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-white truncate">{p.name || p.host || p.address || 'Unnamed peer'}</div>
                        <div className="text-[10px] text-gray-500 truncate">
                          {p.status === 'online' ? 'online' : p.status || 'offline'}
                          {p.host ? ` · ${p.host}` : p.address ? ` · ${p.address}` : ''}
                          {disabledReason && ` · ${disabledReason}`}
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
        </div>,
        document.body,
      )}
    </div>
  );
}
