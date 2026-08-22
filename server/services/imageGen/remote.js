/**
 * Durable consumer-side adapter for federated image jobs.
 *
 * Mirrors audioGen/remote.js: the retry/idempotency/cancel/integrity machinery
 * lives in the shared executor (services/federatedMedia/remoteExecutor.js) and
 * this module supplies only the image-specific parts — the persisted marker
 * shape, where the verified PNG lands, and the gallery sidecar a local render
 * would have written.
 *
 * The sidecar matters as much as the pixels: mediaAssetIndex's `completed`
 * hook re-reads it to build the gallery row, so a remote render with no
 * sidecar would land on disk and never appear in the gallery.
 */

import { join } from 'node:path';
import { z } from 'zod';
import { PATHS, atomicWrite } from '../../lib/fileUtils.js';
import { FEDERATED_MEDIA_WIRE_VERSION } from '../../lib/federatedMediaWire.js';
import { federatedMediaImageJobSubmissionSchema } from '../../lib/validation.js';
import { createRemoteMediaExecutor } from '../federatedMedia/remoteExecutor.js';
import { applyRemoteInputAssets, remoteInputAssetsSchema } from '../federatedMedia/inputAssets.js';
import { imageGenEvents } from '../imageGenEvents.js';

const remoteImageMarkerSchema = z.object({
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
  request: federatedMediaImageJobSubmissionSchema,
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
  kind: 'image',
  label: 'image',
  events: imageGenEvents,
  markerSchema: remoteImageMarkerSchema,
  buildRequest: (marker, { stageAsset }) =>
    applyRemoteInputAssets(marker.request, marker.inputAssets, stageAsset),
  // PATHS is read per job (not captured at module load) so a test that swaps
  // the gallery directory still sees its own temp root. The `<jobId>.png`
  // filename is the same shape imageGen/local.js uses, which is what lets the
  // gallery, the media index, and the provider-side result guard all agree.
  resolveDestination: ({ jobId }) => ({ dir: PATHS.images, filename: `${jobId}.png` }),
  async finalize({ jobId, dir, filename, request, remoteJob, peerId }) {
    // Honest sidecar: only fields this render actually had. Seed is the
    // requested one (wire-v1 results carry no rendered seed), so a render that
    // did not pin one records null rather than inventing a number the peer
    // never reported. `federatedPeer`/`federatedJob` are instance-level
    // identifiers already shared across the federation — they are the result
    // provenance, and carry no hostname, address, or credential.
    const meta = {
      id: jobId,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt ?? '',
      modelId: remoteJob.result.modelId ?? request.modelId,
      seed: request.seed ?? null,
      width: request.width,
      height: request.height,
      steps: request.steps ?? null,
      guidance: request.guidance ?? null,
      filename,
      federatedPeerId: peerId,
      federatedJobId: remoteJob.id,
      createdAt: new Date().toISOString(),
    };
    await atomicWrite(join(dir, `${jobId}.metadata.json`), meta);
    return {
      filename,
      path: `/data/images/${filename}`,
      seed: meta.seed,
      modelId: meta.modelId,
    };
  },
});

export const generateImage = executor.run;
export const cancel = executor.cancel;
export const __configureRemoteImageForTests = executor.configureForTests;
export const __resetRemoteImageForTests = executor.resetForTests;
