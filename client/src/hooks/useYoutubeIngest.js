import toast from '../components/ui/Toast';
import { startYoutubeIngest, cancelYoutubeIngest, youtubeIngestEventsUrl } from '../services/apiBrain.js';
import useSseJobSlot from './useSseJobSlot.js';

/**
 * One YouTube brain-ingest job slot — start/cancel + SSE progress + terminal
 * frames via `POST /api/brain/youtube/ingest`. A thin wrapper over the generic
 * `useSseJobSlot`, like the video-download and track-import hooks.
 *
 * `start(body)` takes the whole ingest payload (`{ url, captureTranscript,
 * downloadVideo, ingestAudio, note, agentPrompt, tags }`) rather than a bare URL, so
 * `trimStartArg` stays false and the payload passes through untouched.
 *
 * Non-fatal outcomes (no captions, a duplicate review task) ride along on the
 * terminal `complete` frame as `warnings[]` — the hook only ever sees the
 * terminal payload, so a live-only warning frame would be lost.
 */
export default function useYoutubeIngest({ onComplete } = {}) {
  const { active, percent, stage, start, cancel } = useSseJobSlot({
    startRequest: (body) => startYoutubeIngest(body, { silent: true }),
    eventsUrl: youtubeIngestEventsUrl,
    cancelRequest: cancelYoutubeIngest,
    onComplete: (frame) => {
      for (const message of frame.warnings || []) toast.info(message);
      onComplete?.(frame.ingest);
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
  });
  return { active, percent, stage, start, cancel };
}
