import { useEffect, useRef } from 'react';
import { changeVoiceAvatar, fetchVoiceAvatar } from '../../services/apiVoiceAvatar';
import { useSocketResource } from '../../hooks/useSocketResource';

const events = ['voice:avatar:changed'];

/** Whether a view showing the call portrait should start AvatarForcing for the operator. */
export const shouldAutoStartAvatar = (status) => Boolean(status?.supported && status.installed && !status.updateAvailable
  && status.phase === 'stopped' && status.autoStart !== false);

/**
 * AvatarForcing runtime status, live over the socket. With `autoStart`, a view that shows the call portrait asks the
 * server to start an installed, stopped worker once per mount, so calls open with the live avatar instead of the still
 * portrait. Stop on the avatar card turns that off until the operator starts it again.
 */
export const useAvatarRuntime = (enabled = true, { autoStart = false } = {}) => {
  const resource = useSocketResource(fetchVoiceAvatar, { events, enabled });
  const attempted = useRef(false);
  const { data, updateData } = resource;
  useEffect(() => {
    if (!autoStart || !enabled || attempted.current || !shouldAutoStartAvatar(data)) return;
    attempted.current = true;
    changeVoiceAvatar('autostart').then((next) => { if (next) updateData?.(next); }).catch(() => {});
  }, [autoStart, enabled, data, updateData]);
  return resource;
};
