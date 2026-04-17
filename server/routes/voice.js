/**
 * Voice Routes
 *
 * REST endpoints for voice configuration and local voice-stack health.
 * Actual audio streaming happens over Socket.IO (see server/sockets/voice.js).
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getVoiceConfig, updateVoiceConfig } from '../services/voice/config.js';
import { checkAll, invalidateHealthCache } from '../services/voice/health.js';
import { reconcile, verifyBinaries, verifyModels, downloadPiperVoice } from '../services/voice/bootstrap.js';
import { synthesize, listVoices } from '../services/voice/tts.js';
import { findPiperVoice } from '../services/voice/piper-voices.js';

const router = Router();

const VALID_TTS_ENGINES = new Set(['kokoro', 'piper']);
const validEngine = (v) => VALID_TTS_ENGINES.has(v) ? v : undefined;

// GET /api/voice/config — current merged voice settings
router.get('/config', asyncHandler(async (_req, res) => {
  res.json(await getVoiceConfig());
}));

// PUT /api/voice/config — deep-merge patch, save, and reconcile PM2 state
router.put('/config', asyncHandler(async (req, res) => {
  const next = await updateVoiceConfig(req.body || {});
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
