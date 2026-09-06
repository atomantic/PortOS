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
  nexus: Object.freeze(['nexus', 'health', 'operations', 'feature', 'district', 'activity', 'tree']),
  apps: Object.freeze(['app', 'desk', 'activity', 'tree']),
  agents: Object.freeze(['agent', 'task', 'desk', 'app', 'barrel', 'activity', 'tree']),
  goals: Object.freeze(['goal', 'jira', 'desk', 'app', 'activity', 'tree']),
  memory: Object.freeze(['memory', 'activity', 'tree']),
  data: Object.freeze(['storage', 'app', 'desk', 'barrel', 'task', 'activity', 'tree']),
  federation: Object.freeze(['peer', 'barrel', 'task', 'activity', 'tree']),
  activity: Object.freeze(['activity', 'productivity', 'tree']),
});

const CUSTOM_DISTRICT_ASSET_SLOTS = Object.freeze(['district']);

export function eidoverseResetAssetSlotsForDistrict(districtId, sources = []) {
  return [...new Set([
    ...(EIDOVERSE_RESET_ASSET_SLOTS[districtId] || CUSTOM_DISTRICT_ASSET_SLOTS),
    ...sources.map((source) => EIDOVERSE_SOURCE_KIND[source]).filter(Boolean),
  ])];
}
