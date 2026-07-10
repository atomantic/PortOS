import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Network, Plus, Trash2, RefreshCw, Edit3, Check, X,
  Wifi, WifiOff, CircleDot,
  Cpu, HardDrive, Activity, Bot, MonitorSmartphone, Tag,
  ArrowUpRight, ArrowDownLeft, ArrowLeftRight,
  Database, Brain, CheckCircle2, AlertCircle, Clock,
  RefreshCcw, Timer,
  Target, Sword, Fingerprint, HeartPulse, ChevronDown, ChevronRight,
  Lock, Globe, Info, Sparkles, Film, Images, Library, BookOpen, FilePen, Music, Music2, Disc3, Clapperboard, Palette, BookText, FolderTree, Video
} from 'lucide-react';
import toast from '../components/ui/Toast';
import Pill from '../components/ui/Pill';
import socket from '../services/socket';
import {
  getInstances, updateSelfInstance, addPeer, updatePeer,
  removePeer, connectPeer, reciprocatePeer, probePeer, syncPeer, getTailnetInfo, provisionTailnetCert,
  getNetworkExposure,
  listPeerSubscriptions,
  getPeerFullSyncCoverage,
} from '../services/api';
import PeerAppsList from '../components/instances/PeerAppsList';
import PeerAgentsSection from '../components/instances/PeerAgentsSection';
import { SchemaGapBadge } from '../components/instances/SchemaGapBadge';
import { timeAgo, timeUntil } from '../utils/formatters';
import { useLocalStorageBool } from '../hooks/useLocalStorageBool';
import { directionalCounts, describeDirectional } from '../lib/syncCounts';

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
          <span>{health.cos.activeAgents ?? 0} agents, {health.cos.queuedTasks ?? 0} queued</span>
        </div>
      )}
    </div>
  );
}

function TailnetHelpBanner({ tailnetInfo, networkExposure }) {
  const [collapsed, setCollapsed] = useLocalStorageBool('portos-tailnet-help-collapsed', false);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionResult, setProvisionResult] = useState(null);

  const toggle = () => setCollapsed((prev) => !prev);

  const provision = async (e) => {
    e.stopPropagation();
    setProvisioning(true);
    setProvisionResult(null);
    const result = await provisionTailnetCert().catch(() => null);
    setProvisioning(false);
    if (!result?.ok) return; // request() already toasted the error
    setProvisionResult(result);
    toast.success(result.message);
  };

  const status = tailnetInfo === null
    ? { label: 'Tailscale DNS not detected', tone: 'warn', detail: 'Install Tailscale and enable MagicDNS in your tailnet admin to auto-suggest peer DNS names.' }
    : tailnetInfo?.suffix
      ? { label: `MagicDNS: ${tailnetInfo.suffix}`, tone: 'ok', detail: tailnetInfo.self ? `This instance: ${tailnetInfo.self}` : null }
      : { label: 'Tailscale running but MagicDNS suffix not found', tone: 'warn', detail: 'Enable MagicDNS in your tailnet admin console (login.tailscale.com/admin/dns).' };

  const ToneIcon = status.tone === 'ok' ? CheckCircle2 : AlertCircle;
  const toneClass = status.tone === 'ok' ? 'text-port-success' : 'text-port-warning';
  const trustedHttpsHost = networkExposure?.httpsEnabled && networkExposure?.cert?.mode === 'tailscale'
    ? networkExposure.cert.tailscaleHost || tailnetInfo?.self || null
    : null;
  const trustedHttpsPort = networkExposure?.bind?.port || 5555;
  const trustedHttpsUrl = trustedHttpsHost ? `https://${trustedHttpsHost}:${trustedHttpsPort}` : null;

  // Only offer the one-click provision button when Tailscale is actually
  // detected and we have a MagicDNS hostname for this instance — otherwise
  // the API call will fail with the same "enable MagicDNS first" guidance.
  const canProvision = !!tailnetInfo?.self;

  if (trustedHttpsHost) {
    return (
      <div className="bg-port-card border border-port-border rounded-xl px-4 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <Lock size={16} className="text-port-success shrink-0" />
          <div className="flex-1 min-w-[220px]">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium text-white">Tailnet DNS &amp; trusted HTTPS</span>
              <Pill tone="success" size="xs" bordered={false} icon={CheckCircle2}>
                Running on Tailscale HTTPS
              </Pill>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Currently running on HTTPS with Tailscale DNS.
            </p>
          </div>
          {trustedHttpsUrl && (
            <a
              href={trustedHttpsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-port-accent hover:text-port-accent/80 font-mono"
              title={`Open ${trustedHttpsUrl}`}
            >
              {trustedHttpsHost}
              <ArrowUpRight size={12} />
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-port-card border border-port-border rounded-xl">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 p-4 text-left"
      >
        <Lock size={16} className="text-port-accent shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white">Tailnet DNS &amp; trusted HTTPS</span>
            <Pill tone="bare" size="xs" bordered={false} icon={ToneIcon} className={`${toneClass} bg-port-bg`}>
              {status.label}
            </Pill>
          </div>
        </div>
        {collapsed ? <ChevronRight size={14} className="text-gray-500" /> : <ChevronDown size={14} className="text-gray-500" />}
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 -mt-1 text-xs text-gray-400 space-y-2">
          {status.detail && (
            <div className="flex items-start gap-1.5">
              <Info size={11} className="mt-0.5 text-gray-500 shrink-0" />
              <span className="font-mono">{status.detail}</span>
            </div>
          )}
          <p>
            By default, federation traffic uses <span className="font-mono text-gray-300">http://{`<ip>`}:5555</span>. Setting a Tailscale MagicDNS host on a peer
            switches that hop to <span className="font-mono text-gray-300">https://{`<host>`}.{tailnetInfo?.suffix || `<tailnet>`}.ts.net</span> with a
            browser-trusted Let&apos;s Encrypt cert provisioned by Tailscale.
          </p>
          <ol className="list-decimal list-inside space-y-1 text-gray-500">
            <li>On each instance, enable MagicDNS + HTTPS Certificates in your tailnet admin (<span className="font-mono">login.tailscale.com/admin/dns</span>).</li>
            <li>
              Click <span className="text-port-accent">Enable HTTPS</span> below to fetch the cert via Tailscale
              (or run <span className="font-mono text-gray-300">npm run setup:cert</span> from a shell).
            </li>
            <li>Below, click <span className="text-port-accent">use {`<host>`}</span> on each peer to switch the link to HTTPS. Or click <span className="text-gray-400">use IP only</span> to revert.</li>
          </ol>
          <div className="flex items-center gap-2 flex-wrap pt-1">
            <button
              onClick={provision}
              disabled={provisioning || !canProvision}
              title={canProvision
                ? `Run \`tailscale cert\` for ${tailnetInfo.self} and write data/certs/{cert,key}.pem`
                : 'Enable MagicDNS in your tailnet admin first, then reload this page'}
              className="inline-flex items-center gap-1.5 bg-port-accent hover:bg-port-accent/80 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded text-xs font-medium transition-colors min-h-[40px] sm:min-h-0"
            >
              <Lock size={12} />
              {provisioning ? 'Provisioning…' : 'Enable HTTPS'}
            </button>
            {provisionResult?.ok && (
              <span className="inline-flex items-center gap-1 text-[11px] text-port-success">
                <CheckCircle2 size={11} />
                {provisionResult.requiresRestart
                  ? 'Cert installed — restart PortOS to activate HTTPS'
                  : 'Cert installed and live'}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SelfCard({ self, onUpdate, syncStatus, tailnetInfo }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');

  const startEdit = () => {
    setName(self?.name || '');
    setEditing(true);
  };

  const saveName = async () => {
    if (!name.trim()) return;
    const result = await updateSelfInstance({ name: name.trim() }).catch(() => null);
    if (!result) return;
    document.title = `PortOS: ${name.trim()}`;
    onUpdate();
    setEditing(false);
    toast.success('Instance name updated');
  };

  const defaultFullSync = self?.defaultPeerFullSync === true;
  const toggleDefaultFullSync = async () => {
    const result = await updateSelfInstance({ defaultPeerFullSync: !defaultFullSync }).catch(() => null);
    if (!result) return;
    onUpdate();
    toast.success(`New peers will ${!defaultFullSync ? 'default to full mirror' : 'start with no categories'}`);
  };

  if (!self) return null;

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider">This Instance</h3>
        <Network size={16} className="text-port-accent" />
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {editing ? (
            <div className="flex items-center gap-2 flex-1">
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveName()}
                className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white focus:outline-hidden focus:border-port-accent"
                autoFocus
              />
              <button onClick={saveName} aria-label="Save name" className="text-port-success hover:text-port-success/80">
                <Check size={16} />
              </button>
              <button onClick={() => setEditing(false)} aria-label="Cancel" className="text-gray-500 hover:text-white">
                <X size={16} />
              </button>
            </div>
          ) : (
            <>
              <span className="text-white font-semibold text-lg">{self.name}</span>
              <button onClick={startEdit} aria-label="Edit" className="text-gray-500 hover:text-white">
                <Edit3 size={14} />
              </button>
            </>
          )}
        </div>
        <p className="text-xs text-gray-500 font-mono">{self.instanceId}</p>
        {tailnetInfo?.self ? (
          <div className="flex items-center gap-1.5 text-[11px] mt-1" title="This instance's Tailscale MagicDNS name — peers can reach you over HTTPS at this name">
            <Globe size={11} className="text-port-accent" />
            <span className="font-mono text-port-accent">{tailnetInfo.self}</span>
            <span className="text-gray-600">·</span>
            <span className="text-gray-500">tailnet DNS</span>
          </div>
        ) : tailnetInfo === null ? null : (
          <div className="flex items-center gap-1.5 text-[11px] mt-1 text-gray-500" title="No MagicDNS name detected for this instance">
            <Globe size={11} />
            <span>No tailnet DNS — peers will reach you by IP</span>
          </div>
        )}
        <button
          onClick={toggleDefaultFullSync}
          className="mt-2 pt-2 border-t border-port-border/50 flex items-start gap-2 w-full text-left group"
          title="When on, peers you add will start in full-mirror mode automatically"
        >
          <div className={`w-3 h-3 mt-0.5 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
            defaultFullSync ? 'bg-port-accent border-port-accent' : 'border-gray-600 bg-transparent'
          }`}>
            {defaultFullSync && <Check size={8} className="text-white" />}
          </div>
          <Globe size={12} className={`mt-0.5 ${defaultFullSync ? 'text-port-accent' : 'text-gray-500'}`} />
          <div className="flex-1 min-w-0">
            <span className={`text-xs ${defaultFullSync ? 'text-white' : 'text-gray-400'} group-hover:text-gray-300`}>Default new peers to full mirror</span>
            <p className="text-[10px] text-gray-600 leading-snug">Applies to peers added from now on; existing peers are unchanged.</p>
          </div>
        </button>
        {syncStatus?.local && (
          <div className="mt-2 pt-2 border-t border-port-border/50 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-gray-400">
            <span className="flex items-center gap-1.5">
              <Brain size={12} /> Brain seq: {syncStatus.local.brainSeq}
            </span>
            <span className="flex items-center gap-1.5">
              <Database size={12} /> Memory seq: {syncStatus.local.memorySeq}
            </span>
            {SNAPSHOT_CATEGORIES.map(({ key, label, icon: Icon }) => {
                const hasChecksum = !!syncStatus.local.checksums?.[key];
                return (
                  <span key={key} className="flex items-center gap-1.5">
                    <Icon size={12} />
                    <span>{label}:</span>
                    {hasChecksum ? (
                      <CheckCircle2 size={11} className="text-port-success" />
                    ) : (
                      <Clock size={11} className="text-gray-600" />
                    )}
                  </span>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

function AddPeerForm({ onAdd }) {
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('5555');
  const [name, setName] = useState('');
  const [showAuth, setShowAuth] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [adding, setAdding] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!address.trim()) return;
    setAdding(true);
    const data = { address: address.trim(), port: parseInt(port, 10) || 5555 };
    if (name.trim()) data.name = name.trim();
    // Only attach credentials when a password was entered — username alone
    // (or neither) is treated as "no auth" by the server's sanitizer.
    if (password) data.auth = { username: username.trim(), password };
    const result = await addPeer(data).catch(() => null);
    setAdding(false);
    if (!result) return;
    setAddress('');
    setPort('5555');
    setName('');
    setUsername('');
    setPassword('');
    setShowAuth(false);
    onAdd();
    toast.success('Peer added');
  };

  return (
    <form onSubmit={handleSubmit} className="bg-port-card border border-port-border rounded-xl p-5">
      <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3 flex items-center gap-2">
        <Plus size={14} /> Add Peer
      </h3>
      <div className="flex flex-wrap gap-2">
        <input
          value={address}
          onChange={e => setAddress(e.target.value)}
          placeholder="100.64.x.x"
          pattern="^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$"
          required
          className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent flex-1 min-w-[140px]"
        />
        <input
          value={port}
          onChange={e => setPort(e.target.value)}
          placeholder="5554"
          type="number"
          min="1"
          max="65535"
          className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent w-20"
        />
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Name (optional)"
          className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent flex-1 min-w-[120px]"
        />
        <button
          type="submit"
          disabled={adding || !address.trim()}
          className="bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
        >
          {adding ? 'Adding...' : 'Add'}
        </button>
      </div>
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setShowAuth(v => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
        >
          <Lock size={11} />
          {showAuth ? 'Hide credentials' : 'Add credentials (peer behind an auth proxy)'}
        </button>
        {showAuth && (
          <div className="flex flex-wrap gap-2 mt-2">
            <input
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Username (optional)"
              autoComplete="off"
              className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent flex-1 min-w-[120px]"
            />
            <input
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              type="password"
              autoComplete="new-password"
              className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-hidden focus:border-port-accent flex-1 min-w-[120px]"
            />
          </div>
        )}
      </div>
    </form>
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

function SyncStatusBadge({ label, icon: Icon, localSeq, peerSeq, cursorSeq, peerCursorForUs, syncing }) {
  // cursorSeq        = how far we've pulled from them (our cursor for their data)
  // localSeq         = our local max seq for this data type
  // peerSeq          = their max seq for this data type (their sync-status endpoint)
  // peerCursorForUs  = how far THEY've pulled from us (their cursor into our data)
  //
  // Two directions, both in plain language (raw seqs live in the tooltip):
  //   toPull = peerSeq - cursorSeq         (their items we haven't pulled)
  //   toPush = localSeq - peerCursorForUs  (our items they haven't pulled)
  const { toPull, toPush } = directionalCounts({
    localMax: localSeq,
    peerMax: peerSeq,
    ourCursor: cursorSeq,
    peerCursorForUs,
  });
  const { state, text } = describeDirectional({ toPull, toPush });

  // Nothing known at all (no probe yet, no cursor) → render nothing.
  if (peerSeq == null && cursorSeq == null && peerCursorForUs == null && localSeq == null) return null;

  const StateIcon = syncing ? RefreshCw : state === 'synced' ? CheckCircle2 : state === 'behind' ? AlertCircle : Clock;
  const iconClass = syncing
    ? 'text-port-accent animate-spin'
    : state === 'synced' ? 'text-port-success' : state === 'behind' ? 'text-port-warning' : 'text-gray-500';
  const textClass = syncing
    ? 'text-port-accent'
    : state === 'synced' ? 'text-port-success' : state === 'behind' ? 'text-port-warning' : 'text-gray-400';

  // Raw sequences retained for debugging in the tooltip.
  const tooltip = `Pulled ${cursorSeq ?? 0} of their ${peerSeq ?? '?'} · `
    + `they pulled ${peerCursorForUs ?? '?'} of our ${localSeq ?? '?'}`;

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Icon size={12} className="text-gray-500" />
      <span className="text-gray-500">{label}:</span>
      <span className="flex items-center gap-1" title={tooltip}>
        <StateIcon size={11} className={iconClass} />
        <span className={textClass}>{syncing ? 'syncing…' : text}</span>
      </span>
    </div>
  );
}

// Sync category metadata for UI display
const SYNC_CATEGORY_META = [
  { key: 'brain', label: 'Brain', icon: Brain, description: 'People, projects, ideas, admin, memories, links' },
  { key: 'memory', label: 'Memory', icon: Database, description: 'CoS agent memories (PostgreSQL)' },
  { key: 'goals', label: 'Goals', icon: Target, description: 'Life goals, milestones, progress tracking' },
  { key: 'character', label: 'Character', icon: Sword, description: 'XP, HP, level, events, character sheet' },
  { key: 'digitalTwin', label: 'Digital Twin', icon: Fingerprint, description: 'Identity, taste, documents, autobiography, social accounts, personality traits, chronotype, longevity, feedback' },
  { key: 'meatspace', label: 'Meatspace', icon: HeartPulse, description: 'Daily logs, blood tests, body metrics, eyes' },
  { key: 'universe', label: 'Universe', icon: Sparkles, description: 'Universe Builder canon: characters, places, objects' },
  { key: 'pipeline', label: 'Pipeline', icon: Film, description: 'Series + issues record state (no image/video blobs)' },
  { key: 'mediaCollections', label: 'Media Collections', icon: Images, description: 'Per-universe/series image + video buckets' },
  { key: 'videoHistory', label: 'Video History', icon: Film, description: 'Generated-video metadata rows (so synced collection videos render)' },
  { key: 'storyBuilder', label: 'Story Builder', icon: BookOpen, description: 'Resumable Story Builder sessions you marked for cross-machine sync' },
  { key: 'authors', label: 'Authors', icon: FilePen, description: 'Author personas + headshots used as series bylines (PostgreSQL)' },
  { key: 'artists', label: 'Artists', icon: Music, description: 'Music artist personas + portraits (PostgreSQL)' },
  { key: 'albums', label: 'Albums', icon: Disc3, description: 'Music albums + cover art and ordered track lists (PostgreSQL)' },
  { key: 'tracks', label: 'Tracks', icon: Music2, description: 'Music tracks + attached audio files (PostgreSQL)' },
  { key: 'creativeDirectorProjects', label: 'Creative Director', icon: Clapperboard, description: 'Creative Director projects: treatment, scenes, runs (PostgreSQL)' },
  { key: 'moodBoards', label: 'Mood Boards', icon: Palette, description: 'Mood boards: pinned image + text references (PostgreSQL)' },
  { key: 'writersRoomWorks', label: 'Writers Room', icon: BookText, description: 'Writers Room works: manuscripts + draft versions + prose bodies (PostgreSQL)' },
  { key: 'writersRoomFolders', label: 'Writers Room Folders', icon: FolderTree, description: 'Writers Room library folders: names + nesting (PostgreSQL)' },
  { key: 'writersRoomExercises', label: 'Writers Room Sprints', icon: Timer, description: 'Writers Room writing-sprint sessions + appended prose (PostgreSQL)' },
  { key: 'musicVideoProjects', label: 'Music Video', icon: Video, description: 'Music Video projects: director board + beat-aligned scenes (PostgreSQL)' },
  { key: 'catalog', label: 'Catalog', icon: Library, description: 'Creative ingredients catalog: orphan ingredients + ref links (PostgreSQL)' }
];

// Snapshot categories — exclude the per-record / delta-based categories that
// have no 60s snapshot checksum: brain + memory (delta), catalog + authors/music
// (PostgreSQL, per-record peer-push only — no snapshot loop).
const NON_SNAPSHOT_KEYS = new Set(['brain', 'memory', 'catalog', 'authors', 'artists', 'albums', 'tracks', 'creativeDirectorProjects', 'moodBoards', 'writersRoomWorks', 'writersRoomFolders', 'writersRoomExercises', 'musicVideoProjects']);
const SNAPSHOT_CATEGORIES = SYNC_CATEGORY_META.filter(m => !NON_SNAPSHOT_KEYS.has(m.key));

// Indicator backed by REAL coverage diffing (record IDs vs confirmed pushes),
// not the BIGSERIAL cursors — so "fully mirrored" never lies. Refetches on mount
// and whenever `refreshKey` changes; the caller passes peer.lastSeen, so it
// refreshes on each probe tick — cheap for a single-user box and lets the
// "N pending" count tick down live as the initial back-subscribe converges.
function FullSyncCoverageBadge({ peerId, peerInstanceId, refreshKey }) {
  const [coverage, setCoverage] = useState(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!peerInstanceId) { setCoverage(null); setLoaded(true); return; }
    let cancelled = false;
    setLoaded(false);
    getPeerFullSyncCoverage(peerId, { silent: true })
      .then((r) => { if (!cancelled) setCoverage(r); })
      .catch(() => { if (!cancelled) setCoverage(null); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [peerId, peerInstanceId, refreshKey]);

  if (!peerInstanceId) {
    return <span className="text-[10px] text-gray-600">awaiting first connection…</span>;
  }
  if (!loaded || !coverage) {
    return <span className="text-[10px] text-gray-600">checking coverage…</span>;
  }
  if (coverage.fullyMirrored) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-port-success" title={`All ${coverage.total} record(s) confirmed-delivered to this peer`}>
        <CheckCircle2 size={11} /> Fully mirrored · {coverage.total} record{coverage.total !== 1 ? 's' : ''}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[10px] text-port-warning" title={`${coverage.pending} of ${coverage.total} record(s) not yet confirmed-delivered`}>
      <Clock size={11} /> {coverage.pending} pending · {coverage.confirmed}/{coverage.total} mirrored
    </span>
  );
}

function SyncCategoriesPanel({ peer, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const categories = peer.syncCategories || {};
  const fullSync = peer.fullSync === true;
  // A full-sync peer mirrors every category — present them as locked-on.
  const enabledCount = fullSync ? SYNC_CATEGORY_META.length : Object.values(categories).filter(Boolean).length;

  const toggleFullSync = async () => {
    await updatePeer(peer.id, { fullSync: !fullSync }).catch(() => null);
    onRefresh();
  };

  const toggleCategory = async (key) => {
    if (fullSync) return; // categories are locked-on under full mirror
    const newValue = !categories[key];
    const anyCatEnabled = Object.values({ ...categories, [key]: newValue }).some(Boolean);
    await updatePeer(peer.id, {
      syncCategories: { [key]: newValue },
      syncEnabled: anyCatEnabled
    }).catch(() => null);
    onRefresh();
  };

  const toggleAll = async (enable) => {
    const updated = {};
    for (const { key } of SYNC_CATEGORY_META) {
      updated[key] = enable;
    }
    await updatePeer(peer.id, {
      syncCategories: updated,
      syncEnabled: enable
    }).catch(() => null);
    onRefresh();
  };

  // Explicitly push our current category map to the peer so it enables the same
  // toward us. Toggling already auto-reciprocates; this is the catch-up button
  // for peers configured one-directionally before auto-reciprocate existed, or
  // when the peer was offline during an earlier toggle.
  const makeMutual = async () => {
    const result = await reciprocatePeer(peer.id, { silent: true }).catch(() => null);
    if (result?.ok) toast.success(`Asked ${peer.name} to sync the same categories back`);
    else toast.error(`Couldn't reach ${peer.name} to make sync mutual — try again when it's online`);
    onRefresh();
  };

  return (
    <div className="mt-2 pt-2 border-t border-port-border/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full text-left group"
      >
        {expanded ? <ChevronDown size={12} className="text-gray-500" /> : <ChevronRight size={12} className="text-gray-500" />}
        <RefreshCcw size={12} className={enabledCount > 0 ? 'text-port-accent' : 'text-gray-500'} />
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium group-hover:text-gray-400 transition-colors">
          Sync Categories
        </span>
        <span className={`text-[10px] ml-auto ${enabledCount > 0 ? 'text-port-accent' : 'text-gray-600'}`}>
          {enabledCount}/{SYNC_CATEGORY_META.length}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          {/* Full mirror toggle — when on, every current + future category is
              implied and all subscribable records back-subscribe to this peer. */}
          <button
            onClick={toggleFullSync}
            className={`flex items-start gap-2 w-full px-2 py-1.5 rounded border transition-colors text-left mb-1.5 ${
              fullSync ? 'border-port-accent/60 bg-port-accent/10' : 'border-port-border hover:bg-port-bg/50'
            }`}
          >
            <div className={`w-3 h-3 mt-0.5 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
              fullSync ? 'bg-port-accent border-port-accent' : 'border-gray-600 bg-transparent'
            }`}>
              {fullSync && <Check size={8} className="text-white" />}
            </div>
            <Globe size={12} className={`mt-0.5 ${fullSync ? 'text-port-accent' : 'text-gray-500'}`} />
            <div className="flex-1 min-w-0">
              <span className={`text-xs font-medium ${fullSync ? 'text-white' : 'text-gray-300'}`}>Full mirror</span>
              <p className="text-[10px] text-gray-600 leading-snug">
                Mirror everything to {peer.name || 'this peer'} — every category, all existing
                records, and any new category added in a future version. Reciprocated automatically.
              </p>
              {fullSync && (
                <div className="mt-1">
                  <FullSyncCoverageBadge peerId={peer.id} peerInstanceId={peer.instanceId} refreshKey={peer.lastSeen} />
                </div>
              )}
            </div>
          </button>
          <p className="text-[10px] text-gray-600 mb-1.5 leading-snug">
            {fullSync
              ? 'Categories are locked on while full mirror is enabled. Turn it off to choose categories individually.'
              : <>Enabling a category syncs it both ways — we ask {peer.name || 'the peer'} to sync the same back automatically.</>}
          </p>
          <div className="flex items-center justify-end gap-2 mb-1.5">
            {/* Available whenever we know the peer's identity — NOT gated on
                enabledCount. The worst stale case is disabling the LAST category
                while the peer is offline: the peer keeps its now-stale enabled
                set, and the reciprocate endpoint pushes our all-false map to
                clear it. Gating on enabledCount>0 would hide the control exactly
                when it's needed. */}
            {peer.instanceId && (
              <button
                onClick={makeMutual}
                className="flex items-center gap-1 mr-auto text-[10px] text-gray-500 hover:text-port-accent transition-colors"
                title="Push the current categories to this peer so it syncs them back (use if it was offline during a change)"
              >
                <ArrowLeftRight size={10} />
                Make mutual
              </button>
            )}
            {/* Enable/Disable-all are moot under full mirror (categories locked on). */}
            {!fullSync && (
              <>
                <button
                  onClick={() => toggleAll(true)}
                  className="text-[10px] text-port-accent hover:text-port-accent/80 transition-colors"
                >
                  Enable all
                </button>
                <button
                  onClick={() => toggleAll(false)}
                  className="text-[10px] text-gray-500 hover:text-gray-400 transition-colors"
                >
                  Disable all
                </button>
              </>
            )}
          </div>
          {SYNC_CATEGORY_META.map(({ key, label, icon: Icon, description }) => {
            // Under full mirror every category reads as on and is non-interactive.
            const on = fullSync || categories[key];
            return (
            <button
              key={key}
              onClick={() => toggleCategory(key)}
              disabled={fullSync}
              title={fullSync ? 'Locked on by full mirror' : undefined}
              className={`flex items-center gap-2 w-full px-2 py-1.5 rounded text-left transition-colors ${fullSync ? 'opacity-70 cursor-default' : 'hover:bg-port-bg/50'}`}
            >
              <div className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
                on
                  ? 'bg-port-accent border-port-accent'
                  : 'border-gray-600 bg-transparent'
              }`}>
                {on && (fullSync ? <Lock size={7} className="text-white" /> : <Check size={8} className="text-white" />)}
              </div>
              <Icon size={12} className={on ? 'text-port-accent' : 'text-gray-500'} />
              <div className="flex-1 min-w-0">
                <span className={`text-xs ${on ? 'text-white' : 'text-gray-400'}`}>{label}</span>
                <p className="text-[10px] text-gray-600 truncate">{description}</p>
              </div>
            </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SnapshotSyncBadge({ label, icon: Icon, cursorChecksum, remoteChecksum, livePushCovered, subsLoaded = true, syncing = false }) {
  // `livePushCovered` is true when this peer has at least one per-record
  // peer-sync subscription for a record kind that maps to this category
  // (universe-subs → 'universe', series-subs → 'pipeline'). The orchestrator
  // intentionally SKIPS the 60s snapshot loop for those categories — the push
  // pipeline is authoritative — so cursor.checksums[cat] stays frozen at
  // whatever it was when peer-subs took over and the cursor-vs-remote diff
  // would always read "behind" even when the records are actually converged.
  // Render a distinct "live-push" state instead so the badge stops lying.
  const synced = cursorChecksum && remoteChecksum && cursorChecksum === remoteChecksum;
  // Suppress "behind" until peer subs have loaded — `livePushCovered` is derived
  // from them, so before they resolve a live-push category would briefly mislabel
  // itself "behind". Until then it falls through to the neutral "pending" state.
  const behind = subsLoaded && cursorChecksum && remoteChecksum && cursorChecksum !== remoteChecksum;

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <Icon size={12} className="text-gray-500" />
      <span className="text-gray-500">{label}:</span>
      {syncing ? (
        <>
          <RefreshCw size={11} className="text-port-accent animate-spin" />
          <span className="text-port-accent">syncing…</span>
        </>
      ) : livePushCovered ? (
        <>
          <ArrowLeftRight size={11} className="text-port-accent" />
          <span className="text-port-accent" title="Per-record push pipeline owns this category; snapshot cursor is intentionally stale">
            live-push
          </span>
        </>
      ) : synced ? (
        <>
          <CheckCircle2 size={11} className="text-port-success" />
          <span className="text-port-success">synced</span>
        </>
      ) : behind ? (
        <>
          <AlertCircle size={11} className="text-port-warning" />
          <span className="text-port-warning">behind</span>
        </>
      ) : (
        <>
          <Clock size={11} className="text-gray-500" />
          <span className="text-gray-400">pending</span>
        </>
      )}
    </div>
  );
}

function SyncStatusSection({ peer, syncStatus, peerSubs = [], peerSubsLoaded = true, syncing = false }) {
  if (!syncStatus || !peer.instanceId) return null;

  const cursor = syncStatus.cursors?.[peer.instanceId];
  const remoteSyncSeqs = peer.remoteSyncSeqs;
  // A full-sync peer mirrors every category, so the snapshot sync status should
  // surface them all on (its stored syncCategories map can be all-false
  // underneath). Mirror the server's allSyncCategoriesOn semantics here.
  const categories = peer.fullSync === true
    ? Object.fromEntries(SYNC_CATEGORY_META.map(m => [m.key, true]))
    : (peer.syncCategories || {});
  // The peer's cursor into OUR data (how far it has pulled from us) — the
  // push-frontier toward this peer. Present only when our probe passed `forPeer`
  // and the peer is new enough to report it; absent → push count is "unknown".
  const peerCursorForUs = remoteSyncSeqs?.cursorForYou ?? null;

  // No sync data available at all
  if (!cursor && !remoteSyncSeqs) return null;

  // Only show delta-based status for enabled categories
  const showBrain = categories.brain;
  const showMemory = categories.memory;

  // Show snapshot category sync status for all enabled snapshot categories
  const cursorChecksums = cursor?.checksums || {};
  const remoteChecksums = remoteSyncSeqs?.checksums || {};

  // Derive the set of snapshot categories that are "covered" by the
  // per-record peer-sync push pipeline. Mirrors the inverse mapping in
  // `server/services/sharing/peerSync.js` KIND_TO_CATEGORY — universe-subs
  // cover 'universe', series-subs cover 'pipeline' (which bundles series +
  // issues). The orchestrator skips snapshot pulls for these, so the
  // cursor checksum stays stale and the cursor-vs-remote diff is a lie.
  // Render those categories as "live-push" instead.
  const livePushCovered = new Set();
  for (const s of peerSubs) {
    if (s.recordKind === 'universe') livePushCovered.add('universe');
    if (s.recordKind === 'series') livePushCovered.add('pipeline');
  }

  const enabledSnapshots = SNAPSHOT_CATEGORIES
    .map(m => m.key)
    .filter(cat => categories[cat]);

  if (!showBrain && !showMemory && enabledSnapshots.length === 0) return null;

  return (
    <div className="mt-2 pt-2 border-t border-port-border/50">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Database size={12} className="text-gray-500" />
        <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Sync Status</span>
        {cursor?.lastSyncAt && (
          <span className="text-[10px] text-gray-600 ml-auto">{timeAgo(cursor.lastSyncAt)}</span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {showBrain && (
          <SyncStatusBadge
            label="Brain"
            icon={Brain}
            localSeq={syncStatus.local?.brainSeq}
            peerSeq={remoteSyncSeqs?.brainSeq}
            cursorSeq={cursor?.brainSeq}
            peerCursorForUs={peerCursorForUs?.brainSeq}
            syncing={syncing}
          />
        )}
        {showMemory && (
          <SyncStatusBadge
            label="Memory"
            icon={Database}
            localSeq={syncStatus.local?.memorySeq}
            peerSeq={remoteSyncSeqs?.memorySeq}
            cursorSeq={cursor?.memorySeq}
            peerCursorForUs={peerCursorForUs?.memorySeq}
            syncing={syncing}
          />
        )}
        {enabledSnapshots.map(cat => {
          const meta = SYNC_CATEGORY_META.find(m => m.key === cat);
          if (!meta) return null;
          return (
            <SnapshotSyncBadge
              key={cat}
              label={meta.label}
              icon={meta.icon}
              cursorChecksum={cursorChecksums[cat]}
              remoteChecksum={remoteChecksums[cat]}
              livePushCovered={livePushCovered.has(cat)}
              subsLoaded={peerSubsLoaded}
              syncing={syncing}
            />
          );
        })}
      </div>
    </div>
  );
}

function PeerHostEditor({ peer, onRefresh, tailnetInfo }) {
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
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
          placeholder="host.tailnet.ts.net (empty to clear)"
          className="bg-port-bg border border-port-border rounded px-2 py-0.5 text-xs text-white font-mono focus:outline-hidden focus:border-port-accent flex-1 min-w-[180px]"
          autoFocus
        />
        <button onClick={save} disabled={saving} aria-label="Save name" className="text-port-success hover:text-port-success/80 disabled:opacity-50"><Check size={14} /></button>
        <button onClick={() => setEditing(false)} aria-label="Cancel" className="text-gray-500 hover:text-white"><X size={14} /></button>
        {suggestion && suggestion !== value && (
          <button
            onClick={applySuggestion}
            className="text-[10px] text-port-accent hover:text-port-accent/80 underline"
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
        className="text-[10px] text-gray-500 hover:text-white underline"
        title={suggestion ? `Auto-detected: ${suggestion}` : 'Set a Tailscale DNS name for HTTPS'}
      >
        {peer.host ? 'edit' : (suggestion ? `use ${suggestion}` : 'set DNS')}
      </button>
      {peer.host && (
        <button
          onClick={clearHost}
          disabled={saving}
          className="text-[10px] text-gray-500 hover:text-white underline disabled:opacity-50"
          title="Switch this hop back to http://<ip>"
        >
          use IP only
        </button>
      )}
    </div>
  );
}

function PeerAuthEditor({ peer, onRefresh }) {
  const [editing, setEditing] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const hasAuth = !!peer.auth;

  const startEdit = () => {
    // Prefill the (non-secret) username; the password is never sent to the
    // browser (server redacts it to a hasPassword marker), so it must be
    // re-entered to save — saving replaces the whole credential server-side.
    setUsername(peer.auth?.username || '');
    setPassword('');
    setEditing(true);
  };

  const save = async () => {
    if (!password) return; // a password is required to store a credential
    setSaving(true);
    const result = await updatePeer(peer.id, { auth: { username: username.trim(), password } }).catch(() => null);
    setSaving(false);
    if (!result) return;
    onRefresh();
    setEditing(false);
    toast.success('Peer credential saved');
  };

  const clear = async () => {
    setSaving(true);
    const result = await updatePeer(peer.id, { auth: null }).catch(() => null);
    setSaving(false);
    if (!result) return;
    onRefresh();
    setEditing(false);
    toast.success('Peer credential cleared');
  };

  if (editing) {
    return (
      <div className="mt-1 flex items-center gap-1 flex-wrap">
        <input
          value={username}
          onChange={e => setUsername(e.target.value)}
          placeholder="user (optional)"
          autoComplete="off"
          className="bg-port-bg border border-port-border rounded px-2 py-0.5 text-xs text-white focus:outline-hidden focus:border-port-accent w-28"
        />
        <input
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && save()}
          placeholder={hasAuth ? 're-enter password to update' : 'password'}
          type="password"
          autoComplete="new-password"
          className="bg-port-bg border border-port-border rounded px-2 py-0.5 text-xs text-white focus:outline-hidden focus:border-port-accent flex-1 min-w-[120px]"
          autoFocus
        />
        <button onClick={save} disabled={saving || !password} aria-label="Save name" className="text-port-success hover:text-port-success/80 disabled:opacity-50"><Check size={14} /></button>
        <button onClick={() => setEditing(false)} aria-label="Cancel" className="text-gray-500 hover:text-white"><X size={14} /></button>
        {hasAuth && (
          <button onClick={clear} disabled={saving} className="text-[10px] text-gray-500 hover:text-port-error underline disabled:opacity-50">remove</button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
      {hasAuth ? (
        <Pill tone="success" size="xs" bordered={false} icon={Lock} title="Outbound requests to this peer send an HTTP Basic credential">
          credential set{peer.auth?.username ? ` · ${peer.auth.username}` : ''}
        </Pill>
      ) : peer.authRequired ? (
        <Pill tone="warning" size="xs" bordered={false} icon={Lock} title="Peer returned 401/403 — it's behind an auth proxy and needs a credential">
          auth required
        </Pill>
      ) : null}
      <button
        onClick={startEdit}
        className={`text-[10px] underline ${peer.authRequired && !hasAuth ? 'text-port-warning hover:text-port-warning/80' : 'text-gray-500 hover:text-white'}`}
        title="Set an HTTP Basic username/password for a peer behind an auth proxy"
      >
        {hasAuth ? 'edit credential' : 'set credential'}
      </button>
    </div>
  );
}

function PeerCard({ peer, onRefresh, syncStatus, tailnetInfo }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');
  const [probing, setProbing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Peer subs are loaded once at this level and shared with SchemaGapBadge and
  // SyncStatusSection (which uses the sub set to decide which snapshot badges
  // render as "live-push" instead of a misleading "behind"). Without sharing,
  // every card would issue duplicate /sharing/peer-subs fetches. (The verbose
  // per-record "Live-pushed records" list that used to render these was removed
  // — it grew unbounded and the Sync Details drawer covers per-record status.)
  const [peerSubs, setPeerSubs] = useState([]);
  // Track whether the first subs fetch has settled — until it has, `peerSubs`
  // is [] and SyncStatusSection can't tell a live-push category from a behind
  // one, so it would flash "behind". Gates the snapshot badges' "behind" state.
  const [peerSubsLoaded, setPeerSubsLoaded] = useState(false);
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
        if (payload.totalApplied > 0) onRefresh();
      }
      // `applied` events are informational (and drive the server-side log) —
      // the global `syncing` flag already animates every badge, so the client
      // needn't track per-category granularity.
    };
    socket.on('sync:progress', handleProgress);
    return () => socket.off('sync:progress', handleProgress);
  }, [peer.instanceId, onRefresh]);

  useEffect(() => {
    if (!peer.instanceId) {
      setPeerSubs([]);
      setPeerSubsLoaded(true); // no instanceId → nothing to load; don't suppress forever
      return;
    }
    // instanceId just became available or changed — re-suppress "behind" until
    // this peer's first fetch settles, otherwise the stale [] would mislabel a
    // live-push category. Cleared in the .finally() below.
    setPeerSubsLoaded(false);
    let cancelled = false;
    const refetch = () => listPeerSubscriptions({ peerId: peer.instanceId }, { silent: true })
      .then((r) => {
        if (!cancelled) setPeerSubs(r?.subscriptions || []);
      })
      .catch(() => {
        if (!cancelled) setPeerSubs([]);
      })
      .finally(() => {
        if (!cancelled) setPeerSubsLoaded(true);
      });
    refetch();
    // When a per-record schema block is persisted server-side, the
    // subscription's `blockedBySchema` field changes inside
    // peer_subscriptions.json. The parent Instances component already
    // refetches `peers` on this event, but its refresh doesn't re-run this
    // card's `peerSubs` effect (deps are `peer.instanceId` only). Without
    // a local subscription here, SchemaGapBadge keeps rendering the stale
    // `blockedBySchema` value until a full page reload.
    // The event carries `peerId` so only the affected card refetches —
    // every card listens, but skips events for other peers.
    const handleSchemaSubChange = (payload) => {
      if (payload?.peerId && payload.peerId !== peer.instanceId) return;
      refetch();
    };
    socket.on('peerSync:subscription-blocked', handleSchemaSubChange);
    socket.on('peerSync:subscription-unblocked', handleSchemaSubChange);
    // An incoming push from this peer auto-created a reverse subscription
    // back to it (`maybeCreateReverseSubscription`). The new row lives in
    // peer_subscriptions.json but this card cached `peerSubs` on mount, so
    // refetch this peer's subs to surface the adopted-from-reverse sub
    // without a manual page reload. Carries `peerId`, so the same filter
    // keeps every other card from refetching needlessly.
    socket.on('peerSync:subscription:created', handleSchemaSubChange);
    return () => {
      cancelled = true;
      socket.off('peerSync:subscription-blocked', handleSchemaSubChange);
      socket.off('peerSync:subscription-unblocked', handleSchemaSubChange);
      socket.off('peerSync:subscription:created', handleSchemaSubChange);
    };
  }, [peer.instanceId]);

  const StatusIcon = STATUS_ICONS[peer.status] || CircleDot;
  const isInboundOnly = peer.directions?.includes('inbound') && !peer.directions?.includes('outbound');

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
    await probePeer(peer.id).catch(() => null);
    onRefresh();
    setProbing(false);
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

  return (
    <div className={`bg-port-card border border-port-border rounded-xl p-5 transition-opacity ${!peer.enabled ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <StatusIcon size={16} className={STATUS_COLORS[peer.status]} />
          {editingName ? (
            <div className="flex items-center gap-1">
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && saveName()}
                className="bg-port-bg border border-port-border rounded px-2 py-0.5 text-sm text-white focus:outline-hidden focus:border-port-accent w-32"
                autoFocus
              />
              <button onClick={saveName} aria-label="Save name" className="text-port-success hover:text-port-success/80"><Check size={14} /></button>
              <button onClick={() => setEditingName(false)} aria-label="Cancel" className="text-gray-500 hover:text-white"><X size={14} /></button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-white font-medium">{peer.name}</span>
              <button onClick={() => { setName(peer.name); setEditingName(true); }} aria-label="Edit" className="text-gray-600 hover:text-white">
                <Edit3 size={12} />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleSync}
            disabled={syncing || peer.status !== 'online'}
            className="p-1.5 text-gray-500 hover:text-port-accent transition-colors disabled:opacity-40 disabled:hover:text-gray-500"
            title={peer.status === 'online' ? 'Sync now' : 'Peer offline — cannot sync'}
            aria-label={peer.status === 'online' ? 'Sync now' : 'Peer offline — cannot sync'}
          >
            <RefreshCcw size={14} className={syncing ? 'animate-spin text-port-accent' : ''} />
          </button>
          <button
            onClick={handleProbe}
            disabled={probing}
            className="p-1.5 text-gray-500 hover:text-white transition-colors disabled:opacity-50"
            title="Probe now"
          >
            <RefreshCw size={14} className={probing ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handleToggle}
            className={`p-1.5 transition-colors text-xs font-mono ${peer.enabled ? 'text-port-success hover:text-port-success/80' : 'text-gray-600 hover:text-white'}`}
            title={peer.enabled ? 'Disable polling' : 'Enable polling'}
          >
            {peer.enabled ? 'ON' : 'OFF'}
          </button>
          {confirmRemove ? (
            <div className="flex items-center gap-1">
              <button onClick={handleRemove} className="text-port-error hover:text-port-error/80 text-xs">Yes</button>
              <button onClick={() => setConfirmRemove(false)} className="text-gray-500 hover:text-white text-xs">No</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              className="p-1.5 text-gray-600 hover:text-port-error transition-colors"
              title="Remove peer"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-xs text-gray-500 font-mono">{peer.address}:{peer.port}</p>
          <DirectionBadge directions={peer.directions} />
          {isInboundOnly && (
            <button
              onClick={handleConnect}
              disabled={connecting}
              className="inline-flex items-center gap-1 text-[10px] text-port-accent bg-port-accent/10 hover:bg-port-accent/20 rounded px-1.5 py-0.5 transition-colors disabled:opacity-50"
              title="Connect back to make this mutual"
            >
              <ArrowLeftRight size={10} />
              {connecting ? 'Connecting...' : 'Connect'}
            </button>
          )}
        </div>
        <PeerHostEditor peer={peer} onRefresh={onRefresh} tailnetInfo={tailnetInfo} />
        <PeerAuthEditor peer={peer} onRefresh={onRefresh} />
      </div>

      <HealthSummary health={peer.lastHealth} version={peer.version} />

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

      <SyncCategoriesPanel peer={peer} onRefresh={onRefresh} />

      <SyncStatusSection peer={peer} syncStatus={syncStatus} peerSubs={peerSubs} peerSubsLoaded={peerSubsLoaded} syncing={syncing} />

      <PeerAppsList apps={peer.lastApps} peerAddress={peer.address} peerHost={peer.host} />
      {peer.status === 'online' && (
        <PeerAgentsSection peerId={peer.id} peerName={peer.name} />
      )}
    </div>
  );
}

export default function Instances() {
  const [self, setSelf] = useState(null);
  const [peers, setPeers] = useState([]);
  const [syncStatus, setSyncStatus] = useState(null);
  const [tailnetInfo, setTailnetInfo] = useState(null);
  const [networkExposure, setNetworkExposure] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const data = await getInstances().catch(() => null);
    if (data) {
      setSelf(data.self);
      setPeers(data.peers);
      setSyncStatus(data.syncStatus ?? null);
    }
  }, []);

  useEffect(() => {
    // Kick off these reads in parallel — the tailnet map and exposure snapshot
    // are independent of peer state, and fetching them sequentially added
    // ~100-500ms to first paint on machines where `tailscale status --json`
    // is slow to respond.
    Promise.all([
      fetchData(),
      getTailnetInfo().then(setTailnetInfo).catch(() => setTailnetInfo(null)),
      getNetworkExposure({ silent: true }).then(setNetworkExposure).catch(() => setNetworkExposure(null))
    ]).finally(() => setLoading(false));

    socket.emit('instances:subscribe');
    const handlePeersUpdated = (updatedPeers) => {
      setPeers(updatedPeers);
    };
    socket.on('instances:peers:updated', handlePeersUpdated);
    // NOTE: `peerSync:subscription-blocked/unblocked` is intentionally NOT
    // handled here. Those events only mutate per-record subscription state
    // (`blockedBySchema`), which each PeerCard refetches for its own peer via
    // its peerSubs effect. A page-level fetchData() on every such event would
    // refetch all peers + syncStatus for a change that touches only one card.

    return () => {
      socket.emit('instances:unsubscribe');
      socket.off('instances:peers:updated', handlePeersUpdated);
    };
  }, [fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading instances...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Network size={24} className="text-port-accent" />
        <h1 className="text-2xl font-bold text-white">Instances</h1>
        <span className="text-sm text-gray-500">PortOS Federation</span>
      </div>

      <TailnetHelpBanner tailnetInfo={tailnetInfo} networkExposure={networkExposure} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SelfCard self={self} onUpdate={fetchData} syncStatus={syncStatus} tailnetInfo={tailnetInfo} />
        <AddPeerForm onAdd={fetchData} />
      </div>

      {peers.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
            Peers ({peers.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {peers.map(peer => (
              <PeerCard key={peer.id} peer={peer} onRefresh={fetchData} syncStatus={syncStatus} tailnetInfo={tailnetInfo} />
            ))}
          </div>
        </div>
      )}

      {peers.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <Network size={48} className="mx-auto mb-4 opacity-30" />
          <p>No peers registered yet.</p>
          <p className="text-sm mt-1">Add a Tailscale IP address to connect to another PortOS instance.</p>
        </div>
      )}
    </div>
  );
}
