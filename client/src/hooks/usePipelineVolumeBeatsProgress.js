import { pipelineVolumeBeatsSseUrl } from '../services/api';
import { useSseProgress } from './useSseProgress';

/**
 * Subscribe to the volume beat-sheet SSE stream. Frame shapes are documented
 * in server/services/pipeline/volumeBeatsRunner.js.
 */
export function usePipelineVolumeBeatsProgress(seriesId, seasonId, { enabled = true } = {}) {
  const url = seriesId && seasonId ? pipelineVolumeBeatsSseUrl(seriesId, seasonId) : null;
  return useSseProgress(url, { enabled });
}
