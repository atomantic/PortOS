import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import * as api from '../services/api';
import socket from '../services/socket';
import { useAutoRefetch } from './useAutoRefetch';
import { METRICS as HEALTH_TOWER_METRICS } from '../utils/cityHealthTower';
import { applyAiStatusEvent, pruneAiOps, AI_CORE } from '../utils/cityAiCore';
import { coalesce } from '../utils/coalesce';

// Metric keys the vitals-tower landmark renders — fetched as the latest-value snapshot.
const HEALTH_METRIC_KEYS = HEALTH_TOWER_METRICS.map(m => m.key);

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
  const [backupStatus, setBackupStatus] = useState(null);
  const [cosTasks, setCosTasks] = useState([]);
  const [healthMetrics, setHealthMetrics] = useState(null);
  // Voice-agent district marker: `enabled` from the persisted /voice/status payload,
  // `live` driven by the per-socket voice:* events (idle | listening | dictating | error).
  const [voiceState, setVoiceState] = useState(null);
  const [character, setCharacter] = useState(null);
  // AI Core landmark: in-flight `ai:status` ops keyed by id + the last op-start timestamp
  // (for the flare). Purely event-driven — there's no GET for in-flight ops, so it starts
  // empty and the socket handler below maintains it.
  const [aiActivity, setAiActivity] = useState({ ops: {}, lastStartTs: 0 });
  const [loading, setLoading] = useState(true);
  const logIdRef = useRef(0);
  // One-shot timer that prunes expired AI Core ops. `ai:status` is purely event-driven, so
  // without this a `done` afterglow (or a flare) beam would linger until the next event —
  // the render derivations check the clock but nothing re-renders to advance it.
  const aiPruneTimerRef = useRef(null);
  // Mirror of the latest aiActivity so the prune timer can decide whether to re-arm without
  // depending on React having run the state updater synchronously (it isn't guaranteed to).
  const aiActivityRef = useRef(aiActivity);
  aiActivityRef.current = aiActivity;

  const fetchApps = useCallback(async () => {
    const data = await api.getApps().catch(() => []);
    setApps(data);
    return data;
  }, []);

  const fetchAll = useCallback(async () => {
    // /notifications/count returns the lightweight { count } payload — the HUD
    // and Attention pane only need unread, and notifications:count socket
    // events keep it fresh after this initial fetch.
    const [appsData, agents, cosAgentsData, status, reviewData, instanceData, health, notif, backup, cosTasksData, healthMetricsData, voice, characterData] = await Promise.all([
      api.getApps().catch(() => []),
      api.getRunningAgents().catch(() => []),
      api.getCosAgents().catch(() => []),
      api.getCosStatus().catch(() => ({ running: false })),
      api.getReviewCounts().catch(() => ({ total: 0, alert: 0, todo: 0, briefing: 0, cos: 0 })),
      api.getInstances().catch(() => ({ self: null, peers: [], syncStatus: null })),
      api.getSystemHealth({ silent: true }).catch(() => null),
      api.getNotificationCount().catch(() => ({ count: 0 })),
      api.getBackupStatus({ silent: true }).catch(() => null),
      api.getCosTasks({ silent: true }).catch(() => ({ tasks: [] })),
      api.getLatestHealthMetrics(HEALTH_METRIC_KEYS, { silent: true }).catch(() => null),
      api.getVoiceStatus({ silent: true }).catch(() => null),
      // `skills: false` — the city only renders the level (see fetchCharacter).
      api.getCharacter({ silent: true, skills: false }).catch(() => null),
    ]);

    setApps(appsData);
    setRunningAgents(agents);
    setCosAgents(cosAgentsData);
    setCosStatus(status);
    setReviewCounts(reviewData);
    setInstances(instanceData);
    setSystemHealth(health);
    setNotificationCounts({ unread: notif?.count ?? 0 });
    setBackupStatus(backup);
    setCosTasks(Array.isArray(cosTasksData?.tasks) ? cosTasksData.tasks : []);
    setHealthMetrics(healthMetricsData);
    // Seed the marker with the persisted enabled flag; live sub-state starts idle and the
    // voice:* socket handlers below take over. Preserve a prior `live` across refetches so
    // a mid-turn fetchAll doesn't snap the beacon back to idle.
    setVoiceState(prev => ({ enabled: voice?.enabled ?? false, live: prev?.live || 'idle' }));
    if (characterData) setCharacter(characterData);
    setLoading(false);
  }, []);

  // Pull a fresh backup snapshot status — used after backup:completed so the vault
  // landmark reflects the new lastRun/status without a full fetchAll.
  const fetchBackup = useCallback(async () => {
    const backup = await api.getBackupStatus({ silent: true }).catch(() => null);
    if (backup) setBackupStatus(backup);
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

  // Character XP badge: there's no XP-gain socket event, so the only way an XP
  // gain (e.g. a synced JIRA ticket / completed task) surfaces in the HUD is a
  // periodic poll. The Xp badge diffs successive snapshots to fire its burst.
  // Preserve last-good character on a transient blip (don't wipe to null).
  const fetchCharacter = useCallback(async () => {
    // The HUD badge renders only the level, and this polls every 15s — `skills: false` skips
    // the server's six-domain stat fan-out that nothing here reads.
    const next = await api.getCharacter({ silent: true, skills: false }).catch(() => null);
    if (next) setCharacter(next);
  }, []);

  // Only overwrite the running-agents HUD/list when a fresh fetch lands —
  // a transient blip used to wipe the visible agents to `[]` until the
  // next successful poll.
  const fetchRunningAgents = useCallback(async () => {
    try {
      const agents = await api.getRunningAgents({ silent: true });
      setRunningAgents(agents);
    } catch {
      // preserve last-good agents on transient blip
    }
  }, []);

  // `immediate: false` — `fetchAll()` (run from the socket-setup effect below
  // and from agent socket events) already covers the initial fetch for both
  // running agents and system health; the hook then takes over the polling
  // cadence without double-fetching at mount.
  useAutoRefetch(fetchRunningAgents, 10_000, { immediate: false, pollOnly: true });
  useAutoRefetch(fetchHealth, 15_000, { immediate: false, pollOnly: true });
  useAutoRefetch(fetchCharacter, 15_000, { immediate: false, pollOnly: true });

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

  // CoS agent spawn/complete events arrive in bursts (a wave of agents starting fires
  // several within milliseconds), and each one triggers a full `fetchAll`. Coalesce those
  // socket-driven refreshes into a single trailing refetch (~120ms) so a burst costs one
  // round of requests instead of N. The mount fetch below stays immediate.
  const coalescedFetchAll = useMemo(() => coalesce(fetchAll, 120), [fetchAll]);

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
      coalescedFetchAll();
    };
    socket.on('cos:agent:spawned', handleAgentSpawned);

    const handleAgentUpdated = (updatedAgent) => {
      setCosAgents(prev => prev.map(a => a.agentId === updatedAgent.agentId ? updatedAgent : a));
    };
    socket.on('cos:agent:updated', handleAgentUpdated);

    const handleAgentCompleted = () => {
      coalescedFetchAll();
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

    // Backup vault landmark: mark in-flight on start (so the seal pulses blue), then
    // refetch on completion to pick up the fresh lastRun/status and clear `running`.
    const handleBackupStarted = () => setBackupStatus(prev => ({ ...(prev || {}), running: true }));
    // Clear `running` optimistically so the seal stops pulsing blue even if the
    // refetch fails, then pull authoritative lastRun/status from the server.
    const handleBackupCompleted = () => {
      setBackupStatus(prev => (prev?.running ? { ...prev, running: false } : prev));
      fetchBackup();
    };
    socket.on('backup:started', handleBackupStarted);
    socket.on('backup:completed', handleBackupCompleted);

    // CoS task-queue silhouette: the server broadcasts the full current task list as
    // `cos:tasks:cos:changed` on every add/modify/complete, so one handler keeps the
    // warehouse's crate stack in sync without per-event bookkeeping.
    const handleCosTasksChanged = (data) => setCosTasks(Array.isArray(data?.tasks) ? data.tasks : []);
    socket.on('cos:tasks:cos:changed', handleCosTasksChanged);

    // Voice-agent district marker: the voice pipeline emits these directly to the
    // active socket (no subscribe gate). `voice:dictation` toggles the dictating beacon,
    // `voice:error` lights it red, and `voice:idle` (turn complete / reset) returns it to
    // standby — unless dictation is still on, in which case it stays green.
    const handleVoiceDictation = (data) => setVoiceState(prev => ({
      ...(prev || { enabled: true }),
      enabled: prev?.enabled ?? true,
      live: data?.enabled ? 'dictating' : 'idle',
    }));
    const handleVoiceError = () => setVoiceState(prev => ({ ...(prev || { enabled: true }), live: 'error' }));
    const handleVoiceIdle = () => setVoiceState(prev => (
      // Keep dictating lit while a dictation session is active; a turn ending mid-dictation
      // shouldn't blink the beacon back to standby.
      prev?.live === 'dictating' ? prev : { ...(prev || { enabled: true }), live: 'idle' }
    ));
    socket.on('voice:dictation', handleVoiceDictation);
    socket.on('voice:error', handleVoiceError);
    socket.on('voice:idle', handleVoiceIdle);

    // AI Core landmark: every LLM/model call broadcasts phase-tagged `ai:status` events
    // (start → model:loading → model:loaded → complete/error) globally. Track the in-flight
    // set so the central spire glows/beams with live model activity; the pure reducer adds
    // on non-terminal phases, drops on complete/error, and prunes stale ops.
    // Prune expired ops AND clear a stale flare, re-arming while either is still pending —
    // so a `done` afterglow beam (afterglowMs), a stranded in-flight op (opMaxAgeMs), and a
    // flare-only beam (flareMs, when a fast throughput-less call left no op behind) all fade
    // without depending on a further `ai:status` event to advance the clock. Tick at the
    // afterglow cadence; both pruneAiOps and the lastStartTs clear short-circuit to no
    // re-render when nothing expired.
    const scheduleAiPrune = () => {
      if (aiPruneTimerRef.current) clearTimeout(aiPruneTimerRef.current);
      aiPruneTimerRef.current = setTimeout(() => {
        const now = Date.now();
        setAiActivity(prev => {
          const ops = pruneAiOps(prev.ops, now);
          const flareActive = prev.lastStartTs > 0 && now - prev.lastStartTs <= AI_CORE.flareMs;
          const lastStartTs = prev.lastStartTs > 0 && !flareActive ? 0 : prev.lastStartTs;
          if (ops === prev.ops && lastStartTs === prev.lastStartTs) return prev;
          return { ...prev, ops, lastStartTs };
        });
        // Decide re-arm from the ref (kept in sync with state every render), NOT from a flag
        // set inside the updater above — React doesn't guarantee that updater ran by now, so
        // reading its result synchronously would be unreliable. The ref reflects pre-tick
        // state; if anything is still within its window we re-arm and the next tick prunes it.
        const { ops: liveOps, lastStartTs: liveStart } = aiActivityRef.current;
        const flarePending = liveStart > 0 && now - liveStart <= AI_CORE.flareMs;
        if (Object.keys(pruneAiOps(liveOps, now)).length > 0 || flarePending) scheduleAiPrune();
      }, AI_CORE.afterglowMs + 100);
    };

    const handleAiStatus = (event) => {
      setAiActivity(prev => ({
        ops: applyAiStatusEvent(prev.ops, event),
        lastStartTs: event?.phase === 'start' ? Date.now() : prev.lastStartTs,
      }));
      scheduleAiPrune();
    };
    socket.on('ai:status', handleAiStatus);

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
      socket.off('backup:started', handleBackupStarted);
      socket.off('backup:completed', handleBackupCompleted);
      socket.off('cos:tasks:cos:changed', handleCosTasksChanged);
      socket.off('voice:dictation', handleVoiceDictation);
      socket.off('voice:error', handleVoiceError);
      socket.off('voice:idle', handleVoiceIdle);
      socket.off('ai:status', handleAiStatus);
      if (aiPruneTimerRef.current) clearTimeout(aiPruneTimerRef.current);
      coalescedFetchAll.cancel(); // drop any pending trailing refetch on unmount
    };
  }, [fetchAll, fetchApps, fetchBackup, coalescedFetchAll]);

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
    backupStatus,
    cosTasks,
    healthMetrics,
    voiceState,
    character,
    aiActivity,
    loading,
    connected: socket.connected,
  };
};
