import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import { useLocalStorageBool } from '../hooks/useLocalStorageBool';
import { useAutoRefetch } from '../hooks/useAutoRefetch';
import { useValidTab } from '../hooks/useValidTab';
import * as api from '../services/api';
import { Play, Square, Clock, CheckCircle, AlertCircle, Cpu, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Brain, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import toast from '../components/ui/Toast';
import BrailleSpinner from '../components/BrailleSpinner';
import TabPills from '../components/ui/TabPills';

// Import from modular components
import {
  TABS,
  STATE_MESSAGES,
  CoSCharacter,
  StateLabel,
  TerminalCoSPanel,
  StatusIndicator,
  StatCard,
  StatusBubble,
  EventLog,
  QuickSummary,
  ActionableInsightsBanner,
  TasksTab,
  AgentsTab,
  JobsTab,
  ScheduleTab,
  WorkflowTab,
  DigestTab,
  GsdTab,
  ProductivityTab,
  LearningTab,
  MemoryTab,
  HealthTab,
  ConfigTab,
  BriefingTab
} from '../components/cos';
import { resolveDynamicAvatar } from '../components/cos/constants';

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

export default function ChiefOfStaff() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = useValidTab(TABS, 'tasks');

  const [status, setStatus] = useState(null);
  const [tasks, setTasks] = useState({ user: null, cos: null });
  const [agents, setAgents] = useState([]);
  const [health, setHealth] = useState(null);
  const [providers, setProviders] = useState([]);
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
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const tabsRef = useRef(null);
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

  // Derive agent state from system status
  const deriveAgentState = useCallback((statusData, agentsData, healthData) => {
    if (!statusData?.running) return 'sleeping';

    const activeAgents = agentsData.filter(a => a.status === 'running');
    if (activeAgents.length > 0) return 'coding';

    if (healthData?.issues?.length > 0) return 'investigating';

    // When running but idle, show as thinking (ready to work)
    return 'thinking';
  }, []);

  const fetchData = useCallback(async () => {
    const [statusData, tasksData, agentsData, healthData, providersData, appsData, learningSummaryData] = await Promise.all([
      api.getCosStatus().catch(() => null),
      api.getCosTasks().catch(() => ({ user: null, cos: null })),
      api.getCosAgents().catch(() => []),
      api.getCosHealth().catch(() => null),
      api.getProviders().catch(() => ({ providers: [] })),
      api.getApps().catch(() => []),
      api.getCosLearningSummary().catch(() => null)
    ]);
    setStatus(statusData);
    setTasks(tasksData);
    setAgents(agentsData);
    setHealth(healthData);
    setProviders(providersData.providers || []);
    // Filter out PortOS Autofixer (it's part of PortOS project)
    setApps(appsData.filter(a => a.id !== 'portos-autofixer'));
    setLearningSummary(learningSummaryData);
    setLoading(false);

    const newState = deriveAgentState(statusData, agentsData, healthData);
    setAgentState(newState);
    // Use default state message - real messages come from socket events
    setStatusMessage(STATE_MESSAGES[newState]);

    // Set active agent metadata for dynamic avatar (use first running agent)
    const runningAgent = agentsData.find(a => a.status === 'running');
    setActiveAgentMeta(runningAgent?.metadata || null);
  }, [deriveAgentState]);

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
      setHealth({ lastCheck: data.metrics?.timestamp, issues: data.issues });
      if (data.issues?.length > 0) {
        setAgentState('investigating');
        setStatusMessage(`Health check: ${data.issues.length} issue${data.issues.length > 1 ? 's' : ''} found`);
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
    // useCityData (CyberCity), useAgentFeedbackToast, and other always-mounted
    // consumers; the server's per-socket subscriber Set has no ref count.
    // Unsubscribing here would yank events out from under them.
    return () => {
      socket.off('connect', subscribe);
      socket.off('cos:status', handleCosStatus);
      socket.off('cos:tasks:user:changed', handleTasksUserChanged);
      socket.off('cos:agent:spawned', handleAgentSpawned);
      socket.off('cos:agent:updated', handleAgentUpdated);
      socket.off('cos:agent:output', handleAgentOutput);
      socket.off('cos:agent:completed', handleAgentCompleted);
      socket.off('cos:health:check', handleHealthCheck);
      socket.off('cos:log', handleCosLog);
      socket.off('apps:changed', handleAppsChanged);
    };
  }, [socket, fetchData]);

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
      setHealth({ lastCheck: result.metrics?.timestamp, issues: result.issues });
      toast.success('Health check complete');
      if (result.issues?.length > 0) {
        setStatusMessage(`Health: ${result.issues.length} issue${result.issues.length > 1 ? 's' : ''} detected`);
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
  const hasIssues = useMemo(() =>
    (health?.issues?.length || 0) > 0,
    [health?.issues?.length]
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
        label="Issues"
        value={health?.issues?.length || 0}
        icon={<AlertCircle className={`w-4 h-4 ${hasIssues ? 'text-port-error' : 'text-gray-500'}`} />}
        compact
      />
      <button
        onClick={() => navigate('/cos/learning')}
        className={`bg-port-card/80 border rounded px-2 py-1.5 flex items-center gap-2 transition-all ${
          learningSummary?.status === 'critical' ? 'border-port-error shadow-md shadow-port-error/20' :
          learningSummary?.status === 'warning' ? 'border-port-warning' :
          'border-port-border'
        }`}
      >
        <Brain className={`w-4 h-4 shrink-0 ${
          learningSummary?.status === 'critical' ? 'text-port-error' :
          learningSummary?.status === 'warning' ? 'text-port-warning' :
          learningSummary?.status === 'good' ? 'text-port-accent-2' :
          'text-gray-500'
        }`} />
        <div className="flex-1 min-w-0 text-left">
          <div className="text-[10px] text-gray-500">Learning</div>
          <div className="text-sm font-bold text-white flex items-center gap-2">
            {learningSummary?.overallSuccessRate != null ? `${learningSummary.overallSuccessRate}%` : 'No data'}
            {learningSummary?.skipped > 0 && (
              <span className="text-[9px] text-port-error font-normal">
                ({learningSummary.skipped} skipped)
              </span>
            )}
          </div>
        </div>
      </button>
      {status?.running ? (
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
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading" />
      </div>
    );
  }

  return (
    <div className={`relative flex flex-col lg:grid ${desktopPanelCollapsed ? 'lg:grid-cols-[0px_1fr]' : 'lg:grid-cols-[320px_1fr]'} h-full overflow-hidden transition-[grid-template-columns] duration-200`}>
      {/* Floating expand button - flush with nav edge when panel is collapsed */}
      {desktopPanelCollapsed && (
        <button
          onClick={toggleDesktopPanel}
          className="hidden lg:flex absolute left-0 top-2 z-20 p-1.5 text-gray-500 hover:text-white transition-colors rounded-r-md hover:bg-slate-800/80 bg-slate-900/60 border border-l-0 border-port-accent-2/20"
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
          <div className="lg:hidden border-b border-port-accent-2/20 bg-gradient-to-b from-slate-900/80 to-slate-900/40">
            <button
              onClick={() => setAgentPanelCollapsed(!agentPanelCollapsed)}
              className="flex items-center justify-between w-full px-3 py-2 bg-slate-900/60 border-b border-port-accent-2/20 min-h-[40px]"
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
                <StatusIndicator running={status?.running} />
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
                  <StatCard label="Issues" value={health?.issues?.length || 0} icon={<AlertCircle className={`w-4 h-4 ${hasIssues ? 'text-port-error' : 'text-gray-500'}`} />} compact />
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="relative flex flex-col border-b lg:border-b-0 lg:border-r border-port-accent-2/20 bg-gradient-to-b from-slate-900/80 to-slate-900/40 shrink-0 w-full max-w-full overflow-x-hidden lg:h-full lg:overflow-y-auto scrollbar-hide">
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
            className="lg:hidden flex items-center justify-between w-full px-3 py-2 bg-slate-900/60 border-b border-port-accent-2/20 min-h-[40px]"
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
              <StatusIndicator running={status?.running} />
            </div>
            <div className="flex items-center gap-1.5 text-gray-400">
              <StateLabel state={agentState} compact />
              {agentPanelCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
            </div>
          </button>

          {/* Collapsible Content */}
          <div
            id="cos-agent-panel"
            className={`${agentPanelCollapsed ? 'hidden' : 'flex'} lg:flex min-w-0 relative overflow-hidden ${hasCanvasAvatar ? 'flex-none min-h-dvh-cap [--dvh-cap:180px] sm:[--dvh-cap:190px] md:[--dvh-cap:190px] lg:[--dvh-cap:460px] lg:[--dvh-inset:1rem] xl:[--dvh-cap:620px]' : 'flex-1'}`}
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
              <div className="hidden lg:block text-sm font-semibold tracking-widest uppercase text-slate-400 mb-1 font-mono">
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
            label="Issues"
            value={health?.issues?.length || 0}
            icon={<AlertCircle className={`w-3 h-3 sm:w-4 sm:h-4 lg:w-5 lg:h-5 ${hasIssues ? 'text-port-error' : 'text-gray-500'}`} />}
            mini
          />
          {/* Learning Health - clickable to go to Learning tab */}
          <button
            onClick={() => navigate('/cos/learning')}
            className={`bg-port-card border rounded p-1.5 sm:p-2 lg:p-3 transition-all text-left hover:bg-port-card/80 ${
              learningSummary?.status === 'critical' ? 'border-port-error shadow-md shadow-port-error/20' :
              learningSummary?.status === 'warning' ? 'border-port-warning shadow-md shadow-port-warning/20' :
              'border-port-border hover:border-port-accent-2/50'
            }`}
            title={learningSummary?.statusMessage || 'View learning analytics'}
          >
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[10px] sm:text-xs text-gray-500 truncate">Learning</span>
              <Brain className={`w-3 h-3 sm:w-4 sm:h-4 lg:w-5 lg:h-5 shrink-0 ${
                learningSummary?.status === 'critical' ? 'text-port-error' :
                learningSummary?.status === 'warning' ? 'text-port-warning' :
                learningSummary?.status === 'good' ? 'text-port-accent-2' :
                'text-gray-500'
              }`} />
            </div>
            <div className="text-sm sm:text-base lg:text-xl font-bold text-white">
              {learningSummary?.overallSuccessRate != null ? `${learningSummary.overallSuccessRate}%` : '—'}
            </div>
            {learningSummary?.skipped > 0 && (
              <div className="text-[9px] text-port-error mt-0.5 truncate">
                {learningSummary.skipped} skipped
              </div>
            )}
          </button>
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
            <BriefingTab />
          </div>
        )}
        {activeTab === 'tasks' && (
          <div role="tabpanel" id="tabpanel-tasks" aria-labelledby="tab-tasks">
            {/* Tasks-only widgets live under the tab nav so they don't stretch above
                tabs that don't surface this data. */}
            <ActionableInsightsBanner onTaskUnblocked={handleTaskUnblocked} />
            <QuickSummary />
            <TasksTab tasks={tasks} onRefresh={fetchData} providers={providers} apps={apps} />
          </div>
        )}
        {activeTab === 'agents' && (
          <div role="tabpanel" id="tabpanel-agents" aria-labelledby="tab-agents">
            <AgentsTab agents={agents} onRefresh={fetchData} liveOutputs={liveOutputs} providers={providers} apps={apps} />
          </div>
        )}
        {activeTab === 'jobs' && (
          <div role="tabpanel" id="tabpanel-jobs" aria-labelledby="tab-jobs">
            <JobsTab />
          </div>
        )}
        {activeTab === 'schedule' && (
          <div role="tabpanel" id="tabpanel-schedule" aria-labelledby="tab-schedule">
            <ScheduleTab apps={apps} />
          </div>
        )}
        {activeTab === 'workflow' && (
          <div role="tabpanel" id="tabpanel-workflow" aria-labelledby="tab-workflow">
            <WorkflowTab apps={apps} />
          </div>
        )}
        {activeTab === 'digest' && (
          <div role="tabpanel" id="tabpanel-digest" aria-labelledby="tab-digest">
            <DigestTab />
          </div>
        )}
        {activeTab === 'gsd' && (
          <div role="tabpanel" id="tabpanel-gsd" aria-labelledby="tab-gsd">
            <GsdTab />
          </div>
        )}
        {activeTab === 'productivity' && (
          <div role="tabpanel" id="tabpanel-productivity" aria-labelledby="tab-productivity">
            <ProductivityTab />
          </div>
        )}
        {activeTab === 'learning' && (
          <div role="tabpanel" id="tabpanel-learning" aria-labelledby="tab-learning">
            <LearningTab />
          </div>
        )}
        {activeTab === 'memory' && (
          <div role="tabpanel" id="tabpanel-memory" aria-labelledby="tab-memory">
            <MemoryTab apps={apps} />
          </div>
        )}
        {activeTab === 'health' && (
          <div role="tabpanel" id="tabpanel-health" aria-labelledby="tab-health">
            <HealthTab health={health} onCheck={handleHealthCheck} />
          </div>
        )}
        {activeTab === 'config' && (
          <div role="tabpanel" id="tabpanel-config" aria-labelledby="tab-config">
            <ConfigTab config={status?.config} onUpdate={fetchData} onEvaluate={handleForceEvaluate} avatarStyle={configAvatarStyle} setAvatarStyle={setAvatarStyle} />
          </div>
        )}
      </div>
    </div>
  );
}
