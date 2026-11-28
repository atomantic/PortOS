/**
 * Voice Call transceiver channels: the stored channel record shape and each channel's sparse agent overrides over the global voice config.
 *
 * A channel's `agent` holds only the fields the user tuned for that channel. Every absent
 * field inherits the global voice settings, so editing a default under Settings → Voice
 * still reaches every channel that did not override it. Pure and dependency-light so the
 * client can apply the same overrides it shows (for the on-device fast path and labels).
 */

import { TTS_ENGINE_IDS } from './voiceEngines.js';

export const VOICE_CHANNELS_SETTINGS_KEY = 'voiceAvatarChannels';
export const AVATAR_CHANNEL_COUNT = 6;
export const AVATAR_CHANNEL_LABEL_MAX = 24;

/** Per-field limits; they match the global `voice.llm` config schema. */
export const CHANNEL_AGENT_LIMITS = Object.freeze({
  voiceId: 160,
  provider: 80,
  model: 128,
  name: 64,
  role: 128,
  speechStyle: 256,
  customPrompt: 2000,
  trait: 64,
  traits: 20,
});

/** The personality fields a channel can override, in `voice.llm.personality` order. */
export const CHANNEL_PERSONA_TEXT_FIELDS = Object.freeze(['name', 'role', 'speechStyle', 'customPrompt']);

const ENGINE_IDS = new Set(TTS_ENGINE_IDS);
const VOICE_ID_RE = /^([a-z][a-z0-9-]*):(\S+)$/i;

/** `engine:voice` → `{ engine, voice }` for a supported engine, else null. */
export function parseChannelVoiceId(voiceId) {
  const match = typeof voiceId === 'string' ? VOICE_ID_RE.exec(voiceId.trim()) : null;
  if (!match) return null;
  const lower = match[1].toLowerCase();
  const engine = lower === 'qwen3' ? 'qwen3-tts' : lower;
  return ENGINE_IDS.has(engine) ? { engine, voice: match[2] } : null;
}

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Keep only valid, non-empty overrides; anything else inherits the global setting. */
export function normalizeChannelAgent(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const agent = {};
  const voice = parseChannelVoiceId(text(raw.voiceId, CHANNEL_AGENT_LIMITS.voiceId));
  if (voice) agent.voiceId = `${voice.engine}:${voice.voice}`;
  const provider = text(raw.provider, CHANNEL_AGENT_LIMITS.provider);
  if (provider) {
    agent.provider = provider;
    agent.model = text(raw.model, CHANNEL_AGENT_LIMITS.model) || 'auto';
  }
  for (const field of CHANNEL_PERSONA_TEXT_FIELDS) {
    const value = text(raw[field], CHANNEL_AGENT_LIMITS[field]);
    if (value) agent[field] = value;
  }
  // An array, even an empty one, is an override; only an absent list inherits.
  if (Array.isArray(raw.traits)) {
    const traits = [...new Set(raw.traits.map((trait) => text(trait, CHANNEL_AGENT_LIMITS.trait)).filter(Boolean))];
    agent.traits = traits.slice(0, CHANNEL_AGENT_LIMITS.traits);
  }
  return agent;
}

/**
 * Apply one edit to a channel's agent field by field: a value sets that field, `null`
 * clears it back to the global default, and a `null` patch clears every override.
 * Clearing the provider clears its model too.
 */
export function mergeChannelAgentPatch(agent, patch) {
  if (patch === null) return {};
  const next = { ...(agent || {}) };
  for (const [field, value] of Object.entries(patch || {})) {
    if (value === null) delete next[field];
    else if (value !== undefined) next[field] = value;
  }
  if (!next.provider) delete next.model;
  return next;
}

const blankChannel = () => ({ label: '', avatar: null, agent: {} });

/** Normalize a stored channels record; anything malformed falls back per field. */
export function normalizeChannels(raw, { isSafeFilename = () => true } = {}) {
  const list = Array.isArray(raw?.channels) ? raw.channels : [];
  const channels = Array.from({ length: AVATAR_CHANNEL_COUNT }, (_, index) => {
    const entry = list[index];
    if (!entry || typeof entry !== 'object') return blankChannel();
    return {
      label: text(entry.label, AVATAR_CHANNEL_LABEL_MAX),
      avatar: typeof entry.avatar === 'string' && isSafeFilename(entry.avatar) ? entry.avatar : null,
      agent: normalizeChannelAgent(entry.agent),
    };
  });
  const active = Number.isInteger(raw?.active) && raw.active >= 0 && raw.active < AVATAR_CHANNEL_COUNT ? raw.active : 0;
  return { active, channels };
}

/** The global personality with a channel's persona overrides applied. */
export function applyChannelPersonality(personality, agent) {
  const merged = { ...(personality || {}) };
  for (const field of CHANNEL_PERSONA_TEXT_FIELDS) if (agent?.[field]) merged[field] = agent[field];
  if (Array.isArray(agent?.traits)) merged.traits = [...agent.traits];
  return merged;
}

/** True when the channel tunes any persona field. */
export const hasChannelPersona = (agent) =>
  CHANNEL_PERSONA_TEXT_FIELDS.some((field) => Boolean(agent?.[field])) || Array.isArray(agent?.traits);

/**
 * The effective voice config for a channel: the global config with the channel's LLM
 * and persona overrides applied. A persona override turns the personality prompt on for
 * that channel, since tuning it while the raw system prompt is in use would do nothing.
 */
export function applyChannelAgent(cfg, agent) {
  if (!cfg?.llm || !agent || Object.keys(agent).length === 0) return cfg;
  const llm = { ...cfg.llm, personality: applyChannelPersonality(cfg.llm.personality, agent) };
  if (hasChannelPersona(agent)) llm.usePersonality = true;
  if (agent.provider) {
    // The global vision model belongs to the global provider.
    if (agent.provider !== cfg.llm.provider) llm.visionModel = 'auto';
    llm.provider = agent.provider;
    llm.model = agent.model || 'auto';
  }
  return { ...cfg, llm };
}

/** `synthesize()` options for the channel's voice, or `{}` to speak with the global voice. */
export function channelAgentSpeechOpts(agent) {
  const voice = parseChannelVoiceId(agent?.voiceId);
  return voice ? { engine: voice.engine, voice: voice.voice } : {};
}
