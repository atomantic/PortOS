import { useState, useEffect, useCallback } from 'react';
import { useSocket } from '../hooks/useSocket';
import * as api from '../services/api';
import {
  Play,
  Square,
  RefreshCw,
  CheckCircle,
  Clock,
  AlertCircle,
  Ban,
  Activity,
  FileText,
  Settings,
  Cpu,
  Trash2,
  Plus,
  Edit3,
  Save,
  X,
  Terminal,
  Zap,
  GripVertical,
  Brain
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const TABS = [
  { id: 'tasks', label: 'Tasks', icon: FileText },
  { id: 'agents', label: 'Agents', icon: Cpu },
  { id: 'scripts', label: 'Scripts', icon: Terminal },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'health', label: 'Health', icon: Activity },
  { id: 'config', label: 'Config', icon: Settings }
];

const AGENT_STATES = {
  sleeping: { label: 'Sleeping', color: '#6366f1', icon: '💤' },
  thinking: { label: 'Thinking', color: '#f59e0b', icon: '🧠' },
  coding: { label: 'Coding', color: '#10b981', icon: '⚡' },
  investigating: { label: 'Investigating', color: '#ec4899', icon: '🔍' },
  reviewing: { label: 'Reviewing', color: '#8b5cf6', icon: '📋' },
  planning: { label: 'Planning', color: '#06b6d4', icon: '📐' },
  ideating: { label: 'Ideating', color: '#f97316', icon: '💡' },
};

const STATE_MESSAGES = {
  sleeping: ["Resting... Wake me if you need anything!", "💤 Power saving mode..."],
  thinking: ["Processing your request...", "Analyzing the situation...", "Let me think about this..."],
  coding: ["Writing some code...", "Implementing the solution...", "Building something cool..."],
  investigating: ["Looking into this...", "Researching the topic...", "Gathering information..."],
  reviewing: ["Checking the details...", "Reviewing for quality...", "Making sure everything's right..."],
  planning: ["Organizing the approach...", "Mapping out the strategy...", "Creating a plan..."],
  ideating: ["Brainstorming ideas...", "Getting creative!", "Inspiration incoming..."],
};

function CoSCharacter({ state, speaking }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;

  return (
    <div className="relative w-44 h-56 md:w-56 md:h-72">
      <svg viewBox="0 0 200 240" className="cos-character w-full h-auto">
        <defs>
          <linearGradient id="bodyGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#1e293b" />
            <stop offset="100%" stopColor="#0f172a" />
          </linearGradient>
          <linearGradient id="screenGrad" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={stateConfig.color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={stateConfig.color} stopOpacity="0.1" />
          </linearGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
          <filter id="innerGlow">
            <feGaussianBlur stdDeviation="2" result="blur"/>
            <feComposite in="SourceGraphic" in2="blur" operator="over"/>
          </filter>
        </defs>

        {/* Particles */}
        <g className={`particles particles-${state}`}>
          {[
            { cx: 30, cy: 50 },
            { cx: 170, cy: 60 },
            { cx: 25, cy: 130 },
            { cx: 175, cy: 140 },
            { cx: 40, cy: 200 },
            { cx: 160, cy: 190 }
          ].map((pos, i) => (
            <circle
              key={i}
              cx={pos.cx}
              cy={pos.cy}
              r="2"
              fill={stateConfig.color}
              opacity="0.6"
              className={`cos-particle cos-particle-${i}`}
            />
          ))}
        </g>

        {/* Body */}
        <rect x="50" y="90" width="100" height="120" rx="20" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" />

        {/* Chest Screen */}
        <rect x="60" y="100" width="80" height="50" rx="8" fill="#0f172a" stroke={stateConfig.color} strokeWidth="1" opacity="0.8" />
        <rect x="65" y="105" width="70" height="40" rx="5" fill="url(#screenGrad)" />

        {/* Chest Display Content */}
        <g className="chest-display">
          {state === 'coding' && (
            <g className="code-lines">
              {[0, 1, 2, 3].map(i => (
                <rect key={i} x="70" y={110 + i * 8} width={30 + (i % 2) * 15} height="3" rx="1" fill={stateConfig.color} opacity="0.8" className={`code-line code-line-${i}`} />
              ))}
            </g>
          )}
          {state === 'thinking' && (
            <g className="thinking-dots">
              {[0, 1, 2].map(i => (
                <circle key={i} cx={85 + i * 15} cy="125" r="4" fill={stateConfig.color} className={`thinking-dot thinking-dot-${i}`} />
              ))}
            </g>
          )}
          {state === 'planning' && (
            <g className="plan-grid">
              {[0, 1, 2].map(row =>
                [0, 1, 2].map(col => (
                  <rect key={`${row}-${col}`} x={72 + col * 20} y={108 + row * 12} width="15" height="8" rx="2" fill={stateConfig.color} opacity={0.4 + ((row + col) % 3) * 0.2} className="plan-cell" />
                ))
              )}
            </g>
          )}
          {state === 'investigating' && (
            <g className="scan-line-group">
              <line x1="70" y1="125" x2="130" y2="125" stroke={stateConfig.color} strokeWidth="2" className="scan-line" />
            </g>
          )}
          {state === 'reviewing' && (
            <g className="review-checks">
              {[0, 1, 2].map(i => (
                <path key={i} d={`M${75 + i * 20},125 l4,4 l8,-8`} stroke={stateConfig.color} strokeWidth="2" fill="none" className={`check check-${i}`} />
              ))}
            </g>
          )}
          {state === 'ideating' && (
            <g className="lightbulb">
              <ellipse cx="100" cy="120" rx="12" ry="15" fill={stateConfig.color} opacity="0.3" className="bulb-glow" />
              <ellipse cx="100" cy="120" rx="8" ry="10" fill={stateConfig.color} className="bulb" />
            </g>
          )}
          {state === 'sleeping' && (
            <g className="zzz">
              <text x="80" y="130" fill={stateConfig.color} fontSize="16" fontFamily="monospace" className="cos-z cos-z-1">Z</text>
              <text x="95" y="120" fill={stateConfig.color} fontSize="12" fontFamily="monospace" className="cos-z cos-z-2">z</text>
              <text x="105" y="112" fill={stateConfig.color} fontSize="8" fontFamily="monospace" className="cos-z cos-z-3">z</text>
            </g>
          )}
        </g>

        {/* Arms */}
        <rect x="30" y="100" width="18" height="60" rx="9" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" className={`arm arm-left arm-${state}`} />
        <rect x="152" y="100" width="18" height="60" rx="9" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" className={`arm arm-right arm-${state}`} />

        {/* Hands */}
        <circle cx="39" cy="165" r="10" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" className={`hand hand-left hand-${state}`} />
        <circle cx="161" cy="165" r="10" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" className={`hand hand-right hand-${state}`} />

        {/* Head */}
        <rect x="55" y="20" width="90" height="75" rx="15" fill="url(#bodyGrad)" stroke="#334155" strokeWidth="2" />

        {/* Face Screen */}
        <rect x="62" y="28" width="76" height="55" rx="10" fill="#0f172a" stroke={stateConfig.color} strokeWidth="1.5" filter="url(#innerGlow)" />

        {/* Eyes */}
        <g className={`eyes eyes-${state}`}>
          {state === 'sleeping' ? (
            <>
              <line x1="75" y1="50" x2="90" y2="50" stroke={stateConfig.color} strokeWidth="3" strokeLinecap="round" />
              <line x1="110" y1="50" x2="125" y2="50" stroke={stateConfig.color} strokeWidth="3" strokeLinecap="round" />
            </>
          ) : (
            <>
              <ellipse cx="82" cy="48" rx="10" ry={state === 'investigating' ? 12 : 8} fill={stateConfig.color} filter="url(#glow)" className="eye eye-left" />
              <ellipse cx="118" cy="48" rx="10" ry={state === 'investigating' ? 12 : 8} fill={stateConfig.color} filter="url(#glow)" className="eye eye-right" />
              <circle cx="82" cy="48" r="3" fill="#0f172a" className="pupil pupil-left" />
              <circle cx="118" cy="48" r="3" fill="#0f172a" className="pupil pupil-right" />
            </>
          )}
        </g>

        {/* Mouth */}
        <g className={`mouth mouth-${state} ${speaking ? 'speaking' : ''}`}>
          {speaking ? (
            <ellipse cx="100" cy="70" rx="12" ry="6" fill={stateConfig.color} opacity="0.8" className="mouth-open" />
          ) : state === 'sleeping' ? (
            <ellipse cx="100" cy="68" rx="8" ry="3" fill={stateConfig.color} opacity="0.5" />
          ) : (
            <path d="M88,68 Q100,78 112,68" stroke={stateConfig.color} strokeWidth="2" fill="none" strokeLinecap="round" />
          )}
        </g>

        {/* Antenna */}
        <line x1="100" y1="20" x2="100" y2="5" stroke="#334155" strokeWidth="3" />
        <circle cx="100" cy="5" r="5" fill={stateConfig.color} filter="url(#glow)" className="antenna-light" />

        {/* Status Light */}
        <circle cx="148" cy="35" r="4" fill={stateConfig.color} filter="url(#glow)" className="status-light" />
      </svg>
    </div>
  );
}

function StateLabel({ state }) {
  const stateConfig = AGENT_STATES[state] || AGENT_STATES.sleeping;

  return (
    <div
      className="flex items-center gap-2 px-4 py-2 rounded-full mt-4 font-mono text-xs"
      style={{
        background: 'rgba(15, 23, 42, 0.8)',
        border: `1px solid ${stateConfig.color}`,
        boxShadow: `0 0 20px rgba(99, 102, 241, 0.2)`
      }}
    >
      <span className="text-base">{stateConfig.icon}</span>
      <span className="text-gray-100">{stateConfig.label}</span>
    </div>
  );
}

function StatusBubble({ message }) {
  return (
    <div className="relative mt-4 px-4 py-3 rounded-2xl max-w-[280px] text-center text-sm leading-relaxed bg-indigo-500/10 border border-indigo-500/30">
      <div
        className="absolute -top-2 left-1/2 -translate-x-1/2 rotate-45 w-3.5 h-3.5 bg-indigo-500/10 border-l border-t border-indigo-500/30"
      />
      {message}
    </div>
  );
}

function EventLog({ logs }) {
  if (!logs || logs.length === 0) return null;

  const levelColors = {
    info: 'text-blue-400',
    warn: 'text-yellow-400',
    error: 'text-red-400',
    success: 'text-green-400',
    debug: 'text-gray-500'
  };

  const levelIcons = {
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌',
    success: '✅',
    debug: '🔍'
  };

  return (
    <div className="mt-4 w-full max-w-[280px]">
      <div className="text-xs text-gray-500 mb-1 font-mono">Event Log</div>
      <div className="bg-slate-900/80 border border-slate-700/50 rounded-lg p-2 max-h-32 overflow-y-auto">
        {logs.slice(-5).reverse().map((log, i) => (
          <div key={i} className={`text-xs font-mono py-0.5 ${levelColors[log.level] || 'text-gray-400'}`}>
            <span className="mr-1">{levelIcons[log.level] || '•'}</span>
            <span className="text-gray-500">{new Date(log.timestamp).toLocaleTimeString()}</span>
            {' '}
            <span>{log.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ChiefOfStaff() {
  const [status, setStatus] = useState(null);
  const [tasks, setTasks] = useState({ user: null, cos: null });
  const [agents, setAgents] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [health, setHealth] = useState(null);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('tasks');
  const [agentState, setAgentState] = useState('sleeping');
  const [speaking, setSpeaking] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Ready to help organize your day!");
  const [liveOutputs, setLiveOutputs] = useState({});
  const [eventLogs, setEventLogs] = useState([]);
  const socket = useSocket();

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
    const [statusData, tasksData, agentsData, scriptsData, healthData, providersData] = await Promise.all([
      api.getCosStatus().catch(() => null),
      api.getCosTasks().catch(() => ({ user: null, cos: null })),
      api.getCosAgents().catch(() => []),
      api.getCosScripts().catch(() => ({ scripts: [] })),
      api.getCosHealth().catch(() => null),
      api.getProviders().catch(() => ({ providers: [] }))
    ]);
    setStatus(statusData);
    setTasks(tasksData);
    setAgents(agentsData);
    setScripts(scriptsData.scripts || []);
    setHealth(healthData);
    setProviders(providersData.providers || []);
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
    <div className="flex flex-col lg:grid lg:grid-cols-[320px_1fr] min-h-[calc(100vh-120px)] -m-6">
      {/* Agent Panel */}
      <div className="relative flex flex-col items-center p-6 lg:p-8 border-b lg:border-b-0 lg:border-r border-indigo-500/20 bg-gradient-to-b from-slate-900/80 to-slate-900/40 overflow-hidden">
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
          <StatusBubble message={statusMessage} />
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

      {/* Content Panel */}
      <div className="flex-1 p-6 lg:p-8 overflow-y-auto">
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
        <div className="flex gap-1 mb-6 border-b border-port-border overflow-x-auto">
          {TABS.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                  activeTab === tab.id
                    ? 'text-port-accent border-port-accent'
                    : 'text-gray-500 border-transparent hover:text-white'
                }`}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        {activeTab === 'tasks' && (
          <TasksTab tasks={tasks} onRefresh={fetchData} providers={providers} />
        )}
        {activeTab === 'agents' && (
          <AgentsTab agents={agents} onRefresh={fetchData} liveOutputs={liveOutputs} />
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
          <ConfigTab config={status?.config} onUpdate={fetchData} onEvaluate={handleForceEvaluate} />
        )}
      </div>
    </div>
  );
}

function StatusIndicator({ running }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
      running
        ? 'bg-port-success/20 text-port-success'
        : 'bg-gray-700 text-gray-400'
    }`}>
      <span className={`w-2 h-2 rounded-full ${running ? 'bg-port-success animate-pulse' : 'bg-gray-500'}`} />
      {running ? 'Running' : 'Stopped'}
    </div>
  );
}

function StatCard({ label, value, icon, active, activeLabel }) {
  return (
    <div className={`bg-port-card border rounded-lg p-4 transition-all ${
      active ? 'border-port-accent shadow-lg shadow-port-accent/20' : 'border-port-border'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-500">{label}</span>
        <div className={active ? 'animate-pulse' : ''}>
          {icon}
        </div>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      {active && activeLabel && (
        <div className="text-xs text-port-accent mt-1 truncate animate-pulse">
          {activeLabel}
        </div>
      )}
    </div>
  );
}

function TasksTab({ tasks, onRefresh, providers }) {
  const [showAddTask, setShowAddTask] = useState(false);
  const [newTask, setNewTask] = useState({ id: '', description: '', context: '', model: '', provider: '' });
  const [userTasksLocal, setUserTasksLocal] = useState([]);
  const userTasks = tasks.user?.tasks || [];
  const cosTasks = tasks.cos?.tasks || [];

  // Keep local state in sync with server state
  useEffect(() => {
    setUserTasksLocal(userTasks);
  }, [userTasks]);

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = userTasksLocal.findIndex(t => t.id === active.id);
    const newIndex = userTasksLocal.findIndex(t => t.id === over.id);

    // Optimistically update local state
    const newOrder = arrayMove(userTasksLocal, oldIndex, newIndex);
    setUserTasksLocal(newOrder);

    // Persist to server
    const taskIds = newOrder.map(t => t.id);
    const result = await api.reorderCosTasks(taskIds).catch(err => {
      toast.error(err.message);
      setUserTasksLocal(userTasks); // Revert on error
      return null;
    });
    if (result?.success) {
      toast.success('Tasks reordered');
      onRefresh();
    }
  };

  // Get models for selected provider
  const selectedProvider = providers?.find(p => p.id === newTask.provider);
  const availableModels = selectedProvider?.models || [];

  const handleAddTask = async () => {
    if (!newTask.description.trim()) {
      toast.error('Description is required');
      return;
    }

    const taskId = newTask.id.trim() || `task-${Date.now()}`;
    await api.addCosTask({
      id: taskId,
      description: newTask.description,
      context: newTask.context,
      model: newTask.model || undefined,
      provider: newTask.provider || undefined
    }).catch(err => {
      toast.error(err.message);
      return;
    });

    toast.success('Task added');
    setNewTask({ id: '', description: '', context: '', model: '', provider: '' });
    setShowAddTask(false);
    onRefresh();
  };

  return (
    <div className="space-y-6">
      {/* User Tasks */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-white">User Tasks (TASKS.md)</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddTask(!showAddTask)}
              className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors"
            >
              <Plus size={16} />
              Add Task
            </button>
            <button
              onClick={onRefresh}
              className="text-gray-500 hover:text-white transition-colors"
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        {/* Add Task Form */}
        {showAddTask && (
          <div className="bg-port-card border border-port-accent/50 rounded-lg p-4 mb-4">
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Task ID (auto-generated if empty)"
                value={newTask.id}
                onChange={e => setNewTask(t => ({ ...t, id: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <input
                type="text"
                placeholder="Task description *"
                value={newTask.description}
                onChange={e => setNewTask(t => ({ ...t, description: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <input
                type="text"
                placeholder="Context (optional)"
                value={newTask.context}
                onChange={e => setNewTask(t => ({ ...t, context: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <div className="flex gap-3">
                <select
                  value={newTask.provider}
                  onChange={e => setNewTask(t => ({ ...t, provider: e.target.value, model: '' }))}
                  className="w-40 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                >
                  <option value="">Auto (default)</option>
                  {providers?.filter(p => p.enabled).map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <select
                  value={newTask.model}
                  onChange={e => setNewTask(t => ({ ...t, model: e.target.value }))}
                  className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
                  disabled={!newTask.provider}
                >
                  <option value="">{newTask.provider ? 'Select model...' : 'Select provider first'}</option>
                  {availableModels.map(m => (
                    <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                  ))}
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowAddTask(false)}
                  className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddTask}
                  className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors"
                >
                  <Plus size={14} />
                  Add
                </button>
              </div>
            </div>
          </div>
        )}

        {userTasksLocal.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No user tasks. Click "Add Task" or edit TASKS.md directly.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={userTasksLocal.map(t => t.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {userTasksLocal.map(task => (
                  <SortableTaskItem key={task.id} task={task} onRefresh={onRefresh} providers={providers} />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* System Tasks */}
      <div>
        <h3 className="text-lg font-semibold text-white mb-3">System Tasks (COS-TASKS.md)</h3>

        {cosTasks.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No system tasks.
          </div>
        ) : (
          <div className="space-y-2">
            {cosTasks.map(task => (
              <TaskItem key={task.id} task={task} isSystem onRefresh={onRefresh} providers={providers} />
            ))}
          </div>
        )}
      </div>

      {/* Awaiting Approval */}
      {tasks.cos?.awaitingApproval?.length > 0 && (
        <div>
          <h3 className="text-lg font-semibold text-yellow-500 mb-3">Awaiting Approval</h3>
          <div className="space-y-2">
            {tasks.cos.awaitingApproval.map(task => (
              <TaskItem key={task.id} task={task} awaitingApproval onRefresh={onRefresh} providers={providers} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SortableTaskItem({ task, onRefresh, providers }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1000 : 'auto',
  };

  return (
    <div ref={setNodeRef} style={style}>
      <TaskItem
        task={task}
        onRefresh={onRefresh}
        providers={providers}
        dragHandleProps={{ ...attributes, ...listeners }}
      />
    </div>
  );
}

function TaskItem({ task, isSystem, awaitingApproval, onRefresh, providers, dragHandleProps }) {
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({
    description: task.description,
    context: task.metadata?.context || '',
    model: task.metadata?.model || '',
    provider: task.metadata?.provider || ''
  });

  // Get models for selected provider in edit mode
  const editProvider = providers?.find(p => p.id === editData.provider);
  const editModels = editProvider?.models || [];

  const statusIcons = {
    pending: <Clock size={16} className="text-yellow-500" />,
    in_progress: <Activity size={16} className="text-port-accent animate-pulse" />,
    completed: <CheckCircle size={16} className="text-port-success" />,
    blocked: <Ban size={16} className="text-port-error" />
  };

  const handleStatusChange = async (newStatus) => {
    await api.updateCosTask(task.id, { status: newStatus }).catch(err => toast.error(err.message));
    toast.success(`Task marked as ${newStatus}`);
    onRefresh();
  };

  const handleSave = async () => {
    await api.updateCosTask(task.id, editData).catch(err => toast.error(err.message));
    toast.success('Task updated');
    setEditing(false);
    onRefresh();
  };

  const handleDelete = async () => {
    await api.deleteCosTask(task.id).catch(err => toast.error(err.message));
    toast.success('Task deleted');
    onRefresh();
  };

  const handleApprove = async () => {
    await api.approveCosTask(task.id).catch(err => toast.error(err.message));
    toast.success('Task approved');
    onRefresh();
  };

  return (
    <div className={`bg-port-card border rounded-lg p-4 group ${
      awaitingApproval ? 'border-yellow-500/50' : 'border-port-border'
    }`}>
      <div className="flex items-start gap-3">
        {/* Drag handle - only show for user tasks (not system or awaiting approval) */}
        {dragHandleProps && !isSystem && !awaitingApproval && (
          <button
            {...dragHandleProps}
            className="mt-0.5 cursor-grab active:cursor-grabbing text-gray-500 hover:text-gray-300 transition-colors touch-none"
            title="Drag to reorder"
          >
            <GripVertical size={16} />
          </button>
        )}
        <button
          onClick={() => handleStatusChange(task.status === 'completed' ? 'pending' : 'completed')}
          className="mt-0.5 hover:scale-110 transition-transform"
          title={task.status === 'completed' ? 'Mark as pending' : 'Mark as completed'}
        >
          {statusIcons[task.status]}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-sm font-mono text-gray-500">{task.id}</span>
            {isSystem && task.autoApproved && (
              <span className="px-2 py-0.5 rounded text-xs bg-port-success/20 text-port-success">AUTO</span>
            )}
            {awaitingApproval && (
              <button
                onClick={handleApprove}
                className="px-2 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors"
              >
                APPROVE
              </button>
            )}
          </div>

          {editing ? (
            <div className="space-y-2">
              <input
                type="text"
                value={editData.description}
                onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
                className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
              />
              <input
                type="text"
                placeholder="Context"
                value={editData.context}
                onChange={e => setEditData(d => ({ ...d, context: e.target.value }))}
                className="w-full px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
              />
              <div className="flex gap-2">
                <select
                  value={editData.provider}
                  onChange={e => setEditData(d => ({ ...d, provider: e.target.value, model: '' }))}
                  className="w-36 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                >
                  <option value="">Auto</option>
                  {providers?.filter(p => p.enabled).map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <select
                  value={editData.model}
                  onChange={e => setEditData(d => ({ ...d, model: e.target.value }))}
                  className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm"
                  disabled={!editData.provider}
                >
                  <option value="">{editData.provider ? 'Auto' : 'Select provider'}</option>
                  {editModels.map(m => (
                    <option key={m} value={m}>{m.replace('claude-', '').replace(/-\d+$/, '')}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  className="flex items-center gap-1 text-xs text-port-success hover:text-port-success/80"
                >
                  <Save size={12} /> Save
                </button>
                <button
                  onClick={() => setEditing(false)}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-white"
                >
                  <X size={12} /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="text-white">{task.description}</p>
              {task.metadata?.context && (
                <p className="text-sm text-gray-500 mt-1">{task.metadata.context}</p>
              )}
              {(task.metadata?.model || task.metadata?.provider) && (
                <div className="flex items-center gap-2 mt-1">
                  {task.metadata?.model && (
                    <span className="px-1.5 py-0.5 text-xs bg-purple-500/20 text-purple-400 rounded font-mono">
                      {task.metadata.model}
                    </span>
                  )}
                  {task.metadata?.provider && (
                    <span className="px-1.5 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 rounded">
                      {task.metadata.provider}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!editing && (
            <>
              <button
                onClick={() => setEditing(true)}
                className="p-1 text-gray-500 hover:text-white transition-colors"
                title="Edit"
              >
                <Edit3 size={14} />
              </button>
              <button
                onClick={handleDelete}
                className="p-1 text-gray-500 hover:text-port-error transition-colors"
                title="Delete"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentsTab({ agents, onRefresh, liveOutputs }) {
  const handleTerminate = async (agentId) => {
    await api.terminateCosAgent(agentId).catch(err => toast.error(err.message));
    toast.success('Terminate signal sent');
    onRefresh();
  };

  const handleDelete = async (agentId) => {
    await api.deleteCosAgent(agentId).catch(err => toast.error(err.message));
    toast.success('Agent removed');
    onRefresh();
  };

  const handleClearCompleted = async () => {
    await api.clearCompletedCosAgents().catch(err => toast.error(err.message));
    toast.success('Cleared completed agents');
    onRefresh();
  };

  const runningAgents = agents.filter(a => a.status === 'running');
  // Sort completed agents by completion time (most recent first)
  const completedAgents = agents
    .filter(a => a.status === 'completed')
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));

  return (
    <div className="space-y-6">
      {/* Active Agents */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold text-white">Active Agents</h3>
          {runningAgents.length > 0 && (
            <span className="text-sm text-port-accent animate-pulse">
              {runningAgents.length} running
            </span>
          )}
        </div>
        {runningAgents.length === 0 ? (
          <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
            No active agents. Start CoS and add tasks to see agents working.
          </div>
        ) : (
          <div className="space-y-2">
            {runningAgents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                onTerminate={handleTerminate}
                liveOutput={liveOutputs[agent.id]}
              />
            ))}
          </div>
        )}
      </div>

      {/* Completed Agents */}
      {completedAgents.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold text-white">
              Completed Agents
              <span className="text-sm text-gray-500 font-normal ml-2">
                ({completedAgents.length} total)
              </span>
            </h3>
            <button
              onClick={handleClearCompleted}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-port-error transition-colors"
            >
              <Trash2 size={14} />
              Clear
            </button>
          </div>
          <div className="space-y-2">
            {completedAgents.slice(0, 15).map(agent => (
              <AgentCard key={agent.id} agent={agent} completed onDelete={handleDelete} />
            ))}
            {completedAgents.length > 15 && (
              <div className="text-center text-sm text-gray-500 py-2">
                + {completedAgents.length - 15} more completed agents
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent, onTerminate, onDelete, completed, liveOutput }) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Determine if this is a system agent (health check, etc.)
  const isSystemAgent = agent.taskId?.startsWith('sys-') || agent.id?.startsWith('sys-');

  // Update duration display for running agents
  useEffect(() => {
    if (completed) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [completed]);

  const duration = agent.completedAt
    ? new Date(agent.completedAt) - new Date(agent.startedAt)
    : now - new Date(agent.startedAt);

  const formatDuration = (ms) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  };

  // Combine stored output with live output
  const output = liveOutput || agent.output || [];
  const lastOutput = output.length > 0 ? output[output.length - 1]?.line : null;

  return (
    <div className={`bg-port-card border rounded-lg overflow-hidden ${
      completed
        ? isSystemAgent ? 'border-port-border opacity-50' : 'border-port-border opacity-75'
        : 'border-port-accent/50'
    }`}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Cpu size={16} className={completed ? 'text-gray-500' : 'text-port-accent animate-pulse'} />
            <span className="font-mono text-sm text-gray-400">{agent.id}</span>
            {isSystemAgent && (
              <span className="px-1.5 py-0.5 text-xs bg-gray-500/20 text-gray-400 rounded">SYS</span>
            )}
            {agent.metadata?.model && (
              <span className={`px-2 py-0.5 text-xs rounded ${
                agent.metadata.modelTier === 'heavy' ? 'bg-purple-500/20 text-purple-400' :
                agent.metadata.modelTier === 'light' ? 'bg-green-500/20 text-green-400' :
                'bg-blue-500/20 text-blue-400'
              }`} title={agent.metadata.modelReason}>
                {agent.metadata.model.replace('claude-', '').replace(/-\d+$/, '')}
              </span>
            )}
            {!completed && (
              <span className={`px-2 py-0.5 text-xs rounded animate-pulse ${
                agent.metadata?.phase === 'initializing' ? 'bg-yellow-500/20 text-yellow-400' :
                agent.metadata?.phase === 'working' ? 'bg-port-accent/20 text-port-accent' :
                'bg-port-accent/20 text-port-accent'
              }`}>
                {agent.metadata?.phase === 'initializing' ? 'Initializing' :
                 agent.metadata?.phase === 'working' ? 'Working' :
                 'Running'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500">{formatDuration(duration)}</span>
            {output.length > 0 && (
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-gray-500 hover:text-white transition-colors text-xs"
              >
                {expanded ? 'Hide' : 'Show'} Output
              </button>
            )}
            {!completed && onTerminate && (
              <button
                onClick={() => onTerminate(agent.id)}
                className="text-gray-500 hover:text-port-error transition-colors"
                title="Terminate"
              >
                <Square size={14} />
              </button>
            )}
            {completed && onDelete && (
              <button
                onClick={() => onDelete(agent.id)}
                className="text-gray-500 hover:text-port-error transition-colors"
                title="Remove"
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>
        <p className="text-white text-sm mb-2">{agent.metadata?.taskDescription || agent.taskId}</p>

        {/* Status / Last output line */}
        {!completed && lastOutput && (
          <div className="text-xs text-gray-500 font-mono truncate bg-port-bg/50 px-2 py-1 rounded">
            {lastOutput.substring(0, 100)}...
          </div>
        )}

        {agent.result && (
          <div className={`text-sm flex items-center gap-2 ${agent.result.success ? 'text-port-success' : 'text-port-error'}`}>
            {agent.result.success ? (
              <><CheckCircle size={14} /> Completed successfully</>
            ) : (
              <><AlertCircle size={14} /> {agent.result.error || 'Failed'}</>
            )}
          </div>
        )}
      </div>

      {/* Expanded output view */}
      {expanded && output.length > 0 && (
        <div className="border-t border-port-border bg-port-bg/50 p-3 max-h-64 overflow-y-auto">
          <pre className="text-xs font-mono text-gray-400 whitespace-pre-wrap">
            {output.map((o, i) => (
              <div key={i} className="py-0.5">
                {o.line}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

function ScriptsTab({ scripts, onRefresh }) {
  const [showCreate, setShowCreate] = useState(false);
  const [newScript, setNewScript] = useState({
    name: '',
    description: '',
    command: '',
    schedule: 'on-demand',
    cronExpression: '',
    triggerAction: 'log-only',
    triggerPrompt: '',
    triggerPriority: 'MEDIUM'
  });

  const handleCreate = async () => {
    if (!newScript.name.trim() || !newScript.command.trim()) {
      toast.error('Name and command are required');
      return;
    }

    await api.createCosScript(newScript).catch(err => {
      toast.error(err.message);
      return;
    });

    toast.success('Script created');
    setNewScript({
      name: '',
      description: '',
      command: '',
      schedule: 'on-demand',
      cronExpression: '',
      triggerAction: 'log-only',
      triggerPrompt: '',
      triggerPriority: 'MEDIUM'
    });
    setShowCreate(false);
    onRefresh();
  };

  const handleRun = async (id) => {
    toast.loading('Running script...', { id: 'script-run' });
    const result = await api.runCosScript(id).catch(err => {
      toast.error(err.message, { id: 'script-run' });
      return null;
    });
    if (result) {
      if (result.success) {
        toast.success('Script completed', { id: 'script-run' });
      } else {
        toast.error(`Script failed: ${result.error || 'Unknown error'}`, { id: 'script-run' });
      }
      onRefresh();
    }
  };

  const handleToggle = async (script) => {
    await api.updateCosScript(script.id, { enabled: !script.enabled }).catch(err => toast.error(err.message));
    toast.success(script.enabled ? 'Script disabled' : 'Script enabled');
    onRefresh();
  };

  const handleDelete = async (id) => {
    await api.deleteCosScript(id).catch(err => toast.error(err.message));
    toast.success('Script deleted');
    onRefresh();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold text-white">Scheduled Scripts</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="flex items-center gap-1 text-sm text-port-accent hover:text-port-accent/80 transition-colors"
          >
            <Plus size={16} />
            New Script
          </button>
          <button
            onClick={onRefresh}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {/* Create Script Form */}
      {showCreate && (
        <div className="bg-port-card border border-port-accent/50 rounded-lg p-4 mb-4">
          <div className="space-y-3">
            <div className="flex gap-3">
              <input
                type="text"
                placeholder="Script name *"
                value={newScript.name}
                onChange={e => setNewScript(s => ({ ...s, name: e.target.value }))}
                className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <select
                value={newScript.schedule}
                onChange={e => setNewScript(s => ({ ...s, schedule: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="on-demand">On Demand</option>
                <option value="every-5-min">Every 5 min</option>
                <option value="every-15-min">Every 15 min</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <input
              type="text"
              placeholder="Description"
              value={newScript.description}
              onChange={e => setNewScript(s => ({ ...s, description: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            />
            <textarea
              placeholder="Shell command *"
              value={newScript.command}
              onChange={e => setNewScript(s => ({ ...s, command: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-20"
            />
            <div className="flex gap-3">
              <select
                value={newScript.triggerAction}
                onChange={e => setNewScript(s => ({ ...s, triggerAction: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="log-only">Log Only</option>
                <option value="spawn-agent">Spawn Agent</option>
              </select>
              <select
                value={newScript.triggerPriority}
                onChange={e => setNewScript(s => ({ ...s, triggerPriority: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="LOW">LOW</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="HIGH">HIGH</option>
                <option value="CRITICAL">CRITICAL</option>
              </select>
            </div>
            {newScript.triggerAction === 'spawn-agent' && (
              <textarea
                placeholder="Prompt for agent when triggered"
                value={newScript.triggerPrompt}
                onChange={e => setNewScript(s => ({ ...s, triggerPrompt: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm h-16"
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowCreate(false)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                className="flex items-center gap-1 px-3 py-1.5 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg text-sm transition-colors"
              >
                <Plus size={14} />
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scripts List */}
      {scripts.length === 0 ? (
        <div className="bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500">
          No scripts configured. Create a script to automate tasks.
        </div>
      ) : (
        <div className="space-y-2">
          {scripts.map(script => (
            <ScriptCard
              key={script.id}
              script={script}
              onRun={handleRun}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onUpdate={onRefresh}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScriptCard({ script, onRun, onToggle, onDelete, onUpdate }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editData, setEditData] = useState({
    name: script.name,
    description: script.description || '',
    command: script.command,
    schedule: script.schedule || 'on-demand',
    triggerAction: script.triggerAction || 'log-only',
    triggerPrompt: script.triggerPrompt || '',
    triggerPriority: script.triggerPriority || 'MEDIUM'
  });

  const handleSave = async () => {
    if (!editData.name.trim() || !editData.command.trim()) {
      toast.error('Name and command are required');
      return;
    }
    await api.updateCosScript(script.id, editData).catch(err => toast.error(err.message));
    toast.success('Script updated');
    setEditing(false);
    onUpdate?.();
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  };

  const scheduleLabels = {
    'on-demand': 'On Demand',
    'every-5-min': 'Every 5 min',
    'every-15-min': 'Every 15 min',
    'every-30-min': 'Every 30 min',
    'hourly': 'Hourly',
    'every-6-hours': 'Every 6 hours',
    'daily': 'Daily',
    'weekly': 'Weekly'
  };

  return (
    <div className={`bg-port-card border rounded-lg overflow-hidden ${
      script.enabled ? 'border-port-border' : 'border-port-border opacity-60'
    }`}>
      <div className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Terminal size={16} className={script.enabled ? 'text-port-accent' : 'text-gray-500'} />
            <span className="font-medium text-white">{script.name}</span>
            <span className={`px-2 py-0.5 text-xs rounded ${
              script.schedule === 'on-demand' ? 'bg-gray-500/20 text-gray-400' : 'bg-port-accent/20 text-port-accent'
            }`}>
              {scheduleLabels[script.schedule] || script.schedule}
            </span>
            {script.triggerAction === 'spawn-agent' && (
              <span className="px-2 py-0.5 text-xs bg-purple-500/20 text-purple-400 rounded">
                <Zap size={10} className="inline mr-1" />
                Triggers Agent
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onRun(script.id)}
              className="p-1.5 text-gray-500 hover:text-port-success transition-colors"
              title="Run now"
            >
              <Play size={14} />
            </button>
            <button
              onClick={() => setEditing(true)}
              className="p-1.5 text-gray-500 hover:text-white transition-colors"
              title="Edit"
            >
              <Edit3 size={14} />
            </button>
            <button
              onClick={() => onToggle(script)}
              className={`p-1.5 transition-colors ${
                script.enabled ? 'text-port-success hover:text-gray-500' : 'text-gray-500 hover:text-port-success'
              }`}
              title={script.enabled ? 'Disable' : 'Enable'}
            >
              {script.enabled ? <CheckCircle size={14} /> : <Ban size={14} />}
            </button>
            <button
              onClick={() => onDelete(script.id)}
              className="p-1.5 text-gray-500 hover:text-port-error transition-colors"
              title="Delete"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        {/* Edit Form */}
        {editing ? (
          <div className="space-y-3 mt-3">
            <div className="flex gap-3">
              <input
                type="text"
                placeholder="Script name *"
                value={editData.name}
                onChange={e => setEditData(d => ({ ...d, name: e.target.value }))}
                className="flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              />
              <select
                value={editData.schedule}
                onChange={e => setEditData(d => ({ ...d, schedule: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="on-demand">On Demand</option>
                <option value="every-5-min">Every 5 min</option>
                <option value="every-15-min">Every 15 min</option>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
            <input
              type="text"
              placeholder="Description"
              value={editData.description}
              onChange={e => setEditData(d => ({ ...d, description: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
            />
            <textarea
              placeholder="Shell command *"
              value={editData.command}
              onChange={e => setEditData(d => ({ ...d, command: e.target.value }))}
              className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm font-mono h-20"
            />
            <div className="flex gap-3">
              <select
                value={editData.triggerAction}
                onChange={e => setEditData(d => ({ ...d, triggerAction: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="log-only">Log Only</option>
                <option value="spawn-agent">Spawn Agent</option>
              </select>
              <select
                value={editData.triggerPriority}
                onChange={e => setEditData(d => ({ ...d, triggerPriority: e.target.value }))}
                className="px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm"
              >
                <option value="LOW">LOW</option>
                <option value="MEDIUM">MEDIUM</option>
                <option value="HIGH">HIGH</option>
                <option value="CRITICAL">CRITICAL</option>
              </select>
            </div>
            {editData.triggerAction === 'spawn-agent' && (
              <textarea
                placeholder="Prompt for agent when triggered"
                value={editData.triggerPrompt}
                onChange={e => setEditData(d => ({ ...d, triggerPrompt: e.target.value }))}
                className="w-full px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm h-16"
              />
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setEditing(false)}
                className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                className="flex items-center gap-1 px-3 py-1.5 bg-port-success/20 hover:bg-port-success/30 text-port-success rounded-lg text-sm transition-colors"
              >
                <Save size={14} />
                Save
              </button>
            </div>
          </div>
        ) : (
          <>
            {script.description && (
              <p className="text-sm text-gray-400 mb-2">{script.description}</p>
            )}

            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>Last run: {formatTime(script.lastRun)}</span>
              {script.lastExitCode !== null && (
                <span className={script.lastExitCode === 0 ? 'text-port-success' : 'text-port-error'}>
                  Exit: {script.lastExitCode}
                </span>
              )}
              <span>Runs: {script.runCount || 0}</span>
              {script.lastOutput && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="text-port-accent hover:text-port-accent/80"
                >
                  {expanded ? 'Hide' : 'Show'} output
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Command preview */}
      {!editing && (
        <div className="px-4 pb-3">
          <code className="text-xs text-gray-500 font-mono bg-port-bg/50 px-2 py-1 rounded block truncate">
            {script.command}
          </code>
        </div>
      )}

      {/* Expanded output */}
      {expanded && script.lastOutput && (
        <div className="border-t border-port-border bg-port-bg/50 p-3 max-h-48 overflow-y-auto">
          <pre className="text-xs font-mono text-gray-400 whitespace-pre-wrap">
            {script.lastOutput}
          </pre>
        </div>
      )}
    </div>
  );
}

function MemoryTab() {
  const [memories, setMemories] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [view, setView] = useState('list'); // list, timeline, graph
  const [filters, setFilters] = useState({ types: [], categories: [] });
  const [categories, setCategories] = useState([]);
  const [embeddingStatus, setEmbeddingStatus] = useState(null);

  const MEMORY_TYPES = ['fact', 'learning', 'observation', 'decision', 'preference', 'context'];
  const TYPE_COLORS = {
    fact: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    learning: 'bg-green-500/20 text-green-400 border-green-500/30',
    observation: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    decision: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    preference: 'bg-pink-500/20 text-pink-400 border-pink-500/30',
    context: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    const [memoriesRes, statsRes, catsRes, embRes] = await Promise.all([
      api.getMemories({ limit: 100, ...filters }).catch(() => ({ memories: [] })),
      api.getMemoryStats().catch(() => null),
      api.getMemoryCategories().catch(() => []),
      api.getEmbeddingStatus().catch(() => null)
    ]);
    setMemories(memoriesRes.memories || []);
    setStats(statsRes);
    setCategories(catsRes);
    setEmbeddingStatus(embRes);
    setLoading(false);
  }, [filters]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setLoading(true);
    const results = await api.searchMemories(searchQuery, { limit: 20 }).catch(() => ({ memories: [] }));
    setSearchResults(results.memories || []);
    setLoading(false);
  };

  const handleDelete = async (id) => {
    await api.deleteMemory(id);
    toast.success('Memory archived');
    fetchData();
  };

  const displayMemories = searchResults || memories;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">Memory System</h3>
          <p className="text-sm text-gray-500">
            {stats?.active || 0} active memories
            {embeddingStatus?.available ? ' • LM Studio connected' : ' • LM Studio offline'}
          </p>
        </div>
        <div className="flex gap-2">
          {['list', 'timeline', 'graph'].map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
                view === v ? 'bg-port-accent text-white' : 'bg-port-border text-gray-400 hover:text-white'
              }`}
            >
              {v.charAt(0).toUpperCase() + v.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="Search memories semantically..."
          className="flex-1 bg-port-card border border-port-border rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:border-port-accent outline-none"
        />
        <button
          onClick={handleSearch}
          className="px-4 py-2 bg-port-accent hover:bg-port-accent/80 text-white rounded-lg transition-colors"
        >
          Search
        </button>
        {searchResults && (
          <button
            onClick={() => { setSearchResults(null); setSearchQuery(''); }}
            className="px-3 py-2 bg-port-border text-gray-400 hover:text-white rounded-lg transition-colors"
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* Type Filters */}
      <div className="flex flex-wrap gap-2">
        {MEMORY_TYPES.map(type => (
          <button
            key={type}
            onClick={() => {
              const newTypes = filters.types.includes(type)
                ? filters.types.filter(t => t !== type)
                : [...filters.types, type];
              setFilters({ ...filters, types: newTypes });
            }}
            className={`px-3 py-1 text-xs rounded-full border transition-colors ${
              filters.types.includes(type) ? TYPE_COLORS[type] : 'border-port-border text-gray-500 hover:text-gray-300'
            }`}
          >
            {type}
          </button>
        ))}
      </div>

      {/* Stats Row */}
      {stats && (
        <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
          {Object.entries(stats.byType || {}).map(([type, count]) => (
            <div key={type} className={`p-2 rounded-lg border text-center ${TYPE_COLORS[type] || 'border-port-border'}`}>
              <div className="text-lg font-bold">{count}</div>
              <div className="text-xs opacity-75">{type}</div>
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw className="animate-spin text-port-accent" size={24} />
        </div>
      ) : view === 'list' ? (
        <div className="space-y-3">
          {displayMemories.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              {searchQuery ? 'No memories found for this search' : 'No memories yet. Memories are extracted from agent task completions.'}
            </div>
          ) : (
            displayMemories.map(memory => (
              <div key={memory.id} className="bg-port-card border border-port-border rounded-lg p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`px-2 py-0.5 text-xs rounded-full border ${TYPE_COLORS[memory.type]}`}>
                        {memory.type}
                      </span>
                      <span className="text-xs text-gray-500">{memory.category}</span>
                      {memory.similarity && (
                        <span className="text-xs text-port-accent">{(memory.similarity * 100).toFixed(0)}% match</span>
                      )}
                    </div>
                    <p className="text-white text-sm">{memory.summary || memory.content?.substring(0, 200)}</p>
                    {memory.tags?.length > 0 && (
                      <div className="flex gap-1 mt-2">
                        {memory.tags.map(tag => (
                          <span key={tag} className="px-2 py-0.5 text-xs bg-port-border rounded text-gray-400">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="text-xs text-gray-500 mt-2">
                      {new Date(memory.createdAt).toLocaleDateString()} • importance: {((memory.importance || 0.5) * 100).toFixed(0)}%
                    </div>
                  </div>
                  <button
                    onClick={() => handleDelete(memory.id)}
                    className="p-2 text-gray-500 hover:text-port-error transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      ) : view === 'timeline' ? (
        <MemoryTimeline memories={memories} />
      ) : (
        <MemoryGraph />
      )}
    </div>
  );
}

function MemoryTimeline({ memories }) {
  const grouped = memories.reduce((acc, m) => {
    const date = m.createdAt?.split('T')[0] || 'Unknown';
    if (!acc[date]) acc[date] = [];
    acc[date].push(m);
    return acc;
  }, {});

  const dates = Object.keys(grouped).sort().reverse();

  return (
    <div className="space-y-6">
      {dates.map(date => (
        <div key={date}>
          <div className="text-sm font-medium text-gray-400 mb-2 sticky top-0 bg-port-bg py-1">
            {new Date(date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
          </div>
          <div className="border-l border-port-border pl-4 space-y-3">
            {grouped[date].map(m => (
              <div key={m.id} className="relative">
                <div className="absolute -left-[21px] w-2 h-2 rounded-full bg-port-accent" />
                <div className="text-sm text-white">{m.summary}</div>
                <div className="text-xs text-gray-500 mt-1">{m.type} • {m.category}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MemoryGraph() {
  const [graphData, setGraphData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getMemoryGraph().then(setGraphData).catch(() => setGraphData(null)).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <RefreshCw className="animate-spin text-port-accent" size={24} />
      </div>
    );
  }

  if (!graphData || !graphData.nodes?.length) {
    return (
      <div className="text-center py-12 text-gray-500">
        No memory graph data available. Add more memories to see relationships.
      </div>
    );
  }

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 min-h-[400px]">
      <div className="text-center text-gray-500">
        <Brain size={48} className="mx-auto mb-4 text-port-accent/50" />
        <p>Graph visualization coming soon</p>
        <p className="text-sm mt-2">{graphData.nodes.length} nodes • {graphData.edges.length} connections</p>
      </div>
    </div>
  );
}

function HealthTab({ health, onCheck }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-white">System Health</h3>
          {health?.lastCheck && (
            <p className="text-sm text-gray-500">
              Last check: {new Date(health.lastCheck).toLocaleString()}
            </p>
          )}
        </div>
        <button
          onClick={onCheck}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
        >
          <RefreshCw size={14} />
          Run Check
        </button>
      </div>

      {!health?.issues || health.issues.length === 0 ? (
        <div className="bg-port-success/10 border border-port-success/30 rounded-lg p-6 text-center">
          <CheckCircle className="w-12 h-12 text-port-success mx-auto mb-3" />
          <p className="text-port-success font-medium">All Systems Healthy</p>
          <p className="text-gray-500 text-sm mt-1">No issues detected</p>
        </div>
      ) : (
        <div className="space-y-2">
          {health.issues.map((issue, idx) => (
            <div
              key={idx}
              className={`border rounded-lg p-4 ${
                issue.type === 'error'
                  ? 'bg-port-error/10 border-port-error/30'
                  : 'bg-yellow-500/10 border-yellow-500/30'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle size={16} className={issue.type === 'error' ? 'text-port-error' : 'text-yellow-500'} />
                <span className={`text-sm font-medium uppercase ${
                  issue.type === 'error' ? 'text-port-error' : 'text-yellow-500'
                }`}>
                  {issue.category}
                </span>
              </div>
              <p className="text-white">{issue.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConfigTab({ config, onUpdate, onEvaluate }) {
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState({
    evaluationIntervalMs: config?.evaluationIntervalMs || 60000,
    healthCheckIntervalMs: config?.healthCheckIntervalMs || 900000,
    maxConcurrentAgents: config?.maxConcurrentAgents || 3,
    maxProcessMemoryMb: config?.maxProcessMemoryMb || 2048,
    autoStart: config?.autoStart || false
  });

  const handleSave = async () => {
    await api.updateCosConfig(formData).catch(err => toast.error(err.message));
    toast.success('Configuration updated');
    setEditing(false);
    onUpdate();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-white">Configuration</h3>
        <div className="flex gap-2">
          <button
            onClick={onEvaluate}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded-lg transition-colors"
          >
            <Activity size={14} />
            Force Evaluate
          </button>
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors"
            >
              <Settings size={14} />
              Edit
            </button>
          ) : (
            <button
              onClick={handleSave}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-success/20 hover:bg-port-success/30 text-port-success rounded-lg transition-colors"
            >
              <CheckCircle size={14} />
              Save
            </button>
          )}
        </div>
      </div>

      <div className="bg-port-card border border-port-border rounded-lg divide-y divide-port-border">
        <ConfigRow
          label="Evaluation Interval"
          value={`${formData.evaluationIntervalMs / 1000}s`}
          editing={editing}
          type="number"
          inputValue={formData.evaluationIntervalMs / 1000}
          onChange={v => setFormData(f => ({ ...f, evaluationIntervalMs: v * 1000 }))}
          suffix="seconds"
        />
        <ConfigRow
          label="Health Check Interval"
          value={`${formData.healthCheckIntervalMs / 60000}m`}
          editing={editing}
          type="number"
          inputValue={formData.healthCheckIntervalMs / 60000}
          onChange={v => setFormData(f => ({ ...f, healthCheckIntervalMs: v * 60000 }))}
          suffix="minutes"
        />
        <ConfigRow
          label="Max Concurrent Agents"
          value={formData.maxConcurrentAgents}
          editing={editing}
          type="number"
          inputValue={formData.maxConcurrentAgents}
          onChange={v => setFormData(f => ({ ...f, maxConcurrentAgents: v }))}
        />
        <ConfigRow
          label="Max Process Memory"
          value={`${formData.maxProcessMemoryMb} MB`}
          editing={editing}
          type="number"
          inputValue={formData.maxProcessMemoryMb}
          onChange={v => setFormData(f => ({ ...f, maxProcessMemoryMb: v }))}
          suffix="MB"
        />
        <ConfigRow
          label="Auto Start"
          value={formData.autoStart ? 'Enabled' : 'Disabled'}
          editing={editing}
          type="checkbox"
          inputValue={formData.autoStart}
          onChange={v => setFormData(f => ({ ...f, autoStart: v }))}
        />
      </div>

      {/* MCP Servers */}
      <div>
        <h4 className="text-sm font-medium text-gray-400 mb-2">MCP Servers</h4>
        <div className="bg-port-card border border-port-border rounded-lg p-4">
          {config?.mcpServers?.map((mcp, idx) => (
            <div key={idx} className="flex items-center gap-2 text-sm">
              <span className="text-port-accent font-mono">{mcp.name}</span>
              <span className="text-gray-500">:</span>
              <span className="text-gray-400">{mcp.command} {mcp.args?.join(' ')}</span>
            </div>
          )) || <span className="text-gray-500">No MCP servers configured</span>}
        </div>
      </div>

      {/* Task Files */}
      <div>
        <h4 className="text-sm font-medium text-gray-400 mb-2">Task Files</h4>
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <FileText size={14} className="text-gray-500" />
            <span className="text-gray-400">User Tasks:</span>
            <span className="text-white font-mono">{config?.userTasksFile || 'TASKS.md'}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <FileText size={14} className="text-gray-500" />
            <span className="text-gray-400">System Tasks:</span>
            <span className="text-white font-mono">{config?.cosTasksFile || 'COS-TASKS.md'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConfigRow({ label, value, editing, type, inputValue, onChange, suffix }) {
  return (
    <div className="flex items-center justify-between p-4">
      <span className="text-gray-400">{label}</span>
      {editing ? (
        <div className="flex items-center gap-2">
          {type === 'checkbox' ? (
            <input
              type="checkbox"
              checked={inputValue}
              onChange={e => onChange(e.target.checked)}
              className="w-4 h-4 rounded border-port-border bg-port-bg text-port-accent focus:ring-port-accent"
            />
          ) : (
            <>
              <input
                type="number"
                value={inputValue}
                onChange={e => onChange(parseInt(e.target.value) || 0)}
                className="w-24 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-sm text-right"
              />
              {suffix && <span className="text-gray-500 text-sm">{suffix}</span>}
            </>
          )}
        </div>
      ) : (
        <span className="text-white">{value}</span>
      )}
    </div>
  );
}
