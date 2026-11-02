// The document preview and export share this song clock.
export const DOCUMENT_RENDER_FPS = 24;
const SONG_CAP_SEC = 900;

/** The song length the document is timed against (analysis first). */
export function documentSongDuration(project) {
  const duration = project?.audioAnalysis?.durationSec;
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? Math.min(duration, SONG_CAP_SEC) : null;
}

/** Whole frames that fit inside the song at `fps` (the contract ceiling). */
export function documentRenderClock(songDurationSec, fps = DOCUMENT_RENDER_FPS) {
  const frames = Math.max(0, Math.floor(songDurationSec * fps + 1e-6));
  return { fps, frames, durationSec: frames / fps };
}
