import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as api from '../services/api';
import socket from '../services/socket';

export const useCityData = () => {
  const [apps, setApps] = useState([]);
  const [cosAgents, setCosAgents] = useState([]);
  const [cosStatus, setCosStatus] = useState({ running: false });
  const [runningAgents, setRunningAgents] = useState([]);
  const [eventLogs, setEventLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef(null);

  const fetchApps = useCallback(async () => {
    const data = await api.getApps().catch(() => []);
    setApps(data);
    return data;
  }, []);

  const fetchAll = useCallback(async () => {
    const [appsData, agents, cosAgentsData, status] = await Promise.all([
      api.getApps().catch(() => []),
      api.getRunningAgents().catch(() => []),
      api.getCosAgents().catch(() => []),
      api.getCosStatus().catch(() => ({ running: false })),
    ]);
    setApps(appsData);
    setRunningAgents(agents);
    setCosAgents(cosAgentsData);
    setCosStatus(status);
    setLoading(false);
  }, []);

  // Build agent-to-app mapping
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

    // Subscribe to CoS events
    const subscribe = () => socket.emit('cos:subscribe');
    if (socket.connected) subscribe();
    socket.on('connect', subscribe);

    // App changes
    const handleAppsChanged = () => fetchApps();
    socket.on('apps:changed', handleAppsChanged);

    // CoS agent events
    socket.on('cos:agent:spawned', (data) => {
      setCosAgents(prev => [...prev, data]);
      fetchAll();
    });

    socket.on('cos:agent:updated', (updatedAgent) => {
      setCosAgents(prev => prev.map(a => a.agentId === updatedAgent.agentId ? updatedAgent : a));
    });

    socket.on('cos:agent:completed', () => {
      fetchAll();
    });

    // CoS log events
    socket.on('cos:log', (data) => {
      setEventLogs(prev => [...prev, { ...data, timestamp: data.timestamp || Date.now() }].slice(-50));
    });

    // CoS status
    socket.on('cos:status', (data) => {
      setCosStatus(prev => ({ ...prev, running: data.running }));
    });

    // Poll running agents (no socket events for system agents)
    pollRef.current = setInterval(async () => {
      const agents = await api.getRunningAgents().catch(() => []);
      setRunningAgents(agents);
    }, 10000);

    return () => {
      socket.emit('cos:unsubscribe');
      socket.off('connect', subscribe);
      socket.off('apps:changed', handleAppsChanged);
      socket.off('cos:agent:spawned');
      socket.off('cos:agent:updated');
      socket.off('cos:agent:completed');
      socket.off('cos:log');
      socket.off('cos:status');
      clearInterval(pollRef.current);
    };
  }, [fetchAll, fetchApps]);

  return {
    apps,
    cosAgents,
    cosStatus,
    runningAgents,
    eventLogs,
    agentMap,
    loading,
    connected: socket.connected,
  };
};
