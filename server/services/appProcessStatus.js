import { getAllApps } from './apps.js';
import { isDesktopType, usesPm2 } from './appProcessTypes.js';
import { listProcessesStrict } from './pm2.js';

export async function getDesktopProcessNames() {
  const apps = await getAllApps();
  const names = new Set();
  for (const app of apps) {
    if (isDesktopType(app.type)) {
      for (const name of app.pm2ProcessNames || []) names.add(name);
    }
    if (app.nativeLaunch?.processName) names.add(app.nativeLaunch.processName);
  }
  return names;
}

export async function resolvePm2HomeForProcess(processName) {
  const apps = await getAllApps();
  const app = apps.find(candidate =>
    candidate.pm2ProcessNames?.includes(processName)
    || candidate.nativeLaunch?.processName === processName
  );
  return app?.pm2Home || null;
}

export async function annotateExpectedExit(processes) {
  const desktopNames = await getDesktopProcessNames().catch(err => {
    console.error(`❌ Could not read the app registry for process supervision: ${err.message}`);
    return new Set();
  });
  return processes.map(p => ({ ...p, expectedExit: desktopNames.has(p?.name) }));
}

export async function getAppStatuses() {
  const apps = await getAllApps({ includeArchived: false });

  const homeGroups = new Map();
  for (const app of apps) {
    if (!usesPm2(app.type)) continue;
    const home = app.pm2Home || null;
    if (!homeGroups.has(home)) homeGroups.set(home, true);
  }

  const procMaps = new Map();
  const failedHomes = new Set();
  for (const home of homeGroups.keys()) {
    const procs = await listProcessesStrict(home);
    if (procs === null) {
      failedHomes.add(home);
      procMaps.set(home, new Map());
    } else {
      procMaps.set(home, new Map(procs.map(p => [p.name, p])));
    }
  }

  return apps.map(app => {
    const managed = usesPm2(app.type);
    const base = { id: app.id, name: app.name, type: app.type, repoPath: app.repoPath };
    if (!managed) {
      return { ...base, overallStatus: 'n/a', managed: false };
    }
    const home = app.pm2Home || null;
    if (failedHomes.has(home)) {
      return { ...base, overallStatus: 'unknown', managed: true, degraded: true };
    }
    const procMap = procMaps.get(home) || new Map();
    const names = app.pm2ProcessNames || [];
    let overallStatus = 'not_started';
    if (names.length > 0) {
      const statuses = names.map(n => procMap.get(n)?.status || 'not_found');
      if (statuses.some(s => s === 'online')) overallStatus = 'online';
      else if (statuses.some(s => s === 'stopped')) overallStatus = 'stopped';
      else overallStatus = 'not_started';
    }
    return { ...base, overallStatus, managed: true };
  });
}

export async function getAppStatusSummary() {
  const statuses = await getAppStatuses();
  const managed = statuses.filter(s => s.managed);
  const unknown = managed.filter(s => s.overallStatus === 'unknown').length;

  return {
    total: managed.length,
    online: managed.filter(s => s.overallStatus === 'online').length,
    stopped: managed.filter(s => s.overallStatus === 'stopped').length,
    notStarted: managed.filter(s => s.overallStatus === 'not_started').length,
    unknown,
    degraded: unknown > 0,
    unmanaged: statuses.length - managed.length
  };
}
