import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useSocket } from '../hooks/useSocket';
import { useLocalStorageBool } from '../hooks/useLocalStorageBool';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { useValidTab } from '../hooks/useValidTab';
import * as api from '../services/api';
import { coalesce } from '../utils/coalesce';
import { Play, Pause, Square, Clock, CheckCircle, AlertCircle, Cpu, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Brain, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import TabPills from '../components/ui/TabPills';
import PageSkeleton from '../components/ui/PageSkeleton';

// Import from modular components
import {
  TABS,
  STATE_MESSAGES,
  summarizeHealthIssues,
  healthIssueTone,
  fresherHealth,
  resolveDynamicAvatar,
} from '../components/cos/constants';
import CoSCharacter from '../components/cos/CoSCharacter';
import StateLabel from '../components/cos/StateLabel';
import TerminalCoSPanel from '../components/cos/TerminalCoSPanel';
import StatusIndicator from '../components/cos/StatusIndicator';
import StatCard from '../components/cos/StatCard';
import StatusBubble from '../components/cos/StatusBubble';
import EventLog from '../components/cos/EventLog';
import QuickSummary from '../components/cos/QuickSummary';
import ActionableInsightsBanner from '../components/cos/ActionableInsightsBanner';
import TasksTab from '../components/cos/tabs/TasksTab';
import AgentsTab from '../components/cos/tabs/AgentsTab';

// The Runs tab (full AI run history + its log modal) is lazy-loaded so its weight
// stays out of the eager CoS chunk every /cos/* visit pays for — same reason the
// avatars below are not re-exported from the components/cos barrel.
const RunsTab = lazy(() => import('../components/cos/tabs/RunsTab'));
// The run-event diagnostic is lazy for the same reason as Runs: it is a
// post-mortem surface nobody opens on a normal day, and it pulls the whole
// ledger read path with it.
const RunEventsTab = lazy(() => import('../components/cos/tabs/RunEventsTab'));
const MindTab = lazy(() => import('../components/cos/tabs/MindTab'));
const PersistentMindTools = lazy(() => import('./PersistentMindTools'));
// The task and agent tabs are the default CoS landing surfaces and stay eager.
// Every other tab is loaded only when selected so the common queue view does
// not pay for charts, memory graphs, briefing readers, or configuration forms.
const JobsTab = lazy(() => import('../components/cos/tabs/JobsTab'));
const ScheduleTab = lazy(() => import('../components/cos/tabs/ScheduleTab'));
const WorkflowTab = lazy(() => import('../components/cos/tabs/WorkflowTab'));
const DigestTab = lazy(() => import('../components/cos/tabs/DigestTab'));
const GsdTab = lazy(() => import('../components/cos/tabs/GsdTab'));
const ProductivityTab = lazy(() => import('../components/cos/tabs/ProductivityTab'));
const LearningTab = lazy(() => import('../components/cos/tabs/LearningTab'));
const MemoryTab = lazy(() => import('../components/cos/tabs/MemoryTab'));
const HealthTab = lazy(() => import('../components/cos/tabs/HealthTab'));
const ConfigTab = lazy(() => import('../components/cos/tabs/ConfigTab'));
const BriefingTab = lazy(() => import('../components/cos/tabs/BriefingTab'));

// Three.js-based avatars lazy-loaded so the R3F stack isn't bundled unless the
// user's chosen avatar style actually needs it.
const LAZY_AVATARS = {
  cyber:    lazy(() => import('../components/cos/CyberCoSAvatar')),
  sigil:    lazy(() => import('../components/cos/SigilCoSAvatar')),
  esoteric: lazy(() => import('../components/cos/EsotericCoSAvatar')),
  nexus:    lazy(() => import('../components/cos/NexusCoSAvatar')),
  muse:     lazy(() => import('../components/cos/MuseCoSAvatar')),
  // Bundled CC0 Kenney Mini Characters — animated rigged GLB avatars.
  miniMaleC:   lazy(() => import('../components/cos/MiniCharMaleC')),
  miniFemaleD: lazy(() => import('../components/cos/MiniCharFemaleD')),
};

const CANVAS_AVATAR_STYLES = new Set([
  'cyber', 'sigil', 'esoteric', 'nexus', 'muse',
  'miniMaleC', 'miniFemaleD',
]);

// Shared brand gradient for the "CoS" wordmark headings (clipped to text).
const COS_TITLE_GRADIENT = 'linear-gradient(135deg, #6366f1, #8b5cf6, #06b6d4)';

function TabLoadFallback({ label }) {
  return <div className="flex items-center justify-center py-12"><BrailleSpinner text={`Loading ${label}`} /></div>;
}

export default function ChiefOfStaff() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'tasks');

  const [status, setStatus] = useState(null);
  const [tasks, setTasks] = useState({ user: null, cos: null });
  const [agents, setAgents] = useState([]);
  const [health, setHealth] = useState(null);
  const [healthLoaded, setHealthLoaded] = useState(false);
  const [providers, setProviders] = useState([]);
  // Which provider an unpinned task actually runs on — the Schedule tab names it
  // on the "Default" option and resolves model/effort choices against it.
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [agentState, setAgentState] = useState('sleeping');
  const [speaking, setSpeaking] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Idle - waiting for tasks...");
  const [liveOutputs, setLiveOutputs] = useState({});
  const [eventLogs, setEventLogs] = useState([]);
  const [agentPanelCollapsed, setAgentPanelCollapsed] = useState(false);
  const [desktopPanelCollapsed, setDesktopPanelCollapsed] = useLocalStorageBool(
    'cos-panel-collapsed',
    false,
    { format: 'true' },
  );
  const [activeAgentMeta, setActiveAgentMeta] = useState(null);
  const [learningSummary, setLearningSummary] = useState(null);
  // Actionable insights (blocked/approval/health counts) are fetched here in
  // fetchData and passed to ActionableInsightsBanner as a prop, so every trigger
  // that refetches CoS data — task mutations, socket-driven changes, health
  // checks, the 30s poll — refreshes the banner without a separate signal. null
  // until the first fetch resolves; preserved across transient fetch failures.
  const [insights, setInsights] = useState(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const tabsRef = useRef(null);
  // Monotonic counter for queue-state writes, so a slow fetchData cannot overwrite
  // a fresher fetchQueue result (see both functions below).
  const queueSeqRef = useRef(0);
  const socket = useSocket();

  // Derive avatar style from server config, with optional dynamic override
  const configAvatarStyle = status?.config?.avatarStyle || 'svg';
  const dynamicAvatarEnabled = status?.config?.dynamicAvatar || false;
  const dynamicStyle = dynamicAvatarEnabled ? resolveDynamicAvatar(activeAgentMeta) : null;
  const avatarStyle = dynamicStyle || configAvatarStyle;

  // Update avatar style via server config
  const setAvatarStyle = async (style) => {
    await api.updateCosConfig({ avatarStyle: style });
    fetchData();
  };

  const toggleDesktopPanel = useCallback(() => {
    setDesktopPanelCollapsed((prev) => !prev);
  }, [setDesktopPanelCollapsed]);

  // ONE writer for the health snapshot, so the Issues tile, the avatar state and
  // the status bubble can never describe different health checks. The ref is
  // written synchronously alongside the state, which is what lets fetchData run
  // the freshness rule and then derive from the value it actually committed —
  // with a functional updater the merged result was only visible inside the
  // updater, so the derivation below fell back to the raw (possibly older, or
  // null) read. `merge` runs the freshness rule; the socket and manual paths
  // deliver the newest check by definition and set it outright.
  const healthRef = useRef(null);
  const applyHealth = useCallback((next, { merge = false } = {}) => {
    const resolved = merge ? fresherHealth(healthRef.current, next) : next;
    healthRef.current = resolved;
    setHealth(resolved);
    setHealthLoaded(true);
    return resolved;
  }, []);

  // Derive agent state from system status
  const deriveAgentState = useCallback((statusData, agentsData, healthData) => {
    if (!statusData?.running) return 'sleeping';
    if (statusData.paused) return 'sleeping';

    const activeAgents = agentsData.filter(a => a.status === 'running');
    if (activeAgents.length > 0) return 'coding';

    if (healthData?.issues?.length > 0) return 'investigating';

    // When running but idle, show as thinking (ready to work)
    return 'thinking';
  }, []);

  const fetchData = useCallback(async () => {
    const queueSeq = queueSeqRef.current;
    // The queue is the critical path for both the Tasks and Agents tabs. Start
    // the secondary reads at the same time, but do not make the first paint
    // wait for them: actionable insights runs a server-side PM2/memory health
    // check, and provider/app/learning data can be hydrated after the queue is
    // already usable.
    const coreRead = Promise.all([
      api.getCosStatus().catch(() => null),
      api.getCosTasks().catch(() => ({ user: null, cos: null })),
      api.getCosAgents().catch(() => []),
    ]);
    const healthRead = api.getCosHealth().catch(() => null).then((data) => {
      // Health is independently useful to the Health tab. Commit it as soon
      // as its own read settles instead of making that tab wait for the slower
      // actionable-insights request in the same batch.
      applyHealth(data, { merge: true });
      return data;
    });
    const secondaryRead = Promise.all([
      healthRead,
      api.getProviders().catch(() => ({ providers: [] })),
      api.getApps().catch(() => []),
      api.getCosLearningSummary().catch(() => null),
      // `silent: true` keeps transient poll blips quiet, matching the banner's
      // retired 60s poll; `.catch(() => null)` → preserve last-good below.
      api.getCosActionableInsights({ silent: true }).catch(() => null)
    ]);

    const [statusData, tasksData, agentsData] = await coreRead;
    setStatus(statusData);
    // A queue refresh started later can still resolve first. Its task payload
    // must not be clobbered by this older, pre-flip read — otherwise the row
    // returns to the pending-AND-active state this guard exists to remove.
    if (queueSeqRef.current === queueSeq) {
      setTasks(tasksData);
      setAgents(agentsData);
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

    const [, providersData, appsData, learningSummaryData, insightsData] = await secondaryRead;
    // `getCosHealth` above reads the *pre-check* persisted health, while the
    // getCosActionableInsights call in this same batch triggers a fresh server
    // health check (cos.runHealthCheck) that emits `cos:health:check` — the
    // socket handler's health write can land before this runs. `fresherHealth`
    // keeps whichever check is newer (and keeps the last-good one when this read
    // failed); everything below derives from what it returned, never from the
    // raw read, so the bubble can't name an older issue than the tile shows.
    const mergedHealth = healthRef.current;
    setProviders(providersData.providers || []);
    setActiveProviderId(providersData.activeProvider || null);
    // Filter out PortOS Autofixer (it's part of PortOS project)
    setApps(appsData.filter(a => a.id !== 'portos-autofixer'));
    setLearningSummary(learningSummaryData);
    // Apply a real insights payload (including a legitimately-empty []); a null
    // from a failed/transient fetch preserves the last-good array so the banner
    // doesn't flicker empty on a blip.
    if (insightsData?.insights) setInsights(insightsData.insights);

    const newState = deriveAgentState(statusData, agentsData, mergedHealth);
    setAgentState(newState);
    // Default state message — richer messages come from socket events. The one
    // state whose default is useless is `investigating`: only a health issue
    // gets us here, so name it rather than saying "Investigating issue..." next
    // to an Active count of 0 with no agent to inspect.
    setStatusMessage(statusData?.paused
      ? `Paused${statusData.pauseReason ? ` — ${statusData.pauseReason}` : ''}`
      : (newState === 'investigating' && summarizeHealthIssues(mergedHealth?.issues)) || STATE_MESSAGES[newState]);

  }, [deriveAgentState, applyHealth]);

  // A cheap, read-only refresh of just the queue — the task lists plus the agent
  // list the Tasks tab reads to tell an already-spawning task from a waiting one.
  // Deliberately NOT fetchData: that batch also pulls actionable insights, whose
  // endpoint runs a health check that auto-restarts errored PM2 processes (see
  // the note below), which must never ride the store's per-mutation task stream.
  const fetchQueue = useCallback(async () => {
    const [tasksData, agentsData] = await Promise.all([
      api.getCosTasks({ silent: true }).catch(() => null),
      api.getCosAgents({ silent: true }).catch(() => null)
    ]);
    if (tasksData) setTasks(tasksData);
    if (Array.isArray(agentsData)) setAgents(agentsData);
    // Supersede any fetchData still in flight — see the guard in fetchData. Bumped
    // even when both reads failed: a failed refresh still means this queue state
    // is newer than whatever an older, slower batch is about to report.
    queueSeqRef.current += 1;
  }, []);

  // NOTE: there is deliberately no on-demand "refresh just the banner insights"
  // path. The /cos/actionable-insights endpoint runs a health check that
  // AUTO-RESTARTS errored PM2 processes (see server/services/cosHealthMonitor.js)
  // and re-emits `cos:health:check`. So an on-demand refresh — whether from the
  // `cos:health:check` socket handler or the manual "Run Check" button — would
  // either loop (socket) or fire a second, redundant process-restart ~1s after
  // the button's own check. The banner's server-derived counts refresh only
  // through fetchData: the 30s poll, task mutations (TasksTab onRefresh), the
  // unblock-up path, and agent spawn/completion (which already call fetchData).

  // Redirect unknown tab IDs to the default tab — `activeTab !== tab` only
  // when the param failed validation and fell back.
  useEffect(() => {
    if (tab && tab !== activeTab) {
      navigate('/cos/tasks', { replace: true });
    }
  }, [tab, activeTab, navigate]);

  // Reduced polling since most updates come via socket events
  useAutoRefetch(fetchData, 30_000, { pollOnly: true });


  useEffect(() => {
    if (!socket) return;

    // Subscribe when socket is connected (or already connected)
    const subscribe = () => {
      socket.emit('cos:subscribe');
    };

    // Subscribe now if already connected, AND always re-subscribe on every
    // (re)connect — the server rebuilds an empty per-socket subscriber Set on
    // reconnect, so registering the listener only in the else branch left
    // cos:* events dead after a reconnect when the socket was already connected
    // at mount. Cleanup below offs this listener.
    if (socket.connected) subscribe();
    socket.on('connect', subscribe);

    const handleCosStatus = (data) => {
      setStatus(prev => ({ ...prev, running: data.running }));
      if (!data.running) {
        setAgentState('sleeping');
        setStatusMessage("Stopped - daemon not running");
        setActiveAgentMeta(null);
      }
    };
    socket.on('cos:status', handleCosStatus);

    const handleTasksUserChanged = (data) => {
      setTasks(prev => ({ ...prev, user: data }));
    };
    socket.on('cos:tasks:user:changed', handleTasksUserChanged);

    // System (COS-TASKS.md) tasks change on their own file-watcher event, and
    // scheduled/on-demand CoS work IS an internal task — so without this handler
    // a freshly queued scheduled task only appeared once the 30s poll came
    // around. Same full-list payload as the user event, so swap it in directly.
    const handleTasksCosChanged = (data) => {
      setTasks(prev => ({ ...prev, cos: data }));
    };
    socket.on('cos:tasks:cos:changed', handleTasksCosChanged);

    // The store's own per-mutation event, which fires the instant a task is added
    // or its status flips — ahead of the debounced file watcher above. It carries
    // one task rather than the list, and also fires for writes with nothing to
    // show here (every running task's federation lease heartbeat), so it drives
    // one coalesced queue refresh rather than a fetch per event. This is what
    // collapses the pending→in_progress lag: 'cos:agent:spawned' fires BEFORE
    // spawnAgentForTask flips the task off 'pending', so the fetch it triggers
    // always reads the task as still-queued.
    const refreshQueue = coalesce(fetchQueue, 400);
    socket.on('cos:tasks:changed', refreshQueue);

    const handleAgentSpawned = (data) => {
      setAgentState('coding');
      // Show actual task description if available
      const taskDesc = data?.metadata?.taskDescription;
      const shortDesc = taskDesc ? taskDesc.substring(0, 60) + (taskDesc.length > 60 ? '...' : '') : 'Working on task...';
      setStatusMessage(`Running: ${shortDesc}`);
      setSpeaking(true);
      setTimeout(() => setSpeaking(false), 2000);
      // Track active agent metadata for dynamic avatar resolution
      if (data?.metadata) setActiveAgentMeta(data.metadata);
      // Initialize empty output buffer for new agent
      if (data?.agentId || data?.id) {
        setLiveOutputs(prev => ({ ...prev, [data.agentId || data.id]: [] }));
      }
      fetchData();
    };
    socket.on('cos:agent:spawned', handleAgentSpawned);

    const handleAgentUpdated = (updatedAgent) => {
      // Update the specific agent in the agents list without fetching all data
      setAgents(prev => prev.map(agent =>
        agent.id === updatedAgent.id ? updatedAgent : agent
      ));
    };
    socket.on('cos:agent:updated', handleAgentUpdated);

    const handleAgentOutput = (data) => {
      if (data?.agentId && data?.line) {
        setLiveOutputs(prev => {
          const existing = prev[data.agentId] || [];
          const updated = [...existing, { line: data.line, timestamp: Date.now() }];
          return { ...prev, [data.agentId]: updated.length > 500 ? updated.slice(-500) : updated };
        });
      }
    };
    socket.on('cos:agent:output', handleAgentOutput);

    const handleAgentCompleted = (data) => {
      setAgentState('reviewing');
      const success = data?.result?.success;
      setStatusMessage(success ? "Task completed successfully" : "Task failed - checking errors...");
      setSpeaking(true);
      setTimeout(() => setSpeaking(false), 2000);
      // Clear active agent metadata so avatar reverts to default
      setActiveAgentMeta(null);
      // Clean up live output buffer for completed agent to prevent memory growth
      if (data?.agentId) {
        setLiveOutputs(prev => {
          const { [data.agentId]: _, ...rest } = prev;
          return rest;
        });
      }
      fetchData();
    };
    socket.on('cos:agent:completed', handleAgentCompleted);

    const handleHealthCheck = (data) => {
      applyHealth({ lastCheck: data.metrics?.timestamp, issues: data.issues });
      // Do NOT refresh banner insights here — /cos/actionable-insights runs a
      // health check that re-emits this very socket event, which would loop
      // (see the note by the redirect effect). Banner refreshes on the next poll.
      if (data.issues?.length > 0) {
        setAgentState('investigating');
        setStatusMessage(summarizeHealthIssues(data.issues));
        setSpeaking(true);
        setTimeout(() => setSpeaking(false), 2000);
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
          setSpeaking(true);
          setTimeout(() => setSpeaking(false), 1500);
        }
      }
    };
    socket.on('cos:log', handleCosLog);

    // Listen for apps changes (start/stop/restart)
    const handleAppsChanged = () => {
      fetchData();
    };
    socket.on('apps:changed', handleAppsChanged);

    // Don't emit cos:unsubscribe — the cos:* namespace is shared with
    // useOpenWorldData (OpenWorld), useAgentFeedbackToast, and other always-mounted
    // consumers; the server's per-socket subscriber Set has no ref count.
    // Unsubscribing here would yank events out from under them.
    return () => {
      socket.off('connect', subscribe);
      socket.off('cos:status', handleCosStatus);
      socket.off('cos:tasks:user:changed', handleTasksUserChanged);
      socket.off('cos:tasks:cos:changed', handleTasksCosChanged);
      socket.off('cos:tasks:changed', refreshQueue);
      socket.off('cos:agent:spawned', handleAgentSpawned);
      socket.off('cos:agent:updated', handleAgentUpdated);
      socket.off('cos:agent:output', handleAgentOutput);
      socket.off('cos:agent:completed', handleAgentCompleted);
      socket.off('cos:health:check', handleHealthCheck);
      socket.off('cos:log', handleCosLog);
      socket.off('apps:changed', handleAppsChanged);
      refreshQueue.cancel();
    };
  }, [socket, fetchData, fetchQueue]);

  const handleStart = async () => {
    const result = await api.startCos({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    if (result?.success) {
      toast.success('Chief of Staff started');
      setAgentState('thinking');
      setStatusMessage("Starting daemon - scanning for tasks...");
      setSpeaking(true);
      setTimeout(() => setSpeaking(false), 2000);
      fetchData();
    }
  };

  const handleStop = async () => {
    const result = await api.stopCos({ silent: true }).catch(err => {
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
    const result = await api.pauseCos(reason, { silent: true }).catch(err => {
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
    const result = await api.resumeCos({ silent: true }).catch(err => {
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
      await api.forceCosEvaluate({ silent: true });
      toast.success('Evaluation triggered');
      setAgentState('thinking');
      setStatusMessage("Evaluating tasks...");
      setSpeaking(true);
      setTimeout(() => setSpeaking(false), 2000);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleTaskUnblocked = (taskId) => {
    setTasks(prev => {
      const unblockSlice = (slice) => {
        if (!slice) return slice;
        const blockedTask = slice.grouped?.blocked?.find(t => t.id === taskId);
        if (!blockedTask && !slice.tasks?.some(t => t.id === taskId)) return slice;
        const unblocked = blockedTask
          ? { ...blockedTask, status: 'pending', metadata: { ...blockedTask.metadata, blocker: undefined } }
          : null;
        const currentPending = slice.grouped?.pending || [];
        const alreadyPending = currentPending.some(t => t.id === taskId);
        return {
          ...slice,
          tasks: slice.tasks?.map(t => t.id === taskId ? { ...t, status: 'pending', metadata: { ...t.metadata, blocker: undefined } } : t),
          grouped: {
            ...slice.grouped,
            blocked: slice.grouped?.blocked?.filter(t => t.id !== taskId) || [],
            pending: alreadyPending ? currentPending : [...currentPending, ...(unblocked ? [unblocked] : [])]
          }
        };
      };
      return {
        ...prev,
        user: unblockSlice(prev.user),
        cos: unblockSlice(prev.cos)
      };
    });
  };

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
    setSpeaking(true);
    const result = await api.forceHealthCheck({ silent: true }).catch(err => {
      toast.error(err.message);
      return null;
    });
    setSpeaking(false);
    if (result) {
      applyHealth({ lastCheck: result.metrics?.timestamp, issues: result.issues });
      // Do NOT refresh the banner insights here — /cos/actionable-insights runs
      // a process-restarting health check, so an on-demand refresh would fire a
      // second restart ~1s after forceHealthCheck's own. The banner's health
      // count refreshes on the next fetchData poll instead (see the note above).
      toast.success('Health check complete');
      if (result.issues?.length > 0) {
        setStatusMessage(summarizeHealthIssues(result.issues));
      } else {
        setAgentState('sleeping');
        setStatusMessage("Health check passed - all systems OK");
      }
    }
  };

  // Memoize expensive derived state to prevent recalculation on every render
  // Note: These must be before any early returns to follow React's Rules of Hooks
  const activeAgentCount = useMemo(() =>
    agents.filter(a => a.status === 'running').length,
    [agents]
  );

  // Memoize pending task count
  const pendingTaskCount = useMemo(() =>
    (tasks.user?.grouped?.pending?.length || 0) + (tasks.cos?.grouped?.pending?.length || 0),
    [tasks.user?.grouped?.pending?.length, tasks.cos?.grouped?.pending?.length]
  );

  // Check if tabs can scroll left/right
  const checkTabsScroll = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 1);
  }, []);

  // Update scroll state on mount and resize
  useEffect(() => {
    checkTabsScroll();
    window.addEventListener('resize', checkTabsScroll);
    return () => window.removeEventListener('resize', checkTabsScroll);
  }, [checkTabsScroll]);

  const scrollTabs = useCallback((direction) => {
    const el = tabsRef.current;
    if (!el) return;
    const scrollAmount = 200;
    el.scrollBy({ left: direction === 'left' ? -scrollAmount : scrollAmount, behavior: 'smooth' });
  }, []);

  const hasCanvasAvatar = CANVAS_AVATAR_STYLES.has(avatarStyle);

  // Learning tile behaviour shared by the compact (sidebar/mobile) and mini
  // (ascii stats bar) renderings — only the icon scale and the empty-state
  // value differ between them. A skipped task type is critical on its own
  // terms: derive that here rather than trusting the server's status chain to
  // keep classifying `skipped > 0` as `critical`, or a reorder there would
  // silently drop the red signal while the tile still reads "N skipped".
  const learningSkipped = learningSummary?.skipped ?? 0;
  // `!= null`, not truthiness — a real 0% success rate is the highest-signal
  // state and must not render as the empty state. `null` is the sentinel each
  // tile falls back from to its own (differently sized) empty-state string.
  const learningRate = learningSummary?.overallSuccessRate != null ? `${learningSummary.overallSuccessRate}%` : null;
  const learningStatProps = {
    label: 'Learning',
    tone: learningSkipped > 0 ? 'critical' : (learningSummary?.status || 'default'),
    active: learningSkipped > 0,
    activeLabel: learningSkipped > 0 ? `${learningSkipped} skipped` : null,
    title: learningSummary?.statusMessage || 'View learning analytics',
    onClick: () => navigate('/cos/learning'),
  };

  // The Issues tile is the only place the UI admits CoS found something wrong,
  // so it has to click through to the detail. Without that, a warning-level
  // health issue parked the avatar on "Investigating" with Active 0, no agent
  // to open, and the offending message reachable only by guessing at the Health
  // tab. `title` surfaces the same summary on hover/touch-and-hold.
  const healthIssues = health?.issues || [];
  const issuesStatProps = {
    label: 'Issues',
    value: healthIssues.length,
    tone: healthIssueTone(healthIssues),
    title: summarizeHealthIssues(healthIssues) || 'No issues detected — view system health',
    onClick: () => navigate('/cos/health'),
  };

  // Compact stats card grid — rendered both inside the desktop CoS sidebar and
  // the mobile compressed header so the metrics always live "inside" CoS.
  const statsGridCards = (
    <>
      <StatCard
        label="Active"
        value={activeAgentCount}
        icon={<Cpu className="w-4 h-4 text-port-accent" />}
        active={activeAgentCount > 0}
        compact
      />
      <StatCard
        label="Pending"
        value={pendingTaskCount}
        icon={<Clock className="w-4 h-4 text-port-warning" />}
        compact
      />
      <StatCard
        label="Done"
        value={status?.stats?.tasksCompleted || 0}
        icon={<CheckCircle className="w-4 h-4 text-port-success" />}
        compact
      />
      <StatCard
        {...issuesStatProps}
        icon={<AlertCircle className="w-4 h-4" />}
        compact
      />
      <StatCard
        {...learningStatProps}
        value={learningRate ?? 'No data'}
        icon={<Brain className="w-4 h-4" />}
        compact
      />
      {status?.running ? (
        <>
          <button
            type="button"
            onClick={status.paused ? handleResume : handlePause}
            className={`border rounded px-2 py-1.5 flex items-center gap-2 transition-colors min-h-[52px] ${
              status.paused
                ? 'bg-port-success/20 hover:bg-port-success/30 text-port-success border-port-success/30'
                : 'bg-port-warning/20 hover:bg-port-warning/30 text-port-warning border-port-warning/30'
            }`}
            aria-label={status.paused ? 'Resume Chief of Staff scheduling' : 'Pause Chief of Staff scheduling'}
            title={status.paused
              ? 'Resume task evaluation and dispatch'
              : 'Pause new task evaluation and dispatch; running agents keep their work'}
          >
            {status.paused
              ? <Play size={16} className="shrink-0" aria-hidden="true" />
              : <Pause size={16} className="shrink-0" aria-hidden="true" />}
            <div className="flex-1 min-w-0 text-left">
              <div className="text-[10px] text-gray-600">Queue</div>
              <div className="text-sm font-bold">{status.paused ? 'Resume' : 'Pause'}</div>
            </div>
          </button>
          <button
            type="button"
            onClick={handleStop}
            className="bg-port-error/20 hover:bg-port-error/30 text-port-error border border-port-error/30 rounded px-2 py-1.5 flex items-center gap-2 transition-colors min-h-[52px]"
            aria-label="Stop Chief of Staff agent"
          >
            <Square size={16} className="shrink-0" aria-hidden="true" />
            <div className="flex-1 min-w-0 text-left">
              <div className="text-[10px] text-gray-600">Agent</div>
              <div className="text-sm font-bold text-port-error">Stop</div>
            </div>
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={handleStart}
          className="bg-port-success/20 hover:bg-port-success/30 text-port-success border border-port-success/30 rounded px-2 py-1.5 flex items-center gap-2 transition-colors min-h-[52px]"
          aria-label="Start Chief of Staff agent"
        >
          <Play size={16} className="shrink-0" aria-hidden="true" />
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[10px] text-port-success/80">Agent</div>
            <div className="text-sm font-bold">Start</div>
          </div>
        </button>
      )}
    </>
  );

  const renderAvatar = (background = false) => {
    const LazyAvatar = LAZY_AVATARS[avatarStyle];
    if (LazyAvatar) {
      return (
        <Suspense fallback={<div className="flex items-center justify-center h-full"><BrailleSpinner /></div>}>
          <LazyAvatar state={agentState} speaking={speaking} background={background} />
        </Suspense>
      );
    }
    return <CoSCharacter state={agentState} speaking={speaking} />;
  };

  if (loading) {
    // Reserve the loaded two-pane shell (#4144) — `/cos` is an `isFullWidth`
    // route, so a centered spinner reserved nothing and the whole page jumped
    // into place on first paint. `desktopPanelCollapsed` comes from
    // localStorage, so the skeleton already knows which rail width to hold.
    return (
      <PageSkeleton
        layout="split"
        label="Loading Chief of Staff"
        fullHeight
        padded
        bodyClassName="p-3 lg:p-4"
        sideCollapsed={desktopPanelCollapsed}
        sideClassName="flex flex-col gap-3 border-b lg:border-b-0 lg:border-r border-port-accent-2/20 bg-gradient-to-b from-port-card/80 to-port-card/40 p-3 lg:px-4 lg:py-6 lg:h-full lg:overflow-hidden"
        sideHero
        sideBlocks={4}
        sideBlockColsClass="grid-cols-2"
        tabs={TABS.length}
      />
    );
  }

  return (
    <div className={`relative flex flex-col lg:grid ${desktopPanelCollapsed ? 'lg:grid-cols-[0px_1fr]' : 'lg:grid-cols-[320px_1fr]'} h-full overflow-hidden transition-[grid-template-columns] duration-200`}>
      {/* Floating expand button - flush with nav edge when panel is collapsed */}
      {desktopPanelCollapsed && (
        <button
          onClick={toggleDesktopPanel}
          className="hidden lg:flex absolute left-0 top-2 z-20 p-1.5 text-port-text-muted hover:text-port-text transition-colors rounded-r-md hover:bg-port-border/80 bg-port-card/60 border border-l-0 border-port-accent-2/20"
          aria-label="Expand CoS panel"
          title="Expand CoS panel"
        >
          <PanelLeftOpen size={16} />
        </button>
      )}

      {/* Agent Panel */}
      {avatarStyle === 'ascii' ? (
        <>
          {/* Desktop: collapsed placeholder or full panel */}
          {desktopPanelCollapsed ? (
            <div className="hidden lg:block overflow-hidden min-w-0" />
          ) : (
            <div className="hidden lg:block relative">
              <button
                onClick={toggleDesktopPanel}
                className="absolute top-2 right-2 z-10 p-1.5 text-gray-500 hover:text-white transition-colors rounded-md hover:bg-white/5"
                aria-label="Collapse CoS panel"
                title="Collapse CoS panel"
              >
                <PanelLeftClose size={16} />
              </button>
              <TerminalCoSPanel
                state={agentState}
                speaking={speaking}
                statusMessage={statusMessage}
                eventLogs={eventLogs}
                running={status?.running}
                onStart={handleStart}
                onStop={handleStop}
                stats={status?.stats}
              />
            </div>
          )}
          {/* Mobile: always show the terminal panel (it has its own compact layout) */}
          <div className="lg:hidden">
            <TerminalCoSPanel
              state={agentState}
              speaking={speaking}
              statusMessage={statusMessage}
              eventLogs={eventLogs}
              running={status?.running}
              onStart={handleStart}
              onStop={handleStop}
              stats={status?.stats}
            />
          </div>
        </>
      ) : desktopPanelCollapsed ? (
        /* Collapsed SVG - desktop placeholder, mobile shows compact header */
        <>
          <div className="hidden lg:block overflow-hidden min-w-0" />
          {/* Mobile: still show the compact header */}
          <div className="lg:hidden border-b border-port-accent-2/20 bg-gradient-to-b from-port-card/80 to-port-card/40">
            <button
              onClick={() => setAgentPanelCollapsed(!agentPanelCollapsed)}
              className="flex items-center justify-between w-full px-3 py-2 bg-port-card/60 border-b border-port-accent-2/20 min-h-[40px]"
              aria-expanded={!agentPanelCollapsed}
              aria-controls="cos-agent-panel"
            >
              <div className="flex items-center gap-2">
                <h1
                  className="text-base font-bold"
                  style={{
                    background: COS_TITLE_GRADIENT,
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    backgroundClip: 'text'
                  }}
                >
                  CoS
                </h1>
                <StatusIndicator running={status?.running} paused={status?.paused} />
              </div>
              <div className="flex items-center gap-1.5 text-gray-400">
                <StateLabel state={agentState} compact />
                {agentPanelCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
              </div>
            </button>
            {!agentPanelCollapsed && (
              <div className="flex flex-1 min-w-0 p-2">
                {/* Mobile Stats Grid */}
                <div className="flex-1 grid grid-cols-2 gap-1.5 relative z-10 content-center">
                  <StatCard label="Active" value={activeAgentCount} icon={<Cpu className="w-4 h-4 text-port-accent" />} active={activeAgentCount > 0} compact />
                  <StatCard label="Pending" value={pendingTaskCount} icon={<Clock className="w-4 h-4 text-port-warning" />} compact />
                  <StatCard label="Done" value={status?.stats?.tasksCompleted || 0} icon={<CheckCircle className="w-4 h-4 text-port-success" />} compact />
                  <StatCard {...issuesStatProps} icon={<AlertCircle className="w-4 h-4" />} compact />
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="relative flex flex-col border-b lg:border-b-0 lg:border-r border-port-accent-2/20 bg-gradient-to-b from-port-card/80 to-port-card/40 shrink-0 w-full max-w-full overflow-x-hidden lg:h-full lg:overflow-y-auto scrollbar-hide">
          {/* Desktop Collapse Button */}
          <button
            onClick={toggleDesktopPanel}
            className="hidden lg:flex absolute top-2 right-2 z-20 p-1.5 text-gray-500 hover:text-white transition-colors rounded-md hover:bg-white/5"
            aria-label="Collapse CoS panel"
            title="Collapse CoS panel"
          >
            <PanelLeftClose size={16} />
          </button>

          {/* Mobile Collapse Toggle Header */}
          <button
            onClick={() => setAgentPanelCollapsed(!agentPanelCollapsed)}
            className="lg:hidden flex items-center justify-between w-full px-3 py-2 bg-port-card/60 border-b border-port-accent-2/20 min-h-[40px]"
            aria-expanded={!agentPanelCollapsed}
            aria-controls="cos-agent-panel"
          >
            <div className="flex items-center gap-2">
              <h1
                className="text-base font-bold"
                style={{
                  background: COS_TITLE_GRADIENT,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text'
                }}
              >
                CoS
              </h1>
              <StatusIndicator running={status?.running} paused={status?.paused} />
            </div>
            <div className="flex items-center gap-1.5 text-gray-400">
              <StateLabel state={agentState} compact />
              {agentPanelCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
            </div>
          </button>

          {/* Collapsible Content */}
          <div
            id="cos-agent-panel"
            className={`${agentPanelCollapsed ? 'hidden' : 'flex'} lg:flex min-w-0 relative overflow-hidden ${hasCanvasAvatar ? 'flex-none min-h-[180px] sm:min-h-[190px] md:min-h-[190px] lg:min-h-dvh-cap lg:[--dvh-cap:460px] lg:[--dvh-inset:1rem] xl:[--dvh-cap:620px]' : 'flex-1'}`}
          >
            {/* Background Effects */}
            <div
              className="absolute inset-0 z-0 pointer-events-none"
              style={{
                background: `
                  radial-gradient(circle at 50% 20%, rgba(99, 102, 241, 0.1) 0%, transparent 50%),
                  repeating-linear-gradient(0deg, transparent, transparent 50px, rgba(99, 102, 241, 0.03) 50px, rgba(99, 102, 241, 0.03) 51px)
                `
              }}
            />

            {hasCanvasAvatar && (
              // Cap the full-bleed avatar canvas to the panel's BASE height
              // (the same min-h the panel starts at) and anchor it to the top.
              // The panel itself uses min-h so it can grow to fit the stats grid
              // + event log without clipping; without this cap the inset-0 canvas
              // grows with the panel on desktop, dragging the framed avatar down
              // into the stats grid below it.
              <div className="absolute inset-0 lg:bottom-auto lg:h-dvh-cap lg:[--dvh-cap:460px] lg:[--dvh-inset:1rem] xl:[--dvh-cap:620px] z-[1] -translate-x-16 -translate-y-1 sm:translate-x-0 sm:-translate-y-6 md:-translate-y-8 lg:-translate-y-28 xl:-translate-y-36">
                {renderAvatar(true)}
              </div>
            )}

            {/* Avatar UI overlays the full-width canvas stage for 3D styles. */}
            <div className={`${hasCanvasAvatar ? 'absolute inset-y-0 left-0 w-[46%] lg:relative lg:inset-auto lg:w-full lg:flex-none lg:min-h-full p-2 sm:p-3 lg:px-4 lg:py-6' : 'relative flex-1 min-w-0 lg:flex-none lg:min-h-full p-2 lg:px-4 lg:py-6'} min-w-0 flex flex-col items-center z-10`}>
              <div className="hidden lg:block text-sm font-semibold tracking-widest uppercase text-port-text-muted mb-1 font-mono">
                Digital Assistant
              </div>
              <h1
                className="hidden lg:block text-lg sm:text-xl lg:text-2xl xl:text-3xl font-bold mb-2 lg:mb-4"
                style={{
                  background: COS_TITLE_GRADIENT,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text'
                }}
              >
                Chief of Staff
              </h1>

              {!hasCanvasAvatar && renderAvatar()}
              {hasCanvasAvatar && <div className="flex-none h-[5.75rem] sm:h-[4rem] md:h-[3rem] lg:h-[11rem] xl:h-[12rem]" aria-hidden="true" />}
              <div className="hidden lg:block">
                <StateLabel state={agentState} />
              </div>
              <div className={`${hasCanvasAvatar ? 'sm:-mt-4 md:-mt-6 lg:mt-0' : ''} hidden sm:block`}>
                <StatusBubble message={statusMessage} />
              </div>

              {/* Desktop Stats Grid - integrated into CoS sidebar (matches mobile compressed layout) */}
              <div className="hidden lg:grid grid-cols-2 gap-1.5 w-full mt-3 relative z-10">
                {statsGridCards}
              </div>

              {status?.running && (
                <div className="hidden lg:flex flex-1 min-h-0 w-full flex-col">
                  <EventLog logs={eventLogs} />
                </div>
              )}
            </div>

            {/* Mobile Stats Grid - shows core stats in compact 2-column layout */}
            <div className={`${hasCanvasAvatar ? 'ml-[46%] w-[54%] flex-none self-start content-start' : 'flex-1 content-center'} grid grid-cols-2 gap-1.5 p-2 lg:hidden relative z-10`}>
              {statsGridCards}
            </div>
          </div>
        </div>
      )}

      {/* Content Panel */}
      <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-3 lg:p-4">
        {/* Stats Bar - hidden for SVG/canvas modes (now integrated into CoS sidebar);
            ascii/terminal mode keeps it because TerminalCoSPanel doesn't host the cards. */}
        <div className={`grid grid-cols-5 gap-1.5 sm:gap-2 lg:gap-3 mb-3 sm:mb-4 lg:mb-6 ${avatarStyle !== 'ascii' ? 'hidden' : ''}`}>
          <StatCard
            label="Active"
            value={activeAgentCount}
            icon={<Cpu className="w-3 h-3 sm:w-4 sm:h-4 lg:w-5 lg:h-5 text-port-accent" />}
            active={activeAgentCount > 0}
            mini
          />
          <StatCard
            label="Pending"
            value={pendingTaskCount}
            icon={<Clock className="w-3 h-3 sm:w-4 sm:h-4 lg:w-5 lg:h-5 text-port-warning" />}
            mini
          />
          <StatCard
            label="Done"
            value={status?.stats?.tasksCompleted || 0}
            icon={<CheckCircle className="w-3 h-3 sm:w-4 sm:h-4 lg:w-5 lg:h-5 text-port-success" />}
            mini
          />
          <StatCard
            {...issuesStatProps}
            icon={<AlertCircle className="w-3 h-3 sm:w-4 sm:h-4 lg:w-5 lg:h-5" />}
            mini
          />
          {/* Learning Health - clickable to go to Learning tab */}
          <StatCard
            {...learningStatProps}
            value={learningRate ?? '—'}
            icon={<Brain className="w-3 h-3 sm:w-4 sm:h-4 lg:w-5 lg:h-5" />}
            mini
          />
        </div>

        {/* Tabs - scrollable with arrow navigation */}
        <div className="relative mb-4 lg:mb-6">
          {/* Left scroll button */}
          {canScrollLeft && (
            <button
              onClick={() => scrollTabs('left')}
              className="absolute left-0 top-0 bottom-px z-10 flex items-center justify-center w-8 bg-gradient-to-r from-port-bg via-port-bg to-transparent hover:from-port-card"
              aria-label="Scroll tabs left"
            >
              <ChevronLeft size={18} className="text-gray-400" />
            </button>
          )}
          {/* Right scroll button */}
          {canScrollRight && (
            <button
              onClick={() => scrollTabs('right')}
              className="absolute right-0 top-0 bottom-px z-10 flex items-center justify-center w-8 bg-gradient-to-l from-port-bg via-port-bg to-transparent hover:from-port-card"
              aria-label="Scroll tabs right"
            >
              <ChevronRight size={18} className="text-gray-400" />
            </button>
          )}
          <TabPills
            tabs={TABS}
            activeTab={activeTab}
            onChange={(id) => navigate(`/cos/${id}`)}
            hideLabelOnMobile
            ariaLabel="Chief of Staff sections"
            controlsIdPrefix="tabpanel"
            listRef={tabsRef}
            onScroll={checkTabsScroll}
            className="pb-px"
          />
        </div>

        {/* Tab Content */}
        {activeTab === 'briefing' && (
          <div role="tabpanel" id="tabpanel-briefing" aria-labelledby="tab-briefing">
            <Suspense fallback={<TabLoadFallback label="briefing" />}>
              <BriefingTab />
            </Suspense>
          </div>
        )}
        {activeTab === 'tasks' && (
          <div role="tabpanel" id="tabpanel-tasks" aria-labelledby="tab-tasks">
            {/* Tasks-only widgets live under the tab nav so they don't stretch above
                tabs that don't surface this data. */}
            <ActionableInsightsBanner insights={insights} onTaskUnblocked={handleTaskUnblocked} onRefresh={fetchData} />
            <QuickSummary />
            <TasksTab tasks={tasks} agents={agents} onRefresh={fetchData} onTaskAdded={handleUserTaskAdded} providers={providers} apps={apps} />
          </div>
        )}
        {activeTab === 'agents' && (
          <div role="tabpanel" id="tabpanel-agents" aria-labelledby="tab-agents">
            <AgentsTab agents={agents} onRefresh={fetchData} liveOutputs={liveOutputs} providers={providers} apps={apps} />
          </div>
        )}
        {activeTab === 'jobs' && (
          <div role="tabpanel" id="tabpanel-jobs" aria-labelledby="tab-jobs">
            <Suspense fallback={<TabLoadFallback label="jobs" />}>
              <JobsTab />
            </Suspense>
          </div>
        )}
        {activeTab === 'runs' && (
          <div role="tabpanel" id="tabpanel-runs" aria-labelledby="tab-runs">
            <Suspense fallback={<TabLoadFallback label="runs" />}>
              <RunsTab />
            </Suspense>
          </div>
        )}
        {activeTab === 'run-events' && (
          <div role="tabpanel" id="tabpanel-run-events" aria-labelledby="tab-run-events">
            <Suspense fallback={<TabLoadFallback label="run events" />}>
              <RunEventsTab />
            </Suspense>
          </div>
        )}
        {activeTab === 'mind' && (
          <div role="tabpanel" id="tabpanel-mind" aria-labelledby="tab-mind">
            <Suspense fallback={<TabLoadFallback label="mind" />}>
              <MindTab />
            </Suspense>
          </div>
        )}
        {activeTab === 'tools' && (
          <div role="tabpanel" id="tabpanel-tools" aria-labelledby="tab-tools">
            <Suspense fallback={<TabLoadFallback label="mind tools" />}>
              <PersistentMindTools />
            </Suspense>
          </div>
        )}
        {activeTab === 'schedule' && (
          <div role="tabpanel" id="tabpanel-schedule" aria-labelledby="tab-schedule">
            <Suspense fallback={<TabLoadFallback label="schedule" />}>
              <ScheduleTab apps={apps} providers={providers} activeProviderId={activeProviderId} />
            </Suspense>
          </div>
        )}
        {activeTab === 'workflow' && (
          <div role="tabpanel" id="tabpanel-workflow" aria-labelledby="tab-workflow">
            <Suspense fallback={<TabLoadFallback label="workflow" />}>
              <WorkflowTab apps={apps} providers={providers} />
            </Suspense>
          </div>
        )}
        {activeTab === 'digest' && (
          <div role="tabpanel" id="tabpanel-digest" aria-labelledby="tab-digest">
            <Suspense fallback={<TabLoadFallback label="digest" />}>
              <DigestTab />
            </Suspense>
          </div>
        )}
        {activeTab === 'gsd' && (
          <div role="tabpanel" id="tabpanel-gsd" aria-labelledby="tab-gsd">
            <Suspense fallback={<TabLoadFallback label="GSD" />}>
              <GsdTab />
            </Suspense>
          </div>
        )}
        {activeTab === 'productivity' && (
          <div role="tabpanel" id="tabpanel-productivity" aria-labelledby="tab-productivity">
            <Suspense fallback={<TabLoadFallback label="productivity" />}>
              <ProductivityTab />
            </Suspense>
          </div>
        )}
        {activeTab === 'learning' && (
          <div role="tabpanel" id="tabpanel-learning" aria-labelledby="tab-learning">
            <Suspense fallback={<TabLoadFallback label="learning" />}>
              <LearningTab />
            </Suspense>
          </div>
        )}
        {activeTab === 'memory' && (
          <div role="tabpanel" id="tabpanel-memory" aria-labelledby="tab-memory">
            <Suspense fallback={<TabLoadFallback label="memory" />}>
              <MemoryTab apps={apps} />
            </Suspense>
          </div>
        )}
        {activeTab === 'health' && (
          <div role="tabpanel" id="tabpanel-health" aria-labelledby="tab-health">
            <Suspense fallback={<TabLoadFallback label="health" />}>
              <HealthTab health={health} healthLoading={!healthLoaded} onCheck={handleHealthCheck} />
            </Suspense>
          </div>
        )}
        {activeTab === 'config' && (
          <div role="tabpanel" id="tabpanel-config" aria-labelledby="tab-config">
            <Suspense fallback={<TabLoadFallback label="configuration" />}>
              <ConfigTab config={status?.config} onUpdate={fetchData} onEvaluate={handleForceEvaluate} avatarStyle={configAvatarStyle} setAvatarStyle={setAvatarStyle} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
