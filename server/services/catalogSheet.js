import { assertCatalogIdentityWritable } from './catalogDB/identityAccess.js';
/**
 * Catalog reference sheets: a sheet for a catalog record without needing a
 * universe, plus environment (place) and product (object) sheet kinds.
 *
 * A character already linked to a universe canon entry delegates to the
 * universe renderer, so its sheet keeps landing on the canon pointer. Every
 * other record builds from its own payload and queues an image job tagged
 * `catalogAttach` with `role: 'sheet:<variant>'`; catalogImageAttachHook files
 * the finished image as a `reference` media row with that role (never the
 * portrait), and the card-cover query skips sheet roles.
 *
 * A `look` render (variant `look` + `wardrobeId`) dresses a character in one
 * of its `payload.wardrobes`. It is driven from the record's Looks tab, so it
 * is not listed among the sheet variants, and it always renders through the
 * catalog path — even for a universe-linked character — tagged
 * `role: 'look:<wardrobeId>'`.
 */

import { ServerError } from '../lib/errorHandler.js';
import { universeAestheticLine } from '../lib/universeVisualStyle.js';
import { recordRenderPin } from '../lib/renderTargets.js';
import { shortId } from '../lib/fileUtils.js';
import { getIngredient, getIngredientIdentityIds, listLiveRefsForIngredient } from './catalogDB.js';
import { getUniverse } from './universeBuilder.js';
import { enqueueJob } from './mediaJobQueue/index.js';
import {
  DEFAULT_CHARACTER_SHEET_STYLE,
  buildSheetRenderParams,
  getSheetVariantBuilder,
  listSheetVariants,
  previewCharacterReferenceSheet,
  renderCharacterReferenceSheet,
} from './universeCharacterSheet.js';
import {
  DEFAULT_ENVIRONMENT_SHEET_STYLE,
  DEFAULT_PRODUCT_SHEET_STYLE,
  buildEnvironmentSheetPrompt,
  buildProductSheetPrompt,
  buildCharacterLookPrompt,
} from './catalogSheetPrompts.js';
import { CATALOG_LOOK_VARIANT_ID } from '../lib/catalogValidation.js';

const CATALOG_SHEET_VARIANTS = Object.freeze({
  place: Object.freeze([Object.freeze({
    id: 'environment',
    label: 'Environment sheet',
    description: 'Establishing wide, reverse angle, detail inserts and a palette strip of the empty location.',
    build: buildEnvironmentSheetPrompt,
    defaultStyle: DEFAULT_ENVIRONMENT_SHEET_STYLE,
    negativesLabel: 'Environment sheet negatives',
  })]),
  object: Object.freeze([Object.freeze({
    id: 'product',
    label: 'Product sheet',
    description: 'Front, side, back and top views on a plain backdrop, with a scale reference and macro detail.',
    build: buildProductSheetPrompt,
    defaultStyle: DEFAULT_PRODUCT_SHEET_STYLE,
    negativesLabel: 'Product sheet negatives',
  })]),
});

function characterVariants() {
  return listSheetVariants().map((v) => ({
    ...v,
    build: getSheetVariantBuilder(v.id),
    defaultStyle: DEFAULT_CHARACTER_SHEET_STYLE,
    negativesLabel: 'Character sheet negatives',
  }));
}

function variantsForType(type) {
  if (type === 'character') return characterVariants();
  return Object.prototype.hasOwnProperty.call(CATALOG_SHEET_VARIANTS, type) ? CATALOG_SHEET_VARIANTS[type] : [];
}

/** The sheet kinds a catalog type can render (empty for types without one). */
export function listCatalogSheetVariants(type) {
  return variantsForType(type).map(({ id, label, description }) => ({ id, label, description }));
}

// The `look` variant for one wardrobe entry, or a 400 when the record is not
// a character or the wardrobe is not one of its own.
function lookVariantFor(ingredient, payload, wardrobeId) {
  if (ingredient.type !== 'character') {
    throw new ServerError(`A look render is only available for a character, not a ${ingredient.type}`,
      { status: 400, code: 'VALIDATION_ERROR' });
  }
  const wardrobes = Array.isArray(payload.wardrobes) ? payload.wardrobes : [];
  const wardrobe = wardrobes.find((w) => w && typeof w === 'object' && w.id === wardrobeId);
  if (!wardrobe) {
    throw new ServerError(`"${ingredient.name}" has no look with id "${wardrobeId ?? ''}"`,
      { status: 400, code: 'VALIDATION_ERROR' });
  }
  return {
    id: CATALOG_LOOK_VARIANT_ID,
    label: 'Look',
    build: (universe, entry) => buildCharacterLookPrompt(universe, entry, wardrobe),
    defaultStyle: DEFAULT_CHARACTER_SHEET_STYLE,
    negativesLabel: 'Look negatives',
    role: `look:${wardrobe.id}`,
  };
}

// Load + guard the record, resolve its variant and any universe it links to.
async function resolveSheetTarget(id, options) {
  const ingredient = await getIngredient(id);
  if (!ingredient) throw new ServerError('Ingredient not found', { status: 404, code: 'NOT_FOUND' });
  const payload = ingredient.payload && typeof ingredient.payload === 'object' ? ingredient.payload : {};
  if (payload.locked === true) {
    throw new ServerError(
      `"${ingredient.name}" is locked — unlock it before rendering a reference sheet`,
      { status: 409, code: 'CATALOG_INGREDIENT_LOCKED' },
    );
  }
  const isLook = options.variant === CATALOG_LOOK_VARIANT_ID;
  const variants = variantsForType(ingredient.type);
  const variant = isLook
    ? lookVariantFor(ingredient, payload, options.wardrobeId)
    : options.variant
      ? variants.find((v) => v.id === options.variant)
      : variants[0];
  if (!variant) {
    throw new ServerError(
      `Sheet variant "${options.variant ?? ''}" is not available for a ${ingredient.type}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }

  const refs = await listLiveRefsForIngredient(id);
  const universes = [];
  for (const ref of refs) {
    if (ref.refKind !== 'universe') continue;
    // A ref can outlive its universe (getUniverse throws NOT_FOUND then).
    const universe = await getUniverse(ref.refId).catch(() => null);
    if (universe) universes.push(universe);
  }
  // A local consolidation retains embedded source variants. Render its
  // authoritative merged payload instead of delegating to a stale canon copy.
  const identityIds = await getIngredientIdentityIds(ingredient.id);
  if (ingredient.type === 'character' && !isLook && identityIds.length === 1) {
    for (const universe of universes) {
      const entry = (universe.characters || []).find((c) => c.ingredientId === ingredient.id);
      if (entry) return { ingredient, payload, variant, delegate: { universeId: universe.id, entryId: entry.id } };
    }
  }
  return { ingredient, payload, variant, universe: universes[0] ?? null };
}

async function buildCatalogSheet(target, options) {
  const { ingredient, payload, variant, universe } = target;
  const entry = { ...payload, name: ingredient.name };
  // The builders take a universe object; an empty one means "no universe" and
  // the template carries the variant's default style line instead.
  const built = variant.build(universe || {}, entry);
  const universeStyle = universe ? universeAestheticLine(universe) : '';
  return buildSheetRenderParams({
    built,
    options,
    styleLine: universeStyle || variant.defaultStyle,
    styleChip: universeStyle
      ? { id: 'universe-style', label: 'Universe style' }
      : { id: 'sheet-default-style', label: 'Default sheet style' },
    negativesLabel: variant.negativesLabel,
    renderPin: universe ? recordRenderPin(universe) : {},
  });
}

/** What a catalog sheet render would send, built by the render's own code. */
export async function previewCatalogSheet(id, options = {}) {
  const target = await resolveSheetTarget(id, options);
  if (target.delegate) {
    return previewCharacterReferenceSheet(target.delegate.universeId, target.delegate.entryId, {
      ...options, variant: target.variant.id,
    });
  }
  const { params } = await buildCatalogSheet(target, options);
  return {
    sentPrompt: params.prompt,
    ...(params.negativePrompt ? { sentNegativePrompt: params.negativePrompt } : {}),
    promptAdditions: params.promptAdditions || [],
  };
}

/** Queue a sheet render for a catalog record; returns `{ jobId, variant, delegatedTo }`. */
export async function renderCatalogSheet(id, options = {}) {
  await assertCatalogIdentityWritable(id);
  const target = await resolveSheetTarget(id, options);
  if (target.delegate) {
    const { universeId, entryId } = target.delegate;
    const result = await renderCharacterReferenceSheet(universeId, entryId, { ...options, variant: target.variant.id });
    return { ...result, delegatedTo: 'universe', universeId, entryId };
  }
  const { params, modelId, activeMode } = await buildCatalogSheet(target, options);
  const role = target.variant.role || `sheet:${target.variant.id}`;
  params.catalogAttach = { ingredientId: id, kind: 'reference', role };
  const queued = await enqueueJob({ kind: 'image', params });
  console.log(`🎨 Catalog ${target.variant.label} render — ingredient=${shortId(id)} job=${shortId(queued.jobId)} mode=${activeMode} model=${modelId}`);
  return {
    jobId: queued.jobId,
    generationId: queued.jobId,
    variant: target.variant.id,
    role,
    delegatedTo: null,
    queuePosition: queued.position,
  };
}
