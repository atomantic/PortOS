import { assertCatalogIdentityWritable } from '../catalogDB/identityAccess.js';
/**
 * Creative Director — first-pass asset generation.
 *
 * When the autonomous path seeds a project's cast from the catalog, an opt-in "generate
 * first-pass assets" step renders a catalog portrait for each freshly-cast member with none, so
 * the cast arrives on-model. `enqueueFirstPassSceneFrames` extends it one stage later: once
 * auto-compose has written a treatment, it seeds a first reference frame per scene. Scene
 * clips (i2v) and the music bed are separate pipelines tracked as their own issues.
 *
 * Reuse, not a new pipeline: each render is an ordinary image-gen job on the SAME
 * mediaJobQueue with the same `catalogAttach` tag as the manual portrait path, so the durable
 * `catalogImageAttachHook` files the render onto the ingredient even with no client mounted.
 * We only enqueue and tag.
 *
 * Director-first and optional: only the queue-backed modes (local / codex) are seeded. If
 * image-gen is external SD-API, codex is disabled, etc., first-pass gen skips gracefully
 * (recorded in the returned summary) rather than failing the auto-cast request.
 */

import { enqueueUnattendedMediaJob, hasConfiguredMediaRoute } from '../federatedMedia/defaultRouting.js';
import { getSettings } from '../settings.js';
import { resolveImageCleaners } from '../../lib/imageCleanDefaults.js';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';
import { resolveRenderTargetConfig } from '../imageGen/cloudProviderConfig.js';
import { resolveLocalImageModel } from '../imageGen/prepareParams.js';
import { RENDER_TARGET } from '../../lib/renderTargets.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getIngredient, listMediaForIngredient } from '../catalog/catalogDB.js';
import { resolveAspectDimensions } from '../../lib/creativeDirectorPresets.js';
import { payloadSnippet, getActiveCatalogType } from '../../lib/catalog/catalogTypes.js';

// Keep the derived portrait prompt bounded: enough to render on-model, a touch wider than
// catalogSeed's CAST_SUMMARY_CHARS (200) since this is the actual render prompt.
const PORTRAIT_PROMPT_CHARS = 400;

/**
 * Pure: derive an image-gen prompt for a catalog ingredient's first-pass portrait. The name
 * anchors the subject; the payload snippet (characters: `physicalDescription`, others:
 * `description`, via `snippetFallbackKeys`) supplies visual detail. Returns '' with no usable
 * name/description so the caller skips rather than queue a contentless render.
 */
export function buildPortraitPrompt(ingredient) {
  if (!ingredient || typeof ingredient !== 'object') return '';
  const name = typeof ingredient.name === 'string' ? ingredient.name.trim() : '';
  const detail = payloadSnippet(ingredient.payload, ingredient.type, PORTRAIT_PROMPT_CHARS, getActiveCatalogType);
  if (name && detail) return `${name} — ${detail}`;
  return name || detail || '';
}

/**
 * Resolve the queue-backed image-gen mode + per-job base params, or a not-ready marker when
 * first-pass gen can't run as a background batch (external mode, codex disabled). Reads
 * settings like the imageGen route + universeBuilderRender so the cleanC2PA / denoise cleaners
 * apply as in a manual portrait render.
 *
 * Shared by `enqueueFirstPassSceneFrames` so both use the same queue-backed-mode gate.
 */
/**
 * `resolveQueueModeParams` answers "can this machine render locally". An install that routes
 * unattended renders to a peer often has no local image runtime, so a "not ready" verdict
 * would skip work the provider was going to do. When the image kind is routed the local
 * verdict is irrelevant: an unready local lane still yields an empty-but-ready param set.
 */
async function resolveOrRouteQueueParams(project = null) {
  const resolved = await resolveQueueModeParams(project);
  if (resolved.ready) return resolved;
  if (!(await hasConfiguredMediaRoute('image'))) return resolved;
  return { mode: resolved.mode, ready: true, jobParams: {} };
}

async function resolveQueueModeParams(project = null) {
  const settings = await getSettings();
  // Render-target ladder: the CD project's persisted renderBackend image pin → the
  // series-first-pass pin in settings.renderDefaults → the install default → external (not
  // ready). The record pin is usability-gated by the resolver, matching
  // enforceRenderBackendPin's live-settings contract.
  const projectPin = project?.renderBackend?.image || null;
  const { mode, cloud } = resolveRenderTargetConfig(settings, RENDER_TARGET.SERIES_FIRST_PASS, {
    recordMode: projectPin?.mode || null,
    recordModel: projectPin?.modelId || null,
    fallbackMode: IMAGE_GEN_MODE.EXTERNAL,
  });
  if (cloud) {
    if (!cloud.enabled) return { mode, ready: false, reason: cloud.disabledReason };
    const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, mode);
    return { mode, ready: true, jobParams: { ...cloud.jobParams, cleanC2PA, denoise } };
  }
  if (mode === IMAGE_GEN_MODE.LOCAL) {
    let localModel;
    try {
      localModel = resolveLocalImageModel(settings, {});
    } catch (err) {
      if (!(err instanceof ServerError)) throw err;
      return { mode, ready: false, reason: err.code };
    }
    if (!localModel.selectedModel) return { mode, ready: false, reason: 'IMAGE_GEN_UNKNOWN_MODEL' };
    const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, mode);
    return {
      mode,
      ready: true,
      jobParams: {
        pythonPath: localModel.pythonPath,
        modelId: localModel.selectedModel.id,
        cleanC2PA,
        denoise,
      },
    };
  }
  // external (or unknown mode): synchronous SD-API isn't suited to a background batch and
  // doesn't route through the durable attach hook, so first-pass gen sits out.
  return { mode, ready: false, reason: 'mode-unsupported' };
}

/**
 * Already has a live portrait? First-pass gen never clobbers one, so re-running auto-cast with
 * the toggle on is idempotent.
 */
async function ingredientHasPortrait(ingredientId) {
  const media = await listMediaForIngredient(ingredientId);
  return media.some((m) => m.kind === 'portrait');
}

/**
 * Enqueue first-pass portrait renders for the given cast members lacking a portrait. `members`
 * is the cast-view array (each carries `ingredientId`), typically the `added` set.
 *
 * Returns `{ mode, enqueued: [{ ingredientId, jobId }], skipped: [{ ingredientId, reason }], reason? }`.
 * Best-effort: a gone / promptless ingredient is recorded in `skipped`, never thrown, since
 * this runs as a side-effect of auto-cast and must not fail the seeding.
 */
export async function enqueueFirstPassPortraits(members = [], project = null) {
  const list = Array.isArray(members) ? members.filter((m) => m && m.ingredientId) : [];
  if (list.length === 0) return { mode: null, enqueued: [], skipped: [] };

  const resolved = await resolveOrRouteQueueParams(project);
  if (!resolved.ready) {
    return { mode: resolved.mode, enqueued: [], skipped: [], reason: resolved.reason };
  }

  // Resolve each member's decision concurrently (independent reads); Promise.all preserves
  // order, so the enqueue pass below still assigns jobIds in cast order.
  const decisions = await Promise.all(list.map(async ({ ingredientId }) => {
    const ingredient = await getIngredient(ingredientId);
    if (!ingredient) return { ingredientId, skip: 'gone' };
    const refused = await assertCatalogIdentityWritable(ingredientId).then(() => null, error => {
      if (error?.code?.startsWith('CATALOG_IDENTITY_')) return error.code;
      throw error;
    });
    if (refused) return { ingredientId, skip: refused };
    if (await ingredientHasPortrait(ingredientId)) return { ingredientId, skip: 'has-portrait' };
    const prompt = buildPortraitPrompt(ingredient);
    if (!prompt) return { ingredientId, skip: 'no-prompt' };
    return { ingredientId, prompt };
  }));

  const enqueued = [];
  const skipped = [];
  for (const { ingredientId, skip, prompt } of decisions) {
    if (skip) {
      skipped.push({ ingredientId, reason: skip });
      continue;
    }
    // A routed enqueue can reject on provider preflight (busy, stale, unauthorized, unsupported
    // conditioning); record the reason and keep going rather than abandon the REMAINING portraits.
    let queued;
    try {
      queued = await enqueueUnattendedMediaJob({
        kind: 'image',
        params: {
          ...resolved.jobParams,
          prompt,
          // Tag the job so the durable catalogImageAttachHook files the render as this ingredient's
          // portrait with no mounted client. Explicit `kind: 'portrait'`: a deliberate first-pass
          // portrait, not an ad-hoc reference render.
          catalogAttach: { ingredientId, kind: 'portrait' },
        },
      });
    } catch (error) {
      console.error(`❌ CD first-pass portrait ${ingredientId}: could not queue: ${error.message}`);
      skipped.push({ ingredientId, reason: error.code || 'enqueue-failed' });
      continue;
    }
    enqueued.push({ ingredientId, jobId: queued.jobId });
  }
  console.log(`🎨 CD first-pass portraits: ${enqueued.length} queued, ${skipped.length} skipped (${resolved.mode})`);
  return { mode: resolved.mode, enqueued, skipped };
}

/**
 * Enqueue first-pass scene reference-frame renders for a project's treatment. Once auto-compose
 * has written a scene plan, seed one image-gen job per scene tagged for the durable
 * `creativeDirectorSceneImageHook`, which files the render onto `scene.sourceImageFile` (the
 * field a manual reference or i2v-continuation source already populates; sceneRunner.js reads
 * it as the source image), so first-pass gen fills the gap rather than adding a field.
 *
 * Idempotent: a scene already carrying a `sourceImageFile` is left alone. Best-effort: a scene
 * missing a prompt is recorded in `skipped`, never thrown, since this runs as a side effect of
 * writing the treatment and must not fail that write.
 *
 * Fire-and-forget: the orchestrator can advance to rendering the first pending scene
 * (`completionHook.js`) before its seed job finishes, in which case that scene falls back to
 * text-to-video for its first attempt and the frame lands afterward for retries / manual
 * reference (race window tracked in #1929; fixing it would touch completionHook.js's
 * pause/resume/orphan-detection state machine).
 *
 * Renders at the project's `aspectRatio` (via `ASPECT_PRESETS`) so the frame matches what
 * sceneRunner.js force-crops the source to; an unscaled square would lose its edges.
 *
 * Skips `useContinuationFromPrior` scenes: sceneRunner.js overwrites their `sourceImageFile`
 * with the prior scene's extracted last frame, so a seeded frame would be silently discarded.
 *
 * Returns `{ mode, enqueued: [{ sceneId, jobId }], skipped: [{ sceneId, reason }], reason? }`.
 */
export async function enqueueFirstPassSceneFrames(project) {
  const scenes = Array.isArray(project?.treatment?.scenes) ? project.treatment.scenes : [];
  if (scenes.length === 0) return { mode: null, enqueued: [], skipped: [] };

  const resolved = await resolveOrRouteQueueParams(project);
  if (!resolved.ready) {
    return { mode: resolved.mode, enqueued: [], skipped: [], reason: resolved.reason };
  }

  // Render at the project's aspect ratio, not the worker's square default: sceneRunner.js
  // force-scales + center-crops the source to the target box (`scale=w:h:force_original_aspect_ratio=increase,crop=w:h`
  // in videoGen/local.js), so a square seed for 16:9/9:16 would lose much of an axis. Falls back
  // to the worker default (undefined → 1024x1024) for an unrecognized aspectRatio rather than
  // throwing, per the best-effort contract.
  const { width, height } = resolveAspectDimensions(project.aspectRatio, {});

  const enqueued = [];
  const skipped = [];
  for (const scene of scenes) {
    if (!scene?.sceneId) continue;
    if (scene.sourceImageFile) {
      skipped.push({ sceneId: scene.sceneId, reason: 'has-reference' });
      continue;
    }
    // A continuation scene's render source is the PRIOR scene's extracted last frame
    // (sceneRunner.js overwrites sourceImageFile on successful extraction), so a seeded frame is
    // normally discarded: wasted queue/GPU time. The extraction-failure fallback is the exception,
    // not what first-pass gen should optimize for.
    if (scene.useContinuationFromPrior) {
      skipped.push({ sceneId: scene.sceneId, reason: 'continuation' });
      continue;
    }
    const prompt = typeof scene.prompt === 'string' ? scene.prompt.trim() : '';
    if (!prompt) {
      skipped.push({ sceneId: scene.sceneId, reason: 'no-prompt' });
      continue;
    }
    // Same reason as the portrait loop: a routed enqueue can reject on provider
    // preflight, and one bad scene must not abandon the rest of the batch.
    let queued;
    try {
      queued = await enqueueUnattendedMediaJob({
        kind: 'image',
        params: {
          ...resolved.jobParams,
          prompt,
          width,
          height,
          // Tag the job so the durable creativeDirectorSceneImageHook files the render onto this
          // scene's sourceImageFile with no mounted client (mirrors the portrait path's catalogAttach).
          creativeDirector: { projectId: project.id, sceneId: scene.sceneId },
        },
      });
    } catch (error) {
      console.error(`❌ CD first-pass scene ${scene.sceneId}: could not queue: ${error.message}`);
      skipped.push({ sceneId: scene.sceneId, reason: error.code || 'enqueue-failed' });
      continue;
    }
    enqueued.push({ sceneId: scene.sceneId, jobId: queued.jobId });
  }
  console.log(`🎬 CD first-pass scene frames: ${enqueued.length} queued, ${skipped.length} skipped (${resolved.mode})`);
  return { mode: resolved.mode, enqueued, skipped };
}
