/**
 * Video Gen — creative-surface backend pin → job params (#3135 / #3231 Phase 4).
 *
 * A Creative Director project can pin which backend renders its video
 * (`project.renderBackend.video = { mode, modelId }`), and a creative
 * commission is the main thing that sets it: the commission's
 * `generation.videoMode` / `.videoModelId` ride onto the project it mints each
 * fire (see creativeCommissions/abilityAdapters.js#buildRenderBackendPin).
 *
 * TWO different surfaces enqueue video for such a project, and both have to
 * honor that pin:
 *
 *   1. the PLAN-driven path — the planner LLM's `media_enqueueVideoJob` tool
 *      (`services/creative/tools/media.js#enforceRenderBackendPin`); and
 *   2. the TREATMENT/SCENE path — `creativeDirector/sceneRunner.js`, which
 *      renders each treatment scene directly, with no LLM in the loop. This is
 *      the path a commission's video actually travels most of the time.
 *
 * #3135 wired only (1). So a commission pinned to Grok still rendered every
 * scene on the local MLX runtime, and an install with no `imageGen.local
 * .pythonPath` failed the whole project up front even though Grok was
 * configured, enabled, and explicitly pinned. This module is the ONE place the
 * resolution ladder and backend job shapes live, so the two surfaces cannot
 * drift apart again.
 *
 * The helpers take `settings` rather than reading them, so the callers keep
 * their existing single settings read per enqueue.
 */

import { RENDER_TARGET, normalizeRenderPinValue } from '../../lib/renderTargets.js';
import { nearestGrokDuration } from '../../lib/grokVideoClip.js';
import { nearestReactorAspect } from '../../lib/reactorVideoClip.js';
import { ServerError } from '../../lib/errorHandler.js';
import { renderTargetDefaults } from '../imageGen/cloudProviderConfig.js';
import { VIDEO_GEN_MODE, VIDEO_GEN_MODES, resolveVideoMode, hasVideoPin, isVideoModeUsable } from './modes.js';

/**
 * Resolve the video backend for a CD project through the pin ladder: the
 * project's own `renderBackend.video` pin (per-record, wins) → the surface's
 * `renderDefaults[target].videoMode` pin → the install-wide
 * `settings.videoGen.mode` pin → LOCAL. Every rung is usability-gated by
 * `resolveVideoMode`, so a pin naming a backend whose toggle has since been
 * switched off degrades to local rather than bricking a nightly commission.
 *
 * `pinned` reports whether ANY rung named a backend (presence only, no
 * usability gating) — it's what lets a caller with a "byte-identical when
 * nothing is pinned" contract (enforceRenderBackendPin) return the caller's
 * params untouched instead of re-deriving them.
 *
 * `modelId` belongs to the resolved backend: local catalog pins follow the
 * existing project → target precedence; fal endpoint pins come only from an
 * explicit fal project pin. Grok and Reactor use their renderer's own model.
 */
export function resolveVideoBackendPin(project, settings, { target = RENDER_TARGET.CREATIVE_AGENT } = {}) {
  const raw = project?.renderBackend?.video || null;
  // Normalize the project's own pin through the SAME rule the settings rungs
  // use (`normalizeRenderPinValue`): the `'auto'` sentinel and blank strings
  // mean "no pin — fall through". A bare truthiness check would read a stored
  // `{ mode: 'auto' }` as a real pin and cost the caller its byte-identical
  // passthrough. Commissions never persist `auto` (buildRenderBackendPin drops
  // it), but a hand-made or peer-synced project can carry the sentinel.
  const mode = normalizeRenderPinValue(raw?.mode);
  const targetDefaults = renderTargetDefaults(settings, target);
  const strictMode = mode || normalizeRenderPinValue(targetDefaults.videoMode) || normalizeRenderPinValue(settings?.videoGen?.mode) || VIDEO_GEN_MODE.LOCAL;
  if (project?.workspace === 'video' && (!VIDEO_GEN_MODES.includes(strictMode) || !isVideoModeUsable(settings, strictMode))) {
    throw new ServerError(`The selected ${strictMode} video backend is unavailable. Enable it and configure its credentials in Settings, or change the production backend.`, { status: 409, code: 'VIDEO_BACKEND_UNAVAILABLE' });
  }
  const resolvedMode = project?.workspace === 'video' ? strictMode : resolveVideoMode(mode, settings, { target });
  // The target videoModel and project.modelId are local catalog choices. fal
  // accepts an endpoint model only from its own explicit project pin; Reactor
  // and Grok choose their models in the renderer. A lapsed fal pin must not
  // pass its endpoint id into the legacy local fallback either.
  const cloudModelPin = mode === VIDEO_GEN_MODE.FAL || mode === VIDEO_GEN_MODE.REACTOR;
  const localModelId = (!cloudModelPin && normalizeRenderPinValue(raw?.modelId))
    || targetDefaults.videoModel || null;
  const modelId = resolvedMode === VIDEO_GEN_MODE.LOCAL ? localModelId
    : resolvedMode === VIDEO_GEN_MODE.FAL && mode === VIDEO_GEN_MODE.FAL
      ? normalizeRenderPinValue(raw?.modelId) : null;
  return {
    // A model pin counts as a pin even with no mode beside it. Naming a local
    // video model IS a configured choice, and the resolved mode for an
    // otherwise-unpinned lane is LOCAL — the one backend that consumes a model
    // id — so there is always something for it to apply to. Gating `pinned` on
    // the mode alone made the two surfaces disagree: the scene path reads
    // `modelId` unconditionally and would honor it, while the planner path
    // takes its byte-identical early return and drops it. Nothing configured
    // still yields `pinned: false`, so the auto-is-byte-identical contract is
    // intact — the only jobs that change are ones the user asked to change.
    pinned: !!mode || !!modelId || hasVideoPin(settings, { target }),
    // What the project ASKED for, normalized — null when it pinned nothing.
    // Distinct from `mode` (what it GOT): when the two disagree, the ladder
    // degraded an unusable pin, and only the caller has the context to decide
    // whether that's worth reporting.
    requested: mode,
    mode: resolvedMode,
    modelId,
  };
}

/**
 * The Grok-lane job params for a video render.
 *
 * `mode: 'grok'` is the media-job queue's backend discriminator (it dispatches
 * to videoGen/grok.js on exactly this key); the t2v/i2v semantic that the local
 * lane keeps in `mode` travels as `videoMode` instead, matching what
 * routes/videoGen.js enqueues. videoGen/grok.js reads the same
 * `settings.imageGen.grok` slice the image path does — one CLI, one config.
 *
 * Clip length crosses a contract boundary here: every other surface authors a
 * duration in the local lane's continuous seconds, while Grok delivers 6s or
 * 10s and nothing else (measured — see lib/grokVideoClip.js). Without the
 * translation a 10s scene would silently come back 6s, because grok.js defaults
 * anything undeliverable to its 6s minimum. `nearestGrokDuration` rounds UP to
 * the shortest clip that still covers the request, which is free: a shorter
 * request costs the same wall clock and returns the same footage.
 *
 * Returns only the keys that are grok-specific, so a caller merges it over its
 * own params rather than being handed a whole job. That matters for geometry:
 * both callers already carry the project's `width`/`height`, and grok.js
 * derives its base-image aspect ratio from those in preference to the
 * configured `imageGen.grok.aspectRatio` — so this must not restate (or drop)
 * them, only supply the ratio fallback for a caller that has no geometry.
 */
export function grokVideoJobParams(settings, { sourceImagePath = null, durationSeconds } = {}) {
  const grok = settings?.imageGen?.grok || {};
  return {
    mode: VIDEO_GEN_MODE.GROK,
    videoMode: sourceImagePath ? 'image' : 'text',
    grokPath: grok.grokPath,
    duration: nearestGrokDuration(durationSeconds),
    ...(grok.aspectRatio ? { aspectRatio: grok.aspectRatio } : {}),
  };
}

/**
 * Apply a resolved creative video pin to the queue's renderer contract. Both
 * planner tools and direct scenes use this boundary so cloud backend tokens
 * cannot fall into local text/image mode or local-model reconciliation.
 *
 * Local params keep their semantic mode and conditioning intact. Cloud workers
 * accept a first frame, not local keyframe/audio/LoRA machinery; refuse those
 * requests before enqueue instead of producing an unconditioned paid clip.
 * Backend workers retain their own duration/prompt validation before submission
 * (in particular Reactor's shared short-clip limits, never a project-length clip).
 */
export function videoBackendJobParams(settings, pin, params = {}, { durationSeconds } = {}) {
  if (pin.mode === VIDEO_GEN_MODE.LOCAL) {
    const base = VIDEO_GEN_MODES.includes(params.mode)
      ? (({ mode: _backend, ...rest }) => rest)(params)
      : params;
    return pin.modelId ? { ...base, modelId: pin.modelId } : base;
  }

  const semantic = VIDEO_GEN_MODES.includes(params.mode) ? params.videoMode : params.mode;
  const hasInput = (value) => Array.isArray(value) ? value.length > 0 : Boolean(value);
  const unsupported = [
    'keyframes', 'lastImagePath', 'lastImageFile', 'audioFilePath', 'audioFile',
    'extendFromVideoId', 'extendFromVideoPath', 'icReferencePaths',
    'icReferenceVideoIds', 'icReferenceImageFiles', 'loras', 'loraPaths', 'loraFilenames',
  ].filter((key) => hasInput(params[key]));
  if (semantic && semantic !== 'text' && semantic !== 'image') unsupported.push(`mode ${semantic}`);
  if (Number(params.chunks) > 1) unsupported.push('chained chunks');
  if (Number(params.batchSize) > 1) unsupported.push('batched clips');
  if (params.disableAudio === true) unsupported.push('audio-disabled output');
  if (params.i2vReferenceMode && params.i2vReferenceMode !== 'anchor') unsupported.push('inspire reference mode');
  if (params.continueFromClipId && pin.mode !== VIDEO_GEN_MODE.REACTOR) unsupported.push('Reactor clip continuation');
  if (unsupported.length) {
    throw new ServerError(
      `The ${pin.mode} video backend cannot honor ${unsupported.join(', ')}. Remove those inputs or choose a compatible local render backend.`,
      { status: 400, code: 'VIDEO_BACKEND_INPUT_UNSUPPORTED' },
    );
  }

  // Keep attribution, geometry and source references, but never carry local
  // runtime/model knobs into a paid renderer with a different model namespace.
  const {
    modelId: _model, pythonPath: _python, numFrames: _frames, fps: _fps,
    steps: _steps, guidanceScale: _guidance, tiling: _tiling,
    imageStrength: _strength, disableAudio: _audio, ...base
  } = params;
  const sourceImagePath = params.sourceImagePath || null;
  const duration = params.duration ?? params.durationSeconds ?? durationSeconds;
  if (pin.mode === VIDEO_GEN_MODE.GROK) {
    return { ...base, ...grokVideoJobParams(settings, { sourceImagePath, durationSeconds: duration }) };
  }
  if (pin.mode === VIDEO_GEN_MODE.FAL) {
    return {
      ...base,
      mode: VIDEO_GEN_MODE.FAL,
      videoMode: sourceImagePath ? 'image' : 'text',
      ...(pin.modelId ? { modelId: pin.modelId } : {}),
      ...(duration != null ? { duration } : {}),
    };
  }
  if (pin.mode === VIDEO_GEN_MODE.REACTOR) {
    const seconds = params.seconds ?? duration;
    const aspect = Number(params.width) > 0 && Number(params.height) > 0
      ? nearestReactorAspect(params.width, params.height)
      : params.aspect ?? params.aspectRatio;
    return {
      ...base,
      mode: VIDEO_GEN_MODE.REACTOR,
      videoMode: sourceImagePath ? 'image' : 'text',
      ...(seconds != null ? { seconds } : {}),
      ...(aspect ? { aspect } : {}),
    };
  }
  throw new ServerError('Unknown video backend; choose a configured render backend.', {
    status: 400, code: 'VIDEO_BACKEND_UNSUPPORTED',
  });
}
