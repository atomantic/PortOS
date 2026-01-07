import { useState, useEffect, useCallback } from 'react';
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
  const [statusMessage, setStatusMessage] = useState("Ready to help organize your day!");
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
    const messages = STATE_MESSAGES[newState];
    setStatusMessage(messages[Math.floor(Math.random() * messages.length)]);
  }, [deriveAgentState]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
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
        setStatusMessage(STATE_MESSAGES.sleeping[0]);
      }
    });

    socket.on('cos:tasks:user:changed', (data) => {
      setTasks(prev => ({ ...prev, user: data }));
    });

    socket.on('cos:agent:spawned', (data) => {
      setAgentState('coding');
      setStatusMessage("Working on a task...");
      setSpeaking(true);
      setTimeout(() => setSpeaking(false), 2000);
      // Initialize empty output buffer for new agent
      if (data?.agentId) {
        setLiveOutputs(prev => ({ ...prev, [data.agentId]: [] }));
      }
      fetchData();
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

    socket.on('cos:agent:completed', () => {
      setAgentState('reviewing');
      setStatusMessage("Task completed! Checking results...");
      setSpeaking(true);
      setTimeout(() => setSpeaking(false), 2000);
      fetchData();
    });

    socket.on('cos:health:check', (data) => {
      setHealth({ lastCheck: data.metrics?.timestamp, issues: data.issues });
      if (data.issues?.length > 0) {
        setAgentState('investigating');
        setStatusMessage("Found some issues to look into...");
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
      setStatusMessage("Starting up... Let me see what needs to be done!");
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
      setStatusMessage(STATE_MESSAGES.sleeping[0]);
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
    setStatusMessage("Running health check...");
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
        setStatusMessage("Found some issues!");
      } else {
        setAgentState('reviewing');
        setStatusMessage("All systems healthy!");
      }
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  const activeAgentCount = agents.filter(a => a.status === 'running').length;
  const hasIssues = (health?.issues?.length || 0) > 0;

  return (
    <div className="flex flex-col lg:grid lg:grid-cols-[320px_1fr] h-screen">
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
        <div className="relative flex flex-col items-center p-6 lg:p-8 border-b lg:border-b-0 lg:border-r border-indigo-500/20 bg-gradient-to-b from-slate-900/80 to-slate-900/40 h-full overflow-y-auto scrollbar-hide">
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

          <div className="relative z-10 flex flex-col items-center">
            <div className="text-sm font-semibold tracking-widest uppercase text-slate-400 mb-1 font-mono">
              Digital Assistant
            </div>
            <h1
              className="text-2xl lg:text-3xl font-bold mb-4 lg:mb-8"
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
            <StatusBubble message={statusMessage} countdown={evalCountdown} />
            {status?.running && <EventLog logs={eventLogs} />}

            {/* Control Buttons */}
            <div className="flex items-center gap-3 mt-6">
              {status?.running ? (
                <button
                  onClick={handleStop}
                  className="flex items-center gap-2 px-4 py-2 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors"
                >
                  <Square size={16} />
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleStart}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-lg transition-colors"
                >
                  <Play size={16} />
                  Start
                </button>
              )}
              <StatusIndicator running={status?.running} />
            </div>
          </div>
        </div>
      )}

      {/* Content Panel */}
      <div className="flex-1 p-3 lg:p-4 overflow-y-auto">
        {/* Stats Bar */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <StatCard
            label="Active Agents"
            value={activeAgentCount}
            icon={<Cpu className="w-5 h-5 text-port-accent" />}
            active={activeAgentCount > 0}
            activeLabel={activeAgentCount > 0 ? agents.find(a => a.status === 'running')?.taskId : null}
          />
          <StatCard
            label="Pending Tasks"
            value={(tasks.user?.grouped?.pending?.length || 0) + (tasks.cos?.grouped?.pending?.length || 0)}
            icon={<Clock className="w-5 h-5 text-yellow-500" />}
          />
          <StatCard
            label="Completed"
            value={status?.stats?.tasksCompleted || 0}
            icon={<CheckCircle className="w-5 h-5 text-port-success" />}
          />
          <StatCard
            label="Health Issues"
            value={health?.issues?.length || 0}
            icon={<AlertCircle className={`w-5 h-5 ${hasIssues ? 'text-port-error' : 'text-gray-500'}`} />}
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-port-border overflow-x-auto scrollbar-hide">
          {TABS.map(tabItem => {
            const Icon = tabItem.icon;
            return (
              <button
                key={tabItem.id}
                onClick={() => navigate(`/cos/${tabItem.id}`)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                  activeTab === tabItem.id
                    ? 'text-port-accent border-port-accent'
                    : 'text-gray-500 border-transparent hover:text-white'
                }`}
              >
                <Icon size={16} />
                {tabItem.label}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        {activeTab === 'tasks' && (
          <TasksTab tasks={tasks} onRefresh={fetchData} providers={providers} apps={apps} />
        )}
        {activeTab === 'agents' && (
          <AgentsTab agents={agents} onRefresh={fetchData} liveOutputs={liveOutputs} providers={providers} apps={apps} />
        )}
        {activeTab === 'scripts' && (
          <ScriptsTab scripts={scripts} onRefresh={fetchData} />
        )}
        {activeTab === 'memory' && (
          <MemoryTab />
        )}
        {activeTab === 'health' && (
          <HealthTab health={health} onCheck={handleHealthCheck} />
        )}
        {activeTab === 'config' && (
          <ConfigTab config={status?.config} onUpdate={fetchData} onEvaluate={handleForceEvaluate} avatarStyle={avatarStyle} setAvatarStyle={setAvatarStyle} evalCountdown={evalCountdown} />
        )}
      </div>
    </div>
  );
}
