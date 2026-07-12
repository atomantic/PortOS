import {
  importReferenceAudio,
  cancelReferenceAudioImport,
  referenceAudioImportEventsUrl,
} from '../services/apiRounds.js';
import useSseJobSlot from './useSseJobSlot.js';

/**
 * One round reference-audio-import job slot (#2120) — download + extract a
 * reference's audio from a URL via yt-dlp into the uploads dir, streaming SSE
 * progress. The deferred convenience path from the reference-audio analysis
 * feature (#2106); upload/mic capture remain the primary attach paths.
 *
 * A thin wrapper over the generic `useSseJobSlot` (#2368) — call it once per UI
 * surface that can independently kick off an import so each owns its own job +
 * SSE subscription (a shared slot would let a second kickoff orphan the first's
 * in-flight job).
 *
 * `onComplete(filename, context)` fires once the download lands a file in the
 * uploads dir — `context` is whatever was passed to `start(url, context)`,
 * captured at kickoff so a slow-finishing job still attaches to the right
 * target even if the caller's own state changed while it was in flight.
 */
export default function useReferenceAudioImport({ onComplete } = {}) {
  const { active, percent, stage, start, cancel } = useSseJobSlot({
    startRequest: (url) => importReferenceAudio(url, { silent: true }),
    eventsUrl: referenceAudioImportEventsUrl,
    cancelRequest: cancelReferenceAudioImport,
    trimStartArg: true,
    onComplete: (frame, context) => onComplete?.(frame.filename, context),
    successToast: () => 'Reference audio downloaded — Save the song to keep it',
    errorFallback: 'Reference audio download failed',
    canceledMessage: 'Reference audio download cancelled',
    lostConnectionMessage: 'Lost connection to the reference-audio download',
    startErrorFallback: 'Failed to start reference-audio download',
  });
  return { active, percent, stage, start, cancel };
}
