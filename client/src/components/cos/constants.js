import {
  FileText,
  Cpu,
  Terminal,
  Brain,
  Activity,
  Settings
} from 'lucide-react';

export const TABS = [
  { id: 'tasks', label: 'Tasks', icon: FileText },
  { id: 'agents', label: 'Agents', icon: Cpu },
  { id: 'scripts', label: 'Scripts', icon: Terminal },
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
