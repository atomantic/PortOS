import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorEvents, errorMiddleware, ServerError } from '../lib/errorHandler.js';
import { onDemandRuntimeAppNames } from '../lib/managedRuntimeApps.js';
import { request } from '../lib/testHelper.js';
import * as mtplx from '../services/mtplxServerManager.js';
import * as mtplxModels from '../services/mtplxModelManager.js';
import * as slotstream from '../services/slotstreamServerManager.js';
import * as slotstreamModels from '../services/slotstreamModelManager.js';
import * as splash from '../services/splashServerManager.js';
import * as mkserve from '../services/mkserveRuntimeManager.js';
import { getSplashRuntimeStatus } from '../services/splashRuntimeStatus.js';
import { saveProcessList } from '../services/pm2.js';
import { resetProviderReadinessCache } from '../services/provider/providerReadiness.js';
import { syncRuntimeProviderModels } from '../services/localRuntimeProviderSync.js';
import { recordingOperatorIo } from '../test/recordingOperatorIo.js';
import localLlmRuntimes from './localLlmRuntimes.js';

vi.mock('../services/llamaServerManager.js', () => ({
  getLlamaServerStatus: vi.fn(),
  getLlamaServerUpdateStatus: vi.fn(),
  startLlamaServer: vi.fn(),
  stopLlamaServer: vi.fn(),
  installLlamaServer: vi.fn(),
  upgradeLlamaServer: vi.fn(),
  waitForLlamaServerReady: vi.fn(),
}));
vi.mock('../services/specDecodeModels.js', () => ({
  getSpecDecodePresetStatus: vi.fn(),
  downloadSpecDecodeModel: vi.fn(),
  cancelSpecDecodeModelDownload: vi.fn(),
  removeSpecDecodeModel: vi.fn(),
}));
vi.mock('../services/mtplxServerManager.js', () => ({
  getMtplxServerStatus: vi.fn(),
  startMtplxServer: vi.fn(),
  stopMtplxServer: vi.fn(),
  installMtplx: vi.fn(),
  uninstallMtplx: vi.fn(),
  waitForMtplxReady: vi.fn(),
}));
vi.mock('../services/mtplxModelManager.js', () => ({
  searchMtplxCatalog: vi.fn(),
  pullMtplxModel: vi.fn(),
  cancelMtplxModelPull: vi.fn(),
  removeMtplxModel: vi.fn(),
}));
vi.mock('../services/slotstreamServerManager.js', () => ({
  getSlotstreamServerStatus: vi.fn(),
  startSlotstreamServer: vi.fn(),
  stopSlotstreamServer: vi.fn(),
  installSlotstream: vi.fn(),
  uninstallSlotstream: vi.fn(),
  waitForSlotstreamReady: vi.fn(),
}));
vi.mock('../services/slotstreamModelManager.js', () => ({
  downloadSlotstreamModel: vi.fn(),
  cancelSlotstreamModelDownload: vi.fn(),
  removeSlotstreamModel: vi.fn(),
}));
vi.mock('../services/splashRuntimeStatus.js', () => ({ getSplashRuntimeStatus: vi.fn() }));
vi.mock('../services/splashServerManager.js', () => ({
  installSplashRuntime: vi.fn(),
  saveSplashContextWindow: vi.fn(),
  startSplashServer: vi.fn(),
  stopSplashServer: vi.fn(),
  uninstallSplashRuntime: vi.fn(),
}));
vi.mock('../services/mkserveRuntimeManager.js', () => ({
  getMkserveRuntimeStatus: vi.fn(),
  installMkserve: vi.fn(),
  startMkserveServer: vi.fn(),
  stopMkserveServer: vi.fn(),
  uninstallMkserve: vi.fn(),
}));
vi.mock('../services/pm2.js', () => ({ saveProcessList: vi.fn() }));
vi.mock('../services/provider/providerReadiness.js', () => ({ resetProviderReadinessCache: vi.fn() }));
vi.mock('../services/localRuntimeProviderSync.js', () => ({ syncRuntimeProviderModels: vi.fn() }));

const base = '/api/local-llm';
const model = 'example-org/example-model';
const endpoint = 'http://127.0.0.1:9000/v1';
const operator = { enabled: true, authenticated: true, method: 'session' };
const peer = { ...operator, method: 'peer' };
const bundleStatus = { supported: true, state: 'stopped', installed: true };
const ignoreRouteError = () => {};

beforeAll(() => errorEvents.on('error', ignoreRouteError));
afterAll(() => errorEvents.off('error', ignoreRouteError));
beforeEach(() => {
  vi.resetAllMocks();
  getSplashRuntimeStatus.mockResolvedValue(bundleStatus);
  mkserve.getMkserveRuntimeStatus.mockResolvedValue(bundleStatus);
});

function makeApp(auth = operator) {
  const app = express();
  const io = recordingOperatorIo();
  app.set('io', io);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.portosAuthContext = auth;
    next();
  });
  app.use(base, localLlmRuntimes);
  app.use(errorMiddleware);
  return {
    io,
    get: (path) => request(app).get(`${base}/${path}`),
    post: (path, body = {}) => request(app).post(`${base}/${path}`).send(body),
    put: (path, body) => request(app).put(`${base}/${path}`).send(body),
  };
}

it.each([
  ['mtplx', mtplx.getMtplxServerStatus],
  ['slotstream', slotstream.getSlotstreamServerStatus],
  ['splash', getSplashRuntimeStatus],
  ['mkserve', mkserve.getMkserveRuntimeStatus],
])('GET /%s/status includes runtime logs for operator sessions only', async (runtime, readStatus) => {
  const status = { installed: true, recentLogs: [] };
  const withLogs = { ...status, recentLogs: ['fixture output'] };
  readStatus.mockImplementation(async ({ includeLogs }) => includeLogs ? withLogs : status);

  const remote = await makeApp(peer).get(`${runtime}/status`);
  expect(remote.status).toBe(200);
  expect(remote.body).toMatchObject(status);
  expect(readStatus).toHaveBeenLastCalledWith({ includeLogs: false });

  const unauthenticated = await makeApp(null).get(`${runtime}/status`);
  expect(unauthenticated.status).toBe(200);
  expect(unauthenticated.body).toMatchObject(status);
  expect(readStatus).toHaveBeenLastCalledWith({ includeLogs: false });

  const delegated = await makeApp().get(`${runtime}/status`);
  expect(delegated.status).toBe(200);
  expect(delegated.body).toMatchObject(withLogs);
  expect(readStatus).toHaveBeenLastCalledWith({ includeLogs: true });
});

describe.each([
  {
    kind: 'mtplx', start: mtplx.startMtplxServer, stop: mtplx.stopMtplxServer, install: mtplx.installMtplx,
    uninstall: mtplx.uninstallMtplx, waitFor: mtplx.waitForMtplxReady, invalid: { model: 123 },
  },
  {
    kind: 'slotstream', start: slotstream.startSlotstreamServer, stop: slotstream.stopSlotstreamServer,
    install: slotstream.installSlotstream, uninstall: slotstream.uninstallSlotstream, waitFor: slotstream.waitForSlotstreamReady,
    invalid: { memoryGb: 1 },
  },
])('$kind lifecycle', ({ kind, start, stop, install, uninstall, waitFor, invalid }) => {
  it('rejects an invalid start before launching or changing readiness', async () => {
    const response = await makeApp().post(`${kind}/start`, invalid);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(start).not.toHaveBeenCalled();
    expect(resetProviderReadinessCache).not.toHaveBeenCalled();
    expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
  });

  it.each([true, false])('returns the start result and refreshes models (online=%s)', async (online) => {
    const { io, post } = makeApp();
    const result = { success: true, online, endpoint };
    const refresh = Promise.withResolvers();
    start.mockResolvedValue(result);
    syncRuntimeProviderModels.mockReturnValue(refresh.promise);
    try {
      const response = await post(`${kind}/start`, { port: '9000', model });
      expect(response.status).toBe(200);
      expect(response.body).toEqual(result);
      expect(start).toHaveBeenCalledWith({ port: 9000, model, onProgress: expect.any(Function) });
      expect(resetProviderReadinessCache).toHaveBeenCalledOnce();
      expect(syncRuntimeProviderModels).toHaveBeenCalledExactlyOnceWith({
        kind, io, waitForReady: online ? null : expect.any(Function),
      });
      expect(waitFor).not.toHaveBeenCalled();
      if (!online) {
        await syncRuntimeProviderModels.mock.calls[0][0].waitForReady();
        expect(waitFor).toHaveBeenCalledExactlyOnceWith(endpoint);
      }
    } finally {
      refresh.resolve();
    }
  });

  it.each([{}, { code: 'EXTERNAL_PROCESS_RUNNING' }])('reports an external daemon conflict with details %j', async (details) => {
    stop.mockResolvedValue({ success: false, message: 'An external process is listening.', ...details });
    const response = await makeApp().post(`${kind}/stop`);
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: 'An external process is listening.', code: 'EXTERNAL_PROCESS_RUNNING',
    });
    expect(resetProviderReadinessCache).not.toHaveBeenCalled();
    expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
  });

  it.each([
    ['stop', stop],
    ['install', install],
    ['uninstall', uninstall],
  ])('forwards %s and invalidates cached readiness', async (action, run) => {
    const result = { success: true, action };
    run.mockResolvedValue(result);
    const response = await makeApp().post(`${kind}/${action}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(run).toHaveBeenCalledOnce();
    expect(resetProviderReadinessCache).toHaveBeenCalledOnce();
    expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
  });
});

it('passes validated MTPLX catalog filters to the search service', async () => {
  const results = [{ model }];
  const { get } = makeApp();
  mtplxModels.searchMtplxCatalog.mockResolvedValue(results);

  const invalid = await get('mtplx/models/search?limit=101');
  expect(invalid.status).toBe(400);
  expect(invalid.body.code).toBe('VALIDATION_ERROR');
  expect(mtplxModels.searchMtplxCatalog).not.toHaveBeenCalled();

  const response = await get('mtplx/models/search?query=%20fixture%20&limit=12&offset=2');
  expect(response.status).toBe(200);
  expect(response.body).toEqual(results);
  expect(mtplxModels.searchMtplxCatalog).toHaveBeenCalledExactlyOnceWith({ query: 'fixture', limit: 12, offset: 2 });
});

describe.each([
  {
    kind: 'mtplx', action: 'pull', transfer: mtplxModels.pullMtplxModel, cancel: mtplxModels.cancelMtplxModelPull,
    remove: mtplxModels.removeMtplxModel, cancelArgs: [], checkpoint: model, defaultCode: 'MTPLX_PULL_FAILED',
  },
  {
    kind: 'slotstream', action: 'download', transfer: slotstreamModels.downloadSlotstreamModel,
    cancel: slotstreamModels.cancelSlotstreamModelDownload, remove: slotstreamModels.removeSlotstreamModel,
    cancelArgs: [{ model }], checkpoint: 'example-org__example-model', defaultCode: 'SLOTSTREAM_DOWNLOAD_FAILED',
  },
])('$kind checkpoint routes', ({ kind, action, transfer, cancel, remove, cancelArgs, checkpoint, defaultCode }) => {
  const path = `${kind}/models/${action}`;

  it('forwards transfer progress and refreshes models after completion', async () => {
    const { io, post } = makeApp();
    const frame = { event: 'progress', model, downloadedBytes: 5, totalBytes: 10 };
    const result = { success: true, model };
    transfer.mockImplementation(async ({ onProgress }) => {
      onProgress(frame);
      return result;
    });

    const response = await post(path, { model });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(transfer).toHaveBeenCalledWith({ model, onProgress: expect.any(Function) });
    expect(io.emit).toHaveBeenCalledWith(`${kind}:download`, frame);
    expect(resetProviderReadinessCache).toHaveBeenCalledOnce();
    expect(syncRuntimeProviderModels).toHaveBeenCalledExactlyOnceWith({ kind, io, waitForReady: null });
  });

  it('reports a failed transfer as a 502 without refreshing models', async () => {
    transfer.mockResolvedValue({ success: false, error: 'Checkpoint unavailable' });
    const response = await makeApp().post(path, { model });
    expect(response.status).toBe(502);
    expect(response.body).toMatchObject({ error: 'Checkpoint unavailable', code: defaultCode });
    expect(resetProviderReadinessCache).not.toHaveBeenCalled();
    expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
  });

  it('acknowledges cancellation and returns cancelled transfers as HTTP 200', async () => {
    const { post } = makeApp();
    // Slotstream's service also returns internal cancellation metadata.
    const cancelled = { success: false, cancelled: true, model };
    transfer.mockResolvedValue(kind === 'slotstream' ? { ...cancelled, code: 'SLOTSTREAM_DOWNLOAD_CANCELLED' } : cancelled);
    cancel.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const cancelledResponse = await post(`${path}/cancel`, cancelArgs[0]);
    expect(cancelledResponse.status).toBe(200);
    expect(cancelledResponse.body).toEqual({ success: true, cancelled: true });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(...cancelArgs);
    expect((await post(`${path}/cancel`, cancelArgs[0])).body).toEqual({ success: true, cancelled: false });

    const response = await post(path, { model });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(cancelled);
    expect(resetProviderReadinessCache).not.toHaveBeenCalled();
    expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
  });

  it('removes the named checkpoint and refreshes models', async () => {
    const { io, post } = makeApp();
    const result = { success: true, model: checkpoint };
    remove.mockResolvedValue(result);
    const response = await post(`${kind}/models/remove`, { model: checkpoint });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(result);
    expect(remove).toHaveBeenCalledExactlyOnceWith(checkpoint);
    expect(resetProviderReadinessCache).toHaveBeenCalledOnce();
    expect(syncRuntimeProviderModels).toHaveBeenCalledExactlyOnceWith({ kind, io, waitForReady: null });
  });
});

it.each([
  [401, 'HF_AUTH'],
  [422, 'SLOTSTREAM_NO_WEIGHTS'],
  [504, 'SLOTSTREAM_METADATA_TIMEOUT'],
])('preserves a Slotstream download failure with status %i and code %s', async (status, code) => {
  slotstreamModels.downloadSlotstreamModel.mockResolvedValue({ success: false, error: 'Checkpoint unavailable', status, code });
  const response = await makeApp().post('slotstream/models/download', { model });
  expect(response.status).toBe(status);
  expect(response.body).toMatchObject({ error: 'Checkpoint unavailable', code });
  expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
});

it('validates Slotstream removals and preserves an in-use conflict', async () => {
  const { post } = makeApp();
  const invalid = await post('slotstream/models/remove', { model: '../outside' });
  expect(invalid.status).toBe(400);
  expect(invalid.body.code).toBe('VALIDATION_ERROR');
  expect(slotstreamModels.removeSlotstreamModel).not.toHaveBeenCalled();

  slotstreamModels.removeSlotstreamModel.mockRejectedValue(new ServerError('Checkpoint is in use', {
    status: 409, code: 'SLOTSTREAM_CHECKPOINT_IN_USE',
  }));
  const response = await post('slotstream/models/remove', { model: 'example-model' });
  expect(response.status).toBe(409);
  expect(response.body.code).toBe('SLOTSTREAM_CHECKPOINT_IN_USE');
  expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
});

it.each([
  ['mtplx/start', mtplx.startMtplxServer, {}],
  ['slotstream/start', slotstream.startSlotstreamServer, {}],
  ['mtplx/models/pull', mtplxModels.pullMtplxModel, { model }],
  ['mtplx/models/remove', mtplxModels.removeMtplxModel, { model }],
  ['slotstream/models/download', slotstreamModels.downloadSlotstreamModel, { model }],
])('does not refresh models when /%s throws', async (path, run, body) => {
  run.mockRejectedValue(new ServerError('Refused', { status: 400 }));
  const response = await makeApp().post(path, body);
  expect(response.status).toBe(400);
  expect(resetProviderReadinessCache).not.toHaveBeenCalled();
  expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
});

describe.each([
  {
    kind: 'splash', label: 'Splash', install: splash.installSplashRuntime, start: splash.startSplashServer,
    stop: splash.stopSplashServer, uninstall: splash.uninstallSplashRuntime,
  },
  {
    kind: 'mkserve', label: 'mkserve', install: mkserve.installMkserve, start: mkserve.startMkserveServer,
    stop: mkserve.stopMkserveServer, uninstall: mkserve.uninstallMkserve,
  },
])('$kind background lifecycle', ({ kind, label, install, start, stop, uninstall }) => {
  it.each([
    ['install', install],
    ['upgrade', install],
    ['start', start],
    ['stop', stop],
    ['uninstall', uninstall],
  ])('accepts %s, reports its progress, and holds the operation slot until completion', async (action, run) => {
    const { get, io, post } = makeApp();
    const work = Promise.withResolvers();
    const message = `${label}: Processing fixture`;
    run.mockImplementation(({ onProgress }) => {
      onProgress({ message: 'Processing fixture' });
      return work.promise;
    });

    try {
      const accepted = await post(`${kind}/${action}`);
      expect(accepted.status).toBe(202);
      expect(accepted.body.operation).toMatchObject({ id: expect.any(String), action });
      const operation = { ...accepted.body.operation, message };
      const status = await get(`${kind}/status`);
      expect(status.status).toBe(200);
      expect(status.body).toEqual({ ...bundleStatus, operation, lastError: null });
      expect(io.emit).toHaveBeenCalledWith('localLlm:progress', { event: 'progress', message, runtime: kind, operation });

      const competingAction = action === 'start' ? 'install' : 'start';
      expect((await post(`${kind}/${competingAction}`)).status).toBe(409);
      expect(run).toHaveBeenCalledOnce();
      expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
    } finally {
      work.resolve();
    }

    expect((await get(`${kind}/status`)).body).toEqual({ ...bundleStatus, operation: null, lastError: null });
    expect(io.emit).toHaveBeenCalledWith('localLlm:progress', expect.objectContaining({
      event: 'complete', runtime: kind, operation: null, lastError: null,
    }));
    if (action === 'start') {
      expect(syncRuntimeProviderModels).toHaveBeenCalledExactlyOnceWith({ kind, io, waitForReady: null });
    } else {
      expect(start).not.toHaveBeenCalled();
      expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
    }
  });

  it('refuses caller-supplied launch overrides', async () => {
    const response = await makeApp().post(`${kind}/start`, { executable: 'fixture' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ['install', false],
    ['upgrade', true],
  ])('cancels %s and holds the slot through teardown (explicit ID: %s)', async (action, useId) => {
    const { get, io, post } = makeApp();
    const work = Promise.withResolvers();
    install.mockReturnValue(work.promise);

    try {
      const accepted = await post(`${kind}/${action}`);
      expect(accepted.status).toBe(202);
      const { operation } = accepted.body;
      const { onProgress, signal } = install.mock.calls[0][0];

      const mismatch = await post(`${kind}/cancel`, { operationId: '61d3819b-c7ab-476c-be68-81355beebdae' });
      expect(mismatch.status).toBe(200);
      expect(mismatch.body).toEqual({ cancelled: false });
      expect(signal.aborted).toBe(false);

      const cancelled = await post(`${kind}/cancel`, useId ? { operationId: operation.id } : undefined);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({
        cancelled: true, operation: { id: operation.id, action, cancelling: true },
      });
      expect(signal.aborted).toBe(true);
      onProgress('Late progress');
      expect((await get(`${kind}/status`)).body.operation).toEqual(cancelled.body.operation);
      expect((await post(`${kind}/uninstall`)).status).toBe(409);
      expect(uninstall).not.toHaveBeenCalled();
    } finally {
      const signal = install.mock.calls[0]?.[0].signal;
      if (signal?.aborted) work.reject(signal.reason);
      else work.resolve();
    }

    expect((await get(`${kind}/status`)).body).toEqual({ ...bundleStatus, operation: null, lastError: null });
    expect((await post(`${kind}/cancel`)).body).toEqual({ cancelled: false });
    expect(io.emit).toHaveBeenCalledWith('localLlm:progress', expect.objectContaining({
      event: 'cancelled', runtime: kind, operation: null, lastError: null,
    }));
  });

  it.each([
    ['install', install],
    ['start', start],
  ])('surfaces a failed %s in status and emits the ServerError message until retry', async (action, run) => {
    const { get, io, post } = makeApp();
    const message = 'Runtime is busy. Stop the external process first.';
    run.mockRejectedValueOnce(new ServerError(message, { status: 409 }));

    try {
      expect((await post(`${kind}/${action}`)).status).toBe(202);
      expect((await get(`${kind}/status`)).body).toEqual({ ...bundleStatus, operation: null, lastError: message });
      expect(io.emit).toHaveBeenCalledWith('localLlm:progress', {
        event: 'error', runtime: kind, message: `${label}: ${message}`, operation: null, lastError: message,
      });
      expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
    } finally {
      const retry = Promise.withResolvers();
      run.mockReturnValueOnce(retry.promise);
      try {
        const accepted = await post(`${kind}/${action}`);
        expect(accepted.status).toBe(202);
        expect((await get(`${kind}/status`)).body).toEqual({
          ...bundleStatus, operation: accepted.body.operation, lastError: null,
        });
      } finally {
        retry.resolve();
      }
    }
    expect((await get(`${kind}/status`)).body).toEqual({ ...bundleStatus, operation: null, lastError: null });
  });

  it('redacts unexpected failure details from status and operator progress', async () => {
    const { get, io, post } = makeApp();
    const detail = 'Fixture failure at /private/runtime/weights';
    const publicMessage = 'Operation failed. See PortOS server logs for details.';
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    install.mockRejectedValueOnce(new Error(detail));
    try {
      const accepted = await post(`${kind}/install`);
      expect(accepted.status).toBe(202);
      expect(accepted.text).not.toContain(detail);
      const status = await get(`${kind}/status`);
      expect(status.body).toEqual({ ...bundleStatus, operation: null, lastError: publicMessage });
      expect(status.text).not.toContain(detail);
      expect(io.emit).toHaveBeenCalledWith('localLlm:progress', {
        event: 'error', runtime: kind, message: `${label}: ${publicMessage}`, operation: null, lastError: publicMessage,
      });
      expect(JSON.stringify(io.emit.mock.calls)).not.toContain(detail);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(detail));
    } finally {
      log.mockRestore();
      install.mockResolvedValueOnce({});
      await post(`${kind}/install`);
    }
  });
});

it('accepts the repair flag only on mkserve install', async () => {
  const { post } = makeApp();
  mkserve.installMkserve.mockResolvedValue({});
  const accepted = await post('mkserve/install', { repair: true });
  expect(accepted.status).toBe(202);
  expect(accepted.body.operation.action).toBe('repair');
  expect(mkserve.installMkserve).toHaveBeenCalledWith(expect.objectContaining({ repair: true }));
  expect((await post('mkserve/start', { repair: true })).status).toBe(400);
  expect((await post('splash/install', { repair: true })).status).toBe(400);
  expect(mkserve.startMkserveServer).not.toHaveBeenCalled();
  expect(splash.installSplashRuntime).not.toHaveBeenCalled();
});

it('validates and saves the Splash context only while the runtime is idle', async () => {
  const { post, put } = makeApp();
  const work = Promise.withResolvers();
  const contextWindow = 1000000;
  const save = (value) => put('splash/context', { contextWindow: value });
  expect((await save(1010000)).status).toBe(400);
  expect((await save('1000000')).status).toBe(400);

  splash.installSplashRuntime.mockReturnValue(work.promise);
  try {
    expect((await post('splash/install')).status).toBe(202);
    const blocked = await save(contextWindow);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe('Splash already has an operation in progress.');
    expect(splash.saveSplashContextWindow).not.toHaveBeenCalled();
  } finally {
    work.resolve();
  }

  const result = { requestedContextWindow: contextWindow };
  splash.saveSplashContextWindow.mockResolvedValue(result);
  const response = await save(contextWindow);
  expect(response.status).toBe(200);
  expect(response.body).toEqual(result);
  expect(splash.saveSplashContextWindow).toHaveBeenCalledExactlyOnceWith(contextWindow);
});

it('save-startup excludes every on-demand runtime from the boot dump', async () => {
  const result = { saved: true };
  saveProcessList.mockResolvedValue(result);
  const response = await makeApp().post('save-startup');
  expect(response.status).toBe(200);
  expect(response.body).toEqual(result);
  expect(saveProcessList).toHaveBeenCalledExactlyOnceWith(null, { exclude: onDemandRuntimeAppNames() });
});
