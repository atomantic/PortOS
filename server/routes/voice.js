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
import { reconcile, verifyBinaries, verifyModels } from '../services/voice/bootstrap.js';
import { synthesize, listVoices } from '../services/voice/tts.js';

const router = Router();

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

// GET /api/voice/voices — enumerate voices for the active TTS engine
router.get('/voices', asyncHandler(async (_req, res) => {
  res.json(await listVoices());
}));

// POST /api/voice/test — synthesize {text} and return WAV bytes
router.post('/test', asyncHandler(async (req, res) => {
  const text = (req.body?.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'text is required' });
  const { wav, latencyMs } = await synthesize(text);
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('X-TTS-Latency-Ms', String(latencyMs));
  res.send(wav);
}));

export default router;
