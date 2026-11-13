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
import { requireFilmProject, filmSnapshotOwner } from './films.js';
import { getBlenderSong } from '../film/song.js';
import { mutateFilmProject } from './projectStore.js';
import { emitCodeAnimationChanged } from '../socket.js';

const digestFile = async (path) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
};

async function publishFilm(owner, output, plan, song, signal) {
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
      await mutateFilmProject(owner.id, async current => {
        const snapshot = filmSnapshotOwner(owner, current);
        const currentPlan = planBlenderFinal(await readBlenderFilm(snapshot));
        const currentSong = await getBlenderSong(snapshot, current.film.settings);
        if (JSON.stringify(currentPlan) !== JSON.stringify(plan) || JSON.stringify(currentSong) !== JSON.stringify(song)) {
          throw blenderRefusal('Film inputs changed during assembly; assemble the final again', 'FILM_INPUTS_CHANGED', 409);
        }
        await mutateVideoHistory(history => {
          history.unshift({ id: videoId, filename, thumbnail, modelId: 'code-animation-film', prompt: project.title,
            ...accepted.format, durationSec: plan.durationSec, createdAt: accepted.acceptedAt, codeAnimation: { projectId: owner.id, kind: 'film' } });
          return history;
        });
        // History now owns the file even if the subsequent project commit fails.
        committed = true;
        return { acceptedOutput: accepted };
      });
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
  let finalPlan;
  let finalSong;
  let finalSignal;
  if (input.quality === 'final') planBlenderFinal(await readBlenderFilm(owner));
  return startBlenderCut(owner, { quality: input.quality,
    finish: async ({ assemble, signal }) => {
      const project = await requireFilmProject(owner.id);
      const snapshot = filmSnapshotOwner(owner, project);
      const song = await getBlenderSong(snapshot, project.film.settings);
      if (input.quality === 'final') {
        finalSignal = signal;
        finalPlan = planBlenderFinal(await readBlenderFilm(snapshot));
        finalSong = song;
      }
      return assemble({ ...(finalPlan ? { segments: finalPlan.segments, width: finalPlan.width, height: finalPlan.height, fps: finalPlan.fps } : {}),
        audio: song.audio.master ? { path: song.audio.master, startSec: 0 } : null });
    },
    afterCut: input.quality === 'final' ? output => publishFilm(owner, output, finalPlan, finalSong, finalSignal) : null,
  });
}
