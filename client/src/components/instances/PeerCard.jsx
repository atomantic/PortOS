import { useState, useEffect, useRef } from 'react';
import { Trash2, RefreshCw, Edit3, Check, X, Wifi, WifiOff, CircleDot, Cpu, HardDrive, Activity, Bot, MonitorSmartphone, Tag, ArrowUpRight, ArrowDownLeft, ArrowLeftRight, RefreshCcw, Timer } from 'lucide-react';
import { useSocketResource } from '../../hooks/useSocketResource';
import toast from '../ui/Toast';
import Pill from '../ui/Pill';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import socket from '../../services/socket';
import {
  updatePeer,
  removePeer,
  connectPeer,
  probePeer,
  syncPeer,
  retryTailcatForward,
  forgetTailcatForward,
} from '../../services/apiSystem.js';
import { listPeerSubscriptions } from '../../services/apiPeerSync.js';
import PeerSyncSecretEditor from './PeerSyncSecretEditor';
import PeerAppsList from './PeerAppsList';
import PeerAgentsSection from './PeerAgentsSection';
import { SchemaGapBadge } from './SchemaGapBadge';
import ListLoadError from '../ui/ListLoadError';
import PeerMediaProviderPanel from './PeerMediaProviderPanel';
import PeerAdministrationPanel from './PeerAdministrationPanel';
import BrainParityPanel from './BrainParityPanel';
import TailcatForwardStatus from './TailcatForwardStatus';
import { timeAgo, timeUntil } from '../../utils/formatters';
import PeerHostEditor from './PeerHostEditor';
import PeerAuthEditor from './PeerAuthEditor';
import SyncCategoriesPanel from './SyncCategoriesPanel';
import SyncStatusSection from './SyncStatusSection';

const STATUS_COLORS = {
  online: 'text-port-success',
  offline: 'text-port-error',
  unknown: 'text-gray-500'
};

const STATUS_ICONS = {
  online: Wifi,
  offline: WifiOff,
  unknown: CircleDot
};

function HealthSummary({ health, version }) {
  if (!health) return <span className="text-gray-500 text-xs">No data</span>;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      {version && (
        <div className="flex items-center gap-1.5 text-gray-400 col-span-2">
          <Tag size={12} />
          <span>v{version}</span>
        </div>
      )}
      <div className="flex items-center gap-1.5 text-gray-400">
        <HardDrive size={12} />
        <span>Mem {health.system?.memory?.usagePercent ?? '?'}%</span>
      </div>
      <div className="flex items-center gap-1.5 text-gray-400">
        <Cpu size={12} />
        <span>CPU {health.system?.cpu?.usagePercent ?? '?'}%</span>
      </div>
      <div className="flex items-center gap-1.5 text-gray-400">
        <Activity size={12} />
        <span>Up {health.system?.uptimeFormatted ?? '?'}</span>
      </div>
      <div className="flex items-center gap-1.5 text-gray-400">
        <MonitorSmartphone size={12} />
        <span>{health.apps?.total ?? '?'} apps</span>
      </div>
      {health.cos && (
        <div className="flex items-center gap-1.5 text-gray-400 col-span-2">
          <Bot size={12} />
          {/* `queuedTasks: null` means the pending list could not be read, not that
              nothing is waiting — render it as unknown rather than a confident zero. */}
          <span>{health.cos.activeAgents ?? 0} agents, {health.cos.queuedTasks ?? '?'} queued</span>
        </div>
      )}
    </div>
  );
}

function DirectionBadge({ directions = [] }) {
  const hasInbound = directions.includes('inbound');
  const hasOutbound = directions.includes('outbound');

  if (hasInbound && hasOutbound) {
    return (
      <Pill tone="success" size="xs" bordered={false} icon={ArrowLeftRight} title="Bidirectional — we added them and they added us">
        mutual
      </Pill>
    );
  }
  if (hasOutbound) {
    return (
      <Pill tone="accent" size="xs" bordered={false} icon={ArrowUpRight} title="Outbound — we added this peer">
        outbound
      </Pill>
    );
  }
  if (hasInbound) {
    return (
      <Pill tone="warning" size="xs" bordered={false} icon={ArrowDownLeft} title="Inbound — this peer added us">
        inbound
      </Pill>
    );
  }
  return null;
}

function ProbeDiagnostics({ peer, probing, onProbe }) {
  const last = peer.lastProbe;
  return (
    <div className="mt-2 rounded-lg border border-port-border bg-port-bg/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-gray-500">Health check</span>
        <button
          type="button"
          onClick={onProbe}
          disabled={probing}
          className="inline-flex items-center gap-1 text-[11px] text-port-accent hover:text-white disabled:opacity-50 border border-port-accent/40 rounded px-2 py-1 pointer-coarse:min-h-11 pointer-coarse:px-3 transition-colors"
          title="Force an immediate health/details probe"
        >
          <RefreshCw size={11} className={probing ? 'animate-spin' : ''} />
          {probing ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {last ? (
        <p className={`mt-1.5 text-[11px] leading-snug break-words ${last.ok ? 'text-port-success' : 'text-port-warning'}`}>
          {last.ok ? 'ok' : (last.class || 'failed')}
          {last.httpStatus != null && ` · HTTP ${last.httpStatus}`}
          {last.latencyMs != null && ` · ${last.latencyMs}ms`}
          {last.at && ` · ${timeAgo(last.at)}`}
          {!last.ok && last.message && (
            <span className="block text-gray-400 mt-0.5">{last.message}</span>
          )}
          {peer.consecutiveFailures > 0 && peer.nextProbeAt && (
            <span className="block text-gray-500 mt-0.5">
              next probe {timeUntil(peer.nextProbeAt) ?? '—'}
            </span>
          )}
        </p>
      ) : (
        <p className="mt-1.5 text-[11px] text-gray-500">No probe result yet — run a health check.</p>
      )}
    </div>
  );
}

const PEER_SUBSCRIPTION_EVENTS = ['peerSync:subscription-blocked', 'peerSync:subscription-unblocked', 'peerSync:subscription:created'];
const EMPTY_SUBS = [];

export function PeerCard({ peer, onRefresh, syncStatus, tailnetInfo, parityReport, focused = false }) {
  const cardRef = useRef(null);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');
  const [probing, setProbing] = useState(false);
  const [forwardBusy, setForwardBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Outbound subscriptions inform per-record schema compatibility. A failed
  // read keeps the last good subscriptions and surfaces an error row, so a
  // hidden "peer is behind" warning is never mistaken for "no mismatch".
  const { data: peerSubsData, error: peerSubsError, refetch: retryPeerSubs } = useSocketResource(
    () => listPeerSubscriptions({ peerId: peer.instanceId }, { silent: true }),
    {
      events: PEER_SUBSCRIPTION_EVENTS,
      // Events carry `peerId`, so only the affected card refetches. A block
      // or an incoming push's auto-created reverse subscription changes rows
      // the page-level peers refresh doesn't reach.
      matchesEvent: (payload) => !payload?.peerId || payload.peerId === peer.instanceId,
      resourceKey: peer.instanceId,
      enabled: !!peer.instanceId,
    }
  );
  const peerSubs = peerSubsData?.subscriptions || EMPTY_SUBS;
  // Live sync activity, driven by the `sync:progress` socket event. `syncing`
  // is true between this peer's `start` and `complete`; while it's true every
  // enabled category badge shows "syncing…". On `complete` it clears and the
  // parent's peers refetch settles the card to the new directional summary.
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!peer.instanceId) return;
    const handleProgress = (payload) => {
      if (payload?.peerId !== peer.instanceId) return;
      if (payload.phase === 'start') {
        setSyncing(true);
      } else if (payload.phase === 'complete') {
        setSyncing(false);
        // Pull the freshest cursors/seqs so the card settles to the new
        // directional summary. Only when records actually moved — otherwise the
        // 60s background `syncAllPeers` cycle would fire a full page refetch per
        // peer on every idle tick (a refetch herd). The manual "Sync now" path
        // (`handleSync`) does its own authoritative refetch on the awaited POST,
        // so a no-op manual sync still settles; this branch covers the
        // records-moved case for both manual and background syncs.
        // A failed cycle applies nothing, so the totalApplied gate alone would
        // never pull the new `lastSyncError` onto the card (#7943).
        if (payload.totalApplied > 0 || payload.error) onRefresh();
      }
      // `applied` events are informational (and drive the server-side log) —
      // the global `syncing` flag already animates every badge, so the client
      // needn't track per-category granularity.
    };
    socket.on('sync:progress', handleProgress);
    return () => socket.off('sync:progress', handleProgress);
  }, [peer.instanceId, onRefresh]);

  const StatusIcon = STATUS_ICONS[peer.status] || CircleDot;
  const isInboundOnly = peer.directions?.includes('inbound') && !peer.directions?.includes('outbound');
  const peerLabel = peer.name || peer.address;

  const handleConnect = async () => {
    setConnecting(true);
    const result = await connectPeer(peer.id).catch(() => null);
    setConnecting(false);
    if (!result) return;
    onRefresh();
    toast.success(`Connected to ${peer.name}`);
  };

  const handleProbe = async () => {
    setProbing(true);
    const result = await probePeer(peer.id).catch(() => null);
    onRefresh();
    setProbing(false);
    if (!result) {
      toast.error(`Health check failed for ${peer.name}`);
      return;
    }
    if (result.status === 'online') {
      const ms = result.lastProbe?.latencyMs;
      toast.success(`Health check ok${ms != null ? ` (${ms}ms)` : ''}`);
    } else {
      const detail = result.lastProbe?.message || result.lastProbe?.class || 'offline';
      toast.error(`Health check: ${detail}`);
    }
  };

  const handleForwardRetry = async (remotePort, tcAddress) => {
    const forwardId = peer.tailcatForward?.id;
    if (!forwardId) return;
    setForwardBusy(true);
    const updated = await retryTailcatForward(forwardId, { ...(remotePort ? { remotePort } : {}), ...(tcAddress ? { tcAddress } : {}) }).catch(() => null);
    setForwardBusy(false);
    onRefresh();
    if (!updated) return;
    toast.success(`Tailcat forward restarted on 127.0.0.1:${updated.port}`);
  };

  const handleForwardForget = async () => {
    const forwardId = peer.tailcatForward?.id;
    if (!forwardId) return;
    setForwardBusy(true);
    const removed = await forgetTailcatForward(forwardId).catch(() => null);
    setForwardBusy(false);
    if (!removed) return;
    onRefresh();
    toast.success('Tailcat forward and peer removed');
  };

  const handleSync = async () => {
    // Optimistically flip the card into its syncing state — the server's
    // `sync:progress` start event will confirm it, but this gives instant
    // feedback even before the socket round-trips. The custom catch owns the
    // error UI, so request() must stay silent to avoid a double toast.
    setSyncing(true);
    const result = await syncPeer(peer.id, { silent: true }).catch(() => null);
    // The POST awaits the full sync server-side, so its resolution IS the
    // authoritative completion for a manual sync — clear the spinner here
    // rather than relying solely on the fire-and-forget `complete` socket
    // event, which a transient socket disconnect could drop and leave the card
    // stuck. The refetch itself is owned by the `complete` handler (gated on
    // records-moved); a no-op manual sync changes nothing worth refetching.
    setSyncing(false);
    if (!result) {
      toast.error(`Couldn't sync with ${peer.name} — is it online?`);
    }
  };

  const handleRemove = async () => {
    const result = await removePeer(peer.id).catch(() => null);
    if (!result) return;
    onRefresh();
    toast.success('Peer removed');
  };

  const handleToggle = async () => {
    await updatePeer(peer.id, { enabled: !peer.enabled }).catch(() => null);
    onRefresh();
  };

  const saveName = async () => {
    if (!name.trim()) return;
    const result = await updatePeer(peer.id, { name: name.trim() }).catch(() => null);
    if (!result) return;
    onRefresh();
    setEditingName(false);
  };

  // `?peer=<id>` deep links (e.g. from App Quality's unavailable-peer list) land on this card.
  useEffect(() => {
    if (focused) cardRef.current?.scrollIntoView?.({ block: 'center' });
  }, [focused]);

  return (
    <div
      ref={cardRef}
      data-peer-id={peer.id}
      aria-current={focused ? 'true' : undefined}
      className={`bg-port-card border rounded-xl p-5 transition-opacity ${focused ? 'border-port-accent ring-2 ring-port-accent/40' : 'border-port-border'} ${!peer.enabled ? 'opacity-50' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <StatusIcon size={16} className={STATUS_COLORS[peer.status]} />
          {editingName ? (
            <div className="flex items-center gap-1">
              <input
                aria-label="Peer name"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveName()}
                className="bg-port-bg border border-port-border rounded px-2 py-0.5 text-sm text-white focus:outline-hidden focus:border-port-accent w-32"
                autoFocus
              />
              <button onClick={saveName} aria-label="Save name" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-port-success hover:text-port-success/80"><Check size={14} /></button>
              <button onClick={() => setEditingName(false)} aria-label="Cancel" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-500 hover:text-white"><X size={14} /></button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-white font-medium">{peer.name}</span>
              <button onClick={() => { setName(peer.name); setEditingName(true); }} aria-label="Edit" className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center text-gray-600 hover:text-white">
                <Edit3 size={12} />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing || peer.status !== 'online'}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-port-accent transition-colors disabled:opacity-40 disabled:hover:text-gray-500"
            title={peer.status === 'online' ? 'Sync now' : 'Peer offline — cannot sync'}
            aria-label={peer.status === 'online' ? 'Sync now' : 'Peer offline — cannot sync'}
          >
            <RefreshCcw size={14} className={syncing ? 'animate-spin text-port-accent' : ''} />
          </button>
          <button
            onClick={handleProbe}
            disabled={probing}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-500 hover:text-white transition-colors disabled:opacity-50"
            title="Probe now" aria-label="Probe now"
          >
            <RefreshCw size={14} className={probing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleToggle}
            className={`min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 transition-colors text-xs font-mono ${peer.enabled ? 'text-port-success hover:text-port-success/80' : 'text-gray-600 hover:text-white'}`}
            title={peer.enabled ? 'Disable polling' : 'Enable polling'}
            aria-label={peer.enabled ? 'ON, disable polling' : 'OFF, enable polling'}
          >
            {peer.enabled ? 'ON' : 'OFF'}
          </button>
          {confirmRemove ? (
            <ConfirmButtonPair
              prompt={`Remove peer "${peerLabel}"?`}
              confirmText="Remove"
              confirmIcon={Trash2}
              cancelText="Cancel"
              ariaLabel={`Confirm removing peer ${peerLabel}`}
              confirmAriaLabel={`Confirm removing peer ${peerLabel}`}
              cancelAriaLabel={`Cancel removing peer ${peerLabel}`}
              largeTouchTargets
              onConfirm={handleRemove}
              onCancel={() => setConfirmRemove(false)}
            />
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-600 hover:text-port-error transition-colors"
              title="Remove peer" aria-label="Remove peer"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-xs text-gray-500 font-mono">{peer.address}:{peer.port}</p>
          {peer.transport === 'tailcat' && (
            <Pill tone="accent" size="xs" bordered={false} title="Reachable via local tailcat forward (no Tailscale account)">
              tailcat
            </Pill>
          )}
          <DirectionBadge directions={peer.directions} />
          {isInboundOnly && (
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="inline-flex items-center gap-1 text-[10px] pointer-coarse:min-h-11 text-port-accent bg-port-accent/10 hover:bg-port-accent/20 rounded px-1.5 py-0.5 transition-colors disabled:opacity-50"
              title="Connect back to make this mutual"
            >
              <ArrowLeftRight size={10} />
              {connecting ? 'Connecting...' : 'Connect'}
            </button>
          )}
        </div>
        <PeerHostEditor peer={peer} onRefresh={onRefresh} tailnetInfo={tailnetInfo} />
        <PeerAuthEditor peer={peer} onRefresh={onRefresh} />
        <PeerSyncSecretEditor peer={peer} onRefresh={onRefresh} />
      </div>

      {peer.transport === 'tailcat' && (
        <div className="mb-2">
          <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">Tailcat forward</div>
          <TailcatForwardStatus
            forward={peer.tailcatForward}
            busy={forwardBusy}
            onRetry={peer.tailcatForward?.id ? handleForwardRetry : undefined}
            onForget={peer.tailcatForward?.id ? handleForwardForget : undefined}
            compact
          />
        </div>
      )}

      <HealthSummary health={peer.lastHealth} version={peer.version} />

      <ProbeDiagnostics peer={peer} probing={probing} onProbe={handleProbe} />

      <div className="mt-2 text-xs text-gray-600">
        Last seen: {timeAgo(peer.lastSeen)}
      </div>

      {peer.consecutiveFailures > 0 && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-port-warning">
          <Timer size={12} />
          <span>
            {peer.consecutiveFailures} consecutive failure{peer.consecutiveFailures !== 1 ? 's' : ''}
            {peer.nextProbeAt && ` · next probe ${timeUntil(peer.nextProbeAt) ?? '—'}`}
          </span>
        </div>
      )}

      <SchemaGapBadge peer={peer} peerSubs={peerSubs} />
      {peerSubsError && (
        <ListLoadError
          what="subscriptions used for schema-compatibility warnings"
          error={peerSubsError}
          onRetry={retryPeerSubs}
          className="mt-2"
        />
      )}

      <PeerMediaProviderPanel peer={peer} onRefresh={onRefresh} />
      <PeerAdministrationPanel peer={peer} />

      <SyncCategoriesPanel peer={peer} onRefresh={onRefresh} />

      <SyncStatusSection peer={peer} syncStatus={syncStatus} syncing={syncing} />

      <BrainParityPanel peer={peer} report={parityReport} />

      <PeerAppsList apps={peer.lastApps} peerAddress={peer.address} peerHost={peer.host} />
      {peer.status === 'online' && (
        <PeerAgentsSection peerId={peer.id} peerName={peer.name} />
      )}
    </div>
  );
}
