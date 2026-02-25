import {
  FileText,
  Cpu,
  Terminal,
  Brain,
  Activity,
  Settings,
  Calendar,
  Clock,
  GraduationCap,
  Bot,
  Flame,
  Newspaper
} from 'lucide-react';

export const TABS = [
  { id: 'briefing', label: 'Briefing', icon: Newspaper },
  { id: 'tasks', label: 'Tasks', icon: FileText },
  { id: 'agents', label: 'Agents', icon: Cpu },
  { id: 'jobs', label: 'Jobs', icon: Bot },
  { id: 'scripts', label: 'Scripts', icon: Terminal },
  { id: 'schedule', label: 'Schedule', icon: Clock },
  { id: 'digest', label: 'Digest', icon: Calendar },
  { id: 'productivity', label: 'Streaks', icon: Flame },
  { id: 'learning', label: 'Learning', icon: GraduationCap },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'health', label: 'Health', icon: Activity },
  { id: 'config', label: 'Config', icon: Settings }
];

export const AGENT_STATES = {
  sleeping: { label: 'Sleeping', color: '#6366f1', icon: '💤' },
  thinking: { label: 'Thinking', color: '#f59e0b', icon: '🧠' },
  coding: { label: 'Coding', color: '#10b981', icon: '⚡' },
  investigating: { label: 'Investigating', color: '#ec4899', icon: '🔍' },
  reviewing: { label: 'Reviewing', color: '#8b5cf6', icon: '📋' },
  planning: { label: 'Planning', color: '#06b6d4', icon: '📐' },
  ideating: { label: 'Ideating', color: '#f97316', icon: '💡' },
};

// Default messages shown when no specific event message is available
export const STATE_MESSAGES = {
  sleeping: "Idle - waiting for tasks...",
  thinking: "Processing...",
  coding: "Working on task...",
  investigating: "Investigating issue...",
  reviewing: "Reviewing results...",
  planning: "Planning next steps...",
  ideating: "Analyzing options...",
};

export const MEMORY_TYPES = ['fact', 'learning', 'observation', 'decision', 'preference', 'context'];

export const MEMORY_TYPE_COLORS = {
  fact: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  learning: 'bg-green-500/20 text-green-400 border-green-500/30',
  observation: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  decision: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  preference: 'bg-pink-500/20 text-pink-400 border-pink-500/30',
  context: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
};

// Autonomy level presets for CoS behavior
export const AUTONOMY_LEVELS = [
  {
    id: 'standby',
    label: 'Standby',
    color: 'green',
    description: 'Only processes user-defined tasks from TASKS.md',
    params: {
      evaluationIntervalMs: 300000,      // 5 min
      maxConcurrentAgents: 1,
      maxConcurrentAgentsPerProject: 1,
      improvementEnabled: false,
      proactiveMode: false,
      idleReviewEnabled: false,
      immediateExecution: false
    }
  },
  {
    id: 'assistant',
    label: 'Assistant',
    color: 'blue',
    description: 'Processes user tasks plus improvement tasks on schedule',
    params: {
      evaluationIntervalMs: 120000,      // 2 min
      maxConcurrentAgents: 2,
      maxConcurrentAgentsPerProject: 1,
      improvementEnabled: true,
      proactiveMode: false,
      idleReviewEnabled: false,
      immediateExecution: true
    }
  },
  {
    id: 'manager',
    label: 'Manager',
    color: 'yellow',
    description: 'Full task processing with app improvements, no proactive mode',
    params: {
      evaluationIntervalMs: 60000,       // 1 min
      maxConcurrentAgents: 3,
      maxConcurrentAgentsPerProject: 2,
      improvementEnabled: true,
      proactiveMode: false,
      idleReviewEnabled: true,
      immediateExecution: true
    }
  },
  {
    id: 'yolo',
    label: 'YOLO',
    color: 'red',
    description: 'Maximum autonomy with proactive task creation and frequent checks',
    params: {
      evaluationIntervalMs: 30000,       // 30 sec
      maxConcurrentAgents: 5,
      maxConcurrentAgentsPerProject: 3,
      improvementEnabled: true,
      proactiveMode: true,
      idleReviewEnabled: true,
      immediateExecution: true
    }
  }
];

// Get params for a specific autonomy level
export const computeAutonomyParams = (levelId) => {
  const level = AUTONOMY_LEVELS.find(l => l.id === levelId);
  return level ? level.params : null;
};

// Detect which autonomy level matches the current config (or null for custom)
export const detectAutonomyLevel = (config) => {
  if (!config) return null;

  for (const level of AUTONOMY_LEVELS) {
    const matches = Object.entries(level.params).every(([key, value]) => {
      return config[key] === value;
    });
    if (matches) return level.id;
  }
  return null; // Custom configuration
};

// Format milliseconds as human-readable interval
export const formatInterval = (ms) => {
  if (ms < 60000) return `${ms / 1000}s`;
  if (ms < 3600000) return `${ms / 60000}min`;
  return `${ms / 3600000}hr`;
};

// Avatar style labels for display
export const AVATAR_STYLE_LABELS = {
  svg: 'Digital (SVG)',
  cyber: 'Cyberpunk (3D)',
  sigil: 'Arcane Sigil (3D)',
  esoteric: 'Esoteric (3D)',
  nexus: 'Neural Nexus (3D)',
  ascii: 'Minimalist (ASCII)'
};

// Dynamic avatar rules - maps task context to avatar styles
// Priority order: provider > analysisType > taskType > priority > fallback
const DYNAMIC_AVATAR_RULES = {
  // Provider-based: different providers get distinct visual identities
  provider: {
    codex: 'esoteric',        // OpenAI Codex → mystical/ancient aesthetic
    'lm-studio': 'sigil',    // Local LM Studio → arcane/occult aesthetic
    'gemini-cli': 'sigil',   // Gemini → arcane aesthetic
  },
  // Improvement task analysis types → cyberpunk (system working on itself)
  analysisType: {
    security: 'cyber',
    'code-quality': 'cyber',
    'test-coverage': 'cyber',
    performance: 'cyber',
    'console-errors': 'cyber',
  },
  // Task analysis types
  taskType: {
    internal: 'sigil',        // Internal CoS tasks → arcane
  },
  // Priority-based: critical tasks get a distinctive look
  priority: {
    CRITICAL: 'esoteric',
  }
};

/**
 * Resolve which avatar style to display based on active agent metadata.
 * Returns null if no rule matches (caller should use configured default).
 */
export const resolveDynamicAvatar = (agentMetadata) => {
  if (!agentMetadata) return null;

  // Check provider rules first
  const providerId = agentMetadata.providerId || agentMetadata.provider;
  if (providerId && DYNAMIC_AVATAR_RULES.provider[providerId]) {
    return DYNAMIC_AVATAR_RULES.provider[providerId];
  }

  // Check analysis type (improvement tasks)
  const analysisType = agentMetadata.analysisType || agentMetadata.selfImprovementType;
  if (analysisType && DYNAMIC_AVATAR_RULES.analysisType[analysisType]) {
    return DYNAMIC_AVATAR_RULES.analysisType[analysisType];
  }

  // Check task type
  if (agentMetadata.taskType && DYNAMIC_AVATAR_RULES.taskType[agentMetadata.taskType]) {
    return DYNAMIC_AVATAR_RULES.taskType[agentMetadata.taskType];
  }

  // Check priority
  if (agentMetadata.priority && DYNAMIC_AVATAR_RULES.priority[agentMetadata.priority]) {
    return DYNAMIC_AVATAR_RULES.priority[agentMetadata.priority];
  }

  return null;
};
