import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-voice-authority-') }));
afterAll(cleanupTempDataRoots);

// The piper voice fetch runs the setup script (which can brew install) and
// whisper start launches whisper-server under PM2, so both need operator
// authority (#13055). Whisper stop and the TTS test, which runs an installed
// runtime on text, stay open. Real router behind the real gates; the voice
// services are doubled so no process starts.
const auth = vi.hoisted(() => ({ enabled: false }));
const storedVoice = vi.hoisted(() => ({ enabled: true, stt: { engine: 'whisper' }, tts: { engine: 'piper' } }));
const effects = vi.hoisted(() => ({
  piperFetch: vi.fn(async () => ({ downloaded: true })),
  startWhisper: vi.fn(async () => ({ started: true })),
}));
const open = vi.hoisted(() => ({
  stopWhisper: vi.fn(async () => {}),
  synthesize: vi.fn(async () => ({ wav: Buffer.from('RIFF'), latencyMs: 1 })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  ensureInstanceId: vi.fn(async () => 'example-self'),
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/voice/config.js', () => ({
  getVoiceConfig: vi.fn(async () => storedVoice),
  updateVoiceConfig: vi.fn(),
}));
vi.mock('../services/voice/bootstrap.js', () => ({
  downloadPiperVoice: effects.piperFetch,
  startWhisper: effects.startWhisper,
  stopWhisper: open.stopWhisper,
}));
vi.mock('../services/voice/tts.js', () => ({ synthesize: open.synthesize, VALID_ENGINES: new Set(['piper']) }));
vi.mock('../services/voice/piper-voices.js', () => ({ findPiperVoice: vi.fn(() => ({ id: 'en_US-example-medium' })) }));
vi.mock('../services/voice/health.js', () => ({ invalidateHealthCache: vi.fn() }));
vi.mock('../services/voice/proactiveSpeech.js', () => ({
  HHMM_RE: /^([01]\d|2[0-3]):[0-5]\d$/,
  MAX_PROACTIVE_TEXT_LEN: 500,
}));
// Unrelated voice services stay unreachable when mounting the router.
vi.mock('../services/voice/facetimeBridge.js', () => ({ probe: vi.fn(), call: vi.fn(), hangup: vi.fn() }));
vi.mock('../services/voice/profiles.js', () => ({}));
vi.mock('../services/voice/profileBenchmarks.js', () => ({}));
vi.mock('../services/voice/qwen3TtsRuntime.js', () => ({}));
vi.mock('../services/voice/fineTuning.js', () => ({}));

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import voiceRoutes from './voice.js';

const operations = [
  ['/api/voice/piper/fetch', { voice: 'en_US-example-medium' }, effects.piperFetch],
  ['/api/voice/whisper', { action: 'start' }, effects.startWhisper],
];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/voice', voiceRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, [path, body], headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('voice runtime setup and whisper start operator authority (#13055)', () => {
  it('refuses remote password-free callers, spoofed-proxy and case variants before any runtime work', async () => {
    for (const [path, body] of operations) {
      for (const [address, headers, target] of [
        ['192.0.2.10', {}, path],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, path],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }, path],
        ['192.0.2.10', {}, path.toUpperCase() + '/'],
      ]) {
        const response = await post(appFor(address), [target, body], headers);
        expect([response.status, response.body.code], target).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password and denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await post(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await post(appFor(address), operation, headers);
        expect(response.status, `${operation[0]}: ${JSON.stringify(response.body)}`).toBe(200);
      }
    }
    expect(effects.piperFetch).toHaveBeenCalledTimes(3);
    expect(effects.piperFetch).toHaveBeenLastCalledWith('en_US-example-medium', storedVoice);
    expect(effects.startWhisper).toHaveBeenCalledTimes(3);
    expect(effects.startWhisper).toHaveBeenLastCalledWith(storedVoice);
  });

  it('leaves whisper stop and the TTS test open to a remote password-free caller', async () => {
    const stop = await post(appFor(), ['/api/voice/whisper', { action: 'stop' }]);
    expect([stop.status, stop.body]).toEqual([200, { success: true, action: 'stop' }]);
    expect(open.stopWhisper).toHaveBeenCalledTimes(1);
    const spoken = await post(appFor(), ['/api/voice/test', { text: 'Hello' }]);
    expect(spoken.status).toBe(200);
    expect(open.synthesize).toHaveBeenCalledWith('Hello', { voice: undefined, engine: undefined });
    expectNoEffects();
  });
});
