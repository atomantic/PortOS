/**
 * Deck prompt progress. GET and POST may arrive in either order: POST reserves
 * the channel before writing frames, and a late subscriber replays the latest.
 */
import { createProgressChannels, CHANNEL_IDLE_MS } from '../lib/progressChannels.js';

const progress = createProgressChannels({
  label: 'Deck prompt progress',
  describeKey: (key) => `deck=${String(key).slice(0, 8)}`,
});

export { CHANNEL_IDLE_MS };
export const beginPromptProgress = (deckId) => progress.begin(String(deckId));
export const attachClient = (deckId, res) => progress.attach(String(deckId), res);
export const isChannelOpen = (deckId) => progress.isOpen(String(deckId));
export const emitPromptProgress = (deckId, payload) => progress.emit(String(deckId), payload);
export const finishPromptProgress = (deckId, payload) => progress.finish(String(deckId), payload);
export const __testing = progress.__testing;
