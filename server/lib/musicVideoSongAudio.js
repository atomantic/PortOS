/**
 * Whether a project's song-derived state (beat grid and sections, lyric and
 * phrase timings) still belongs to the audio its linked track plays today.
 *
 * Replacing a track's audio in place (a new take of the same song) changes
 * `track.audioFilename` but not the project's `trackId`, so the link-change
 * invalidation in `applyProjectPatch` never fires. Each derived state records
 * the master filename it was computed from — `audioAnalysis.masterFilename`
 * and the project's `lyricTimingMasterFilename` — and this compares them with
 * the current master. A record that never stamped a filename (analyzed before
 * this existed) is "unknown", not stale: nothing can be said about it.
 */
import { ServerError } from './errorHandler.js';

const hasTimedLyrics = (project) => (project?.lyricCues || []).some((cue) => Number.isFinite(cue?.startSec) || (cue?.words || []).length > 0);

/**
 * `{ masterFilename, analysisStale, lyricsStale, analysisFrom, lyricsFrom }`
 * when the current master differs from what a derived state recorded, else null.
 */
export function songAudioChange(project, currentMasterFilename) {
  if (!project || !currentMasterFilename) return null;
  const analysisFrom = project.audioAnalysis?.masterFilename || null;
  const lyricsFrom = project.lyricTimingMasterFilename || null;
  const analysisStale = Boolean(analysisFrom) && analysisFrom !== currentMasterFilename;
  const lyricsStale = Boolean(lyricsFrom) && lyricsFrom !== currentMasterFilename && hasTimedLyrics(project);
  if (!analysisStale && !lyricsStale) return null;
  return { masterFilename: currentMasterFilename, analysisStale, lyricsStale, analysisFrom, lyricsFrom };
}

/** The refusal text a render shows while the song's timing predates its audio. */
export const songAudioChangeMessage = (change) => (change.analysisStale && change.lyricsStale
  ? 'The song audio was replaced after its beat grid and lyric timing were made'
  : change.analysisStale ? 'The song audio was replaced after its beat grid was made' : 'The song audio was replaced after its lyric timing was made')
  + '. Re-analyze and re-time it, or keep the old timing, before rendering.';

/** Refuse a render that would cut a replaced song against its previous beat grid or lyric timing. */
export function assertSongAudioCurrent(project, masterFilename) {
  const change = songAudioChange(project, masterFilename);
  if (change) throw new ServerError(songAudioChangeMessage(change), { status: 409, code: 'SONG_AUDIO_CHANGED', context: change });
}

/** The patch that adopts the current master as the basis of the timing the director chose to keep. */
export function keepSongTimingPatch(project, currentMasterFilename) {
  return {
    ...(project.audioAnalysis ? { audioAnalysis: { ...project.audioAnalysis, masterFilename: currentMasterFilename } } : {}),
    ...(project.lyricTimingMasterFilename ? { lyricTimingMasterFilename: currentMasterFilename } : {}),
  };
}
