import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// Mock all voice service modules before importing the router so the route
// file's top-level imports resolve to the mocks.
vi.mock('../services/voice/config.js', () => ({
  getVoiceConfig: vi.fn(),
  updateVoiceConfig: vi.fn(),
}));
vi.mock('../services/voice/health.js', () => ({
  checkAll: vi.fn(),
  invalidateHealthCache: vi.fn(),
}));
vi.mock('../services/voice/bootstrap.js', () => ({
  reconcile: vi.fn(),
  verifyBinaries: vi.fn(),
  verifyModels: vi.fn(),
  downloadPiperVoice: vi.fn(),
}));
vi.mock('../services/voice/tts.js', () => ({
  synthesize: vi.fn(),
  listVoices: vi.fn(),
}));
vi.mock('../services/voice/piper-voices.js', () => ({
  findPiperVoice: vi.fn(),
}));

import * as config from '../services/voice/config.js';
import * as health from '../services/voice/health.js';
import * as bootstrap from '../services/voice/bootstrap.js';
import * as tts from '../services/voice/tts.js';
import * as piperVoices from '../services/voice/piper-voices.js';
import voiceRoutes from './voice.js';

const DEFAULT_CFG = {
  enabled: false,
  stt: { engine: 'web-speech', endpoint: 'http://127.0.0.1:5562' },
  tts: { engine: 'kokoro' },
};

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/voice', voiceRoutes);
  return app;
};

describe('Voice Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.getVoiceConfig.mockResolvedValue(DEFAULT_CFG);
  });

  describe('GET /api/voice/config', () => {
    it('returns the merged voice config', async () => {
      const res = await request(buildApp()).get('/api/voice/config');
      expect(res.status).toBe(200);
      expect(res.body.stt.engine).toBe('web-speech');
    });
  });

  describe('PUT /api/voice/config', () => {
    it('rejects unknown top-level keys via the Zod strict schema', async () => {
      const res = await request(buildApp()).put('/api/voice/config').send({ bogus: true });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.error).toMatch(/Invalid voice config/);
      expect(config.updateVoiceConfig).not.toHaveBeenCalled();
    });

    it('rejects an invalid stt engine value', async () => {
      const res = await request(buildApp())
        .put('/api/voice/config')
        .send({ stt: { engine: 'cloud-api' } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(config.updateVoiceConfig).not.toHaveBeenCalled();
    });

    it('rejects an invalid tts engine value', async () => {
      const res = await request(buildApp())
        .put('/api/voice/config')
        .send({ tts: { engine: 'elevenlabs' } });
      expect(res.status).toBe(400);
      expect(config.updateVoiceConfig).not.toHaveBeenCalled();
    });

    it('saves a valid patch and runs reconcile', async () => {
      const next = { ...DEFAULT_CFG, enabled: true };
      config.updateVoiceConfig.mockResolvedValue(next);
      bootstrap.reconcile.mockResolvedValue({ skipped: 'web-speech', piperProvisioned: false });

      const res = await request(buildApp())
        .put('/api/voice/config')
        .send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.config.enabled).toBe(true);
      expect(res.body.reconciliation).toEqual({ skipped: 'web-speech', piperProvisioned: false });
      expect(config.updateVoiceConfig).toHaveBeenCalledWith({ enabled: true });
      expect(health.invalidateHealthCache).toHaveBeenCalled();
    });

    it('reports reconcile failures without 500-ing the route', async () => {
      config.updateVoiceConfig.mockResolvedValue({ ...DEFAULT_CFG, enabled: true });
      bootstrap.reconcile.mockRejectedValue(new Error('whisper-server not on PATH'));

      const res = await request(buildApp())
        .put('/api/voice/config')
        .send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body.reconciliation).toEqual({ error: 'whisper-server not on PATH' });
    });
  });

  describe('GET /api/voice/status', () => {
    it('returns the expected shape', async () => {
      health.checkAll.mockResolvedValue({ whisper: { ok: true } });
      bootstrap.verifyBinaries.mockResolvedValue({ whisper: '/usr/bin/whisper-server', piper: null, piperRequired: false });
      bootstrap.verifyModels.mockReturnValue({ sttModel: '/p/model.bin', ttsVoice: 'kokoro:x' });

      const res = await request(buildApp()).get('/api/voice/status');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        enabled: false,
        sttEngine: 'web-speech',
        ttsEngine: 'kokoro',
        services: { whisper: { ok: true } },
        binaries: { whisper: '/usr/bin/whisper-server' },
        models: { sttModel: '/p/model.bin' },
      });
    });
  });

  describe('GET /api/voice/voices', () => {
    it('delegates to listVoices with the requested engine and returns { engine, voices } shape', async () => {
      tts.listVoices.mockResolvedValue({ engine: 'kokoro', voices: [{ id: 'af_heart' }] });
      const res = await request(buildApp()).get('/api/voice/voices?engine=kokoro');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ engine: 'kokoro', voices: [{ id: 'af_heart' }] });
      expect(tts.listVoices).toHaveBeenCalledWith('kokoro');
    });

    it('ignores unknown engine query values', async () => {
      tts.listVoices.mockResolvedValue({ engine: 'kokoro', voices: [] });
      await request(buildApp()).get('/api/voice/voices?engine=elevenlabs');
      expect(tts.listVoices).toHaveBeenCalledWith(undefined);
    });
  });

  describe('POST /api/voice/piper/fetch', () => {
    it('rejects unknown piper voice ids with 400', async () => {
      piperVoices.findPiperVoice.mockReturnValue(null);
      const res = await request(buildApp())
        .post('/api/voice/piper/fetch')
        .send({ voice: 'en_US-fake-high' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unknown piper voice/);
      expect(bootstrap.downloadPiperVoice).not.toHaveBeenCalled();
    });

    it('downloads a valid voice and returns the result', async () => {
      piperVoices.findPiperVoice.mockReturnValue({ id: 'en_GB-jenny_dioco-medium' });
      bootstrap.downloadPiperVoice.mockResolvedValue({ skipped: true, voicePath: '~/.portos/voice/voices/en_GB-jenny_dioco-medium.onnx' });

      const res = await request(buildApp())
        .post('/api/voice/piper/fetch')
        .send({ voice: 'en_GB-jenny_dioco-medium' });
      expect(res.status).toBe(200);
      expect(res.body.voice).toBe('en_GB-jenny_dioco-medium');
      expect(res.body.skipped).toBe(true);
      expect(bootstrap.downloadPiperVoice).toHaveBeenCalled();
    });
  });

  describe('POST /api/voice/test', () => {
    it('requires text', async () => {
      const res = await request(buildApp()).post('/api/voice/test').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/text is required/);
    });

    it('returns WAV bytes on success', async () => {
      tts.synthesize.mockResolvedValue({ wav: Buffer.from([0x52, 0x49, 0x46, 0x46]), latencyMs: 123 });
      const res = await request(buildApp())
        .post('/api/voice/test')
        .send({ text: 'hello', voice: 'af_heart', engine: 'kokoro' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/audio\/wav/);
      expect(res.headers['x-tts-latency-ms']).toBe('123');
    });
  });
});
