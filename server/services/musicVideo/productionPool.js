/**
 * Music Video production run (#9066) — the allowed provider/model pool.
 *
 * A pool route is `{ kind: 'image'|'video', mode, model }`: a render backend
 * from the shared alphabets (lib/generationModes.js) plus, where the backend
 * takes one, a model id. Eligibility is re-derived from LIVE settings and
 * catalogs every time — at Start (every route must be eligible) and again at
 * dispatch for the route a step picked — so a backend disabled, a key removed
 * or a local model uninstalled mid-run refuses that step before enqueue
 * instead of silently falling back to something the director did not allow.
 *
 * Capability is per scene: a frame conditioned on the visual spec's reference
 * images needs a backend (and local model) that consumes reference images, and
 * a performance shot needs a source-audio lip-sync video provider. A route
 * that cannot serve a scene is skipped for that scene with the reason
 * recorded; when no pool route can, the run halts with every reason listed.
 *
 * `metered` routes spend money or remote quota. PortOS has no price catalog
 * for any of them, so their price is unknown (null) and a run with a dollar
 * cap refuses them; local routes cost $0.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { QUEUEABLE_IMAGE_MODES, VIDEO_GEN_MODES } from '../../lib/generationModes.js';
import { MUSIC_VIDEO_AUTOMATION_TOOLS } from '../../lib/musicVideoAutomation.js';
import { isPerformanceScene, performanceBlockedReason } from '../../lib/musicVideoShotTiming.js';
import { maxInputImages, supportsCloudModelOverride } from '../../lib/imageGenCapabilities.js';
import { isHardwareCompatible } from '../../lib/systemCapabilities.js';
import { RUNNER_FAMILIES } from '../../lib/runners.js';
import { poolHasRoute, routeKey } from './production.js';

// The image backends accept at most four reference images for most models;
// mirrors the board's MAX_CONDITIONING_REFERENCES (useMusicVideoSceneMedia.js).
const MAX_CONDITIONING_REFERENCES = 4;

const describe = (route) => `${route.kind} ${route.mode}${route.model ? ` (${route.model})` : ''}`;
const isMetered = (route) => MUSIC_VIDEO_AUTOMATION_TOOLS.some((t) => t.id === `${route.kind}:${route.mode}` && t.metered);

/** The price per generation this install can vouch for: 0 for local, null (unknown) for metered. */
const routePriceUsd = (route) => (isMetered(route) ? null : 0);

/** routeKey → price map for a pool. */
export const poolPricing = (pool) => Object.fromEntries(pool.map((r) => [routeKey(r), routePriceUsd(r)]));

/** The visual-spec references a frame is conditioned on (capped to the backend limit). */
export const conditioningReferences = (project) => (project?.visualSpec?.references || [])
  .filter((ref) => ref?.condition && ref.imageId).slice(0, MAX_CONDITIONING_REFERENCES);

/** What a scene's `kind` generation needs from a route. */
export function sceneRequirement(project, scene, stepKind) {
  return stepKind === 'frame'
    ? { kind: 'image', conditioning: conditioningReferences(project).length }
    : { kind: 'video', performance: isPerformanceScene(scene) };
}

/**
 * The live facts eligibility reads. Loaded lazily (the catalogs are heavy)
 * and injectable for tests.
 */
export async function loadPoolEnv() {
  const [{ getSettings }, { getImageModels }, { resolveVideoModelSelection }] = await Promise.all([
    import('../settings.js'),
    import('../../lib/mediaModels.js'),
    import('../videoGen/modelSelection.js'),
  ]);
  const { isVideoModeUsable } = await import('../videoGen/modes.js');
  return {
    settings: await getSettings(),
    imageModels: getImageModels(),
    resolveVideoModel: (modelId) => resolveVideoModelSelection(modelId),
    isVideoModeUsable,
  };
}

/**
 * Is `route` runnable on this install right now? Returns `{ ok, reason }`.
 * Covers the explicit opt-in toggles (a cloud CLI spends quota only when
 * enabled), configured API keys, installed + hardware-compatible local
 * models, and whether a named cloud model can actually be selected.
 */
async function routeEligibility(route, env) {
  const { settings } = env;
  if (route.kind === 'image') {
    if (!QUEUEABLE_IMAGE_MODES.includes(route.mode)) {
      return { ok: false, reason: `${describe(route)} renders synchronously and cannot run unattended; choose a queued image backend` };
    }
    if (route.mode === 'local') {
      if (!settings?.imageGen?.local?.pythonPath) return { ok: false, reason: 'The local image runtime is not configured in Settings' };
      const model = (env.imageModels || []).find((m) => m.id === route.model);
      if (!route.model || !model) return { ok: false, reason: `Local image model "${route.model || '(none)'}" is not installed` };
      if (!isHardwareCompatible(model.hardwareCompatibility)) return { ok: false, reason: `Local image model "${route.model}" cannot run on this hardware` };
      return { ok: true, reason: null };
    }
    if (settings?.imageGen?.[route.mode]?.enabled !== true) {
      return { ok: false, reason: `${describe(route)} is not enabled in Settings → Image Gen` };
    }
    const configured = settings.imageGen[route.mode].model || null;
    if (route.model && route.model !== configured && !supportsCloudModelOverride(route.mode)) {
      return { ok: false, reason: `${route.mode} image gen cannot select model "${route.model}"; it renders with its configured model only` };
    }
    return { ok: true, reason: null };
  }
  if (!VIDEO_GEN_MODES.includes(route.mode)) return { ok: false, reason: `Unknown video backend "${route.mode}"` };
  if (!env.isVideoModeUsable(settings, route.mode)) {
    return { ok: false, reason: `${describe(route)} is not usable — enable it or configure its API key in Settings` };
  }
  if (route.mode === 'local') {
    if (!settings?.imageGen?.local?.pythonPath) return { ok: false, reason: 'The local video runtime is not configured in Settings' };
    if (!route.model) return { ok: false, reason: 'A local video route must name its model' };
    const { model } = await env.resolveVideoModel(route.model);
    if (!model) return { ok: false, reason: `Local video model "${route.model}" is not installed` };
    if (!isHardwareCompatible(model.hardwareCompatibility)) return { ok: false, reason: `Local video model "${route.model}" cannot run on this hardware` };
  }
  return { ok: true, reason: null };
}

/** Why `route` cannot serve this scene requirement, or null when it can. */
function routeIncapableReason(route, requirement, env) {
  if (route.kind !== requirement.kind) return `${describe(route)} does not generate ${requirement.kind === 'image' ? 'frames' : 'clips'}`;
  if (requirement.kind === 'image' && requirement.conditioning > 0) {
    const limit = route.mode === 'local' ? null : maxInputImages(route.mode);
    if (limit != null && requirement.conditioning > limit) {
      return `${describe(route)} takes at most ${limit} reference image${limit === 1 ? '' : 's'}; the visual spec conditions on ${requirement.conditioning}`;
    }
    if (route.mode === 'local') {
      const model = (env.imageModels || []).find((m) => m.id === route.model);
      if (model?.runner !== RUNNER_FAMILIES.FLUX2 && model?.pipelineClass !== 'QwenImage21Pipeline') {
        return `Local model "${route.model}" cannot use reference images (FLUX.2 and Qwen Image 2.1 only)`;
      }
    }
  }
  if (requirement.kind === 'video' && requirement.performance) {
    return performanceBlockedReason(route.mode);
  }
  return null;
}

/** Start-time check: every route in the pool must be eligible now. Throws 409 with every reason. */
export async function assertPoolEligible(pool, env) {
  const problems = [];
  for (const route of pool) {
    const { ok, reason } = await routeEligibility(route, env);
    if (!ok) problems.push(reason);
  }
  if (problems.length) {
    throw new ServerError(`Some allowed routes cannot run: ${problems.join('; ')}`, { status: 409, code: 'PRODUCTION_ROUTE_INELIGIBLE', context: { problems } });
  }
}

/**
 * Dispatch-time enforcement for ONE chosen route: it must be a literal member
 * of the run's pool, eligible right now, and capable of this scene. Throws
 * 409 before anything is enqueued — there is never a fallback to another route.
 */
export async function assertRouteAllowed(run, route, requirement, env) {
  if (!poolHasRoute(run, route)) {
    throw new ServerError(`${route ? describe(route) : 'That route'} is not in this run's allowed pool`, { status: 409, code: 'PRODUCTION_ROUTE_NOT_ALLOWED' });
  }
  const { ok, reason } = await routeEligibility(route, env);
  if (!ok) throw new ServerError(reason, { status: 409, code: 'PRODUCTION_ROUTE_INELIGIBLE' });
  const incapable = routeIncapableReason(route, requirement, env);
  if (incapable) throw new ServerError(incapable, { status: 409, code: 'PRODUCTION_ROUTE_INCAPABLE' });
}

/**
 * The default chooser: the first route in the director's pool order that is
 * eligible and capable. Returns `{ route, rationale }`, or `{ route: null,
 * reasons }` listing why every candidate was passed over.
 */
export async function chooseProductionRoute(run, requirement, env) {
  const reasons = [];
  const candidates = run.pool.filter((r) => r.kind === requirement.kind);
  if (!candidates.length) return { route: null, reasons: [`The allowed pool has no ${requirement.kind} route`] };
  for (const route of candidates) {
    const { ok, reason } = await routeEligibility(route, env);
    if (!ok) { reasons.push(reason); continue; }
    const incapable = routeIncapableReason(route, requirement, env);
    if (incapable) { reasons.push(incapable); continue; }
    const skipped = reasons.length ? ` (skipped ${reasons.length} earlier route${reasons.length === 1 ? '' : 's'}: ${reasons.join('; ')})` : '';
    const need = requirement.kind === 'image'
      ? (requirement.conditioning ? `frame conditioned on ${requirement.conditioning} reference image${requirement.conditioning === 1 ? '' : 's'}` : 'unconditioned frame')
      : (requirement.performance ? 'lip-synced performance shot' : 'cutaway clip');
    return { route, rationale: `First eligible ${requirement.kind} route in the allowed pool for ${/^[aeiou]/.test(need) ? 'an' : 'a'} ${need}${skipped}` };
  }
  return { route: null, reasons };
}
