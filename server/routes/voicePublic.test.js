import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
const { request } = await import('../lib/testHelper.js');

vi.mock('../services/voice/tts.js', async () => ({
  synthesize: vi.fn(),
  listVoices: vi.fn(),
  VALID_ENGINES: (await import('../lib/voiceEngines.js')).VALID_ENGINES,
}));
vi.mock('../services/voice/config.js', () => ({
  getVoiceConfig: vi.fn(),
}));
vi.mock('../services/voice/proactiveSpeech.js', () => ({
  MAX_PROACTIVE_TEXT_LEN: 2000,
}));
const access = vi.hoisted(() => ({ exposed: true }));
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ apiAccess: { voice: { exposed: access.exposed } } })),
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

const tts = await import('../services/voice/tts.js');
const config = await import('../services/voice/config.js');
const { default: voicePublicRoutes } = await import('./voicePublic.js');

const buildApp = (authContext) => {
  const app = express();
  // A remote LAN caller: host control then rests on the auth context alone.
  if (authContext) {
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.10' });
      req.portosAuthContext = authContext;
      next();
    });
  }
  app.use(express.json());
  app.use('/api/voice/public', voicePublicRoutes);
  return app;
};

describe('Public Voice API (/api/voice/public)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.exposed = true;
    config.getVoiceConfig.mockResolvedValue({
      tts: { engine: 'piper', kokoro: { voice: 'af_heart' }, piper: { voice: 'en_GB-jenny_dioco-medium' } },
    });
  });

  describe('POST /synthesize', () => {
    it('synthesizes text and returns audio/wav with headers', async () => {
      tts.synthesize.mockResolvedValue({ wav: Buffer.from('RIFFfake'), latencyMs: 42, engine: 'piper' });
      const res = await request(buildApp()).post('/api/voice/public/synthesize').send({ text: 'hello' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/audio\/wav/);
      expect(res.headers['x-tts-latency-ms']).toBe('42');
      expect(res.headers['x-tts-engine']).toBe('piper');
      expect(tts.synthesize).toHaveBeenCalledWith('hello', expect.objectContaining({ engine: undefined }));
    });

    it.each([...tts.VALID_ENGINES])('passes %s engine/voice/rate overrides through', async (engine) => {
      tts.synthesize.mockResolvedValue({ wav: Buffer.from('x'), latencyMs: 1, engine: 'piper' });
      const res = await request(buildApp()).post('/api/voice/public/synthesize')
        .send({ text: 'hi', engine, voice: 'en_US-amy-medium', rate: 1.5 });
      expect(res.status).toBe(200);
      expect(tts.synthesize).toHaveBeenCalledWith('hi', { engine, voice: 'en_US-amy-medium', rate: 1.5 });
    });

    it('400s on empty text', async () => {
      const res = await request(buildApp()).post('/api/voice/public/synthesize').send({ text: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('400s on unknown engine', async () => {
      const res = await request(buildApp()).post('/api/voice/public/synthesize').send({ text: 'hi', engine: 'elevenlabs' });
      expect(res.status).toBe(400);
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('400s on unknown keys (strict schema)', async () => {
      const res = await request(buildApp()).post('/api/voice/public/synthesize').send({ text: 'hi', voiceId: 'oops' });
      expect(res.status).toBe(400);
      expect(tts.synthesize).not.toHaveBeenCalled();
    });

    it('surfaces synthesize() UNKNOWN_VOICE as 400', async () => {
      const { ServerError } = await import('../lib/errorHandler.js');
      tts.synthesize.mockRejectedValue(new ServerError('unknown piper voice: bogus', { status: 400, code: 'UNKNOWN_VOICE' }));
      const res = await request(buildApp()).post('/api/voice/public/synthesize').send({ text: 'hi', engine: 'piper', voice: 'bogus' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_VOICE');
    });
  });

  describe('exposure (#13055)', () => {
    // authGate applies the exposure toggle only with a password set, so the
    // router enforces it on a password-free install: unexposed synthesis
    // spawns a TTS runtime only for a caller with host control.
    it('refuses unexposed synthesis without host control and keeps it for an operator', async () => {
      access.exposed = false;
      tts.synthesize.mockResolvedValue({ wav: Buffer.from('x'), latencyMs: 1, engine: 'piper' });
      const refused = await request(buildApp({ enabled: false })).post('/api/voice/public/synthesize').send({ text: 'hi' });
      expect([refused.status, refused.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      expect(tts.synthesize).not.toHaveBeenCalled();

      const operator = { enabled: true, authenticated: true, method: 'session' };
      expect((await request(buildApp(operator)).post('/api/voice/public/synthesize').send({ text: 'hi' })).status).toBe(200);
      expect(tts.synthesize).toHaveBeenCalledTimes(1);
    });

    it('keeps the voice list readable while unexposed', async () => {
      access.exposed = false;
      tts.listVoices.mockResolvedValue([]);
      expect((await request(buildApp({ enabled: false })).get('/api/voice/public/voices')).status).toBe(200);
    });
  });

  describe('GET /voices', () => {
    it('delegates to listVoices with the requested engine', async () => {
      tts.listVoices.mockResolvedValue({ engine: 'piper', voices: [{ id: 'af_heart' }] });
      const res = await request(buildApp()).get('/api/voice/public/voices?engine=piper');
      expect(res.status).toBe(200);
      expect(res.body.engine).toBe('piper');
      expect(tts.listVoices).toHaveBeenCalledWith('piper');
    });

    it('ignores an unknown engine query value', async () => {
      tts.listVoices.mockResolvedValue({ engine: 'piper', voices: [] });
      await request(buildApp()).get('/api/voice/public/voices?engine=bogus');
      expect(tts.listVoices).toHaveBeenCalledWith(undefined);
    });
  });

  describe('GET /engines', () => {
    it('reads Qwen3 defaults from its persisted configuration key', async () => {
      config.getVoiceConfig.mockResolvedValue({ tts: { engine: 'qwen3-tts', qwen3: { voice: 'warm-narrator' } } });
      const res = await request(buildApp()).get('/api/voice/public/engines');
      expect(res.body.defaults['qwen3-tts']).toBe('warm-narrator');
    });
    it('returns engines + active + per-engine default voice', async () => {
      const res = await request(buildApp()).get('/api/voice/public/engines');
      expect(res.status).toBe(200);
      expect(res.body.engines).toEqual([...tts.VALID_ENGINES]);
      expect(Object.keys(res.body.defaults)).toEqual([...tts.VALID_ENGINES]);
      expect(res.body.defaults['qwen3-tts']).toBeNull();
      expect(res.body.active).toBe('piper');
      expect(res.body.defaults.piper).toBe('en_GB-jenny_dioco-medium');
    });
  });
});
