import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSocket } from '../hooks/useSocket';
import * as api from '../services/api';
import { Play, Square, Clock, CheckCircle, AlertCircle, Cpu } from 'lucide-react';
import toast from 'react-hot-toast';

// Import from modular components
import {
  TABS,
  STATE_MESSAGES,
  useNextEvalCountdown,
  CoSCharacter,
  StateLabel,
  TerminalCoSPanel,
  StatusIndicator,
  StatCard,
  StatusBubble,
  EventLog,
  TasksTab,
  AgentsTab,
  ScriptsTab,
  DigestTab,
  MemoryTab,
  HealthTab,
  ConfigTab
} from '../components/cos';

export default function ChiefOfStaff() {
  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab || 'tasks';

  const [status, setStatus] = useState(null);
  const [tasks, setTasks] = useState({ user: null, cos: null });
  const [agents, setAgents] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [health, setHealth] = useState(null);
  const [providers, setProviders] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [agentState, setAgentState] = useState('sleeping');
  const [speaking, setSpeaking] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Idle - waiting for tasks...");
  const [liveOutputs, setLiveOutputs] = useState({});
  const [eventLogs, setEventLogs] = useState([]);
  const socket = useSocket();

  // Derive avatar style from server config
  const avatarStyle = status?.config?.avatarStyle || 'svg';

  // Update avatar style via server config
  const setAvatarStyle = async (style) => {
    await api.updateCosConfig({ avatarStyle: style });
    fetchData();
  };

  // Countdown to next evaluation
  const evalCountdown = useNextEvalCountdown(
    status?.stats?.lastEvaluation,
    status?.config?.evaluationIntervalMs,
    status?.running
  );

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
    const [statusData, tasksData, agentsData, scriptsData, healthData, providersData, appsData] = await Promise.all([
      api.getCosStatus().catch(() => null),
      api.getCosTasks().catch(() => ({ user: null, cos: null })),
      api.getCosAgents().catch(() => []),
      api.getCosScripts().catch(() => ({ scripts: [] })),
      api.getCosHealth().catch(() => null),
      api.getProviders().catch(() => ({ providers: [] })),
      api.getApps().catch(() => [])
    ]);
    setStatus(statusData);
    setTasks(tasksData);
    setAgents(agentsData);
    setScripts(scriptsData.scripts || []);
    setHealth(healthData);
    setProviders(providersData.providers || []);
    // Filter out PortOS Autofixer (it's part of PortOS project)
    setApps(appsData.filter(a => a.id !== 'portos-autofixer'));
    setLoading(false);

    const newState = deriveAgentState(statusData, agentsData, healthData);
    setAgentState(newState);
    // Use default state message - real messages come from socket events
    setStatusMessage(STATE_MESSAGES[newState]);
  }, [deriveAgentState]);

  useEffect(() => {
    fetchData();
    // Reduced polling since most updates come via socket events
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  useEffect(() => {
    if (!socket) return;

    // Subscribe when socket is connected (or already connected)
    const subscribe = () => {
      socket.emit('cos:subscribe');
    };

    if (socket.connected) {
      subscribe();
    } else {
      socket.on('connect', subscribe);
    }

    socket.on('cos:status', (data) => {
      setStatus(prev => ({ ...prev, running: data.running }));
      if (!data.running) {
        setAgentState('sleeping');
        setStatusMessage("Stopped - daemon not running");
      }
    });

    socket.on('cos:tasks:user:changed', (data) => {
      setTasks(prev => ({ ...prev, user: data }));
    });

    socket.on('cos:agent:spawned', (data) => {
      setAgentState('coding');
      // Show actual task description if available
      const taskDesc = data?.metadata?.taskDescription;
      const shortDesc = taskDesc ? taskDesc.substring(0, 60) + (taskDesc.length > 60 ? '...' : '') : 'Working on task...';
      setStatusMessage(`Running: ${shortDesc}`);
      setSpeaking(true);
      setTimeout(() => setSpeaking(false), 2000);
      // Initialize empty output buffer for new agent
      if (data?.agentId || data?.id) {
        setLiveOutputs(prev => ({ ...prev, [data.agentId || data.id]: [] }));
      }
      fetchData();
    });

    socket.on('cos:agent:updated', (updatedAgent) => {
      // Update the specific agent in the agents list without fetching all data
      setAgents(prev => prev.map(agent =>
        agent.id === updatedAgent.id ? updatedAgent : agent
      ));
    });

    socket.on('cos:agent:output', (data) => {
      if (data?.agentId && data?.line) {
        setLiveOutputs(prev => ({
          ...prev,
          [data.agentId]: [
            ...(prev[data.agentId] || []),
            { line: data.line, timestamp: Date.now() }
          ]
        }));
      }
    });

    socket.on('cos:agent:completed', (data) => {
      setAgentState('reviewing');
      const success = data?.result?.success;
      setStatusMessage(success ? "Task completed successfully" : "Task failed - checking errors...");
      setSpeaking(true);
      setTimeout(() => setSpeaking(false), 2000);
      fetchData();
    });

    socket.on('cos:health:check', (data) => {
      setHealth({ lastCheck: data.metrics?.timestamp, issues: data.issues });
      if (data.issues?.length > 0) {
        setAgentState('investigating');
        setStatusMessage(`Health check: ${data.issues.length} issue${data.issues.length > 1 ? 's' : ''} found`);
        setSpeaking(true);
        setTimeout(() => setSpeaking(false), 2000);
      }
    });

    // Listen for detailed log events
    socket.on('cos:log', (data) => {
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
    });

    // Listen for apps changes (start/stop/restart)
    socket.on('apps:changed', () => {
      fetchData();
    });

    return () => {
      socket.emit('cos:unsubscribe');
      socket.off('connect', subscribe);
      socket.off('cos:status');
      socket.off('cos:tasks:user:changed');
      socket.off('cos:agent:spawned');
      socket.off('cos:agent:output');
      socket.off('cos:agent:completed');
      socket.off('cos:health:check');
      socket.off('cos:log');
      socket.off('apps:changed');
    };
  }, [socket, fetchData]);

  const handleStart = async () => {
    const result = await api.startCos().catch(err => {
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
    const result = await api.stopCos().catch(err => {
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
    await api.forceCosEvaluate().catch(err => toast.error(err.message));
    toast.success('Evaluation triggered');
    setAgentState('thinking');
    setStatusMessage("Evaluating tasks...");
    setSpeaking(true);
    setTimeout(() => setSpeaking(false), 2000);
  };

  const handleHealthCheck = async () => {
    setAgentState('investigating');
    setStatusMessage("Running system health check...");
    setSpeaking(true);
    const result = await api.forceHealthCheck().catch(err => {
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:grid lg:grid-cols-[320px_1fr] h-screen overflow-hidden">
      {/* Agent Panel */}
      {avatarStyle === 'ascii' ? (
        <TerminalCoSPanel
          state={agentState}
          speaking={speaking}
          statusMessage={statusMessage}
          eventLogs={eventLogs}
          running={status?.running}
          onStart={handleStart}
          onStop={handleStop}
          stats={status?.stats}
          evalCountdown={evalCountdown}
        />
      ) : (
        <div className="relative flex border-b lg:border-b-0 lg:border-r border-indigo-500/20 bg-gradient-to-b from-slate-900/80 to-slate-900/40 shrink-0 lg:h-full lg:overflow-y-auto scrollbar-hide">
          {/* Background Effects */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: `
                radial-gradient(circle at 50% 20%, rgba(99, 102, 241, 0.1) 0%, transparent 50%),
                repeating-linear-gradient(0deg, transparent, transparent 50px, rgba(99, 102, 241, 0.03) 50px, rgba(99, 102, 241, 0.03) 51px)
              `
            }}
          />

          {/* Avatar Column - half width on mobile, full on desktop */}
          <div className="flex-1 lg:flex-none flex flex-col items-center p-4 lg:p-8 relative z-10">
            <div className="hidden lg:block text-sm font-semibold tracking-widest uppercase text-slate-400 mb-1 font-mono">
              Digital Assistant
            </div>
            <h1
              className="text-lg sm:text-xl lg:text-3xl font-bold mb-2 lg:mb-8"
              style={{
                background: 'linear-gradient(135deg, #6366f1, #8b5cf6, #06b6d4)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text'
              }}
            >
              Chief of Staff
            </h1>

            <CoSCharacter state={agentState} speaking={speaking} />
            <StateLabel state={agentState} />
            <div className="hidden sm:block">
              <StatusBubble message={statusMessage} countdown={evalCountdown} />
            </div>
            <div className="hidden lg:block">
              {status?.running && <EventLog logs={eventLogs} />}
            </div>

            {/* Control Buttons */}
            <div className="flex items-center gap-2 sm:gap-3 mt-3 lg:mt-6">
              {status?.running ? (
                <button
                  onClick={handleStop}
                  className="flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors"
                  aria-label="Stop Chief of Staff agent"
                >
                  <Square size={14} className="sm:w-4 sm:h-4" aria-hidden="true" />
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  className="flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-1.5 sm:py-2 text-sm sm:text-base bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-lg transition-colors"
                  aria-label="Start Chief of Staff agent"
                >
                  <Play size={14} className="sm:w-4 sm:h-4" aria-hidden="true" />
                  Start
                </button>
              )}
              <StatusIndicator running={status?.running} />
            </div>
          </div>

          {/* Mobile Stats Column - only visible on mobile */}
          <div className="flex-1 flex flex-col justify-center gap-2 p-3 lg:hidden relative z-10">
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
              icon={<Clock className="w-4 h-4 text-yellow-500" />}
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
          </div>
        </div>
      )}

      {/* Content Panel */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="overflow-y-auto p-3 lg:p-4">
        {/* Stats Bar - hidden on mobile for SVG mode (shown in avatar panel instead) */}
        <div className={`grid grid-cols-4 gap-1.5 sm:gap-2 lg:gap-3 mb-3 sm:mb-4 lg:mb-6 ${avatarStyle !== 'ascii' ? 'hidden lg:grid' : ''}`}>
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
            icon={<Clock className="w-3 h-3 sm:w-4 sm:h-4 lg:w-5 lg:h-5 text-yellow-500" />}
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
        </div>

        {/* Tabs */}
        <div role="tablist" aria-label="Chief of Staff sections" className="flex gap-1 mb-6 border-b border-port-border overflow-x-auto scrollbar-hide">
          {TABS.map(tabItem => {
            const Icon = tabItem.icon;
            const isSelected = activeTab === tabItem.id;
            return (
              <button
                key={tabItem.id}
                role="tab"
                aria-selected={isSelected}
                aria-controls={`tabpanel-${tabItem.id}`}
                id={`tab-${tabItem.id}`}
                onClick={() => navigate(`/cos/${tabItem.id}`)}
                className={`flex items-center gap-2 px-3 sm:px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                  isSelected
                    ? 'text-port-accent border-port-accent'
                    : 'text-gray-500 border-transparent hover:text-white'
                }`}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="hidden sm:inline">{tabItem.label}</span>
                <span className="sr-only sm:hidden">{tabItem.label}</span>
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        {activeTab === 'tasks' && (
          <div role="tabpanel" id="tabpanel-tasks" aria-labelledby="tab-tasks">
            <TasksTab tasks={tasks} onRefresh={fetchData} providers={providers} apps={apps} />
          </div>
        )}
        {activeTab === 'agents' && (
          <div role="tabpanel" id="tabpanel-agents" aria-labelledby="tab-agents">
            <AgentsTab agents={agents} onRefresh={fetchData} liveOutputs={liveOutputs} providers={providers} apps={apps} />
          </div>
        )}
        {activeTab === 'scripts' && (
          <div role="tabpanel" id="tabpanel-scripts" aria-labelledby="tab-scripts">
            <ScriptsTab scripts={scripts} onRefresh={fetchData} />
          </div>
        )}
        {activeTab === 'digest' && (
          <div role="tabpanel" id="tabpanel-digest" aria-labelledby="tab-digest">
            <DigestTab />
          </div>
        )}
        {activeTab === 'memory' && (
          <div role="tabpanel" id="tabpanel-memory" aria-labelledby="tab-memory">
            <MemoryTab />
          </div>
        )}
        {activeTab === 'health' && (
          <div role="tabpanel" id="tabpanel-health" aria-labelledby="tab-health">
            <HealthTab health={health} onCheck={handleHealthCheck} />
          </div>
        )}
        {activeTab === 'config' && (
          <div role="tabpanel" id="tabpanel-config" aria-labelledby="tab-config">
            <ConfigTab config={status?.config} onUpdate={fetchData} onEvaluate={handleForceEvaluate} avatarStyle={avatarStyle} setAvatarStyle={setAvatarStyle} evalCountdown={evalCountdown} />
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
