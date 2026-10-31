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
import {
  FEDERATED_MEDIA_MAX_VIDEO_FRAMES,
  FEDERATED_MEDIA_WIRE_VERSION,
} from '../../lib/federatedMediaWire.js';
import { federatedMediaVideoJobSubmissionBaseSchema } from '../../lib/validation.js';
import { inputAssetRejection } from './inputAssets.js';

// The BASE (un-refined) schema: this validates a partially-negotiated body,
// and Zod refuses `.partial()` on a schema carrying cross-field refinements.
// The full schema still guards the submitted body — see remote.js.
const partialVideoJobSubmissionSchema = federatedMediaVideoJobSubmissionBaseSchema.partial();

const unsupportedInput = (message) => new ServerError(message, { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' });

const hasOptions = (options) => Array.isArray(options) && options.length > 0;

// First option wins a tie (the discrete frame options arrive sorted, so the shorter one).
const nearestOption = (options, target, valueOf = Number) => options.reduce((closest, opt) =>
  Math.abs(valueOf(opt) - target) < Math.abs(valueOf(closest) - target) ? opt : closest,
options[0]);

const isBoundedResolution = (opt) => Number.isInteger(Number(opt?.w)) && Number.isInteger(Number(opt?.h))
  && Number(opt.w) >= 64 && Number(opt.w) <= 2048 && Number(opt.h) >= 64 && Number(opt.h) <= 2048;

// Clip duration is what the user chose; the frame count follows the fps.
function rescaleFrameCount(numFrames, fromFps, toFps, capability) {
  const maxNumFrames = capability.maxNumFrames != null
    ? Number(capability.maxNumFrames)
    : FEDERATED_MEDIA_MAX_VIDEO_FRAMES;
  const maxAllowed = Math.min(
    FEDERATED_MEDIA_MAX_VIDEO_FRAMES,
    maxNumFrames > 0 ? maxNumFrames : FEDERATED_MEDIA_MAX_VIDEO_FRAMES,
  );
  return Math.min(maxAllowed, Math.max(1, Math.round((Number(numFrames) / fromFps) * toFps)));
}

// Runs before frame negotiation so a rescaled count is then snapped to the
// provider's frame grid.
function negotiateFps(request, capability, label) {
  if (!hasOptions(capability.fpsOptions) || request.fps === undefined) return request;
  const requestedFps = Number(request.fps);
  const validFps = capability.fpsOptions.map(Number).filter((f) => Number.isInteger(f) && f >= 1 && f <= 60);
  if (validFps.length === 0 || !Number.isFinite(requestedFps)) return request;
  const bestFps = nearestOption(validFps, requestedFps);
  if (bestFps === requestedFps) return request;
  console.log(`🌐 Federated render: adjusted fps from ${requestedFps} to ${bestFps} for ${label}`);
  let negotiated = request;
  if (request.numFrames !== undefined && Number.isFinite(Number(request.numFrames)) && requestedFps > 0) {
    negotiated = { ...negotiated, numFrames: rescaleFrameCount(request.numFrames, requestedFps, bestFps, capability) };
  }
  return { ...negotiated, fps: bestFps };
}

// Discrete frameOptions models snap to the nearest option (local reconciler parity).
function snapToFrameOptions(requestedFrames, capability, label) {
  const maxNumFrames = capability.maxNumFrames != null ? Number(capability.maxNumFrames) : null;
  const validOptions = capability.frameOptions
    .map(Number)
    .filter((opt) => Number.isInteger(opt)
      && opt >= 1
      && opt <= FEDERATED_MEDIA_MAX_VIDEO_FRAMES
      && (maxNumFrames === null || opt <= maxNumFrames))
    .sort((a, b) => a - b);
  if (validOptions.length === 0) {
    throw unsupportedInput(`Requested frame count (${requestedFrames}) cannot be satisfied by ${label}`);
  }
  return nearestOption(validOptions, requestedFrames);
}

// Stride models take n*stride + 1 frames, floored, and never exceed maxNumFrames.
function snapToFrameGrid(requestedFrames, capability, label) {
  const frameStride = capability.frameStride != null ? Number(capability.frameStride) : null;
  const maxNumFrames = capability.maxNumFrames != null ? Number(capability.maxNumFrames) : null;
  const hasStride = frameStride !== null && Number.isInteger(frameStride) && frameStride > 0;
  const hasMax = maxNumFrames !== null && Number.isInteger(maxNumFrames) && maxNumFrames > 0;
  if (!hasStride && !hasMax) return requestedFrames;

  const minLegal = hasStride ? frameStride + 1 : 1;
  let legalFrames = requestedFrames;
  if (hasStride) {
    legalFrames = legalFrames < minLegal
      ? minLegal
      : Math.floor((legalFrames - 1) / frameStride) * frameStride + 1;
  }
  if (hasMax && legalFrames > maxNumFrames) {
    legalFrames = hasStride
      ? Math.floor((maxNumFrames - 1) / frameStride) * frameStride + 1
      : maxNumFrames;
  }
  if (legalFrames < minLegal) {
    throw unsupportedInput(`Requested frame count (${requestedFrames}) cannot be satisfied by ${label} (minimum ${minLegal})`);
  }
  return legalFrames;
}

// Frame constraint negotiation (issue #4681)
function negotiateFrameCount(request, capability, label) {
  if (request.numFrames === undefined) return request;
  const requestedFrames = Number(request.numFrames);
  if (!Number.isFinite(requestedFrames) || requestedFrames < 1) {
    throw unsupportedInput(`Requested frame count (${requestedFrames}) is invalid for ${label}`);
  }
  const legalFrames = hasOptions(capability.frameOptions)
    ? snapToFrameOptions(requestedFrames, capability, label)
    : snapToFrameGrid(requestedFrames, capability, label);
  if (legalFrames === requestedFrames) return request;
  console.log(`🌐 Federated render: adjusted numFrames from ${requestedFrames} to ${legalFrames} for ${label}`);
  return { ...request, numFrames: legalFrames };
}

// Closest aspect ratio; within 0.001 of a tie, the closest area wins.
function closestAspectThenArea(options, width, height) {
  const requestedAspect = width / height;
  const requestedArea = width * height;
  return options.reduce((best, option) => {
    const aspectDiff = Math.abs((Number(option.w) / Number(option.h)) - requestedAspect);
    const areaDiff = Math.abs((Number(option.w) * Number(option.h)) - requestedArea);
    if (!best) return { option, aspectDiff, areaDiff };
    if (aspectDiff < best.aspectDiff - 0.001) return { option, aspectDiff, areaDiff };
    if (Math.abs(aspectDiff - best.aspectDiff) <= 0.001 && areaDiff < best.areaDiff) {
      return { option, aspectDiff, areaDiff };
    }
    return best;
  }, null).option;
}

function closestResolution(options, request) {
  if (request.width !== undefined && request.height !== undefined) {
    return closestAspectThenArea(options, Number(request.width), Number(request.height));
  }
  if (request.width !== undefined) return nearestOption(options, Number(request.width), (opt) => Number(opt.w));
  return nearestOption(options, Number(request.height), (opt) => Number(opt.h));
}

// Canvas constraint negotiation (issue #4681)
function negotiateCanvas(request, capability, label) {
  if (!hasOptions(capability.resolutionOptions) || (request.width === undefined && request.height === undefined)) {
    return request;
  }
  const validOptions = capability.resolutionOptions.filter(isBoundedResolution);
  if (validOptions.length === 0) return request;
  const best = closestResolution(validOptions, request);
  const width = Number(best.w);
  const height = Number(best.h);
  if (request.width === width && request.height === height) return request;
  console.log(`🌐 Federated render: adjusted resolution from ${request.width ?? '?'}x${request.height ?? '?'} to ${best.w}x${best.h} for ${label}`);
  return { ...request, width, height };
}

/**
 * Negotiate frame and canvas constraints against the provider capability.
 * Snaps fps to supported fpsOptions (rescaling frame count to preserve duration),
 * snaps numFrames to nearest discrete option or n*stride + 1 (bounded by maxNumFrames),
 * and matches resolution against closest aspect/area preset.
 */
export function negotiateVideoConstraints(request, capability) {
  if (!request || !capability) return request;
  const label = capability.modelName || capability.modelId;
  const negotiated = negotiateCanvas(
    negotiateFrameCount(negotiateFps(request, capability, label), capability, label),
    capability,
    label,
  );

  // Defensive validation against the wire schema bounds before persisting/returning
  const validationResult = partialVideoJobSubmissionSchema.safeParse(negotiated);
  if (!validationResult.success) {
    const issueMessages = validationResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    throw unsupportedInput(`Negotiated video parameters violate schema: ${issueMessages}`);
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
  const { capability, status } = await resolveFederatedMediaProvider(peer, {
    kind,
    engine: request.engine,
    modelId: request.modelId,
  });
  // Advisory, like every other check here — the provider re-validates at
  // admission. Doing it now turns "the peer 400s after the user committed" into
  // a message on the Generate button naming the input to clear.
  const rejection = inputAssetRejection(capability, inputAssets, status);
  if (rejection) {
    throw unsupportedInput(rejection);
  }
  const effectiveRequest = kind === 'video'
    ? negotiateVideoConstraints(request, capability)
    : request;
  if (request.audioConditioning && (effectiveRequest.fps !== request.fps || effectiveRequest.numFrames !== request.numFrames)) {
    throw unsupportedInput('Peer frame constraints would change the supplied audio window');
  }
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
