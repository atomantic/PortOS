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
import { reconcile, verifyBinaries, verifyModels, downloadPiperVoice, startWhisper, stopWhisper } from '../services/voice/bootstrap.js';
import { synthesize, listVoices, VALID_ENGINES } from '../services/voice/tts.js';
import { readyState as kokoroReadyState, unloadKokoro, loadedModelKey as kokoroLoadedKey } from '../services/voice/tts-kokoro.js';
import { findPiperVoice } from '../services/voice/piper-voices.js';
import { speakProactive, HHMM_RE, MAX_PROACTIVE_TEXT_LEN } from '../services/voice/proactiveSpeech.js';

const router = Router();

const validEngine = (v) => VALID_ENGINES.has(v) ? v : undefined;

// Shared cap for every REST endpoint that turns a text payload into TTS
// audio (/test and /speak). Imported from proactiveSpeech.js so the
// HTTP-layer cap and the function-boundary cap can't drift apart — if
// someone bumps the proactive limit, the route cap moves with it. Both
// caps exist on purpose: route-level for early rejection (no synthesis
// work wasted), function-level as defense in depth for direct in-process
// callers (CoS, scheduler) that bypass the route.
const MAX_VOICE_TEXT_LEN = MAX_PROACTIVE_TEXT_LEN;

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
    // 80 matches the provider-registry id cap (providerSchema.id in
    // aiToolkit/validation.js) — a shorter cap here would reject a valid
    // custom provider the voice picker happily lets the user select.
    provider: z.string().max(80).optional(),
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
    // Code-agent delegation. provider/model default to '' (= system default);
    // tolerate the UI's empty-string sentinel rather than forcing undefined.
    // 80-char provider cap matches the provider-registry id cap (same as the
    // llm.provider field above).
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
  // Notify connected clients (VoiceWidget, etc.) so they can refresh the
  // enabled flag / STT engine without a page reload when Settings saves.
  req.app.get('io')?.emit('voice:config:changed', {
    enabled: next.enabled,
    sttEngine: next.stt?.engine,
    sttLanguage: next.stt?.language,
    ttsEngine: next.tts?.engine,
    hotkey: next.hotkey,
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
  if (text.length > MAX_VOICE_TEXT_LEN) {
    return res.status(400).json({ error: `text too long (${text.length} > ${MAX_VOICE_TEXT_LEN} chars)` });
  }
  const voice = (req.body?.voice || '').toString().trim() || undefined;
  const engine = validEngine((req.body?.engine || '').toString().trim());
  // synthesize() throws a ServerError(`status: 400, code: 'UNKNOWN_VOICE'`)
  // when the client supplies a voice id that isn't in the curated catalog;
  // asyncHandler maps the ServerError status, so no inline try/catch needed.
  const { wav, latencyMs } = await synthesize(text, { voice, engine });
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('X-TTS-Latency-Ms', String(latencyMs));
  res.send(wav);
}));

// POST /api/voice/speak — server-pushed proactive speech. The CoS (or any
// internal subsystem) uses this to make the assistant speak first; clients
// pick up the audio over the `voice:speak` socket event. Suppressed by
// quiet hours / disabled flag — those return 200 with `{ ok: false, reason }`
// rather than an HTTP error because suppression is the documented contract.
const speakBodySchema = z.object({
  // Trim first so whitespace-only payloads ("   ") fail the .min(1) check
  // at the HTTP boundary with a 400, matching /api/voice/test's behavior
  // instead of falling through to a 200 { ok:false, reason:'empty' }.
  text: z.string().trim().min(1).max(MAX_VOICE_TEXT_LEN),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  // Empty / whitespace-only `source` would otherwise satisfy `.optional()`
  // and override speakProactive's default of `'cos'`, emitting payloads
  // with `source: ''`. Treat whitespace-only as omitted so the default
  // applies. (`.trim().min(1)` would have rejected the same input with
  // a 400 — we prefer silent fall-through for an internal route.)
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
  // Fail fast on missing io — that's a server misconfiguration (Socket.IO
  // never attached) and a 200 { ok:false, reason:'no-io' } would silently
  // mask the bad state from monitoring. Quiet-hours / proactive-disabled
  // still return 200 because those ARE expected suppression outcomes.
  if (!io) {
    throw new ServerError(
      'voice subsystem misconfigured: io not attached',
      { status: 500, code: 'VOICE_IO_UNAVAILABLE' },
    );
  }
  const result = await speakProactive({ io, ...parsed.data });
  res.json(result);
}));

// GET /api/voice/tts/status — Kokoro residency snapshot (lazy/loading/loaded
// plus the model key currently cached). Piper has no resident model — it
// spawns per-synthesis — so it's not represented here.
router.get('/tts/status', asyncHandler(async (_req, res) => {
  res.json({
    kokoro: {
      state: kokoroReadyState(),
      loadedKey: kokoroLoadedKey(),
    },
  });
}));

// POST /api/voice/tts/unload — drop the cached Kokoro instance so unified
// memory can host a big diffusion model instead. The next synthesizeKokoro
// call pays the ~2–3s cold start. No-op if nothing was loaded.
router.post('/tts/unload', asyncHandler(async (_req, res) => {
  res.json(unloadKokoro());
}));

// POST /api/voice/whisper — body: { action: 'stop' | 'start' }.
// Memory-management lever: stop frees ~1.5 GB of whisper.cpp + GGML model
// weights for the duration. Start re-binds the PM2 process using current
// voice.stt config. Distinct from /api/voice/config (which persists enabled
// state) — this is a transient stop, voice.enabled stays true.
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
    // Drop the cached `services.whisper.ok` so the next /voice/status reflects
    // the just-flipped PM2 state — without this the Memory Management panel
    // re-polls and sees up to 3s of "still running" after a successful stop.
    invalidateHealthCache();
    return res.json({ success: true, action: 'stop' });
  }
  const cfg = await getVoiceConfig();
  const result = await startWhisper(cfg);
  invalidateHealthCache();
  res.json({ success: true, action: 'start', ...result });
}));

export default router;
