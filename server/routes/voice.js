import { emitToOperatorsOn } from '../services/socketIo.js';
import * as callSession from '../services/voice/callSession.js';
import { voiceObservation } from '../services/localModelObservations.js';
import { observeModelMutations } from '../services/modelObservation.js';
import { emptyQuerySchema, voiceEngineQuerySchema } from '../lib/queryValidation.js';
/**
 * Voice Routes
 *
 * REST endpoints for voice configuration, profiles, and local voice-stack health.
 * Actual audio streaming happens over Socket.IO (see server/sockets/voice.js).
 */

import { Router } from 'express';
import voiceAvatarRoutes from './voiceAvatar.js';
import { TTS_ENGINE_CONFIG_KEYS } from '../lib/voiceEngines.js';
import {
  voicePiperFetchBodySchema,
  facetimeActionSchema,
  voiceConfigPatchSchema,
  voiceProfileListSchema,
  promotePresetProfileSchema,
  voiceDesignCandidateSchema,
  voiceCloneCandidateSchema,
  promoteProfileSchema,
  interactiveBenchmarkSchema,
  interactivePlaybackReceiptSchema,
  fineTuneStartSchema,
  fineTuneJobParamsSchema,
  fineTunePromoteSchema,
  profileIdParamsSchema,
  studioDesignSchema,
  studioAssignmentSchema,
  voiceTestBodySchema,
  whisperActionSchema,
  voiceStudioProfilesQuerySchema,
} from '../lib/voiceValidation.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { MAX_BASE64_UPLOAD_BYTES } from '../lib/uploadLimits.js';
import { getVoiceConfig, updateVoiceConfig } from '../services/voice/config.js';
import { invalidateHealthCache } from '../services/voice/health.js';
import { readVoiceLlmResidency } from '../services/voice/llm.js';
import * as facetimeBridge from '../services/voice/facetimeBridge.js';
import { reconcile, downloadPiperVoice, startWhisper, stopWhisper } from '../services/voice/bootstrap.js';
import { synthesize, listVoices, listVoiceEngines, VALID_ENGINES } from '../services/voice/tts.js';
import {
  listVoiceProfiles,
  listStudioProfiles,
  getVoiceProfileRequired,
  parsePresetVoiceId,
  promotePresetProfile,
  createVoiceDesignCandidate,
  createClonedVoiceCandidate,
  promoteVoiceProfile,
  deleteVoiceProfile,
} from '../services/voice/profiles.js';
import { renderProfileBenchmark, benchmarkProfileInteractive, completeProfileInteractiveBenchmark } from '../services/voice/profileBenchmarks.js';
import { DEFAULT_DESIGN_MODEL } from '../services/voice/qwen3TtsRuntime.js';
import {
  startFineTuningJob,
  listFineTuningJobs,
  getFineTuningJobStatus,
  cancelFineTuningJob,
  promoteCheckpoint,
} from '../services/voice/fineTuning.js';
import { findPiperVoice } from '../services/voice/piper-voices.js';

const router = Router();
router.use('/avatar', voiceAvatarRoutes);
router.use(observeModelMutations('voice-readiness'));

const validEngine = (v) => VALID_ENGINES.has(v) ? v : undefined;

// Older clients/configs still send `trigger`; it was never read, so drop it
// before .strict() validation instead of 400ing them.
const stripLegacyTrigger = (body) => {
  if (!body || typeof body !== 'object' || !('trigger' in body)) return body;
  const { trigger: _trigger, ...rest } = body;
  return rest;
};

// GET /api/voice/config — current merged voice settings
router.get('/config', asyncHandler(async (_req, res) => {
  res.json(await getVoiceConfig());
}));

// PUT /api/voice/config — deep-merge patch, save, and reconcile PM2 state
router.put('/config', asyncHandler(async (req, res) => {
  const parsed = voiceConfigPatchSchema.safeParse(stripLegacyTrigger(req.body) || {});
  if (!parsed.success) {
    throw new ServerError(
      `Invalid voice config: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  let next = await updateVoiceConfig(parsed.data);
  invalidateHealthCache();
  // Reconcile starts/stops whisper-server under PM2 and can run the setup
  // script, so it is host work (#13055); hostControlRouteGate (#16018) admits
  // only a caller with host control to this write.
  const reconciliation = await reconcile(next).catch((err) => ({ error: err.message }));
  if (next.enabled && next.tts?.retiredEngine && !reconciliation?.skipped && !reconciliation?.error && !reconciliation?.setupRequired) {
    next = await updateVoiceConfig({ tts: { retiredEngine: null } });
  }
  emitToOperatorsOn(req.app.get('io'), 'voice:config:changed', {
    enabled: next.enabled,
    sttEngine: next.stt?.engine,
    sttLanguage: next.stt?.language,
    ttsEngine: next.tts?.engine,
    ttsVoice: next.tts?.[TTS_ENGINE_CONFIG_KEYS[next.tts?.engine] ?? next.tts?.engine]?.voice,
    ttsRate: next.tts?.rate,
    hotkey: next.hotkey,
    vad: { endOfSpeechMs: next.vad?.endOfSpeechMs, minUtteranceMs: next.vad?.minUtteranceMs },
    fastPath: next.llm?.fastPath || null,
    personality: next.llm?.usePersonality === false ? null : (next.llm?.personality || null),
    llmProvider: next.llm?.provider,
    llmModel: next.llm?.model,
  });
  res.json({ config: next, reconciliation });
}));

// GET /api/voice/status — reachability + enabled flag + binary/model presence
router.get('/status', asyncHandler(async (_req, res) => {
  res.json(await voiceObservation.read());
}));

// GET /api/voice/llm/residency — is the saved Voice LLM resident in memory? Read-only; never loads it.
router.get('/llm/residency', asyncHandler(async (req, res) => {
  validateRequest(emptyQuerySchema, req.query);
  const { llm } = await getVoiceConfig();
  res.json(await readVoiceLlmResidency({ provider: llm?.provider, model: llm?.model }));
}));

router.get('/facetime/status', asyncHandler(async (_req, res) => {
  res.json(await facetimeBridge.checkSetup());
}));

router.post('/facetime/probe', asyncHandler(async (req, res) => {
  validateRequest(facetimeActionSchema, req.body || {});
  res.json(await facetimeBridge.probe());
}));

const FACETIME_CALL_REFUSALS = {
  'no-call-host': { code: 'NO_CALL_HOST', message: 'No FaceTime call host tab is attached' },
  'call-in-progress': { code: 'CALL_IN_PROGRESS', message: 'A FaceTime call is already in progress' },
  'dial-failed': { code: 'DIAL_FAILED', message: 'FaceTime dial failed' },
};

// Call/hangup go through callSession so the attached Call Host's PCM frames are
// accepted (sockets/voice.js drops frames while the session is idle) and
// transcript journaling stays in sync with the FaceTime window.
router.post('/facetime/call', asyncHandler(async (req, res) => {
  validateRequest(facetimeActionSchema, req.body || {});
  const result = await callSession.startCall({ origin: 'user' });
  if (!result.ok) {
    const mapped = FACETIME_CALL_REFUSALS[result.reason];
    throw new ServerError(result.message || mapped?.message || 'FaceTime call refused', {
      status: 409,
      code: mapped?.code || 'FACETIME_CALL_REFUSED',
      context: { command: 'call', reason: result.reason },
    });
  }
  res.json({ ok: true, command: 'call', state: result.state });
}));

router.post('/facetime/hangup', asyncHandler(async (req, res) => {
  validateRequest(facetimeActionSchema, req.body || {});
  if (callSession.isCallActive()) {
    await callSession.endCall('user-hangup');
    return res.json({ ok: true, command: 'hangup', state: callSession.getCallState() });
  }
  // Idle: still hang up so an orphaned FaceTime window can be closed.
  res.json(await facetimeBridge.hangup());
}));

router.get('/voices', asyncHandler(async (req, res) => {
  res.json(await listVoices(validEngine(validateRequest(voiceEngineQuerySchema, req.query).engine)));
}));

const notifyStudio = req => emitToOperatorsOn(req.app.get('io'), 'voice-studio:changed', {});
// Include legacy character-editor mutations so an open library stays current.
router.use('/profiles', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') res.once('finish', () => {
    if (res.statusCode < 400) notifyStudio(req);
  });
  next();
});

router.get('/studio/profiles', asyncHandler(async (req, res) => {
  const filters = validateRequest(voiceStudioProfilesQuerySchema, req.query);
  res.json(await listStudioProfiles(filters));
}));
router.get('/profiles/:id', asyncHandler(async (req, res) => {
  const { id } = validateRequest(profileIdParamsSchema, req.params);
  res.json({ profile: await getVoiceProfileRequired(id) });
}));
router.get('/studio/status', asyncHandler(async (_req, res) => {
  const { getAukStatus } = await import('../services/voice/aukRuntime.js');
  res.json(await getAukStatus());
}));
router.post('/studio/setup', asyncHandler(async (req, res) => {
  validateRequest(facetimeActionSchema, req.body || {});
  const { startAukSetup } = await import('../services/voice/aukRuntime.js');
  res.status(202).json(startAukSetup(() => notifyStudio(req)));
}));
router.post('/studio/setup/cancel', asyncHandler(async (req, res) => {
  validateRequest(facetimeActionSchema, req.body || {});
  const { cancelAukSetup } = await import('../services/voice/aukRuntime.js');
  res.json(await cancelAukSetup());
}));
router.post('/studio/unload', asyncHandler(async (req, res) => {
  validateRequest(facetimeActionSchema, req.body || {});
  const { unloadAuk } = await import('../services/voice/aukRuntime.js');
  unloadAuk();
  notifyStudio(req);
  res.json({ ok: true });
}));
router.post('/studio/design', asyncHandler(async (req, res) => {
  const body = validateRequest(studioDesignSchema, req.body || {});
  const { createStudioVoice } = await import('../services/voice/studio.js');
  const profile = await createStudioVoice(body);
  notifyStudio(req);
  res.status(201).json({ profile });
}));
router.post('/profiles/:id/assign', asyncHandler(async (req, res) => {
  const { id } = validateRequest(profileIdParamsSchema, req.params);
  const body = validateRequest(studioAssignmentSchema, req.body || {});
  const { assignStudioVoice } = await import('../services/voice/studio.js');
  const profile = await assignStudioVoice(id, body);
  res.json({ profile });
}));

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
  const preset = parsePresetVoiceId(body.voiceId);
  if (preset?.engine === 'kokoro') {
    throw new ServerError('Kokoro has been retired. Select a Piper preset to create a voice profile.', {
      status: 409, code: 'VOICE_ENGINE_RETIRED',
    });
  }
  const modelRevision = preset?.engine === 'qwen3-tts' ? DEFAULT_DESIGN_MODEL : `piper:${preset?.voice || ''}`;
  const profile = await promotePresetProfile({
    ...body,
    modelRevision,
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
    throw new ServerError(`Audio file exceeds maximum size limit of ${MAX_BASE64_UPLOAD_BYTES} bytes`, { status: 413, code: 'FILE_TOO_LARGE' });
  }
  const profile = await createClonedVoiceCandidate({
    ...body,
    audioBuffer,
  });
  res.status(201).json({ profile });
}));

// DELETE /api/voice/profiles/:id — withdraw consent: remove row, transcript and source recording
router.delete('/profiles/:id', asyncHandler(async (req, res) => {
  const { id: profileId } = validateRequest(profileIdParamsSchema, req.params);
  const result = await deleteVoiceProfile(profileId);
  res.json({ deleted: true, id: result.id });
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
  const benchmark = await benchmarkProfileInteractive(profileId, body);
  res.json({ benchmark });
}));

router.post('/profiles/:id/benchmark-interactive/complete', asyncHandler(async (req, res) => {
  const { id: profileId } = validateRequest(profileIdParamsSchema, req.params);
  const body = validateRequest(interactivePlaybackReceiptSchema, req.body || {});
  const profile = await completeProfileInteractiveBenchmark(profileId, body);
  res.json({ profile });
}));

// Fine-tuning endpoints
router.post('/profiles/:id/fine-tune/start', asyncHandler(async (req, res) => {
  const { id: profileId } = validateRequest(profileIdParamsSchema, req.params);
  const body = validateRequest(fineTuneStartSchema, req.body || {});
  const result = await startFineTuningJob({ profileId, ...body });
  res.status(202).json(result);
}));

// Newest-first runs from their job.json sidecars, so the Voice Lab recovers a
// run (and its checkpoints) after a reload; live changes arrive on
// `voice:fine-tune:updated`.
router.get('/profiles/:id/fine-tune', asyncHandler(async (req, res) => {
  const { id: profileId } = validateRequest(profileIdParamsSchema, req.params);
  res.json({ jobs: await listFineTuningJobs(profileId) });
}));

router.get('/profiles/:id/fine-tune/:jobId', asyncHandler(async (req, res) => {
  const { id: profileId, jobId } = validateRequest(fineTuneJobParamsSchema, req.params);
  const result = await getFineTuningJobStatus(jobId, profileId);
  res.json(result);
}));

router.post('/profiles/:id/fine-tune/:jobId/cancel', asyncHandler(async (req, res) => {
  const { id: profileId, jobId } = validateRequest(fineTuneJobParamsSchema, req.params);
  const result = cancelFineTuningJob(jobId, profileId);
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

// POST /api/voice/piper/fetch
router.post('/piper/fetch', asyncHandler(async (req, res) => {
  const { voice } = validateRequest(voicePiperFetchBodySchema, req.body ?? {});
  if (!findPiperVoice(voice)) {
    throw new ServerError(`unknown piper voice: ${voice}`, { status: 400 });
  }
  const cfg = await getVoiceConfig();
  const result = await downloadPiperVoice(voice, cfg);
  res.json({ voice, ...result });
}));

// POST /api/voice/test
router.post('/test', asyncHandler(async (req, res) => {
  const { text, voice: requestedVoice, engine: requestedEngine } = validateRequest(voiceTestBodySchema, req.body ?? {});
  const voice = requestedVoice || undefined;
  const engine = validEngine(requestedEngine);
  const { wav, latencyMs } = await synthesize(text, { voice, engine });
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('X-TTS-Latency-Ms', String(latencyMs));
  res.send(wav);
}));

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
