/**
 * Storyboard panel frame completion hook.
 *
 * For each finished image job tagged `params.storyboardPanelRender`, adds the
 * frame to its panel as a take — server-side, so frames land after the user
 * navigated away. A failed or canceled frame is counted against its run so the
 * image node settles. Serialized per board; the run id in make.js keeps a
 * newer run's bookkeeping from counting an older run's frames.
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { attachPanelFrame, failPanelFrame, STORYBOARD_PANEL_RENDER_TAG } from './storyboards/make.js';

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;

const hook = createMediaJobImageHook({
  label: 'storyboard panel frame',
  initLog: '🎬 Storyboard panel frame hook initialized',
  tagKey: STORYBOARD_PANEL_RENDER_TAG,
  identify: (tag, job) => (isId(tag?.storyboardId) && isId(tag?.panelId) && isId(tag?.nodeId) && isId(tag?.runId)
    ? { storyboardId: tag.storyboardId, panelId: tag.panelId, nodeId: tag.nodeId, runId: tag.runId, jobId: job?.id || null }
    : null),
  serializeKey: ({ storyboardId }) => storyboardId,
  describe: ({ storyboardId, panelId }) => `${storyboardId}/${panelId}`,
  attach: attachPanelFrame,
  onAttached: ({ storyboardId, panelId }, result) => {
    console.log(`🎬 Storyboard ${storyboardId.slice(0, 11)} panel ${panelId.slice(0, 12)} frame → take ${result.takeId.slice(0, 13)}`);
  },
  onTerminal: (ctx, status, job) => failPanelFrame(ctx, status, job?.error),
});

export function initStoryboardPanelImageHook() {
  hook.init();
}

export const __testing = hook.__testing;
