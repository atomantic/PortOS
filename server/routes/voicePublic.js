/**
 * Public Voice / TTS API.
 *
 * A deliberately-minimal, externally-callable surface mounted at
 * `/api/voice/public/*`. When the PortOS password is on, `authGate` re-opens
 * THIS prefix (and only this prefix) for callers without a session, gated by
 * the `apiAccess.voice` settings (see server/lib/apiRegistry.js). Default is
 * not-exposed + passwordless-once-exposed.
 *
 * SECURITY: this router contains ONLY read/compute operations — text→audio
 * synthesis and voice/engine enumeration. It has NO config mutation, NO process
 * control, NO PUT. The full `/api/voice/*` router (config, whisper, unload,
 * speak) stays fully gated and is never part of the public registry. Keeping
 * the public surface on its own mount means it can't accidentally grow when a
 * new route is added to the main voice router.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { synthesize, listVoices, VALID_ENGINES } from '../services/voice/tts.js';
import { getVoiceConfig } from '../services/voice/config.js';
import { MAX_PROACTIVE_TEXT_LEN } from '../services/voice/proactiveSpeech.js';

const router = Router();

// Shared cap with the in-process function boundary (proactiveSpeech) and the
// internal /api/voice/test route — imported so the three can't drift.
const MAX_VOICE_TEXT_LEN = MAX_PROACTIVE_TEXT_LEN;

const validEngine = (v) => (VALID_ENGINES.has(v) ? v : undefined);

// .strict() rejects unknown keys so a typo'd field (e.g. "voiceId") fails loudly
// rather than being silently ignored. `text` is trimmed before the length check
// so whitespace-only payloads 400 instead of synthesizing empty audio.
// Exported so server/lib/openapiSpec.js can assert its (light) copy stays in
// sync — see openapiSpec.test.js's parity test.
export const synthesizeBodySchema = z.object({
  text: z.string().trim().min(1).max(MAX_VOICE_TEXT_LEN),
  engine: z.enum(['kokoro', 'piper']).optional(),
  voice: z.string().max(128).optional(),
  rate: z.number().min(0.25).max(4).optional(),
}).strict();

// POST /api/voice/public/synthesize — body { text, engine?, voice?, rate? } → WAV.
// Mirrors /api/voice/test but is the external-facing surface. `synthesize()`
// validates the voice id against the curated catalog (throws 400 UNKNOWN_VOICE),
// so a bad voice can't silently produce the wrong audio.
router.post('/synthesize', asyncHandler(async (req, res) => {
  const parsed = synthesizeBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ServerError(
      `Invalid synthesize payload: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  const { text, engine, voice, rate } = parsed.data;
  const { wav, latencyMs, engine: usedEngine } = await synthesize(text, {
    voice: voice || undefined,
    engine: validEngine(engine),
    rate,
  });
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('X-TTS-Latency-Ms', String(latencyMs));
  res.setHeader('X-TTS-Engine', usedEngine);
  res.send(wav);
}));

// GET /api/voice/public/voices?engine=kokoro|piper — enumerate available voices
// for the given engine (or the configured default when unspecified).
router.get('/voices', asyncHandler(async (req, res) => {
  res.json(await listVoices(validEngine(req.query?.engine)));
}));

// GET /api/voice/public/engines — discover the available engines + the
// configured default voice per engine, so an external caller can build a
// request without first listing every voice.
router.get('/engines', asyncHandler(async (_req, res) => {
  const cfg = await getVoiceConfig();
  res.json({
    engines: [...VALID_ENGINES],
    active: cfg.tts?.engine,
    defaults: {
      kokoro: cfg.tts?.kokoro?.voice,
      piper: cfg.tts?.piper?.voice,
    },
  });
}));

export default router;
