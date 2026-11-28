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
