/**
 * Deck prompt-writing progress channel.
 *
 * `POST /decks/:id/generate-prompts` writes a 79-card tarot deck in ~7
 * sequential LLM calls with no realtime feedback — the client sat on
 * "Writing prompts…" until the whole POST settled. This module carries the
 * per-chunk frames for that work.
 *
 * This is the subscribe-first sibling of the pipeline text-stage channel
 * (`services/pipeline/textStageProgress.js`): same `sseUtils` wire primitives
 * (`broadcastSse` / `attachSseClient`), same lifecycle —
 *   1. The client opens `GET /decks/:id/generate-prompts/progress`.
 *      `attachClient` OPENS the channel when it doesn't exist yet, so the
 *      subscriber never 404s on a run it is about to trigger.
 *   2. The client POSTs `…/generate-prompts`. The route pushes frames through
 *      `emitPromptProgress`, which is a NO-OP when nobody subscribed.
 *   3. `finishPromptProgress` broadcasts the terminal frame and lets the
 *      channel linger for `SSE_CLEANUP_DELAY_MS` so a late attach replays it.
 *
 * The channel is purely advisory: generation never waits on it, never fails
 * because of it, and a caller with no subscriber runs the pre-change path.
 */

import { broadcastSse, attachSseClient, SSE_CLEANUP_DELAY_MS } from '../lib/sseUtils.js';

// Same abandoned-reservation reap as the text-stage sibling: a channel opened
// by a subscriber that never sees a generation start (POST failed validation,
// navigation between GET and POST, …) is closed rather than held open forever.
// Only covers the pre-start window — once frames flow the channel lives until
// its terminal frame, however long generation takes.
export const CHANNEL_IDLE_MS = 60_000;

// channels: Map<deckId, { clients[], lastPayload, started, finished, timer }>
// `timer` is the single owned timeout for this channel — the idle reap before
// a run starts, then the post-terminal replay eviction. Owning it lets a fresh
// run reclaim a channel still inside its replay window.
const channels = new Map();

const clearTimer = (channel) => {
  if (channel.timer) {
    clearTimeout(channel.timer);
    channel.timer = null;
  }
};

// End every attached response and evict the channel — but only when it is
// still the mapped one, so a replacement opened in the meantime survives.
const dropChannel = (key, channel) => {
  clearTimer(channel);
  for (const c of channel.clients) c.end();
  if (channels.get(key) === channel) channels.delete(key);
};

/**
 * Attach an SSE client, opening the channel when this is the first subscriber.
 * Always succeeds — the subscribe-then-trigger ordering depends on it.
 */
export function attachClient(deckId, res) {
  const key = String(deckId);
  let channel = channels.get(key);
  // A finished channel still inside its replay window belongs to the PREVIOUS
  // run — a new subscriber is here for the next one, so replace it outright
  // rather than binding them to a stream that will never emit again.
  if (channel?.finished) {
    dropChannel(key, channel);
    channel = null;
  }
  if (!channel) {
    channel = { clients: [], lastPayload: null, started: false, finished: false, timer: null };
    channels.set(key, channel);
    // setTimeout callback — runs outside the request lifecycle, so it must not throw.
    channel.timer = setTimeout(() => {
      if (channels.get(key) !== channel || channel.started) return;
      console.log(`🧹 Deck prompt progress — reaped idle channel deck=${String(deckId).slice(0, 8)}`);
      dropChannel(key, channel);
    }, CHANNEL_IDLE_MS);
    channel.timer.unref?.();
  }
  attachSseClient(channels, key, res);
  // A subscriber that disconnects before any generation started leaves nothing
  // to stream — close the reservation instead of waiting out the idle timer.
  res.req.on('close', () => {
    if (channels.get(key) !== channel) return;
    if (!channel.started && channel.clients.length === 0) dropChannel(key, channel);
  });
  return true;
}

/** True when a channel is open for this deck. */
export const isChannelOpen = (deckId) => channels.has(String(deckId));

/**
 * Broadcast one progress frame. No-op when nothing is subscribed — this is
 * the whole reason generation never depends on the channel.
 */
export function emitPromptProgress(deckId, payload) {
  const channel = channels.get(String(deckId));
  if (!channel) return;
  // A `start` frame revives a channel still lingering after the previous run's
  // terminal frame, so a client that stayed attached keeps streaming. Any
  // other frame type on a finished channel is trailing noise and is dropped.
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
}

/**
 * Broadcast the terminal frame (`complete` / `error`) and schedule teardown.
 * The channel lingers for the shared grace window so a client that attached
 * just after the frame shipped still replays it from `lastPayload`.
 */
export function finishPromptProgress(deckId, payload) {
  const key = String(deckId);
  const channel = channels.get(key);
  if (!channel || channel.finished) return;
  clearTimer(channel);
  broadcastSse(channel, payload);
  channel.finished = true;
  channel.timer = setTimeout(() => dropChannel(key, channel), SSE_CLEANUP_DELAY_MS);
  channel.timer.unref?.();
}

// Exported for tests — lets a suite assert channel bookkeeping and reset state.
export const __testing = {
  channels,
  reset: () => {
    for (const [key, channel] of [...channels]) dropChannel(key, channel);
    channels.clear();
  },
};
