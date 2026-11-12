/**
 * What a Blender film's assembly paints over the joined shots, as the footage
 * encoder does at the same point: the project's color grade, fades through
 * black on the cuts, and the timed effects each Board scene sets on its cuts
 * and at moments inside it (glitches, gate jumps, shutter blinks, light leaks).
 * Dissolves and beat toggles join handles per segment (film.js / assemble.js);
 * wipes need no extra handle here and stay undrawn. Pure.
 */
import { blenderCutEffects, plannedTransitions, sceneCutEffect } from '../../../lib/musicVideoCutEffects.js';
import { musicVideoGradeFilter } from '../../../lib/musicVideoGrade.js';
import {
  mergeGlitchFrames, musicVideoTransitionFilter, sceneShotGlitchFrames, sceneTransitionSections, transitionGlitchFrames,
} from '../../../lib/musicVideoTransitions.js';

function fadeBlackFilters(scenes, storyboardRows, { fps, first, last }) {
  const planned = plannedTransitions(storyboardRows);
  const sorted = [...scenes].sort((a, b) => a.startSec - b.startSec);
  const effects = blenderCutEffects(sorted.map((scene) => ({
    id: scene.sceneId,
    startFrame: Math.round(scene.startSec * fps),
    endFrame: Math.round(scene.endSec * fps),
    cutEffect: sceneCutEffect(scene, planned.get(scene.sceneId)),
  })), { fps }).filter((effect) => effect.style === 'fade-black');
  const filters = [];
  for (const { cutFrame, outFrames, inFrames } of effects) {
    if (outFrames > 0 && cutFrame > first && cutFrame - outFrames < last) {
      const start = Math.max(first, cutFrame - outFrames);
      const from = start - first;
      const count = cutFrame - start;
      filters.push(`fade=t=out:s=${from}:n=${count}:enable='between(n,${from},${from + count - 1})'`);
    }
    if (inFrames > 0 && cutFrame + inFrames > first && cutFrame < last) {
      const start = Math.max(first, cutFrame);
      const from = start - first;
      const count = cutFrame + inFrames - start;
      filters.push(`fade=t=in:s=${from}:n=${count}:enable='between(n,${from},${from + count - 1})'`);
    }
  }
  return filters;
}

/**
 * The ffmpeg filter chain for the window `[startSec, endSec)` of the film at
 * `width`x`height`, or null when the project sets neither a grade, fade-through-black
 * nor a timed effect there (the shots then join by stream copy, untouched).
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
  const fades = fadeBlackFilters(scenes, project.productionReview?.draft?.storyboard, { fps, first, last });
  return [grade, musicVideoTransitionFilter(glitches, { width, height }), ...fades].filter(Boolean).join(',') || null;
}
