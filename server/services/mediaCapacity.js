/**
 * Local media-lane capacity: what this machine is rendering and whether it can
 * take another job (#4348). Kept apart from `activeProcessing.js` so the slow-cadence
 * System Health poll avoids its GPU-utilization probes and CoS task read.
 *
 * FEDERATION: returned by `GET /api/system/health/details`, which peers fetch on
 * every probe, so it describes ONLY this machine's runtime, never peers, routing
 * policy or allowlists (see `redactPeerForWire` in services/instances.js).
 */

import { getCudaCapability } from '../lib/cudaCapability.js';
import { getQueueCapacity } from './mediaJobQueue/index.js';

/**
 * @returns {Promise<{gpu: {cudaStatus: 'available'|'absent'|'unknown', laneBusy: boolean, laneKind: string|null},
 *   lanes: object, byKind: object, totals: {running: number, queued: number}}>}
 */
export async function getMediaCapacity() {
  // Three-state, never a boolean: `unknown` (probe failed) must not read as `absent` (no CUDA).
  const capability = await getCudaCapability().catch(() => ({ status: 'unknown' }));
  const capacity = getQueueCapacity();
  return {
    gpu: {
      cudaStatus: capability.status,
      laneBusy: capacity.lanes.gpu.running > 0,
      laneKind: capacity.runningKind,
    },
    lanes: capacity.lanes,
    byKind: capacity.byKind,
    totals: capacity.totals,
  };
}
