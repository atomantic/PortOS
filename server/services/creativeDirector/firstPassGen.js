/**
 * Creative Director — first-pass asset generation (#1818).
 *
 * Follow-up to the Auto-cast MVP (#1810) and auto-compose (#1817). When the
 * autonomous path seeds a project's cast from the catalog, an opt-in
 * "generate first-pass assets" step kicks off a catalog portrait render for
 * each freshly-cast member that has no portrait yet — so the cast "arrives
 * on-model" without the user hand-rendering each ingredient.
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
 */
async function resolveQueueModeParams() {
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
    const { cleanC2PA, denoise } = resolveImageCleaners(undefined, settings, mode);
    // modelId omitted → the worker falls through to its default ('dev') model,
    // matching the manual portrait path which also passes no modelId. pythonPath
    // may be null (FLUX.2 carries its own venv); the worker surfaces a missing
    // python over SSE rather than us hard-failing the whole auto-cast request.
    return {
      mode,
      ready: true,
      jobParams: { pythonPath: settings.imageGen?.local?.pythonPath || null, cleanC2PA, denoise },
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

  const enqueued = [];
  const skipped = [];
  for (const member of list) {
    const { ingredientId } = member;
    const ingredient = await getIngredient(ingredientId);
    if (!ingredient) {
      skipped.push({ ingredientId, reason: 'gone' });
      continue;
    }
    if (await ingredientHasPortrait(ingredientId)) {
      skipped.push({ ingredientId, reason: 'has-portrait' });
      continue;
    }
    const prompt = buildPortraitPrompt(ingredient);
    if (!prompt) {
      skipped.push({ ingredientId, reason: 'no-prompt' });
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
