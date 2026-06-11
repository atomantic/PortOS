import { pipelineManuscriptCompletenessSseUrl } from '../services/api';
import { useSseProgress } from './useSseProgress';

/**
 * Subscribe to the streamed manuscript-completeness review SSE stream (the
 * "generate edits for every finding" pass). Frame shapes are documented in
 * server/services/pipeline/manuscriptCompletenessRunner.js
 * (start / plan / chunk:start / chunk:complete / complete / canceled / error).
 */
export function usePipelineManuscriptCompletenessProgress(seriesId, { enabled = true } = {}) {
  const url = seriesId ? pipelineManuscriptCompletenessSseUrl(seriesId) : null;
  return useSseProgress(url, { enabled });
}
