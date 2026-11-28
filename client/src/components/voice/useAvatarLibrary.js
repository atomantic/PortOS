import { fetchAvatarLibrary } from '../../services/apiVoiceAvatar';
import { useSocketResource } from '../../hooks/useSocketResource';

const events = ['voice:avatar:library:changed'];

/** The Avatars collection and channel assignments, refreshed when any tab changes them. */
export const useAvatarLibrary = (enabled = true) =>
  useSocketResource(fetchAvatarLibrary, { events, enabled });

export const avatarImageSrc = (filename) => (filename ? `/data/images/${encodeURIComponent(filename)}` : null);

/** The active channel record (with its index) from a library payload, or null before load. */
export function activeChannelOf(library) {
  if (!library?.channels?.length) return null;
  const index = library.active ?? 0;
  return { index, ...library.channels[index] };
}

/** The LLM a channel's agent runs: its own override, else the global voice LLM. */
export function channelLlm(channel, globalProvider, globalModel) {
  const own = channel?.agent?.provider;
  return own
    ? { provider: own, model: channel.agent.model || 'auto', own: true }
    : { provider: globalProvider || 'lmstudio', model: globalModel || 'auto', own: false };
}

/** The voice a channel's agent speaks with, as a short label: its own voice, else the global one. */
export const channelVoiceLabel = (channel, globalLabel) =>
  channel?.agent?.voiceId?.split(':').slice(1).join(':') || globalLabel;
