/**
 * One YouTube-audio-import job slot (#1945): start/cancel + SSE progress + terminal-frame handling via
 * `POST /api/tracks/import/youtube`.
 *
 * Returns `{ active, percent, start(url, context), cancel }`; `onComplete(track, context)` fires with
 * the finished Track. Call once per UI surface that can independently kick off an import — a shared
 * slot would let one surface's kickoff orphan another's in-flight job. Use when: Any picker that lets
 * a user paste a YouTube URL to create a Track (Music Video's create form and track-change row).
 */

import { importTrackFromYoutube, importTrackFromSuno, cancelTrackImport, trackImportEventsUrl } from '../services/apiTracks.js';
import { isSunoSongUrl } from '../../../server/lib/sunoSong.js';
import useSseJobSlot from './useSseJobSlot.js';

/**
 * One audio-import job slot (#1945) for a pasted YouTube or Suno song link (Suno imports title, lyrics and style): start/cancel + SSE progress + terminal-frame handling, a thin wrapper over `useSseJobSlot` (#2368). Call it once per UI surface that can independently kick off an import so each owns its own job and SSE subscription (a shared slot would let a second surface's kickoff orphan the first's in-flight job).
 * `onComplete(track, context)` fires once the import lands a Track; `context` is whatever was passed to `start(url, context)`, captured at kickoff so a slow job still attaches to the right target even if the caller's state changes meanwhile.
 */
export default function useYoutubeTrackImport({ onComplete } = {}) {
  const { active, percent, start, cancel } = useSseJobSlot({
    startRequest: (url) => (isSunoSongUrl(url) ? importTrackFromSuno : importTrackFromYoutube)(url, { silent: true }),
    eventsUrl: trackImportEventsUrl,
    cancelRequest: cancelTrackImport,
    trimStartArg: true,
    onComplete: (frame, context) => onComplete?.(frame.track, context),
    successToast: (frame) => (frame.reused
      ? 'Already in your library'
      : `Imported "${frame.track.title}" from ${frame.source === 'suno' ? 'Suno' : 'YouTube'}`),
    errorFallback: 'Audio import failed',
    canceledMessage: 'Audio import cancelled',
    lostConnectionMessage: 'Lost connection to the audio import — check the music library',
    startErrorFallback: 'Failed to start the audio import',
  });
  return { active, percent, start, cancel };
}
