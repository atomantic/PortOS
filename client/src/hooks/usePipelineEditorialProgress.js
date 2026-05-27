import { pipelineEditorialSseUrl } from '../services/api';
import { useSseProgress } from './useSseProgress';

/**
 * Subscribe to the series editorial-analysis batch SSE stream. Frame shapes are
 * documented in server/services/pipeline/editorialAnalysisRunner.js
 * (start / issue:start / issue:complete / issue:error / complete / canceled / error).
 */
export function usePipelineEditorialProgress(seriesId, { enabled = true } = {}) {
  const url = seriesId ? pipelineEditorialSseUrl(seriesId) : null;
  return useSseProgress(url, { enabled });
}
