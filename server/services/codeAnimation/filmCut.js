/** Final assembly publishes an accepted film to Media History, without Music Video finishing. */
import { randomUUID, createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PATHS } from '../../lib/paths.js';
import { generateThumbnail } from '../../lib/ffmpeg.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { mutateVideoHistory } from '../videoGen/history.js';
import { planBlenderFinal, readBlenderFilm } from '../film/film.js';
import { startBlenderCut } from '../film/cuts.js';
import { blenderRefusal } from '../film/workspace.js';
import { requireFilmProject } from './films.js';
import { mutateFilmProject } from './projectStore.js';
import { emitCodeAnimationChanged } from '../socket.js';

const digestFile = async (path) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
};

async function publishFilm(owner, output, plan, signal) {
  const project = await requireFilmProject(owner.id);
  const videoId = randomUUID();
  const filename = `film-${videoId}.mp4`;
  const destination = join(PATHS.videos, filename);
  await mkdir(PATHS.videos, { recursive: true });
  let thumbnail;
  let committed = false;
  try {
    signal?.throwIfAborted();
    await copyFile(output, destination, constants.COPYFILE_EXCL);
    thumbnail = await generateThumbnail(destination, videoId);
    if (!thumbnail) throw new Error('Film thumbnail generation failed');
    const accepted = { kind: 'film', videoId, filename, path: `/data/videos/${filename}`, thumbnail,
      format: { width: plan.width, height: plan.height, fps: plan.fps, durationSeconds: plan.durationSec },
      signature: plan.signature, renderHash: await digestFile(destination), acceptedAt: new Date().toISOString() };
    signal?.throwIfAborted();
    await withBackupAssetPublication(async () => {
      signal?.throwIfAborted();
      await mutateVideoHistory(history => {
        history.unshift({ id: videoId, filename, thumbnail, modelId: 'code-animation-film', prompt: project.title,
          ...accepted.format, durationSec: plan.durationSec, createdAt: accepted.acceptedAt, codeAnimation: { projectId: owner.id, kind: 'film' } });
        return history;
      });
      // The file is now referenced by history even if the subsequent project write fails.
      committed = true;
      await mutateFilmProject(owner.id, () => ({ acceptedOutput: accepted }));
    });
    emitCodeAnimationChanged(owner.id);
  } finally {
    if (!committed) {
      await rm(destination, { force: true });
      if (thumbnail) await rm(join(PATHS.videoThumbnails, thumbnail), { force: true });
    }
  }
}

export async function startFilmCut(owner, input) {
  if (input.animatic || input.filmLook) throw blenderRefusal('Review drafts and film look finishing belong to Music Video', 'VALIDATION_ERROR');
  const song = await owner.song();
  let finalPlan;
  let finalSignal;
  if (input.quality === 'final') finalPlan = planBlenderFinal(await readBlenderFilm(owner));
  return startBlenderCut(owner, { quality: input.quality, audioPath: song?.audio.master || null,
    finish: input.quality === 'final' ? async ({ film, assemble, signal }) => {
      finalSignal = signal;
      finalPlan = planBlenderFinal(film);
      return assemble();
    } : null,
    afterCut: input.quality === 'final' ? output => publishFilm(owner, output, finalPlan, finalSignal) : null,
  });
}
