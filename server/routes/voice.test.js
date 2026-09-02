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
  // POST /api/voice/whisper imports these at module load — without the
  // mock entries the destructured imports resolve to `undefined` and the
  // route TypeErrors the first time it's hit.
  startWhisper: vi.fn(),
  stopWhisper: vi.fn(),
}));
vi.mock('../services/voice/tts.js', () => ({
  synthesize: vi.fn(),
  listVoices: vi.fn(),
  listVoiceEngines: vi.fn(),
  VALID_ENGINES: new Set(['kokoro', 'piper', 'qwen3-tts']),
}));
vi.mock('../services/voice/profiles.js', () => ({
  listVoiceProfiles: vi.fn(),
  promotePresetProfile: vi.fn(),
  createVoiceDesignCandidate: vi.fn(),
  createClonedVoiceCandidate: vi.fn(),
  promoteVoiceProfile: vi.fn(),
}));
vi.mock('../services/voice/profileBenchmarks.js', () => ({
  renderProfileBenchmark: vi.fn(),
  benchmarkProfileInteractive: vi.fn(),
}));
vi.mock('../services/voice/qwen3TtsRuntime.js', () => ({
  getQwen3RuntimeStatus: vi.fn(),
  downloadQwen3Model: vi.fn(),
}));
vi.mock('../services/voice/fineTuning.js', () => ({
  startFineTuningJob: vi.fn(),
  getFineTuningJobStatus: vi.fn(),
  cancelFineTuningJob: vi.fn(),
  promoteCheckpoint: vi.fn(),
}));
// GET /api/voice/tts/status + POST /api/voice/tts/unload destructure these at
// module load — mock them so the route resolves without spinning up Kokoro.
vi.mock('../services/voice/tts-kokoro.js', () => ({
  readyState: vi.fn(() => 'lazy'),
  unloadKokoro: vi.fn(() => ({ unloaded: false })),
  loadedModelKey: vi.fn(() => null),
}));
vi.mock('../services/voice/piper-voices.js', () => ({
  findPiperVoice: vi.fn(),
}));
vi.mock('../services/voice/proactiveSpeech.js', async () => {
  const actual = await vi.importActual('../services/voice/proactiveSpeech.js');
  return {
    ...actual,
    speakProactive: vi.fn(),
  };
});
vi.mock('../services/voice/facetimeBridge.js', () => ({
  checkSetup: vi.fn(),
  probe: vi.fn(),
  call: vi.fn(),
  hangup: vi.fn(),
}));

import * as config from '../services/voice/config.js';
import * as health from '../services/voice/health.js';
import * as bootstrap from '../services/voice/bootstrap.js';
import * as tts from '../services/voice/tts.js';
import * as voiceProfiles from '../services/voice/profiles.js';
import * as profileBenchmarks from '../services/voice/profileBenchmarks.js';
import * as qwen3TtsRuntime from '../services/voice/qwen3TtsRuntime.js';
import * as fineTuning from '../services/voice/fineTuning.js';
import { ServerError } from '../lib/errorHandler.js';
import * as piperVoices from '../services/voice/piper-voices.js';
import * as proactiveSpeech from '../services/voice/proactiveSpeech.js';
import * as kokoro from '../services/voice/tts-kokoro.js';
import * as facetimeBridge from '../services/voice/facetimeBridge.js';
import voiceRoutes from './voice.js';
import { errorEvents } from '../lib/errorHandler.js';

// Node's EventEmitter throws if 'error' is emitted with zero listeners.
// asyncHandler emits to errorEvents on every route failure, so swallow it
// here — assertions go through the HTTP response, not the emitter.
errorEvents.on('error', () => {});

const DEFAULT_CFG = {
  enabled: false,
  stt: { engine: 'web-speech', endpoint: 'http://127.0.0.1:5562' },
  tts: { engine: 'kokoro', rate: 1, kokoro: { modelId: 'kokoro-test', dtype: 'q8' } },
};

const buildApp = ({ io = { emit: () => {} } } = {}) => {
  const app = express();
  app.use(express.json());
  // /speak fails fast when io is missing (a 500 misconfiguration error
  // rather than a 200 { ok:false, reason:'no-io' } that monitoring would
  // miss). Attach a stub io by default; pass io:null to exercise the
  // misconfiguration branch.
  if (io) app.set('io', io);
  app.use('/api/voice', voiceRoutes);
  return app;
};

describe('Voice Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.getVoiceConfig.mockResolvedValue(DEFAULT_CFG);
  });

  describe('machine-local voice profiles & Voice Lab', () => {
    it('reports the preset engine capability contract', async () => {
      tts.listVoiceEngines.mockResolvedValue([{ id: 'kokoro', capabilities: { preset: true, formant: false } }]);
      const res = await request(buildApp()).get('/api/voice/engines');
      expect(res.status).toBe(200);
      expect(res.body.engines).toEqual([{ id: 'kokoro', capabilities: { preset: true, formant: false } }]);
    });

    it('lists only the requested machine-local character binding', async () => {
      voiceProfiles.listVoiceProfiles.mockResolvedValue([{ id: 'voice-profile-1' }]);
      const res = await request(buildApp()).get('/api/voice/profiles?universeId=uni-1&characterId=char-1');
      expect(res.status).toBe(200);
      expect(voiceProfiles.listVoiceProfiles).toHaveBeenCalledWith({ universeId: 'uni-1', characterId: 'char-1' });
      expect(res.body.profiles).toEqual([{ id: 'voice-profile-1' }]);
    });

    it('promotes a preset with the current local model and delivery provenance', async () => {
      voiceProfiles.promotePresetProfile.mockResolvedValue({ id: 'voice-profile-1' });
      const res = await request(buildApp()).post('/api/voice/profiles/preset').send({
        universeId: 'uni-1', characterId: 'char-1', voiceId: 'kokoro:af_heart',
      });
      expect(res.status).toBe(201);
      expect(voiceProfiles.promotePresetProfile).toHaveBeenCalledWith(expect.objectContaining({
        modelRevision: 'kokoro-test:q8', delivery: { rate: 1 },
      }));
      expect(res.body).toEqual({ profile: { id: 'voice-profile-1' } });
    });

    it('creates a candidate voice design profile without altering approved binding', async () => {
      voiceProfiles.createVoiceDesignCandidate.mockResolvedValue({ id: 'voice-design-1', kind: 'designed', approval: { status: 'draft' } });
      const res = await request(buildApp()).post('/api/voice/profiles/design').send({
        universeId: 'uni-1', characterId: 'char-1', instructions: 'warm low alto', seed: 42,
      });
      expect(res.status).toBe(201);
      expect(voiceProfiles.createVoiceDesignCandidate).toHaveBeenCalledWith(expect.objectContaining({
        instructions: 'warm low alto', seed: 42,
      }));
      expect(res.body.profile.kind).toBe('designed');
    });

    it('creates a consented clone candidate profile with verified performer consent', async () => {
      voiceProfiles.createClonedVoiceCandidate.mockResolvedValue({ id: 'voice-clone-1', kind: 'cloned', approval: { status: 'draft' } });
      const res = await request(buildApp()).post('/api/voice/profiles/clone').send({
        universeId: 'uni-1',
        characterId: 'char-1',
        filename: 'reference.wav',
        audioBase64: Buffer.from('mockwav').toString('base64'),
        transcript: 'sample transcript',
        performerConsentConfirmed: true,
      });
      expect(res.status).toBe(201);
      expect(voiceProfiles.createClonedVoiceCandidate).toHaveBeenCalledWith(expect.objectContaining({
        filename: 'reference.wav',
        transcript: 'sample transcript',
        performerConsentConfirmed: true,
      }));
    });

    it('promotes candidate profile and sets routes', async () => {
      voiceProfiles.promoteVoiceProfile.mockResolvedValue({ id: 'voice-profile-1', approval: { status: 'approved' } });
      const res = await request(buildApp()).post('/api/voice/profiles/voice-profile-1/promote').send({
        routes: { studio: { enabled: true }, interactive: { enabled: true } },
      });
      expect(res.status).toBe(200);
      expect(voiceProfiles.promoteVoiceProfile).toHaveBeenCalledWith('voice-profile-1', expect.any(Object));
    });

    it('runs interactive latency qualification benchmark', async () => {
      profileBenchmarks.benchmarkProfileInteractive.mockResolvedValue({ id: 'voice-profile-1' });
      const res = await request(buildApp()).post('/api/voice/profiles/voice-profile-1/benchmark-interactive').send({
        maxFirstAudioMs: 800,
      });
      expect(res.status).toBe(200);
      expect(profileBenchmarks.benchmarkProfileInteractive).toHaveBeenCalledWith('voice-profile-1', { maxFirstAudioMs: 800 });
    });

    it('runs fixed benchmarks only for a valid profile id', async () => {
      profileBenchmarks.renderProfileBenchmark.mockResolvedValue({ id: 'voice-profile-1' });
      const res = await request(buildApp()).post('/api/voice/profiles/voice-profile-1/benchmark').send({});
      expect(res.status).toBe(200);
      expect(profileBenchmarks.renderProfileBenchmark).toHaveBeenCalledWith('voice-profile-1');
    });

    it('manages fine-tuning lifecycle: start, status, cancel, promote', async () => {
      const jobId = '11111111-2222-4333-8444-555555555555';
      fineTuning.startFineTuningJob.mockResolvedValue({ jobId, status: 'running' });
      fineTuning.getFineTuningJobStatus.mockResolvedValue({ jobId, status: 'completed', checkpoints: [{ id: 'ckpt-1' }] });
      fineTuning.cancelFineTuningJob.mockReturnValue({ ok: true, jobId, status: 'cancelled' });
      fineTuning.promoteCheckpoint.mockResolvedValue({ id: 'voice-profile-1', kind: 'fine-tuned' });

      const startRes = await request(buildApp()).post('/api/voice/profiles/voice-profile-1/fine-tune/start').send({ epochs: 5 });
      expect(startRes.status).toBe(202);

      const statusRes = await request(buildApp()).get(`/api/voice/profiles/voice-profile-1/fine-tune/${jobId}`);
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.status).toBe('completed');
      expect(fineTuning.getFineTuningJobStatus).toHaveBeenCalledWith(jobId, 'voice-profile-1');

      const cancelRes = await request(buildApp()).post(`/api/voice/profiles/voice-profile-1/fine-tune/${jobId}/cancel`).send({});
      expect(cancelRes.status).toBe(200);

      const promoteRes = await request(buildApp()).post(`/api/voice/profiles/voice-profile-1/fine-tune/${jobId}/promote`).send({ checkpointId: 'ckpt-1' });
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.body.profile.kind).toBe('fine-tuned');
    });

    it('rejects a fine-tuning job id that could escape the profile directory', async () => {
      const res = await request(buildApp())
        .get('/api/voice/profiles/voice-profile-1/fine-tune/..%2F..%2Fother-profile');
      expect(res.status).toBe(400);
      expect(fineTuning.getFineTuningJobStatus).not.toHaveBeenCalled();
    });

    it('probes Qwen3 runtime status and downloads model on demand', async () => {
      qwen3TtsRuntime.getQwen3RuntimeStatus.mockResolvedValue({ ok: true, installed: true });
      qwen3TtsRuntime.downloadQwen3Model.mockResolvedValue({ ok: true, modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign' });

      const statusRes = await request(buildApp()).get('/api/voice/qwen3/status');
      expect(statusRes.status).toBe(200);
      expect(statusRes.body.ok).toBe(true);

      const downloadRes = await request(buildApp()).post('/api/voice/qwen3/download-model').send({
        modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
      });
      expect(downloadRes.status).toBe(200);
      expect(downloadRes.body.modelId).toBe('Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign');
    });
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

    it('accepts a valid llm.fastPath patch (fast-resolution cascade)', async () => {
      config.updateVoiceConfig.mockResolvedValue({ ...DEFAULT_CFG });
      bootstrap.reconcile.mockResolvedValue({ skipped: true });
      const patch = { llm: { fastPath: { enabled: true, triggers: true, browserLlm: true, browser: { temperature: 0.5, topK: 4 } } } };
      const res = await request(buildApp()).put('/api/voice/config').send(patch);
      expect(res.status).toBe(200);
      expect(config.updateVoiceConfig).toHaveBeenCalledWith(patch);
    });

    it('accepts a facetime.autoAnswer patch', async () => {
      config.updateVoiceConfig.mockResolvedValue({ ...DEFAULT_CFG });
      bootstrap.reconcile.mockResolvedValue({ skipped: true });
      const patch = { facetime: { autoAnswer: true } };
      const res = await request(buildApp()).put('/api/voice/config').send(patch);
      expect(res.status).toBe(200);
      expect(config.updateVoiceConfig).toHaveBeenCalledWith(patch);
    });

    it('rejects a non-boolean facetime.autoAnswer', async () => {
      const res = await request(buildApp())
        .put('/api/voice/config')
        .send({ facetime: { autoAnswer: 'yes' } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(config.updateVoiceConfig).not.toHaveBeenCalled();
    });

    it('rejects out-of-range fastPath.browser params', async () => {
      const res = await request(buildApp())
        .put('/api/voice/config')
        .send({ llm: { fastPath: { browser: { temperature: 9 } } } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(config.updateVoiceConfig).not.toHaveBeenCalled();
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

    it('maps ServerError UNKNOWN_VOICE from synthesize() to a 400 response', async () => {
      tts.synthesize.mockRejectedValue(new ServerError('voice id not in catalog', {
        status: 400,
        code: 'UNKNOWN_VOICE',
      }));
      const res = await request(buildApp())
        .post('/api/voice/test')
        .send({ text: 'hello', voice: 'nonexistent', engine: 'piper' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('voice id not in catalog');
      expect(res.body.code).toBe('UNKNOWN_VOICE');
    });

    it('lets unrelated synth errors bubble to asyncHandler (500)', async () => {
      tts.synthesize.mockRejectedValue(new Error('synth crashed'));
      const res = await request(buildApp())
        .post('/api/voice/test')
        .send({ text: 'hello', voice: 'whatever', engine: 'piper' });
      expect(res.status).toBe(500);
    });
  });

  describe('POST /api/voice/speak', () => {
    it('rejects empty text via the Zod schema', async () => {
      const res = await request(buildApp()).post('/api/voice/speak').send({ text: '' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(proactiveSpeech.speakProactive).not.toHaveBeenCalled();
    });

    // Regression: schema trims before .min(1) so whitespace-only payloads
    // fail at the HTTP boundary with a 400, not at the downstream
    // speakProactive empty-text branch with a 200 {ok:false}.
    it.each(['   ', '\t', '\n', '   \t  \n  '])('rejects whitespace-only text "%s"', async (text) => {
      const res = await request(buildApp()).post('/api/voice/speak').send({ text });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(proactiveSpeech.speakProactive).not.toHaveBeenCalled();
    });

    it('rejects invalid priority enum', async () => {
      const res = await request(buildApp())
        .post('/api/voice/speak')
        .send({ text: 'hi', priority: 'urgent' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('forwards text + priority to speakProactive and returns its result', async () => {
      proactiveSpeech.speakProactive.mockResolvedValue({ ok: true, latencyMs: 18 });
      const res = await request(buildApp())
        .post('/api/voice/speak')
        .send({ text: 'Heads up — meeting in five.', priority: 'high', source: 'cos' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, latencyMs: 18 });
      expect(proactiveSpeech.speakProactive).toHaveBeenCalledTimes(1);
      const [args] = proactiveSpeech.speakProactive.mock.calls[0];
      expect(args.text).toBe('Heads up — meeting in five.');
      expect(args.priority).toBe('high');
      expect(args.source).toBe('cos');
    });

    it('propagates suppression results (ok:false) without throwing', async () => {
      proactiveSpeech.speakProactive.mockResolvedValue({ ok: false, reason: 'quiet-hours' });
      const res = await request(buildApp()).post('/api/voice/speak').send({ text: 'late night ping' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: false, reason: 'quiet-hours' });
    });

    // Misconfiguration must surface as a real HTTP error so monitoring
    // sees it — a 200 ok:false here would silently mask a Socket.IO that
    // never attached.
    it('returns 500 VOICE_IO_UNAVAILABLE when io is not configured', async () => {
      proactiveSpeech.speakProactive.mockResolvedValue({ ok: true, latencyMs: 1 });
      const res = await request(buildApp({ io: null }))
        .post('/api/voice/speak')
        .send({ text: 'hi' });
      expect(res.status).toBe(500);
      expect(res.body.code).toBe('VOICE_IO_UNAVAILABLE');
      expect(proactiveSpeech.speakProactive).not.toHaveBeenCalled();
    });

    // Empty / whitespace-only source must NOT override speakProactive's
    // default of 'cos'. The schema transforms it to undefined so the
    // default kicks in.
    it.each(['', '   ', '\t'])('drops empty/whitespace source "%s" so default applies', async (source) => {
      proactiveSpeech.speakProactive.mockResolvedValue({ ok: true });
      const res = await request(buildApp())
        .post('/api/voice/speak')
        .send({ text: 'hi', source });
      expect(res.status).toBe(200);
      expect(proactiveSpeech.speakProactive).toHaveBeenCalledTimes(1);
      const [args] = proactiveSpeech.speakProactive.mock.calls[0];
      expect(args.source).toBeUndefined();
    });
  });

  describe('GET /api/voice/tts/status', () => {
    it('returns the Kokoro residency snapshot', async () => {
      kokoro.readyState.mockReturnValue('loaded');
      kokoro.loadedModelKey.mockReturnValue('kokoro-v1:af_heart');
      const res = await request(buildApp()).get('/api/voice/tts/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ kokoro: { state: 'loaded', loadedKey: 'kokoro-v1:af_heart' } });
    });
  });

  describe('POST /api/voice/tts/unload', () => {
    it('drops the cached Kokoro instance and echoes its result', async () => {
      kokoro.unloadKokoro.mockReturnValue({ unloaded: true });
      const res = await request(buildApp()).post('/api/voice/tts/unload');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ unloaded: true });
      expect(kokoro.unloadKokoro).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /api/voice/whisper', () => {
    it('stops whisper and invalidates the health cache', async () => {
      const res = await request(buildApp()).post('/api/voice/whisper').send({ action: 'stop' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, action: 'stop' });
      expect(bootstrap.stopWhisper).toHaveBeenCalledTimes(1);
      expect(bootstrap.startWhisper).not.toHaveBeenCalled();
      expect(health.invalidateHealthCache).toHaveBeenCalled();
    });

    it('starts whisper from the current config and returns the bootstrap result', async () => {
      bootstrap.startWhisper.mockResolvedValue({ restarted: true });
      const res = await request(buildApp()).post('/api/voice/whisper').send({ action: 'start' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, action: 'start', restarted: true });
      expect(config.getVoiceConfig).toHaveBeenCalled();
      expect(bootstrap.startWhisper).toHaveBeenCalledWith(DEFAULT_CFG);
      expect(bootstrap.stopWhisper).not.toHaveBeenCalled();
      expect(health.invalidateHealthCache).toHaveBeenCalled();
    });

    it('rejects an invalid action with 400 without touching whisper', async () => {
      const res = await request(buildApp()).post('/api/voice/whisper').send({ action: 'restart' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(bootstrap.startWhisper).not.toHaveBeenCalled();
      expect(bootstrap.stopWhisper).not.toHaveBeenCalled();
    });
  });

  describe('FaceTime Audio control plane', () => {
    it('GET /api/voice/facetime/status reports setup without spawning the helper', async () => {
      facetimeBridge.checkSetup.mockResolvedValue({ ready: true });
      const res = await request(buildApp()).get('/api/voice/facetime/status');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ready: true });
      expect(facetimeBridge.probe).not.toHaveBeenCalled();
    });

    it.each(['probe', 'call', 'hangup'])('POST /api/voice/facetime/%s dispatches to the matching bridge command', async (command) => {
      facetimeBridge[command].mockResolvedValue({ ok: true, command });
      const res = await request(buildApp()).post(`/api/voice/facetime/${command}`).send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, command });
      expect(facetimeBridge[command]).toHaveBeenCalledTimes(1);
    });

    it('POST /api/voice/facetime/probe propagates a bridge failure as an error response', async () => {
      facetimeBridge.probe.mockRejectedValue(new ServerError('helper not installed', { status: 409 }));
      const res = await request(buildApp()).post('/api/voice/facetime/probe').send({});
      expect(res.status).toBe(409);
    });

    it('rejects an unexpected body field with 400 without touching the bridge', async () => {
      const res = await request(buildApp()).post('/api/voice/facetime/call').send({ extra: 'nope' });
      expect(res.status).toBe(400);
      expect(facetimeBridge.call).not.toHaveBeenCalled();
    });
  });
});
