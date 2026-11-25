/**
 * Music Video seeked renderers: the one registry of the modes that draw a
 * seekable composition (a Blender film, an Eidoverse video, code, a composition
 * document) instead of concatenating footage.
 *
 * A final render is the same encode as an excerpt whose window is the whole
 * song, so each mode is defined once here and both `render.js` (final) and
 * `excerptRender.js` (draft excerpts, social cuts, the publish kit's native cut)
 * read it. "Draft equals final" therefore holds by construction: a window is an
 * explicit parameter of `encode`, not a second copy of the mode.
 */

import { documentSceneVisualLayer } from '../../lib/musicVideo/musicVideoLayers.js';
import { encodeCodeComposition, prepareCodeRender } from './codeRender.js';
import { documentRenderInitScripts, encodeDocumentComposition, prepareDocumentRender } from './documentRender.js';
import { assertCurrentPerformanceTakes, withDraftPerformanceFallbacks } from './performanceShot.js';
import { resolveMasterAudioPath } from './masterAudioPath.js';

const sectionsOf = (list) => (list || [])
  .filter((s) => s?.sceneId && typeof s.startSec === 'number' && typeof s.endSec === 'number' && s.endSec > s.startSec);

/**
 * Entry contract.
 * - `prepare(project, { windowed })` -> `{ plan, totalSec, songSections, ... }`. `windowed` is true for an
 *   excerpt, which a Blender film prepares without needing every shot's final render.
 * - `encode({ prepared, project, projectId, jobId, audioPath, soundBed, outputPath, signal, onProgress,
 *   lookPass, window?: { startSec, endSec }, fade?, videoArgs? })`: an absent `window` is the whole song.
 * Flags: `fixedFrame` (cannot re-lay-out at another aspect), `filmLookFinish` (film look is a finishing pass),
 * `filmLookInPage` (the page draws the look, so the outro does too), `soundBed`, `performanceTakes`.
 */
export const SEEKED_RENDERERS = Object.freeze({
  // The final shot videos joined with the song; its frame is the film's own.
  blender: {
    label: 'Blender film', modelId: 'music-video-blender', fixedFrame: true, filmLookFinish: true,
    prepare: async (project, { windowed = false } = {}) => {
      const mod = await import('./blender/finalRender.js');
      if (windowed) return mod.prepareBlenderExcerpt(project);
      const plan = await mod.prepareBlenderFinal(project);
      return { plan, totalSec: plan.durationSec, songSections: [] };
    },
    assertWindow: async (input) => (await import('./blender/finalRender.js')).assertBlenderExcerptWindow(input),
    encode: async ({ prepared, window, ...input }) => {
      const mod = await import('./blender/finalRender.js');
      return window
        ? mod.encodeBlenderExcerpt({ ...input, prepared, startSec: window.startSec, endSec: window.endSec })
        : mod.encodeBlenderFinal({ ...input, plan: prepared.plan });
    },
    recordFinal: async (input) => (await import('./blender/finalRender.js')).recordBlenderFinal(input),
  },
  eidoverse: {
    label: 'Eidoverse Video', modelId: 'music-video-eidoverse',
    prepare: async (project) => {
      const plan = await (await import('./eidoverseRender.js')).prepareEidoverseRender(project);
      return { plan, totalSec: plan.durationSec, songSections: sectionsOf(project.scenes).map((s) => ({ sceneId: s.sceneId, startSec: s.startSec, endSec: s.endSec })) };
    },
    encode: async ({ prepared, window, ...input }) => (await import('./eidoverseRender.js')).encodeEidoverseComposition({
      ...input, plan: prepared.plan, windowStart: window?.startSec, windowEnd: window?.endSec,
    }),
  },
  code: {
    label: 'code', modelId: 'music-video-code', filmLookInPage: true,
    prepare: async (project) => {
      const plan = prepareCodeRender(project);
      return { plan, totalSec: plan.durationSec, songSections: plan.song.sections.map((s) => ({ sceneId: s.sceneId || s.id, startSec: s.startSec, endSec: s.endSec })) };
    },
    // The same init scripts (film look, title card, wipes, glitches, colour match) as the final, windowed or not.
    encode: async ({ prepared, project, projectId, jobId, audioPath, outputPath, signal, onProgress, window, fade, videoArgs }) => {
      const plan = window ? prepareCodeRender(project, { windowStart: window.startSec, windowEnd: window.endSec }) : prepared.plan;
      await encodeCodeComposition({
        ...plan, audioPath, audioStartSec: window?.startSec ?? 0, outputPath, directory: `compositions/music-video/${projectId}/${jobId}`,
        signal, onProgress, fade, videoArgs, initScripts: documentRenderInitScripts(project),
      });
      return { width: plan.width, height: plan.height, fps: plan.fps, durationSec: plan.durationSec, boundaryTimes: plan.sectionTimes };
    },
  },
  document: {
    label: 'composition document', modelId: 'music-video-document', filmLookInPage: true, soundBed: true,
    // A document draws the scenes' selected takes, so it runs the same performance-take gate as a footage render (#9266).
    performanceTakes: true,
    prepare: async (project) => {
      const plan = await prepareDocumentRender(project);
      const generated = project.composition?.document?.source?.kind === 'generated';
      const songSections = sectionsOf(project.scenes)
        .map((s) => ({ sceneId: s.sceneId, layer: documentSceneVisualLayer(project, s, { generated }), startSec: s.startSec, endSec: s.endSec }));
      return { plan, totalSec: plan.durationSec, songSections };
    },
    encode: ({ prepared, project, jobId, audioPath, soundBed, outputPath, signal, onProgress, window, fade, videoArgs }) => encodeDocumentComposition({
      project, plan: prepared.plan, jobId, audioPath, soundBed, outputPath, signal, onProgress,
      ...(window ? { windowStart: window.startSec, windowEnd: window.endSec, collectFootageVisibility: true } : {}), fade, videoArgs,
    }),
  },
});

/** The seeked renderer for a project's render mode, or null for footage modes. */
export const seekedRendererFor = (project) => SEEKED_RENDERERS[project?.composition?.mode] || null;

/**
 * The master audio, the sound bed and the project to draw, after the performance-take gate.
 * `draft` lets a stale performance shot draw as a cutaway (the excerpt still records the real
 * selection); `checkAudio(audioPath)` is the caller's extra freshness check on the resolved master.
 * A missing master throws here, before any render is marked running.
 */
export async function resolveSeekedInputs(renderer, project, { resolveAudio = resolveMasterAudioPath, draft = false, checkAudio } = {}) {
  const audioPath = await resolveAudio(project);
  checkAudio?.(audioPath);
  const drawn = renderer.performanceTakes && draft ? await withDraftPerformanceFallbacks(project, audioPath) : project;
  if (renderer.performanceTakes) await assertCurrentPerformanceTakes(drawn, audioPath);
  // Lazy: renderPlan.js pulls the footage planner, which only a sound-bed mode needs here.
  const soundBed = renderer.soundBed ? await (await import('./renderPlan.js')).resolveSoundBedPath(project) : null;
  return { audioPath, soundBed, drawn };
}
