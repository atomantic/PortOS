/**
 * Zod schemas for voice configuration, profiles, synthesis, and avatar routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { mediaFilenameSchema, nonEmptyString } from './sharedSchemas.js';
import { MAX_AVATAR_WAV_BYTES } from './uploadLimits.js';
import { HHMM_RE } from './timezone.js';
import { TTS_ENGINE_IDS } from './voiceEngines.js';
import { VOICE_TEXT_MAX_CHARS } from './apiContractSchemas.js';
import { AVATAR_CHANNEL_COUNT, AVATAR_CHANNEL_LABEL_MAX, CHANNEL_AGENT_LIMITS } from './voiceChannels.js';

export const voicePiperFetchBodySchema = z.object({ voice: nonEmptyString });

export const voiceAvatarCommandSchema = z.object({
  action: z.enum(['install', 'update', 'cancel', 'start', 'stop', 'uninstall']),
  acceptTerms: z.literal(true).optional(),
}).strict();

export const voiceAvatarWaveSchema = z.custom(wav => Buffer.isBuffer(wav) && wav.length >= 44 &&
  wav.length <= MAX_AVATAR_WAV_BYTES && wav.toString('ascii', 0, 4) === 'RIFF' &&
  wav.toString('ascii', 8, 12) === 'WAVE', 'Expected PCM WAV audio.');

export const voiceAvatarIdleSchema = z.object({
  stage: z.enum(['idle', 'listening', 'thinking']).default('idle'),
}).strict();

/**
 * A channel's agent overrides. Every field is optional and an absent one inherits the
 * global voice config; `voiceAvatarChannels` normalization drops anything invalid.
 */
const L = CHANNEL_AGENT_LIMITS;
export const voiceChannelAgentSchema = z.object({
  voiceId: z.string().trim().max(L.voiceId).optional(),
  provider: z.string().trim().max(L.provider).optional(),
  model: z.string().trim().max(L.model).optional(),
  name: z.string().trim().max(L.name).optional(),
  role: z.string().trim().max(L.role).optional(),
  speechStyle: z.string().trim().max(L.speechStyle).optional(),
  customPrompt: z.string().trim().max(L.customPrompt).optional(),
  traits: z.array(z.string().trim().max(L.trait)).max(L.traits).optional(),
}).strict();

/** Voice Call transceiver channels; each can wear one avatar and tune its own agent. */
const voiceAvatarChannelSchema = z.object({
  label: z.string().trim().max(AVATAR_CHANNEL_LABEL_MAX),
  avatar: mediaFilenameSchema.nullable(),
  agent: voiceChannelAgentSchema.optional(),
}).strict();

export const voiceAvatarChannelsSchema = z.object({
  active: z.number().int().min(0).max(AVATAR_CHANNEL_COUNT - 1).optional(),
  channels: z.array(voiceAvatarChannelSchema).length(AVATAR_CHANNEL_COUNT).optional(),
}).strict().refine((body) => body.active !== undefined || body.channels !== undefined, 'Send active or channels');

/** One channel's edit; a sent `agent` replaces that channel's overrides as a whole. */
export const voiceAvatarChannelPatchSchema = voiceAvatarChannelSchema.partial()
  .refine((body) => Object.keys(body).length > 0, 'Send label, avatar or agent');
export const voiceAvatarChannelParamsSchema = z.object({
  index: z.coerce.number().int().min(0).max(AVATAR_CHANNEL_COUNT - 1),
}).strict();

export const voiceAvatarAddSchema = z.object({ filename: mediaFilenameSchema }).strict();
export const voiceAvatarFilenameParamsSchema = z.object({ filename: mediaFilenameSchema }).strict();

export const facetimeActionSchema = z.object({}).strict();

export const voiceConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
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
    engine: z.enum([...TTS_ENGINE_IDS, 'kokoro']).optional(),
    retiredEngine: z.literal('kokoro').optional(),
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

export const voiceProfileListSchema = z.object({
  universeId: z.string().trim().min(1).max(160).optional(),
  characterId: z.string().trim().min(1).max(160).optional(),
}).strict();

export const promotePresetProfileSchema = z.object({
  universeId: z.string().trim().min(1).max(160),
  characterId: z.string().trim().min(1).max(160),
  characterName: z.string().trim().max(160).optional(),
  voiceId: z.string().trim().min(1).max(160),
}).strict();

export const voiceDesignCandidateSchema = z.object({
  universeId: z.string().trim().min(1).max(160),
  characterId: z.string().trim().min(1).max(160),
  characterName: z.string().trim().max(160).optional(),
  instructions: z.string().trim().max(2000).optional(),
  seed: z.number().int().optional(),
  modelId: z.string().trim().max(160).optional(),
  rate: z.number().min(0.25).max(4).optional(),
}).strict();

export const voiceCloneCandidateSchema = z.object({
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

export const promoteProfileSchema = z.object({
  routes: z.object({
    studio: z.object({ enabled: z.boolean().optional() }).partial().optional(),
    interactive: z.object({
      enabled: z.boolean().optional(),
      maxFirstAudioMs: z.number().min(50).max(5000).optional(),
    }).partial().optional(),
  }).partial().optional(),
}).strict();

export const interactiveBenchmarkSchema = z.object({
  maxFirstAudioMs: z.number().min(50).max(5000).optional(),
}).strict();

export const interactivePlaybackReceiptSchema = z.object({
  benchmarkId: z.string().uuid(),
  renderRequestLatencyMs: z.number().min(0).max(3600000),
  playbackStartupMs: z.number().min(0).max(30000),
}).strict();

export const fineTuneStartSchema = z.object({
  epochs: z.number().int().min(1).max(50).optional(),
  checkpointInterval: z.number().int().min(10).max(500).optional(),
  baseModel: z.string().trim().max(160).optional(),
}).strict();

export const fineTuneJobParamsSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  // Job ids are minted with randomUUID and are joined into a filesystem path
  // when the run is resolved from its on-disk record, so anything that could
  // carry a separator or `..` is rejected here.
  jobId: z.string().trim().uuid(),
}).strict();

export const fineTunePromoteSchema = z.object({
  checkpointId: z.string().trim().min(1).max(160),
}).strict();

export const profileIdParamsSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
}).strict();

export const studioDesignSchema = z.object({
  label: z.string().trim().min(1).max(160),
  instructions: z.string().trim().min(1).max(2000),
  text: z.string().trim().min(1).max(400),
  seed: z.number().int().min(0).max(2147483647).default(42),
  rate: z.number().min(0.5).max(2).default(1),
  pitchSemitones: z.number().int().min(-12).max(12).default(0),
  genSeconds: z.number().min(2).max(6).default(4),
}).strict();

export const studioAssignmentSchema = z.object({
  enableInteractive: z.boolean().default(false),
  universeId: z.string().trim().min(1).max(160),
  characterId: z.string().trim().min(1).max(160),
}).strict();

export const voiceTestBodySchema = z.object({
  text: z.string().trim().min(1).max(VOICE_TEXT_MAX_CHARS),
  voice: z.string().trim().default(''),
  engine: z.string().trim().default(''),
});

export const whisperActionSchema = z.object({
  action: z.enum(['start', 'stop']),
});

export const voiceStudioProfilesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(512).optional(),
}).strict();

export const avatarModelQuerySchema = z.object({ variant: z.string().optional() });
