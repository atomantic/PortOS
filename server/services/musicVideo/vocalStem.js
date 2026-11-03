/**
 * Music Video vocal-stem conditioning (#8977).
 *
 * A performance shot conditions the lip-sync provider on a slice of the song.
 * The full mix carries drums, bass and pads that can pull mouth motion off the
 * vocal, so the director may attach an isolated VOCAL STEM: a full-length
 * bounce of the vocal from the same session as the master. Performance slices
 * are then cut from the stem, at the same song times, instead of the mix.
 *
 * The stem conditions generation only. The master stays the project's audio:
 * the final render, the beat grid, the lyric cues and the staleness check on
 * a performance take all still read the master.
 *
 * A stem is only useful if it shares the master's timebase. Song time T in
 * the stem must be song time T in the master. The check that can be made
 * without guessing is duration: a stem bounced from the same session is the
 * master's length to within an encoder frame or two. A trimmed, offset or
 * different-edit stem is refused, both when attached and again at every
 * submission. A leading offset inside an equal-length file cannot be detected
 * this way, which is why the UI asks for a full-length bounce from zero.
 *
 * A stem also records the master file it was checked against
 * (`vocalStemMasterFilename`). A linked track's audio can be replaced in place
 * (a new Suno take uploaded to the track) without the project's `trackId`
 * changing, so the invalidation in applyProjectPatch never runs; the recorded
 * filename is what tells a stem of the old song from one of the current song.
 * A stem demucs split from that exact master (`vocalStemDerived`) shares its
 * timebase by construction, so its length is not compared: a container's
 * duration is only an estimate for some files (a VBR MP3 without a seek
 * header) and would refuse a stem that is in fact sample-aligned.
 *
 * The stem file lives in the shared music library (like an uploaded master),
 * so it federates through the project's `music` asset manifest.
 */

import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import { basename, join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { assertFileNotMediaManifest, PATHS } from '../../lib/fileUtils.js';
import { probeVideoDuration, safeUnder } from '../../lib/ffmpeg.js';
import { importUploadedTrack } from '../pipeline/musicLibrary.js';
import { getProject, updateProject } from './projects.js';
import { CLEARED_VOCAL_STEM } from './projectsLogic.js';
import { requireProject } from './requireProject.js';

// A same-session bounce differs from the master by encoder padding at most
// (an MP3 frame is ~26ms); a tenth of a second admits that and nothing that
// would move a syllable onto the wrong frame.
export const VOCAL_STEM_TIMEBASE_TOLERANCE_SEC = 0.1;

/**
 * Refuse a stem whose length does not match the master's.
 */
export function assertVocalStemTimebase(stemSec, songSec) {
  if (stemSec == null || songSec == null) {
    throw new ServerError('Could not read the vocal stem or song duration', { status: 400, code: 'MUSIC_VIDEO_VOCAL_STEM_UNREADABLE' });
  }
  if (Math.abs(stemSec - songSec) > VOCAL_STEM_TIMEBASE_TOLERANCE_SEC) {
    throw new ServerError(
      `The vocal stem is ${stemSec.toFixed(3)}s but the song is ${songSec.toFixed(3)}s. A stem must be a full-length bounce from the same session, starting at 0:00, so its timing matches the song. Use Separate vocals to make one from this song, or remove the stem.`,
      { status: 400, code: 'MUSIC_VIDEO_VOCAL_STEM_TIMEBASE' },
    );
  }
}

/** True when the stem was made from a song file other than the current master. */
export function vocalStemMasterChanged(project, masterPath) {
  const recorded = project?.vocalStemMasterFilename;
  return Boolean(project?.vocalStemFilename && recorded && masterPath && recorded !== basename(masterPath));
}

/**
 * Refuse a stem that does not belong to the current master: one made from an
 * earlier song file, or (when not split from this master) one whose length
 * does not match. `stemSec` is only read when the length is compared.
 */
export async function assertVocalStemMatchesSong(project, { masterPath, songSec, probeStemSec }) {
  if (vocalStemMasterChanged(project, masterPath)) {
    throw new ServerError(
      'The song changed after this vocal stem was made, so its timing belongs to the old song. Use Separate vocals to make one from the new song, or remove the stem.',
      { status: 409, code: 'MUSIC_VIDEO_VOCAL_STEM_STALE' },
    );
  }
  if (project.vocalStemDerived === true && project.vocalStemMasterFilename) return;
  assertVocalStemTimebase(await probeStemSec(), songSec);
}

/**
 * Absolute path of the project's vocal stem, or null when none is attached.
 * Throws when the record names a stem whose file is gone or unsafe, rather
 * than quietly conditioning on the full mix.
 */
export function resolveVocalStemPath(project) {
  const filename = project?.vocalStemFilename;
  if (!filename) return null;
  const safe = safeUnder(PATHS.music, filename);
  if (!safe || !existsSync(safe)) {
    throw new ServerError('The project\'s vocal stem file is missing. Attach it again or remove it.', { status: 404, code: 'MUSIC_VIDEO_VOCAL_STEM_MISSING' });
  }
  return safe;
}

const audioSourceKey = (project) => `${project?.trackId ?? ''}\u0000${project?.uploadedAudioFilename ?? ''}`;

/**
 * Attach an uploaded vocal stem to a project after checking its timebase
 * against the current master. The temp upload is always removed.
 */
export async function attachVocalStem(projectId, { tempPath, originalName, derived = false }) {
  try {
    const project = await requireProject(projectId);
    // Before the probe: ffmpeg would follow a playlist posing as audio.
    await assertFileNotMediaManifest(tempPath);
    // Lazy: render.js pulls the whole render pipeline.
    const { resolveMasterAudioPath } = await import('./render.js');
    const masterPath = await resolveMasterAudioPath(project);
    if (!derived) {
      const [songSec, stemSec] = await Promise.all([probeVideoDuration(masterPath), probeVideoDuration(tempPath)]);
      assertVocalStemTimebase(stemSec, songSec);
    }
    return await withBackupAssetPublication(async () => {
      const { filename } = await importUploadedTrack(tempPath, originalName);
      // The song may have been swapped while the files were probed; a stem
      // checked against the old master must not land on the new one.
      const current = await getProject(projectId);
      if (!current || audioSourceKey(current) !== audioSourceKey(project)) {
        await unlink(join(PATHS.music, filename)).catch(() => {});
        throw new ServerError('The project\'s song changed while the vocal stem was uploading. Upload it again.', { status: 409, code: 'MUSIC_VIDEO_AUDIO_CHANGED' });
      }
      return updateProject(projectId, {
        vocalStemFilename: filename,
        vocalStemMasterFilename: basename(masterPath),
        vocalStemDerived: derived === true,
        performanceConditioningSource: 'vocal-stem',
      });
    });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/**
 * Stop conditioning on a stem. The library file stays, as with a track's
 * audio, because the library is shared.
 */
export async function detachVocalStem(projectId) {
  await requireProject(projectId);
  return updateProject(projectId, { ...CLEARED_VOCAL_STEM, performanceConditioningSource: 'master' });
}
