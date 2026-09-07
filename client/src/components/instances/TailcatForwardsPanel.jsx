/**
 * Orphan / pre-peer Tailcat forwards only.
 *
 * When a forward is linked to a federated peer (`peerId`), its status lives on
 * that peer card — the primary source of truth. This panel keeps the salvage
 * surface for a forward that failed before peer registration (or whose peer
 * was removed), so a saved tc… capability can still be retried without pasting
 * the address again.
 *
 * Rows carry only the redacted address. Nothing here can reveal the capability.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from '../ui/Toast';
import { getTailcatForwards, retryTailcatForward, forgetTailcatForward } from '../../services/api';
import TailcatForwardStatus from './TailcatForwardStatus';

export default function TailcatForwardsPanel({ onChange, peerIds }) {
  // `null` = not loaded yet, `[]` = loaded and genuinely empty. Distinct so a
  // pending fetch never renders as "no forwards".
  const [forwards, setForwards] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const peerIdSet = useMemo(() => {
    if (!peerIds) return null;
    return peerIds instanceof Set ? peerIds : new Set(peerIds);
  }, [peerIds]);

  const load = useCallback(async () => {
    // An install that has never added a tailcat peer is the common case — not
    // something to toast about on every Instances load.
    const data = await getTailcatForwards({ silent: true }).catch(() => null);
    setForwards(Array.isArray(data?.forwards) ? data.forwards : []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const orphans = useMemo(() => {
    if (!forwards) return null;
    return forwards.filter((f) => {
      if (!f.peerId) return true;
      if (!peerIdSet) return false; // linked forward; peer card owns it
      return !peerIdSet.has(f.peerId);
    });
  }, [forwards, peerIdSet]);

  const retry = async (id) => {
    setBusyId(id);
    const peer = await retryTailcatForward(id).catch(() => null);
    setBusyId(null);
    // Refetch rather than guess: status, liveness and the failure text are all
    // derived server-side, and a local guess would misreport a failed retry.
    await load();
    if (!peer) return;
    onChange?.();
    toast.success(`Tailcat forward started on 127.0.0.1:${peer.port}`);
  };

  const forget = async (id) => {
    setBusyId(id);
    const removed = await forgetTailcatForward(id).catch(() => null);
    setBusyId(null);
    if (!removed) return load();
    // Drop the row locally — a removal has no server-derived state left to read.
    setForwards(prev => (prev || []).filter(f => f.id !== id));
    onChange?.();
    toast.success('Tailcat forward and its saved address removed');
  };

  if (!orphans || orphans.length === 0) return null;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-5">
      <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-1">
        Tailcat forwards — needs attention ({orphans.length})
      </h2>
      <p className="text-[11px] text-gray-500 mb-3 leading-snug">
        Orphaned or pre-peer forwards only. Linked Tailcat peers show forward
        status on their card. Saved on this machine so a failed start can be
        retried without pasting its <span className="font-mono">tc…</span> address again.
      </p>
      <ul className="space-y-2">
        {orphans.map(forward => (
          <li key={forward.id}>
            <div className="mb-1 text-sm text-white truncate">
              {forward.name || forward.tcAddress}
            </div>
            <TailcatForwardStatus
              forward={forward}
              busy={busyId === forward.id}
              onRetry={() => retry(forward.id)}
              onForget={() => forget(forward.id)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
