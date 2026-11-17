/**
 * Creative Director scene reference-frame attach hook (#1867).
 *
 * For each completed image job carrying `params.creativeDirector`, files the
 * rendered filename onto that scene's `sourceImageFile` server-side (the same field
 * sceneRunner.js reads as a render's source image). Only local/Codex lanes ride the
 * media-job queue; `updateScene` emits the record-updated event so peers sync.
 * Shared scaffold lives in `createMediaJobImageHook` (#1791); mounted from
 * server/index.js after the media job queue starts.
 */

import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { updateScene } from './creativeDirector/local.js';

const hook = createMediaJobImageHook({
  label: 'creative-director scene-frame',
  initLog: '🎬 Creative Director scene-frame hook initialized',
  tagKey: 'creativeDirector',
  // Require both ids; the tag is otherwise ambiguous about which scene to file.
  identify: (tag) => (tag?.projectId && tag.sceneId
    ? { projectId: tag.projectId, sceneId: tag.sceneId }
    : null),
  // Per PROJECT: concurrent load→modify→save of one project record would clobber.
  serializeKey: ({ projectId }) => projectId,
  // Newest-render-wins per scene: drop an out-of-order older render.
  sceneKey: ({ projectId, sceneId }) => `${projectId}:${sceneId}`,
  describe: ({ projectId, sceneId }) => `${projectId}/${sceneId}`,
  attach: ({ projectId, sceneId, filename }) =>
    updateScene(projectId, sceneId, { sourceImageFile: filename }),
  onAttached: ({ projectId, sceneId, filename }) => {
    console.log(`🎬 CD scene reference frame ${projectId.slice(0, 8)}/${sceneId} ← ${filename}`);
  },
});

export function initCreativeDirectorSceneImageHook() {
  hook.init();
}

export const __testing = hook.__testing;
