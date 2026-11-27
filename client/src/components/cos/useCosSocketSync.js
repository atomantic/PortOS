import { useEffect, useState } from 'react';
import { useSocket } from '../../hooks/useSocket';
import { coalesce } from '../../utils/coalesce';
import { isAgentHandoff } from '../../lib/agentOutcome';
import { mergeAgentRecords } from '../../lib/mergeCosAgentRecords';
import { summarizeHealthIssues } from './constants';

export default function useCosSocketSync({
  avatar, appsReadRef, needsRef, agentReadRef, applyAgents, applyStatus, applyHealth, setTasks,
  fetchData, fetchQueue, refreshLearningSummary, readAgentsSlice, readApps, readProviders,
}) {
  const { agentStateRef, setActiveAgentMeta, setAgentState, setStatusMessage, setSpeakingFor, settleAgentState } = avatar;
  const [completedRevision, setCompletedRevision] = useState(0);
  const [taskHistoryRevision, setTaskHistoryRevision] = useState(0);
  const [liveOutputs, setLiveOutputs] = useState({});
  const [eventLogs, setEventLogs] = useState([]);
  const socket = useSocket();
  useEffect(() => {
    if (!socket) return;

    // The page subscription reacquires the room before the recovery reads.
    const reconnect = () => {
      appsReadRef.current = null;
      fetchData();
      setCompletedRevision(value => value + 1);
      setTaskHistoryRevision(value => value + 1);
    };
    socket.on('connect', reconnect);

    const handleCosStatus = (data) => {
      applyStatus(prev => ({ ...prev, running: data.running }));
      fetchQueue();
      if (!data.running) {
        setAgentState('sleeping');
        setStatusMessage("Stopped - daemon not running");
        setActiveAgentMeta(null);
      } else {
        // Started from elsewhere: leave Sleeping without waiting for a refresh.
        settleAgentState();
      }
    };
    socket.on('cos:status', handleCosStatus);

    // The store's own per-mutation event, which fires the instant a task is added
    // or its status flips. It carries one task rather than the list, and also
    // fires for writes with nothing to
    // show here (every running task's federation lease heartbeat), so it drives
    // one coalesced queue refresh rather than a fetch per event. This is what
    // collapses the pending→in_progress lag: 'cos:agent:spawned' fires BEFORE
    // spawnAgentForTask flips the task off 'pending', so the fetch it triggers
    // always reads the task as still-queued.
    const refreshQueue = coalesce(fetchQueue, 400);
    // The learning summary changes when learning data is persisted (the server's
    // `cos:learning:changed`: outcomes, resets, backfills) and when an agent
    // finishes. A tab switch must not be what refreshes the tile.
    const refreshLearning = coalesce(refreshLearningSummary, 400);
    socket.on('cos:learning:changed', refreshLearning);
    // Deletion and cleanup change the agent list without a lifecycle event, and a
    // slice kept across tab switches no longer gets a fresh read to hide that.
    const refreshAgents = coalesce(() => { if (needsRef.current.agents) readAgentsSlice(); }, 400);
    socket.on('cos:agents:changed', refreshAgents);
    const handleTaskMutation = data => {
      if (data?.completedChanged || data?.task?.status === 'completed' || data?.previousStatus === 'completed' || ['deleted', 'peer-merged'].includes(data?.action)) {
        setTaskHistoryRevision(value => value + 1);
      }
      if (data?.task?.id) {
        setTasks(prev => {
          const updated = { ...prev };
          for (const key of ['user', 'cos']) {
            if (updated[key]?.tasks) {
              updated[key] = {
                ...updated[key],
                tasks: updated[key].tasks.map(t => t.id === data.task.id ? { ...t, ...data.task } : t),
              };
            }
          }
          return updated;
        });
      }
      refreshQueue();
    };
    socket.on('cos:tasks:changed', handleTaskMutation);

    // This queue belongs to the socket subscription and is discarded with it.
    const pendingOutputs = new Map();
    let outputFlushTimer = null;

    const cancelOutputFlush = () => {
      clearTimeout(outputFlushTimer);
      outputFlushTimer = null;
    };

    const discardPendingOutput = (id) => {
      if (pendingOutputs.delete(id) && pendingOutputs.size === 0) cancelOutputFlush();
    };

    const flushOutputs = () => {
      outputFlushTimer = null;
      const batch = [...pendingOutputs];
      pendingOutputs.clear();
      setLiveOutputs(prev => {
        const next = { ...prev };
        for (const [id, lines] of batch) {
          next[id] = (prev[id] || []).concat(lines).slice(-500);
        }
        return next;
      });
    };

    const handleAgentSpawned = (data) => {
      if (needsRef.current.agents && data?.id) {
        agentReadRef.current?.updates.set(data.id, data);
        applyAgents(prev => [...prev.filter(agent => agent.id !== data.id), data]);
      }
      setAgentState('coding');
      // Show actual task description if available
      const taskDesc = data?.metadata?.taskDescription;
      const shortDesc = taskDesc ? taskDesc.substring(0, 60) + (taskDesc.length > 60 ? '...' : '') : 'Working on task...';
      setStatusMessage(`Running: ${shortDesc}`);
      setSpeakingFor();
      // Track active agent metadata for dynamic avatar resolution
      if (data?.metadata) setActiveAgentMeta(data.metadata);
      // Initialize empty output buffer for new agent
      const id = data?.id || data?.agentId;
      if (needsRef.current.agents && id) {
        discardPendingOutput(id);
        setLiveOutputs(prev => ({ ...prev, [id]: [] }));
      }
      fetchQueue();
    };
    socket.on('cos:agent:spawned', handleAgentSpawned);

    const handleAgentUpdated = (updatedAgent) => {
      if (!needsRef.current.agents) return;
      const updates = agentReadRef.current?.updates;
      updates?.set(updatedAgent.id, mergeAgentRecords(updates.get(updatedAgent.id), updatedAgent));
      // Update the specific agent in the agents list without fetching all data
      applyAgents(prev => prev.map(agent =>
        agent.id === updatedAgent.id ? mergeAgentRecords(agent, updatedAgent) : agent
      ).filter(agent => agent.status !== 'completed' || agent.deliveryPending));
      if (updatedAgent.status === 'completed' || updatedAgent.metadata?.releaseSynchronization) {
        setCompletedRevision(value => value + 1);
      }
    };
    socket.on('cos:agent:updated', handleAgentUpdated);

    const handleAgentOutput = (data) => {
      if (!needsRef.current.agents || !data?.agentId || !data?.line) return;

      const { agentId, line } = data;
      if (!pendingOutputs.has(agentId)) pendingOutputs.set(agentId, []);
      pendingOutputs.get(agentId).push({ line, timestamp: Date.now() });
      if (outputFlushTimer === null) outputFlushTimer = setTimeout(flushOutputs, 100);
    };
    socket.on('cos:agent:output', handleAgentOutput);

    const handleAgentCompleted = (data) => {
      const id = data?.id || data?.agentId;
      if (needsRef.current.agents && id) {
        agentReadRef.current?.updates.set(id, { ...data, id, status: 'completed' });
        applyAgents(prev => prev.filter(agent => agent.id !== id));
      }
      setCompletedRevision(value => value + 1);
      refreshLearning();
      setAgentState('reviewing');
      // Three outcomes, not two: a run retired by Resume/Relaunch never reached a
      // verdict, so announcing "Task failed" for it tells the user their own
      // provider swap broke something.
      setStatusMessage(
        isAgentHandoff(data) ? "Handed the task to a new run"
          : data?.result?.success ? "Task completed successfully"
            : "Task failed - checking errors..."
      );
      setSpeakingFor();
      // Clear active agent metadata so avatar reverts to default
      setActiveAgentMeta(null);
      // Evict queued lines as well so a later flush cannot recreate this buffer.
      if (id) {
        discardPendingOutput(id);
        setLiveOutputs(prev => {
          if (!(id in prev)) return prev;
          const { [id]: _, ...rest } = prev;
          return rest;
        });
      }
      fetchQueue();
    };
    socket.on('cos:agent:completed', handleAgentCompleted);

    const handleHealthCheck = (data) => {
      applyHealth({ lastCheck: data.metrics?.timestamp, issues: data.issues });
      // The health snapshot is already in this event; no HTTP health read is needed.
      if (data.issues?.length > 0) {
        setAgentState('investigating');
        setStatusMessage(summarizeHealthIssues(data.issues));
        setSpeakingFor();
      } else if (agentStateRef.current === 'investigating') {
        // The issue that parked the avatar is gone.
        settleAgentState();
      }
    };
    socket.on('cos:health:check', handleHealthCheck);

    // Listen for detailed log events
    const handleCosLog = (data) => {
      setEventLogs(prev => {
        const newLogs = [...prev, data].slice(-20); // Keep last 20 logs
        return newLogs;
      });
      // Update status message with latest log
      if (data.message) {
        setStatusMessage(data.message);
        if (data.level === 'success' || data.level === 'error') {
          setSpeakingFor(1500);
        }
      }
    };
    socket.on('cos:log', handleCosLog);
    const handleRecoveryScheduleChanged = event => {
      if (needsRef.current.agents && event?.id === 'cos-pending-merge-sweep') refreshQueue();
    };
    socket.on('cos:scheduler:changed', handleRecoveryScheduleChanged);

    // Stable reference data has its own invalidation path, independent of the queue.
    const handleAppsChanged = coalesce(() => {
      appsReadRef.current = null;
      if (needsRef.current.apps) readApps();
    }, 400);
    const handleProvidersChanged = coalesce(() => {
      if (needsRef.current.providers) readProviders();
    }, 400);
    const handleConfigChanged = () => fetchData();
    socket.on('providers:changed', handleProvidersChanged);
    socket.on('cos:config:changed', handleConfigChanged);
    socket.on('cos:status:paused', handleConfigChanged);
    socket.on('cos:status:resumed', handleConfigChanged);
    socket.on('apps:changed', handleAppsChanged);

    return () => {
      socket.off('connect', reconnect);
      socket.off('providers:changed', handleProvidersChanged);
      socket.off('cos:config:changed', handleConfigChanged);
      socket.off('cos:status:paused', handleConfigChanged);
      socket.off('cos:status:resumed', handleConfigChanged);
      handleAppsChanged.cancel();
      handleProvidersChanged.cancel();
      socket.off('cos:status', handleCosStatus);
      socket.off('cos:tasks:changed', handleTaskMutation);
      socket.off('cos:agent:spawned', handleAgentSpawned);
      socket.off('cos:agent:updated', handleAgentUpdated);
      socket.off('cos:agent:output', handleAgentOutput);
      cancelOutputFlush();
      pendingOutputs.clear();
      socket.off('cos:agent:completed', handleAgentCompleted);
      socket.off('cos:health:check', handleHealthCheck);
      socket.off('cos:log', handleCosLog);
      socket.off('cos:scheduler:changed', handleRecoveryScheduleChanged);
      socket.off('cos:learning:changed', refreshLearning);
      socket.off('cos:agents:changed', refreshAgents);
      refreshAgents.cancel();
      socket.off('apps:changed', handleAppsChanged);
      refreshQueue.cancel();
      refreshLearning.cancel();
    };
  }, [socket, fetchData, fetchQueue, refreshLearningSummary, readAgentsSlice, readApps, readProviders,
    appsReadRef, needsRef, agentReadRef, agentStateRef, applyAgents, applyStatus, applyHealth,
    setTasks, setActiveAgentMeta, setAgentState, setStatusMessage, setSpeakingFor, settleAgentState]);

  return { completedRevision, taskHistoryRevision, liveOutputs, eventLogs };
}
