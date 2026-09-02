/**
 * Voice Routes
 *
 * REST endpoints for voice configuration, profiles, and local voice-stack health.
 * Actual audio streaming happens over Socket.IO (see server/sockets/voice.js).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { MAX_BASE64_UPLOAD_BYTES } from '../lib/uploadLimits.js';
import { getVoiceConfig, updateVoiceConfig } from '../services/voice/config.js';
import { checkAll, invalidateHealthCache } from '../services/voice/health.js';
import * as facetimeBridge from '../services/voice/facetimeBridge.js';
import { reconcile, verifyBinaries, verifyModels, downloadPiperVoice, startWhisper, stopWhisper } from '../services/voice/bootstrap.js';
import { synthesize, listVoices, listVoiceEngines, VALID_ENGINES } from '../services/voice/tts.js';
import {
  listVoiceProfiles,
  promotePresetProfile,
  createVoiceDesignCandidate,
  createClonedVoiceCandidate,
  promoteVoiceProfile,
} from '../services/voice/profiles.js';
import { renderProfileBenchmark, benchmarkProfileInteractive } from '../services/voice/profileBenchmarks.js';
import { getQwen3RuntimeStatus, downloadQwen3Model } from '../services/voice/qwen3TtsRuntime.js';
import {
  startFineTuningJob,
  getFineTuningJobStatus,
  cancelFineTuningJob,
  promoteCheckpoint,
} from '../services/voice/fineTuning.js';
import { readyState as kokoroReadyState, unloadKokoro, loadedModelKey as kokoroLoadedKey } from '../services/voice/tts-kokoro.js';
import { findPiperVoice } from '../services/voice/piper-voices.js';
import { speakProactive, HHMM_RE, MAX_PROACTIVE_TEXT_LEN } from '../services/voice/proactiveSpeech.js';

const router = Router();

const facetimeActionSchema = z.object({}).strict();

const validEngine = (v) => VALID_ENGINES.has(v) ? v : undefined;

const MAX_VOICE_TEXT_LEN = MAX_PROACTIVE_TEXT_LEN;

const voiceConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  trigger: z.enum(['push-to-talk', 'hotword', 'vad']).optional(),
  hotkey: z.string().max(32).optional(),
  facetime: z.object({
    maxCallMinutes: z.number().int().min(1).max(120).optional(),
    targetHandle: z.string().trim().max(254).refine((value) => value === '' || /^\+?[1-9]\d{6,14}$/.test(value) || z.string().email().safeParse(value).success, 'Must be an E.164 phone number or email address').optional(),
    targetName: z.string().trim().max(120).optional(),
    blackHole2chLabel: z.string().trim().min(1).max(120).optional(),
    blackHole16chLabel: z.string().trim().min(1).max(120).optional(),
    escalateCritical: z.boolean().optional(),
    escalateAfterMinutes: z.number().int().min(1).max(1440).optional(),
    autoAnswer: z.boolean().optional(),
  }).partial().optional(),
  stt: z.object({
    engine: z.enum(['whisper', 'web-speech']).optional(),
    endpoint: z.string().url().optional(),
    model: z.string().max(64).optional(),
    modelPath: z.string().max(512).optional(),
    language: z.string().max(16).optional(),
    coreml: z.boolean().optional(),
    vocabularyPrompt: z.string().max(4000).optional(),
  }).partial().optional(),
  tts: z.object({
    engine: z.enum(['kokoro', 'piper', 'qwen3-tts']).optional(),
    rate: z.number().min(0.25).max(4).optional(),
    kokoro: z.object({
      modelId: z.string().max(128).optional(),
      dtype: z.enum(['fp32', 'fp16', 'q8', 'q4', 'q4f16']).optional(),
      voice: z.string().max(64).optional(),
    }).partial().optional(),
    piper: z.object({
      voice: z.string().max(128).optional(),
      voicePath: z.string().max(512).optional(),
      speakerId: z.number().int().nullable().optional(),
    }).partial().optional(),
    qwen3: z.object({
      modelId: z.string().max(128).optional(),
      voice: z.string().max(128).optional(),
    }).partial().optional(),
  }).partial().optional(),
  llm: z.object({
    provider: z.string().max(80).optional(),
    model: z.string().max(128).optional(),
    visionModel: z.string().max(128).optional(),
    systemPrompt: z.string().max(4000).optional(),
    usePersonality: z.boolean().optional(),
    personality: z.object({
      name: z.string().max(64).optional(),
      role: z.string().max(128).optional(),
      traits: z.array(z.string().max(64)).max(20).optional(),
      speechStyle: z.string().max(256).optional(),
      customPrompt: z.string().max(2000).optional(),
    }).partial().optional(),
    tools: z.object({
      enabled: z.boolean().optional(),
      maxIterations: z.number().int().min(1).max(10).optional(),
    }).partial().optional(),
    codeAgent: z.object({
      enabled: z.boolean().optional(),
      provider: z.string().max(80).optional(),
      model: z.string().max(128).optional(),
      announceOnComplete: z.boolean().optional(),
    }).partial().optional(),
    proactive: z.object({
      enabled: z.boolean().optional(),
      quietHours: z.object({
        enabled: z.boolean().optional(),
        start: z.string().regex(HHMM_RE).optional(),
        end: z.string().regex(HHMM_RE).optional(),
      }).partial().optional(),
    }).partial().optional(),
    fastPath: z.object({
      enabled: z.boolean().optional(),
      triggers: z.boolean().optional(),
      browserLlm: z.boolean().optional(),
      browser: z.object({
        temperature: z.number().min(0).max(2).optional(),
        topK: z.number().int().min(1).max(128).optional(),
      }).partial().optional(),
    }).partial().optional(),
  }).partial().optional(),
  vad: z.object({
    endOfSpeechMs: z.number().int().min(100).max(5000).optional(),
    minUtteranceMs: z.number().int().min(50).max(5000).optional(),
  }).partial().optional(),
}).strict();

// GET /api/voice/config — current merged voice settings
router.get('/config', asyncHandler(async (_req, res) => {
  res.json(await getVoiceConfig());
}));

// PUT /api/voice/config — deep-merge patch, save, and reconcile PM2 state
router.put('/config', asyncHandler(async (req, res) => {
  const parsed = voiceConfigPatchSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ServerError(
      `Invalid voice config: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  const next = await updateVoiceConfig(parsed.data);
  invalidateHealthCache();
  const reconciliation = await reconcile(next).catch((err) => ({ error: err.message }));
  req.app.get('io')?.emit('voice:config:changed', {
    enabled: next.enabled,
    sttEngine: next.stt?.engine,
    sttLanguage: next.stt?.language,
    ttsEngine: next.tts?.engine,
    ttsVoice: next.tts?.[next.tts?.engine]?.voice,
    ttsRate: next.tts?.rate,
    hotkey: next.hotkey,
    fastPath: next.llm?.fastPath || null,
  });
  res.json({ config: next, reconciliation });
}));

// GET /api/voice/status — reachability + enabled flag + binary/model presence
router.get('/status', asyncHandler(async (_req, res) => {
  const cfg = await getVoiceConfig();
  const [services, bins] = await Promise.all([checkAll(cfg), verifyBinaries(cfg)]);
  const models = verifyModels(cfg);
  res.json({
    enabled: cfg.enabled,
    sttEngine: cfg.stt.engine,
    ttsEngine: cfg.tts.engine,
    services,
    binaries: bins,
    models,
  });
}));

router.get('/facetime/status', asyncHandler(async (_req, res) => {
  res.json(await facetimeBridge.checkSetup());
}));

for (const command of ['probe', 'call', 'hangup']) {
  router.post(`/facetime/${command}`, asyncHandler(async (req, res) => {
    validateRequest(facetimeActionSchema, req.body || {});
    res.json(await facetimeBridge[command]());
  }));
}

router.get('/voices', asyncHandler(async (req, res) => {
  res.json(await listVoices(validEngine(req.query?.engine)));
}));

const voiceProfileListSchema = z.object({
  universeId: z.string().trim().min(1).max(160).optional(),
  characterId: z.string().trim().min(1).max(160).optional(),
}).strict();

const promotePresetProfileSchema = z.object({
  universeId: z.string().trim().min(1).max(160),
  characterId: z.string().trim().min(1).max(160),
  characterName: z.string().trim().max(160).optional(),
  voiceId: z.string().trim().min(1).max(160),
}).strict();

const voiceDesignCandidateSchema = z.object({
  universeId: z.string().trim().min(1).max(160),
  characterId: z.string().trim().min(1).max(160),
  characterName: z.string().trim().max(160).optional(),
  instructions: z.string().trim().max(2000).optional(),
  seed: z.number().int().optional(),
  modelId: z.string().trim().max(160).optional(),
  rate: z.number().min(0.25).max(4).optional(),
}).strict();

const voiceCloneCandidateSchema = z.object({
  universeId: z.string().trim().min(1).max(160),
  characterId: z.string().trim().min(1).max(160),
  characterName: z.string().trim().max(160).optional(),
  filename: z.string().trim().min(1).max(160),
  audioBase64: z.string().min(1),
  transcript: z.string().trim().max(4000).optional(),
  performerConsentConfirmed: z.boolean(),
  licensePosture: z.string().trim().max(160).optional(),
  modelId: z.string().trim().max(160).optional(),
  rate: z.number().min(0.25).max(4).optional(),
}).strict();

const promoteProfileSchema = z.object({
  routes: z.object({
    studio: z.object({ enabled: z.boolean().optional() }).partial().optional(),
    interactive: z.object({
      enabled: z.boolean().optional(),
      maxFirstAudioMs: z.number().min(50).max(5000).optional(),
    }).partial().optional(),
  }).partial().optional(),
}).strict();

const interactiveBenchmarkSchema = z.object({
  maxFirstAudioMs: z.number().min(50).max(5000).optional(),
}).strict();

const fineTuneStartSchema = z.object({
  epochs: z.number().int().min(1).max(50).optional(),
  checkpointInterval: z.number().int().min(10).max(500).optional(),
  baseModel: z.string().trim().max(160).optional(),
}).strict();

const fineTuneJobParamsSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  // Job ids are minted with randomUUID and are joined into a filesystem path
  // when the run is resolved from its on-disk record, so anything that could
  // carry a separator or `..` is rejected here.
  jobId: z.string().trim().uuid(),
}).strict();

const fineTunePromoteSchema = z.object({
  checkpointId: z.string().trim().min(1).max(160),
}).strict();

const downloadModelSchema = z.object({
  modelId: z.string().trim().min(1).max(160),
}).strict();

const profileIdParamsSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
}).strict();

// GET /api/voice/engines
router.get('/engines', asyncHandler(async (_req, res) => {
  res.json({ engines: await listVoiceEngines() });
}));

// GET /api/voice/profiles
router.get('/profiles', asyncHandler(async (req, res) => {
  const filters = validateRequest(voiceProfileListSchema, req.query || {});
  res.json({ profiles: await listVoiceProfiles(filters) });
}));

// POST /api/voice/profiles/preset
router.post('/profiles/preset', asyncHandler(async (req, res) => {
  const body = validateRequest(promotePresetProfileSchema, req.body || {});
  const cfg = await getVoiceConfig();
  const profile = await promotePresetProfile({
    ...body,
    modelRevision: /^kokoro:/i.test(body.voiceId)
      ? `${cfg.tts.kokoro?.modelId || 'configured'}:${cfg.tts.kokoro?.dtype || 'configured'}`
      : `piper:${body.voiceId.slice('piper:'.length)}`,
    delivery: { rate: cfg.tts?.rate },
  });
  res.status(201).json({ profile });
}));

// POST /api/voice/profiles/design — create voice design candidate profile
router.post('/profiles/design', asyncHandler(async (req, res) => {
  const body = validateRequest(voiceDesignCandidateSchema, req.body || {});
  const profile = await createVoiceDesignCandidate(body);
  res.status(201).json({ profile });
}));

// POST /api/voice/profiles/clone — create consented clone candidate profile
router.post('/profiles/clone', asyncHandler(async (req, res) => {
  const body = validateRequest(voiceCloneCandidateSchema, req.body || {});
  const audioBuffer = Buffer.from(body.audioBase64, 'base64');
  if (audioBuffer.length > MAX_BASE64_UPLOAD_BYTES) {
    throw new ServerError('FILE_TOO_LARGE', `Audio file exceeds maximum size limit of ${MAX_BASE64_UPLOAD_BYTES} bytes`);
  }
  const profile = await createClonedVoiceCandidate({
    ...body,
    audioBuffer,
  });
  res.status(201).json({ profile });
}));

// POST /api/voice/profiles/:id/promote — explicitly promote candidate profile
router.post('/profiles/:id/promote', asyncHandler(async (req, res) => {
  const { id: profileId } = validateRequest(profileIdParamsSchema, req.params);
  const body = validateRequest(promoteProfileSchema, req.body || {});
  const profile = await promoteVoiceProfile(profileId, body);
  res.json({ profile });
}));

// POST /api/voice/profiles/:id/benchmark
router.post('/profiles/:id/benchmark', asyncHandler(async (req, res) => {
  const { id: profileId } = validateRequest(profileIdParamsSchema, req.params);
  const profile = await renderProfileBenchmark(profileId);
  res.json({ profile });
}));

// POST /api/voice/profiles/:id/benchmark-interactive — qualify interactive route
router.post('/profiles/:id/benchmark-interactive', asyncHandler(async (req, res) => {
  const { id: profileId } = validateRequest(profileIdParamsSchema, req.params);
  const body = validateRequest(interactiveBenchmarkSchema, req.body || {});
  const profile = await benchmarkProfileInteractive(profileId, body);
  res.json({ profile });
}));

// Fine-tuning endpoints
router.post('/profiles/:id/fine-tune/start', asyncHandler(async (req, res) => {
  const { id: profileId } = validateRequest(profileIdParamsSchema, req.params);
  const body = validateRequest(fineTuneStartSchema, req.body || {});
  const result = await startFineTuningJob({ profileId, ...body });
  res.status(202).json(result);
}));

router.get('/profiles/:id/fine-tune/:jobId', asyncHandler(async (req, res) => {
  const { id: profileId, jobId } = validateRequest(fineTuneJobParamsSchema, req.params);
  const result = await getFineTuningJobStatus(jobId, profileId);
  res.json(result);
}));

router.post('/profiles/:id/fine-tune/:jobId/cancel', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(fineTuneJobParamsSchema, req.params);
  const result = cancelFineTuningJob(jobId);
  res.json(result);
}));

router.post('/profiles/:id/fine-tune/:jobId/promote', asyncHandler(async (req, res) => {
  const { id: profileId, jobId } = validateRequest(fineTuneJobParamsSchema, req.params);
  const body = validateRequest(fineTunePromoteSchema, req.body || {});
  const profile = await promoteCheckpoint({
    profileId,
    jobId,
    checkpointId: body.checkpointId,
  });
  res.json({ profile });
}));

// Qwen3 runtime status and model management
router.get('/qwen3/status', asyncHandler(async (_req, res) => {
  res.json(await getQwen3RuntimeStatus());
}));

router.post('/qwen3/download-model', asyncHandler(async (req, res) => {
  const body = validateRequest(downloadModelSchema, req.body || {});
  const result = await downloadQwen3Model(body.modelId);
  res.json(result);
}));

// POST /api/voice/piper/fetch
router.post('/piper/fetch', asyncHandler(async (req, res) => {
  const voice = (req.body?.voice || '').toString();
  if (!findPiperVoice(voice)) {
    throw new ServerError(`unknown piper voice: ${voice}`, { status: 400 });
  }
  const cfg = await getVoiceConfig();
  const result = await downloadPiperVoice(voice, cfg);
  res.json({ voice, ...result });
}));

// POST /api/voice/test
router.post('/test', asyncHandler(async (req, res) => {
  const text = (req.body?.text || '').toString().trim();
  if (!text) throw new ServerError('text is required', { status: 400 });
  if (text.length > MAX_VOICE_TEXT_LEN) {
    throw new ServerError(`text too long (${text.length} > ${MAX_VOICE_TEXT_LEN} chars)`, { status: 400 });
  }
  const voice = (req.body?.voice || '').toString().trim() || undefined;
  const engine = validEngine((req.body?.engine || '').toString().trim());
  const { wav, latencyMs } = await synthesize(text, { voice, engine });
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('X-TTS-Latency-Ms', String(latencyMs));
  res.send(wav);
}));

const speakBodySchema = z.object({
  text: z.string().trim().min(1).max(MAX_VOICE_TEXT_LEN),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  source: z.string().max(64).optional()
    .transform((s) => {
      const t = (s ?? '').trim();
      return t === '' ? undefined : t;
    }),
});
router.post('/speak', asyncHandler(async (req, res) => {
  const parsed = speakBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ServerError(
      `Invalid speak payload: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  const io = req.app.get('io');
  if (!io) {
    throw new ServerError(
      'voice subsystem misconfigured: io not attached',
      { status: 500, code: 'VOICE_IO_UNAVAILABLE' },
    );
  }
  const result = await speakProactive({ io, ...parsed.data });
  res.json(result);
}));

// GET /api/voice/tts/status
router.get('/tts/status', asyncHandler(async (_req, res) => {
  res.json({
    kokoro: {
      state: kokoroReadyState(),
      loadedKey: kokoroLoadedKey(),
    },
  });
}));

// POST /api/voice/tts/unload
router.post('/tts/unload', asyncHandler(async (_req, res) => {
  res.json(unloadKokoro());
}));

const whisperActionSchema = z.object({
  action: z.enum(['start', 'stop']),
});
router.post('/whisper', asyncHandler(async (req, res) => {
  const parsed = whisperActionSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ServerError(
      `Invalid whisper payload: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  const { action } = parsed.data;
  if (action === 'stop') {
    await stopWhisper();
    invalidateHealthCache();
    return res.json({ success: true, action: 'stop' });
  }
  const cfg = await getVoiceConfig();
  const result = await startWhisper(cfg);
  invalidateHealthCache();
  res.json({ success: true, action: 'start', ...result });
}));

export default router;
