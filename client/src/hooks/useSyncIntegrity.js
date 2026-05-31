import { useState, useEffect, useCallback, useRef } from 'react';
import { getInstances } from '../services/apiSystem.js';
import { fetchSyncIntegrity } from '../services/apiPeerSync.js';

/**
 * Maps a record kind to the `syncCategories` key that gates whether a peer
 * participates in syncing that kind. Mirrors `KIND_TO_CATEGORY` in
 * `server/services/sharing/peerSync.js`.
 */
const KIND_TO_CATEGORY = Object.freeze({
  universe: 'universe',
  series: 'pipeline',
  mediaCollection: 'mediaCollections',
});

/**
 * Worst-case status ranking — lower index = worse / more actionable.
 * `assets-missing` is ranked worst because the record metadata is present
 * but the associated files are absent, which is the most disruptive to users.
 * `diverged` means content differs (could overwrite in either direction).
 * `local-only` / `peer-only` mean one side is missing the record entirely.
 * `in-parity` is the healthy terminal state.
 */
const STATUS_RANK = [
  'assets-missing',
  'diverged',
  'peer-only',
  'local-only',
  'metadata-missing',
  'in-parity',
];

function worstStatus(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ra = STATUS_RANK.indexOf(a);
  const rb = STATUS_RANK.indexOf(b);
  // Unknown statuses (indexOf → -1) are treated as maximally bad.
  const ea = ra === -1 ? -1 : ra;
  const eb = rb === -1 ? -1 : rb;
  return ea <= eb ? a : b;
}

/**
 * Fetch integrity data for every online, sync-enabled peer that covers the
 * given record `kind`, then reduce to per-record worst-case status maps.
 *
 * @param {string} kind - 'universe' | 'series' | 'mediaCollection'
 * @param {Object} [opts]
 * @param {Array}  [opts.peers] - pre-fetched peer list (avoids a duplicate
 *   fetch when the calling page already has it). When omitted the hook fetches
 *   the instance list itself.
 *
 * @returns {{
 *   loading: boolean,
 *   error: Error|null,
 *   noSyncingPeers: boolean,
 *   integrityUnavailable: boolean,
 *   statusById: Map<string, string>,
 *   byPeer: Map<string, Array<{peerId:string, peerName:string, status:string}>>,
 *   unavailablePeers: Array<{peerId:string, peerName:string, reason:string}>,
 *   refresh: () => void,
 * }}
 *
 * `statusById`  — Map<recordId, worst status across all queried peers>
 * `byPeer`      — Map<recordId, [{peerId, peerName, status}, …]> for drawer breakdowns
 * `noSyncingPeers` — true when no online peer has the matching category enabled
 * `unavailablePeers` — per-peer reasons for peers that could not report
 *   integrity, e.g. peer-unreachable vs peer-too-old.
 * `integrityUnavailable` — true when eligible peers DO exist but none returned
 *   usable integrity data (all too-old / unreachable / fetch-failed). Distinct
 *   from `noSyncingPeers`; lets callers render a neutral "unknown" badge instead
 *   of silently rendering nothing.
 *
 * Status precedence (worst → best): assets-missing, diverged, peer-only,
 * local-only, in-parity. A record absent from every peer response is not
 * included in `statusById` — callers may treat absence as "unknown / no peers".
 */
/**
 * Map a useSyncIntegrity result + a record id to the SyncBadge `status` prop,
 * applying the single source of precedence so the 4 badge call sites can't
 * drift: no syncing peers → 'not-syncing'; a known per-record status wins;
 * otherwise 'unknown' when integrity was unavailable, else undefined (badge
 * renders nothing — record not seen by any peer).
 *
 * @param {{noSyncingPeers:boolean, integrityUnavailable:boolean, statusById:Map}} sync
 * @param {string} recordId
 * @returns {string|undefined}
 */
function unavailableBadgeStatus(unavailablePeers = []) {
  const reasons = new Set(unavailablePeers.map((p) => p.reason).filter(Boolean));
  if (reasons.size === 1 && reasons.has('peer-unreachable')) return 'peer-unreachable';
  if (reasons.size === 1 && reasons.has('peer-too-old')) return 'peer-too-old';
  if (reasons.size === 1 && reasons.has('fetch-failed')) return 'fetch-failed';
  return 'unknown';
}

export function syncBadgeStatus(sync, recordId) {
  if (sync.noSyncingPeers) return 'not-syncing';
  return sync.statusById.get(recordId)
    ?? (sync.integrityUnavailable ? unavailableBadgeStatus(sync.unavailablePeers) : undefined);
}

export function useSyncIntegrity(kind, { peers: peersProp } = {}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [noSyncingPeers, setNoSyncingPeers] = useState(false);
  const [integrityUnavailable, setIntegrityUnavailable] = useState(false);
  const [statusById, setStatusById] = useState(() => new Map());
  const [byPeer, setByPeer] = useState(() => new Map());
  const [unavailablePeers, setUnavailablePeers] = useState([]);

  // Generation counter to discard stale async responses (e.g. if `kind`
  // changes while a fetch is in flight).
  const genRef = useRef(0);

  const run = useCallback(async () => {
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);

    try {
      // Resolve the peer list — use the caller-provided prop when available
      // to avoid a duplicate /instances fetch.
      let peers = peersProp;
      if (!peers) {
        const data = await getInstances({ silent: true });
        peers = data?.peers ?? [];
      }

      // Filter to online peers that have the matching sync category enabled.
      const category = KIND_TO_CATEGORY[kind];
      const eligiblePeers = (peers || []).filter(
        (p) =>
          p.enabled !== false &&
          p.status === 'online' &&
          p.syncEnabled !== false &&
          p.instanceId &&
          category &&
          p.syncCategories?.[category] === true,
      );

      if (gen !== genRef.current) return; // stale

      if (eligiblePeers.length === 0) {
        setNoSyncingPeers(true);
        setIntegrityUnavailable(false);
        setStatusById(new Map());
        setByPeer(new Map());
        setUnavailablePeers([]);
        setLoading(false);
        return;
      }

      setNoSyncingPeers(false);

      // Fetch integrity from all eligible peers in parallel. Failures for
      // individual peers are swallowed (fetchSyncIntegrity is silent; unavailable
      // peers surface via the `available:false` payload rather than throwing).
      const results = await Promise.all(
        eligiblePeers.map(async (peer) => {
          try {
            const data = await fetchSyncIntegrity(peer.instanceId, kind);
            return { peer, data };
          } catch {
            return { peer, data: { available: false, reason: 'fetch-failed', records: [] } };
          }
        }),
      );

      if (gen !== genRef.current) return; // stale

      // Reduce to per-record worst-case status + per-peer breakdown.
      const newStatusById = new Map();
      const newByPeer = new Map();
      const newUnavailablePeers = [];

      let anyAvailable = false;
      for (const { peer, data } of results) {
        if (!data?.available) {
          newUnavailablePeers.push({
            peerId: peer.instanceId,
            peerName: peer.name ?? peer.instanceId,
            reason: data?.reason ?? 'fetch-failed',
          });
          continue;
        }
        anyAvailable = true;
        for (const rec of data.records ?? []) {
          const existing = newStatusById.get(rec.id);
          newStatusById.set(rec.id, worstStatus(existing, rec.status));

          const entries = newByPeer.get(rec.id) ?? [];
          entries.push({ peerId: peer.instanceId, peerName: peer.name ?? peer.instanceId, status: rec.status });
          newByPeer.set(rec.id, entries);
        }
      }

      // Eligible peers existed but NONE returned usable integrity data (all
      // too-old / unreachable / fetch-failed). Without flagging this, every
      // statusById.get(id) is undefined and the badge silently disappears even
      // though sync IS configured — callers render a neutral badge off this.
      setIntegrityUnavailable(!anyAvailable);
      setStatusById(newStatusById);
      setByPeer(newByPeer);
      setUnavailablePeers(newUnavailablePeers);
    } catch (err) {
      if (gen !== genRef.current) return;
      setError(err);
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [kind, peersProp]);

  useEffect(() => {
    run();
  }, [run]);

  return { loading, error, noSyncingPeers, integrityUnavailable, statusById, byPeer, unavailablePeers, refresh: run };
}
