/** Restore the opted-in, installed world at boot without installing or inferring. */
import { createSingleFlight } from '../lib/singleFlight.js';
import { ServerError } from '../lib/errorHandler.js';

const startup = createSingleFlight();

export function reconcileEidoverseRuntime() {
  return startup.run('runtime', async () => {
    const { isInstanceFeatureEnabled, assertConfiguredEidoverseInstalled } = await import('./instanceFeatures.js');
    if (!await isInstanceFeatureEnabled('eidoverse')) return { running: false, reason: 'feature-disabled' };

    // Strict configured-install check: never download, recreate a registry, or
    // start an unknown process because a readiness probe failed.
    const setup = await assertConfiguredEidoverseInstalled();
    if (!['online', 'launching', 'not_started', 'stopped', 'errored'].includes(setup.runtimeStatus)) {
      throw new ServerError('Eidoverse runtime status is unavailable; startup was deferred.', {
        status: 503, code: 'EIDOVERSE_RUNTIME_UNKNOWN',
      });
    }
    let started = false;
    if (!['online', 'launching'].includes(setup.runtimeStatus)) {
      const { getAppById, notifyAppsChanged } = await import('./apps.js');
      const { EIDOVERSE_PROCESS_NAME, EIDOVERSE_PORT, EIDOVERSE_MAX_MEMORY_RESTART } = await import('./eidoverse.js');
      const app = await getAppById(setup.appId);
      if (app?.archived || !app?.repoPath || !app?.startCommands?.[0]
        || app.pm2ProcessNames?.length !== 1 || app.pm2ProcessNames[0] !== EIDOVERSE_PROCESS_NAME) {
        throw new ServerError('The registered Eidoverse launch configuration is unavailable.', {
          status: 409, code: 'EIDOVERSE_LAUNCH_UNAVAILABLE',
        });
      }
      // Recheck after async registry reads in case the operator disabled it.
      if (!await isInstanceFeatureEnabled('eidoverse')) return { running: false, reason: 'feature-disabled' };
      const { startWithCommand } = await import('./pm2.js');
      const result = await startWithCommand(EIDOVERSE_PROCESS_NAME, app.repoPath, app.startCommands[0], {
        pm2Home: app.pm2Home, port: EIDOVERSE_PORT, maxMemoryRestart: EIDOVERSE_MAX_MEMORY_RESTART,
      });
      if (result?.success !== true) {
        throw new ServerError('Eidoverse runtime could not start.', { status: 503, code: 'EIDOVERSE_START_FAILED' });
      }
      started = true;
      notifyAppsChanged('start', app.id);
    }

    if (!await isInstanceFeatureEnabled('eidoverse')) return { running: true, started, reason: 'feature-disabled' };
    const { ensureEidoverseHost } = await import('./eidoverseHost.js');
    await ensureEidoverseHost(); // Wait for HTTP readiness before the world socket.
    const { ensureEidoverseWorldConfig, ensureEidoverseWorldPresence, reconcilePendingEidoverseWorld } = await import('./eidoverseWorld.js');
    const config = await ensureEidoverseWorldConfig();
    if (!await isInstanceFeatureEnabled('eidoverse')) return { running: true, started, reason: 'feature-disabled' };
    if (config.cos.enabled) await ensureEidoverseWorldPresence();
    await reconcilePendingEidoverseWorld();
    return { running: true, started, presenceEnabled: config.cos.enabled };
  });
}
