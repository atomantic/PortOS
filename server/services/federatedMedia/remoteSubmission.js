/**
 * Route-side helper that turns "the user picked peer X" into the persisted
 * remote-job marker the queue's remote adapters run from.
 *
 * It exists so every call site enforces the same three things in the same
 * order — the peer is registered, the local user explicitly allowlisted this
 * peer/model, and the provider has fresh capacity — before a job is enqueued.
 * Skipping any of them is how an agent would end up routing arbitrary work to
 * an arbitrary peer, which the provider contract exists to prevent.
 *
 * The preflight is advisory: the provider re-checks authorization and capacity
 * on submit. Doing it here just keeps known-doomed work from being queued.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { FEDERATED_MEDIA_WIRE_VERSION } from '../../lib/federatedMediaWire.js';
import { federatedMediaVideoJobSubmissionBaseSchema } from '../../lib/validation.js';
import { inputAssetRejection } from './inputAssets.js';

// The BASE (un-refined) schema: this validates a partially-negotiated body,
// and Zod refuses `.partial()` on a schema carrying cross-field refinements.
// The full schema still guards the submitted body — see remote.js.
const partialVideoJobSubmissionSchema = federatedMediaVideoJobSubmissionBaseSchema.partial();

/**
 * Negotiate frame and canvas constraints against the provider capability.
 * Snaps fps to supported fpsOptions (rescaling frame count to preserve duration),
 * snaps numFrames to nearest discrete option or n*stride + 1 (bounded by maxNumFrames),
 * and matches resolution against closest aspect/area preset.
 */
export function negotiateVideoConstraints(request, capability) {
  if (!request || !capability) return request;
  let negotiated = request;

  // FPS constraint negotiation (negotiated first so frame count can rescale to preserve duration)
  if (Array.isArray(capability.fpsOptions) && capability.fpsOptions.length > 0 && negotiated.fps !== undefined) {
    const requestedFps = Number(negotiated.fps);
    const validFps = capability.fpsOptions.map(Number).filter((f) => Number.isInteger(f) && f >= 1 && f <= 60);
    if (validFps.length > 0 && Number.isFinite(requestedFps)) {
      const bestFps = validFps.reduce((closest, opt) =>
        Math.abs(opt - requestedFps) < Math.abs(closest - requestedFps) ? opt : closest,
      validFps[0]);
      if (bestFps !== requestedFps) {
        console.log(`🌐 Federated render: adjusted fps from ${requestedFps} to ${bestFps} for ${capability.modelName || capability.modelId}`);
        // Rescale frame count to preserve clip duration (matches local reconciler)
        if (negotiated.numFrames !== undefined && Number.isFinite(Number(negotiated.numFrames)) && requestedFps > 0) {
          const maxNumFrames = capability.maxNumFrames != null ? Number(capability.maxNumFrames) : 600;
          const maxAllowed = Math.min(600, maxNumFrames > 0 ? maxNumFrames : 600);
          const rescaledFrames = Math.min(maxAllowed, Math.max(1, Math.round((Number(negotiated.numFrames) / requestedFps) * bestFps)));
          negotiated = { ...negotiated, numFrames: rescaledFrames };
        }
        negotiated = { ...negotiated, fps: bestFps };
      }
    }
  }

  // Frame constraint negotiation (issue #4681)
  if (negotiated.numFrames !== undefined) {
    const requestedFrames = Number(negotiated.numFrames);
    if (!Number.isFinite(requestedFrames) || requestedFrames < 1) {
      throw new ServerError(
        `Requested frame count (${requestedFrames}) is invalid for ${capability.modelName || capability.modelId}`,
        { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
      );
    }

    if (Array.isArray(capability.frameOptions) && capability.frameOptions.length > 0) {
      const maxNumFrames = capability.maxNumFrames != null ? Number(capability.maxNumFrames) : null;
      const validOptions = capability.frameOptions
        .map(Number)
        .filter((opt) => Number.isInteger(opt) && opt >= 1 && opt <= 600 && (maxNumFrames === null || opt <= maxNumFrames))
        .sort((a, b) => a - b);
      if (validOptions.length === 0) {
        throw new ServerError(
          `Requested frame count (${requestedFrames}) cannot be satisfied by ${capability.modelName || capability.modelId}`,
          { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
        );
      }
      // Discrete frameOptions models snap to nearestOption (consistent with local reconciler)
      const best = validOptions.reduce((closest, opt) =>
        Math.abs(opt - requestedFrames) < Math.abs(closest - requestedFrames) ? opt : closest,
      validOptions[0]);
      if (best !== requestedFrames) {
        console.log(`🌐 Federated render: adjusted numFrames from ${requestedFrames} to ${best} for ${capability.modelName || capability.modelId}`);
        negotiated = { ...negotiated, numFrames: best };
      }
    } else {
      const frameStride = capability.frameStride != null ? Number(capability.frameStride) : null;
      const maxNumFrames = capability.maxNumFrames != null ? Number(capability.maxNumFrames) : null;
      const hasStride = frameStride !== null && Number.isInteger(frameStride) && frameStride > 0;
      const hasMax = maxNumFrames !== null && Number.isInteger(maxNumFrames) && maxNumFrames > 0;

      if (hasStride || hasMax) {
        let legalFrames = requestedFrames;
        const minLegal = hasStride ? frameStride + 1 : 1;
        if (hasStride) {
          if (legalFrames < minLegal) {
            legalFrames = minLegal;
          } else {
            legalFrames = Math.floor((legalFrames - 1) / frameStride) * frameStride + 1;
          }
        }
        if (hasMax && legalFrames > maxNumFrames) {
          legalFrames = hasStride
            ? Math.floor((maxNumFrames - 1) / frameStride) * frameStride + 1
            : maxNumFrames;
        }
        if (legalFrames < minLegal || legalFrames < 1) {
          throw new ServerError(
            `Requested frame count (${requestedFrames}) cannot be satisfied by ${capability.modelName || capability.modelId} (minimum ${minLegal})`,
            { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
          );
        }
        if (legalFrames !== requestedFrames) {
          console.log(`🌐 Federated render: adjusted numFrames from ${requestedFrames} to ${legalFrames} for ${capability.modelName || capability.modelId}`);
          negotiated = { ...negotiated, numFrames: legalFrames };
        }
      }
    }
  }

  // Canvas constraint negotiation (issue #4681)
  if (Array.isArray(capability.resolutionOptions) && capability.resolutionOptions.length > 0
      && (negotiated.width !== undefined || negotiated.height !== undefined)) {
    const validOptions = capability.resolutionOptions.filter(
      (opt) => Number.isInteger(Number(opt?.w)) && Number.isInteger(Number(opt?.h))
        && Number(opt.w) >= 64 && Number(opt.w) <= 2048 && Number(opt.h) >= 64 && Number(opt.h) <= 2048,
    );
    if (validOptions.length > 0) {
      let bestOption = null;
      if (negotiated.width !== undefined && negotiated.height !== undefined) {
        const requestedAspect = Number(negotiated.width) / Number(negotiated.height);
        const requestedArea = Number(negotiated.width) * Number(negotiated.height);
        bestOption = validOptions.reduce((best, option) => {
          const aspectDiff = Math.abs((Number(option.w) / Number(option.h)) - requestedAspect);
          const areaDiff = Math.abs((Number(option.w) * Number(option.h)) - requestedArea);
          if (!best) return { option, aspectDiff, areaDiff };
          if (aspectDiff < best.aspectDiff - 0.001) return { option, aspectDiff, areaDiff };
          if (Math.abs(aspectDiff - best.aspectDiff) <= 0.001 && areaDiff < best.areaDiff) {
            return { option, aspectDiff, areaDiff };
          }
          return best;
        }, null)?.option;
      } else if (negotiated.width !== undefined) {
        const reqW = Number(negotiated.width);
        bestOption = validOptions.reduce((closest, opt) =>
          Math.abs(Number(opt.w) - reqW) < Math.abs(Number(closest.w) - reqW) ? opt : closest,
        validOptions[0]);
      } else {
        const reqH = Number(negotiated.height);
        bestOption = validOptions.reduce((closest, opt) =>
          Math.abs(Number(opt.h) - reqH) < Math.abs(Number(closest.h) - reqH) ? opt : closest,
        validOptions[0]);
      }

      if (bestOption && (negotiated.width !== Number(bestOption.w) || negotiated.height !== Number(bestOption.h))) {
        console.log(`🌐 Federated render: adjusted resolution from ${negotiated.width ?? '?'}x${negotiated.height ?? '?'} to ${bestOption.w}x${bestOption.h} for ${capability.modelName || capability.modelId}`);
        negotiated = { ...negotiated, width: Number(bestOption.w), height: Number(bestOption.h) };
      }
    }
  }

  // Defensive validation against the wire schema bounds before persisting/returning
  const validationResult = partialVideoJobSubmissionSchema.safeParse(negotiated);
  if (!validationResult.success) {
    const issueMessages = validationResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw new ServerError(
      `Negotiated video parameters violate schema: ${issueMessages}`,
      { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
    );
  }

  return negotiated;
}

/**
 * @param {object} args
 * @param {string} args.peerId - Registered peer the user selected.
 * @param {'audio'|'image'|'video'} args.kind
 * @param {object} args.request - Validated wire submission (carries engine/modelId).
 * @param {Array<{role: string, path: string}>} [args.inputAssets] - Local
 *   conditioning images for this render, checked against the peer's advertised
 *   `inputAssets` block here and uploaded by the executor at submit time.
 * @returns {Promise<{peer: object, capability: object, request: object, remoteMedia: object}>}
 */
export async function prepareRemoteMediaJob({ peerId, kind, request, inputAssets = [] }) {
  // Imported lazily, not statically: the image/video generate routes reach this
  // module, and a static edge to the peer registry would drag it (and its
  // settings/DB dependencies) into every route suite's module graph — where a
  // partially-mocked fileUtils then fails to load it. Nothing here runs until a
  // caller actually names a provider peer.
  const [{ getPeers }, { resolveFederatedMediaProvider }] = await Promise.all([
    import('../instances.js'),
    import('../federatedMediaConsumer.js'),
  ]);
  const peers = await getPeers();
  const peer = peers.find((candidate) => candidate.id === peerId);
  if (!peer) {
    throw new ServerError('Selected media provider peer was not found', {
      status: 404,
      code: 'MEDIA_PROVIDER_PEER_NOT_FOUND',
    });
  }
  const { capability } = await resolveFederatedMediaProvider(peer, {
    kind,
    engine: request.engine,
    modelId: request.modelId,
  });
  // Advisory, like every other check here — the provider re-validates at
  // admission. Doing it now turns "the peer 400s after the user committed" into
  // a message on the Generate button naming the input to clear.
  const rejection = inputAssetRejection(capability, inputAssets);
  if (rejection) {
    throw new ServerError(rejection, { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' });
  }
  const effectiveRequest = kind === 'video'
    ? negotiateVideoConstraints(request, capability)
    : request;
  return {
    peer,
    capability,
    request: effectiveRequest,
    remoteMedia: {
      wireVersion: FEDERATED_MEDIA_WIRE_VERSION,
      peerId: peer.id,
      reconcile: false,
      cancelRequested: false,
      request: effectiveRequest,
      ...(inputAssets.length ? { inputAssets } : {}),
    },
  };
}
