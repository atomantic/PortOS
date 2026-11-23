/**
 * Import the linked track's lyric sheet onto a Music Video project.
 *
 * A track in the music library carries the song's lyrics as a plain sheet
 * with `[Verse]`/`[Chorus]` headers and stage directions. The project needs
 * them as lyric cues (the sung lines) plus lyric markers (the structure), and
 * nothing else reads them off the track once the project exists. The
 * director's "Use track lyrics" button replaces the lines; the autopilot
 * kickoff imports only when the project has no lines, so a re-run never
 * overwrites lines the director edited.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { getTrack } from '../tracks/index.js';
import { updateProject as updateProjectEdit } from './projectBoardEdits.js';
import { updateProject } from './projects.js';
import { requireProject } from './requireProject.js';
import { parseLyricCues } from './timedText.js';

export const MAX_LYRIC_CUES = 2000;

/**
 * @param {string} projectId
 * With `edit: true` the reply carries the edit result (`edit`, null when nothing was written) instead of the project.
 * @param {{ mode?: 'replace' | 'if-empty', edit?: boolean }} [options]
 * @returns {Promise<{ project?: object, edit?: object|null, imported: number, markers: number, skipped: string|null }>}
 */
export async function importTrackLyrics(projectId, { mode = 'replace', edit: answerEdit = false } = {}) {
  const project = await requireProject(projectId);
  const ifEmpty = mode === 'if-empty';
  const skip = (skipped) => ({ ...(answerEdit ? { edit: null } : { project }), imported: 0, markers: 0, skipped });
  if (ifEmpty && (project.lyricCues || []).length > 0) return skip('has-lyrics');
  if (!project.trackId) {
    if (ifEmpty) return skip('no-track');
    throw new ServerError('Link a track from the music library first', { status: 400, code: 'NO_TRACK' });
  }
  const track = await getTrack(project.trackId);
  if (!track) throw new ServerError('Linked track not found', { status: 404, code: 'NOT_FOUND' });
  const { cues, markers } = parseLyricCues(typeof track.lyrics === 'string' ? track.lyrics : '');
  if (cues.length === 0) {
    if (ifEmpty) return skip('no-track-lyrics');
    throw new ServerError('The linked track has no lyrics', { status: 422, code: 'NO_TRACK_LYRICS' });
  }
  if (cues.length > MAX_LYRIC_CUES) {
    throw new ServerError(`A project holds at most ${MAX_LYRIC_CUES} lyric cues`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const patch = { lyricCues: cues, lyricMarkers: markers };
  const updated = await (answerEdit ? updateProjectEdit(project.id, patch) : updateProject(project.id, patch));
  console.log(`🎼 Imported ${cues.length} track lyric lines (${markers.length} markers) into ${project.id}`);
  return { ...(answerEdit ? updated : { project: updated }), imported: cues.length, markers: markers.length, skipped: null };
}
