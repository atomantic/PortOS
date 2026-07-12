import { startVideoDownload, cancelVideoDownload, videoDownloadEventsUrl } from '../services/apiVideoDownload.js';
import useSseJobSlot from './useSseJobSlot.js';

/**
 * One full-video-download job slot (#1946) — start/cancel + SSE progress +
 * terminal-frame handling via `POST /api/devtools/video-download`. A thin
 * wrapper over the generic `useSseJobSlot` (#2368): kick off returns a jobId,
 * progress streams over SSE, and terminal frames drive completion.
 * `onComplete(video)` fires once the download lands a video-history entry so the
 * caller can prepend it to its list without a full refetch.
 */
export default function useVideoDownload({ onComplete } = {}) {
  const { active, percent, stage, start, cancel } = useSseJobSlot({
    startRequest: (url) => startVideoDownload(url, { silent: true }),
    eventsUrl: videoDownloadEventsUrl,
    cancelRequest: cancelVideoDownload,
    trimStartArg: true,
    onComplete: (frame) => onComplete?.(frame.video),
    successToast: (frame) => `Downloaded "${frame.video?.title || 'video'}"`,
    errorFallback: 'Video download failed',
    canceledMessage: 'Video download cancelled',
    lostConnectionMessage: 'Lost connection to the download — check the list below',
    startErrorFallback: 'Failed to start download',
  });
  return { active, percent, stage, start, cancel };
}
