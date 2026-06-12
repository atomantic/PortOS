import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

vi.mock('../services/voice/tts.js', () => ({
  synthesize: vi.fn(),
  listVoices: vi.fn(),
  VALID_ENGINES: new Set(['kokoro', 'piper']),
}));
vi.mock('../services/voice/config.js', () => ({
  getVoiceConfig: vi.fn(),
}));
vi.mock('../services/voice/proactiveSpeech.js', () => ({
  MAX_PROACTIVE_TEXT_LEN: 2000,
}));

import * as tts from '../services/voice/tts.js';
import * as config from '../services/voice/config.js';
import voicePublicRoutes from './voicePublic.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/voice/public', voicePublicRoutes);
  return app;
};

describe('Public Voice API (/api/voice/public)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.getVoiceConfig.mockResolvedValue({
      tts: { engine: 'kokoro', kokoro: { voice: 'af_heart' }, piper: { voice: 'en_GB-jenny_dioco-medium' } },
    });
  });

  describe('POST /synthesize', () => {
    it('synthesizes text and returns audio/wav with headers', async () => {
      tts.synthesize.mockResolvedValue({ wav: Buffer.from('RIFFfake'), latencyMs: 42, engine: 'kokoro' });
      const res = await request(buildApp()).post('/api/voice/public/synthesize').send({ text: 'hello' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/audio\/wav/);
      expect(res.headers['x-tts-latency-ms']).toBe('42');
      expect(res.headers['x-tts-engine']).toBe('kokoro');
      expect(tts.synthesize).toHaveBeenCalledWith('hello', expect.objectContaining({ engine: undefined }));
    });

    it('passes engine/voice/rate overrides through', async () => {
      tts.synthesize.mockResolvedValue({ wav: Buffer.from('x'), latencyMs: 1, engine: 'piper' });
      await request(buildApp()).post('/api/voice/public/synthesize')
        .send({ text: 'hi', engine: 'piper', voice: 'en_US-amy-medium', rate: 1.5 });
      expect(tts.synthesize).toHaveBeenCalledWith('hi', { engine: 'piper', voice: 'en_US-amy-medium', rate: 1.5 });
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

  describe('GET /voices', () => {
    it('delegates to listVoices with the requested engine', async () => {
      tts.listVoices.mockResolvedValue({ engine: 'kokoro', voices: [{ id: 'af_heart' }] });
      const res = await request(buildApp()).get('/api/voice/public/voices?engine=kokoro');
      expect(res.status).toBe(200);
      expect(res.body.engine).toBe('kokoro');
      expect(tts.listVoices).toHaveBeenCalledWith('kokoro');
    });

    it('ignores an unknown engine query value', async () => {
      tts.listVoices.mockResolvedValue({ engine: 'kokoro', voices: [] });
      await request(buildApp()).get('/api/voice/public/voices?engine=bogus');
      expect(tts.listVoices).toHaveBeenCalledWith(undefined);
    });
  });

  describe('GET /engines', () => {
    it('returns engines + active + per-engine default voice', async () => {
      const res = await request(buildApp()).get('/api/voice/public/engines');
      expect(res.status).toBe(200);
      expect(res.body.engines).toEqual(expect.arrayContaining(['kokoro', 'piper']));
      expect(res.body.active).toBe('kokoro');
      expect(res.body.defaults.kokoro).toBe('af_heart');
      expect(res.body.defaults.piper).toBe('en_GB-jenny_dioco-medium');
    });
  });
});
