import { pipelineAutoRunSseUrl } from '../services/api';
import { useSseProgress } from './useSseProgress';

/**
 * Subscribe to the auto-run-text SSE stream for a pipeline issue. Frame
 * shapes are documented in server/services/pipeline/autoRunner.js#broadcast.
 */
export function usePipelineAutoRunProgress(issueId, { enabled = true } = {}) {
  const url = issueId ? pipelineAutoRunSseUrl(issueId) : null;
  return useSseProgress(url, { enabled });
}
