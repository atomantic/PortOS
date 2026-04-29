import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as api from '../services/api';
import socket from '../services/socket';

const healthSignature = (h) => {
  const warnings = (h?.warnings || []).map(w => `${w.type}:${w.message}`).join(';');
  return `${h?.overallHealth}|${h?.system?.cpu?.usagePercent}|${h?.system?.memory?.usagePercent}|${h?.system?.disk?.usagePercent}|${warnings}`;
};

export const useCityData = () => {
  const [apps, setApps] = useState([]);
  const [cosAgents, setCosAgents] = useState([]);
  const [cosStatus, setCosStatus] = useState({ running: false });
  const [runningAgents, setRunningAgents] = useState([]);
  const [eventLogs, setEventLogs] = useState([]);
  const [reviewCounts, setReviewCounts] = useState({ total: 0, alert: 0, todo: 0, briefing: 0, cos: 0 });
  const [instances, setInstances] = useState({ self: null, peers: [], syncStatus: null });
  const [systemHealth, setSystemHealth] = useState(null);
  const [notificationCounts, setNotificationCounts] = useState({ unread: 0 });
  const [loading, setLoading] = useState(true);
  const pollRef = useRef(null);
  const healthPollRef = useRef(null);
  const logIdRef = useRef(0);

  const fetchApps = useCallback(async () => {
    const data = await api.getApps().catch(() => []);
    setApps(data);
    return data;
  }, []);

  const fetchAll = useCallback(async () => {
    // /notifications/count returns the lightweight { count } payload — the HUD
    // and Attention pane only need unread, and notifications:count socket
    // events keep it fresh after this initial fetch.
    const [appsData, agents, cosAgentsData, status, reviewData, instanceData, health, notif] = await Promise.all([
      api.getApps().catch(() => []),
      api.getRunningAgents().catch(() => []),
      api.getCosAgents().catch(() => []),
      api.getCosStatus().catch(() => ({ running: false })),
      api.getReviewCounts().catch(() => ({ total: 0, alert: 0, todo: 0, briefing: 0, cos: 0 })),
      api.getInstances().catch(() => ({ self: null, peers: [], syncStatus: null })),
      api.getSystemHealth({ silent: true }).catch(() => null),
      api.getNotificationCount().catch(() => ({ count: 0 })),
    ]);

    setApps(appsData);
    setRunningAgents(agents);
    setCosAgents(cosAgentsData);
    setCosStatus(status);
    setReviewCounts(reviewData);
    setInstances(instanceData);
    setSystemHealth(health);
    setNotificationCounts({ unread: notif?.count ?? 0 });
    setLoading(false);
  }, []);

  const healthInFlightRef = useRef(false);
  const fetchHealth = useCallback(async () => {
    // In-flight guard: a slow /system/health/details (>15s) would otherwise
    // let the next interval tick fire a concurrent request. Drop the new tick
    // when one is already pending; the next interval picks up fresh state.
    if (healthInFlightRef.current) return;
    healthInFlightRef.current = true;
    const health = await api.getSystemHealth({ silent: true }).catch(() => null);
    healthInFlightRef.current = false;
    if (!health) return;
    setSystemHealth(prev => {
      if (prev && healthSignature(prev) === healthSignature(health)) return prev;
      return health;
    });
  }, []);

  const agentMap = useMemo(() => {
    const map = new Map();
    const allAgents = [...(cosAgents || [])];

    allAgents.forEach(agent => {
      if (!agent.workspacePath) return;
      const matchedApp = apps.find(app =>
        app.repoPath && agent.workspacePath.startsWith(app.repoPath)
      );
      if (matchedApp) {
        const existing = map.get(matchedApp.id) || { app: matchedApp, agents: [] };
        existing.agents.push(agent);
        map.set(matchedApp.id, existing);
      }
    });

    return map;
  }, [apps, cosAgents]);

  useEffect(() => {
    fetchAll();

    const subscribe = () => {
      socket.emit('cos:subscribe');
      socket.emit('notifications:subscribe');
    };
    if (socket.connected) subscribe();
    socket.on('connect', subscribe);

    const handleAppsChanged = () => fetchApps();
    socket.on('apps:changed', handleAppsChanged);

    const handleAgentSpawned = (data) => {
      setCosAgents(prev => [...prev, data]);
      fetchAll();
    };
    socket.on('cos:agent:spawned', handleAgentSpawned);

    const handleAgentUpdated = (updatedAgent) => {
      setCosAgents(prev => prev.map(a => a.agentId === updatedAgent.agentId ? updatedAgent : a));
    };
    socket.on('cos:agent:updated', handleAgentUpdated);

    const handleAgentCompleted = () => {
      fetchAll();
    };
    socket.on('cos:agent:completed', handleAgentCompleted);

    const handleCosLog = (data) => {
      const entry = { ...data, timestamp: data.timestamp || Date.now(), _localId: ++logIdRef.current };
      setEventLogs(prev => [...prev, entry].slice(-50));
    };
    socket.on('cos:log', handleCosLog);

    const handleCosStatus = (data) => {
      setCosStatus(prev => ({ ...prev, running: data.running }));
    };
    socket.on('cos:status', handleCosStatus);

    // notifications:count fires after every add/update/remove on the server,
    // so we don't need to listen to those individually or refetch — count is
    // the only field the city UI surfaces.
    const handleNotifCount = (count) => {
      setNotificationCounts(prev => prev?.unread === count ? prev : { unread: count });
    };
    const handleNotifCleared = () => setNotificationCounts({ unread: 0 });
    socket.on('notifications:count', handleNotifCount);
    socket.on('notifications:cleared', handleNotifCleared);

    pollRef.current = setInterval(async () => {
      const agents = await api.getRunningAgents().catch(() => []);
      setRunningAgents(agents);
    }, 10000);

    healthPollRef.current = setInterval(fetchHealth, 15000);

    // Subscribe but do NOT unsubscribe on cleanup. The cos:* and notifications:*
    // namespaces are shared (useNotifications in Layout, useAgentFeedbackToast).
    // Server uses a per-socket Set, so unsubscribing here would yank the
    // subscription out from under those always-mounted consumers. The socket
    // disconnect handler cleans up Set membership when the tab closes.
    return () => {
      socket.off('connect', subscribe);
      socket.off('apps:changed', handleAppsChanged);
      socket.off('cos:agent:spawned', handleAgentSpawned);
      socket.off('cos:agent:updated', handleAgentUpdated);
      socket.off('cos:agent:completed', handleAgentCompleted);
      socket.off('cos:log', handleCosLog);
      socket.off('cos:status', handleCosStatus);
      socket.off('notifications:count', handleNotifCount);
      socket.off('notifications:cleared', handleNotifCleared);
      clearInterval(pollRef.current);
      clearInterval(healthPollRef.current);
    };
  }, [fetchAll, fetchApps, fetchHealth]);

  return {
    apps,
    cosAgents,
    cosStatus,
    runningAgents,
    eventLogs,
    agentMap,
    reviewCounts,
    instances,
    systemHealth,
    notificationCounts,
    loading,
    connected: socket.connected,
  };
};
