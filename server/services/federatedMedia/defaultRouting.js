/**
 * Server-owned default provider routing for UNATTENDED media jobs.
 *
 * The interactive generate routes route a job because a human picked a peer in
 * the UI and the server validated that choice. Creative Director and Creative
 * Commission have no human in the loop at enqueue time, and their planners are
 * LLMs — so "let the caller name a peer" is exactly the arbitrary-peer routing
 * the provider contract exists to prevent (#4348). Instead the routing policy
 * lives in this instance's own settings: `federation.mediaRouting.<kind>` names
 * one peer and one model, the agent names nothing, and the resolver still runs
 * the full allowlist + capacity preflight before a job leaves the node.
 *
 * Audio is intentionally unroutable here. Its wire body is not a projection of
 * the local job at all: only a canonical prompt rendered from a fixed enum
 * profile may cross the boundary, because free-form music prompts and lyrics
 * carry PII. A Creative Director music bed is free-form by construction, so it
 * stays local rather than being silently rewritten into a profile the user
 * never chose.
 *
 * FAIL-CLOSED, NEVER FAIL-QUIET: when a kind has a configured route and the
 * provider is stale, busy, unauthorized, or unavailable, the enqueue FAILS with
 * the typed reason instead of falling back to a local render. Falling back
 * would burn hours of local GPU on work the user deliberately routed to another
 * machine, and would do it invisibly — the opposite of the "show clear
 * blocked/busy/unavailable states and avoid silently falling back" requirement.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { buildFederatedMediaRequest } from '../../lib/federatedMediaRequest.js';
import { getSettingsWithStatus } from '../settings.js';
import { isTailnetPeer } from '../../lib/tailnetPeer.js';
import { CLOUD_VIDEO_GEN_MODES, VIDEO_GEN_MODES } from '../videoGen/modes.js';
import { ROUTABLE_MEDIA_KINDS, normalizeMediaRoutingConfig } from './routingPolicy.js';
import { collectRemoteInputAssets } from './inputAssets.js';

// The route's shape and its save-time policy live in routingPolicy.js; this
// module owns only what happens at ENQUEUE time. Re-exported so existing
// callers keep one import site.
export { ROUTABLE_MEDIA_KINDS, normalizeMediaRoutingConfig };

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// Params the wire still cannot carry, each for a recorded reason rather than a
// missing feature: LoRA weights are a MODEL (ADR
// docs/decisions/2026-08-22-federated-media-input-assets.md rule 3), and
// IC-LoRA references / keyframes / a video to extend are multi-step CHAIN STATE
// this machine sequences (rule 4).
//
// Refusing beats dropping, because "silently dropping the source image a user
// pinned returns a plausible render of the wrong thing" — and that reasoning is
// STRONGER here, not weaker: an unattended run has nobody watching to notice the
// shot came back unconditioned. Init/reference/start/end frames are absent from
// this map on purpose: they are single-render conditioning and now cross under
// rule 1. Keyed by the param a planner actually writes, valued by the noun the
// error names.
const UNSUPPORTED_CONDITIONING = Object.freeze({
  icReferenceVideoIds: 'IC-LoRA references',
  icReferenceImageFiles: 'IC-LoRA references',
  keyframes: 'keyframes',
  extendFromVideoId: 'a source video to extend',
  loraFilenames: 'LoRA weights',
  loraPaths: 'LoRA weights',
});

const isPresent = (value) => (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '');

/**
 * Refuse a routed job whose conditioning the wire would silently drop.
 *
 * `buildFederatedMediaRequest` projects only the text-to-image/text-to-video
 * fields onto the wire, so an unrecognized param does not fail validation — it
 * just disappears. Without this guard a scene render conditioned on a reference
 * frame would come back as an unrelated text-only image and be filed by its
 * completion hook as though it were correct.
 */
function assertRoutableConditioning(kind, params) {
  const unsupported = [...new Set(
    Object.entries(UNSUPPORTED_CONDITIONING)
      .filter(([key]) => isPresent(params?.[key]))
      .map(([, label]) => label),
  )];
  // A multi-chunk video is chained locally from its own prior output; the
  // provider renders one clip and knows nothing about the chain.
  if (kind === 'video' && Number(params?.chunks) > 1) unsupported.push('chained chunks');
  // `disableAudio` is not conditioning but it IS output semantics: the wire
  // cannot carry it, so a provider renders the clip WITH audio and the caller
  // silently gets the opposite of what it asked for. Only a truthy value is a
  // conflict — the common `false` is the provider's own default anyway.
  if (kind === 'video' && params?.disableAudio === true) unsupported.push('a silent (audio-disabled) render');
  // `params.mode` on a video job is OVERLOADED: it is either a backend token
  // ('local' / 'grok', what enforceRenderBackendPin writes) or, for the local
  // lane, the pipeline semantic (t2v / i2v / first-last-frame / audio-to-video).
  // The two need opposite treatment, and conflating them either rejects every
  // routable Grok-pinned job or silently renders the wrong pipeline.
  if (kind === 'video' && params?.mode !== undefined) {
    const mode = params.mode;
    if (CLOUD_VIDEO_GEN_MODES.includes(mode)) {
      // A cloud-CLI render spends that provider's quota with its own model and
      // its own duration vocabulary, none of which the wire carries. Refuse
      // rather than quietly substituting the peer's model — the interactive
      // route rejects a federated Grok render for the same reason.
      unsupported.push(`the ${mode} backend`);
    } else if (!VIDEO_GEN_MODES.includes(mode) && mode !== 'text') {
      // A genuine pipeline semantic other than text-to-video. `routedJobParams`
      // drops `mode`, so an unguarded 'fflf' or 'a2v' job would come back as a
      // plain text-to-video clip: a valid-looking render of a different thing.
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
 * Is a kind routed at all? Reads settings only — no peer probe, no capacity
 * preflight.
 *
 * Local readiness gates ("no Python runtime, skip the render") run BEFORE the
 * enqueue, and on a machine that routes its renders precisely because it cannot
 * render locally, those gates would skip work the peer was going to do. Call
 * this to decide whether a local-readiness verdict is even relevant.
 *
 * @param {'image'|'video'} kind
 * @returns {Promise<boolean>}
 */
export async function hasConfiguredMediaRoute(kind) {
  if (!ROUTABLE_MEDIA_KINDS.includes(kind)) return false;
  // On an unreadable read, answer TRUE: every caller uses this to decide whether
  // a local-readiness verdict may skip the render, and skipping is the one
  // outcome that silently discards work. Saying "routed" defers the decision to
  // resolveDefaultMediaRoute, which fails loudly with MEDIA_ROUTING_UNREADABLE.
  //
  // `getSettingsWithStatus`, not `getSettings`: the latter hands back an empty
  // object for a corrupt settings.json rather than rejecting, so a `.catch()`
  // here would never fire and a configured route would read as absent — exactly
  // the collapse this is guarding against.
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
  // UNREADABLE is not the same as NO ROUTE. A settings object that parses and
  // simply has no `mediaRouting` is a fresh install and must render locally; a
  // settings read that FAILS tells us nothing, and treating it as "no route"
  // would silently bypass a route the user configured — burning local GPU (or
  // another backend's quota) on work they deliberately sent elsewhere. That is
  // exactly the collapse the project's sentinel rule forbids, so a failed read
  // gets its own typed error rather than a null.
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
  // Single-render conditioning DOES cross (rule 1). Collected here so the
  // unattended lane sends exactly what the interactive routes send — same asset
  // upload, same capability gate in prepareRemoteMediaJob, same marker shape.
  // A planner writes image conditioning as `initImagePath`/`referenceImagePaths`
  // and video conditioning as `sourceImagePath`/`sourceImageFile`, so both
  // spellings feed the one role.
  const inputAssets = collectRemoteInputAssets(kind === 'image'
    ? { initImage: params?.initImagePath, referenceImages: params?.referenceImagePaths }
    : { sourceImage: params?.sourceImagePath || params?.sourceImageFile, lastImage: params?.lastImageFile });
  const request = buildFederatedMediaRequest({
    kind,
    engine: route.engine,
    // The route's model wins over whatever the planner wrote: a peer advertises
    // its own model ids, and a local model name would fail the peer's allowlist
    // check with a confusing "not allowlisted" rather than an honest mismatch.
    params: { ...params, modelId: route.modelId },
  });
  // Lazy, for the same reason remoteSubmission.js is lazy: the creative tool
  // module is imported by agent-tool suites that mock the settings/DB layer,
  // and a static edge to the peer registry would drag that graph into them.
  const { prepareRemoteMediaJob } = await import('./remoteSubmission.js');
  const { peer, request: negotiatedRequest, remoteMedia } = await prepareRemoteMediaJob({
    peerId: route.peerId,
    kind,
    request,
    inputAssets,
  });
  // ADR docs/decisions/2026-08-20-federated-visual-prompts.md, rule 5: a
  // STANDING route must refuse a non-tailnet peer. It exports every future
  // prompt of its kind with nobody reviewing, so a misconfigured counterparty
  // is a permanent leak where an interactive mistake is a one-time one — and
  // peerFetch's rejectUnauthorized:false leaves a plain-LAN or non-.ts.net peer
  // with no server authentication, so an impostor reads the prompt out of the
  // request body before failing to answer. Interactive routing is unchanged.
  //
  // Checked AFTER prepareRemoteMediaJob so the peer record is the registry's,
  // not one reconstructed from the route.
  if (!isTailnetPeer(peer)) {
    throw new ServerError(
      `Unattended ${kind} routing requires a Tailscale peer — "${peer.name || peer.id}" is reachable outside the tailnet, `
      + 'so a standing route would export every future prompt over an unauthenticated hop.',
      { status: 403, code: 'MEDIA_ROUTING_PEER_NOT_TAILNET' },
    );
  }
  const finalRequest = negotiatedRequest || request;
  // NOTE: Frame and canvas constraints are negotiated in prepareRemoteMediaJob
  // against the peer's advertised capability (frameStride, maxNumFrames,
  // frameOptions, resolutionOptions). Model-specific prompt constraints (e.g. MiniMax
  // H3 rejecting negative prompts) remain provider-enforced.
  //
  // Stamp the marker so the boundary survives the job, not just the enqueue.
  // The tailnet check above ran against the peer record as it looked NOW; a
  // queued or reconciling job re-resolves its peer from the registry on every
  // request, and that record can change (a host edited from a .ts.net name to a
  // LAN address) between enqueue and submit. The executor re-checks on this bit.
  return { peer, request: finalRequest, remoteMedia: { ...remoteMedia, standingRoute: true } };
}

/**
 * Local params that only mean something to a LOCAL dispatch. Dropping them
 * mirrors the generate routes: the backend selectors would otherwise ride into
 * a job no local backend ever runs, and a rollback to a build that cannot read
 * `remoteMedia` must fail closed rather than re-render the job for real.
 *
 * Destination tags (`creativeDirectorSceneImage`, `musicVideo`, `catalogAttach`,
 * …) deliberately stay: their completion hooks fire off the finished filename
 * and work identically for a federated render.
 */
const LOCAL_ONLY_ROUTED_PARAMS = Object.freeze([
  'mode', 'cloudModel', 'backend', 'pythonPath',
  'mediaProviderPeerId', 'mediaProviderEngine',
]);

// Post-processing passes that run over the produced FILE, not the render. The
// wire cannot request them and the remote executor does not re-apply them after
// download, so a routed job comes back without them. They are dropped with a log
// rather than rejected (as `disableAudio` is) because the distinction is what is
// rendered vs. how the artifact is polished: dropping a denoise pass still
// returns the requested image, just less clean, and `cleanC2PA` defaults to true
// for cloud modes the user never explicitly opted into. Re-applying them
// consumer-side after download is the real fix; see the follow-up issue.
const DROPPED_POST_PROCESSING = Object.freeze(['cleanC2PA', 'denoise']);

/**
 * Turn a resolved route plus the planner's params into the job params to
 * enqueue. The prompt is blanked because it rides ONLY inside the versioned
 * marker (see the generate routes for the same reasoning).
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
 * Every autonomous render — the Creative Director planner tool, the scene
 * runner, first-pass portraits and scene frames — must go through here rather
 * than calling `enqueueJob` directly, or a configured route silently applies to
 * some of a project's renders and not others. That inconsistency is worse than
 * no routing at all: half a project renders on the peer's model and half on the
 * local one, with no indication why the shots don't match.
 *
 * Signature-compatible with `enqueueJob` so a call site converts by changing
 * the function name.
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
