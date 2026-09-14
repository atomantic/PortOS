/**
 * Deck card render hook — files a completed `deckCard`-tagged image job onto
 * its card (append to `imageRefs`, promote to primary, clear the in-flight
 * record), serialized per deck and newest-wins per card so a re-render that
 * finished out of order can't overwrite a newer frame. Runs server-side, so a
 * slow cloud render still lands after the user navigated away.
 *
 * A job that ends without a file (`failed` / `canceled`) is recorded on the
 * card too, so the persisted status doesn't stay "queued" forever and the
 * card grid can offer a retry after a reload.
 *
 * The deck service (and with it zod + the render-target leaves) is imported
 * at completion time, not at boot: bootstrap.js reaches this module from
 * every suite that boots the queue hooks, and none of them need the deck
 * graph instantiated (server/AGENTS.md "Import scoping").
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';

// One shared load: a failed + canceled pair fires in the same tick, and under
// the test runner two overlapping dynamic imports of one mocked specifier let
// one of them escape the mock (observed 2026-09-13). A rejected load is
// forgotten so a transient failure doesn't poison every later event.
let decksModule = null;
const decks = () => (decksModule ||= import('./decks.js').catch((err) => { decksModule = null; throw err; }));

const hook = createMediaJobImageHook({
  label: 'deck card',
  initLog: '🃏 Deck card render hook initialized',
  tagKey: 'deckCard',
  identify: (tag, job) => (tag?.deckId && tag?.cardId
    ? { deckId: tag.deckId, cardId: tag.cardId, key: tag.key || null, jobId: job?.id || null }
    : null),
  serializeKey: ({ deckId }) => deckId,
  sceneKey: ({ deckId, cardId }) => `${deckId}:${cardId}`,
  describe: ({ deckId, key }) => `${deckId}/${key}`,
  attach: async ({ deckId, cardId, filename, jobId }) => {
    const { attachCardRender } = await decks();
    return attachCardRender({ deckId, cardId, filename, jobId });
  },
  onAttached: ({ deckId, key }, card) => {
    console.log(`🃏 deck card ${deckId}/${key} ← ${card.primaryImageRef}`);
  },
  onTerminal: async ({ deckId, cardId, jobId }, status, job) => {
    const { markCardRenderTerminal } = await decks();
    return markCardRenderTerminal(deckId, cardId, { jobId, status, error: job.error || null });
  },
});

export function initDeckRenderHook() {
  hook.init();
}

export const __testing = hook.__testing;
