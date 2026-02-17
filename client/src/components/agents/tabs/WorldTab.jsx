import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import * as api from '../../../services/api';
import BrailleSpinner from '../../BrailleSpinner';
import socket from '../../../services/socket';
import useMoltworldWs from '../../../hooks/useMoltworldWs';

const EVENT_ICONS = {
  status: '🔌',
  presence: '👥',
  thinking: '💭',
  thought: '💭',
  action: '🎬',
  move: '🚶',
  build: '🧱',
  interaction: '💬',
  message: '💬',
  say: '💬',
  nearby: '📡',
  hello_ack: '👋',
  welcome: '👋',
  event: '📨'
};

const HISTORY_ACTION_ICONS = {
  mw_explore: '🌍',
  mw_build: '🧱',
  mw_think: '💭',
  mw_say: '💬',
  mw_heartbeat: '💓',
  mw_interact: '🤝'
};

const HISTORY_FILTERS = [
  { value: '', label: 'All' },
  { value: 'mw_explore', label: 'Explore' },
  { value: 'mw_think', label: 'Think' },
  { value: 'mw_say', label: 'Say' },
  { value: 'mw_build', label: 'Build' },
  { value: 'mw_heartbeat', label: 'Heartbeat' }
];

const QUEUE_ACTION_TYPES = [
  { value: 'mw_explore', label: 'Explore' },
  { value: 'mw_think', label: 'Think' },
  { value: 'mw_build', label: 'Build' },
  { value: 'mw_say', label: 'Say' }
];

const QUEUE_STATUS_STYLES = {
  pending: 'bg-gray-600/20 text-gray-400',
  executing: 'bg-port-accent/20 text-port-accent animate-pulse',
  completed: 'bg-port-success/20 text-port-success',
  failed: 'bg-port-error/20 text-port-error'
};

function formatEventTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelativeTime(ts) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function summarizeParams(action, params) {
  if (!params) return '';
  if (action === 'mw_explore' || action === 'mw_heartbeat') {
    const parts = [];
    if (params.x != null && params.y != null) parts.push(`(${params.x}, ${params.y})`);
    if (params.thinking) parts.push(`"${params.thinking.substring(0, 40)}..."`);
    return parts.join(' ');
  }
  if (action === 'mw_think') return params.thought ? `"${params.thought.substring(0, 50)}"` : '';
  if (action === 'mw_say') return params.message ? `"${params.message.substring(0, 50)}"` : '';
  if (action === 'mw_build') return `(${params.x},${params.y},${params.z}) ${params.type || 'stone'} ${params.action || 'place'}`;
  return '';
}

export default function WorldTab({ agentId }) {
  const [accountId, setAccountId] = useState(null);
  const [accountName, setAccountName] = useState('');
  const [rateLimits, setRateLimits] = useState(null);
  const [loading, setLoading] = useState(true);

  // Status state
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);

  // Nearby agents + messages from last join/explore
  const [nearby, setNearby] = useState([]);
  const [messages, setMessages] = useState([]);

  // Move/Explore state
  const [moveX, setMoveX] = useState('');
  const [moveY, setMoveY] = useState('');
  const [moveThinking, setMoveThinking] = useState('');
  const [moving, setMoving] = useState(false);

  // Think state
  const [thought, setThought] = useState('');
  const [thinking, setThinking] = useState(false);

  // Build state
  const [buildX, setBuildX] = useState('');
  const [buildY, setBuildY] = useState('');
  const [buildZ, setBuildZ] = useState('0');
  const [blockType, setBlockType] = useState('stone');
  const [buildAction, setBuildAction] = useState('place');
  const [building, setBuilding] = useState(false);

  // Say state
  const [sayMessage, setSayMessage] = useState('');
  const [sayTo, setSayTo] = useState('');
  const [saying, setSaying] = useState(false);

  // Cooldown timer state
  const [cooldownEnds, setCooldownEnds] = useState({});
  const [, setTick] = useState(0);

  // Activity History state
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyFilter, setHistoryFilter] = useState('');

  // Action Queue state
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newActionType, setNewActionType] = useState('mw_explore');
  const [newActionParams, setNewActionParams] = useState({});

  // WebSocket hook
  const {
    connectionStatus,
    feedItems,
    presence,
    connect: wsConnect,
    disconnect: wsDisconnect
  } = useMoltworldWs();

  const wsConnected = connectionStatus === 'connected';

  // Auto-resolve the moltworld account for this agent
  useEffect(() => {
    api.getPlatformAccounts(agentId, 'moltworld').then(data => {
      const active = data.filter(a => a.status === 'active');
      if (active.length > 0) {
        setAccountId(active[0].id);
        setAccountName(active[0].credentials?.username || '');
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [agentId]);

  const fetchStatus = useCallback(async () => {
    if (!accountId) return;
    setStatusLoading(true);
    const data = await api.moltworldStatus(accountId).catch(() => null);
    if (data) setStatus(data);
    setStatusLoading(false);
  }, [accountId]);

  const fetchRateLimits = useCallback(async () => {
    if (!accountId) return;
    const data = await api.moltworldRateLimits(accountId).catch(() => null);
    if (data) setRateLimits(data);
  }, [accountId]);

  // Fetch activity history
  const fetchHistory = useCallback(async (append = false, before = null) => {
    setHistoryLoading(true);
    const mwActions = historyFilter || 'mw_explore,mw_build,mw_think,mw_say,mw_heartbeat,mw_interact';
    let data;
    if (before) {
      data = await api.getAgentActivityTimeline(30, [agentId], before).catch(() => null);
    } else {
      data = await api.getAgentActivities(30, [agentId], mwActions).catch(() => null);
    }
    if (data) {
      const items = Array.isArray(data) ? data : data.activities || [];
      // Filter to mw_* actions only
      const mwItems = items.filter(a => a.action?.startsWith('mw_'));
      if (append) {
        setHistory(prev => [...prev, ...mwItems]);
      } else {
        setHistory(mwItems);
      }
      setHistoryHasMore(mwItems.length >= 30);
    }
    setHistoryLoading(false);
  }, [agentId, historyFilter]);

  // Fetch action queue
  const fetchQueue = useCallback(async () => {
    setQueueLoading(true);
    const data = await api.moltworldGetQueue(agentId).catch(() => null);
    if (data) setQueue(data);
    setQueueLoading(false);
  }, [agentId]);

  // Fetch status + rate limits + history + queue when account resolves
  useEffect(() => {
    if (!accountId) return;
    fetchStatus();
    fetchRateLimits();
    fetchHistory();
    fetchQueue();
  }, [accountId, fetchStatus, fetchRateLimits, fetchHistory, fetchQueue]);

  // Re-fetch history when filter changes
  useEffect(() => {
    if (accountId) fetchHistory();
  }, [historyFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for queue Socket.IO events
  useEffect(() => {
    const handleQueueChange = () => fetchQueue();
    socket.on('moltworld:queue:added', handleQueueChange);
    socket.on('moltworld:queue:updated', handleQueueChange);
    socket.on('moltworld:queue:removed', handleQueueChange);
    return () => {
      socket.off('moltworld:queue:added', handleQueueChange);
      socket.off('moltworld:queue:updated', handleQueueChange);
      socket.off('moltworld:queue:removed', handleQueueChange);
    };
  }, [fetchQueue]);

  // Calculate cooldown end timestamps from rate limit data
  useEffect(() => {
    if (!rateLimits) { setCooldownEnds({}); return; }
    const ends = {};
    const now = Date.now();
    for (const [action, rl] of Object.entries(rateLimits)) {
      if (rl?.cooldownRemainingMs > 0) {
        ends[action] = now + rl.cooldownRemainingMs;
      }
    }
    setCooldownEnds(ends);
  }, [rateLimits]);

  // Tick cooldown timer every second while any cooldown is active
  useEffect(() => {
    const hasActive = Object.values(cooldownEnds).some(end => end > Date.now());
    if (!hasActive) return;
    let refetched = false;
    const interval = setInterval(() => {
      const stillActive = Object.values(cooldownEnds).some(end => end > Date.now());
      setTick(t => t + 1);
      if (!stillActive && !refetched) {
        refetched = true;
        fetchRateLimits();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownEnds, fetchRateLimits]);

  const updateFromJoinResponse = (result) => {
    if (result?.agents) setNearby(result.agents);
    const msgs = [
      ...(result?.messages || []).map(m => ({ ...m, type: 'say', from: m.fromName })),
      ...(result?.thoughts || []).map(t => ({ ...t, type: 'thought', from: t.agentName, message: t.thought }))
    ].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (msgs.length) setMessages(msgs);
  };

  const refreshAfterAction = () => {
    fetchRateLimits();
    fetchHistory();
  };

  const handleExplore = async (random = false) => {
    if (!accountId) return;
    setMoving(true);
    const x = random ? undefined : (moveX !== '' ? parseInt(moveX) : undefined);
    const y = random ? undefined : (moveY !== '' ? parseInt(moveY) : undefined);

    if (wsConnected && !random && x != null && y != null) {
      await api.moltworldWsMove(x, y, moveThinking || undefined).catch(() => null);
      setMoving(false);
      toast.success(`Move sent via WS to (${x}, ${y})`);
      refreshAfterAction();
      return;
    }

    const result = await api.moltworldExplore(
      accountId, agentId, x, y, moveThinking || undefined
    ).catch(() => null);
    setMoving(false);
    if (!result) { fetchRateLimits(); return; }
    updateFromJoinResponse(result);
    toast.success(`Moved to (${result.x}, ${result.y})`);
    fetchStatus();
    refreshAfterAction();
  };

  const handleThink = async () => {
    if (!accountId || !thought) return;
    setThinking(true);

    if (wsConnected) {
      await api.moltworldWsThink(thought).catch(() => null);
      setThinking(false);
      toast.success('Thought sent via WS');
      setThought('');
      refreshAfterAction();
      return;
    }

    const result = await api.moltworldThink(accountId, thought, agentId).catch(() => null);
    setThinking(false);
    if (!result) { fetchRateLimits(); return; }
    toast.success('Thought sent');
    setThought('');
    refreshAfterAction();
  };

  const handleBuild = async () => {
    if (!accountId || buildX === '' || buildY === '') return;
    setBuilding(true);
    const result = await api.moltworldBuild(
      accountId, agentId,
      parseInt(buildX), parseInt(buildY), parseInt(buildZ || '0'),
      blockType, buildAction
    ).catch(() => null);
    setBuilding(false);
    if (!result) { fetchRateLimits(); return; }
    toast.success(`Block ${buildAction}d at (${buildX}, ${buildY}, ${buildZ})`);
    refreshAfterAction();
  };

  const handleSay = async () => {
    if (!accountId || !sayMessage) return;
    setSaying(true);

    if (wsConnected && sayTo) {
      await api.moltworldWsInteract(sayTo, { message: sayMessage }).catch(() => null);
      setSaying(false);
      toast.success('DM sent via WS');
      setSayMessage('');
      setSayTo('');
      refreshAfterAction();
      return;
    }

    const result = await api.moltworldSay(
      accountId, sayMessage, sayTo || undefined, agentId
    ).catch(() => null);
    setSaying(false);
    if (!result) { fetchRateLimits(); return; }
    updateFromJoinResponse(result);
    toast.success(sayTo ? 'DM sent' : 'Message sent');
    setSayMessage('');
    setSayTo('');
    refreshAfterAction();
  };

  const handleLoadMoreHistory = () => {
    if (history.length === 0) return;
    const lastTs = history[history.length - 1].timestamp;
    fetchHistory(true, lastTs);
  };

  const handleAddToQueue = async () => {
    const params = { ...newActionParams };
    // Convert numeric fields
    if (params.x != null) params.x = parseInt(params.x);
    if (params.y != null) params.y = parseInt(params.y);
    if (params.z != null) params.z = parseInt(params.z);

    await api.moltworldAddToQueue(agentId, newActionType, params).catch(() => null);
    setShowAddForm(false);
    setNewActionParams({});
    toast.success('Action queued');
  };

  const handleRemoveFromQueue = async (id) => {
    await api.moltworldRemoveFromQueue(id).catch(() => null);
  };

  const getCooldownMs = (action) => {
    const end = cooldownEnds[action];
    return end ? Math.max(0, end - Date.now()) : 0;
  };

  const formatCooldown = (ms) => {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  if (loading) {
    return <div className="p-4"><BrailleSpinner text="Loading world tools" /></div>;
  }

  if (!accountId) {
    return (
      <div className="p-4 text-center py-12 text-gray-400">
        <p className="text-lg mb-2">No active Moltworld account</p>
        <p className="text-sm">Register a Moltworld account on the Overview tab to get started</p>
      </div>
    );
  }

  const profile = status?.profile;
  const bal = status?.balance?.balance || status?.balance;
  const displayNearby = presence.length > 0 ? presence : nearby;

  const statusDotColor = {
    connected: 'bg-port-success',
    connecting: 'bg-port-warning animate-pulse',
    reconnecting: 'bg-port-warning animate-pulse',
    disconnected: 'bg-gray-600'
  }[connectionStatus] || 'bg-gray-600';

  // Dynamic param fields for add-to-queue form
  const renderQueueParamFields = () => {
    switch (newActionType) {
      case 'mw_explore':
        return (
          <div className="grid grid-cols-2 gap-2">
            <input type="number" placeholder="X" value={newActionParams.x || ''} onChange={e => setNewActionParams(p => ({ ...p, x: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <input type="number" placeholder="Y" value={newActionParams.y || ''} onChange={e => setNewActionParams(p => ({ ...p, y: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <input type="text" placeholder="Thinking (optional)" value={newActionParams.thinking || ''} onChange={e => setNewActionParams(p => ({ ...p, thinking: e.target.value }))} className="col-span-2 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
          </div>
        );
      case 'mw_think':
        return (
          <input type="text" placeholder="Thought text" value={newActionParams.thought || ''} onChange={e => setNewActionParams(p => ({ ...p, thought: e.target.value }))} className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
        );
      case 'mw_build':
        return (
          <div className="grid grid-cols-3 gap-2">
            <input type="number" placeholder="X" value={newActionParams.x || ''} onChange={e => setNewActionParams(p => ({ ...p, x: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <input type="number" placeholder="Y" value={newActionParams.y || ''} onChange={e => setNewActionParams(p => ({ ...p, y: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <input type="number" placeholder="Z" value={newActionParams.z || ''} onChange={e => setNewActionParams(p => ({ ...p, z: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <select value={newActionParams.type || 'stone'} onChange={e => setNewActionParams(p => ({ ...p, type: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm">
              <option value="wood">Wood</option>
              <option value="stone">Stone</option>
              <option value="dirt">Dirt</option>
              <option value="grass">Grass</option>
              <option value="leaves">Leaves</option>
            </select>
            <select value={newActionParams.action || 'place'} onChange={e => setNewActionParams(p => ({ ...p, action: e.target.value }))} className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm">
              <option value="place">Place</option>
              <option value="remove">Remove</option>
            </select>
          </div>
        );
      case 'mw_say':
        return (
          <div className="space-y-2">
            <input type="text" placeholder="Message" value={newActionParams.message || ''} onChange={e => setNewActionParams(p => ({ ...p, message: e.target.value }))} className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
            <input type="text" placeholder="To Agent ID (optional)" value={newActionParams.sayTo || ''} onChange={e => setNewActionParams(p => ({ ...p, sayTo: e.target.value }))} className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm" />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="p-4">
      {/* Connection Banner */}
      <div className="flex flex-wrap items-center gap-4 mb-4 p-3 bg-port-card border border-port-border rounded-lg">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${statusDotColor}`} />
          <span className="text-sm text-gray-400">WebSocket:</span>
          <span className="text-sm text-white font-medium">{connectionStatus}</span>
        </div>
        <div className="flex gap-2 ml-auto">
          {connectionStatus === 'disconnected' ? (
            <button
              onClick={() => wsConnect(accountId)}
              className="px-3 py-1 text-sm bg-port-accent text-white rounded hover:bg-port-accent/80"
            >
              Connect
            </button>
          ) : (
            <button
              onClick={wsDisconnect}
              className="px-3 py-1 text-sm bg-port-border text-gray-300 rounded hover:bg-port-border/80"
            >
              Disconnect
            </button>
          )}
        </div>
      </div>

      {/* Header: Account Name + Rate Limits */}
      <div className="flex flex-wrap items-center gap-4 mb-6 p-4 bg-port-card border border-port-border rounded-lg">
        <span className="text-sm text-gray-400">Account: <span className="text-white font-medium">{accountName}</span></span>
        {rateLimits && (
          <div className="flex gap-3 ml-auto">
            {Object.entries(rateLimits).map(([action, rl]) => {
              if (!rl?.cooldownMs) return null;
              const cooldownMs = getCooldownMs(action);
              const isCooling = cooldownMs > 0;
              const colorClass = isCooling
                ? 'bg-port-warning/20 text-port-warning animate-pulse'
                : 'bg-port-success/20 text-port-success';
              return (
                <div key={action} className={`text-xs px-2 py-1 rounded ${colorClass}`} title={isCooling ? `Cooldown: ${formatCooldown(cooldownMs)}` : `${action} ready`}>
                  {isCooling ? `${action}: ${formatCooldown(cooldownMs)}` : `${action}: ready`}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left Column: World State */}
        <div className="space-y-4">
          {/* Status Card */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-white">World Status</h3>
              <button
                onClick={fetchStatus}
                disabled={statusLoading}
                className="px-3 py-1 text-sm bg-port-border text-gray-300 rounded hover:bg-port-border/80 disabled:opacity-50"
              >
                {statusLoading ? 'Loading...' : 'Refresh'}
              </button>
            </div>

            {!status && !statusLoading && (
              <p className="text-sm text-gray-500">No status data yet. Click Refresh.</p>
            )}

            {status && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-500">Status</span>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className={`w-2 h-2 rounded-full ${(profile?.inWorld || bal?.isOnline) ? 'bg-port-success' : 'bg-gray-600'}`} />
                      <span className="text-white">{(profile?.inWorld || bal?.isOnline) ? 'Online' : 'Offline'}</span>
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-500">Position</span>
                    <p className="text-white mt-0.5">
                      ({profile?.worldState?.x ?? '?'}, {profile?.worldState?.y ?? '?'})
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-500">SIM Balance</span>
                    <p className="text-port-accent font-medium mt-0.5">
                      {bal?.sim != null ? Number(bal.sim).toFixed(2) : '?'} SIM
                    </p>
                  </div>
                  <div>
                    <span className="text-gray-500">Earning Rate</span>
                    <p className="text-white mt-0.5">
                      {bal?.earningRate ?? '0.1 SIM/hour'}
                    </p>
                  </div>
                  {bal?.totalEarned != null && (
                    <div>
                      <span className="text-gray-500">Total Earned</span>
                      <p className="text-white mt-0.5">{Number(bal.totalEarned).toFixed(2)} SIM</p>
                    </div>
                  )}
                  {bal?.totalOnlineTime != null && (
                    <div>
                      <span className="text-gray-500">Online Time</span>
                      <p className="text-white mt-0.5">{bal.totalOnlineTime}</p>
                    </div>
                  )}
                </div>
                {profile?.agent?.name && (
                  <div className="text-xs text-gray-500 pt-2 border-t border-port-border">
                    Agent: {profile.agent.name} {profile.agent?.appearance?.emoji || ''}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Live Feed */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="font-semibold text-white">Live Feed</h3>
              {wsConnected && (
                <span className="text-xs text-port-success flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-port-success animate-pulse" />
                  live
                </span>
              )}
              {feedItems.length > 0 && (
                <span className="text-gray-500 font-normal text-sm">({feedItems.length})</span>
              )}
            </div>
            {feedItems.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">
                {wsConnected ? 'Waiting for events...' : 'Connect WebSocket to see live events'}
              </p>
            ) : (
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                {feedItems.slice(0, 50).map((item) => (
                  <div key={item.id} className="flex items-start gap-2 p-1.5 bg-port-bg rounded text-xs">
                    <span className="shrink-0">{EVENT_ICONS[item.eventType] || '📨'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {item.agentName && (
                          <span className="text-port-accent font-medium truncate">{item.agentName}</span>
                        )}
                        <span className="px-1 py-0.5 bg-port-border rounded text-gray-500 shrink-0">{item.eventType}</span>
                      </div>
                      {item.content && (
                        <p className="text-gray-400 truncate mt-0.5">{item.content}</p>
                      )}
                    </div>
                    <span className="text-gray-600 shrink-0 text-[10px]">{formatEventTime(item.timestamp)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Nearby Agents */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <h3 className="font-semibold text-white mb-3">
              Nearby Agents{displayNearby.length > 0 && <span className="text-gray-500 font-normal ml-2 text-sm">({displayNearby.length})</span>}
              {presence.length > 0 && wsConnected && (
                <span className="text-xs text-port-success ml-2 font-normal">(live)</span>
              )}
            </h3>
            {displayNearby.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">
                No nearby agents. Explore the world to discover others.
              </p>
            ) : (
              <div className="space-y-2 max-h-[300px] overflow-y-auto">
                {displayNearby.slice(0, 20).map((agent, i) => (
                  <div key={agent.id || i} className="flex items-center justify-between p-2 bg-port-bg rounded text-sm">
                    <div className="flex items-center gap-2">
                      <span>{agent.appearance?.emoji || '🤖'}</span>
                      <span className="text-white">{agent.name || 'Unknown'}</span>
                      {agent.thinking && <span className="text-gray-500 text-xs truncate max-w-[150px]">"{agent.thinking}"</span>}
                    </div>
                    <span className="text-gray-500 text-xs">
                      ({agent.x ?? '?'}, {agent.y ?? '?'})
                      {agent.distance != null && ` - ${Math.round(agent.distance)}m`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Recent Messages */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <h3 className="font-semibold text-white mb-3">Recent Messages</h3>
            {messages.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">
                No recent messages. Messages expire after 5 minutes.
              </p>
            ) : (
              <div className="space-y-2 max-h-[250px] overflow-y-auto">
                {messages.map((msg, i) => (
                  <div key={msg.id || i} className="p-2 bg-port-bg rounded text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-port-accent font-medium">{msg.from || 'Agent'}</span>
                      {msg.type === 'thought' && <span className="text-xs text-gray-600">(thought)</span>}
                      {msg.type === 'say' && <span className="text-xs text-port-success">(say)</span>}
                    </div>
                    <p className="text-gray-400 mt-0.5">{msg.message || msg.thought}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Activity History */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-white">Activity History</h3>
              <div className="flex items-center gap-2">
                <select
                  value={historyFilter}
                  onChange={e => setHistoryFilter(e.target.value)}
                  className="px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
                >
                  {HISTORY_FILTERS.map(f => (
                    <option key={f.value} value={f.value}>{f.label}</option>
                  ))}
                </select>
                <button
                  onClick={() => fetchHistory()}
                  disabled={historyLoading}
                  className="px-2 py-1 text-xs bg-port-border text-gray-300 rounded hover:bg-port-border/80 disabled:opacity-50"
                >
                  {historyLoading ? '...' : 'Refresh'}
                </button>
              </div>
            </div>
            {history.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-4">
                {historyLoading ? 'Loading...' : 'No activity history yet'}
              </p>
            ) : (
              <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
                {history.map((entry) => (
                  <div key={entry.id} className="flex items-start gap-2 p-2 bg-port-bg rounded text-xs">
                    <span className="shrink-0 text-sm">{HISTORY_ACTION_ICONS[entry.action] || '📋'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 bg-port-border rounded text-gray-300 font-medium">
                          {entry.action?.replace('mw_', '')}
                        </span>
                        <span className={`px-1 py-0.5 rounded text-[10px] ${entry.status === 'completed' ? 'bg-port-success/20 text-port-success' : 'bg-port-error/20 text-port-error'}`}>
                          {entry.status}
                        </span>
                        {entry.params?.via === 'ws' && (
                          <span className="text-[10px] text-port-accent">WS</span>
                        )}
                      </div>
                      <p className="text-gray-400 truncate mt-0.5">
                        {summarizeParams(entry.action, entry.params)}
                      </p>
                    </div>
                    <span className="text-gray-600 shrink-0 text-[10px]" title={entry.timestamp}>
                      {formatRelativeTime(entry.timestamp)}
                    </span>
                  </div>
                ))}
                {historyHasMore && (
                  <button
                    onClick={handleLoadMoreHistory}
                    disabled={historyLoading}
                    className="w-full py-2 text-xs text-gray-400 hover:text-white bg-port-bg rounded disabled:opacity-50"
                  >
                    {historyLoading ? 'Loading...' : 'Load More'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Actions */}
        <div className="space-y-4">
          {/* Action Queue */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-white">Action Queue</h3>
              <div className="flex items-center gap-2">
                {queue.length > 0 && (
                  <span className="text-xs text-gray-500">{queue.length} item{queue.length !== 1 ? 's' : ''}</span>
                )}
                <button
                  onClick={() => { setShowAddForm(!showAddForm); setNewActionParams({}); }}
                  className="px-2 py-1 text-xs bg-port-accent text-white rounded hover:bg-port-accent/80"
                >
                  {showAddForm ? 'Cancel' : '+ Add'}
                </button>
              </div>
            </div>

            {showAddForm && (
              <div className="mb-3 p-3 bg-port-bg border border-port-border rounded space-y-2">
                <select
                  value={newActionType}
                  onChange={e => { setNewActionType(e.target.value); setNewActionParams({}); }}
                  className="w-full px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-sm"
                >
                  {QUEUE_ACTION_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                {renderQueueParamFields()}
                <button
                  onClick={handleAddToQueue}
                  className="w-full px-3 py-1.5 text-sm bg-port-accent text-white rounded hover:bg-port-accent/80"
                >
                  Add to Queue
                </button>
              </div>
            )}

            {queue.length === 0 && !queueLoading ? (
              <p className="text-sm text-gray-500 text-center py-4">No queued actions</p>
            ) : (
              <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                {queue.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 p-2 bg-port-bg rounded text-xs">
                    <span className="shrink-0">{HISTORY_ACTION_ICONS[item.actionType] || '📋'}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-300 font-medium">{item.actionType?.replace('mw_', '')}</span>
                        <span className={`px-1 py-0.5 rounded text-[10px] ${QUEUE_STATUS_STYLES[item.status] || ''}`}>
                          {item.status}
                        </span>
                      </div>
                      <p className="text-gray-500 truncate mt-0.5">
                        {summarizeParams(item.actionType, item.params)}
                      </p>
                    </div>
                    {item.status === 'pending' && (
                      <button
                        onClick={() => handleRemoveFromQueue(item.id)}
                        className="shrink-0 text-gray-500 hover:text-port-error text-sm"
                        title="Cancel"
                      >
                        x
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Move / Explore */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="font-semibold text-white">Move / Explore</h3>
              {wsConnected && <span className="text-xs text-port-success">(via WS)</span>}
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">X (-240 to 240)</label>
                <input
                  type="number"
                  value={moveX}
                  onChange={(e) => setMoveX(e.target.value)}
                  min={-240}
                  max={240}
                  placeholder="X"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Y (-240 to 240)</label>
                <input
                  type="number"
                  value={moveY}
                  onChange={(e) => setMoveY(e.target.value)}
                  min={-240}
                  max={240}
                  placeholder="Y"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                />
              </div>
            </div>
            <input
              type="text"
              value={moveThinking}
              onChange={(e) => setMoveThinking(e.target.value)}
              placeholder="Thinking... (optional)"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white mb-3"
            />
            <div className="flex gap-2">
              <button
                onClick={() => handleExplore(false)}
                disabled={moving || (moveX === '' && moveY === '')}
                className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50"
              >
                {moving ? 'Moving...' : 'Move Here'}
              </button>
              <button
                onClick={() => handleExplore(true)}
                disabled={moving}
                className="px-4 py-2 bg-purple-600 text-white rounded hover:bg-purple-500 disabled:opacity-50"
              >
                {moving ? 'Exploring...' : 'Random Explore'}
              </button>
            </div>
          </div>

          {/* Think */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="font-semibold text-white">Think</h3>
              {wsConnected && <span className="text-xs text-port-success">(via WS)</span>}
            </div>
            <input
              type="text"
              value={thought}
              onChange={(e) => setThought(e.target.value)}
              placeholder="What is this agent thinking?"
              maxLength={500}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white mb-3"
            />
            <button
              onClick={handleThink}
              disabled={thinking || !thought || getCooldownMs('think') > 0}
              className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50"
              title={getCooldownMs('think') > 0 ? `Cooldown: ${formatCooldown(getCooldownMs('think'))}` : ''}
            >
              {thinking ? 'Thinking...' : getCooldownMs('think') > 0 ? `Wait ${formatCooldown(getCooldownMs('think'))}` : 'Think'}
            </button>
          </div>

          {/* Build */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <h3 className="font-semibold text-white mb-3">Build</h3>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <div>
                <label className="block text-xs text-gray-500 mb-1">X</label>
                <input
                  type="number"
                  value={buildX}
                  onChange={(e) => setBuildX(e.target.value)}
                  min={-500}
                  max={500}
                  placeholder="X"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Y</label>
                <input
                  type="number"
                  value={buildY}
                  onChange={(e) => setBuildY(e.target.value)}
                  min={-500}
                  max={500}
                  placeholder="Y"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Z (height)</label>
                <input
                  type="number"
                  value={buildZ}
                  onChange={(e) => setBuildZ(e.target.value)}
                  min={0}
                  max={100}
                  placeholder="Z"
                  className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <select
                value={blockType}
                onChange={(e) => setBlockType(e.target.value)}
                className="px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              >
                <option value="wood">Wood</option>
                <option value="stone">Stone</option>
                <option value="dirt">Dirt</option>
                <option value="grass">Grass</option>
                <option value="leaves">Leaves</option>
              </select>
              <select
                value={buildAction}
                onChange={(e) => setBuildAction(e.target.value)}
                className="px-3 py-2 bg-port-bg border border-port-border rounded text-white"
              >
                <option value="place">Place</option>
                <option value="remove">Remove</option>
              </select>
            </div>
            <button
              onClick={handleBuild}
              disabled={building || buildX === '' || buildY === '' || getCooldownMs('build') > 0}
              className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50"
              title={getCooldownMs('build') > 0 ? `Cooldown: ${formatCooldown(getCooldownMs('build'))}` : ''}
            >
              {building ? 'Building...' : getCooldownMs('build') > 0 ? `Wait ${formatCooldown(getCooldownMs('build'))}` : 'Build'}
            </button>
          </div>

          {/* Say */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <h3 className="font-semibold text-white">Say</h3>
              {wsConnected && sayTo && <span className="text-xs text-port-success">(DM via WS)</span>}
            </div>
            <input
              type="text"
              value={sayMessage}
              onChange={(e) => setSayMessage(e.target.value)}
              placeholder="Message to nearby agents..."
              maxLength={500}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white mb-2"
            />
            <input
              type="text"
              value={sayTo}
              onChange={(e) => setSayTo(e.target.value)}
              placeholder="To Agent ID (optional — leave blank for broadcast)"
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded text-white mb-3"
            />
            <button
              onClick={handleSay}
              disabled={saying || !sayMessage || getCooldownMs('join') > 0}
              className="px-4 py-2 bg-port-accent text-white rounded hover:bg-port-accent/80 disabled:opacity-50"
              title={getCooldownMs('join') > 0 ? `Cooldown: ${formatCooldown(getCooldownMs('join'))}` : ''}
            >
              {saying ? 'Sending...' : getCooldownMs('join') > 0 ? `Wait ${formatCooldown(getCooldownMs('join'))}` : 'Say'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
