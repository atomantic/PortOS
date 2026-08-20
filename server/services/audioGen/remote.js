/**
 * Durable consumer-side adapter for federated audio jobs.
 *
 * The retry/idempotency/cancel/integrity machinery lives in the shared
 * executor (services/federatedMedia/remoteExecutor.js); this module supplies
 * only the audio-specific parts: the persisted marker shape, the
 * privacy-safe prompt rendering, and where the verified WAV lands.
 */

import { z } from 'zod';
import { PATHS } from '../../lib/fileUtils.js';
import {
  FEDERATED_MEDIA_WIRE_VERSION,
  federatedMediaAudioProfileSchema,
  renderFederatedMediaAudioPrompt,
} from '../../lib/federatedMediaWire.js';
import { federatedMediaJobRoutingSchema } from '../../lib/validation.js';
import { createRemoteMediaExecutor, remoteMediaError } from '../federatedMedia/remoteExecutor.js';
import { audioGenEvents } from './events.js';

const remoteMediaMarkerSchema = z.object({
  wireVersion: z.literal(FEDERATED_MEDIA_WIRE_VERSION),
  peerId: z.string().uuid(),
  reconcile: z.boolean().optional(),
  cancelRequested: z.boolean().optional(),
  // Set by the unattended (standing) router, never by an interactive render.
  // Optional so a marker already queued by an older build still validates; its
  // absence means "interactive", which is the correct reading of history.
  standingRoute: z.boolean().optional(),
  profile: federatedMediaAudioProfileSchema,
  // Free-form prompt/lyrics are deliberately absent from persisted routing
  // state. The adapter renders a fixed-vocabulary instrumental prompt from the
  // profile immediately before submission, so hand-edited queue state cannot
  // smuggle personal text onto the federation wire.
  request: federatedMediaJobRoutingSchema,
}).passthrough();

const executor = createRemoteMediaExecutor({
  kind: 'audio',
  label: 'audio',
  events: audioGenEvents,
  markerSchema: remoteMediaMarkerSchema,
  buildRequest(marker) {
    const prompt = renderFederatedMediaAudioPrompt(marker.profile);
    if (!prompt) {
      throw remoteMediaError('Remote audio job has an invalid privacy-safe profile', {
        code: 'MEDIA_PROVIDER_AUDIO_PROFILE_INVALID',
      });
    }
    // No explicit `kind` on the wire: an already-deployed audio-only provider
    // validates this body against a strict schema that predates the field and
    // would reject it. The provider defaults a kind-less body to 'audio'.
    return { ...marker.request, prompt };
  },
  // PATHS is read per job (not captured at module load) so a test that swaps
  // the music directory still sees its own temp root.
  resolveDestination: ({ jobId }) => ({ dir: PATHS.music, filename: `music-gen-${jobId}.wav` }),
  finalize: async ({ filename, request, remoteJob }) => ({
    filename,
    durationSec: remoteJob.result.durationSec ?? request.durationSec ?? null,
    engine: remoteJob.result.engine ?? request.engine,
    modelId: remoteJob.result.modelId ?? request.modelId,
  }),
});

export const generateAudio = executor.run;
export const cancel = executor.cancel;
export const __configureRemoteAudioForTests = executor.configureForTests;
export const __resetRemoteAudioForTests = executor.resetForTests;
