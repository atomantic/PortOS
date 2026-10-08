import { importTrackFromYoutube, importTrackFromSuno, cancelTrackImport, trackImportEventsUrl } from '../services/apiTracks.js';
import { isSunoSongUrl } from '../../../server/lib/sunoSong.js';
import useSseJobSlot from './useSseJobSlot.js';

/**
 * One audio-import job slot (#1945) for a pasted YouTube or Suno song link —
 * a Suno link imports the song with its title, lyrics and style — start/cancel + SSE progress +
 * terminal-frame handling. A thin wrapper over the generic `useSseJobSlot`
 * (#2368); call it once per UI surface that can independently kick off an import
 * (e.g. the create form and an existing project's track picker) so two surfaces
 * each own their own job and SSE subscription — a single shared slot would let a
 * second surface's kickoff silently orphan the first surface's in-flight job (its
 * SSE subscription would never re-attach).
 *
 * `onComplete(track, context)` fires once the import lands a Track — `context`
 * is whatever was passed to `start(url, context)`, captured at kickoff time so
 * a slow-finishing job still attaches to the right target even if the caller's
 * own state (e.g. which project is selected) changes while it's in flight.
 */
export default function useYoutubeTrackImport({ onComplete } = {}) {
  const { active, percent, start, cancel } = useSseJobSlot({
    startRequest: (url) => (isSunoSongUrl(url) ? importTrackFromSuno : importTrackFromYoutube)(url, { silent: true }),
    eventsUrl: trackImportEventsUrl,
    cancelRequest: cancelTrackImport,
    trimStartArg: true,
    onComplete: (frame, context) => onComplete?.(frame.track, context),
    successToast: (frame) => `Imported "${frame.track.title}" from ${frame.source === 'suno' ? 'Suno' : 'YouTube'}`,
    errorFallback: 'Audio import failed',
    canceledMessage: 'Audio import cancelled',
    lostConnectionMessage: 'Lost connection to the audio import — check the music library',
    startErrorFallback: 'Failed to start the audio import',
  });
  return { active, percent, start, cancel };
}
