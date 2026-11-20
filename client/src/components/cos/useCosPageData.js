/**
 * Owns every Chief of Staff page read, socket subscription and task/daemon mutation, and returns one state object for the page's panels and tabs.
 *
 * Single-owner hook (ChiefOfStaff page only), so it lives beside the CoS components rather than in `hooks/`. The page-level reads are keyed on the active tab alone; the selected task travels through a ref so a click never refetches or re-registers the socket listeners (#12032).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSocket } from '../../hooks/useSocket';
import { useSocketSubscription } from '../../hooks/useSocketSubscription';
import {
  updateCosConfig,
  getCosAgents,
  getCosStatus,
  getCosTasks,
  getCosHealth,
  getCosLearningSummary,
  getCosActionableInsights,
  getCosTask,
  startCos,
  stopCos,
  pauseCos,
  resumeCos,
  forceCosEvaluate,
  forceHealthCheck,
} from '../../services/apiAgents.js';
import { getProviders } from '../../services/apiProviders.js';
import { getApps } from '../../services/apiApps.js';
import { coalesce } from '../../utils/coalesce';
import { sameJsonShape } from '../../lib/sameJsonShape';
import { isAgentHandoff } from '../../lib/agentOutcome';
import { runningAgentsByTaskId, withoutSpawningTasks } from '../../lib/cosSpawnWindow';
import toast from '../ui/Toast';
import {
  STATE_MESSAGES,
  summarizeHealthIssues,
  fresherHealth,
  resolveDynamicAvatar,
} from './constants';

// cos:subscribe task-list modes (server/services/socket.js registerSubscriber):
// the page fetches its own lists on invalidation; everyone else gets full lists.
const COS_PAGE_SUBSCRIBE = { taskLists: 'invalidate' };
const COS_PAGE_RELEASE = { taskLists: 'full' };

function mergeAgentRecords(base, update) {
  if (!base) return update;
  if (!update) return base;
  return {
    ...base,
    ...update,
    metadata: {
      ...base.metadata,
      ...update.metadata,
      ...(base.metadata?.releasePublication && !update.metadata?.releasePublication
        ? { releasePublication: base.metadata.releasePublication }
        : {}),
      ...(base.metadata?.releaseSynchronization && !update.metadata?.releaseSynchronization
        ? { releaseSynchronization: base.metadata.releaseSynchronization }
        : {}),
    },
  };
}

// How long the avatar keeps "speaking" after an event that gives it something to
// say. Exported so tests drain the timer by this value rather than a literal —
// a hardcoded drain that no longer covers the timer lets a state update escape
// act() again.
export const SPEAKING_MS = 2000;

// Keep stable reference data until an explicit invalidation. A replaced read
// cannot overwrite the newer cache or clear it when the old request fails.
function readReference(cache, read, apply) {
  if (cache.current) return cache.current;
  const pending = read().then(data => {
    if (cache.current === pending) apply(data);
    return data;
  }).catch(() => { if (cache.current === pending) cache.current = null; });
  cache.current = pending;
  return pending;
}

export default function useCosPageData({ activeTab, selectedTask }) {
  // The selection is read through a ref by the page-level reads and the socket
  // handlers, so changing it changes none of their identities: a click on a
  // task must not refetch the page or re-register fourteen listeners (#12032).
  const selectedTaskRef = useRef(selectedTask);
  selectedTaskRef.current = selectedTask;

  const needsTasks = activeTab === 'tasks';
  const needsAgents = needsTasks || activeTab === 'agents';
  const needsProviders = ['tasks', 'agents', 'schedule', 'workflow'].includes(activeTab);
  const needsApps = needsProviders || activeTab === 'memory';
  // Page-level reads are keyed on the tab alone; the selection is not a page.
  const queryKey = activeTab;
  const queryRef = useRef(queryKey);
  queryRef.current = queryKey;
  const inFlight = useRef(null);
  const queuePending = useRef(null);
  const appsReadRef = useRef(null);

  const [status, setStatus] = useState(null);
  const [tasks, setTasks] = useState({ user: null, cos: null });
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [agents, setAgents] = useState([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentsError, setAgentsError] = useState(null);
  const agentReadRef = useRef(null);
  const [completedRevision, setCompletedRevision] = useState(0);
  const [taskHistoryRevision, setTaskHistoryRevision] = useState(0);
  const [health, setHealth] = useState(null);
  const [healthLoaded, setHealthLoaded] = useState(false);
  const [healthError, setHealthError] = useState(null);
  const [providers, setProviders] = useState([]);
  // Which provider an unpinned task actually runs on — the Schedule tab names it
  // on the "Default" option and resolves model/effort choices against it.
  const [activeProviderId, setActiveProviderId] = useState(null);
  // `[]` is ambiguous — "not fetched yet" vs "fetched, none configured". The
  // pickers below need the difference; see ProviderModelSelector's `loading`.
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [agentState, setAgentState] = useState('sleeping');
  const [statusReadFailed, setStatusReadFailed] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  // Socket events and manual checks share one visible speaking window. Each
  // burst owns a generation so a stale timer or request completion cannot end
  // a newer burst early.
  const speakingTimerRef = useRef(null);
  const speakingGenerationRef = useRef(0);
  const setSpeakingFor = useCallback((duration = SPEAKING_MS, generation) => {
    if (generation !== undefined && generation !== speakingGenerationRef.current) return null;
    if (speakingTimerRef.current !== null) {
      clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
    const nextGeneration = generation ?? speakingGenerationRef.current + 1;
    speakingGenerationRef.current = nextGeneration;
    if (duration <= 0) {
      setSpeaking(false);
      return nextGeneration;
    }
    setSpeaking(true);
    speakingTimerRef.current = setTimeout(() => {
      if (speakingGenerationRef.current !== nextGeneration) return;
      speakingTimerRef.current = null;
      setSpeaking(false);
    }, duration);
    return nextGeneration;
  }, []);
  useEffect(() => () => {
    speakingGenerationRef.current += 1;
    if (speakingTimerRef.current !== null) {
      clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }
  }, []);
  const [statusMessage, setStatusMessage] = useState("Idle - waiting for tasks...");
  const [liveOutputs, setLiveOutputs] = useState({});
  const [eventLogs, setEventLogs] = useState([]);
  const [activeAgentMeta, setActiveAgentMeta] = useState(null);
  const [learningSummary, setLearningSummary] = useState(null);
  // Actionable insights (blocked/approval/health counts) are fetched here in
  // fetchData and passed to ActionableInsightsBanner as a prop, so every trigger
  // that refetches CoS data — task mutations, socket-driven changes, health
  // checks, explicit refresh or reconnect — refreshes the banner without a separate signal. null
  // until the first fetch resolves; preserved across transient fetch failures.
  const [insights, setInsights] = useState(null);
  // Monotonic counter for queue/insight-state writes, so a slow fetchData cannot
  // overwrite a fresher optimistic mutation or fetchQueue result.
  const queueSeqRef = useRef(0);
  const socket = useSocket();
  // The cos:* room, refcounted with the always-mounted Layout consumers, in the
  // page's lighter "invalidate" task-list mode while it is open; the shared
  // socket goes back to full task lists when it unmounts.
  useSocketSubscription('cos', { payload: COS_PAGE_SUBSCRIBE, releasePayload: COS_PAGE_RELEASE });

  // Derive avatar style from server config, with optional dynamic override
  const configAvatarStyle = status?.config?.avatarStyle || 'svg';
  const dynamicAvatarEnabled = status?.config?.dynamicAvatar || false;
  const dynamicStyle = dynamicAvatarEnabled ? resolveDynamicAvatar(activeAgentMeta) : null;
  const avatarStyle = dynamicStyle || configAvatarStyle;

  // Update avatar style via server config
  const setAvatarStyle = async (style) => {
    await updateCosConfig({ avatarStyle: style });
    fetchData();
  };

  // ONE writer for the health snapshot, so the Issues tile, the avatar state and
  // the status bubble can never describe different health checks. The ref is
  // written synchronously alongside the state, which is what lets fetchData run
  // the freshness rule and then derive from the value it actually committed —
  // with a functional updater the merged result was only visible inside the
  // updater, so the derivation below fell back to the raw (possibly older, or
  // null) read. HTTP responses merge by check time; socket events deliver the
  // completed check directly. Only a valid accepted observation clears errors.
  const healthRef = useRef(null);
  // A read started before a successful socket/manual observation cannot mark
  // that newer result unavailable when its own transport later fails.
  const healthObservationRef = useRef(0);
  const markHealthUnavailable = useCallback((observation = healthObservationRef.current) => {
    if (observation !== healthObservationRef.current) return;
    setHealthLoaded(true);
    setHealthError('Could not observe system health. Run Check to retry.');
  }, []);
  const applyHealth = useCallback((next, { merge = false } = {}) => {
    if (!Array.isArray(next?.issues)) {
      markHealthUnavailable();
      return healthRef.current;
    }
    const resolved = merge ? fresherHealth(healthRef.current, next) : next;
    if (resolved === next) {
      healthObservationRef.current += 1;
      setHealthError(null);
    }
    healthRef.current = resolved;
    setHealth(resolved);
    setHealthLoaded(true);
    return resolved;
  }, [markHealthUnavailable]);

  // The single write path for the provider list, mirroring `applyHealth` above:
  // stamping the settle flag anywhere else could set `providers` without it.
  // `sameJsonShape` keeps the array identity stable when the payload is
  // unchanged — which it is on essentially every refresh — so the early commit
  // that fixes first-paint latency doesn't cost a full-tree re-render each tick
  // (`providers` is an unmemoized prop down through every schedule card).
  const applyProviders = useCallback((data) => {
    setProviders(prev => (sameJsonShape(prev, data.providers || []) ? prev : data.providers || []));
    setActiveProviderId(data.activeProvider || null);
    setProvidersLoaded(true);
    return data;
  }, []);

  // Same self-committing-read fix as `applyProviders`, for the same reason: apps
  // feeds the Schedule/Tasks/Agents app pickers, so bundling it into
  // `secondaryRead`'s Promise.all held it hostage to `getCosActionableInsights`
  // (a server-side health check) and left those pickers showing an empty list
  // for seconds. `sameJsonShape` keeps the array identity stable on an unchanged
  // refresh payload so this doesn't cost a full-tree re-render each tick.
  const applyApps = useCallback((data) => {
    const filtered = (Array.isArray(data) ? data : []).filter(a => a.id !== 'portos-autofixer');
    setApps(prev => (sameJsonShape(prev, filtered) ? prev : filtered));
    return filtered;
  }, []);

  // Derive agent state from system status
  const deriveAgentState = useCallback((statusData, agentsData, healthData) => {
    if (!statusData?.running) return 'sleeping';
    if (statusData.paused) return 'sleeping';

    const activeAgents = agentsData.filter(a => a.status === 'running');
    if (activeAgents.length > 0 || statusData.activeAgents > 0) return 'coding';

    if (healthData?.issues?.length > 0) return 'investigating';

    // When running but idle, show as thinking (ready to work)
    return 'thinking';
  }, []);

  // Agent snapshots settle independently of status/tasks. Overlay socket changes
  // received during the read so a slow snapshot cannot undo a live transition.
  const readAgents = useCallback(async (controller) => {
    if (!needsAgents) return null;
    const request = { updates: new Map() };
    agentReadRef.current = request;
    const data = await getCosAgents({ active: true, signal: controller.signal, silent: true }).catch(() => null);
    if (controller.signal.aborted || queryRef.current !== queryKey || agentReadRef.current !== request) return null;
    agentReadRef.current = null;
    if (Array.isArray(data)) {
      const merged = new Map(data.map(agent => [agent.id, agent]));
      for (const [id, agent] of request.updates) merged.set(id, mergeAgentRecords(merged.get(id), agent));
      const snapshot = [...merged.values()].filter(agent => agent.status !== 'completed' || agent.deliveryPending);
      setAgents(snapshot);
      setAgentsLoaded(true);
      setAgentsError(null);
    } else {
      setAgentsError('Could not load active agents.');
    }
    // Opening Agents must not wait for unrelated status or task summaries.
    if (activeTab === 'agents') setLoading(false);
    return data;
  }, [needsAgents, queryKey, activeTab]);

  const fetchData = useCallback(async function refreshPageData() {
    const route = activeTab;
    if (inFlight.current?.key === queryKey && !inFlight.current.controller.signal.aborted) {
      inFlight.current.dirty = true;
      return inFlight.current.promise;
    }
    inFlight.current?.controller.abort();
    const controller = new AbortController();
    const read = async () => {
      const queueSeq = queueSeqRef.current;
      // Paint the visible queue before ancillary summaries and references settle.
      const coreRead = Promise.all([
        getCosStatus().catch(() => null),
        needsTasks ? getCosTasks({ view: 'queue', selected: selectedTaskRef.current, signal: controller.signal, silent: true }).catch(() => null) : Promise.resolve(null),
        readAgents(controller),
      ]);
      const healthObservation = healthObservationRef.current;
      const healthRead = getCosHealth({ signal: controller.signal, silent: true }).catch(() => null).then((data) => {
        if (controller.signal.aborted || queryRef.current !== queryKey) return null;
        if (!Array.isArray(data?.issues)) {
          markHealthUnavailable(healthObservation);
          return null;
        }
        // Health is independently useful to the Health tab. Commit it as soon
        // as its own read settles instead of making that tab wait for the slower
        // actionable-insights request in the same batch.
        applyHealth(data, { merge: true });
        return data;
      });
      // The API shares its provider snapshot across all pages and pickers.
      const providersRead = needsProviders ? getProviders().then(applyProviders).catch(() => {}) : Promise.resolve();
      // Same rationale as providersRead above: apps commits on its own settle
      // instead of waiting on the slower siblings in secondaryRead.
      const appsRead = needsApps ? readReference(appsReadRef, getApps, applyApps) : Promise.resolve();
      const secondaryRead = Promise.all([
        getCosLearningSummary().catch(() => null),
        // Preserve the last good insights on a transient refresh failure.
        needsTasks ? getCosActionableInsights({ cachedHealth: true, silent: true }).catch(() => null) : Promise.resolve(null)
      ]);

      const [statusData, tasksData, agentResult] = await coreRead;
      if (controller.signal.aborted || queryRef.current !== queryKey) return;
      const agentsData = agentResult || [];
      setStatus(statusData);
      setStatusReadFailed(typeof statusData?.running !== 'boolean');
      // A queue refresh started later can still resolve first. Its task payload
      // must not be clobbered by this older, pre-flip read — otherwise the row
      // returns to the pending-AND-active state this guard exists to remove.
      if (queueSeqRef.current === queueSeq) {
        if (tasksData) setTasks(tasksData);
      }

      setLoading(false);

      // Paint the shell and queue before waiting for health, providers, apps,
      // learning, and insights. Those values fill in below without delaying the
      // tab the user asked to open.
      const initialHealth = healthRef.current;
      const initialState = deriveAgentState(statusData, agentsData, initialHealth);
      setAgentState(initialState);
      setStatusMessage(statusData?.paused
        ? `Paused${statusData.pauseReason ? ` — ${statusData.pauseReason}` : ''}`
        : (initialState === 'investigating' && summarizeHealthIssues(initialHealth?.issues)) || STATE_MESSAGES[initialState]);
      const runningAgent = agentsData.find(a => a.status === 'running');
      setActiveAgentMeta(runningAgent?.metadata || null);

      const [learningSummaryData, insightsData] = await secondaryRead;
      // All three self-committing reads are barriers, not values: `mergedHealth`
      // below reads what `healthRead` wrote, so it must not run before they settle.
      await Promise.all([healthRead, providersRead, appsRead]);
      // Health events may have delivered a newer snapshot while these reads settled.
      if (controller.signal.aborted || queryRef.current !== queryKey) return;
      const mergedHealth = healthRef.current;
      setLearningSummary(learningSummaryData);
      // Apply a real insights payload (including a legitimately-empty []); a null
      // from a failed/transient fetch preserves the last-good array so the banner
      // doesn't flicker empty on a blip.
      if (insightsData?.insights && queueSeqRef.current === queueSeq) setInsights(insightsData.insights);

      const newState = deriveAgentState(statusData, agentsData, mergedHealth);
      setAgentState(newState);
      // Default state message — richer messages come from socket events. The one
      // state whose default is useless is `investigating`: only a health issue
      // gets us here, so name it rather than saying "Investigating issue..." next
      // to an Active count of 0 with no agent to inspect.
      setStatusMessage(statusData?.paused
        ? `Paused${statusData.pauseReason ? ` — ${statusData.pauseReason}` : ''}`
        : (newState === 'investigating' && summarizeHealthIssues(mergedHealth?.issues)) || STATE_MESSAGES[newState]);

    };
    const pending = { route, key: queryKey, promise: null, controller, dirty: false };
    inFlight.current = pending;
    pending.promise = read().finally(() => {
      if (inFlight.current === pending) inFlight.current = null;
      if (pending.dirty && !controller.signal.aborted && queryRef.current === queryKey) refreshPageData();
    });
    return pending.promise;
  }, [activeTab, queryKey, needsTasks, needsAgents, needsProviders, needsApps, deriveAgentState, applyHealth, markHealthUnavailable, applyProviders, applyApps, readAgents]);

  // Coalesce event bursts into a read of the visible queue and scalar shell
  // status. Insights use persisted health; invalidation never runs PM2 repair.
  const fetchQueue = useCallback(async function refreshQueueData() {
    if (queuePending.current?.key === queryKey && !queuePending.current.controller.signal.aborted) {
      queuePending.current.dirty = true;
      return queuePending.current.promise;
    }
    queuePending.current?.controller.abort();
    const controller = new AbortController();
    const request = { key: queryKey, controller, dirty: false, promise: null };
    queuePending.current = request;
    const queueSeq = ++queueSeqRef.current;
    const insightsRead = needsTasks
      ? getCosActionableInsights({ cachedHealth: true, silent: true }).catch(() => null)
      : Promise.resolve(null);
    request.promise = Promise.all([
      getCosStatus().catch(() => null),
      needsTasks ? getCosTasks({ view: 'queue', selected: selectedTaskRef.current, signal: controller.signal, silent: true }).catch(() => null) : null,
      readAgents(controller),
    ]).then(async ([summary, tasksData]) => {
      if (controller.signal.aborted || queryRef.current !== queryKey || queueSeqRef.current !== queueSeq) return;
      if (summary) setStatus(summary);
      if (tasksData) setTasks(tasksData);
      const insightsData = await insightsRead;
      if (!controller.signal.aborted && queueSeqRef.current === queueSeq && insightsData?.insights) setInsights(insightsData.insights);
    }).finally(() => {
      if (queuePending.current === request) queuePending.current = null;
      if (request.dirty && !controller.signal.aborted && queryRef.current === queryKey) refreshQueueData();
    });
    return request.promise;
  }, [queryKey, needsTasks, readAgents]);

  // All page insight reads use cached health. Explicit Run Check owns repairs;
  // task invalidations must never trigger a health-check/socket feedback loop.


  // Initial route load only. Socket invalidations and reconnect recover updates.
  useEffect(() => {
    fetchData();
    return () => { inFlight.current?.controller.abort(); queuePending.current?.controller.abort(); };
  }, [fetchData]);

  // The selection-dependent read. The mount read already carries `selected`,
  // so a deep link costs nothing extra; a later selection that is not in the
  // loaded lists (a historical task opened from a summary link) costs exactly
  // one record read, merged into the list it belongs to.
  useEffect(() => {
    if (!selectedTask || !needsTasks) return undefined;
    const { user, cos } = tasksRef.current;
    if (!user && !cos) return undefined;
    const loaded = [...(user?.tasks || []), ...(cos?.tasks || [])];
    if (loaded.some(task => task.id === selectedTask)) return undefined;
    let active = true;
    getCosTask(selectedTask, { silent: true }).then((found) => {
      if (!active || !found?.task) return;
      const key = found.source === 'internal' ? 'cos' : 'user';
      setTasks(prev => {
        const list = prev[key];
        if (!list) return prev;
        return { ...prev, [key]: { ...list, tasks: [...(list.tasks || []).filter(task => task.id !== found.task.id), found.task] } };
      });
    }).catch(() => {});
    return () => { active = false; };
  }, [selectedTask, needsTasks]);


  useEffect(() => {
    if (!socket) return;

    // Reconnect recovery; the subscription itself lives in useSocketSubscription above.
    const reconnect = () => {
      appsReadRef.current = null;
      fetchData();
      setCompletedRevision(value => value + 1);
      setTaskHistoryRevision(value => value + 1);
    };
    socket.on('connect', reconnect);

    const handleCosStatus = (data) => {
      setStatus(prev => ({ ...prev, running: data.running }));
      fetchQueue();
      if (!data.running) {
        setAgentState('sleeping');
        setStatusMessage("Stopped - daemon not running");
        setActiveAgentMeta(null);
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

    const handleAgentSpawned = (data) => {
      if (needsAgents && data?.id) {
        agentReadRef.current?.updates.set(data.id, data);
        setAgents(prev => [...prev.filter(agent => agent.id !== data.id), data]);
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
      if (data?.agentId || data?.id) {
        setLiveOutputs(prev => ({ ...prev, [data.agentId || data.id]: [] }));
      }
      fetchQueue();
    };
    socket.on('cos:agent:spawned', handleAgentSpawned);

    const handleAgentUpdated = (updatedAgent) => {
      if (!needsAgents) return;
      const updates = agentReadRef.current?.updates;
      updates?.set(updatedAgent.id, mergeAgentRecords(updates.get(updatedAgent.id), updatedAgent));
      // Update the specific agent in the agents list without fetching all data
      setAgents(prev => prev.map(agent =>
        agent.id === updatedAgent.id ? mergeAgentRecords(agent, updatedAgent) : agent
      ).filter(agent => agent.status !== 'completed' || agent.deliveryPending));
      if (updatedAgent.status === 'completed' || updatedAgent.metadata?.releaseSynchronization) {
        setCompletedRevision(value => value + 1);
      }
    };
    socket.on('cos:agent:updated', handleAgentUpdated);

    const handleAgentOutput = (data) => {
      if (needsAgents && data?.agentId && data?.line) {
        setLiveOutputs(prev => {
          const existing = prev[data.agentId] || [];
          const updated = [...existing, { line: data.line, timestamp: Date.now() }];
          return { ...prev, [data.agentId]: updated.length > 500 ? updated.slice(-500) : updated };
        });
      }
    };
    socket.on('cos:agent:output', handleAgentOutput);

    const handleAgentCompleted = (data) => {
      const id = data?.id || data?.agentId;
      if (needsAgents && id) {
        agentReadRef.current?.updates.set(id, { ...data, id, status: 'completed' });
        setAgents(prev => prev.filter(agent => agent.id !== id));
      }
      setCompletedRevision(value => value + 1);
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
      // Clean up live output buffer for completed agent to prevent memory growth
      if (data?.agentId) {
        setLiveOutputs(prev => {
          const { [data.agentId]: _, ...rest } = prev;
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
      if (needsAgents && event?.id === 'cos-pending-merge-sweep') refreshQueue();
    };
    socket.on('cos:scheduler:changed', handleRecoveryScheduleChanged);

    // Stable reference data has its own invalidation path, independent of the queue.
    const handleAppsChanged = coalesce(() => {
      appsReadRef.current = null;
      if (needsApps) readReference(appsReadRef, getApps, applyApps);
    }, 400);
    const handleProvidersChanged = coalesce(() => {
      if (needsProviders) getProviders().then(applyProviders).catch(() => {});
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
      socket.off('cos:agent:completed', handleAgentCompleted);
      socket.off('cos:health:check', handleHealthCheck);
      socket.off('cos:log', handleCosLog);
      socket.off('cos:scheduler:changed', handleRecoveryScheduleChanged);
      socket.off('apps:changed', handleAppsChanged);
      refreshQueue.cancel();
    };
  }, [socket, fetchData, fetchQueue, needsAgents, needsTasks, needsApps, needsProviders, applyApps, applyProviders, setSpeakingFor]);

  const handleStart = async () => {
    const result = await startCos({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Chief of Staff started');
      setAgentState('thinking');
      setStatusMessage("Starting daemon - scanning for tasks...");
      setSpeakingFor();
      fetchData();
    }
  };

  const handleStop = async () => {
    const result = await stopCos({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Chief of Staff stopped');
      setAgentState('sleeping');
      setStatusMessage("Stopped - daemon not running");
      fetchData();
    }
  };

  const handlePause = async () => {
    const reason = 'Paused from Chief of Staff controls';
    const result = await pauseCos(reason, { silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Chief of Staff paused');
      setStatus(prev => ({ ...prev, paused: true, pausedAt: result.pausedAt, pauseReason: reason }));
      setAgentState('sleeping');
      setStatusMessage(`Paused — ${reason}`);
      fetchData();
    }
  };

  const handleResume = async () => {
    const result = await resumeCos({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Chief of Staff resumed');
      setStatus(prev => ({ ...prev, paused: false, pausedAt: null, pauseReason: null }));
      setAgentState('thinking');
      setStatusMessage('Resuming daemon - scanning for tasks...');
      fetchData();
    }
  };

  const handleForceEvaluate = async () => {
    // Only announce success / drive the "thinking" state after the request
    // actually resolves — a failed evaluate must not flash a success toast.
    try {
      await forceCosEvaluate({ silent: true });
      toast.success('Evaluation triggered');
      setAgentState('thinking');
      setStatusMessage("Evaluating tasks...");
      setSpeakingFor();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleTaskUnblocked = useCallback((taskId) => {
    // A full refresh starts before its first await, so invalidate any read that
    // began before this confirmed mutation. Otherwise its pre-unblock snapshot
    // can put the task and insight back into the blocked state after our local
    // update has already rendered.
    queueSeqRef.current += 1;
    setTasks(prev => {
      const unblockSlice = (slice) => {
        if (!slice) return slice;
        const blockedTask = slice.grouped?.blocked?.find(t => t.id === taskId);
        const existingTask = slice.tasks?.find(t => t.id === taskId) || blockedTask;
        if (!existingTask) return slice;
        const unblocked = { ...existingTask, status: 'pending', metadata: { ...existingTask.metadata, blocker: undefined, blockedReason: undefined } };
        const currentPending = slice.grouped?.pending || [];
        const pending = currentPending.some(t => t.id === taskId)
          ? currentPending.map(t => t.id === taskId ? unblocked : t)
          : [...currentPending, unblocked];
        return {
          ...slice,
          tasks: slice.tasks?.map(t => t.id === taskId ? unblocked : t),
          grouped: {
            ...slice.grouped,
            blocked: slice.grouped?.blocked?.filter(t => t.id !== taskId) || [],
            pending
          }
        };
      };
      return {
        ...prev,
        user: unblockSlice(prev.user),
        cos: unblockSlice(prev.cos)
      };
    });
    setInsights(prev => {
      if (!Array.isArray(prev)) return prev;
      return prev.flatMap(insight => {
        if (insight.type !== 'blocked' || !Array.isArray(insight.tasks)) return [insight];
        const remaining = insight.tasks.filter(task => task.id !== taskId);
        if (remaining.length === insight.tasks.length) return [insight];
        if (remaining.length === 0) return [];
        const firstRemaining = remaining[0];
        return [{
          ...insight,
          title: `${remaining.length} blocked task${remaining.length > 1 ? 's' : ''}`,
          description: firstRemaining.blocker || firstRemaining.description || insight.description,
          count: remaining.length,
          tasks: remaining,
        }];
      });
    });
  }, []);

  const handleTaskDeleted = useCallback((taskId, taskSource) => {
    queueSeqRef.current += 1;
    setTasks(prev => {
      const deleteSlice = (slice) => {
        if (!slice) return slice;
        const tasks = slice.tasks?.filter(t => t.id !== taskId);
        const filterSlice = (list) => list?.filter(t => t.id !== taskId);
        const grouped = slice.grouped ? {
          pending: filterSlice(slice.grouped.pending),
          in_progress: filterSlice(slice.grouped.in_progress),
          challenged: filterSlice(slice.grouped.challenged),
          blocked: filterSlice(slice.grouped.blocked),
          completed: filterSlice(slice.grouped.completed),
        } : undefined;
        return {
          ...slice,
          tasks,
          ...(grouped ? { grouped } : {}),
        };
      };
      if (taskSource === 'internal' || taskSource === 'cos') {
        return { ...prev, cos: deleteSlice(prev.cos) };
      }
      if (taskSource === 'user') {
        return { ...prev, user: deleteSlice(prev.user) };
      }
      return { ...prev, user: deleteSlice(prev.user), cos: deleteSlice(prev.cos) };
    });
    setInsights(prev => {
      if (!Array.isArray(prev)) return prev;
      return prev.flatMap(insight => {
        if (insight.type !== 'blocked' || !Array.isArray(insight.tasks)) return [insight];
        const remaining = insight.tasks.filter(task => task.id !== taskId);
        if (remaining.length === insight.tasks.length) return [insight];
        if (remaining.length === 0) return [];
        const firstRemaining = remaining[0];
        return [{
          ...insight,
          title: `${remaining.length} blocked task${remaining.length > 1 ? 's' : ''}`,
          description: firstRemaining.blocker || firstRemaining.description || insight.description,
          count: remaining.length,
          tasks: remaining,
        }];
      });
    });
  }, []);

  // A successful task POST returns the persisted task synchronously. Insert it
  // into the queue right away so the user gets a durable pending indication
  // before the scheduler's socket updates report its active transition.
  const handleUserTaskAdded = useCallback((task, { position = 'bottom' } = {}) => {
    if (!task?.id) return;
    // A full-data read started before the POST resolved carries a queue snapshot
    // that cannot contain this task. Retire it before inserting the confirmed
    // record, just as fetchQueue does for socket-driven updates.
    queueSeqRef.current += 1;
    setTasks(prev => {
      const current = prev.user?.tasks || [];
      if (current.some(existing => existing.id === task.id)) return prev;
      const nextTasks = position === 'top' ? [task, ...current] : [...current, task];
      const grouped = {
        pending: nextTasks.filter(item => item.status === 'pending'),
        in_progress: nextTasks.filter(item => item.status === 'in_progress'),
        challenged: nextTasks.filter(item => item.status === 'challenged'),
        blocked: nextTasks.filter(item => item.status === 'blocked'),
        completed: nextTasks.filter(item => item.status === 'completed'),
      };
      return {
        ...prev,
        user: {
          ...(prev.user || { exists: true, type: 'user' }),
          tasks: nextTasks,
          grouped,
        },
      };
    });
  }, []);

  const handleHealthCheck = async () => {
    setAgentState('investigating');
    setStatusMessage("Running system health check...");
    const speakingGeneration = setSpeakingFor();
    const healthObservation = healthObservationRef.current;
    const result = await forceHealthCheck({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setSpeakingFor(0, speakingGeneration);
    if (Array.isArray(result?.issues)) {
      const checkedHealth = applyHealth({ lastCheck: result.metrics?.timestamp, issues: result.issues }, { merge: true });
      // The Health route does not load the Tasks-only insights banner.
      toast.success('Health check complete');
      if (checkedHealth.issues.length > 0) {
        setStatusMessage(summarizeHealthIssues(checkedHealth.issues));
      } else {
        setAgentState('sleeping');
        setStatusMessage("Health check passed - all systems OK");
      }
    } else {
      markHealthUnavailable(healthObservation);
      if (healthObservation === healthObservationRef.current) setStatusMessage('System health unavailable');
    }
  };

  const activeAgentCount = useMemo(() =>
    needsAgents ? agents.filter(a => a.status === 'running').length : status?.activeAgents || 0,
    [agents, needsAgents, status?.activeAgents]
  );

  // Memoize pending task count, settled against the live agent list.
  //
  // GET /api/cos/tasks already settles `grouped.pending` for the spawn window,
  // but `activeAgentCount` above reads the SOCKET-fed agent array, which lands on
  // 'cos:agent:spawned' — ahead of the next task fetch. Counting the payload raw
  // would tick Active to 1 while Pending still read 1 until that fetch returned,
  // which is the "1 pending and 1 active" this page is the headline surface for.
  // Same settlement TasksTab makes from the same two arrays, so the header cards
  // and the task list below them cannot disagree. See lib/cos/cosSpawnWindow.js.
  const runningAgentByTaskId = useMemo(() => runningAgentsByTaskId(agents), [agents]);
  const pendingTaskCount = useMemo(() =>
    needsTasks ? withoutSpawningTasks(tasks.user?.grouped?.pending, runningAgentByTaskId).length
      + withoutSpawningTasks(tasks.cos?.grouped?.pending, runningAgentByTaskId).length : status?.pendingTasks || 0,
    [tasks.user?.grouped?.pending, tasks.cos?.grouped?.pending, runningAgentByTaskId, needsTasks, status?.pendingTasks]
  );

  return {
    status,
    statusReadFailed,
    tasks,
    agents,
    agentsLoaded,
    agentsError,
    completedRevision,
    taskHistoryRevision,
    health,
    healthLoaded,
    healthError,
    providers,
    providersLoaded,
    activeProviderId,
    apps,
    loading,
    agentState,
    speaking,
    statusMessage,
    liveOutputs,
    eventLogs,
    learningSummary,
    insights,
    configAvatarStyle,
    avatarStyle,
    activeAgentCount,
    pendingTaskCount,
    fetchData,
    fetchQueue,
    setAvatarStyle,
    handleStart,
    handleStop,
    handlePause,
    handleResume,
    handleForceEvaluate,
    handleHealthCheck,
    handleTaskUnblocked,
    handleTaskDeleted,
    handleUserTaskAdded,
  };
}
