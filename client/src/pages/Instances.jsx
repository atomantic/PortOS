import PageHeader from '../components/PageHeader';
import PageLayout from '../components/PageLayout';
import { useState, useEffect, useCallback, useRef } from 'react';
import { Network, Plus, MonitorSmartphone, RadioTower, Route } from 'lucide-react';
import { useSearchParams } from 'react-router';
import Drawer from '../components/Drawer';
import useDrawerTab from '../hooks/useDrawerTab';
import { useSocketSubscription } from '../hooks/useSocketSubscription';
import EmptyState from '../components/EmptyState';
import socket from '../services/socket';
import { getInstances, getTailnetInfo, getNetworkExposure } from '../services/apiSystem.js';
import { getBrainParityReports } from '../services/apiBrain.js';
import UnattendedRenderRouting from '../components/instances/UnattendedRenderRouting';
import BrainParitySchedule from '../components/instances/BrainParitySchedule';
import TailnetHelpBanner from '../components/instances/TailnetHelpBanner';
import TailcatForwardsPanel from '../components/instances/TailcatForwardsPanel';
import TailcatServePanel from '../components/instances/TailcatServePanel';
import { TailcatServeProvider, useTailcatServe } from '../components/instances/TailcatServeProvider';
import PageSkeleton from '../components/ui/PageSkeleton';
import { PeerCard } from '../components/instances/PeerCard';
import { AddPeerForm } from '../components/instances/AddPeerDrawer';
import SelfCard from '../components/instances/SelfCard';

export { AddPeerForm, PeerCard };

function InstancesContent() {
  const peerAddressRef = useRef(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const drawer = searchParams.get('connection');
  const focusedPeerId = searchParams.get('peer');
  const [settingsTab, setSettingsTab] = useDrawerTab('connectionTab', 'instance', ['instance', 'network', 'relay', 'routing']);
  const [editingSelf, setEditingSelf] = useState(false);
  const [selfName, setSelfName] = useState('');
  const { status: serveStatus } = useTailcatServe();
  const openDrawer = (value, tab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set('connection', value);
      else next.delete('connection');
      if (tab) next.set('connectionTab', tab);
      return next;
    }, { replace: true });
  };
  const [self, setSelf] = useState(null);
  const [peers, setPeers] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [tailnetInfo, setTailnetInfo] = useState(null);
  const [networkExposure, setNetworkExposure] = useState(null);
  // Last stored brain-parity audit per peer, keyed by peer instanceId. Read
  // once here rather than per card: it's a single local-file read, and every
  // card needs a slice of it. Running a check is on-demand per card.
  const [parityReports, setParityReports] = useState({});
  const [loading, setLoading] = useState(true);
  const [snapshotError, setSnapshotError] = useState(false);
  const [snapshotLoaded, setSnapshotLoaded] = useState(false);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const snapshotRequest = useRef(0);
  const peerEventRevision = useRef(0);

  const fetchData = useCallback(async () => {
    const request = ++snapshotRequest.current;
    const peerRevision = peerEventRevision.current;
    setSnapshotLoading(true);
    const data = await getInstances({ silent: true }).catch(() => null);
    if (request !== snapshotRequest.current) return;
    setSnapshotLoading(false);
    setSnapshotError(!data);
    if (data) {
      setSelf(data.self);
      // Peer events can be newer than this read; the other snapshot fields
      // still belong to the latest request and must settle independently.
      if (peerRevision === peerEventRevision.current) setPeers(data.peers);
      setSyncStatus(data.syncStatus ?? null);
      setSnapshotLoaded(true);
    }
  }, []);

  useEffect(() => {
    // Kick off these reads in parallel — the tailnet map and exposure snapshot
    // are independent of peer state, and fetching them sequentially added
    // ~100-500ms to first paint on machines where `tailscale status --json`
    // is slow to respond.
    let active = true;
    Promise.all([
      fetchData(),
      getTailnetInfo().then((info) => { if (active) setTailnetInfo(info); }).catch(() => { if (active) setTailnetInfo(null); }),
      getNetworkExposure({ silent: true }).then((e) => { if (active) setNetworkExposure(e); }).catch(() => { if (active) setNetworkExposure(null); }),
      // Stored results only — the audit itself never runs on page load.
      getBrainParityReports({ silent: true })
        .then((data) => { if (active) setParityReports(data?.reports ?? {}); })
        .catch(() => { if (active) setParityReports({}); })
    ]).finally(() => { if (active) setLoading(false); });

    const handlePeersUpdated = (updatedPeers) => {
      peerEventRevision.current += 1;
      setPeers(updatedPeers);
    };
    socket.on('instances:peers:updated', handlePeersUpdated);
    // NOTE: `peerSync:subscription-blocked/unblocked` is intentionally NOT
    // handled here. Those events only mutate per-record subscription state
    // (`blockedBySchema`), which each PeerCard refetches for its own peer via
    // its peerSubs effect. A page-level fetchData() on every such event would
    // refetch all peers + syncStatus for a change that touches only one card.

    return () => {
      active = false;
      snapshotRequest.current += 1;
      socket.off('instances:peers:updated', handlePeersUpdated);
    };
  }, [fetchData]);

  // Namespace subscription, separate from the effect above so a reconnect's
  // refetch doesn't re-run (and re-race) the tailnet/exposure/parity-report
  // reads that only belong on mount. Re-emits `instances:subscribe` on every
  // socket reconnect and refetches peers/syncStatus, since the server's
  // per-socket subscriber Set is empty on the reconnected socket.
  useSocketSubscription('instances', { onResubscribe: fetchData });

  if (loading) {
    return (
      <PageSkeleton
        label="Loading instances"
        headerRowClass="flex items-center gap-3"
        titleWidthClass="w-40"
        showAction={false}
        layout="grid"
        gridColsClass="md:grid-cols-2"
        cards={4}
      />
    );
  }

  // Keep state owners above the remounting drawer tabs. The same snapshot
  // drives attention summaries and recovery controls, including with no peers.
  return (
    <TailcatForwardsPanel onChange={fetchData} peerIds={peers.map((peer) => peer.id)}
      renderPanel={(forwardsPanel, orphanCount) => (
        <UnattendedRenderRouting peers={peers} renderPanel={(routingPanel, routeAttention) => (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => openDrawer('add')}
                className="min-h-[44px] inline-flex items-center gap-1 rounded-lg bg-port-accent px-3 text-sm text-white">
                <Plus size={16} /> Add peer
              </button>
              <button type="button" onClick={() => openDrawer('settings')}
                className="min-h-[44px] rounded-lg border border-port-border px-3 text-sm text-gray-300 hover:text-white">
                Connection settings
              </button>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400">
              <span className="break-words min-w-0">{self?.name || 'This instance'}</span>
              <span>{networkExposure?.setup?.complete ? 'Tailscale HTTPS ready' : 'Network setup available'}</span>
              <span>{peers.filter((peer) => peer.status === 'online').length} / {peers.length} peers online</span>
            </div>
            {snapshotError && (
              <div role="alert" className="rounded-lg border border-port-warning/40 p-3 text-sm text-port-warning">
                <p>{snapshotLoaded ? 'Instance snapshot unavailable. Showing last loaded data.' : 'Instance snapshot unavailable. Peer and instance settings could not be loaded.'}</p>
                <button type="button" onClick={fetchData} disabled={snapshotLoading}
                  className="mt-2 min-h-[44px] rounded-lg border border-port-border px-3 disabled:opacity-50">
                  {snapshotLoading ? 'Retrying snapshot…' : 'Retry snapshot'}
                </button>
              </div>
            )}
            {(orphanCount > 0 || serveStatus?.status === 'failed') && (
              <button type="button" onClick={() => openDrawer('settings', 'relay')}
                className="block w-full rounded-lg border border-port-warning/40 p-3 text-left text-sm text-port-warning">
                Tailcat needs attention — review forwards and serve
              </button>
            )}
            {routeAttention && (
              <button type="button" onClick={() => openDrawer('settings', 'routing')}
                className="block w-full rounded-lg border border-port-warning/40 p-3 text-left text-sm text-port-warning">
                Unattended render routing needs attention — review routes
              </button>
            )}

            {snapshotLoaded && !snapshotError && focusedPeerId && !peers.some(peer => peer.id === focusedPeerId) && (
              <p role="status" className="text-sm text-gray-400">The linked peer is no longer registered on this install.</p>
            )}

            {peers.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
                  Peers ({peers.length})
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                  {peers.map(peer => (
                    // Reports key on instanceId (the stable federation identity), but
                    // a peer audited before it was ever probed files under its local
                    // registry id — mirror that fallback here or its report reads as
                    // "not checked".
                    <PeerCard
                      key={peer.id}
                      peer={peer}
                      onRefresh={fetchData}
                      syncStatus={syncStatus}
                      tailnetInfo={tailnetInfo}
                      parityReport={parityReports[peer.instanceId] ?? parityReports[peer.id] ?? null}
                      focused={focusedPeerId === peer.id}
                    />
                  ))}
                </div>
              </div>
            )}

            {snapshotLoaded && !snapshotError && peers.length === 0 && (
              <EmptyState
                icon={Network}
                title="No peers registered yet"
                message="Add another PortOS instance by its Tailscale IP address to federate records between your machines."
                actionLabel="Add your first peer"
                onAction={() => openDrawer('add')}
              />
            )}
            <AddPeerForm onAdd={fetchData} addressRef={peerAddressRef}
              drawer={{ open: drawer === 'add', onClose: () => openDrawer(null) }} />
            <Drawer open={drawer === 'settings'} onClose={() => openDrawer(null)}
              title="Connection settings" size="md"
              tabs={[
                { id: 'instance', label: 'This instance', icon: MonitorSmartphone },
                { id: 'network', label: 'Network', icon: Network },
                { id: 'relay', label: 'Tailcat', icon: RadioTower },
                { id: 'routing', label: 'Render routes', icon: Route },
              ]}
              activeTab={settingsTab} onTabChange={setSettingsTab}>
              {settingsTab === 'instance' && (
                <div className="space-y-4">
                  {!self && (
                    <div className="rounded-lg border border-port-warning/40 p-3 text-sm text-port-warning">
                      <p>This instance settings are unavailable until the instance snapshot loads.</p>
                      <button type="button" onClick={fetchData} disabled={snapshotLoading}
                        className="mt-2 min-h-[44px] rounded-lg border border-port-border px-3 disabled:opacity-50">
                        {snapshotLoading ? 'Retrying snapshot…' : 'Retry instance settings'}
                      </button>
                    </div>
                  )}
                  <SelfCard self={self} onUpdate={fetchData} syncStatus={syncStatus} tailnetInfo={tailnetInfo}
                    editing={editingSelf} setEditing={setEditingSelf} name={selfName} setName={setSelfName} />
                  <BrainParitySchedule />
                </div>
              )}
              {settingsTab === 'network' && <TailnetHelpBanner tailnetInfo={tailnetInfo} networkExposure={networkExposure} />}
              {settingsTab === 'relay' && (
                <div className="space-y-4">
                  <TailcatServePanel onChange={fetchData} />
                  {forwardsPanel}
                </div>
              )}
              {settingsTab === 'routing' && (routingPanel || <p className="text-sm text-gray-400">No render routes configured. Enable a Tailscale peer as a media provider to add one.</p>)}
            </Drawer>
          </div>
        )} />
      )} />
  );
}

export default function Instances() {
  return (
    <PageLayout header={<PageHeader icon={Network} title="Instances" subtitle="PortOS Federation" />}>
      <TailcatServeProvider><InstancesContent /></TailcatServeProvider>
    </PageLayout>
  );
}
