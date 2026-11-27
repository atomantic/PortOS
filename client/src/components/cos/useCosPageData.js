/**
 * Loads page and tab snapshots and reconciles confirmed task mutations with pending reads.
 *
 * Single-owner hook (ChiefOfStaff page only), so it lives beside the CoS components rather than in `hooks/`. Reads are split by what changes them, not by tab (#18643): the shell (status, health, learning) loads on mount and on reconnect/config events; each slice (queue + insights, active agents, providers, apps) loads when its `needs*` flag first turns true. Tab, selection and the `needs*` flags all travel through refs, so neither a tab switch nor a task click refetches the page or re-registers the socket listeners (#12032).
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSocketSubscription } from '../../hooks/useSocketSubscription';
import useMounted from '../../hooks/useMounted';
import {
  getCosAgents,
  getCosStatus,
  getCosTasks,
  getCosHealth,
  getCosLearningSummary,
  getCosActionableInsights,
  getCosTask,
} from '../../services/apiAgents.js';
import { getProviders } from '../../services/apiProviders.js';
import { getApps } from '../../services/apiApps.js';
import { mergeAgentRecords } from '../../lib/mergeCosAgentRecords';
import { sameJsonShape } from '../../lib/sameJsonShape';
import { runningAgentsByTaskId, withoutSpawningTasks } from '../../lib/cosSpawnWindow';
import { fresherHealth } from './constants';
import useCosAvatarState from './useCosAvatarState';
import useCosSocketSync from './useCosSocketSync';
import useCosDaemonActions from './useCosDaemonActions';

export { SPEAKING_MS } from './useCosAvatarState';

// cos:subscribe task-list modes (server/services/socket.js registerSubscriber):
// the page fetches its own lists on invalidation; everyone else gets full lists.
const COS_PAGE_SUBSCRIBE = { taskLists: 'invalidate' };
const COS_PAGE_RELEASE = { taskLists: 'full' };

function pruneBlockedTaskInsight(prev, taskId) {
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
}

// Keep stable reference data until an explicit invalidation. A replaced read
// cannot overwrite the newer cache or clear it when the old request fails.
function readReference(cache, read, apply, onError) {
  if (cache.current) return cache.current;
  const pending = read().then(data => {
    if (cache.current === pending) apply(data);
    return data;
  }).catch(() => {
    if (cache.current !== pending) return;
    cache.current = null;
    onError();
  });
  cache.current = pending;
  return pending;
}

function useCosPageSnapshot({ activeTab, selectedTask }) {
  // The selection is read through a ref by the page-level reads and the socket
  // handlers, so changing it changes none of their identities: a click on a
  // task must not refetch the page or re-register fourteen listeners (#12032).
  const selectedTaskRef = useRef(selectedTask);
  selectedTaskRef.current = selectedTask;

  const needsTasks = activeTab === 'tasks';
  const needsAgents = needsTasks || activeTab === 'agents';
  const needsProviders = ['tasks', 'agents', 'schedule', 'workflow'].includes(activeTab);
  const needsApps = needsProviders || activeTab === 'memory';
  // Handlers and reads consult the live flags through this ref, so a tab switch
  // changes none of their identities (the socket listeners register once per
  // visit). The selection is not a page and is not part of it.
  const needsRef = useRef({});
  needsRef.current = { tab: activeTab, tasks: needsTasks, agents: needsAgents, providers: needsProviders, apps: needsApps };
  // Bumped whenever a slice's flag flips either way. A read that began under an
  // earlier epoch belongs to an activation that has since ended, so it is dropped
  // rather than written (the Mind -> Agents -> Mind -> Agents round trip must not
  // let the first read land after the second).
  const sliceEpochRef = useRef({ tasks: 0, agents: 0 });
  const prevNeedsRef = useRef({ tasks: needsTasks, agents: needsAgents, providers: needsProviders, apps: needsApps });
  const tasksSliceRef = useRef(null);
  const agentsSliceRef = useRef(null);
  // Resolvers for reads that a full refresh or queue refresh is still awaiting.
  // Ending a slice's epoch releases them, so a hung Tasks read cannot hold the
  // loading skeleton (or the rest of a refresh) after the user has moved on.
  const sliceWaitersRef = useRef(new Set());
  const mountedRef = useMounted();
  const learningSeqRef = useRef(0);
  const inFlight = useRef(null);
  const queuePending = useRef(null);
  const appsReadRef = useRef(null);

  const [status, setStatus] = useState(null);
  const [statusReadFailed, setStatusReadFailed] = useState(false);
  const statusRef = useRef(null);
  const applyStatus = useCallback((next) => {
    statusRef.current = typeof next === 'function' ? next(statusRef.current) : next;
    setStatus(statusRef.current);
  }, []);
  // Status reads (the shell read and every queue refresh) are applied in the order
  // they were issued: a read that started before an already-applied one is dropped,
  // so an older shell response cannot put back a stopped daemon a newer one has
  // reported running. Socket merges are not reads and are not ranked.
  const statusReadIssuedRef = useRef(0);
  const statusReadAppliedRef = useRef(0);
  const readStatus = useCallback(() => {
    const seq = ++statusReadIssuedRef.current;
    return getCosStatus().catch(() => null).then(data => ({ seq, data }));
  }, []);
  const applyStatusRead = useCallback(({ seq, data }) => {
    if (seq < statusReadAppliedRef.current) return false;
    statusReadAppliedRef.current = seq;
    const config = data?.config;
    const valid = typeof data?.running === 'boolean' && config != null
      && typeof config === 'object' && !Array.isArray(config);
    setStatusReadFailed(!valid);
    // A failed read leaves daemon status unknown but must not reset saved settings.
    applyStatus(prev => valid ? data : (prev?.config ? { config: prev.config } : null));
    return valid;
  }, [applyStatus]);
  const [tasks, setTasks] = useState({ user: null, cos: null });
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [agents, setAgents] = useState([]);
  // `agents` and `status` are written through `applyAgents` / `applyStatus`, which
  // update a ref in the same call. A shell read that settles after an agent slice
  // read or a socket event then derives avatar state from the newest values
  // instead of from its own captured, possibly superseded, snapshot.
  const agentsRef = useRef([]);
  const applyAgents = useCallback((next) => {
    agentsRef.current = typeof next === 'function' ? next(agentsRef.current) : next;
    setAgents(agentsRef.current);
  }, []);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentsError, setAgentsError] = useState(null);
  const agentReadRef = useRef(null);
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
  const [appsStatus, setAppsStatus] = useState('loading');
  const [loading, setLoading] = useState(true);
  // False until the latest provider read succeeded; a failed invalidation after a
  // good load keeps the last list but stays retryable on the next tab switch.
  const providersCurrentRef = useRef(false);
  const lastTabRef = useRef(activeTab);
  const [learningSummary, setLearningSummary] = useState(null);
  // Actionable insights (blocked/approval/health counts) are fetched here with
  // the queue and passed to ActionableInsightsBanner as a prop, so every trigger
  // that refetches the queue — task mutations, socket-driven changes, explicit
  // refresh, reconnect or opening the Tasks tab — refreshes the banner without a
  // separate signal. null until the first fetch resolves; preserved across
  // transient fetch failures.
  const [insights, setInsights] = useState(null);
  // Monotonic counter for queue/insight-state writes, so a slow fetchData cannot
  // overwrite a fresher optimistic mutation or fetchQueue result.
  const queueSeqRef = useRef(0);

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
    providersCurrentRef.current = true;
    return data;
  }, []);

  const readProviders = useCallback(
    () => getProviders().then(applyProviders).catch(() => { providersCurrentRef.current = false; }),
    [applyProviders],
  );

  // Same self-committing-read fix as `applyProviders`, for the same reason: apps
  // feeds the Schedule/Tasks/Agents app pickers, so bundling it into
  // `secondaryRead`'s Promise.all held it hostage to `getCosActionableInsights`
  // (a server-side health check) and left those pickers showing an empty list
  // for seconds. `sameJsonShape` keeps the array identity stable on an unchanged
  // refresh payload so this doesn't cost a full-tree re-render each tick.
  const applyApps = useCallback((data) => {
    if (!Array.isArray(data)) throw new Error('Invalid app list');
    const filtered = data.filter(a => a.id !== 'portos-autofixer');
    setApps(prev => (sameJsonShape(prev, filtered) ? prev : filtered));
    setAppsStatus('ready');
    return filtered;
  }, []);

  const readApps = useCallback(() => {
    if (!appsReadRef.current) setAppsStatus('loading');
    return readReference(appsReadRef, getApps, applyApps, () => setAppsStatus('error'));
  }, [applyApps]);

  const avatar = useCosAvatarState({ status, statusRef, agentsRef, needsRef, healthRef });
  const { agentStateRef, setActiveAgentMeta, settleAgentState } = avatar;

  // Agent snapshots settle independently of status/tasks. Overlay socket changes
  // received during the read so a slow snapshot cannot undo a live transition.
  const readAgents = useCallback(async (controller) => {
    if (!needsRef.current.agents) return null;
    const epoch = sliceEpochRef.current.agents;
    const request = { updates: new Map() };
    agentReadRef.current = request;
    const data = await getCosAgents({ active: true, signal: controller.signal, silent: true }).catch(() => null);
    if (controller.signal.aborted || sliceEpochRef.current.agents !== epoch || !needsRef.current.agents || agentReadRef.current !== request) {
      if (agentReadRef.current === request) agentReadRef.current = null;
      return null;
    }
    agentReadRef.current = null;
    if (Array.isArray(data)) {
      const merged = new Map(data.map(agent => [agent.id, agent]));
      for (const [id, agent] of request.updates) merged.set(id, mergeAgentRecords(merged.get(id), agent));
      const snapshot = [...merged.values()].filter(agent => agent.status !== 'completed' || agent.deliveryPending);
      applyAgents(snapshot);
      setAgentsLoaded(true);
      setAgentsError(null);
    } else {
      setAgentsError('Could not load active agents.');
    }
    // Opening Agents must not wait for unrelated status or task summaries.
    if (needsRef.current.tab === 'agents') setLoading(false);
    return data;
  }, [applyAgents]);

  // The learning tile is shell data fed by two writers (the full read and an
  // agent completion), so the newest request wins and a failed refresh keeps
  // the last good summary instead of blanking the tile.
  const refreshLearningSummary = useCallback(async () => {
    const seq = ++learningSeqRef.current;
    let failed = false;
    const data = await getCosLearningSummary().catch(() => { failed = true; return null; });
    if (failed || seq !== learningSeqRef.current || !mountedRef.current) return;
    setLearningSummary(data);
  }, [mountedRef]);

  // The full refresh: shell (status, health, learning) plus every slice the
  // current tab needs. Used on mount, reconnect, config/pause events and
  // explicit refreshes; opening a tab reads only the slices it newly needs.
  // Await a slice read only while its epoch lasts: if the slice's flag flips
  // first, resolve null and let the read settle into the void (its own writes are
  // already epoch-guarded).
  const awaitSlice = useCallback((kind, read) => {
    return Promise.race([read, new Promise((resolve) => {
      const waiter = { kind, resolve };
      sliceWaitersRef.current.add(waiter);
      read.finally(() => sliceWaitersRef.current.delete(waiter));
    })]);
  }, []);

  const fetchData = useCallback(async function refreshPageData() {
    if (inFlight.current && !inFlight.current.controller.signal.aborted) {
      inFlight.current.dirty = true;
      return inFlight.current.promise;
    }
    const controller = new AbortController();
    const read = async () => {
      const queueSeq = queueSeqRef.current;
      const needs = needsRef.current;
      const tasksEpoch = sliceEpochRef.current.tasks;
      const tasksCurrent = () => needsRef.current.tasks && sliceEpochRef.current.tasks === tasksEpoch;
      // This read carries the queue, so it supersedes a slice read still in flight
      // (a reconnect while a just-opened Tasks tab is loading).
      if (needs.tasks) tasksSliceRef.current?.abort();
      // Paint the visible queue before ancillary summaries and references settle.
      const coreRead = Promise.all([
        readStatus(),
        needs.tasks ? awaitSlice('tasks', getCosTasks({ view: 'queue', selected: selectedTaskRef.current, signal: controller.signal, silent: true }).catch(() => null)) : Promise.resolve(null),
        awaitSlice('agents', readAgents(controller)),
      ]);
      const healthObservation = healthObservationRef.current;
      const healthRead = getCosHealth({ signal: controller.signal, silent: true }).catch(() => null).then((data) => {
        if (controller.signal.aborted) return null;
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
      const providersRead = needs.providers ? readProviders() : Promise.resolve();
      // Same rationale as providersRead above: apps commits on its own settle
      // instead of waiting on the slower siblings in secondaryRead.
      const appsRead = needs.apps ? readApps() : Promise.resolve();
      const learningSeq = ++learningSeqRef.current;
      const secondaryRead = Promise.all([
        getCosLearningSummary().catch(() => null),
        // Preserve the last good insights on a transient refresh failure.
        needs.tasks ? awaitSlice('tasks', getCosActionableInsights({ cachedHealth: true, silent: true }).catch(() => null)) : Promise.resolve(null)
      ]);

      const [statusRead, tasksData] = await coreRead;
      if (controller.signal.aborted) return;
      applyStatusRead(statusRead);
      // A queue refresh started later can still resolve first. Its task payload
      // must not be clobbered by this older, pre-flip read — otherwise the row
      // returns to the pending-AND-active state this guard exists to remove.
      if (queueSeqRef.current === queueSeq && tasksCurrent()) {
        if (tasksData) setTasks(tasksData);
      }

      setLoading(false);

      // Paint the shell and queue before waiting for health, providers, apps,
      // learning, and insights. Those values fill in below without delaying the
      // tab the user asked to open.
      settleAgentState();
      const initialAgents = needsRef.current.agents ? agentsRef.current : [];
      const runningAgent = initialAgents.find(a => a.status === 'running');
      setActiveAgentMeta(runningAgent?.metadata || null);

      const [learningSummaryData, insightsData] = await secondaryRead;
      // All three self-committing reads are barriers, not values: the state derivation
      // below reads what `healthRead` wrote (via `healthRef`), so it must not run before they settle.
      await Promise.all([healthRead, providersRead, appsRead]);
      // Health events may have delivered a newer snapshot while these reads settled.
      if (controller.signal.aborted) return;
      if (learningSeqRef.current === learningSeq) setLearningSummary(learningSummaryData);
      // Apply a real insights payload (including a legitimately-empty []); a null
      // from a failed/transient fetch preserves the last-good array so the banner
      // doesn't flicker empty on a blip.
      if (insightsData?.insights && queueSeqRef.current === queueSeq && tasksCurrent()) setInsights(insightsData.insights);

      // Status and agents may have moved on (an agent slice read, a spawn event, a
      // pause) while the ancillary reads settled; derive from the newest of both.
      settleAgentState();
    };
    const pending = { promise: null, controller, dirty: false };
    inFlight.current = pending;
    pending.promise = read().finally(() => {
      if (inFlight.current === pending) inFlight.current = null;
      if (pending.dirty && !controller.signal.aborted) refreshPageData();
    });
    return pending.promise;
  }, [setActiveAgentMeta, applyHealth, markHealthUnavailable, readApps, readAgents, awaitSlice, settleAgentState, readProviders, readStatus, applyStatusRead]);

  // Coalesce event bursts into a read of the visible queue and scalar shell
  // status. Insights use persisted health; invalidation never runs PM2 repair.
  const fetchQueue = useCallback(async function refreshQueueData() {
    if (queuePending.current && !queuePending.current.controller.signal.aborted) {
      queuePending.current.dirty = true;
      return queuePending.current.promise;
    }
    const controller = new AbortController();
    const request = { controller, dirty: false, promise: null };
    queuePending.current = request;
    const queueSeq = ++queueSeqRef.current;
    const tasksEpoch = sliceEpochRef.current.tasks;
    const tasksCurrent = () => needsRef.current.tasks && sliceEpochRef.current.tasks === tasksEpoch;
    const insightsRead = needsRef.current.tasks
      ? awaitSlice('tasks', getCosActionableInsights({ cachedHealth: true, silent: true }).catch(() => null))
      : Promise.resolve(null);
    request.promise = Promise.all([
      readStatus(),
      needsRef.current.tasks ? awaitSlice('tasks', getCosTasks({ view: 'queue', selected: selectedTaskRef.current, signal: controller.signal, silent: true }).catch(() => null)) : null,
      awaitSlice('agents', readAgents(controller)),
    ]).then(async ([statusRead, tasksData]) => {
      if (controller.signal.aborted || queueSeqRef.current !== queueSeq) return;
      if (applyStatusRead(statusRead)) {
        // Coding and Thinking are the states a missed agent event leaves wrong (an
        // agent paused or started while this tab ignored agent events), and the
        // summary's activeAgents is what reveals it. Reviewing is a transient
        // completion flash and is left to expire at the next tab switch.
        if (['coding', 'thinking'].includes(agentStateRef.current)) settleAgentState({ ifChanged: true });
      }
      if (tasksData && tasksCurrent()) setTasks(tasksData);
      const insightsData = await insightsRead;
      if (!controller.signal.aborted && queueSeqRef.current === queueSeq && tasksCurrent() && insightsData?.insights) setInsights(insightsData.insights);
    }).finally(() => {
      if (queuePending.current === request) queuePending.current = null;
      if (request.dirty && !controller.signal.aborted) refreshQueueData();
    });
    return request.promise;
  }, [readAgents, awaitSlice, applyStatusRead, settleAgentState, readStatus, agentStateRef]);

  // A slice's first read when its flag turns true: queue + insights.
  // Deliberately reads no shell data; status, health and learning are
  // socket-maintained. The task sequence is captured, not advanced, so a status
  // summary from an overlapping queue refresh is not discarded by this read.
  const readTasksSlice = useCallback(async () => {
    tasksSliceRef.current?.abort();
    const controller = new AbortController();
    tasksSliceRef.current = controller;
    const epoch = sliceEpochRef.current.tasks;
    const queueSeq = queueSeqRef.current;
    const current = () => !controller.signal.aborted && sliceEpochRef.current.tasks === epoch && queueSeqRef.current === queueSeq;
    const insightsRead = getCosActionableInsights({ cachedHealth: true, silent: true }).catch(() => null);
    const tasksData = await getCosTasks({ view: 'queue', selected: selectedTaskRef.current, signal: controller.signal, silent: true }).catch(() => null);
    if (!current()) return;
    if (tasksData) setTasks(tasksData);
    const insightsData = await insightsRead;
    if (current() && insightsData?.insights) setInsights(insightsData.insights);
  }, []);

  const readAgentsSlice = useCallback(async () => {
    agentsSliceRef.current?.abort();
    const controller = new AbortController();
    agentsSliceRef.current = controller;
    const data = await readAgents(controller);
    if (!Array.isArray(data) || controller.signal.aborted) return;
    setActiveAgentMeta(data.find(agent => agent.status === 'running')?.metadata || null);
    if (['coding', 'thinking'].includes(agentStateRef.current)) settleAgentState({ ifChanged: true });
  }, [readAgents, settleAgentState, agentStateRef, setActiveAgentMeta]);

  // All page insight reads use cached health. Explicit Run Check owns repairs;
  // task invalidations must never trigger a health-check/socket feedback loop.


  // Initial page load only: `fetchData` is stable, so this runs once per visit.
  // Socket invalidations and reconnect recover updates; tab switches are the
  // slice effect below.
  useEffect(() => {
    fetchData();
    return () => {
      inFlight.current?.controller.abort();
      queuePending.current?.controller.abort();
      tasksSliceRef.current?.abort();
      agentsSliceRef.current?.abort();
    };
  }, [fetchData]);

  // Read a slice when its flag turns true, and only then: a slice that stays
  // needed across a tab switch (Tasks <-> Agents) is already held and kept
  // current by its socket events. A slice's flag turning false ends its epoch.
  useEffect(() => {
    const prev = prevNeedsRef.current;
    const next = { tasks: needsTasks, agents: needsAgents, providers: needsProviders, apps: needsApps };
    prevNeedsRef.current = next;
    for (const kind of ['tasks', 'agents']) {
      if (prev[kind] === next[kind]) continue;
      sliceEpochRef.current[kind] += 1;
      for (const waiter of sliceWaitersRef.current) {
        if (waiter.kind !== kind) continue;
        sliceWaitersRef.current.delete(waiter);
        waiter.resolve(null);
      }
    }
    if (next.tasks && !prev.tasks) readTasksSlice();
    if (next.agents && !prev.agents) readAgentsSlice();
    // A provider read that failed is silent, so retry it on the next tab switch
    // that still needs providers; once loaded, providers:changed keeps it current.
    const tabChanged = lastTabRef.current !== activeTab;
    lastTabRef.current = activeTab;
    // Leaving a tab ends the completion flash: derive the resting state locally,
    // with no read (the status summary kept the inputs current).
    if (tabChanged && ['coding', 'reviewing', 'thinking'].includes(agentStateRef.current)) settleAgentState({ ifChanged: true });
    if (next.providers && (!prev.providers || (tabChanged && !providersCurrentRef.current))) readProviders();
    // `readApps` serves its cached snapshot, so this only re-reads after a failure.
    if (next.apps && (!prev.apps || tabChanged)) readApps();
  }, [activeTab, needsTasks, needsAgents, needsProviders, needsApps, readTasksSlice, readAgentsSlice, readProviders, readApps, settleAgentState, agentStateRef]);

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
    setInsights(prev => pruneBlockedTaskInsight(prev, taskId));
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
    setInsights(prev => pruneBlockedTaskInsight(prev, taskId));
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

  const page = {
    status,
    statusReadFailed,
    tasks,
    agents,
    agentsLoaded,
    agentsError,
    health,
    healthLoaded,
    healthError,
    providers,
    providersLoaded,
    activeProviderId,
    apps,
    appsStatus,
    readApps,
    loading,
    agentState: avatar.agentState,
    speaking: avatar.speaking,
    statusMessage: avatar.statusMessage,
    learningSummary,
    insights,
    configAvatarStyle: avatar.configAvatarStyle,
    avatarStyle: avatar.avatarStyle,
    activeAgentCount,
    pendingTaskCount,
    fetchData,
    fetchQueue,
    handleTaskUnblocked,
    handleTaskDeleted,
    handleUserTaskAdded,
  };

  return {
    page,
    socketSync: {
      avatar, appsReadRef, needsRef, agentReadRef, applyAgents, applyStatus, applyHealth, setTasks,
      fetchData, fetchQueue, refreshLearningSummary, readAgentsSlice, readApps, readProviders,
    },
    daemon: { avatar, fetchData, applyStatus, applyHealth, markHealthUnavailable, healthObservationRef },
  };
}

export default function useCosPageData({ activeTab, selectedTask }) {
  useSocketSubscription('cos', { payload: COS_PAGE_SUBSCRIBE, releasePayload: COS_PAGE_RELEASE });
  const { page, socketSync, daemon } = useCosPageSnapshot({ activeTab, selectedTask });
  const socketState = useCosSocketSync(socketSync);
  const daemonActions = useCosDaemonActions(daemon);
  return { ...page, ...socketState, ...daemonActions };
}
