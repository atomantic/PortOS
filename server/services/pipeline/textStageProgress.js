/**
 * Pipeline — text-stage generation progress channel (#3393).
 *
 * `generateStage` can run up to three sequential generate+judge cycles (the
 * #2169 draft gate), which is minutes of blind spinner in the UI. This module
 * carries the phase frames for that work.
 *
 * Why not `createSseRunner` (the polish.js / autoRunner shape)? That factory
 * OWNS the run: it mints the runId, fires the work in a detached coordinator,
 * and the HTTP request that started it returns immediately. Text-stage
 * generation is the opposite shape — `POST …/stages/:stageId/generate` awaits
 * the result and returns the finished stage, and every non-route caller
 * (autoRunner, Series Autopilot, volumeBeatsRunner, tests) calls
 * `generateStage` directly as a plain promise. So this is the subscribe-first
 * sibling of that runner: a pub/sub channel over the SAME `sseUtils` wire
 * primitives (`broadcastSse` / `attachSseClient`) and the same
 * `SSE_CLEANUP_DELAY_MS` replay window, so the frame format, the late-attach
 * replay, and the teardown semantics stay identical.
 *
 * Lifecycle (the ordering is what removes the race):
 *   1. The client opens `GET …/generate/progress`. `attachClient` OPENS the
 *      channel when it doesn't exist yet — so the subscriber never 404s on a
 *      run it is about to trigger, and it doesn't matter whether the GET or the
 *      POST reaches the server first.
 *   2. The client POSTs `…/generate`. `generateStage` pushes frames through
 *      `emitStageProgress`, which is a NO-OP when nobody subscribed.
 *   3. `finishStageProgress` broadcasts the terminal frame and lets the channel
 *      linger for `SSE_CLEANUP_DELAY_MS` so a late attach still replays it.
 *
 * The channel is purely advisory: generation never waits on it, never fails
 * because of it, and a caller with no subscriber runs byte-for-byte the
 * pre-#3393 path.
 */

import { broadcastSse, attachSseClient, SSE_CLEANUP_DELAY_MS } from '../../lib/sseUtils.js';

// A channel opened by a subscriber that never sees a generation start is an
// abandoned reservation (the POST failed validation, the user navigated away
// between the GET and the POST, …). Reap it rather than holding the response
// open forever. Only covers the pre-start window — once frames are flowing the
// channel lives until its terminal frame, however long generation takes.
export const CHANNEL_IDLE_MS = 60_000;

// channels: Map<key, { clients[], lastPayload, started, finished, timer }>
// `timer` is the single owned timeout for this channel — the idle reap before a
// run starts, then the post-terminal replay eviction. Owning it (rather than
// calling sseUtils' fire-and-forget closeJobAfterDelay) is what lets a fresh run
// reclaim a channel that is still inside its replay window.
const channels = new Map();

/** Channel key for one issue's one text stage. */
export const channelKey = (issueId, stageId) => `${issueId}::${stageId}`;

const clearTimer = (channel) => {
  if (channel.timer) {
    clearTimeout(channel.timer);
    channel.timer = null;
  }
};

// End every attached response and evict the channel — but only when it is still
// the mapped one, so a replacement opened in the meantime survives.
const dropChannel = (key, channel) => {
  clearTimer(channel);
  for (const c of channel.clients) c.end();
  if (channels.get(key) === channel) channels.delete(key);
};

/**
 * Attach an SSE client, opening the channel when this is the first subscriber.
 * Always succeeds — the subscribe-then-trigger ordering above depends on it.
 */
export function attachClient(issueId, stageId, res) {
  const key = channelKey(issueId, stageId);
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
      console.log(`🧹 Text-stage progress — reaped idle channel stage=${stageId} issue=${String(issueId).slice(0, 8)}`);
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

/** True when a channel is open for this issue+stage. */
export const isChannelOpen = (issueId, stageId) => channels.has(channelKey(issueId, stageId));

/**
 * Broadcast one progress frame. No-op when nothing is subscribed — this is the
 * whole reason generation never depends on the channel.
 */
export function emitStageProgress(issueId, stageId, payload) {
  const channel = channels.get(channelKey(issueId, stageId));
  if (!channel) return;
  // A `start` frame revives a channel still lingering after the previous run's
  // terminal frame, so a client that stayed attached keeps streaming. Any other
  // frame type on a finished channel is trailing noise and is dropped.
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
export function finishStageProgress(issueId, stageId, payload) {
  const key = channelKey(issueId, stageId);
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
