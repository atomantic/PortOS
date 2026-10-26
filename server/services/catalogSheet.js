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
import { characterSheetReferenceCandidates } from '../lib/characterSheetReferences.js';
import { catalogUniverseContext } from '../lib/catalogUniverseContext.js';
import { getUniverse } from './universeBuilder.js';
import { enqueueJob } from './mediaJobQueue/index.js';
import {
  DEFAULT_CHARACTER_SHEET_STYLE,
  buildSheetRenderParams,
  assertSheetReferencesAvailable,
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
    build: (universe, entry, direction) => buildCharacterLookPrompt(universe, entry, wardrobe, direction),
    negativesLabel: 'Look negatives',
    role: `look:${wardrobe.id}`,
  };
}

// Which payload fields a form's age and description replace, per type.
const FORM_FIELDS = Object.freeze({
  character: { age: 'age', description: 'physicalDescription' },
  place: { age: 'era', description: 'description' },
  object: { age: null, description: 'description' },
});
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

// The payload a form's sheet builds from: the record with its age/look swapped in.
function payloadForForm(type, payload, form) {
  if (!form) return payload;
  const fields = FORM_FIELDS[type] || FORM_FIELDS.object;
  const out = { ...payload };
  if (form.description) out[fields.description] = form.description;
  if (form.age) {
    if (fields.age) out[fields.age] = form.age;
    else out[fields.description] = [out[fields.description], form.age].filter(Boolean).join(' — ');
  }
  return out;
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

  const refs = await listLiveRefsForIngredient(id);
  const context = catalogUniverseContext(refs.map((ref) => ref.role === 'owner' && ref.ingredientId && ref.ingredientId !== ingredient.id
    ? { ...ref, role: 'retained-owner' } : ref));
  const universes = [];
  const universeRefs = isLook && options.universeId !== undefined
    ? (options.universeId ? [{ refKind: 'universe', refId: options.universeId }] : [])
    : context.owner ? [context.owner] : [];
  if (isLook && options.universeId === undefined && !context.owner && new Set(refs.filter((r) => r.refKind === 'universe').map((r) => r.refId)).size > 1) {
    throw new ServerError('Choose which universe supplies this look’s visual direction', { status: 400, code: 'LOOK_UNIVERSE_REQUIRED' });
  }
  for (const ref of universeRefs) {
    if (ref.refKind !== 'universe') continue;
    // A ref can outlive its universe (getUniverse throws NOT_FOUND then).
    const universe = await getUniverse(ref.refId).catch((error) => {
      if (!isLook && error?.code === 'NOT_FOUND') return null;
      throw error;
    });
    if (universe) universes.push(universe);
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
  return { ingredient, payload: payloadForForm(ingredient.type, payload, form), variant, universe: universes[0] ?? null };
}

// Presence is checked without rewriting authored text. Board pins alone are
// not a style definition: use the board's explicitly composed style prompt.
async function lookDirection(universe, options) {
  const boardId = options.moodBoardId ?? universe?.moodBoardId;
  const board = boardId ? await getBoard(boardId) : null;
  if (boardId && !board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });
  const hasText = (text) => typeof text === 'string' && !!text.trim();
  const additions = [];
  const add = (id, label, text) => {
    if (hasText(text)) additions.push({ id, label, text });
  };
  add('universe-style', `Universe style · ${universe?.name || ''}`, universe ? universeAestheticLine(universe) : '');
  add('universe-style-notes', 'Universe style notes', universe?.styleNotes);
  for (const [index, ref] of (universe?.styleReferences || []).entries()) {
    add(`universe-style-reference-${index}`, ref.title || 'Universe style reference', ref.prompt);
  }
  add('mood-board-style', `Mood board style · ${board?.name || ''}`, board?.style?.prompt);
  const authored = options.visualDirection || {};
  const hasSourceStyle = additions.length > 0;
  const fields = { style: 'Overall style / medium', camera: 'Camera', lighting: 'Lighting', environment: 'Environment' };
  for (const [key, label] of Object.entries(fields)) add(`look-${key}`, label, authored[key]);
  const missing = Object.entries(fields).filter(([key]) => !hasText(authored[key]) && !(key === 'style' && hasSourceStyle)).map(([, label]) => label);
  return {
    additions,
    styleLine: additions.map((a) => `${a.label}: ${a.text}`).join('\n\n'),
    negatives: [...universeVisualStyleTokens(universe).avoid, board?.style?.negativePrompt].filter(hasText).join(', '),
    status: {
      ready: missing.length === 0,
      missing,
      universe: universe ? { id: universe.id, name: universe.name } : null,
      moodBoard: board ? { id: board.id, name: board.name, hasStyle: hasText(board.style?.prompt) } : null,
    },
  };
}

async function buildCatalogSheet(target, options) {
  const { ingredient, payload, variant, universe } = target;
  const entry = { ...payload, name: ingredient.name };
  // Other sheets retain their default style; looks require explicit direction.
  const direction = variant.id === CATALOG_LOOK_VARIANT_ID ? await lookDirection(universe, options) : null;
  const built = variant.build(universe || {}, entry, direction);
  if (direction?.negatives) built.negativePrompt += `, ${direction.negatives}`;
  const universeStyle = universe ? universeAestheticLine(universe) : '';
  const result = await buildSheetRenderParams({
    built,
    options,
    styleLine: direction ? '' : universeStyle || variant.defaultStyle,
    styleChip: universeStyle
      ? { id: 'universe-style', label: 'Universe style' }
      : { id: 'sheet-default-style', label: 'Default sheet style' },
    negativesLabel: variant.negativesLabel,
    renderPin: universe ? recordRenderPin(universe) : {},
    referenceCandidates: ingredient.type === 'character'
      ? characterSheetReferenceCandidates(payload, await listMediaForIngredient(ingredient.id), options)
      : [],
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
  const { params, visualDirection, referenceImages } = await buildCatalogSheet(target, options);
  return {
    sentPrompt: params.prompt,
    ...(params.negativePrompt ? { sentNegativePrompt: params.negativePrompt } : {}),
    promptAdditions: params.promptAdditions || [],
    ...(target.ingredient.type === 'character' ? { referenceImages } : {}),
    ...(visualDirection ? { visualDirection } : {}),
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
  const { params, modelId, activeMode, visualDirection, referenceImages } = await buildCatalogSheet(target, options);
  assertSheetReferencesAvailable(referenceImages);
  if (visualDirection && !visualDirection.ready) {
    throw new ServerError(`Define the look’s visual direction before rendering: ${visualDirection.missing.join(', ')}`, { status: 400, code: 'LOOK_VISUAL_DIRECTION_REQUIRED' });
  }
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
