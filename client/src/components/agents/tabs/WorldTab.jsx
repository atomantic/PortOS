import { useState, useEffect, useCallback, useRef } from 'react';
import ConnectionStatusDot from '../../ui/ConnectionStatusDot';
import { getPlatformAccounts, moltworldStatus, moltworldRateLimits } from '../../../services/apiAccounts.js';
import BrailleSpinner from '../../BrailleSpinner';
import ListLoadError from '../../ui/ListLoadError';
import useMoltworldWs from './useMoltworldWs';
import { useCooldownTick } from '../../../hooks/useCooldownTick';
import { formatCooldown, formatClockTime } from '../../../utils/formatters';
import useWorldHistory from './useWorldHistory';
import WorldHistorySection from './WorldHistorySection';
import WorldQueueSection, { useWorldQueue } from './WorldQueueSection';
import WorldActionControls, { useWorldActionControls } from './WorldActionControls';

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

function formatEventTime(ts) {
  const d = new Date(ts);
  return formatClockTime(d);
}

export default function WorldTab({ agentId }) {
  const [accountId, setAccountId] = useState(null);
  const [accountName, setAccountName] = useState('');
  const [rateLimits, setRateLimits] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accountError, setAccountError] = useState(null);

  // Status state
  const [status, setStatus] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);

  // Nearby agents + messages from last join/explore
  const [nearby, setNearby] = useState([]);
  const [messages, setMessages] = useState([]);

  // Cooldown timer state
  const [cooldownEnds, setCooldownEnds] = useState({});

  // Keep queue and action drafts mounted across account loading and error views.
  const queueSection = useWorldQueue({ agentId, accountId });

  // WebSocket hook
  const {
    connectionStatus,
    feedItems,
    presence,
    connect: wsConnect,
    disconnect: wsDisconnect
  } = useMoltworldWs();

  const wsConnected = connectionStatus === 'connected';

  // Auto-resolve the moltworld account for this agent. A failed read sets
  // accountError so it never falls through into the "no account" onboarding copy.
  const accountRequestRef = useRef(0);
  const loadAccount = useCallback(async () => {
    const requestId = ++accountRequestRef.current;
    setLoading(true);
    setAccountError(null);
    setAccountId(null);
    setAccountName('');
    const result = await getPlatformAccounts(agentId, 'moltworld', { silent: true })
      .then(data => ({ data }), error => ({ error }));
    if (requestId !== accountRequestRef.current) return;
    if (result.error) {
      setAccountError(result.error);
    } else {
      const active = result.data.filter(a => a.status === 'active');
      if (active.length > 0) {
        setAccountId(active[0].id);
        setAccountName(active[0].credentials?.username || '');
      }
    }
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    loadAccount();
    return () => { accountRequestRef.current += 1; };
  }, [loadAccount]);

  const fetchStatus = useCallback(async () => {
    if (!accountId) return;
    setStatusLoading(true);
    const data = await moltworldStatus(accountId).catch(() => null);
    if (data) setStatus(data);
    setStatusLoading(false);
  }, [accountId]);

  const fetchRateLimits = useCallback(async () => {
    if (!accountId) return;
    const data = await moltworldRateLimits(accountId).catch(() => null);
    if (data) setRateLimits(data);
  }, [accountId]);

  // Status and rate limits depend on the account, independently of history filters.
  useEffect(() => {
    if (!accountId) return;
    fetchStatus();
    fetchRateLimits();
  }, [accountId, fetchStatus, fetchRateLimits]);

  const historySection = useWorldHistory({ agentId, accountId });

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

  useCooldownTick({ cooldownEnds, onAllExpired: fetchRateLimits });

  const updateFromJoinResponse = (result) => {
    if (result?.agents) setNearby(result.agents);
    const msgs = [
      ...(result?.messages || []).map(m => ({ ...m, type: 'say', from: m.fromName })),
      ...(result?.thoughts || []).map(t => ({ ...t, type: 'thought', from: t.agentName, message: t.thought }))
    ].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (msgs.length) setMessages(msgs);
  };

  const actionControls = useWorldActionControls({
    accountId, agentId, wsConnected, updateFromJoinResponse, fetchStatus, fetchRateLimits,
    fetchHistory: historySection.fetchHistory
  });

  const getCooldownMs = (action) => {
    const end = cooldownEnds[action];
    return end ? Math.max(0, end - Date.now()) : 0;
  };

  if (loading) {
    return <div className="p-4"><BrailleSpinner text="Loading world tools" /></div>;
  }

  if (accountError) {
    return <div className="p-4"><ListLoadError what="Moltworld account" error={accountError} onRetry={loadAccount} /></div>;
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
  // `presence === null` = no live snapshot yet → fall back to the last REST
  // join/explore result. Once the WS has spoken (even an empty `[]`), the live
  // snapshot wins so a "nobody nearby" event clears the panel instead of
  // leaving stale phantoms.
  const displayNearby = presence !== null ? presence : nearby;

  return (
    <div className="p-4">
      {/* Connection Banner */}
      <div className="flex flex-wrap items-center gap-4 mb-4 p-3 bg-port-card border border-port-border rounded-lg">
        <ConnectionStatusDot status={connectionStatus} label="WebSocket:" />
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
          <div className="flex flex-wrap gap-2 ml-auto min-w-0">
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
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 className="font-semibold text-white min-w-0">World Status</h3>
              <button
                onClick={fetchStatus}
                disabled={statusLoading}
                className="shrink-0 pointer-coarse:min-h-11 px-3 py-1 text-sm bg-port-border text-gray-300 rounded hover:bg-port-border/80 disabled:opacity-50"
              >
                {statusLoading ? <BrailleSpinner text="Loading" /> : 'Refresh'}
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
              {presence?.length > 0 && wsConnected && (
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
                  <div key={agent.id || i} className="flex flex-wrap items-center justify-between gap-2 p-2 bg-port-bg rounded text-sm">
                    <div className="flex items-center gap-2 min-w-0">
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

          <WorldHistorySection {...historySection} />
        </div>

        <div className="space-y-4">
          <WorldQueueSection {...queueSection} />
          <WorldActionControls {...actionControls} wsConnected={wsConnected} getCooldownMs={getCooldownMs} />
        </div>
      </div>
    </div>
  );
}
