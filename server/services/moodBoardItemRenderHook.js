/**
 * Mood board note render completion hook (#10531).
 *
 * For each finished image job tagged `params.moodBoardRender`, turns the text
 * note it was rendered from into an image item in place — server-side, so the
 * render lands after the user navigated away or while autopilot moves on. A
 * failed or canceled job returns the note to text with the reason. Serialized
 * per board; the row lock and the job-id check in logic.js drop a stale render.
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { MOOD_BOARD_RENDER_TAG, attachRenderedItem, failRenderedItem } from './moodBoard/renderItem.js';

const hook = createMediaJobImageHook({
  label: 'mood board note render',
  initLog: '🖼️ Mood board note render hook initialized',
  tagKey: MOOD_BOARD_RENDER_TAG,
  identify: (tag, job) => (typeof tag?.boardId === 'string' && typeof tag?.itemId === 'string'
    ? { boardId: tag.boardId, itemId: tag.itemId, jobId: job?.id || null }
    : null),
  serializeKey: ({ boardId }) => boardId,
  describe: ({ boardId, itemId }) => `${boardId}/${itemId}`,
  attach: ({ boardId, itemId, jobId, filename, job }) => attachRenderedItem({
    boardId, itemId, jobId, filename, prompt: job?.params?.prompt,
  }),
  onAttached: ({ boardId, itemId }, item) => {
    console.log(`🖼️ Mood board ${boardId}/${itemId} note rendered ← ${item.mediaKey}`);
  },
  onTerminal: (ctx, status, job) => failRenderedItem(ctx, status, job?.error),
});

export function initMoodBoardItemRenderHook() {
  hook.init();
}

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
