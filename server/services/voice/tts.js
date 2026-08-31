// TTS façade — dispatches on cfg.tts.engine ('kokoro' default | 'piper' | 'qwen3-tts').

import { join } from 'node:path';
import { getVoiceConfig, piperVoiceTildePath } from './config.js';
import { synthesizeKokoro, listKokoroVoices } from './tts-kokoro.js';
import { synthesizePiper, listPiperVoices } from './tts-piper.js';
import { synthesizeQwen3, listQwen3Voices } from './tts-qwen3.js';
import { findPiperVoice } from './piper-voices.js';
import { isKokoroVoice } from './kokoro-voices.js';
import { getProfileForSynthesis, profileArtifactDirectory } from './profiles.js';
import { whichFirst } from '../../lib/processEnv.js';
import { ServerError } from '../../lib/errorHandler.js';

// Single source of truth for the supported TTS engine names.
export const VALID_ENGINES = new Set(['kokoro', 'piper', 'qwen3-tts']);

let voiceTransformProbe = null;

const probeVoiceTransforms = () => {
  if (!voiceTransformProbe) {
    voiceTransformProbe = whichFirst('rubberband').then((rubberband) => ({
      rubberband: Boolean(rubberband),
    }));
  }
  return voiceTransformProbe;
};

export const listVoiceEngines = async () => {
  const transforms = await probeVoiceTransforms();
  const unavailableControls = transforms.rubberband
    ? 'Rubber Band is installed, but PortOS has no approved formant-preserving adapter yet. Pitch and formant controls remain disabled until that adapter is enabled.'
    : 'Install Rubber Band to enable a future formant-preserving transform. Pitch and formant controls remain disabled rather than approximated by sample-rate changes.';
  return [
    {
      id: 'kokoro',
      capabilities: {
        preset: true, voiceDesign: false, instantClone: false, fineTune: false,
        streaming: false, instructionControl: false, emotionControl: false,
        seed: false, wordTimings: false, rate: true, pitch: false, formant: false,
      },
      unavailableControls,
      transformProbe: transforms,
    },
    {
      id: 'piper',
      capabilities: {
        preset: true, voiceDesign: false, instantClone: false, fineTune: false,
        streaming: false, instructionControl: false, emotionControl: false,
        seed: false, wordTimings: false, rate: true, pitch: false, formant: false,
      },
      unavailableControls,
      transformProbe: transforms,
    },
    {
      id: 'qwen3-tts',
      capabilities: {
        preset: true, voiceDesign: true, instantClone: true, fineTune: true,
        streaming: true, instructionControl: true, emotionControl: true,
        seed: true, wordTimings: true, rate: true, pitch: false, formant: false,
      },
      unavailableControls,
      transformProbe: transforms,
    },
  ];
};

// Normalize `engine` against the allowlist so an invalid value can't silently
// produce Kokoro audio while the response reports `engine: 'elevenlabs'`.
const resolveEngine = (engine) => {
  const norm = engine === 'qwen3' ? 'qwen3-tts' : engine;
  return VALID_ENGINES.has(norm) ? norm : 'kokoro';
};

const backend = (engine) => {
  if (engine === 'piper') return { synth: synthesizePiper, list: listPiperVoices };
  if (engine === 'qwen3-tts') return { synth: synthesizeQwen3, list: listQwen3Voices };
  return { synth: synthesizeKokoro, list: listKokoroVoices };
};

/**
 * Synthesize text with the active TTS engine or profile binding.
 * @param {string} text
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.voice]  transient voice override
 * @param {string} [opts.engine] transient engine override ('kokoro'|'piper'|'qwen3-tts')
 * @param {number} [opts.rate]   transient speech-rate override (0.25–4)
 * @param {string} [opts.profileId] profile ID to synthesize against
 * @param {string} [opts.route] 'studio' | 'interactive'
 * @returns {Promise<{ wav: Buffer, latencyMs: number, engine: string }>}
 */
export const synthesize = async (text, opts = {}) => {
  const cfg = await getVoiceConfig();
  const profile = opts.profileId
    ? await getProfileForSynthesis(opts.profileId, opts.route || 'studio')
    : null;
  const profileVoice = profile?.voiceId?.split(':')[1] || null;
  const engine = profile ? profile.engine : resolveEngine(opts.engine || cfg.tts.engine);
  const { synth } = backend(engine);

  let ttsCfg = profile ? { ...cfg.tts, rate: profile.delivery.rate } : cfg.tts;
  if (typeof opts.rate === 'number' && Number.isFinite(opts.rate)) {
    ttsCfg = { ...ttsCfg, rate: Math.min(4, Math.max(0.25, opts.rate)) };
  }

  let synthOpts = { ...opts, rate: ttsCfg.rate };

  if (profile) {
    if (profile.kind === 'designed') {
      synthOpts = {
        ...synthOpts,
        mode: 'design',
        instructions: profile.inference?.instructions,
        seed: profile.inference?.seed,
        modelId: profile.inference?.modelId || profile.modelRevision,
      };
    } else if (profile.kind === 'cloned') {
      const sourceAsset = profile.sourceAssets?.[0];
      const sourcePath = sourceAsset?.filename
        ? join(profileArtifactDirectory(profile.id), 'source', sourceAsset.filename)
        : null;
      synthOpts = {
        ...synthOpts,
        mode: 'clone',
        referenceAudio: sourcePath,
        referenceTranscript: sourceAsset?.transcript,
        modelId: profile.inference?.modelId || profile.modelRevision,
      };
    } else if (profile.kind === 'fine-tuned') {
      synthOpts = {
        ...synthOpts,
        mode: 'fine-tuned',
        checkpointPath: profile.inference?.checkpointPath,
        modelId: profile.modelRevision,
      };
    }
  }

  const voice = profileVoice || opts.voice;
  if (voice) {
    if (engine === 'kokoro') {
      if (!isKokoroVoice(voice)) {
        throw new ServerError(`unknown kokoro voice: ${voice}`, {
          status: 400,
          code: 'UNKNOWN_VOICE',
        });
      }
      ttsCfg = { ...ttsCfg, kokoro: { ...ttsCfg.kokoro, voice } };
    } else if (engine === 'piper') {
      const catalog = findPiperVoice(voice);
      if (!catalog) {
        throw new ServerError(`unknown piper voice: ${voice}`, {
          status: 400,
          code: 'UNKNOWN_VOICE',
        });
      }
      ttsCfg = {
        ...ttsCfg,
        piper: {
          ...ttsCfg.piper,
          voice,
          voicePath: piperVoiceTildePath(voice),
          speakerId: null,
        },
      };
    }
  }

  const result = engine === 'qwen3-tts'
    ? await synth(text, synthOpts, opts.signal)
    : await synth(text, ttsCfg, opts.signal);

  const modelRevision = engine === 'kokoro'
    ? `${ttsCfg.kokoro?.modelId || 'kokoro-v0_19'}:${ttsCfg.kokoro?.dtype || 'fp32'}`
    : (engine === 'piper' ? `piper:${ttsCfg.piper?.voice || 'default'}` : (profile?.modelRevision || result.modelRevision));

  return {
    ...result,
    engine,
    ...(profile ? {
      profileId: profile.id,
      profileRevision: profile.version,
      provenance: {
        profileId: profile.id,
        profileRevision: profile.version,
        engine,
        modelRevision,
        effectiveControls: { rate: ttsCfg.rate },
        mastering: profile.mastering,
      },
    } : {}),
  };
};

/**
 * Enumerate voices available for the given engine (or the configured one).
 * @param {string} [engineOverride] 'kokoro' | 'piper' | 'qwen3-tts'
 * @returns {Promise<{ engine: string, voices: Array }>}
 */
export const listVoices = async (engineOverride) => {
  const cfg = await getVoiceConfig();
  const engine = resolveEngine(engineOverride || cfg.tts.engine);
  const { list } = backend(engine);
  return { engine, voices: await list() };
};
