import { streamDetection } from '../services/streamingDetect.js';
import * as pm2Standardizer from '../services/pm2Standardizer.js';
import * as appsService from '../services/apps.js';
import { logAction } from '../services/history.js';
import * as appUpdater from '../services/appUpdater.js';
import * as appDeployer from '../services/appDeployer.js';
import {
  appDeploySchema,
  appStandardizeSchema,
  appUpdateSchema,
  detectStartSchema,
  standardizeStartSchema,
  validateSocketData
} from '../lib/socketValidation.js';

// In-flight app update/standardize operations, keyed by app id. These run for
// minutes and outlive the page that dispatched them, so the server owns both
// the re-entrancy guard and the resumable progress buffer.
const activeAppOperations = new Map();

// repoPath stays server-side: the client only needs to name and render the run.
const activeOperationsPayload = () => ({
  operations: [...activeAppOperations.values()].map(({ repoPath: _repoPath, ...op }) => op)
});

// Two app records may point at the same checkout, so the app id alone doesn't
// identify the resource being mutated.
const findConflictingOperation = (app) => activeAppOperations.get(app.id)
  || (app.repoPath ? [...activeAppOperations.values()].find(op => op.repoPath === app.repoPath) : undefined);

const beginAppOperation = (io, app, type) => {
  const operation = { appId: app.id, appName: app.name, type, steps: [], startedAt: Date.now(), repoPath: app.repoPath };
  activeAppOperations.set(app.id, operation);
  io.emit('app:operations:active', activeOperationsPayload());
  return operation;
};

const endAppOperation = (io, appId) => {
  if (!activeAppOperations.delete(appId)) return;
  io.emit('app:operations:active', activeOperationsPayload());
};

// Record a step into the operation's buffer using the same last-write-wins
// per-step semantics the client renders with.
const recordOperationStep = (operation, frame) => {
  const existing = operation.steps.findIndex(s => s.step === frame.step);
  if (existing >= 0) operation.steps[existing] = frame;
  else operation.steps.push(frame);
};

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

      const outcome = await pm2Standardizer.runStandardizeFlow(repoPath, providerId, {
        overwriteEcosystem,
        onStep: ({ step, status, data }) => {
          socket.emit('standardize:step', { step, status, data, timestamp: Date.now() });
        },
        onAnalyzed: (payload) => socket.emit('standardize:analyzed', payload)
      });

      socket.emit('standardize:complete', outcome);
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [standardize:start]: ${message}`);
      socket.emit('error:server', { message });
      socket.emit('standardize:complete', { success: false, error: message });
    }
  });

  socket.on('app:update', async (rawData) => {
    let operatingAppId = null;
    try {
      const data = validateSocketData(appUpdateSchema, rawData, socket, 'app:update');
      if (!data) return;

      const app = await appsService.getAppById(data.appId);
      if (!app) {
        socket.emit('app:update:error', { message: 'App not found' });
        return;
      }

      const inFlight = findConflictingOperation(app);
      if (inFlight) {
        socket.emit('app:update:error', {
          appId: app.id,
          duplicate: true,
          message: `An ${inFlight.type} is already running for ${inFlight.appName}`
        });
        return;
      }

      console.log(`⬇️ Socket update started for ${app.name}`);
      const operation = beginAppOperation(io, app, 'update');
      operatingAppId = app.id;
      const emit = (step, status, message) => {
        const frame = { appId: app.id, step, status, message, timestamp: Date.now() };
        recordOperationStep(operation, frame);
        io.emit('app:update:step', frame);
      };

      let failure = null;
      const result = await appUpdater.updateApp(app, emit, { syncFork: data.syncFork === true }).catch(err => {
        failure = err;
        io.emit('app:update:error', { appId: app.id, message: err.message });
        return null;
      });

      // The ledger and the apps-changed broadcast are the socket path's job now
      // that it is the only way to update an app — a thrown update still gets a
      // row, with success:false, rather than vanishing from the history.
      await logAction('update', app.id, app.name, { steps: result?.steps ?? [] }, result?.success === true, failure?.message ?? null);
      appsService.notifyAppsChanged('update', app.id);

      if (result) {
        io.emit('app:update:complete', { appId: app.id, success: result.success, steps: result.steps });
        console.log(`✅ Socket update complete for ${app.name}`);
      }
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [app:update]: ${message}`);
      io.emit('app:update:error', { appId: operatingAppId, message });
      io.emit('app:update:complete', { appId: operatingAppId, success: false, steps: [] });
    } finally {
      if (operatingAppId) endAppOperation(io, operatingAppId);
    }
  });

  socket.on('app:standardize', async (rawData) => {
    let operatingAppId = null;
    try {
      const data = validateSocketData(appStandardizeSchema, rawData, socket, 'app:standardize');
      if (!data) return;

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

      const inFlight = findConflictingOperation(app);
      if (inFlight) {
        socket.emit('app:standardize:error', {
          appId: app.id,
          duplicate: true,
          message: `An ${inFlight.type} is already running for ${inFlight.appName}`
        });
        return;
      }

      console.log(`🔧 Socket standardize started for ${app.name}`);
      const operation = beginAppOperation(io, app, 'standardize');
      operatingAppId = app.id;
      const emit = (step, status, message) => {
        const frame = { appId: app.id, step, status, message, timestamp: Date.now() };
        recordOperationStep(operation, frame);
        io.emit('app:standardize:step', frame);
      };

      emit('analyze', 'running', 'Analyzing project configuration...');
      const analysis = await pm2Standardizer.analyzeApp(app.repoPath)
        .catch(err => ({ success: false, error: err.message }));

      if (!analysis.success) {
        emit('analyze', 'error', analysis.error);
        io.emit('app:standardize:error', { appId: app.id, message: analysis.error });
        return;
      }
      emit('analyze', 'done', `Found ${analysis.proposedChanges.processes?.length || 0} processes`);

      emit('backup', 'running', 'Creating git backup...');
      const backup = await pm2Standardizer.createGitBackup(app.repoPath)
        .catch(err => ({ success: false, reason: err.message }));

      if (backup.success) emit('backup', 'done', `Backup branch: ${backup.branch}`);
      else emit('backup', 'skipped', backup.reason || 'No git repository');

      emit('apply', 'running', 'Writing ecosystem.config.cjs...');
      const result = await pm2Standardizer.applyStandardization(app.repoPath, analysis, {
        overwriteEcosystem: data.overwriteEcosystem ?? false
      }).catch(err => ({ success: false, errors: [err.message] }));

      if (result.errors?.length > 0) {
        emit('apply', 'error', result.errors.join(', '));
        io.emit('app:standardize:error', { appId: app.id, message: result.errors.join(', ') });
        return;
      }
      const preserved = result.filesPreserved || [];
      emit('apply', 'done', preserved.length
        ? `Modified ${result.filesModified.length} files, preserved ${preserved.length}`
        : `Modified ${result.filesModified.length} files`);

      if (analysis.proposedChanges?.processes) {
        const pm2ProcessNames = analysis.proposedChanges.processes.map(p => p.name);
        await appsService.updateApp(data.appId, { pm2ProcessNames });
      }

      io.emit('app:standardize:complete', {
        appId: app.id,
        success: true,
        result: {
          backupBranch: result.backupBranch,
          filesModified: result.filesModified,
          filesPreserved: preserved,
          processes: analysis.proposedChanges.processes
        }
      });
      console.log(`✅ Socket standardize complete for ${app.name}`);
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [app:standardize]: ${message}`);
      io.emit('app:standardize:error', { appId: operatingAppId, message });
    } finally {
      if (operatingAppId) endAppOperation(io, operatingAppId);
    }
  });

  // Push active operations on connect and on demand so remounts rehydrate.
  socket.on('app:operations:list', () => {
    socket.emit('app:operations:active', activeOperationsPayload());
  });
  socket.emit('app:operations:active', activeOperationsPayload());

  socket.on('app:deploy', async (rawData) => {
    try {
      const data = validateSocketData(appDeploySchema, rawData, socket, 'app:deploy');
      if (!data) return;

      const onOutput = (type, payload) => {
        socket.emit(`app:deploy:${type}`, { ...payload, timestamp: Date.now() });
      };

      const outcome = await appDeployer.runDeployFlow(data.appId, data.flags, { onOutput });
      if (!outcome.ok) {
        socket.emit('app:deploy:error', { message: outcome.error });
        return;
      }
      socket.emit('app:deploy:complete', { success: outcome.success, code: outcome.code });
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [app:deploy]: ${message}`);
      socket.emit('app:deploy:error', { message });
    }
  });
};
