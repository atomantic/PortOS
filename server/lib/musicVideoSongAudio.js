/**
 * Whether a project's song-derived state (beat grid and sections, lyric and phrase timings) still belongs to the audio its linked track plays today.
 *
 * `songAudioChange(project, currentMasterFilename)` says whether the beat grid (`audioAnalysis.masterFilename`) or lyric timing (`lyricTimingMasterFilename`) derived from an older file than the track plays now (a take replaced in place, #14793); `songAudioChangeMessage` is the render refusal text; `keepSongTimingPatch` adopts the current master as the kept timing's basis; `audioRevisionOf(projectOrRevision)` reads the audio-source revision a final render settles against (absent = 0, #15154). Replacing a track's audio in place changes `track.audioFilename` but not `trackId`, so `applyProjectPatch`'s link-change invalidation never fires; each derived state records its master filename and this compares. A record with no recorded filename (analyzed before this existed) is "unknown", not stale.
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

/** The project's audio revision (#15154), bumped by every audio-source change so a final render started against an older song can tell; a record predating the field, or a malformed value, is revision 0. */
export const audioRevisionOf = (value) => {
  const revision = value !== null && typeof value === 'object' ? value.audioRevision : value;
  return Number.isInteger(revision) && revision > 0 ? revision : 0;
};

/** The patch that adopts the current master as the basis of the timing the director chose to keep. */
export function keepSongTimingPatch(project, currentMasterFilename) {
  return {
    ...(project.audioAnalysis ? { audioAnalysis: { ...project.audioAnalysis, masterFilename: currentMasterFilename } } : {}),
    ...(project.lyricTimingMasterFilename ? { lyricTimingMasterFilename: currentMasterFilename } : {}),
  };
}
