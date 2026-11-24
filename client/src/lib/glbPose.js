/**
 * Pose a loaded GLB by seeking its clips: `createGlbPoser(scene, animations)` returns `{ seek(pose), dispose() }`.
 *
 * `pose` is `{ [clipName]: 0-1 }`, each a fraction of that clip. Every named clip plays paused at its own time on one
 * mixer. The clips a Blender model exports key disjoint nodes (one bone each), so they add up without blending. The
 * scene is drei's shared cached one: dispose puts it back as it loaded.
 */
import { AnimationMixer, LoopOnce } from 'three';

export function createGlbPoser(scene, animations) {
  const mixer = new AnimationMixer(scene);
  const clips = new Map(animations.map((clip) => [clip.name, clip]));
  return {
    seek(pose) {
      for (const [name, value] of Object.entries(pose)) {
        const clip = clips.get(name);
        if (!clip) continue;
        const action = mixer.clipAction(clip);
        action.setLoop(LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        action.paused = true;
        action.time = Math.min(1, Math.max(0, value)) * clip.duration;
      }
      mixer.update(0);
      scene.updateMatrixWorld(true);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    },
  };
}
