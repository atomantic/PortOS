/** Shared SSE channel lifecycle for request-owned progress streams. */
import { attachSseClient, broadcastSse, SSE_CLEANUP_DELAY_MS } from './sseUtils.js';

export const CHANNEL_IDLE_MS = 60_000;

export function createProgressChannels({ label, describeKey }) {
  const channels = new Map();

  const clearTimer = (channel) => {
    if (channel.timer) clearTimeout(channel.timer);
    channel.timer = null;
  };

  const dropChannel = (key, channel) => {
    clearTimer(channel);
    for (const client of channel.clients) client.end();
    if (channels.get(key) === channel) channels.delete(key);
  };

  const ensureChannel = (key) => {
    let channel = channels.get(key);
    // A finished channel belongs to the previous run, even during its replay
    // window. A fresh GET or POST must not attach to that run.
    if (channel?.finished) {
      dropChannel(key, channel);
      channel = null;
    }
    if (!channel) {
      channel = { clients: [], lastPayload: null, started: false, finished: false, timer: null };
      channels.set(key, channel);
      channel.timer = setTimeout(() => {
        if (channels.get(key) !== channel || channel.started) return;
        console.log(`🧹 ${label} — reaped idle channel ${describeKey(key)}`);
        dropChannel(key, channel);
      }, CHANNEL_IDLE_MS);
      channel.timer.unref?.();
    }
    return channel;
  };

  const begin = (key) => {
    const channel = ensureChannel(key);
    if (channel.started) return false;
    channel.started = true;
    clearTimer(channel);
    return true;
  };

  const attach = (key, res) => {
    const channel = ensureChannel(key);
    attachSseClient(channels, key, res);
    res.req.on('close', () => {
      if (channels.get(key) === channel && !channel.started && channel.clients.length === 0) {
        dropChannel(key, channel);
      }
    });
    return true;
  };

  const emit = (key, payload) => {
    const channel = channels.get(key);
    if (!channel) return;
    // Preserve the existing start-frame revival for a subscriber that stayed
    // attached through a previous terminal frame.
    if (channel.finished) {
      if (payload?.type !== 'start') return;
      channel.finished = false;
      clearTimer(channel);
    }
    if (!channel.started) {
      channel.started = true;
      clearTimer(channel);
    }
    broadcastSse(channel, payload);
  };

  const finish = (key, payload) => {
    const channel = channels.get(key);
    if (!channel || channel.finished) return;
    clearTimer(channel);
    broadcastSse(channel, payload);
    channel.finished = true;
    channel.timer = setTimeout(() => dropChannel(key, channel), SSE_CLEANUP_DELAY_MS);
    channel.timer.unref?.();
  };

  return {
    attach,
    begin,
    emit,
    finish,
    isOpen: (key) => channels.has(key),
    __testing: {
      channels,
      reset: () => {
        for (const [key, channel] of [...channels]) dropChannel(key, channel);
        channels.clear();
      },
    },
  };
}
