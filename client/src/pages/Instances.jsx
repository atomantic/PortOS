import { useState, useEffect, useCallback } from 'react';
import {
  Network, Plus, Trash2, RefreshCw, Edit3, Check, X,
  Wifi, WifiOff, CircleDot, ChevronDown, ChevronRight,
  Cpu, HardDrive, Activity, Bot, MonitorSmartphone, Search
} from 'lucide-react';
import toast from 'react-hot-toast';
import socket from '../services/socket';
import {
  getInstances, updateSelfInstance, addPeer, updatePeer,
  removePeer, probePeer, queryPeer
} from '../services/api';

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

const QUERY_PRESETS = [
  { label: 'Health', path: '/api/health/system' },
  { label: 'Apps', path: '/api/apps' },
  { label: 'CoS Status', path: '/api/cos/status' },
  { label: 'Processes', path: '/api/health' }
];

function formatBytes(bytes) {
  if (!bytes) return '—';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}

function timeAgo(iso) {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function HealthSummary({ health }) {
  if (!health) return <span className="text-gray-500 text-xs">No data</span>;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
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

function SelfCard({ self, onUpdate }) {
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
    onUpdate();
    setEditing(false);
    toast.success('Instance name updated');
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
                className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-port-accent"
                autoFocus
              />
              <button onClick={saveName} className="text-port-success hover:text-port-success/80">
                <Check size={16} />
              </button>
              <button onClick={() => setEditing(false)} className="text-gray-500 hover:text-white">
                <X size={16} />
              </button>
            </div>
          ) : (
            <>
              <span className="text-white font-semibold text-lg">{self.name}</span>
              <button onClick={startEdit} className="text-gray-500 hover:text-white">
                <Edit3 size={14} />
              </button>
            </>
          )}
        </div>
        <p className="text-xs text-gray-500 font-mono">{self.instanceId}</p>
      </div>
    </div>
  );
}

function AddPeerForm({ onAdd }) {
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('5554');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!address.trim()) return;
    setAdding(true);
    const data = { address: address.trim(), port: parseInt(port, 10) || 5554 };
    if (name.trim()) data.name = name.trim();
    const result = await addPeer(data).catch(() => null);
    setAdding(false);
    if (!result) return;
    setAddress('');
    setPort('5554');
    setName('');
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
          className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent flex-1 min-w-[140px]"
        />
        <input
          value={port}
          onChange={e => setPort(e.target.value)}
          placeholder="5554"
          type="number"
          min="1"
          max="65535"
          className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent w-20"
        />
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Name (optional)"
          className="bg-port-bg border border-port-border rounded px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent flex-1 min-w-[120px]"
        />
        <button
          type="submit"
          disabled={adding || !address.trim()}
          className="bg-port-accent hover:bg-port-accent/80 disabled:opacity-50 text-white px-4 py-2 rounded text-sm font-medium transition-colors"
        >
          {adding ? 'Adding...' : 'Add'}
        </button>
      </div>
    </form>
  );
}

function QueryPanel({ peerId }) {
  const [expanded, setExpanded] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [customPath, setCustomPath] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const runQuery = async () => {
    const path = customPath.trim() || QUERY_PRESETS[selectedPreset].path;
    if (!path.startsWith('/api/')) {
      toast.error('Path must start with /api/');
      return;
    }
    setLoading(true);
    setResult(null);
    const data = await queryPeer(peerId, path).catch(err => ({ _error: err.message }));
    setResult(data);
    setLoading(false);
  };

  return (
    <div className="mt-3 border-t border-port-border pt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors"
      >
        <Search size={12} />
        <span>Query</span>
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <select
              value={selectedPreset}
              onChange={e => { setSelectedPreset(Number(e.target.value)); setCustomPath(''); }}
              className="bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-port-accent"
            >
              {QUERY_PRESETS.map((p, i) => (
                <option key={i} value={i}>{p.label}</option>
              ))}
            </select>
            <input
              value={customPath}
              onChange={e => setCustomPath(e.target.value)}
              placeholder="or custom /api/..."
              className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1 text-xs text-white placeholder-gray-600 focus:outline-none focus:border-port-accent"
            />
            <button
              onClick={runQuery}
              disabled={loading}
              className="bg-port-accent/20 hover:bg-port-accent/30 text-port-accent px-2 py-1 rounded text-xs transition-colors disabled:opacity-50"
            >
              {loading ? '...' : 'Run'}
            </button>
          </div>
          {result && (
            <pre className="bg-port-bg rounded p-2 text-xs text-gray-300 overflow-auto max-h-64 whitespace-pre-wrap">
              {result._error
                ? <span className="text-port-error">{result._error}</span>
                : JSON.stringify(result, null, 2)
              }
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function PeerCard({ peer, onRefresh }) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState('');
  const [probing, setProbing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const StatusIcon = STATUS_ICONS[peer.status] || CircleDot;

  const handleProbe = async () => {
    setProbing(true);
    await probePeer(peer.id).catch(() => null);
    onRefresh();
    setProbing(false);
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
                className="bg-port-bg border border-port-border rounded px-2 py-0.5 text-sm text-white focus:outline-none focus:border-port-accent w-32"
                autoFocus
              />
              <button onClick={saveName} className="text-port-success hover:text-port-success/80"><Check size={14} /></button>
              <button onClick={() => setEditingName(false)} className="text-gray-500 hover:text-white"><X size={14} /></button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="text-white font-medium">{peer.name}</span>
              <button onClick={() => { setName(peer.name); setEditingName(true); }} className="text-gray-600 hover:text-white">
                <Edit3 size={12} />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
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

      <p className="text-xs text-gray-500 font-mono mb-3">{peer.address}:{peer.port}</p>

      <HealthSummary health={peer.lastHealth} />

      <div className="mt-2 text-xs text-gray-600">
        Last seen: {timeAgo(peer.lastSeen)}
      </div>

      <QueryPanel peerId={peer.id} />
    </div>
  );
}

export default function Instances() {
  const [self, setSelf] = useState(null);
  const [peers, setPeers] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const data = await getInstances().catch(() => null);
    if (data) {
      setSelf(data.self);
      setPeers(data.peers);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();

    socket.emit('instances:subscribe');
    socket.on('instances:peers:updated', (updatedPeers) => {
      setPeers(updatedPeers);
    });

    return () => {
      socket.emit('instances:unsubscribe');
      socket.off('instances:peers:updated');
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SelfCard self={self} onUpdate={fetchData} />
        <AddPeerForm onAdd={fetchData} />
      </div>

      {peers.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wider mb-3">
            Peers ({peers.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {peers.map(peer => (
              <PeerCard key={peer.id} peer={peer} onRefresh={fetchData} />
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
