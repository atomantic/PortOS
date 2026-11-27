import { fetchVoiceAvatar } from '../../services/apiVoiceAvatar';
import { useSocketResource } from '../../hooks/useSocketResource';

const events = ['voice:avatar:changed'];
export const useAvatarRuntime = (enabled = true) =>
  useSocketResource(fetchVoiceAvatar, { events, enabled });
