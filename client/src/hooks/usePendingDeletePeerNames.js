import { useCallback, useEffect, useMemo, useState } from 'react';
import { getInstances } from '../services/api';

// Registry id -> display name for "Delete pending on <peer>". Reads the peer
// registry once when a row's `pendingDelete.peerId` names a peer not resolved
// yet; a failed read caches nothing so a later rows change retries it.
// `rememberPeerName` records a name a delete response already carried.
export default function usePendingDeletePeerNames(rows) {
  const [peerNames, setPeerNames] = useState({});
  const unresolvedPeerIds = useMemo(() => [...new Set((rows || []).map((row) => row?.pendingDelete?.peerId)
    .filter((id) => typeof id === 'string' && !(id in peerNames)))].join(','), [rows, peerNames]);
  useEffect(() => {
    if (!unresolvedPeerIds) return undefined;
    let active = true;
    const ids = unresolvedPeerIds.split(',');
    getInstances({ silent: true }).catch(() => null).then((data) => {
      if (!active || !data) return;
      const known = Object.fromEntries((data?.peers || []).map((p) => [p.id, p.name || p.id]));
      setPeerNames((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, known[id] ?? null])) }));
    });
    return () => { active = false; };
  }, [unresolvedPeerIds, rows]); // rows: a refresh retries a failed lookup
  const rememberPeerName = useCallback((peerId, name) => {
    if (peerId && name) setPeerNames((prev) => ({ ...prev, [peerId]: name }));
  }, []);
  return { peerNames, rememberPeerName };
}
