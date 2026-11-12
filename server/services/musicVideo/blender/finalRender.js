/**
 * A Blender film in the Music Video render pipeline: the final video
 * (`POST /:id/render`) and song-window excerpts and proofs (`POST /:id/excerpt`).
 * render.js and excerptRender.js own the job, SSE, history and settling; these
 * are the `prepare` / `encode` steps they call for `composition.mode === 'blender'`.
 * Nothing renders here: the shot videos already exist and are joined with the song,
 * with the project's grade, timed shot effects and title card painted over the join.
 * `lookPass` tells an encode that the film look pass follows it: a steady title
 * card is then left out of the join and returned as `lookPassInputs` for that pass
 * to draw over the look (blenderTitleCardPlan).
 */
import { normalizeBlenderRecord } from '../../../lib/musicVideoBlender.js';
import { blenderScratchDir } from './workspace.js';
import { blenderNotSynced, planBlenderFinal, planBlenderWindow, readBlenderFilm } from './film.js';
import { blenderFinishFilter } from './finishFilter.js';
import { blenderLeadAudio } from './leadAudio.js';
import { blenderLeadSec, blenderSongEndSec } from './manifest.js';
import { assembleBlenderVideo } from './assemble.js';
import { blenderTitleCardPlan, withBlenderTitleCard } from './titleCard.js';
import { announceBlenderState } from './record.js';

/** The final render's plan; refuses (409) until every shot has a complete, current final render. */
export async function prepareBlenderFinal(project) {
  return planBlenderFinal(await readBlenderFilm(project));
}

/** Join the final shot videos with the master song into `outputPath`. */
export async function encodeBlenderFinal({ plan, project, projectId, jobId, audioPath, outputPath, signal, onProgress, lookPass = false }) {
  const { width, height, fps, segments, durationSec, boundaryTimes, signature } = plan;
  const film = await readBlenderFilm(project);
  const leadSec = blenderLeadSec(film.shots);
  const songEnd = leadSec > 0 ? blenderSongEndSec(film.shots) : durationSec;
  const { leadPath } = leadSec > 0 ? await blenderLeadAudio(project, film.shots, fps) : { leadPath: null };
  const window = { startSec: leadSec > 0 ? -leadSec : 0, endSec: songEnd };
  const card = blenderTitleCardPlan(project, { lookPass, filmEndSec: songEnd });
  await withBlenderTitleCard({ project, jobId, width, height, fps, ...window, filmEndSec: songEnd, bake: card.bake, signal }, (overlays) => assembleBlenderVideo({
    segments, width, height, fps, quality: 'final', overlays,
    filter: blenderFinishFilter(project, { width, height, fps, ...window }),
    audio: { path: audioPath, startSec: 0, ...(leadSec > 0 ? { leadSec, leadPath } : {}) },
    output: outputPath, scratch: blenderScratchDir(projectId, jobId), signal, onProgress,
  }));
  return {
    width, height, fps, durationSec, signature, leadSec,
    boundaryTimes: leadSec > 0 ? boundaryTimes.map((time) => time + leadSec) : boundaryTimes,
    lookPassInputs: { ...card.pass, ...(leadSec > 0 ? { offsetSec: -leadSec } : {}) },
  };
}

/**
 * Once the final is the project's final (`renderHistoryId === jobId`): record
 * which shot renders it was joined from, so a project read can tell when a
 * shot rendered since has left it behind (renderIndex.js `blenderFilmReadState`).
 */
export async function recordBlenderFinal({ projectId, jobId, encoded }) {
  const { mutateProjectRecord } = await import('../projects.js');
  await mutateProjectRecord(projectId, (current) => ({
    project: { ...current, blender: { ...normalizeBlenderRecord(current.blender), final: { jobId, signature: encoded.signature } } },
  }));
  // Open film panels read "the final is behind the shots" from the film state: it just changed.
  announceBlenderState(projectId);
}

/** What an excerpt needs before its window is known: the film, its length and its shots as song sections. */
export async function prepareBlenderExcerpt(project) {
  const film = await readBlenderFilm(project);
  if (!film.shots.length) throw blenderNotSynced();
  return {
    film,
    plan: { fps: film.settings.fps },
    totalSec: film.shots.length ? film.shots[film.shots.length - 1].end : 0,
    // The Board scenes mirror the film's shots, so a review note maps onto a shot through them.
    songSections: (project.scenes || [])
      .filter((scene) => scene?.sceneId && Number.isFinite(scene.startSec) && Number.isFinite(scene.endSec) && scene.endSec > scene.startSec)
      .map((scene) => ({ sceneId: scene.sceneId, startSec: scene.startSec, endSec: scene.endSec })),
  };
}

/** Refuse (409) a window holding a shot that has no video at all, before an excerpt record is made. */
export const assertBlenderExcerptWindow = ({ prepared, startSec, endSec }) => { planBlenderWindow(prepared.film, { startSec, endSec }); };

/** Cut `[startSec, endSec)` out of the best available shot videos, with the song for that window. */
export async function encodeBlenderExcerpt({ prepared, project, projectId, jobId, audioPath, outputPath, signal, startSec, endSec, onProgress, lookPass = false }) {
  const window = planBlenderWindow(prepared.film, { startSec, endSec });
  const { width, height, fps } = window;
  const span = { startSec: window.startSec, endSec: window.startSec + window.durationSec };
  const card = blenderTitleCardPlan(project, { lookPass, filmEndSec: prepared.totalSec });
  await withBlenderTitleCard({ project, jobId, width, height, fps, ...span, filmEndSec: prepared.totalSec, bake: card.bake, signal }, (overlays) => assembleBlenderVideo({
    segments: window.segments, width, height, fps, quality: 'final', overlays,
    filter: blenderFinishFilter(project, { width, height, fps, ...span }),
    audio: { path: audioPath, startSec: window.startSec }, output: outputPath, scratch: blenderScratchDir(projectId, jobId), signal, onProgress,
  }));
  const boundaryTimes = prepared.film.shots.map((shot) => shot.start - window.startSec).filter((time) => time > 0 && time < window.durationSec);
  return { width, height, fps, boundaryTimes: [0, ...boundaryTimes], lookPassInputs: card.pass };
}
