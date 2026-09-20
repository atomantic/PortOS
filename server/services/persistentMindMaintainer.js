/** Read-only setup preview. Intent never turns grants or inference on. */
import { normalizePersistentMindMaintainer, maintainerInstructionBlock } from '../lib/persistentMindMaintainer.js';
import { normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';
import { normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import { getDomainMode } from '../lib/domainAutonomy.js';
import { loadState } from './cosState.js';
import { readPersistentMindManagedApps } from './persistentMindManagedApps.js';

export async function describePersistentMindMaintainerSetup({ config } = {}) {
  const root = await loadState();
  const effective = config || root.config;
  const role = normalizePersistentMindMaintainer(effective?.persistentMindMaintainer);
  const capabilities = normalizePersistentMindCapabilities(effective?.persistentMindCapabilities);
  const profile = normalizePersistentMindProfile(effective?.persistentMindProfile);
  const roster = await readPersistentMindManagedApps({ allowedAppIds: capabilities.allowedAppIds });
  const apps = role.appIds.map(id => {
    const app = roster.find(candidate => candidate.id === id);
    return { id, name: app?.name || id, repository: app?.fullName || null,
      granted: app?.granted === true, available: !!app?.forge };
  });
  const permissions = ['readPortos', 'createTasks', 'fileIssues'].map(capability => ({
    capability, granted: capabilities[capability] === true,
  }));
  const prerequisites = [];
  if (!role.appIds.length) prerequisites.push('Select at least one managed repository.');
  if (apps.some(app => !app.available || !app.granted)) prerequisites.push('Every selected repository needs a resolved forge and managed-app permission.');
  for (const permission of permissions) {
    if (!permission.granted) prerequisites.push(`Grant ${permission.capability} separately in Persistent Mind Tools.`);
  }
  const { resolvePersistentMindProfile } = await import('./persistentMindProfile.js');
  const route = await resolvePersistentMindProfile(profile);
  if (!route.ok) prerequisites.push('Configure an enabled, available persistent mind provider and model.');
  if (getDomainMode(effective, 'cos') !== 'execute') prerequisites.push('CoS autonomy must allow execution.');
  if (root.paused) prerequisites.push('CoS is paused.');
  return {
    role, apps, permissions, prerequisites,
    availableApps: roster.map(app => ({ id: app.id, name: app.name, repository: app.fullName, granted: app.granted, available: !!app.forge })),
    ready: role.enabled && prerequisites.length === 0,
    readinessScope: 'configuration-only',
    profile: { enabled: profile.enabled, providerId: profile.providerId, model: profile.model, wakeIntervalMinutes: profile.wakeIntervalMinutes },
    schedule: { intervalMinutes: role.intervalMinutes, mode: 'programmatic', requiresWatchdog: true },
    instructions: maintainerInstructionBlock({ ...role, enabled: true }),
    machineLocal: true,
  };
}
