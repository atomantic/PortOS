import { recordingOperatorIo } from '../test/recordingOperatorIo.js';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
const { request } = await import('../lib/testHelper.js');

// Shrink the upload cap so an oversized clone body fits express.json's default limit.
vi.mock('../lib/uploadLimits.js', async (importActual) => ({ ...(await importActual()), MAX_BASE64_UPLOAD_BYTES: 8 }));
vi.mock('../services/voice/aukRuntime.js', () => ({ cancelAukSetup: vi.fn() }));
vi.mock('../services/voice/studio.js', () => ({ createStudioVoice: vi.fn(), assignStudioVoice: vi.fn() }));
vi.mock('../services/voice/realtimeRuntime.js', () => ({
  realtimeStatus: vi.fn(),
  ensureRealtimeSidecar: vi.fn(),
}));

// Mock all voice service modules before importing the router so the route
// file's top-level imports resolve to the mocks.
vi.mock('../services/voice/config.js', () => ({
  getVoiceConfig: vi.fn(),
  updateVoiceConfig: vi.fn(),
}));
vi.mock('../services/voice/channelAgent.js', async (importActual) => ({
  ...(await importActual()),
  getAgentVoiceConfig: vi.fn(),
}));
vi.mock('../services/voice/llm.js', async (importActual) => ({
  ...(await importActual()),
  readVoiceLlmResidency: vi.fn(),
}));
vi.mock('../services/voice/pipeline.js', () => ({ warmPromptPrefix: vi.fn() }));
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
vi.mock('../services/voice/profiles.js', async (importActual) => ({
  ...(await importActual()),
  listVoiceProfiles: vi.fn(),
  promotePresetProfile: vi.fn(),
  createVoiceDesignCandidate: vi.fn(),
  createClonedVoiceCandidate: vi.fn(),
  promoteVoiceProfile: vi.fn(),
  deleteVoiceProfile: vi.fn(),
}));
vi.mock('../services/voice/profileBenchmarks.js', () => ({
  renderProfileBenchmark: vi.fn(),
  benchmarkProfileInteractive: vi.fn(),
  completeProfileInteractiveBenchmark: vi.fn(),
}));
vi.mock('../services/voice/qwen3TtsRuntime.js', () => ({
  DEFAULT_DESIGN_MODEL: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign',
}));
vi.mock('../services/voice/fineTuning.js', () => ({
  startFineTuningJob: vi.fn(),
  listFineTuningJobs: vi.fn(),
  getFineTuningJobStatus: vi.fn(),
  cancelFineTuningJob: vi.fn(),
  promoteCheckpoint: vi.fn(),
}));
vi.mock('../services/voice/piper-voices.js', () => ({
  findPiperVoice: vi.fn(),
}));
vi.mock('../services/voice/facetimeBridge.js', () => ({
  checkSetup: vi.fn(),
  probe: vi.fn(),
  call: vi.fn(),
  hangup: vi.fn(),
}));

vi.mock('../services/voice/callSession.js', () => ({
  startCall: vi.fn(),
  endCall: vi.fn(),
  isCallActive: vi.fn(),
  getCallState: vi.fn(),
}));

const callSession = await import('../services/voice/callSession.js');
const config = await import('../services/voice/config.js');
const llm = await import('../services/voice/llm.js');
const channelAgent = await import('../services/voice/channelAgent.js');
const health = await import('../services/voice/health.js');
const pipeline = await import('../services/voice/pipeline.js');
const bootstrap = await import('../services/voice/bootstrap.js');
const tts = await import('../services/voice/tts.js');
const voiceProfiles = await import('../services/voice/profiles.js');
const profileBenchmarks = await import('../services/voice/profileBenchmarks.js');
const fineTuning = await import('../services/voice/fineTuning.js');
const { ServerError } = await import('../lib/errorHandler.js');
const piperVoices = await import('../services/voice/piper-voices.js');
const facetimeBridge = await import('../services/voice/facetimeBridge.js');
const { default: voiceRoutes } = await import('./voice.js');
const { hostControlRouteGate } = await import('../services/authGate.js');
const { errorEvents } = await import('../lib/errorHandler.js');

// Node's EventEmitter throws if 'error' is emitted with zero listeners.
// asyncHandler emits to errorEvents on every route failure, so swallow it
// here — assertions go through the HTTP response, not the emitter.
errorEvents.on('error', () => {});

const DEFAULT_CFG = {
  enabled: false,
  stt: { engine: 'web-speech', endpoint: 'http://127.0.0.1:5562' },
  tts: { engine: 'kokoro', rate: 1, kokoro: { modelId: 'kokoro-test', dtype: 'q8' } },
};

const buildApp = ({ io = recordingOperatorIo(() => {}) } = {}) => {
  const app = express();
  // A local caller on a password-free install holds host control, so PUT
  // /config reconciles (#13055); hostControlVoiceConfig.test.js covers the rest.
  app.use((req, _res, next) => { req.portosAuthContext = { enabled: false }; next(); });
  app.use(express.json());
  app.set('io', io);
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
    });

    it('promotes a preset with the current local model and delivery provenance', async () => {
      voiceProfiles.promotePresetProfile.mockResolvedValue({ id: 'voice-profile-1' });
      const res = await request(buildApp()).post('/api/voice/profiles/preset').send({
        universeId: 'uni-1', characterId: 'char-1', voiceId: 'piper:en_US-lessac-medium',
      });
      expect(res.status).toBe(201);
      expect(voiceProfiles.promotePresetProfile).toHaveBeenCalledWith(expect.objectContaining({
        modelRevision: 'piper:en_US-lessac-medium', delivery: { rate: 1 },
      }));
      expect(res.body).toEqual({ profile: { id: 'voice-profile-1' } });
    });

    it.each([
      ['piper:en_GB-jenny_dioco-medium', 'piper:en_GB-jenny_dioco-medium'],
      ['qwen3:warm-narrator', 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'],
      ['qwen3-tts:warm-narrator', 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign'],
    ])('preserves the model revision for %s preset promotion', async (voiceId, modelRevision) => {
      voiceProfiles.promotePresetProfile.mockResolvedValue({ id: 'voice-profile-1' });
      const res = await request(buildApp()).post('/api/voice/profiles/preset').send({
        universeId: 'uni-1', characterId: 'char-1', voiceId,
      });
      expect(res.status).toBe(201);
      expect(voiceProfiles.promotePresetProfile).toHaveBeenCalledWith(expect.objectContaining({
        modelRevision,
      }));
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

    it('rejects an oversized clone upload with 413 FILE_TOO_LARGE and a readable message', async () => {
      const res = await request(buildApp()).post('/api/voice/profiles/clone').send({
        universeId: 'uni-1',
        characterId: 'char-1',
        filename: 'reference.wav',
        audioBase64: Buffer.alloc(64).toString('base64'),
        transcript: 'sample transcript',
        performerConsentConfirmed: true,
      });
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
      expect(res.body.error).toMatch(/exceeds maximum size limit of 8 bytes/);
      expect(voiceProfiles.createClonedVoiceCandidate).not.toHaveBeenCalled();
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

    it('deletes a profile and returns only its id', async () => {
      voiceProfiles.deleteVoiceProfile.mockResolvedValue({ id: 'voice-clone-1' });
      const res = await request(buildApp()).delete('/api/voice/profiles/voice-clone-1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: true, id: 'voice-clone-1' });
      expect(voiceProfiles.deleteVoiceProfile).toHaveBeenCalledWith('voice-clone-1');
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
      profileBenchmarks.benchmarkProfileInteractive.mockResolvedValue({ benchmarkId: 'example-probe', audioBase64: 'fixture' });
      const res = await request(buildApp()).post('/api/voice/profiles/voice-profile-1/benchmark-interactive').send({
        maxFirstAudioMs: 800,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ benchmark: { benchmarkId: 'example-probe', audioBase64: 'fixture' } });
      expect(profileBenchmarks.benchmarkProfileInteractive).toHaveBeenCalledWith('voice-profile-1', { maxFirstAudioMs: 800 });
    });

    it('validates a playback receipt before completing interactive qualification', async () => {
      profileBenchmarks.completeProfileInteractiveBenchmark.mockResolvedValue({ id: 'voice-profile-1' });
      const receipt = { benchmarkId: '12345678-1234-4234-8234-123456789012', renderRequestLatencyMs: 150, playbackStartupMs: 50 };
      const res = await request(buildApp()).post('/api/voice/profiles/voice-profile-1/benchmark-interactive/complete').send(receipt);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ profile: { id: 'voice-profile-1' } });
      expect(profileBenchmarks.completeProfileInteractiveBenchmark).toHaveBeenCalledWith('voice-profile-1', receipt);
      const invalid = await request(buildApp()).post('/api/voice/profiles/voice-profile-1/benchmark-interactive/complete')
        .send({ ...receipt, playbackStartupMs: -1 });
      expect(invalid.status).toBe(400);
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
      // Cancel is scoped to the profile in the URL, like status and promote.
      expect(fineTuning.cancelFineTuningJob).toHaveBeenCalledWith(jobId, 'voice-profile-1');

      const promoteRes = await request(buildApp()).post(`/api/voice/profiles/voice-profile-1/fine-tune/${jobId}/promote`).send({ checkpointId: 'ckpt-1' });
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.body.profile.kind).toBe('fine-tuned');
    });

    it('lists a profile\'s fine-tuning jobs so the Voice Lab recovers them after a reload', async () => {
      const jobs = [{ id: '11111111-2222-4333-8444-555555555555', status: 'interrupted', checkpoints: [] }];
      fineTuning.listFineTuningJobs.mockResolvedValue(jobs);

      const res = await request(buildApp()).get('/api/voice/profiles/voice-profile-1/fine-tune');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ jobs });
      expect(fineTuning.listFineTuningJobs).toHaveBeenCalledWith('voice-profile-1');

      fineTuning.listFineTuningJobs.mockClear();
      const bad = await request(buildApp()).get('/api/voice/profiles/Not_A_Profile/fine-tune');
      expect(bad.status).toBe(400);
      expect(fineTuning.listFineTuningJobs).not.toHaveBeenCalled();
    });

    it('rejects a fine-tuning job id that could escape the profile directory', async () => {
      const res = await request(buildApp())
        .get('/api/voice/profiles/voice-profile-1/fine-tune/..%2F..%2Fother-profile');
      expect(res.status).toBe(400);
      expect(fineTuning.getFineTuningJobStatus).not.toHaveBeenCalled();
    });

  });

  describe('POST /api/voice/llm/preload', () => {
    it('starts the warm-up and answers without waiting for the load', async () => {
      let finish;
      pipeline.warmPromptPrefix.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const res = await request(buildApp()).post('/api/voice/llm/preload').send({});
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ preloading: true });
      await vi.waitFor(() => expect(pipeline.warmPromptPrefix).toHaveBeenCalledWith({ reason: 'pick' }));
      finish({ warmed: true });
    });

    it('answers even when the load fails, and refuses unknown body keys', async () => {
      pipeline.warmPromptPrefix.mockRejectedValue(new Error('model server offline'));
      expect((await request(buildApp()).post('/api/voice/llm/preload').send({})).status).toBe(202);
      expect((await request(buildApp()).post('/api/voice/llm/preload').send({ model: 'x' })).status).toBe(400);
    });
  });

  describe('GET /api/voice/llm/residency', () => {
    it('reports residency for the on-air channel\'s Voice LLM and refuses unknown query keys', async () => {
      channelAgent.getAgentVoiceConfig.mockResolvedValue({ ...DEFAULT_CFG, llm: { provider: 'ollama', model: 'model-a' } });
      llm.readVoiceLlmResidency.mockResolvedValue({ state: 'unloaded', runtime: 'ollama', model: 'model-a' });
      const res = await request(buildApp()).get('/api/voice/llm/residency');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ state: 'unloaded', runtime: 'ollama', model: 'model-a' });
      expect(llm.readVoiceLlmResidency).toHaveBeenCalledWith({ provider: 'ollama', model: 'model-a' });

      const bad = await request(buildApp()).get('/api/voice/llm/residency?model=other');
      expect(bad.status).toBe(400);
    });
  });

  describe('GET /api/voice/realtime/status host-control gate', () => {
    it('refuses remote password-free requests and allows local or operator-session requests', async () => {
      const runtime = await import('../services/voice/realtimeRuntime.js');
      runtime.realtimeStatus.mockReturnValue({
        home: '~/.portos/sophon-mac',
        size: '32B',
        parts: { python: false, engine: false, weights: false },
        installed: false,
        running: false,
      });
      const makeGatedApp = (authContext, remoteAddress) => {
        const app = express();
        app.use((req, _res, next) => {
          req.portosAuthContext = authContext;
          if (remoteAddress) Object.defineProperty(req.socket, 'remoteAddress', { value: remoteAddress, configurable: true });
          next();
        });
        app.use(hostControlRouteGate);
        app.use('/api/voice', voiceRoutes);
        return app;
      };

      const remote = await request(makeGatedApp({ enabled: false }, '192.0.2.10')).get('/api/voice/realtime/status');
      expect(remote.status).toBe(403);
      expect(remote.body.code).toBe('HOST_CONTROL_FORBIDDEN');
      expect(runtime.realtimeStatus).not.toHaveBeenCalled();

      const local = await request(makeGatedApp({ enabled: false }, '127.0.0.1')).get('/api/voice/realtime/status');
      expect(local.status).toBe(200);
      expect(local.body).toHaveProperty('installed');

      const operator = await request(makeGatedApp({ enabled: true, authenticated: true, method: 'session' }, '192.0.2.10')).get('/api/voice/realtime/status');
      expect(operator.status).toBe(200);
      expect(operator.body).toHaveProperty('installed');
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

    it('accepts a legacy trigger key by stripping it instead of returning 400', async () => {
      config.updateVoiceConfig.mockResolvedValue({ ...DEFAULT_CFG });
      bootstrap.reconcile.mockResolvedValue({ skipped: true });
      const res = await request(buildApp()).put('/api/voice/config').send({ trigger: 'hotword', enabled: true });
      expect(res.status).toBe(200);
      expect(config.updateVoiceConfig).toHaveBeenCalledWith({ enabled: true });
    });

    it('broadcasts personality on voice:config:changed, null when disabled', async () => {
      bootstrap.reconcile.mockResolvedValue({ skipped: true });
      const emit = vi.fn();
      const personality = { name: 'Example', speechStyle: 'calm' };
      config.updateVoiceConfig.mockResolvedValue({ ...DEFAULT_CFG, llm: { usePersonality: true, personality } });
      await request(buildApp({ io: recordingOperatorIo(emit) })).put('/api/voice/config').send({ enabled: true });
      expect(emit).toHaveBeenLastCalledWith('voice:config:changed', expect.objectContaining({ personality }));
      config.updateVoiceConfig.mockResolvedValue({ ...DEFAULT_CFG, llm: { usePersonality: false, personality } });
      await request(buildApp({ io: recordingOperatorIo(emit) })).put('/api/voice/config').send({ enabled: true });
      expect(emit).toHaveBeenLastCalledWith('voice:config:changed', expect.objectContaining({ personality: null }));
    });

    it('accepts Qwen3-TTS engine and voice configuration and resolves ttsVoice on voice:config:changed', async () => {
      const qwenCfg = {
        ...DEFAULT_CFG,
        tts: {
          engine: 'qwen3-tts',
          qwen3: { modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', voice: 'warm-narrator' },
        },
      };
      config.updateVoiceConfig.mockResolvedValue(qwenCfg);
      bootstrap.reconcile.mockResolvedValue({ skipped: true });
      const emit = vi.fn();
      const patch = {
        tts: {
          engine: 'qwen3-tts',
          qwen3: { modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', voice: 'warm-narrator' },
        },
      };

      const res = await request(buildApp({ io: recordingOperatorIo(emit) })).put('/api/voice/config').send(patch);

      expect(res.status).toBe(200);
      expect(config.updateVoiceConfig).toHaveBeenCalledWith(patch);
      expect(emit).toHaveBeenLastCalledWith('voice:config:changed', expect.objectContaining({
        ttsEngine: 'qwen3-tts',
        ttsVoice: 'warm-narrator',
      }));
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

    it.each([
      [true, {}, true],
      [true, { error: 'setup failed' }, false],
      [false, { skipped: true }, false],
    ])('clears retirement only after enabled successful reconciliation (%s, %j)', async (enabled, result, cleared) => {
      const migrated = { enabled, tts: { engine: 'piper', retiredEngine: 'kokoro' } };
      const settled = { enabled, tts: { engine: 'piper' } };
      config.updateVoiceConfig.mockReset();
      config.updateVoiceConfig.mockResolvedValueOnce(migrated).mockResolvedValueOnce(settled);
      bootstrap.reconcile.mockResolvedValue(result);
      const res = await request(buildApp()).put('/api/voice/config').send({ enabled });
      expect(res.status).toBe(200);
      expect(config.updateVoiceConfig).toHaveBeenCalledTimes(cleared ? 2 : 1);
      expect(res.body.config).toEqual(cleared ? settled : migrated);
      if (cleared) expect(config.updateVoiceConfig).toHaveBeenLastCalledWith({ tts: { retiredEngine: null } });
    });

    it.each([
      [true, 'whisper-server not on PATH'],
      [false, 'PM2 could not confirm that portos-whisper stopped. Check PM2 logs for portos-whisper and retry.'],
    ])('reports reconciliation failure after saving enabled=%s', async (enabled, error) => {
      config.updateVoiceConfig.mockReset().mockResolvedValue({ ...DEFAULT_CFG, enabled });
      bootstrap.reconcile.mockRejectedValue(new Error(error));

      const res = await request(buildApp())
        .put('/api/voice/config')
        .send({ enabled });
      expect(res.status).toBe(200);
      expect(res.body.config.enabled).toBe(enabled);
      expect(res.body.reconciliation).toEqual({ error });
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
  it('rejects a repeated query key with 400 (voices, #16428)', async () => {
    const res = await request(buildApp()).get('/api/voice/voices?engine=a&engine=b');
    expect(res.status).toBe(400);
  });

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
      expect(res.body.code).toBe('VALIDATION_ERROR');
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

  describe('POST /api/voice/whisper', () => {
    it('stops whisper and invalidates the health cache', async () => {
      const res = await request(buildApp()).post('/api/voice/whisper').send({ action: 'stop' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, action: 'stop' });
      expect(bootstrap.stopWhisper).toHaveBeenCalledTimes(1);
      expect(bootstrap.startWhisper).not.toHaveBeenCalled();
      expect(health.invalidateHealthCache).toHaveBeenCalled();
    });

    it('returns the actionable PM2 error when shutdown cannot be confirmed', async () => {
      const message = 'PM2 could not confirm that portos-whisper stopped. Check PM2 logs for portos-whisper and retry.';
      bootstrap.stopWhisper.mockRejectedValueOnce(new ServerError(message, {
        status: 503, code: 'WHISPER_STOP_FAILED',
      }));

      const res = await request(buildApp()).post('/api/voice/whisper').send({ action: 'stop' });
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: message, code: 'WHISPER_STOP_FAILED' });
      expect(res.body).not.toHaveProperty('success');
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

    it('POST /api/voice/facetime/probe dispatches to the bridge', async () => {
      facetimeBridge.probe.mockResolvedValue({ ok: true, command: 'probe' });
      const res = await request(buildApp()).post('/api/voice/facetime/probe').send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, command: 'probe' });
    });

    it('POST /api/voice/facetime/call starts a session-backed call', async () => {
      callSession.startCall.mockResolvedValue({ ok: true, state: { state: 'dialing' } });
      const res = await request(buildApp()).post('/api/voice/facetime/call').send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, command: 'call', state: { state: 'dialing' } });
      expect(callSession.startCall).toHaveBeenCalledWith({ origin: 'user' });
      expect(facetimeBridge.call).not.toHaveBeenCalled();
    });

    it.each([
      {
        reason: 'no-call-host',
        result: { ok: false, reason: 'no-call-host' },
        code: 'NO_CALL_HOST',
        error: 'No FaceTime call host tab is attached',
      },
      {
        reason: 'call-in-progress',
        result: { ok: false, reason: 'call-in-progress' },
        code: 'CALL_IN_PROGRESS',
        error: 'A FaceTime call is already in progress',
      },
      {
        reason: 'dial-failed',
        result: { ok: false, reason: 'dial-failed', message: 'FaceTime helper timed out' },
        code: 'DIAL_FAILED',
        error: 'FaceTime helper timed out',
      },
      {
        reason: 'dial-failed (fallback)',
        result: { ok: false, reason: 'dial-failed' },
        code: 'DIAL_FAILED',
        error: 'FaceTime dial failed',
      },
    ])('POST /api/voice/facetime/call returns standard 409 ServerError envelope on refusal $reason', async ({ result, code, error }) => {
      callSession.startCall.mockResolvedValue(result);
      const res = await request(buildApp()).post('/api/voice/facetime/call').send({});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error,
        code,
        timestamp: expect.any(Number),
        context: { command: 'call', reason: result.reason },
      });
    });

    it('POST /api/voice/facetime/hangup ends an active session call', async () => {
      callSession.isCallActive.mockReturnValue(true);
      callSession.endCall.mockResolvedValue({});
      callSession.getCallState.mockReturnValue({ state: 'idle' });
      const res = await request(buildApp()).post('/api/voice/facetime/hangup').send({});
      expect(res.status).toBe(200);
      expect(callSession.endCall).toHaveBeenCalledWith('user-hangup');
      expect(facetimeBridge.hangup).not.toHaveBeenCalled();
    });

    it('POST /api/voice/facetime/hangup falls back to the bridge when idle', async () => {
      callSession.isCallActive.mockReturnValue(false);
      facetimeBridge.hangup.mockResolvedValue({ ok: true, command: 'hangup' });
      const res = await request(buildApp()).post('/api/voice/facetime/hangup').send({});
      expect(res.body).toEqual({ ok: true, command: 'hangup' });
      expect(callSession.endCall).not.toHaveBeenCalled();
    });

    it('POST /api/voice/facetime/probe propagates a bridge failure as an error response', async () => {
      facetimeBridge.probe.mockRejectedValue(new ServerError('helper not installed', { status: 409 }));
      const res = await request(buildApp()).post('/api/voice/facetime/probe').send({});
      expect(res.status).toBe(409);
    });

    it('rejects an unexpected body field with 400 without touching the bridge', async () => {
      const res = await request(buildApp()).post('/api/voice/facetime/call').send({ extra: 'nope' });
      expect(res.status).toBe(400);
      expect(callSession.startCall).not.toHaveBeenCalled();
    });
  });
});

describe('Voice Studio HTTP contract', () => {
  it('returns the current runtime status after canceling setup', async () => {
    const { cancelAukSetup } = await import('../services/voice/aukRuntime.js');
    const status = { supported: true, ready: false, state: 'canceled', stage: 'Setup canceled', error: null };
    cancelAukSetup.mockResolvedValue(status);
    const result = await request(buildApp()).post('/api/voice/studio/setup/cancel').send({});
    expect(result.status).toBe(200);
    expect(result.body).toEqual(status);
    expect(cancelAukSetup).toHaveBeenCalledOnce();
  });
  it('validates controls before generation and emits only a payload-free invalidation after success', async () => {
    const { createStudioVoice } = await import('../services/voice/studio.js');
    const emit = vi.fn();
    const app = buildApp({ io: recordingOperatorIo(emit) });
    createStudioVoice.mockResolvedValue({ id: 'voice-example', label: 'Example voice' });
    const invalid = await request(app).post('/api/voice/studio/design').send({ label: 'Example', instructions: 'Alto', text: 'Hello', pitchSemitones: 99 });
    expect(invalid.status).toBe(400);
    expect(createStudioVoice).not.toHaveBeenCalled();
    const valid = await request(app).post('/api/voice/studio/design').send({ label: 'Example', instructions: 'Alto', text: 'Hello' });
    expect(valid.status).toBe(201);
    expect(emit).toHaveBeenCalledWith('voice-studio:changed', {});
  });
});

describe('GET /api/voice/realtime/status', () => {
  it('reports realtime install and running status without starting the sidecar', async () => {
    const runtime = await import('../services/voice/realtimeRuntime.js');
    config.getVoiceConfig.mockResolvedValue({
      ...DEFAULT_CFG,
      enabled: true,
      realtime: { enabled: true, home: '/tmp/sophon-mac', size: '4B' },
    });
    runtime.realtimeStatus.mockReturnValue({
      home: '/tmp/sophon-mac',
      size: '4B',
      parts: { python: true, engine: true, weights: true },
      installed: true,
      running: false,
    });

    const res = await request(buildApp()).get('/api/voice/realtime/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      voiceEnabled: true,
      home: '/tmp/sophon-mac',
      size: '4B',
      parts: { python: true, engine: true, weights: true },
      installed: true,
      running: false,
    });
    expect(runtime.realtimeStatus).toHaveBeenCalledWith({ enabled: true, home: '/tmp/sophon-mac', size: '4B' });
    expect(runtime.ensureRealtimeSidecar).not.toHaveBeenCalled();
  });

  it('surfaces voiceEnabled: false when top-level Voice mode is off', async () => {
    const runtime = await import('../services/voice/realtimeRuntime.js');
    config.getVoiceConfig.mockResolvedValue({ enabled: false, realtime: { enabled: true, size: '4B' } });
    runtime.realtimeStatus.mockReturnValue({
      home: '/models/sophon',
      size: '4B',
      parts: { python: true, engine: true, weights: true },
      installed: true,
      running: false,
    });
    const res = await request(buildApp()).get('/api/voice/realtime/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      enabled: true,
      voiceEnabled: false,
      home: '/models/sophon',
      size: '4B',
      parts: { python: true, engine: true, weights: true },
      installed: true,
      running: false,
    });
  });

  it('reports enabled: false when realtime is omitted from config', async () => {
    const runtime = await import('../services/voice/realtimeRuntime.js');
    config.getVoiceConfig.mockResolvedValue(DEFAULT_CFG);
    runtime.realtimeStatus.mockReturnValue({
      home: '/tmp/sophon-mac',
      size: '32B',
      parts: { python: false, engine: false, weights: false },
      installed: false,
      running: false,
    });

    const res = await request(buildApp()).get('/api/voice/realtime/status');

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.voiceEnabled).toBe(false);
    expect(res.body.installed).toBe(false);
    expect(runtime.ensureRealtimeSidecar).not.toHaveBeenCalled();
  });
});
