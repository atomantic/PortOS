/**
 * Durable consumer-side adapter for federated video jobs.
 *
 * Mirrors audioGen/remote.js and imageGen/remote.js: the shared executor
 * (services/federatedMedia/remoteExecutor.js) owns retry, idempotent replay,
 * cancellation, and hash-verified transfer; this module supplies the video
 * specifics — the persisted marker shape, where the verified MP4 lands, and
 * the history row + thumbnail a local render would have produced.
 *
 * The history row matters as much as the bytes: mediaAssetIndex's `completed`
 * hook looks the render up by job id in video history, and the Video Gen UI
 * lists from that same file — a remote render with no row would be invisible.
 */

import { join } from 'node:path';
import { z } from 'zod';
import { PATHS } from '../../lib/fileUtils.js';
import { generateThumbnail, optimizeForStreaming } from '../../lib/ffmpeg.js';
import { FEDERATED_MEDIA_WIRE_VERSION } from '../../lib/federatedMediaWire.js';
import { federatedMediaVideoJobSubmissionBaseSchema } from '../../lib/validation.js';
import { createRemoteMediaExecutor } from '../federatedMedia/remoteExecutor.js';
import { applyRemoteInputAssets, remoteInputAssetsSchema } from '../federatedMedia/inputAssets.js';
import { videoGenEvents } from './events.js';
import { mutateVideoHistory } from './history.js';

const remoteVideoMarkerSchema = z.object({
  wireVersion: z.literal(FEDERATED_MEDIA_WIRE_VERSION),
  peerId: z.string().uuid(),
  reconcile: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  // Set by the unattended (standing) router, never by an interactive render.
  // Optional so a marker already queued by an older build still validates; its
  // absence means "interactive", which is the correct reading of history.
  standingRoute: z.boolean().optional(),
  // The full wire submission MINUS its conditioning refs, re-validated on every
  // replay. Persisted queue state is user-editable, so the body that actually
  // leaves this machine is the one this schema accepted — not whatever the file
  // happens to contain.
  request: federatedMediaVideoJobSubmissionBaseSchema,
  // LOCAL paths for this render's conditioning images, resolved to provider
  // asset ids immediately before each submission. Ids are NOT persisted here:
  // they name slots in the peer's TTL-swept staging area, so a reconcile after a
  // restart re-stages the same bytes instead of referencing bytes that are gone.
  // The paths themselves never cross the wire. See federatedMedia/inputAssets.js.
  //
  // Optional so a marker queued before this shipped still validates; absent
  // means the text-only render that build was the only one able to route.
  inputAssets: remoteInputAssetsSchema.optional(),
}).passthrough();

const executor = createRemoteMediaExecutor({
  kind: 'video',
  label: 'video',
  events: videoGenEvents,
  markerSchema: remoteVideoMarkerSchema,
  buildRequest: (marker, { stageAsset }) =>
    applyRemoteInputAssets(marker.request, marker.inputAssets, stageAsset),
  // `<jobId>.mp4` is videoGen/local.js's own filename shape, which is what the
  // provider-side result guard and the local history row both key on.
  resolveDestination: ({ jobId }) => ({ dir: PATHS.videos, filename: `${jobId}.mp4` }),
  async finalize({ jobId, path, filename, request, remoteJob, peerId }) {
    // Both ffmpeg passes are best-effort by construction (they no-op when
    // ffmpeg is absent), exactly as the local finalize path treats them — a
    // missing thumbnail must not fail a render that already landed verified.
    await optimizeForStreaming(path);
    const thumbnail = await generateThumbnail(path, jobId);
    await mutateVideoHistory((history) => {
      history.unshift({
        id: jobId,
        prompt: request.prompt,
        negativePrompt: request.negativePrompt ?? '',
        modelId: remoteJob.result.modelId ?? request.modelId,
        seed: request.seed ?? null,
        width: request.width ?? null,
        height: request.height ?? null,
        numFrames: request.numFrames ?? null,
        fps: request.fps ?? null,
        steps: request.steps ?? null,
        guidanceScale: request.guidance ?? null,
        filename,
        thumbnail,
        // Result provenance: instance-level identifiers already shared across
        // the federation, never a hostname, address, or credential.
        federatedPeerId: peerId,
        federatedJobId: remoteJob.id,
        createdAt: new Date().toISOString(),
      });
      return history;
    });
    return { filename, path: `/data/videos/${filename}`, thumbnail };
  },
});

export const generateVideo = executor.run;
export const cancel = executor.cancel;

/**
 * Chained renders condition each chunk on the previous chunk's tail frames,
 * which the text-only federated wire cannot carry. The queue only reaches this
 * when persisted params claim `chunks > 1` on a remote job, so fail loudly
 * rather than silently rendering a single unchained clip.
 */
export function generateChainedVideo({ jobId }) {
  videoGenEvents.emit('failed', {
    generationId: jobId,
    error: 'Chained video renders cannot run on a federated media provider',
  });
}

export const __configureRemoteVideoForTests = executor.configureForTests;
export const __resetRemoteVideoForTests = executor.resetForTests;
