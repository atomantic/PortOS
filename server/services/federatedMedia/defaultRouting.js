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
import { getSettings } from '../settings.js';

// Only the visual kinds. See the audio note in the module docblock.
export const ROUTABLE_MEDIA_KINDS = Object.freeze(['image', 'video']);

const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

function sanitizeRoute(raw) {
  if (!isRecord(raw)) return null;
  const peerId = trimmed(raw.peerId);
  const engine = trimmed(raw.engine);
  const modelId = trimmed(raw.modelId);
  // A half-written route is not a route. Requiring all three up front is what
  // keeps a partially-saved settings blob from resolving to "peer X, whatever
  // model" — the allowlist check downstream is keyed on the exact pair.
  if (!peerId || !engine || !modelId) return null;
  return { peerId, engine, modelId };
}

/**
 * Project `settings.federation.mediaRouting` down to the routes this build
 * understands. Unknown kinds are dropped rather than carried: a route is only
 * ever consumed by a matching enqueue path, so a kind this version cannot
 * execute must read as "no route" and stay local.
 *
 * @param {object} settings - Full settings record.
 * @returns {{image: object|null, video: object|null}}
 */
export function normalizeMediaRoutingConfig(settings) {
  const raw = settings?.federation?.mediaRouting;
  const config = {};
  for (const kind of ROUTABLE_MEDIA_KINDS) {
    config[kind] = isRecord(raw) ? sanitizeRoute(raw[kind]) : null;
  }
  return config;
}

// Params that ask for conditioning wire v1 cannot carry. The interactive routes
// reject these outright rather than dropping them, because "silently dropping
// the source image a user pinned returns a plausible render of the wrong
// thing" — and that reasoning is STRONGER here, not weaker: an unattended run
// has nobody watching to notice the shot came back unconditioned. Keyed by the
// param a planner actually writes, valued by the noun the error names.
const UNSUPPORTED_CONDITIONING = Object.freeze({
  initImagePath: 'an init image',
  sourceImagePath: 'a source image',
  sourceImageFile: 'a source image',
  lastImageFile: 'an end frame',
  referenceImagePaths: 'reference images',
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
  // For LOCAL video, `mode` is the pipeline semantic for the lane (t2v / i2v /
  // first-last-frame / audio-to-video), not a backend selector — and only
  // text-to-video crosses the wire. Because `routedJobParams` drops `mode`
  // outright, an unguarded 'fflf' or 'a2v' job would come back as a plain
  // text-to-video clip: a valid-looking render of the wrong pipeline. Mirrors
  // the interactive route's non-text-mode rejection.
  if (kind === 'video' && params?.mode !== undefined && params.mode !== 'text') {
    unsupported.push(`a non-text render mode ('${params.mode}')`);
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
  const settings = await getSettings().catch(() => null);
  return !!(settings && normalizeMediaRoutingConfig(settings)[kind]);
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
  // An unreadable settings file is an install-level fault, not a provider
  // fault: no configuration is knowable at all, which is the same state as a
  // fresh install. Rendering locally matches what the rest of this enqueue
  // path already does with an unreadable settings read (the render-backend
  // pin ladder falls through untouched) — hard-failing every autonomous
  // render on a transient read error would be a far worse outcome than one
  // local render. It is logged rather than swallowed so it can never look
  // like "no route configured".
  const settings = await getSettings().catch((error) => {
    console.error(`❌ Federated media routing could not read settings: ${error.message}`);
    return null;
  });
  if (!settings) return null;
  const route = normalizeMediaRoutingConfig(settings)[kind];
  if (!route) return null;

  if (!trimmed(params?.prompt)) {
    throw new ServerError(
      `A federated ${kind} render needs a prompt`,
      { status: 400, code: 'MEDIA_PROVIDER_PROMPT_REQUIRED' },
    );
  }
  assertRoutableConditioning(kind, params);
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
  const { peer, remoteMedia } = await prepareRemoteMediaJob({
    peerId: route.peerId,
    kind,
    request,
  });
  // NOTE: the geometry forwarded here was snapped to the LOCAL model catalog by
  // the enqueue path ahead of this resolver, and wire v1's capability payload
  // publishes no frame-stride/canvas constraints to re-snap it against. A
  // provider whose model has its own frame rule (Wan 2.2 needs
  // `(numFrames - 1) % frameStride === 0`) therefore rejects such a job with a
  // typed `WAN22_INVALID_FRAME_COUNT` — loud and fail-closed, but it makes that
  // pairing unusable until the capability contract carries the constraint. That
  // negotiation is its own slice; see the follow-up issue.
  return { peer, request, remoteMedia };
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
  const jobParams = { ...(params || {}) };
  for (const key of LOCAL_ONLY_ROUTED_PARAMS) delete jobParams[key];
  const dropped = DROPPED_POST_PROCESSING.filter((key) => jobParams[key] === true);
  for (const key of DROPPED_POST_PROCESSING) delete jobParams[key];
  if (dropped.length) {
    console.log(`🌐 Federated render: ${dropped.join(' and ')} will not run on a routed job`);
  }
  return { ...jobParams, prompt: '', modelId: request.modelId, remoteMedia };
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
