// Constants
export { TABS, AGENT_STATES, STATE_MESSAGES, MEMORY_TYPES, MEMORY_TYPE_COLORS } from './constants';

// Avatar/Character Components
// The five three.js *CoSAvatar variants are intentionally NOT re-exported:
// ChiefOfStaff.jsx lazy-imports them per variant, and a static barrel
// re-export pulls them all back into the eager chunk
// (Rollup INEFFECTIVE_DYNAMIC_IMPORT).
export { default as CoSCharacter } from './CoSCharacter';
export { default as StateLabel } from './StateLabel';
export { default as TerminalCoSPanel } from './TerminalCoSPanel';

// UI Components
export { default as StatusIndicator } from './StatusIndicator';
export { default as StatCard } from './StatCard';
export { default as StatusBubble } from './StatusBubble';
export { default as EventLog } from './EventLog';
export { default as QuickSummary } from './QuickSummary';
export { default as ActionableInsightsBanner } from './ActionableInsightsBanner';
export { default as DailyTrendsChart } from './DailyTrendsChart';

// Tab Components
export { default as TasksTab } from './tabs/TasksTab';
export { default as AgentsTab } from './tabs/AgentsTab';
export { default as JobsTab } from './tabs/JobsTab';
export { default as ScheduleTab } from './tabs/ScheduleTab';
export { default as WorkflowTab } from './tabs/WorkflowTab';
export { default as LearningTab } from './tabs/LearningTab';
export { default as MemoryTab } from './tabs/MemoryTab';
export { default as HealthTab } from './tabs/HealthTab';
export { default as ConfigTab } from './tabs/ConfigTab';
export { default as DigestTab } from './tabs/DigestTab';
export { default as GsdTab } from './tabs/GsdTab';
export { default as ProductivityTab } from './tabs/ProductivityTab';
export { default as BriefingTab } from './tabs/BriefingTab';
