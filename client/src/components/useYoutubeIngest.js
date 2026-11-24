/**
 * One YouTube brain-ingest job slot: start/cancel + SSE progress + terminal-frame handling via `POST
 * /api/brain/youtube/ingest`.
 *
 * Returns `{ active, percent, stage, start(body), cancel }` — `start` takes the whole payload (`{ url,
 * captureTranscript, downloadVideo, ingestAudio, note, agentPrompt, tags }`), not a bare URL.
 * `onComplete(ingest)` fires with the stored ingest record; non-fatal `warnings[]` on the terminal
 * frame are toasted automatically. Use when: Quick Capture's YouTube path, and any other surface that
 * ingests a video into the brain.
 */

import toast from './ui/Toast';
import { startYoutubeIngest, cancelYoutubeIngest, listActiveYoutubeIngests, youtubeIngestEventsUrl } from '../services/apiBrain.js';
import useSseJobSlot from '../hooks/useSseJobSlot.js';

// Context of an ingest an earlier page started.
const REATTACHED = Object.freeze({ reattached: true });

/**
 * One YouTube brain-ingest job slot — start/cancel + SSE progress + terminal
 * frames via `POST /api/brain/youtube/ingest`. A thin wrapper over the generic
 * `useSseJobSlot`, like the video-download and track-import hooks.
 *
 * `start(body)` takes the whole ingest payload (`{ url, captureTranscript,
 * downloadVideo, ingestAudio, note, agentPrompt, tags }`) rather than a bare URL, so
 * `trimStartArg` stays false and the payload passes through untouched.
 *
 * An ingest still running when the surface mounts is adopted, so leaving the page
 * loses neither its progress, its Cancel control nor its warnings.
 *
 * `onKickoffError(err, body)` / `onKickoffSuccess(jobId, body)` hand the host the
 * rejected (or acknowledged) payload so it can keep a failed one recoverable.
 *
 * Non-fatal outcomes (no captions, a duplicate review task) ride along on the
 * terminal `complete` frame as `warnings[]` — the hook only ever sees the
 * terminal payload, so a live-only warning frame would be lost.
 */
export default function useYoutubeIngest({ onComplete, onKickoffError, onKickoffSuccess } = {}) {
  const { active, percent, stage, start, cancel } = useSseJobSlot({
    startRequest: (body) => startYoutubeIngest(body, { silent: true }),
    eventsUrl: youtubeIngestEventsUrl,
    cancelRequest: cancelYoutubeIngest,
    findActive: () => listActiveYoutubeIngests({ silent: true })
      .then(({ jobs }) => (jobs?.[0] ? { jobId: jobs[0].jobId, context: REATTACHED } : null)),
    onComplete: (frame, context) => {
      for (const message of frame.warnings || []) toast.info(message);
      // The form's fields belong to a later draft, not to the reattached job.
      if (context !== REATTACHED) onComplete?.(frame.ingest);
    },
    successToast: (frame) => (
      frame.ingest?.taskId
        ? `Ingested "${frame.ingest.title}" — review task queued`
        : `Ingested "${frame.ingest?.title || 'video'}"`
    ),
    errorFallback: 'YouTube ingest failed',
    canceledMessage: 'YouTube ingest cancelled',
    lostConnectionMessage: 'Lost connection to the ingest — check Brain → Links',
    startErrorFallback: 'Failed to start the ingest',
    onKickoffError,
    onKickoffSuccess,
  });
  return { active, percent, stage, start, cancel };
}
