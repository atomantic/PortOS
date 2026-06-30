/**
 * Creative Director — first-pass asset generation (#1818, extended by #1867).
 *
 * Follow-up to the Auto-cast MVP (#1810) and auto-compose (#1817). When the
 * autonomous path seeds a project's cast from the catalog, an opt-in
 * "generate first-pass assets" step kicks off a catalog portrait render for
 * each freshly-cast member that has no portrait yet — so the cast "arrives
 * on-model" without the user hand-rendering each ingredient.
 *
 * #1867 extends the same opt-in step one stage later: once auto-compose has
 * written a treatment (a scene plan exists), `enqueueFirstPassSceneFrames`
 * seeds a first reference frame per scene the same way portraits are seeded.
 * The other two downstream modalities #1818 named (scene clips / i2v, music
 * bed) are genuinely separate pipelines and are tracked as their own issues
 * rather than folded in here.
 *
 * Reuse, not a new pipeline (the issue's explicit constraint). Each render is
 * an ordinary image-gen job enqueued onto the SAME mediaJobQueue with the same
 * `catalogAttach` tag the manual portrait path uses (#1359), so the durable
 * server-side `catalogImageAttachHook` files the finished render onto the
 * ingredient as its portrait — even with no client mounted. We add no attach
 * logic here; we only enqueue and tag.
 *
 * Director-first + strictly optional: only the queue-backed modes (local /
 * codex) are seeded — they route through the durable attach hook. If image-gen
 * is configured for external SD-API, codex is disabled, etc., first-pass gen
 * skips gracefully (recorded in the returned summary) rather than failing the
 * auto-cast request. Autonomy seeds what it can; the director takes over.
 */

import { enqueueJob } from '../mediaJobQueue/index.js';
import { getSettings } from '../settings.js';
import { resolveImageCleaners } from '../imageGen/index.js';
import { IMAGE_GEN_MODE } from '../imageGen/modes.js';
import { getIngredient, listMediaForIngredient } from '../catalogDB.js';
import { ASPECT_PRESETS } from '../../lib/creativeDirectorPresets.js';
import { payloadSnippet, getActiveCatalogType } from '../../lib/catalogTypes.js';

// Keep the derived portrait prompt bounded — enough descriptive text to render
// on-model, not the whole payload. Mirrors the cast-summary budget order of
// magnitude (catalogSeed's CAST_SUMMARY_CHARS = 200) but a touch wider since
// this is the actual render prompt, not a list snippet.
const PORTRAIT_PROMPT_CHARS = 400;

/**
 * Pure: derive an image-gen prompt for a catalog ingredient's first-pass
 * portrait. The name anchors the subject; the payload snippet (characters fall
 * back to `physicalDescription`, others to `description` — the same fallback
 * chain the cast summary uses via `snippetFallbackKeys`) supplies the visual
 * detail. Returns '' when the ingredient carries no usable name/description, so
 * the caller can skip it rather than queue a contentless render.
 */
export function buildPortraitPrompt(ingredient) {
  if (!ingredient || typeof ingredient !== 'object') return '';
  const name = typeof ingredient.name === 'string' ? ingredient.name.trim() : '';
  const detail = payloadSnippet(ingredient.payload, ingredient.type, PORTRAIT_PROMPT_CHARS, getActiveCatalogType);
  if (name && detail) return `${name} — ${detail}`;
  return name || detail || '';
}

/**
 * Resolve the queue-backed image-gen mode + the per-job base params, or a
 * not-ready marker when first-pass gen can't run as a background batch
 * (external mode, codex disabled). Reads settings the same way the imageGen
 * route + universeBuilderRender do, so the cleanC2PA / denoise cleaners apply
 * to first-pass renders exactly like a manual portrait render.
 *
 * Exported so `enqueueFirstPassSceneFrames` (#1867) shares the exact same
 * queue-backed-mode gate as the portrait path rather than re-deriving it.
 */
export async function resolveQueueModeParams() {
  const settings = await getSettings();
  const mode = settings.imageGen?.mode || IMAGE_GEN_MODE.EXTERNAL;
  if (mode === IMAGE_GEN_MODE.CODEX) {
    const c = settings.imageGen?.codex || {};
    if (!c.enabled) return { mode, ready: false, reason: 'codex-disabled' };
    const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, mode);
    return {
      mode,
      ready: true,
      jobParams: { mode: IMAGE_GEN_MODE.CODEX, codexPath: c.codexPath, model: c.model, cleanC2PA, denoise },
    };
  }
  if (mode === IMAGE_GEN_MODE.LOCAL) {
    // We pass no modelId, so the worker renders with its default ('dev') model —
    // an mflux model that REQUIRES a configured pythonPath (the imageGen route
    // and universeBuilderRender both reject this up front with
    // IMAGE_GEN_NOT_CONFIGURED). First-pass gen runs fire-and-forget with no
    // client listening, so a doomed job's SSE failure would vanish while the
    // user is told portraits are rendering. Skip cleanly instead — same
    // graceful-skip contract as a disabled codex.
    const pythonPath = settings.imageGen?.local?.pythonPath || null;
    if (!pythonPath) return { mode, ready: false, reason: 'local-not-configured' };
    const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, mode);
    return {
      mode,
      ready: true,
      jobParams: { pythonPath, cleanC2PA, denoise },
    };
  }
  // external (or an unknown mode) — synchronous SD-API isn't suited for a
  // fire-and-forget background batch and doesn't route through the durable
  // attach hook, so first-pass gen sits this one out.
  return { mode, ready: false, reason: 'mode-unsupported' };
}

/**
 * Already has a live portrait? First-pass gen never clobbers an on-model
 * portrait — it only fills the gap for cast members that have none, so re-running
 * auto-cast with the toggle on is idempotent.
 */
async function ingredientHasPortrait(ingredientId) {
  const media = await listMediaForIngredient(ingredientId);
  return media.some((m) => m.kind === 'portrait');
}

/**
 * Enqueue first-pass portrait renders for the given cast members lacking a
 * portrait. `members` is the cast-view array (each carries `ingredientId`) —
 * typically the `added` set auto-cast just appended.
 *
 * Returns `{ mode, enqueued: [{ ingredientId, jobId }], skipped: [{ ingredientId, reason }], reason? }`.
 * Best-effort and self-contained: a single ingredient being gone / promptless is
 * recorded in `skipped`, never thrown — this runs as a side-effect of auto-cast,
 * so it must not fail the seeding it follows.
 */
export async function enqueueFirstPassPortraits(members = []) {
  const list = Array.isArray(members) ? members.filter((m) => m && m.ingredientId) : [];
  if (list.length === 0) return { mode: null, enqueued: [], skipped: [] };

  const resolved = await resolveQueueModeParams();
  if (!resolved.ready) {
    return { mode: resolved.mode, enqueued: [], skipped: [], reason: resolved.reason };
  }

  // Resolve each member's render decision concurrently — the per-member reads
  // (getIngredient + portrait check) are independent, so a 50-member cast costs
  // one round-trip batch rather than ~2N serial queries. Promise.all preserves
  // order, so the enqueue pass below still assigns jobIds in cast order.
  const decisions = await Promise.all(list.map(async ({ ingredientId }) => {
    const ingredient = await getIngredient(ingredientId);
    if (!ingredient) return { ingredientId, skip: 'gone' };
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
    const queued = enqueueJob({
      kind: 'image',
      params: {
        ...resolved.jobParams,
        prompt,
        // Tag the job so the durable catalogImageAttachHook (#1359) files the
        // finished render as this ingredient's portrait — no mounted client
        // required. Explicit `kind: 'portrait'` since this is a deliberate
        // first-pass portrait, not an ad-hoc reference render.
        catalogAttach: { ingredientId, kind: 'portrait' },
      },
    });
    enqueued.push({ ingredientId, jobId: queued.jobId });
  }
  console.log(`🎨 CD first-pass portraits: ${enqueued.length} queued, ${skipped.length} skipped (${resolved.mode})`);
  return { mode: resolved.mode, enqueued, skipped };
}

/**
 * Enqueue first-pass scene reference-frame renders for a project's treatment
 * (#1867 — the first slice of #1818's deferred "extend beyond portraits"
 * follow-up). Once auto-compose (#1817) has written a scene plan, seed an
 * on-model reference frame per scene the same way `enqueueFirstPassPortraits`
 * seeds cast portraits: one image-gen job per scene tagged for the durable
 * `creativeDirectorSceneImageHook`, which files the finished render onto
 * `scene.sourceImageFile` — the SAME field a manually-set reference image or
 * an i2v-continuation source already populates (sceneRunner.js reads it as
 * the render's source image), so first-pass gen fills the gap rather than
 * adding a parallel field.
 *
 * Director-first + idempotent: a scene that already carries a
 * `sourceImageFile` (set by hand, a prior first-pass run, or the agent
 * itself) is left alone. Best-effort and self-contained — a single scene
 * missing a prompt is recorded in `skipped`, never thrown, since this runs as
 * a side effect of writing the treatment and must not fail that write.
 *
 * Renders at the project's locked-in `aspectRatio` (via `ASPECT_PRESETS`) so
 * the seeded frame matches what sceneRunner.js will force-crop the source
 * image to at actual render time — an unscaled square seed would have its
 * edges cropped away to fit a 16:9/9:16 target.
 *
 * Returns `{ mode, enqueued: [{ sceneId, jobId }], skipped: [{ sceneId, reason }], reason? }`.
 */
export async function enqueueFirstPassSceneFrames(project) {
  const scenes = Array.isArray(project?.treatment?.scenes) ? project.treatment.scenes : [];
  if (scenes.length === 0) return { mode: null, enqueued: [], skipped: [] };

  const resolved = await resolveQueueModeParams();
  if (!resolved.ready) {
    return { mode: resolved.mode, enqueued: [], skipped: [], reason: resolved.reason };
  }

  // Render at the project's locked-in aspect ratio, not the image worker's
  // square default. sceneRunner.js force-scales+center-crops whatever source
  // image it's handed to the project's target box
  // (`scale=w:h:force_original_aspect_ratio=increase,crop=w:h` in
  // videoGen/local.js) — a square seed for a 16:9/9:16 project would have a
  // large chunk of its top/bottom or left/right cropped away before the
  // scene ever renders, silently defeating the seeded frame. Falls back to
  // the worker's own default (undefined → 1024x1024) for an unrecognized
  // aspectRatio rather than throwing, matching this function's best-effort
  // contract.
  const { width, height } = ASPECT_PRESETS[project.aspectRatio] || {};

  const enqueued = [];
  const skipped = [];
  for (const scene of scenes) {
    if (!scene?.sceneId) continue;
    if (scene.sourceImageFile) {
      skipped.push({ sceneId: scene.sceneId, reason: 'has-reference' });
      continue;
    }
    const prompt = typeof scene.prompt === 'string' ? scene.prompt.trim() : '';
    if (!prompt) {
      skipped.push({ sceneId: scene.sceneId, reason: 'no-prompt' });
      continue;
    }
    const queued = enqueueJob({
      kind: 'image',
      params: {
        ...resolved.jobParams,
        prompt,
        width,
        height,
        // Tag the job so the durable creativeDirectorSceneImageHook files the
        // finished render onto this scene's sourceImageFile — no mounted
        // client required. Mirrors the catalogAttach tag the portrait path
        // uses for the catalog hook.
        creativeDirector: { projectId: project.id, sceneId: scene.sceneId },
      },
    });
    enqueued.push({ sceneId: scene.sceneId, jobId: queued.jobId });
  }
  console.log(`🎬 CD first-pass scene frames: ${enqueued.length} queued, ${skipped.length} skipped (${resolved.mode})`);
  return { mode: resolved.mode, enqueued, skipped };
}
