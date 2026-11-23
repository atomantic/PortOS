/**
 * One round reference-audio-import job slot (#2120): start/cancel + SSE progress + terminal-frame
 * handling via `POST /api/rounds/reference-audio/import`.
 *
 * Returns `{ active, percent, stage, start(url, context), cancel }`; `onComplete(filename, context)`
 * fires with the uploads-dir filename to persist on the reference. Call once per surface that can
 * independently kick off a download. Use when: The reference-audio attach controls
 * (`ReferenceAudioAttach`) — the "Download from URL" convenience.
 */

import {
  importReferenceAudio,
  cancelReferenceAudioImport,
  referenceAudioImportEventsUrl,
} from '../../services/apiRounds.js';
import useSseJobSlot from '../../hooks/useSseJobSlot.js';

/**
 * One round reference-audio-import job slot (#2120): download + extract a reference's audio from a URL via yt-dlp into the uploads dir, streaming SSE progress (the deferred convenience path from #2106; upload/mic capture remain primary).
 * A thin wrapper over `useSseJobSlot` (#2368): call it once per UI surface that can independently kick off an import so each owns its own job + SSE subscription (a shared slot would let a second kickoff orphan the first's in-flight job).
 * `onComplete(filename, context)` fires once the download lands a file; `context` is whatever was passed to `start(url, context)`, captured at kickoff so a slow job still attaches to the right target. `target` is `{ roundId, referenceId }` for an already-saved reference (null for an unsaved draft row), read at each kickoff; the server attaches the finished file itself (#9943), so `onComplete` only mirrors it into the editor draft.
 */
export default function useReferenceAudioImport({ onComplete, target = null } = {}) {
  const { active, percent, stage, start, cancel } = useSseJobSlot({
    startRequest: (url) => importReferenceAudio(url, { ...target, silent: true }),
    eventsUrl: referenceAudioImportEventsUrl,
    cancelRequest: cancelReferenceAudioImport,
    trimStartArg: true,
    onComplete: (frame, context) => onComplete?.(frame.filename, context),
    successToast: (frame) => (frame.attached
      ? 'Reference audio downloaded and attached'
      : 'Reference audio downloaded — Save the song to keep it'),
    errorFallback: 'Reference audio download failed',
    canceledMessage: 'Reference audio download cancelled',
    lostConnectionMessage: 'Lost connection to the reference-audio download',
    startErrorFallback: 'Failed to start reference-audio download',
  });
  return { active, percent, stage, start, cancel };
}
