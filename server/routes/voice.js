/**
 * Voice Routes
 *
 * REST endpoints for voice configuration and local voice-stack health.
 * Actual audio streaming happens over Socket.IO (see server/sockets/voice.js).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { getVoiceConfig, updateVoiceConfig } from '../services/voice/config.js';
import { checkAll, invalidateHealthCache } from '../services/voice/health.js';
import { reconcile, verifyBinaries, verifyModels, downloadPiperVoice } from '../services/voice/bootstrap.js';
import { synthesize, listVoices } from '../services/voice/tts.js';
import { findPiperVoice } from '../services/voice/piper-voices.js';

const router = Router();

const VALID_TTS_ENGINES = new Set(['kokoro', 'piper']);
const validEngine = (v) => VALID_TTS_ENGINES.has(v) ? v : undefined;

// Partial schema — deepMerge fills in anything omitted, so every field is
// optional. The point here is to reject unknown engine values and obvious
// type mistakes, not to exhaustively re-spec the full config tree.
const voiceConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  trigger: z.enum(['push-to-talk', 'hotword', 'vad']).optional(),
  hotkey: z.string().max(32).optional(),
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
    engine: z.enum(['kokoro', 'piper']).optional(),
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
  }).partial().optional(),
  llm: z.object({
    provider: z.string().max(32).optional(),
    model: z.string().max(128).optional(),
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
    throw new ServerError(`Invalid voice config: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, 400);
  }
  const next = await updateVoiceConfig(parsed.data);
  invalidateHealthCache();
  const reconciliation = await reconcile(next).catch((err) => ({ error: err.message }));
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

// GET /api/voice/voices?engine=kokoro|piper — enumerate voices for the given
// engine (or the active one when unspecified). Query param lets the Settings
// page preview a different engine's voices without saving first.
router.get('/voices', asyncHandler(async (req, res) => {
  res.json(await listVoices(validEngine(req.query?.engine)));
}));

// POST /api/voice/piper/fetch — download a single Piper voice on demand.
// Validates against the curated catalog to keep shell interpolation safe.
router.post('/piper/fetch', asyncHandler(async (req, res) => {
  const voice = (req.body?.voice || '').toString();
  if (!findPiperVoice(voice)) {
    return res.status(400).json({ error: `unknown piper voice: ${voice}` });
  }
  const cfg = await getVoiceConfig();
  const result = await downloadPiperVoice(voice, cfg);
  res.json({ voice, ...result });
}));

// POST /api/voice/test — synthesize {text, voice?, engine?} and return WAV.
// `engine` override lets the Settings page preview a different engine's voice
// without saving first (e.g. flip to Piper, hit ▶, before clicking Save).
router.post('/test', asyncHandler(async (req, res) => {
  const text = (req.body?.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const voice = (req.body?.voice || '').toString().trim() || undefined;
  const engine = validEngine((req.body?.engine || '').toString().trim());
  const { wav, latencyMs } = await synthesize(text, { voice, engine });
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('X-TTS-Latency-Ms', String(latencyMs));
  res.send(wav);
}));

export default router;
