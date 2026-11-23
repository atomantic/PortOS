/**
 * The one launch path for the managed Eidoverse sequencer. Upstream joins by name
 * with no token, so reaching its port is owner authority over the world: every
 * PortOS start, restart and boot reconcile goes through here so the process is
 * only ever created with the loopback preload (#17865).
 */
import { ServerError } from '../lib/errorHandler.js';
import { eidoverseStartCommand, hasLoopbackPreload, withLoopbackPreload } from '../lib/eidoverseStartCommand.js';
import { getAllApps, notifyAppsChanged, updateApp } from './apps.js';
import {
  EIDOVERSE_MAX_MEMORY_RESTART,
  EIDOVERSE_PORT,
  EIDOVERSE_PROCESS_NAME,
  findManagedApp,
  resolveBunRuntime,
} from './eidoverse.js';
import { deleteApp, getAppStatusStrict, restartApp, startWithCommand } from './pm2.js';

const RUNNING = new Set(['online', 'launching', 'waiting restart']);

async function readStatus(app) {
  const status = await getAppStatusStrict(EIDOVERSE_PROCESS_NAME, app.pm2Home);
  if (status) return status;
  throw new ServerError('Eidoverse runtime status is unavailable.', { status: 503, code: 'EIDOVERSE_RUNTIME_UNKNOWN' });
}

/** Persist the loopback command on an app record saved by an older PortOS or edited by hand. */
async function syncStartCommand(app) {
  const stored = app.startCommands?.[0];
  const command = withLoopbackPreload(stored) ?? eidoverseStartCommand((await resolveBunRuntime())?.command ?? 'bun');
  if (command !== stored) {
    await updateApp(app.id, { startCommands: [command, ...(app.startCommands || []).slice(1)] });
    notifyAppsChanged('update', app.id);
    console.log('🔒 Eidoverse start command updated to bind loopback only');
  }
  return command;
}

/**
 * Create the process fresh. PM2 keeps an existing entry's original args on some
 * start paths (the custom-PM2_HOME CLI), so a leftover entry is removed first.
 */
export async function launchEidoverseProcess(app) {
  if (!app.repoPath) {
    throw new ServerError('The registered Eidoverse launch configuration is unavailable.', {
      status: 409, code: 'EIDOVERSE_LAUNCH_UNAVAILABLE',
    });
  }
  const command = await syncStartCommand(app);
  if ((await readStatus(app)).status !== 'not_found') await deleteApp(EIDOVERSE_PROCESS_NAME, app.pm2Home);
  return startWithCommand(EIDOVERSE_PROCESS_NAME, app.repoPath, command, {
    pm2Home: app.pm2Home, port: EIDOVERSE_PORT, maxMemoryRestart: EIDOVERSE_MAX_MEMORY_RESTART,
  });
}

/** Plain PM2 restart when the entry already carries the preload; otherwise recreate it. */
export async function restartEidoverseProcess(app) {
  const current = await readStatus(app);
  return current.status === 'not_found' || hasLoopbackPreload(current.args)
    ? restartApp(EIDOVERSE_PROCESS_NAME, app.pm2Home)
    : launchEidoverseProcess(app);
}

/**
 * Upgrade an existing install: rewrite the stored command and replace a PM2 entry
 * (including one restored from a PM2 dump) that lacks the preload. Never starts a
 * process that was not already running.
 */
export async function ensureEidoverseLoopback() {
  const app = findManagedApp(await getAllApps());
  if (!app) return { replaced: false };
  await syncStartCommand(app);
  const current = await readStatus(app);
  if (current.status === 'not_found' || hasLoopbackPreload(current.args)) return { replaced: false };
  if (!RUNNING.has(current.status)) {
    await deleteApp(EIDOVERSE_PROCESS_NAME, app.pm2Home);
    return { replaced: false };
  }
  const result = await launchEidoverseProcess(app);
  if (result?.success !== true) {
    throw new ServerError('Eidoverse runtime could not restart on loopback.', { status: 503, code: 'EIDOVERSE_START_FAILED' });
  }
  notifyAppsChanged('restart', app.id);
  console.log('🔒 Eidoverse sequencer restarted on loopback only');
  return { replaced: true };
}
