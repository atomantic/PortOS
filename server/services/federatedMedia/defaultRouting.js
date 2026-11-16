import { isDefaultA2vLoraStages } from '../../lib/videoLoraStageValidation.js';
/**
 * Server-owned default provider routing for UNATTENDED media jobs.
 *
 * Interactive generate routes route a job because a human picked a peer and the server
 * validated it. Creative Director and Creative Commission have LLM planners and no human
 * at enqueue time, so letting the caller name a peer is the arbitrary-peer routing the
 * provider contract prevents. The policy lives in this instance's settings:
 * `federation.mediaRouting.<kind>` names one peer and one model, the agent names nothing,
 * and the resolver still runs the full allowlist + capacity preflight.
 *
 * Audio is intentionally unroutable here: only a canonical prompt rendered from a fixed
 * enum profile may cross the boundary (free-form music prompts and lyrics carry PII), and
 * a Creative Director music bed is free-form, so it stays local.
 *
 * FAIL-CLOSED, NEVER FAIL-QUIET: when a kind has a configured route and the provider is
 * stale, busy, unauthorized or unavailable, the enqueue FAILS with the typed reason
 * instead of falling back to a local render, which would invisibly burn local GPU on work
 * the user deliberately routed elsewhere.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { buildFederatedMediaRequest } from '../../lib/federatedMediaRequest.js';
import { getSettingsWithStatus } from '../settings.js';
import { isTailnetPeer } from '../../lib/tailnetPeer.js';
import { CLOUD_VIDEO_GEN_MODES, VIDEO_GEN_MODES } from '../videoGen/modes.js';
import { ROUTABLE_MEDIA_KINDS, normalizeMediaRoutingConfig } from './routingPolicy.js';
import { collectRemoteInputAssets } from './inputAssets.js';

// The route's shape and save-time policy live in routingPolicy.js; this module owns
// ENQUEUE time. Re-exported so callers keep one import site.
export { ROUTABLE_MEDIA_KINDS, normalizeMediaRoutingConfig };

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// Params the wire cannot carry, each for a recorded reason: LoRA weights are a MODEL (ADR
// docs/decisions/2026-08-22-federated-media-input-assets.md rule 3), and IC-LoRA references
// / keyframes / a video to extend are multi-step CHAIN STATE this machine sequences (rule 4).
//
// Refusing beats dropping: silently dropping a pinned source image returns a plausible
// render of the wrong thing, and an unattended run has nobody to notice. Init/reference/
// start/end frames are absent on purpose (single-render conditioning crosses under rule 1).
// Keyed by the param a planner writes, valued by the noun the error names.
const UNSUPPORTED_CONDITIONING = Object.freeze({
  icReferenceVideoIds: 'IC-LoRA references',
  icReferenceImageFiles: 'IC-LoRA references',
  referenceImageFiles: 'reference images',
  referenceVideoIds: 'reference clips',
  keyframes: 'keyframes',
  extendFromVideoId: 'a source video to extend',
  loraFilenames: 'LoRA weights',
  loraPaths: 'LoRA weights',
});

const isPresent = (value) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '');

/**
 * Refuse a routed job whose conditioning the wire would silently drop.
 *
 * `buildFederatedMediaRequest` projects only text-to-image/text-to-video fields, so an
 * unrecognized param does not fail validation, it vanishes; a reference-conditioned scene
 * would come back as an unrelated text-only image filed by its completion hook as correct.
 */
function assertRoutableConditioning(kind, params) {
  const unsupported = [...new Set(
    Object.entries(UNSUPPORTED_CONDITIONING)
      .filter(([key]) => isPresent(params?.[key]))
      .map(([, label]) => label),
  )];
  if (!isDefaultA2vLoraStages(params?.a2vLoraStageStrengths)) unsupported.push('per-stage user LoRA strengths');
  // A multi-chunk video is chained locally from its own prior output; the
  // provider renders one clip and knows nothing about the chain.
  if (kind === 'video' && Number(params?.chunks) > 1) unsupported.push('chained chunks');
    // `disableAudio` is output semantics: the wire cannot carry it, so the provider would
    // render WITH audio, the opposite of the request. Only a truthy value conflicts.
  if (kind === 'video' && params?.disableAudio === true) unsupported.push('a silent (audio-disabled) render');
    // `params.mode` on a video job is OVERLOADED: a backend token ('local' / 'grok', written
    // by enforceRenderBackendPin) or, for the local lane, the pipeline semantic (t2v / i2v /
    // first-last-frame / audio-to-video). Conflating them rejects every Grok-pinned job or
    // renders the wrong pipeline.
  if (kind === 'video' && params?.mode !== undefined) {
    const mode = params.mode;
    if (CLOUD_VIDEO_GEN_MODES.includes(mode)) {
            // A cloud-CLI render spends that provider's quota with its own model and duration
            // vocabulary, none of which the wire carries. Refuse rather than substitute the
            // peer's model (the interactive route rejects a federated Grok render too).
      unsupported.push(`the ${mode} backend`);
    } else if (!VIDEO_GEN_MODES.includes(mode) && mode !== 'text') {
            // A pipeline semantic other than text-to-video: `routedJobParams` drops `mode`, so an
            // unguarded 'fflf' or 'a2v' job would return a plain text-to-video clip.
      unsupported.push(`a non-text render mode ('${mode}')`);
    }
    // A bare 'local' backend token falls through: it states where the job would
    // have run, not what pipeline it is, and routedJobParams strips it.
  }
  if (!unsupported.length) return;
  throw new ServerError(
    `A federated media provider renders text-to-${kind} only — this ${kind} job uses ${unsupported.join(' and ')}. `
    + `Clear the ${kind} route under Instances to render it locally.`,
    { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
  );
}

/**
 * Is a kind routed at all? Reads settings only — no peer probe, no capacity preflight.
 *
 * Local readiness gates run BEFORE the enqueue; a machine that routes precisely because it
 * cannot render locally would skip work the peer was going to do. Call this to decide
 * whether a local-readiness verdict is relevant.
 *
 * @param {'image'|'video'} kind
 * @returns {Promise<boolean>}
 */
export async function hasConfiguredMediaRoute(kind) {
  if (!ROUTABLE_MEDIA_KINDS.includes(kind)) return false;
    // On an unreadable read, answer TRUE: callers use this to decide whether a local-readiness
    // verdict may skip the render, and skipping silently discards work. "Routed" defers to
    // resolveDefaultMediaRoute, which fails loudly with MEDIA_ROUTING_UNREADABLE.
    //
    // `getSettingsWithStatus`, not `getSettings`: the latter returns an empty object for a
    // corrupt settings.json rather than rejecting, so a `.catch()` would never fire and a
    // configured route would read as absent.
  const { corrupt, settings } = await getSettingsWithStatus().catch(() => ({ corrupt: true, settings: null }));
  if (corrupt) return true;
  return !!normalizeMediaRoutingConfig(settings)[kind];
}

/**
 * Resolve the configured default provider for one unattended job, if any.
 *
 * @param {object} args
 * @param {'image'|'video'} args.kind
 * @param {object} args.params - Local job params the planner produced.
 * @returns {Promise<{peer: object, request: object, remoteMedia: object}|null>}
 *   `null` when this kind has no configured route (render locally). Throws a
 *   typed ServerError when a route IS configured but cannot be honoured.
 */
export async function resolveDefaultMediaRoute({ kind, params }) {
  if (!ROUTABLE_MEDIA_KINDS.includes(kind)) return null;
    // UNREADABLE is not NO ROUTE. Settings that parse without `mediaRouting` are a fresh
    // install and render locally; a FAILED read tells us nothing, and treating it as "no
    // route" would silently bypass a configured route, so it gets its own typed error.
  const { corrupt, settings } = await getSettingsWithStatus().catch((error) => {
    console.error(`❌ Federated media routing could not read settings: ${error.message}`);
    return { corrupt: true, settings: null };
  });
  if (corrupt) {
    console.error('❌ Federated media routing: settings.json is unreadable or malformed');
    throw new ServerError(
      'Could not read this instance\'s media routing configuration',
      { status: 503, code: 'MEDIA_ROUTING_UNREADABLE' },
    );
  }
  const route = normalizeMediaRoutingConfig(settings)[kind];
  if (!route) return null;

  if (!trimmed(params?.prompt)) {
    throw new ServerError(
      `A federated ${kind} render needs a prompt`,
      { status: 400, code: 'MEDIA_PROVIDER_PROMPT_REQUIRED' },
    );
  }
  assertRoutableConditioning(kind, params);
    // Single-render conditioning DOES cross (rule 1), collected through the same shared reader
    // the interactive routes use so both lanes send identical aliases, uploads and markers.
  const inputAssets = collectRemoteInputAssets(kind, params);
  const request = buildFederatedMediaRequest({
    kind,
    engine: route.engine,
        // The route's model wins over the planner's: a peer advertises its own model ids, and a
        // local model name would fail its allowlist with a confusing "not allowlisted".
    params: { ...params, modelId: route.modelId },
  });
    // Lazy, like remoteSubmission.js: agent-tool suites mock the settings/DB layer, and a
    // static edge to the peer registry would drag that graph into them.
  const { prepareRemoteMediaJob } = await import('./remoteSubmission.js');
  const { peer, request: negotiatedRequest, remoteMedia } = await prepareRemoteMediaJob({
    peerId: route.peerId,
    kind,
    request,
    inputAssets,
  });
    // ADR docs/decisions/2026-08-20-federated-visual-prompts.md, rule 5: a STANDING route must
    // refuse a non-tailnet peer. It exports every future prompt with nobody reviewing, and
    // peerFetch's rejectUnauthorized:false leaves a plain-LAN or non-.ts.net peer
    // unauthenticated, so an impostor could read the prompt from the request body.
    // Interactive routing is unchanged. Checked AFTER prepareRemoteMediaJob so the peer record
    // is the registry's, not one reconstructed from the route.
  if (!isTailnetPeer(peer)) {
    throw new ServerError(
      `Unattended ${kind} routing requires a Tailscale peer — "${peer.name || peer.id}" is reachable outside the tailnet, `
      + 'so a standing route would export every future prompt over an unauthenticated hop.',
      { status: 403, code: 'MEDIA_ROUTING_PEER_NOT_TAILNET' },
    );
  }
  const finalRequest = negotiatedRequest || request;
    // NOTE: Frame and canvas constraints are negotiated in prepareRemoteMediaJob against the
    // peer's advertised capability. Model-specific prompt constraints (e.g. MiniMax H3
    // rejecting negative prompts) remain provider-enforced.
    //
    // Stamp the marker so the boundary survives the job: the tailnet check above saw the peer
    // as of NOW, but a queued job re-resolves its peer on every request and the record can
    // change (.ts.net name edited to a LAN address) before submit. The executor re-checks this bit.
  return { peer, request: finalRequest, remoteMedia: { ...remoteMedia, standingRoute: true } };
}

/**
 * Local params that only mean something to a LOCAL dispatch. Dropping them mirrors the
 * generate routes: backend selectors would otherwise ride into a job no local backend runs,
 * and a rollback to a build that cannot read `remoteMedia` must fail closed rather than
 * re-render the job locally.
 *
 * Destination tags (`creativeDirectorSceneImage`, `musicVideo`, `catalogAttach`, …) stay:
 * their completion hooks fire off the finished filename and work for a federated render.
 */
const LOCAL_ONLY_ROUTED_PARAMS = Object.freeze([
  'mode', 'cloudModel', 'backend', 'pythonPath',
  'mediaProviderPeerId', 'mediaProviderEngine',
]);

// Post-processing passes over the produced FILE, not the render. The wire cannot request
// them and the remote executor does not re-apply them after download, so a routed job comes
// back without them. Dropped with a log rather than rejected (unlike `disableAudio`):
// dropping a denoise pass still returns the requested image, just less clean, and
// `cleanC2PA` defaults to true for cloud modes the user never opted into. Re-applying
// consumer-side after download is the real fix.
const DROPPED_POST_PROCESSING = Object.freeze(['cleanC2PA', 'denoise']);

/**
 * Turn a resolved route plus the planner's params into the job params to enqueue. The
 * prompt is blanked because it rides ONLY inside the versioned marker.
 */
export function routedJobParams(params, { request, remoteMedia }) {
  const effectiveRequest = request || remoteMedia?.request;
  const jobParams = { ...(params || {}) };
  for (const key of LOCAL_ONLY_ROUTED_PARAMS) delete jobParams[key];
  const dropped = DROPPED_POST_PROCESSING.filter((key) => jobParams[key] === true);
  for (const key of DROPPED_POST_PROCESSING) delete jobParams[key];
  if (dropped.length) {
    console.log(`🌐 Federated render: ${dropped.join(' and ')} will not run on a routed job`);
  }
  return {
    ...jobParams,
    prompt: '',
    modelId: effectiveRequest.modelId,
    ...(effectiveRequest.numFrames !== undefined ? { numFrames: effectiveRequest.numFrames } : {}),
    ...(effectiveRequest.fps !== undefined ? { fps: effectiveRequest.fps } : {}),
    ...(effectiveRequest.width !== undefined ? { width: effectiveRequest.width } : {}),
    ...(effectiveRequest.height !== undefined ? { height: effectiveRequest.height } : {}),
    remoteMedia,
  };
}

/**
 * THE enqueue entry point for unattended media work.
 *
 * Every autonomous render (Creative Director planner tool, scene runner, first-pass
 * portraits and frames) must go through here, not `enqueueJob` directly, or a configured
 * route applies to some of a project's renders and not others (half on the peer's model,
 * half local, shots mismatched with no explanation).
 *
 * Signature-compatible with `enqueueJob`.
 *
 * @param {object} args
 * @param {'image'|'video'|'audio'} args.kind
 * @param {object} args.params
 * @param {string} [args.owner]
 * @returns {Promise<object>} The queued-job descriptor `enqueueJob` returns.
 */
export async function enqueueUnattendedMediaJob({ kind, params, owner }) {
  const routed = await resolveDefaultMediaRoute({ kind, params });
  const { enqueueJob } = await import('../mediaJobQueue/index.js');
  return enqueueJob({
    kind,
    params: routed ? routedJobParams(params, routed) : params,
    ...(owner === undefined ? {} : { owner }),
  });
}
