import { streamDetection } from '../services/streamingDetect.js';
import * as pm2Standardizer from '../services/pm2Standardizer.js';
import * as appsService from '../services/apps.js';
import * as appDeployer from '../services/appDeployer.js';
import { runAppUpdate } from '../services/appUpdateRunner.js';
import { activeOperationsPayload, appOperationResource, claimAppOperation, endAppOperation, recordOperationStep, runAppOperation } from '../services/appOperations.js';
import { maintenance } from '../lib/maintenanceAdmission.js';
import {
  appDeploySchema,
  appStandardizeSchema,
  appUpdateSchema,
  detectStartSchema,
  standardizeStartSchema,
  validateSocketData
} from '../lib/socketValidation.js';

// The in-flight operation registry lives in services/appOperations.js — the
// unattended auto-updater claims the same resource through it, and the Live
// activity snapshot reads it. Re-exported here because the socket suite drives
// the reset through this module.
export { __resetAppOperations } from '../services/appOperations.js';

export const registerAppHandlers = (socket, io) => {
  socket.on('detect:start', async (rawData) => {
    try {
      const data = validateSocketData(detectStartSchema, rawData, socket, 'detect:start');
      if (!data) return;
      console.log(`🔍 Starting detection: ${data.path}`);
      await streamDetection(socket, data.path);
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [detect:start]: ${message}`);
      socket.emit('error:server', { message });
      socket.emit('detect:complete', { success: false, error: message });
    }
  });

  // The multi-step analyze→backup→apply flow lives in the service; the socket
  // handler only wires progress callbacks to socket events.
  socket.on('standardize:start', async (rawData) => {
    try {
      const data = validateSocketData(standardizeStartSchema, rawData, socket, 'standardize:start');
      if (!data) return;
      const { repoPath, providerId, overwriteEcosystem = false } = data;
      console.log(`🔧 Starting PM2 standardization: ${repoPath}`);

      const outcome = await maintenance.run('app-operation', appOperationResource(repoPath), () => pm2Standardizer.runStandardizeFlow(repoPath, providerId, {
        overwriteEcosystem,
        onStep: ({ step, status, data }) => {
          socket.emit('standardize:step', { step, status, data, timestamp: Date.now() });
        },
        onAnalyzed: (payload) => socket.emit('standardize:analyzed', payload)
      }));

      socket.emit('standardize:complete', outcome);
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [standardize:start]: ${message}`);
      socket.emit('error:server', { message });
      socket.emit('standardize:complete', { success: false, error: message });
    }
  });

  // The update itself — the claim, the PortOS preflight refusals, the run, the
  // ledger row — lives in services/appUpdateRunner.js, because the unattended
  // auto-updater dispatches the identical action without a socket. This handler
  // owns only what is socket-shaped: validation, and routing the two refusals
  // that belong to the person who clicked back to THEIR socket rather than the
  // io bus. They are emitted directly (not thrown) so only that error event
  // fires — falling to the catch below would also fire app:update:complete with
  // success:false, which overwrites the message client-side
  // (useAppOperation's onDone patch).
  socket.on('app:update', async (rawData) => {
    let appId = null;
    try {
      const data = validateSocketData(appUpdateSchema, rawData, socket, 'app:update');
      if (!data) return;
      appId = data.appId;

      const outcome = await runAppUpdate({
        io,
        appId: data.appId,
        syncFork: data.syncFork === true,
        acknowledgeFork: data.acknowledgeFork === true,
        acknowledgeInterruption: data.acknowledgeInterruption === true,
        acknowledgePersistentMindImageBackup: data.acknowledgePersistentMindImageBackup === true,
      });
      if (outcome.ok) return;
      // A 'failed' outcome already went out on the io bus as app:update:error /
      // app:update:complete from inside the runner; re-emitting it here would
      // overwrite that message with a second, less specific one.
      if (outcome.reason === 'failed') return;
      socket.emit('app:update:error', {
        appId: outcome.appId,
        code: outcome.code,
        message: outcome.message,
        ...(outcome.reason === 'duplicate' ? { duplicate: true } : {}),
      });
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [app:update]: ${message}`);
      io.emit('app:update:error', { appId, code: err?.code || null, message });
      io.emit('app:update:complete', { appId, success: false, steps: [] });
    }
  });

  socket.on('app:standardize', async (rawData) => {
    let operatingAppId = null;
    let requestedAppId = null;
    let outcome = 'failure';
    try {
      const data = validateSocketData(appStandardizeSchema, rawData, socket, 'app:standardize');
      if (!data) return;
      requestedAppId = data.appId;

      const app = await appsService.getAppById(data.appId);
      if (!app) {
        socket.emit('app:standardize:error', { message: 'App not found' });
        return;
      }

      const refusal = pm2Standardizer.standardizeRefusalFor(app);
      if (refusal) {
        socket.emit('app:standardize:error', { appId: app.id, message: refusal });
        return;
      }

      const claim = claimAppOperation(io, app, 'standardize');
      if (!claim.ok) {
        socket.emit('app:standardize:error', {
          appId: app.id,
          duplicate: true,
          message: `An ${claim.inFlight.type} is already running for ${claim.inFlight.appName}`
        });
        return;
      }
      const operation = claim.operation;
      operatingAppId = app.id;

      await runAppOperation(operation, async () => {
        console.log(`🔧 Socket standardize started for ${app.name}`);
        const flow = await pm2Standardizer.runStandardizeFlow(app.repoPath, null, {
          overwriteEcosystem: data.overwriteEcosystem ?? false,
          onStep: ({ step, status, data: detail }) => {
            const frame = { appId: app.id, step, status, message: detail?.message, timestamp: Date.now() };
            recordOperationStep(operation, frame);
            io.emit('app:standardize:step', frame);
          }
        });

        if (!flow.success) {
          io.emit('app:standardize:error', { appId: app.id, message: flow.error });
          return;
        }
        const { processes } = flow.result;
        if (processes) {
          await appsService.updateApp(data.appId, { pm2ProcessNames: processes.map(p => p.name) });
        }

        io.emit('app:standardize:complete', { appId: app.id, success: true, result: flow.result });
        outcome = 'completion';
        console.log(`✅ Socket standardize complete for ${app.name}`);
      });
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [app:standardize]: ${message}`);
      io.emit('app:standardize:error', { appId: operatingAppId ?? requestedAppId, message });
    } finally {
      if (operatingAppId) endAppOperation(io, operatingAppId, outcome);
    }
  });

  // Push active operations on connect and on demand so remounts rehydrate.
  socket.on('app:operations:list', () => {
    socket.emit('app:operations:active', activeOperationsPayload());
  });
  socket.emit('app:operations:active', activeOperationsPayload());

  // A deploy runs for minutes, so like update/standardize it lives in the
  // operation registry and broadcasts on the io bus keyed by appId: a client
  // that reconnects (new socket id) or reloads mid-deploy still receives the
  // terminal frame, or rehydrates from `app:operations:active`. The
  // maintenance.run admission stays inside appDeployer.runDeployFlow.
  socket.on('app:deploy', async (rawData) => {
    let operatingAppId = null;
    let requestedAppId = null;
    let outcome = 'failure';
    try {
      const data = validateSocketData(appDeploySchema, rawData, socket, 'app:deploy');
      if (!data) return;
      requestedAppId = data.appId;

      const app = await appsService.getAppById(data.appId);
      if (!app) {
        socket.emit('app:deploy:error', { appId: data.appId, message: 'App not found' });
        return;
      }

      const claim = claimAppOperation(io, app, 'deploy');
      if (!claim.ok) {
        socket.emit('app:deploy:error', {
          appId: app.id,
          duplicate: true,
          message: `An ${claim.inFlight.type} is already running for ${claim.inFlight.appName}`
        });
        return;
      }
      const operation = claim.operation;
      operatingAppId = app.id;

      await runAppOperation(operation, async () => {
        const onOutput = (type, payload) => {
          const frame = { ...payload, appId: app.id, timestamp: Date.now() };
          if (type === 'status') {
            recordOperationStep(operation, { appId: app.id, step: payload.phase ?? 'deploy', status: payload.phase === 'complete' ? 'done' : 'running', message: payload.message, timestamp: frame.timestamp });
          }
          io.emit(`app:deploy:${type}`, frame);
        };

        const result = await appDeployer.runDeployFlow(app.id, data.flags, { onOutput });
        if (!result.ok) {
          io.emit('app:deploy:error', { appId: app.id, message: result.error });
          return;
        }
        io.emit('app:deploy:complete', { appId: app.id, success: result.success, code: result.code });
        if (result.success) outcome = 'completion';
      });
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [app:deploy]: ${message}`);
      io.emit('app:deploy:error', { appId: operatingAppId ?? requestedAppId, message });
    } finally {
      if (operatingAppId) endAppOperation(io, operatingAppId, outcome);
    }
  });
};
