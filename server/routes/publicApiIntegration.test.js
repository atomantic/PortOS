/**
 * End-to-end integration: the REAL authGate middleware + the REAL voicePublic
 * router + the REAL voice router, wired against a temp data dir. Exercises the
 * full request path the plan's verification section describes:
 *   - auth OFF → public synth works
 *   - auth ON + exposed+passwordless → public synth works, config mutation 401s
 *   - auth ON + requireAuth → public synth 401s without a token, works with one
 * Only the TTS engine modules are mocked (so no ML models load); everything
 * else is the production code path.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { bindSettingsFile } from '../lib/settingsTestUtil.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-publicapi-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// Mock only the TTS engine backends so synthesize()/listVoices() don't load
// Kokoro/Piper. The dispatcher (tts.js), config, and routes are all real.
vi.mock('../services/voice/tts-kokoro.js', () => ({
  synthesizeKokoro: vi.fn(async () => ({ wav: Buffer.from('RIFFkokoro'), latencyMs: 5 })),
  listKokoroVoices: vi.fn(async () => [{ name: 'af_heart' }]),
  readyState: vi.fn(() => 'lazy'),
  unloadKokoro: vi.fn(() => ({ unloaded: false })),
  loadedModelKey: vi.fn(() => null),
}));
vi.mock('../services/voice/tts-piper.js', () => ({
  synthesizePiper: vi.fn(async () => ({ wav: Buffer.from('RIFFpiper'), latencyMs: 7 })),
  listPiperVoices: vi.fn(async () => [{ name: 'en_GB-jenny_dioco-medium' }]),
}));

// Direct settings.json writes that also drop the getSettings() read cache —
// see server/lib/settingsTestUtil.js for why the reset is required here
// (a prior setPassword() warms the cache; a bypass-save() write leaves it stale).
const { mergeSettingsFile } = bindSettingsFile(tempRoot);

const resetSettings = (extra = {}) => {
  writeFileSync(join(tempRoot, 'settings.json'), JSON.stringify(extra, null, 2) + '\n');
  writeFileSync(join(tempRoot, 'auth-sessions.json'), '{"tokens":[]}\n');
};
const setApiAccess = (apiAccess) => mergeSettingsFile({ apiAccess });

const buildApp = async () => {
  const { authGate } = await import('../lib/authGate.js');
  const voicePublicRoutes = (await import('./voicePublic.js')).default;
  const voiceRoutes = (await import('./voice.js')).default;
  const app = express();
  app.use(express.json());
  app.use(authGate);
  // Intentionally do NOT set `io`: asyncHandler's error path only fires
  // emitErrorEvent (→ errorEvents.emit('error', …)) when `io` is present, and
  // vi.resetModules() re-imports a FRESH errorHandler each buildApp() with no
  // 'error' listener — a bare EventEmitter throws on an unhandled 'error'
  // event. Leaving `io` unset skips that path; the 400 response is still sent.
  // None of the routes exercised here need `io` (we don't hit /api/voice/speak).
  app.use('/api/voice/public', voicePublicRoutes);
  app.use('/api/voice', voiceRoutes);
  return app;
};

beforeEach(() => {
  vi.resetModules();
  resetSettings();
});
afterAll(() => cleanup());

describe('public voice API — end-to-end through authGate', () => {
  it('auth OFF: public synthesize returns WAV', async () => {
    const app = await buildApp();
    const res = await request(app).post('/api/voice/public/synthesize').send({ text: 'hello' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/wav/);
  });

  it('400 UNKNOWN_VOICE for an unknown Kokoro voice override', async () => {
    // synthesize() validates Kokoro voices against the catalog (symmetric with
    // Piper) so a bogus id returns the documented 400 instead of erroring in
    // the model. tts.js + kokoro-voices.js are real here; only the backend is mocked.
    const app = await buildApp();
    const res = await request(app)
      .post('/api/voice/public/synthesize')
      .send({ text: 'hi', engine: 'kokoro', voice: 'not_a_real_voice' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_VOICE');
  });

  it('accepts a valid Kokoro voice override', async () => {
    const app = await buildApp();
    const res = await request(app)
      .post('/api/voice/public/synthesize')
      .send({ text: 'hi', engine: 'kokoro', voice: 'af_heart' });
    expect(res.status).toBe(200);
  });

  it('auth ON + exposed + passwordless: public synthesize works WITHOUT a token', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await setApiAccess({ voice: { exposed: true, requireAuth: false } });
    const app = await buildApp();
    const res = await request(app).post('/api/voice/public/synthesize').send({ text: 'hi', engine: 'piper' });
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });

  it('auth ON + exposed + passwordless: config mutation is STILL 401', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await setApiAccess({ voice: { exposed: true, requireAuth: false } });
    const app = await buildApp();
    const res = await request(app).put('/api/voice/config').send({ enabled: true });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('auth ON + requireAuth: public synthesize 401s without a token, works with one', async () => {
    const auth = await import('../services/auth.js');
    const { token } = await auth.setPassword({ newPassword: 'correct-horse' });
    await setApiAccess({ voice: { exposed: true, requireAuth: true } });
    const app = await buildApp();

    const denied = await request(app).post('/api/voice/public/synthesize').send({ text: 'hi' });
    expect(denied.status).toBe(401);

    const allowed = await request(app)
      .post('/api/voice/public/synthesize')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'hi' });
    expect(allowed.status).toBe(200);
  });

  it('auth ON + not exposed: public synthesize 401s', async () => {
    const auth = await import('../services/auth.js');
    await auth.setPassword({ newPassword: 'correct-horse' });
    await setApiAccess({ voice: { exposed: false, requireAuth: false } });
    const app = await buildApp();
    const res = await request(app).post('/api/voice/public/synthesize').send({ text: 'hi' });
    expect(res.status).toBe(401);
  });
});
