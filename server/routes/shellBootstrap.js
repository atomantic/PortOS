import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getBuildIdentity } from '../lib/buildIdentity.js';
import { getPasswordRiskStatus } from '../services/auth.js';
import { getShellSetupStatus } from '../services/capabilitiesSnapshot.js';
import { getInstanceFeatures } from '../services/instanceFeatures.js';
import { getSelf } from '../services/instanceIdentity.js';
import { readinessProjection } from '../services/maintenanceControl.js';
import { getSettings } from '../services/settings.js';
import { getShellUpdateStatus } from '../services/updateChecker.js';
import { getVoiceConfig } from '../services/voice/config.js';
import { TTS_ENGINE_CONFIG_KEYS } from '../lib/voiceEngines.js';

const router = Router();

const reads = {
  settings: async () => {
    const { theme, timezone } = await getSettings();
    return { theme, timezone };
  },
  selfInstance: async () => ({ name: (await getSelf())?.name }),
  features: getInstanceFeatures,
  voiceConfig: async () => {
    const { enabled, hotkey, stt, llm, tts, vad } = await getVoiceConfig();
    const engine = tts?.engine;
    // An engine's options live under its config key (qwen3-tts → qwen3), which the client also accepts.
    const ttsKey = TTS_ENGINE_CONFIG_KEYS[engine] ?? engine;
    return {
      enabled, hotkey,
      vad: { endOfSpeechMs: vad?.endOfSpeechMs, minUtteranceMs: vad?.minUtteranceMs },
      stt: { engine: stt?.engine, language: stt?.language },
      // provider + model are the saved Voice brain: without them the client falls back to its placeholder
      // and the Voice Call picker shows (and can then save) a choice the user never made.
      llm: {
        provider: llm?.provider,
        model: llm?.model,
        fastPath: llm?.fastPath,
        personality: llm?.usePersonality === false ? null : llm?.personality,
      },
      tts: { engine, rate: tts?.rate, ...(ttsKey && { [ttsKey]: { voice: tts[ttsKey]?.voice } }) },
    };
  },
  maintenance: readinessProjection,
  passwordRisk: getPasswordRiskStatus,
  updateStatus: getShellUpdateStatus,
  setup: getShellSetupStatus,
  build: getBuildIdentity,
};

// A failed slice is absent so its owner can recover independently through
// the existing endpoint. In particular, absent password posture is unknown.
router.get('/bootstrap', asyncHandler(async (_req, res) => {
  const entries = await Promise.all(Object.entries(reads).map(async ([key, read]) => {
    const value = await Promise.resolve().then(() => read()).catch(() => undefined);
    return [key, value];
  }));
  res.set('Cache-Control', 'private, no-store').json(Object.fromEntries(entries));
}));

export default router;
