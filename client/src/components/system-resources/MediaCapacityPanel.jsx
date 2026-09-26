import { useCallback, useEffect, useRef, useState } from 'react';
import { Gauge } from 'lucide-react';
import { Link } from 'react-router';
import { useSocketSubscription } from '../../hooks/useSocketSubscription.js';
import { useVisibilityEvent } from '../../hooks/useVisibilityEvent.js';
import useMounted from '../../hooks/useMounted.js';
import socket from '../../services/socket';
import * as api from '../../services/api.js';
import Pill from '../ui/Pill';
import { timeAgo } from '../../utils/formatters';
import {
  FEDERATED_MEDIA_KINDS,
  resolvePeerMediaReadiness,
  summarizePeerMediaQueue,
} from '../../lib/federatedMediaReadiness.js';

// Three-state, never a boolean. `unknown` means the nvidia-smi probe itself
// failed; reporting that as "no GPU" would tell the user a machine has no
// accelerator when the truth is that we could not find out (#4348).
const CUDA_META = {
  available: { label: 'CUDA available', tone: 'success' },
  absent: { label: 'no CUDA device', tone: 'note' },
  unknown: { label: 'CUDA unknown', tone: 'warning' },
};

const LANES = [
  { id: 'gpu', label: 'Local GPU', help: 'Serialized — one render at a time.' },
  { id: 'cloud', label: 'Cloud CLI', help: 'Parallel — external quota, no local GPU.' },
  { id: 'remote', label: 'Federated', help: 'Parallel — rendered on a peer.' },
];

function LaneRow({ label, help, lane }) {
  const saturated = lane.running >= lane.limit;
  return (
    <div className="rounded-lg border border-port-border bg-port-bg px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-300">{label}</span>
        <span className={`ml-auto text-xs font-mono ${saturated ? 'text-port-warning' : 'text-gray-400'}`}>
          {lane.running}/{lane.limit}
        </span>
      </div>
      <div className="mt-0.5 text-[10px] text-gray-600">
        {lane.queued > 0 ? `${lane.queued} queued · ` : ''}{help}
      </div>
    </div>
  );
}

function PeerRow({ peer }) {
  const readiness = resolvePeerMediaReadiness(peer);
  const queueSegments = summarizePeerMediaQueue(readiness.queue);
  return (
    <div className="rounded-lg border border-port-border bg-port-bg px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="truncate text-xs font-medium text-gray-300">{peer.name || peer.id}</span>
        <Pill tone={readiness.tone} size="xs" bordered={false} className="ml-auto shrink-0">
          {readiness.label}
        </Pill>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-gray-600">
        {readiness.kinds.length > 0
          ? <span>{readiness.kinds.join(' · ')}</span>
          : <span>no models allowlisted</span>}
        {queueSegments.length > 0 && <span>{queueSegments.join(' · ')}</span>}
        {readiness.checkedAt && <span>checked {timeAgo(readiness.checkedAt)}</span>}
      </div>
      {readiness.help && (
        <p className="mt-1 text-[10px] leading-snug text-port-warning">{readiness.help}</p>
      )}
    </div>
  );
}

/**
 * Local media-lane capacity plus every opted-in peer provider's readiness
 * (#4348) — the System Health answer to "can this install render right now,
 * here or on a peer, and if not, why not?".
 *
 * The peer half is assembled in the browser from `GET /api/instances`, which is
 * a LOCAL read. It is deliberately not folded into `/api/system/health/details`
 * alongside the local half: registered peers fetch that endpoint on every
 * probe, so our peer list and routing policy would ride federation with it —
 * exactly what `redactPeerForWire` keeps machine-local.
 */
export default function MediaCapacityPanel({ media }) {
  const [peers, setPeers] = useState(null);
  const [peersFailed, setPeersFailed] = useState(false);

  const mounted = useMounted();
  const revision = useRef(0);
  const loadPeers = useCallback(async () => {
    const request = ++revision.current;
    const data = await api.getInstances({ silent: true }).catch(() => null);
    if (!mounted.current || request !== revision.current) return;
    // A read that failed, and a read that came back without a peer array, are
    // both "we do not know" — distinct from `[]`, which is "read fine, no
    // peers". Coercing a malformed body to `[]` would render the confident
    // claim "no providers configured" off a response we could not parse.
    if (!Array.isArray(data?.peers)) {
      setPeersFailed(true);
      return;
    }
    setPeersFailed(false);
    setPeers(data.peers);
  }, [mounted]);

  useEffect(() => {
    const updatePeers = (snapshot) => {
      if (!Array.isArray(snapshot)) return;
      // An older HTTP response must not overwrite a newer pushed snapshot.
      revision.current += 1;
      setPeers(snapshot);
      setPeersFailed(false);
    };
    socket.on('instances:peers:updated', updatePeers);
    loadPeers();
    return () => {
      revision.current += 1;
      socket.off('instances:peers:updated', updatePeers);
    };
  }, [loadPeers]);
  useSocketSubscription('instances', { onResubscribe: loadPeers });
  useVisibilityEvent((state) => {
    if (state === 'visible') loadPeers();
  });

  const providers = (peers || []).filter((peer) => peer?.mediaProvider?.enabled === true);
  const cuda = CUDA_META[media?.gpu?.cudaStatus] || CUDA_META.unknown;

  return (
    <div className="rounded-xl border border-port-border bg-port-card p-4">
      <div className="flex items-center gap-2">
        <Gauge size={16} className="text-port-accent" />
        <h3 className="font-semibold text-white">Media capacity</h3>
        <Pill tone={cuda.tone} size="xs" bordered={false} className="ml-auto">{cuda.label}</Pill>
      </div>

      {!media ? (
        <p className="mt-3 text-sm text-gray-400">
          Media-lane capacity is unavailable. Local render slots and queue depth are unknown.
        </p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
            {LANES.map(({ id, label, help }) => (
              <LaneRow key={id} label={label} help={help} lane={media.lanes[id]} />
            ))}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500">
            <span>{media.totals.running} running · {media.totals.queued} queued</span>
            {FEDERATED_MEDIA_KINDS.map(({ kind, label }) => {
              const counts = media.byKind?.[kind];
              if (!counts || (!counts.running && !counts.queued)) return null;
              return <span key={kind}>{label}: {counts.running}/{counts.queued}</span>;
            })}
          </div>
        </>
      )}

      <div className="mt-4 border-t border-port-border/60 pt-3">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Peer providers</h4>
          <Link to="/instances" className="ml-auto text-[11px] text-port-accent hover:underline">
            Instances
          </Link>
        </div>

        {/* A refresh that fails once we already have a list keeps showing it,
            flagged as last-known — the same call QueuesPanel makes. Only a
            failure with nothing to fall back on reports unknown, because that
            is the one case where rendering an empty list would assert
            "no providers configured" without having read anything. */}
        {peersFailed && (
          <p className="mt-2 text-xs text-port-warning">
            Peer list refresh failed. {peers === null
              ? 'Provider readiness is unknown.'
              : 'Showing the last known snapshot.'}
          </p>
        )}

        {peers === null ? (
          !peersFailed && <p className="mt-2 text-xs text-gray-500">Loading peer providers…</p>
        ) : providers.length === 0 ? (
          <p className="mt-2 text-xs text-gray-500">
            No peer is enabled as a media provider. Enable one from Instances to render on another machine.
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {providers.map((peer) => <PeerRow key={peer.id} peer={peer} />)}
          </div>
        )}
      </div>
    </div>
  );
}
