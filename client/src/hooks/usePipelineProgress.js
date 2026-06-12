import { useSseProgress } from './useSseProgress';

/**
 * Subscribe to a runner SSE progress stream whose URL derives from one or
 * more record ids. Generalizes the former per-runner wrapper hooks
 * (auto-run, editorial, manuscript-completeness, volume-beats, story-step):
 * the stream connects only when every id is truthy, and tears down when one
 * clears or `enabled` flips false. Frame shapes are documented in the server
 * runner that backs each `urlBuilder` (e.g.
 * server/services/pipeline/autoRunner.js#broadcast).
 *
 * @param {(...ids: string[]) => string} urlBuilder - SSE-URL builder from services/api
 * @param {Array} ids - builder arguments; any falsy id keeps the stream closed
 * @param {{ enabled?: boolean }} [opts]
 */
export function usePipelineProgress(urlBuilder, ids, { enabled = true } = {}) {
  const url = ids.every(Boolean) ? urlBuilder(...ids) : null;
  return useSseProgress(url, { enabled });
}
