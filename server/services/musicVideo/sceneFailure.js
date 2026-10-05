/**
 * Persist a failed scene render on the scene (#10154).
 *
 * The scene image/video completion hooks call this from their `onTerminal`
 * handler. A `failed` job is recorded as `scene.lastFailure` and announced on
 * `musicVideoEvents` 'scene-failure'; a `canceled` job is the director's own
 * action, never a failure, and is ignored. A deleted project/scene 404s inside
 * `recordSceneFailure`, which the hook scaffold logs rather than throws.
 */

import { recordSceneFailure } from './projects.js';
import { musicVideoEvents } from './events.js';

export async function recordSceneLastFailure({ projectId, sceneId }, status, job, lane) {
  if (status !== 'failed') return;
  const scene = await recordSceneFailure(projectId, sceneId, { lane, error: job?.error });
  musicVideoEvents.emit('scene-failure', { projectId, sceneId, lastFailure: scene.lastFailure ?? null });
  console.log(`⚠️ music-video scene ${lane} failed ${projectId.slice(0, 8)}/${sceneId}: ${scene.lastFailure?.error}`);
}
