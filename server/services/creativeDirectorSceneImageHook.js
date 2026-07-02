/**
 * Creative Director scene reference-frame attach hook (#1867).
 *
 * Subscribes to mediaJobEvents and, for each completed image job that
 * carries `params.creativeDirector`, files the rendered filename onto that
 * project scene's `sourceImageFile` — server-side, independent of any
 * mounted client. This is the durable attach counterpart to the job
 * `firstPassGen.js`'s `enqueueFirstPassSceneFrames` enqueues: a fire-and-
 * forget seed render queued right after the director writes a treatment,
 * landing even if no client is watching.
 *
 * `sourceImageFile` is the SAME field a manually-set per-scene reference
 * image or an i2v-continuation source already populates (sceneRunner.js
 * reads it as the render's source image when `useContinuationFromPrior` is
 * false) — first-pass gen fills the gap, it does not add a parallel field.
 *
 * Only the async local/Codex lanes ride the media-job queue this hook
 * listens to; `resolveQueueModeParams` in firstPassGen.js never queues an
 * external-mode render in the first place, so this hook only ever sees
 * local/Codex completions.
 *
 * `updateScene` routes through the project store dispatcher (local.js),
 * which emits a `creativeDirectorProject` record-updated event on every
 * call — the new `sourceImageFile` propagates to subscribed sync peers
 * exactly like a hand edit.
 *
 * The shared completion-hook scaffold (tag-decode, per-project
 * serialization, the newest-render-wins guard, best-effort error handling,
 * idempotent init/reset) lives in `createMediaJobImageHook` (#1791) — this
 * file is just the Creative-Director-specific config. Mounted once at server
 * boot from server/index.js (after the media job queue is running).
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
  // Serialize per PROJECT: two scene-frame renders for the same project
  // completing close together would otherwise both load→modify→save the one
  // project record and the later write could clobber the earlier scene's
  // sourceImageFile. Different projects still attach concurrently.
  serializeKey: ({ projectId }) => projectId,
  // Newest-render-wins per scene: a render kicked off from another client (or
  // a re-queued retry) can complete out of order — drop an older render so
  // it can't overwrite a newer reference frame.
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

// Test-only reset so suites that re-init can do so cleanly.
export const __testing = hook.__testing;
