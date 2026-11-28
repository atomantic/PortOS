/**
 * The on-air Voice Call channel's agent: the global voice config with that channel's
 * voice, LLM and persona overrides applied (lib/voiceChannels.js), for the spoken-turn
 * pipeline and every line the agent speaks.
 *
 * Reads settings directly instead of going through avatarLibrary.js so the per-turn path
 * does not load the media collection modules.
 */

import { applyChannelAgent, channelAgentSpeechOpts, normalizeChannels, VOICE_CHANNELS_SETTINGS_KEY } from '../../lib/voiceChannels.js';
import { getSettings } from '../settings.js';
import { getVoiceConfig } from './config.js';
import { synthesize } from './tts.js';

/** The active channel's sparse agent overrides (`{}` when it inherits everything). */
export async function getActiveChannelAgent() {
  const { active, channels } = normalizeChannels((await getSettings())?.[VOICE_CHANNELS_SETTINGS_KEY]);
  return channels[active]?.agent ?? {};
}

/** The voice config the on-air channel's agent runs with. */
export async function getAgentVoiceConfig() {
  const [cfg, agent] = await Promise.all([getVoiceConfig(), getActiveChannelAgent()]);
  return applyChannelAgent(cfg, agent);
}

/**
 * Speak a line in the on-air channel's voice. Explicit options still win, and a channel
 * without a voice override speaks with the global voice exactly as before.
 */
export async function synthesizeAgentSpeech(text, opts = {}) {
  const agent = await getActiveChannelAgent();
  return synthesize(text, { ...channelAgentSpeechOpts(agent), ...opts });
}
