/**
 * Creative Director — boot-time recovery.
 *
 * Server restarts (deploys, watchers, OOM kills) abort any in-flight render
 * and tear down the in-memory listeners that runSceneRender attaches. Without
 * recovery the project sits in `rendering` / `stitching` forever — its scene
 * status fields point at jobs that the queue already reclassified as
 * 'failed (interrupted by restart)' but nothing fires advanceAfterSceneSettled
 * to push the project forward.
 *
 * On boot, after the media-job queue reloads its persisted state, we:
 *   1. Find every project that's mid-flight (status in planning/rendering/
 *      stitching).
 *   2. Reset any scenes stuck in `rendering` or `evaluating` back to `pending`
 *      — their listeners are gone, the render is dead, the only sane next
 *      action is to redo them.
 *   3. Call `advanceAfterSceneSettled` to resume each project. It picks up
 *      from wherever the project stopped: re-renders pending scenes, fires a
 *      fresh evaluate task, runs the stitch, etc.
 */

import { listProjects, updateScene } from './local.js';

const RECOVERABLE_STATUSES = new Set(['planning', 'rendering', 'stitching']);
const STUCK_SCENE_STATUSES = new Set(['rendering', 'evaluating']);

export async function recoverInFlightProjects() {
  const projects = await listProjects();
  const recoverable = projects.filter((p) => RECOVERABLE_STATUSES.has(p.status));
  if (!recoverable.length) return { resumed: 0 };

  const { advanceAfterSceneSettled } = await import('./completionHook.js');
  let resumed = 0;
  for (const project of recoverable) {
    const scenes = project.treatment?.scenes || [];
    const stuck = scenes.filter((s) => STUCK_SCENE_STATUSES.has(s.status));
    for (const scene of stuck) {
      await updateScene(project.id, scene.sceneId, { status: 'pending' })
        .catch((e) => console.log(`⚠️ CD recovery: reset scene ${scene.sceneId} of ${project.id} failed: ${e.message}`));
    }
    if (stuck.length) {
      console.log(`🔄 CD recovery: ${project.id} reset ${stuck.length} stuck scene(s) to pending`);
    }
    advanceAfterSceneSettled(project.id)
      .catch((e) => console.log(`⚠️ CD recovery: advance for ${project.id} failed: ${e.message}`));
    resumed += 1;
  }
  console.log(`🔄 CD recovery: resumed ${resumed} in-flight project(s)`);
  return { resumed };
}
