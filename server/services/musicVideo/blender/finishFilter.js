/**
 * What a Blender film's assembly paints over the joined shots, as the footage
 * encoder does at the same point: the project's color grade, and the timed
 * effects each Board scene sets on its cuts and at moments inside it (glitches,
 * gate jumps, shutter blinks, light leaks). The mirrored scenes carry the same
 * ids and times as the film's shots, so both builders read them unchanged.
 * Wipes need two pictures and are not drawn. Pure.
 */
import { musicVideoGradeFilter } from '../../../lib/musicVideoGrade.js';
import {
  mergeGlitchFrames, musicVideoTransitionFilter, sceneShotGlitchFrames, sceneTransitionSections, transitionGlitchFrames,
} from '../../../lib/musicVideoTransitions.js';

/**
 * The ffmpeg filter chain for the window `[startSec, endSec)` of the film at
 * `width`x`height`, or null when the project sets neither a grade nor a timed
 * effect there (the shots then join by stream copy, untouched).
 */
export function blenderFinishFilter(project, { width, height, fps, startSec = 0, endSec }) {
  const scenes = (project.scenes || []).filter((scene) => Number.isFinite(scene?.startSec) && Number.isFinite(scene?.endSec) && scene.endSec > scene.startSec);
  if (!scenes.length) return null;
  const songEnd = Math.max(...scenes.map((scene) => scene.endSec));
  const grade = musicVideoGradeFilter(project.composition?.grade,
    scenes.map(({ sceneId, startSec: from, endSec: to }) => ({ sceneId, startSec: from, endSec: to })),
    { fps, offsetSec: startSec, durationSec: endSec - startSec, frame: { width, height } });
  const cuts = sceneTransitionSections(scenes, fps, { endSec: songEnd, cameras: project.cameras });
  const first = Math.round(startSec * fps);
  const last = Math.round(endSec * fps);
  const glitches = mergeGlitchFrames(
    transitionGlitchFrames(cuts, { totalFrames: Math.round(songEnd * fps) }),
    sceneShotGlitchFrames(scenes, fps, { endSec: songEnd, cameras: project.cameras }),
  ).filter(({ frame }) => frame >= first && frame < last).map((glitch) => ({ ...glitch, frame: glitch.frame - first }));
  return [grade, musicVideoTransitionFilter(glitches, { width, height })].filter(Boolean).join(',') || null;
}
