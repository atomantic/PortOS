import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { asyncHandler, errorMiddleware, ServerError } from '../lib/errorHandler.js';

const auth = vi.hoisted(() => ({ enabled: false, session: false }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyRequestSession: vi.fn(async () => auth.session),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({ security: { passwordRiskAcknowledged: true } })),
}));
vi.mock('../services/voice/config.js', () => ({
  getVoiceConfig: vi.fn(async () => ({
    enabled: true,
    llm: { model: 'test-model', usePersonality: false, systemPrompt: 'sys',
      tools: { enabled: true, maxIterations: 1 }, codeAgent: { enabled: true } },
  })),
}));
vi.mock('../services/appProcessStatus.js', () => ({ annotateExpectedExit: async (processes) => processes }));
vi.mock('../services/pm2.js', () => ({
  listProcesses: vi.fn(async () => [{ name: 'example-api', status: 'online' }]),
  restartApp: vi.fn(async () => {}),
}));
vi.mock('../services/cos.js', () => ({
  addTask: vi.fn(async () => ({ id: 'example-task' })),
  isRunning: () => true,
  reviveBlockedTask: vi.fn(),
}));
vi.mock('../services/providers.js', () => ({
  getActiveProvider: vi.fn(async () => ({ id: 'example-cli', type: 'cli', enabled: true })),
  getProviderById: vi.fn(), getAllProviders: vi.fn(),
}));
vi.mock('../services/voice/stt.js', () => ({
  transcribe: vi.fn(async () => ({ text: 'restart the example service', latencyMs: 1 })),
}));
vi.mock('../services/voice/tts.js', () => ({ synthesize: vi.fn(async () => ({ wav: Buffer.alloc(8), latencyMs: 1 })) }));
vi.mock('../services/voice/llm.js', () => ({ streamChat: vi.fn() }));
// Only replace the call transport/endpoint detector; real socket handlers,
// pipeline, tool dispatcher, auth predicates, and tool bodies run end to end.
const callHost = vi.hoisted(() => ({ socket: null }));
vi.mock('../services/voice/callSession.js', () => ({
  attachHost: (socket) => { callHost.socket = socket; return { ok: true, state: {} }; },
  getCallHost: () => callHost.socket, isCallActive: () => true,
  getCallState: () => ({}), getCallContext: () => null,
  peekCallOpeningLine: () => null, clearCallOpeningLine: vi.fn(),
  detachHost: vi.fn(), endCall: vi.fn(), markListening: vi.fn(), markSpeaking: vi.fn(),
  noteCallerSpeech: vi.fn(), recordTurn: vi.fn(), setCallStateListener: vi.fn(),
}));
vi.mock('../services/voice/callEndpointing.js', async (importOriginal) => ({
  ...await importOriginal(),
  createCallEndpointer: () => ({ speaking: false, push: () => ({ pcm: new Int16Array(16) }), reset() {} }),
}));
vi.mock('../services/voice/captureSession.js', () => ({
  isCaptureActive: () => false, getCaptureHost: () => null,
  attachCaptureHost: vi.fn(), detachCaptureHost: vi.fn(), endCapture: vi.fn(),
  recordUtterance: vi.fn(), setCaptureStateListener: vi.fn(), startCapture: vi.fn(),
}));

import { authGate, hostControlRouteGate, socketAuthGate } from '../services/authGate.js';
import { createRunsRoutes } from '../lib/aiToolkit/routes/runs.js';
import paletteRoutes from './palette.js';
import { registerVoiceHandlers } from '../sockets/voice.js';
import { dispatchTool } from '../services/voice/tools.js';
import { streamChat } from '../services/voice/llm.js';
import { restartApp } from '../services/pm2.js';
import { addTask } from '../services/cos.js';

const runner = {
  createRun: vi.fn(), executeCliRun: vi.fn(), executeTuiRun: vi.fn(), executeApiRun: vi.fn(),
};
const appFor = (address) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/runs', createRunsRoutes(runner, { asyncHandler, ServerError }));
  app.use('/api/palette', paletteRoutes);
  app.use(errorMiddleware);
  return app;
};
const runBody = { providerId: 'example-provider', prompt: 'Fix the example test', workspacePath: '/example/repo' };
const hostTools = [
  ['pm2_restart', { name: 'example-api' }],
  ['dispatch_code_agent', { task: 'Fix the example test' }],
];
const responseFor = (name, args) => ({ text: '', model: 'test-model', toolCalls: [
  { id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
] });
const socketFor = async (address) => {
  const handlers = new Map();
  const socket = {
    id: 'example-socket', data: {}, handshake: { address, headers: {} },
    on: (event, fn) => handlers.set(event, fn), emit: vi.fn(),
    fire: (event, payload) => handlers.get(event)?.(payload),
  };
  await socketAuthGate(socket, (err) => { if (err) throw err; });
  registerVoiceHandlers(socket);
  return socket;
};
const fireTurn = async (socket, event) => {
  const forged = { hasHostControl: true, portosLocalConnection: true, authenticated: true };
  if (event === 'voice:call:audio') await socket.fire('voice:call:attach');
  await socket.fire(event, { text: 'restart the example service', audio: Buffer.alloc(8), pcm: Buffer.alloc(32), ...forged });
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  auth.session = false;
  callHost.socket = null;
});

describe('Runs and palette host authority (#8834)', () => {
  it('refuses remote password-free Runs before creating metadata or resolving any runner/fallback', async () => {
    const response = await request(appFor('192.0.2.10')).post('/api/runs').send(runBody);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    for (const sink of Object.values(runner)) expect(sink).not.toHaveBeenCalled();
  });

  it('refuses a Basic peer credential for Runs before creating metadata', async () => {
    auth.enabled = true;
    const response = await request(appFor('192.0.2.10')).post('/api/runs')
      .set('Authorization', `Basic ${Buffer.from(':example-password').toString('base64')}`)
      .send(runBody);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    expect(runner.createRun).not.toHaveBeenCalled();
  });

  it.each(['cli', 'tui', 'api'])('allows local and session Runs with %s fallback', async (type) => {
    runner.createRun.mockResolvedValue({ runId: 'example-run', provider: { type }, metadata: {}, usedFallback: true, fallbackModel: 'fallback-model' });
    for (const address of ['127.0.0.1', '192.0.2.10']) {
      auth.enabled = address !== '127.0.0.1';
      auth.session = auth.enabled;
      expect((await request(appFor(address)).post('/api/runs').send(runBody)).status).toBe(202);
    }
    const sink = { cli: runner.executeCliRun, tui: runner.executeTuiRun, api: runner.executeApiRun }[type];
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0][0]).toMatchObject(type === 'api'
      ? { model: 'fallback-model' } : { provider: { defaultModel: 'fallback-model' } });
  });

  it.each(hostTools)('protects palette %s from remote anonymous and Basic callers, allowing local/session', async (name, args) => {
    for (const enabled of [false, true]) {
      auth.enabled = enabled;
      const response = await request(appFor('192.0.2.10')).post(`/api/palette/action/${name}`)
        .set('Authorization', `Basic ${Buffer.from(':example-password').toString('base64')}`)
        .send({ args: { ...args, hasHostControl: true }, hasHostControl: true });
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('HOST_CONTROL_FORBIDDEN');
    }
    expect(restartApp).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
    for (const address of ['127.0.0.1', '192.0.2.10']) {
      auth.enabled = address !== '127.0.0.1';
      auth.session = auth.enabled;
      expect((await request(appFor(address)).post(`/api/palette/action/${name}`).send({ args })).status).toBe(200);
    }
    expect(name === 'pm2_restart' ? restartApp : addTask).toHaveBeenCalledTimes(2);
  });

  it('does not grant host tools authority from missing or JSON-shaped contexts, while read tools stay usable', async () => {
    for (const [name, args] of hostTools) {
      for (const ctx of [undefined, { hasHostControl: true }, { hasHostControl: () => false }]) {
        await expect(dispatchTool(name, { ...args, hasHostControl: true }, ctx)).rejects.toMatchObject({ code: 'HOST_CONTROL_FORBIDDEN' });
      }
    }
    expect((await request(appFor('192.0.2.10')).post('/api/palette/action/pm2_status').send({})).status).toBe(200);
    expect(restartApp).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });
});

describe.each(['voice:text', 'voice:turn', 'voice:call:audio'])('%s tool authority', (event) => {
  it.each(hostTools)('rejects forged remote authority for %s through the real pipeline', async (name, args) => {
    streamChat.mockResolvedValue(responseFor(name, { ...args, hasHostControl: true }));
    const socket = await socketFor('192.0.2.10');
    await fireTurn(socket, event);
    expect(streamChat).toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('voice:error', expect.objectContaining({ code: 'HOST_CONTROL_FORBIDDEN', message: expect.stringContaining('operator session') }));
    expect(restartApp).not.toHaveBeenCalled();
    expect(addTask).not.toHaveBeenCalled();
  });

  it('allows local/operator tools but rechecks a revoked session after the model responds', async () => {
    const [name, args] = hostTools[0];
    streamChat.mockResolvedValue(responseFor(name, args));
    await fireTurn(await socketFor('127.0.0.1'), event);
    auth.enabled = true;
    auth.session = true;
    const operator = await socketFor('192.0.2.10');
    await fireTurn(operator, event);
    expect(restartApp).toHaveBeenCalledTimes(2);
    streamChat.mockImplementationOnce(async () => {
      auth.session = false;
      return responseFor(name, args);
    });
    await fireTurn(operator, event);
    expect(restartApp).toHaveBeenCalledTimes(2);
    expect(operator.emit).toHaveBeenCalledWith('voice:error', expect.objectContaining({ code: 'HOST_CONTROL_FORBIDDEN' }));
  });

  it('keeps non-host tools usable for remote password-free callers', async () => {
    streamChat.mockResolvedValue(responseFor('pm2_status', {}));
    const socket = await socketFor('192.0.2.10');
    await fireTurn(socket, event);
    expect(streamChat).toHaveBeenCalled();
    expect(socket.emit).not.toHaveBeenCalledWith('voice:error', expect.objectContaining({ code: 'HOST_CONTROL_FORBIDDEN' }));
    expect(socket.emit).toHaveBeenCalledWith('voice:tool', expect.objectContaining({ name: 'pm2_status' }));
  });
});
