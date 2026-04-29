import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as api from '../services/api';
import socket from '../services/socket';

const healthSignature = (h) =>
  `${h?.overallHealth}|${h?.system?.cpu?.usagePercent}|${h?.system?.memory?.usagePercent}|${h?.system?.disk?.usagePercent}|${h?.warnings?.length ?? 0}`;

export const useCityData = () => {
  const [apps, setApps] = useState([]);
  const [cosAgents, setCosAgents] = useState([]);
  const [cosStatus, setCosStatus] = useState({ running: false });
  const [runningAgents, setRunningAgents] = useState([]);
  const [eventLogs, setEventLogs] = useState([]);
  const [reviewCounts, setReviewCounts] = useState({ total: 0, alert: 0, todo: 0, briefing: 0, cos: 0 });
  const [instances, setInstances] = useState({ self: null, peers: [], syncStatus: null });
  const [systemHealth, setSystemHealth] = useState(null);
  const [notificationCounts, setNotificationCounts] = useState({ total: 0, unread: 0 });
  const [loading, setLoading] = useState(true);
  const pollRef = useRef(null);
  const healthPollRef = useRef(null);

  const fetchApps = useCallback(async () => {
    const data = await api.getApps().catch(() => []);
    setApps(data);
    return data;
  }, []);

  const fetchAll = useCallback(async () => {
    const [appsData, agents, cosAgentsData, status, reviewData, instanceData, health, notifs] = await Promise.all([
      api.getApps().catch(() => []),
      api.getRunningAgents().catch(() => []),
      api.getCosAgents().catch(() => []),
      api.getCosStatus().catch(() => ({ running: false })),
      api.getReviewCounts().catch(() => ({ total: 0, alert: 0, todo: 0, briefing: 0, cos: 0 })),
      api.getInstances().catch(() => ({ self: null, peers: [], syncStatus: null })),
      api.getSystemHealth().catch(() => null),
      api.getNotificationCounts().catch(() => ({ total: 0, unread: 0 })),
    ]);

    setApps(appsData);
    setRunningAgents(agents);
    setCosAgents(cosAgentsData);
    setCosStatus(status);
    setReviewCounts(reviewData);
    setInstances(instanceData);
    setSystemHealth(health);
    setNotificationCounts(notifs);
    setLoading(false);
  }, []);

  const fetchHealth = useCallback(async () => {
    const health = await api.getSystemHealth().catch(() => null);
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

    const subscribe = () => socket.emit('cos:subscribe');
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
      setEventLogs(prev => [...prev, { ...data, timestamp: data.timestamp || Date.now() }].slice(-50));
    };
    socket.on('cos:log', handleCosLog);

    const handleCosStatus = (data) => {
      setCosStatus(prev => ({ ...prev, running: data.running }));
    };
    socket.on('cos:status', handleCosStatus);

    pollRef.current = setInterval(async () => {
      const agents = await api.getRunningAgents().catch(() => []);
      setRunningAgents(agents);
    }, 10000);

    healthPollRef.current = setInterval(fetchHealth, 15000);

    return () => {
      socket.emit('cos:unsubscribe');
      socket.off('connect', subscribe);
      socket.off('apps:changed', handleAppsChanged);
      socket.off('cos:agent:spawned', handleAgentSpawned);
      socket.off('cos:agent:updated', handleAgentUpdated);
      socket.off('cos:agent:completed', handleAgentCompleted);
      socket.off('cos:log', handleCosLog);
      socket.off('cos:status', handleCosStatus);
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
