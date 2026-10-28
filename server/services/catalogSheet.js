import { isPhotographicVisualProfile, normalizeUniverseVisualProfile } from '../lib/universeVisualProfile.js';
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
 *
 * A `formId` render draws one of the record's `payload.forms` (another age,
 * era or look/style) instead of its canonical present-story form: the form's
 * age and description stand in for the record's own age/era and appearance
 * text, and the image is tagged `role: 'sheet:<variant>@<formId>'`. Like a
 * look it always renders through the catalog path, so the universe canon
 * pointer keeps holding the canonical sheet.
 */

import { ServerError } from '../lib/errorHandler.js';
import { universeAestheticLine, universeVisualStyleTokens } from '../lib/universeVisualStyle.js';
import { getBoard } from './moodBoard/db.js';
import { recordRenderPin } from '../lib/renderTargets.js';
import { shortId } from '../lib/fileUtils.js';
import { getIngredient, getIngredientIdentityIds, listLiveRefsForIngredient, listMediaForIngredient } from './catalogDB.js';
import { characterSheetEditBase, characterSheetReferenceCandidates } from '../lib/characterSheetReferences.js';
import { catalogUniverseContext } from '../lib/catalogUniverseContext.js';
import { getUniverse } from './universeBuilder.js';
import { enqueueJob } from './mediaJobQueue/index.js';
import {
  buildSheetRenderParams,
  assertSheetReferencesAvailable,
  getSheetVariantBuilder,
  getSheetVariantDefaultStyle,
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
import { catalogAppearance } from '../lib/catalogAppearance.js';
import { catalogFamilyRenderContext } from './catalogFamily.js';

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

function characterVariants(options) {
  return listSheetVariants(options).map((v) => ({
    ...v,
    build: getSheetVariantBuilder(v.id),
    defaultStyle: getSheetVariantDefaultStyle(v.id),
    negativesLabel: 'Character sheet negatives',
  }));
}

// `photographic` (a photoreal universe) lists the photographic character sheet first.
function variantsForType(type, options = {}) {
  if (type === 'character') return characterVariants(options);
  return Object.prototype.hasOwnProperty.call(CATALOG_SHEET_VARIANTS, type) ? CATALOG_SHEET_VARIANTS[type] : [];
}

/** The sheet kinds a catalog type can render (empty for types without one). */
export function listCatalogSheetVariants(type, options = {}) {
  return variantsForType(type, options).map(({ id, label, description }) => ({ id, label, description }));
}

async function universeContextFor(ingredient) {
  const refs = await listLiveRefsForIngredient(ingredient.id);
  const context = catalogUniverseContext(refs.map((ref) => ref.role === 'owner' && ref.ingredientId && ref.ingredientId !== ingredient.id
    ? { ...ref, role: 'retained-owner' } : ref));
  return { refs, context };
}

// A ref can outlive its universe (getUniverse throws NOT_FOUND then).
const getLinkedUniverse = (universeId) => getUniverse(universeId).catch((error) => {
  if (error?.code === 'NOT_FOUND') return null;
  throw error;
});

/**
 * The sheet kinds a record can render, ordered for its owning universe: a
 * character in a photoreal universe lists the photographic sheet first.
 */
export async function listCatalogSheetVariantsFor(ingredient) {
  if (ingredient.type !== 'character') return listCatalogSheetVariants(ingredient.type);
  const { context } = await universeContextFor(ingredient);
  const owner = context.owner?.refKind === 'universe' ? await getLinkedUniverse(context.owner.refId) : null;
  return listCatalogSheetVariants(ingredient.type, { photographic: isPhotographicVisualProfile(owner?.visualProfile) });
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
    build: (universe, entry, direction, layout) => buildCharacterLookPrompt(universe, entry, wardrobe, direction, layout),
    negativesLabel: 'Look negatives',
    role: `look:${wardrobe.id}`,
  };
}

const MEDIA_ROLE_MAX = 64;

function formFor(ingredient, payload, formId) {
  if (!formId) return null;
  const forms = Array.isArray(payload.forms) ? payload.forms : [];
  const form = forms.find((f) => f && typeof f === 'object' && f.id === formId);
  if (!form) {
    throw new ServerError(`"${ingredient.name}" has no age or look with id "${formId}"`,
      { status: 400, code: 'VALIDATION_ERROR' });
  }
  const age = typeof form.age === 'string' ? form.age.trim() : '';
  const description = typeof form.description === 'string' ? form.description.trim() : '';
  if (!age && !description) {
    throw new ServerError(`Describe how "${form.label}" looks before rendering its sheet`,
      { status: 400, code: 'VALIDATION_ERROR' });
  }
  return { ...form, age, description };
}

// Load + guard the record, resolve its variant and any universe it links to.
async function resolveSheetTarget(id, options) {
  const ingredient = await getIngredient(id);
  if (!ingredient) throw new ServerError('Ingredient not found', { status: 404, code: 'NOT_FOUND' });
  const payload = ingredient.payload && typeof ingredient.payload === 'object' ? ingredient.payload : {};
  const isLook = options.variant === CATALOG_LOOK_VARIANT_ID;
  const { refs, context } = await universeContextFor(ingredient);
  const universes = [];
  const universeRefs = isLook && options.universeId !== undefined
    ? (options.universeId ? [{ refKind: 'universe', refId: options.universeId }] : [])
    : context.owner ? [context.owner] : [];
  if (isLook && options.universeId === undefined && !context.owner && new Set(refs.filter((r) => r.refKind === 'universe').map((r) => r.refId)).size > 1) {
    throw new ServerError('Choose which universe supplies this look’s visual direction', { status: 400, code: 'LOOK_UNIVERSE_REQUIRED' });
  }
  for (const ref of universeRefs) {
    if (ref.refKind !== 'universe') continue;
    // A look's chosen universe must exist; a stale sheet ref is skipped.
    const universe = isLook ? await getUniverse(ref.refId) : await getLinkedUniverse(ref.refId);
    if (universe) universes.push(universe);
  }
  // With no variant named, a photoreal universe defaults to the photographic sheet.
  const profile = options.visualProfileOverride === undefined ? universes[0]?.visualProfile : options.visualProfileOverride;
  const variants = variantsForType(ingredient.type, { photographic: isPhotographicVisualProfile(profile) });
  let variant = isLook
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
  const form = formFor(ingredient, payload, options.formId);
  if (form) {
    const role = `sheet:${variant.id}@${form.id}`;
    if (role.length > MEDIA_ROLE_MAX) {
      throw new ServerError(`Sheet role "${role}" exceeds ${MEDIA_ROLE_MAX} characters`, { status: 400, code: 'VALIDATION_ERROR' });
    }
    variant = { ...variant, label: `${variant.label} · ${form.label}`, role };
  }
  // A local consolidation retains embedded source variants. Render its
  // authoritative merged payload instead of delegating to a stale canon copy.
  const identityIds = await getIngredientIdentityIds(ingredient.id);
  if (ingredient.type === 'character' && !isLook && !form && identityIds.length === 1) {
    for (const universe of universes) {
      const entry = (universe.characters || []).find((c) => c.ingredientId === ingredient.id);
      if (entry) return { ingredient, payload, variant, delegate: { universeId: universe.id, entryId: entry.id } };
    }
  }
  return { ingredient, payload: catalogAppearance(ingredient.type, payload, form), variant, universe: universes[0] ?? null };
}

// Presence is checked without rewriting authored text. Board pins alone are
// not a style definition: use the board's explicitly composed style prompt.
async function lookDirection(universe, options) {
  const authored = options.visualDirection || {};
  const profile = normalizeUniverseVisualProfile(options.visualProfileOverride === undefined ? universe?.visualProfile : options.visualProfileOverride);
  const generation = profile?.generation.enabled ? profile.generation : {};
  const effectiveProfile = profile ? { ...profile, generation: { ...profile.generation, ...(authored.camera ? { optics: '' } : {}), ...(authored.lighting ? { lighting: '' } : {}) } } : null;
  const styledUniverse = universe ? { ...universe, visualProfile: effectiveProfile } : null;
  const boardId = options.moodBoardId ?? universe?.moodBoardId;
  const board = boardId ? await getBoard(boardId) : null;
  if (boardId && !board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  const hasText = (text) => typeof text === 'string' && !!text.trim();
  const additions = [];
  const add = (id, label, text) => {
    if (hasText(text)) additions.push({ id, label, text });
  };
  add('universe-style', `Universe style · ${universe?.name || ''}`, styledUniverse ? universeAestheticLine(styledUniverse) : '');
  add('universe-style-notes', 'Universe style notes', universe?.styleNotes);
  for (const [index, ref] of (universe?.styleReferences || []).entries()) {
    add(`universe-style-reference-${index}`, ref.title || 'Universe style reference', ref.prompt);
  }
  add('mood-board-style', `Mood board style · ${board?.name || ''}`, board?.style?.prompt);
  const hasSourceStyle = additions.length > 0;
  const fields = { style: 'Overall style / medium', camera: 'Camera', lighting: 'Lighting', environment: 'Environment' };
  for (const [key, label] of Object.entries(fields)) add(`look-${key}`, label, authored[key]);
  const defaults = { camera: generation.optics, lighting: generation.lighting };
  const missing = Object.entries(fields).filter(([key]) => !hasText(authored[key]) && !hasText(defaults[key]) && !(key === 'style' && hasSourceStyle)).map(([, label]) => label);
  return {
    profile: effectiveProfile,
    additions,
    styleLine: additions.map((a) => `${a.label}: ${a.text}`).join('\n\n'),
    negatives: [...universeVisualStyleTokens(styledUniverse).avoid, board?.style?.negativePrompt].filter(hasText).join(', '),
    status: {
      ready: missing.length === 0,
      missing,
      universe: universe ? { id: universe.id, name: universe.name } : null,
      moodBoard: board ? { id: board.id, name: board.name, hasStyle: hasText(board.style?.prompt) } : null,
    },
  };
}

async function buildCatalogSheet(target, options) {
  const { ingredient, payload, variant } = target;
  const universe = target.universe ? { ...target.universe, visualProfile: options.visualProfileOverride === undefined ? target.universe.visualProfile : options.visualProfileOverride } : null;
  const entry = { ...payload, name: ingredient.name };
  // Other sheets retain their default style; looks require explicit direction.
  const direction = variant.id === CATALOG_LOOK_VARIANT_ID ? await lookDirection(universe, options) : null;
  const build = (layout) => {
    const built = variant.build(universe || {}, entry, direction, layout);
    if (direction?.negatives) built.negativePrompt += `, ${direction.negatives}`;
    return built;
  };
  const universeStyle = universe ? universeAestheticLine(universe) : '';
  const media = ingredient.type === 'character' ? await listMediaForIngredient(ingredient.id) : [];
  const result = await buildSheetRenderParams({
    built: build,
    options,
    visualProfile: direction ? direction.profile : (options.visualProfileOverride === undefined ? universe?.visualProfile : options.visualProfileOverride),
    styleLine: direction ? '' : universeStyle || variant.defaultStyle,
    styleChip: universeStyle
      ? { id: 'universe-style', label: 'Universe style' }
      : { id: 'sheet-default-style', label: 'Default sheet style' },
    negativesLabel: variant.negativesLabel,
    renderPin: universe ? recordRenderPin(universe) : {},
    referenceCandidates: ingredient.type === 'character' ? characterSheetReferenceCandidates(payload, media, options) : [],
    editBaseCandidate: ingredient.type === 'character' ? characterSheetEditBase(payload, media, options) : null,
    sharedIdentity: ingredient.type === 'character' ? payload.visualIdentity : '',
    family: ingredient.type === 'character' ? await catalogFamilyRenderContext(ingredient.id, ingredient.name) : undefined,
    selfName: ingredient.name,
  });
  if (direction) result.params.promptAdditions = [...direction.additions, ...(result.params.promptAdditions || [])];
  return { ...result, visualDirection: direction?.status };
}

/** What a catalog sheet render would send, built by the render's own code. */
export async function previewCatalogSheet(id, options = {}) {
  const target = await resolveSheetTarget(id, options);
  if (target.delegate) {
    return previewCharacterReferenceSheet(target.delegate.universeId, target.delegate.entryId, {
      ...options, variant: target.variant.id,
    });
  }
  const { params, visualDirection, referenceImages, editBase } = await buildCatalogSheet(target, options);
  return {
    sentPrompt: params.prompt,
    ...(params.negativePrompt ? { sentNegativePrompt: params.negativePrompt } : {}),
    promptAdditions: params.promptAdditions || [],
    ...(target.ingredient.type === 'character' ? { referenceImages } : {}),
    ...(editBase ? { editBase } : {}),
    ...(visualDirection ? { visualDirection } : {}),
  };
}

/** Queue a sheet render for a catalog record; returns `{ jobId, variant, delegatedTo }`. */
export async function renderCatalogSheet(id, options = {}) {
  await assertCatalogIdentityWritable(id);
  const target = await resolveSheetTarget(id, options);
  // The lock guards writes only; a preview of a locked record stays available.
  if (target.ingredient.payload?.locked === true) {
    throw new ServerError(
      `"${target.ingredient.name}" is locked — unlock it before rendering a reference sheet`,
      { status: 409, code: 'CATALOG_INGREDIENT_LOCKED' },
    );
  }
  if (target.delegate) {
    const { universeId, entryId } = target.delegate;
    const result = await renderCharacterReferenceSheet(universeId, entryId, { ...options, variant: target.variant.id });
    return { ...result, delegatedTo: 'universe', universeId, entryId };
  }
  const { params, modelId, activeMode, visualDirection, referenceImages, editBase } = await buildCatalogSheet(target, options);
  assertSheetReferencesAvailable(referenceImages);
  if (visualDirection && !visualDirection.ready) {
    throw new ServerError(`Define the look’s visual direction before rendering: ${visualDirection.missing.join(', ')}`, { status: 400, code: 'LOOK_VISUAL_DIRECTION_REQUIRED' });
  }
  const role = target.variant.role || `sheet:${target.variant.id}`;
  params.catalogAttach = { ingredientId: id, kind: 'reference', role };
  const queued = await enqueueJob({ kind: 'image', params });
  const base = editBase?.status === 'included' ? 'portrait-edit' : editBase?.status === 'fallback' ? 'portrait-reference-fallback' : 'generate';
  console.log(`🎨 Catalog ${target.variant.label} render — ingredient=${shortId(id)} job=${shortId(queued.jobId)} mode=${activeMode} model=${modelId} source=${base}`);
  return {
    jobId: queued.jobId,
    ...(editBase ? { editBase } : {}),
    generationId: queued.jobId,
    variant: target.variant.id,
    role,
    delegatedTo: null,
    queuePosition: queued.position,
  };
}
