/** Copy a Production film into Music Video without starting analysis or a job. */
import { PATHS } from '../../lib/paths.js';
import { makePathResolver } from '../../lib/pathSafety.js';
import { UPLOAD_AUDIO_EXTENSIONS } from '../../lib/mimeTypes.js';
import { validateRequest } from '../../lib/validation.js';
import { promoteFilmSchema } from '../../lib/codeAnimationFilms.js';
import { normalizeBlenderRecord } from '../../lib/musicVideoBlender.js';
import { blenderRefusal } from '../film/workspace.js';
import { blenderFilmProblems, readBlenderManifest } from '../film/manifest.js';
import { requireFilmProject, codeAnimationFilmOwner } from './films.js';
import { mutateFilmProject } from './projectStore.js';
import { emitCodeAnimationChanged } from '../socket.js';

const audioPath = makePathResolver(() => PATHS.music, { extensions: UPLOAD_AUDIO_EXTENSIONS });

export async function promoteFilm(id, input) {
  const selection = validateRequest(promoteFilmSchema, input);
  const source = await requireFilmProject(id);
  const owner = await codeAnimationFilmOwner(id);
  let filename = selection.uploadedAudioFilename;
  let durationSec = null;
  if (selection.trackId) {
    const { getTrack } = await import('../tracks/index.js');
    const track = await getTrack(selection.trackId);
    if (!track || track.deletedAt) throw blenderRefusal('Track not found', 'NOT_FOUND', 404);
    filename = track.audioFilename;
    if (Number.isFinite(track.durationSec) && track.durationSec > 0) durationSec = track.durationSec;
  }
  if (!filename || !audioPath(filename)) throw blenderRefusal('Audio file not found in the Music library', 'AUDIO_MISSING', 404);
  const manifest = await readBlenderManifest(owner);
  const { settings } = normalizeBlenderRecord(source.film);
  const coverageProblems = manifest ? blenderFilmProblems(manifest, { fps: settings.fps, durationSec })
    : ['Sync shots from scripts after analyzing the song: no shot manifest has been saved yet.'];
  const { createProjectFromFilm, deleteProject } = await import('../musicVideo/projects.js');
  const project = await createProjectFromFilm({ ...selection, name: selection.name || source.title,
    composition: { mode: 'blender' } }, owner, settings);
  // Merge only lineage under the source row lock; preserve concurrent source edits.
  const sourceProject = await mutateFilmProject(id, () => ({ promotedTo: project.id })).catch(async error => {
    const { removeBlenderFilmCopy } = await import('../film/fork.js');
    const { musicVideoFilmOwner } = await import('../musicVideo/blender/owner.js');
    await Promise.all([deleteProject(project.id), removeBlenderFilmCopy(musicVideoFilmOwner(project.id))]);
    throw error;
  });
  emitCodeAnimationChanged(id);
  return { project, sourceProject, needsAnalysis: true, needsSync: true,
    coverageDurationSec: durationSec, coverageProblems,
    nextSteps: ['Analyze the song in Music Video.', 'Sync shots from scripts against the analyzed song length; adjust any gaps or shots past the song end.'] };
}
