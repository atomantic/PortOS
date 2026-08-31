export const EIDOVERSE_SOURCE_KIND = Object.freeze({
  apps: 'app',
  agents: 'agent',
  tasks: 'task',
  features: 'feature',
  peers: 'peer',
  health: 'health',
  productivity: 'productivity',
  activity: 'activity',
  goals: 'goal',
  memory: 'memory',
  storage: 'storage',
  jira: 'jira',
  operations: 'operations',
});

export const EIDOVERSE_RESET_ASSET_SLOTS = Object.freeze({
  nexus: Object.freeze(['nexus', 'health', 'operations', 'feature', 'district']),
  apps: Object.freeze(['app']),
  agents: Object.freeze(['agent', 'task']),
  goals: Object.freeze(['goal', 'jira']),
  memory: Object.freeze(['memory']),
  data: Object.freeze(['storage']),
  federation: Object.freeze(['peer']),
  activity: Object.freeze(['activity', 'productivity']),
});
