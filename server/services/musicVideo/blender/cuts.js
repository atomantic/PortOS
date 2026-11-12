/** Music Video finishing and review-draft publication wrap the shared engine join. */
import { copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { requireProject } from '../requireProject.js';
import { blenderRefusal } from './workspace.js';
import { blenderNotSynced, readBlenderFilm } from './film.js';
import { blenderFinishFilter } from './finishFilter.js';
import { blenderTitleCardPlan, withBlenderTitleCard } from './titleCard.js';
import { requireFfmpeg } from './encode.js';
import { updateBlenderJob } from './jobs.js';
import { startBlenderCut as startCut } from '../../film/cuts.js';
import { musicVideoFilmOwner } from './owner.js';
export const BLENDER_CUT_ARTIFACT_TITLE = 'Blender cut';
// The review draft is the newest version of one animatic artifact, so each
// published cut replaces the last in Review instead of piling up beside it.
async function publishReviewDraft(projectId, cutPath) {
  const [{ importDevArtifact }, project] = await Promise.all([import('../devArtifactService.js'), requireProject(projectId)]);
  const existing = (project.devArtifacts || []).find((artifact) => !artifact.deleted && artifact.kind === 'animatic' && artifact.title === BLENDER_CUT_ARTIFACT_TITLE);
  // importDevArtifact consumes the file it is given, so it gets a copy.
  const upload = `${cutPath}.review.mp4`;
  await copyFile(cutPath, upload);
  await importDevArtifact(projectId, {
    tempPath: upload, originalName: 'blender-cut.mp4', kind: 'animatic', title: BLENDER_CUT_ARTIFACT_TITLE,
    ...(existing ? { artifactId: existing.id } : {}),
  });
}

// The finishing pass is the footage renders' own (filmLookFinish.js); loaded only when asked for.
async function filmLookPass(project, wanted) {
  if (!wanted) return { finishNeeded: false, lookPass: null };
  const { applyFilmLookFinish, filmLookFinishNeeded } = await import('../filmLookFinish.js');
  return { finishNeeded: filmLookFinishNeeded(project), lookPass: applyFilmLookFinish };
}

export async function startBlenderCut(projectId, { quality, animatic = false, filmLook = false }) {
  const project = await requireProject(projectId);
  await requireFfmpeg();
  if (!(await readBlenderFilm(project)).shots.length) throw blenderNotSynced();
  const { resolveProjectAudioPath } = await import('../projectAudio.js');
  const audioPath = await resolveProjectAudioPath(project);
  if (!existsSync(audioPath)) throw blenderRefusal("The project's song file is missing", 'AUDIO_MISSING', 404);
  return startCut(musicVideoFilmOwner(projectId), {
    quality, audioPath,
    afterCut: animatic ? (output) => publishReviewDraft(projectId, output) : null,
    async finish({ entry, film, plan, output, signal, log, progress, assemble }) {
      const project = await requireProject(projectId);
      const { finishNeeded, lookPass } = await filmLookPass(project, filmLook);
      const frame = { width: plan.width, height: plan.height, fps: plan.fps, startSec: 0, endSec: film.shots[film.shots.length - 1].end };
      const card = blenderTitleCardPlan(project, { lookPass: finishNeeded, filmEndSec: frame.endSec });
      const { durationSec } = await withBlenderTitleCard({ project, jobId: entry.job.id, ...frame, bake: card.bake, signal }, (overlays) => {
        if (overlays.length) log.write('PortOS: title card over the cut');
        return assemble({ overlays, filter: blenderFinishFilter(project, frame), onProgress: progress(0, finishNeeded ? 0.5 : 1) });
      });
      if (finishNeeded) {
        updateBlenderJob(entry, { status: 'encoding' });
        log.write(card.bake ? 'PortOS: film look pass' : 'PortOS: film look pass, with the steady title card over it');
        await lookPass({ project, path: output, jobId: entry.job.id, signal, label: 'Blender cut film look', ...card.pass, onProgress: progress(0.5, 1) })
          .catch(async (error) => { await rm(output, { force: true }); throw error; });
      }

      return { durationSec, filmLook: finishNeeded };
    },
  });
}
