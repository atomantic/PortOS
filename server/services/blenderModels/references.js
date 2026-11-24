/**
 * A Blender model's reference images (issue #17876): where they start from, the
 * overall sheet, one close-up plate per mechanism, their review, and the parts
 * brief (src/PARTS.md). Images queue only from an explicit render call.
 *
 * Record fields (additive): `referenceSource` `{ ingredientId, name, size,
 * images: [{ filename, label }], imageMode, imageModelId }` and `references`,
 * one slot per image to make:
 * `{ id, role: 'overall' | 'closeup', mechanism?, words, approvedImageId, file, images }`.
 * An image is `{ id, filename, jobId, status, note, error, basedOn, createdAt }`
 * with status rendering | review | approved | superseded | failed. Gallery files
 * are never rewritten, so a new render can only add an image: the approved one
 * stays approved until another is approved in its place. `basedOn` is the
 * approved overall image a plate was made from; a plate whose `basedOn` is no
 * longer the approved one is out of date.
 */
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { copyFileGuarded } from '../../lib/fileCore.js';
import { resolveGalleryImage, resolveImageRef } from '../../lib/pathSafety.js';
import { assertInsideWithoutSymlinks, blenderRefusal } from '../blenderWorkspace/containment.js';
import { resolveSourceFile, writeSourceText } from '../blenderWorkspace/sourceTree.js';
import * as store from './store.js';
import { assertBlenderModelId, blenderModelSourceDirs, blenderModelWorkspaceDir } from './workspace.js';

export const BLENDER_MODEL_REFERENCE_TAG = 'blenderModelReference';
const OVERALL_ID = 'overall';
const MAX_SOURCE_IMAGES = 8;
const MAX_CLOSEUPS = 12;
// Ceiling for renderers that declare none of their own (the overall sheet plus every source image fits).
const REFERENCE_LIMIT = MAX_SOURCE_IMAGES + 1;
const EMPTY_SOURCE = Object.freeze({ ingredientId: null, name: null, size: '', images: [], imageMode: null, imageModelId: null });

const conflict = (message, code) => blenderRefusal(message, code, 409);
const notFound = (message) => blenderRefusal(message, 'NOT_FOUND', 404);
// Approval copies a file and commits the row that names it; two on one model must not interleave.
const serialize = createKeyCachedQueue();

const sourceOf = (model) => ({ ...EMPTY_SOURCE, ...model.referenceSource });
const slotsOf = (model) => {
  const slots = Array.isArray(model.references) ? model.references : [];
  return slots.some((slot) => slot.role === 'overall') ? slots
    : [{ id: OVERALL_ID, role: 'overall', words: '', approvedImageId: null, file: null, images: [] }, ...slots];
};
const approvedOverallId = (model) => slotsOf(model).find((slot) => slot.role === 'overall').approvedImageId;
const approvedImage = (slot) => slot.images.find((image) => image.id === slot.approvedImageId) ?? null;
const galleryPath = (filename) => resolveGalleryImage(filename) || resolveImageRef(filename);

async function requireModel(id) {
  assertBlenderModelId(id);
  const model = await store.getModel(id);
  if (!model) throw notFound('Blender model not found');
  return model;
}

function requireSlot(model, referenceId) {
  const slot = slotsOf(model).find((entry) => entry.id === referenceId);
  if (!slot) throw notFound('That reference is not on this model');
  return slot;
}

function requireUnlocked(model, slot) {
  if (slot.role === 'closeup' && !approvedOverallId(model)) {
    throw conflict('Approve the overall sheet first: a wrong overall sheet makes every close-up wrong.', 'BLENDER_MODEL_OVERALL_NOT_APPROVED');
  }
}

const replaceSlot = (model, referenceId, change) => ({
  ...model, references: slotsOf(model).map((slot) => (slot.id === referenceId ? { ...slot, ...change(slot) } : slot)),
});

// The newest result is the one up for review; an unapproved earlier one is kept as superseded.
const addForReview = (images, image) => [
  ...images.filter((entry) => entry.id !== image.id).map((entry) => (entry.status === 'review' ? { ...entry, status: 'superseded' } : entry)),
  image,
];

async function findLiveJob(jobId) {
  const { getJob } = await import('../mediaJobQueue/index.js');
  const job = jobId ? getJob(jobId) : null;
  return job && (job.status === 'queued' || job.status === 'running') ? job : null;
}

/** The approved overall sheet's image file on disk, or null when none is approved (or its file is gone). */
export function approvedOverallSheetPath(model) {
  const image = approvedImage(slotsOf(model).find((slot) => slot.role === 'overall'));
  return image ? galleryPath(image.filename) || null : null;
}

/** The record's reference fields with what a reader needs derived: locks, staleness and lost renders. */
export async function presentBlenderModelReferences(model) {
  const overallId = approvedOverallId(model);
  const references = await Promise.all(slotsOf(model).map(async (slot) => ({
    ...slot,
    locked: slot.role === 'closeup' && !overallId,
    outOfDate: slot.role === 'closeup' && !!slot.approvedImageId && approvedImage(slot)?.basedOn !== overallId,
    images: await Promise.all(slot.images.map(async (image) => (image.status === 'rendering' && !await findLiveJob(image.jobId)
      ? { ...image, status: 'failed', error: 'This render is no longer in the queue. Render again.' } : image))),
  })));
  return { referenceSource: sourceOf(model), references };
}

/** Change where references start from; an absent key stays as it is. A newly chosen Casting object brings its images and size. */
export async function updateBlenderModelReferenceSource(id, patch) {
  const model = await requireModel(id);
  const incoming = { ...patch };
  if (patch.images) incoming.images = patch.images.map(({ filename, label }) => ({ filename, label: label ?? '' }));
  if (patch.ingredientId === null) incoming.name = null;
  else if (patch.ingredientId && patch.ingredientId !== sourceOf(model).ingredientId) {
    const { getIngredient, listMediaForIngredient } = await import('../catalog/catalogDB.js');
    const object = await getIngredient(patch.ingredientId);
    if (!object) throw notFound('That Casting object was not found');
    if (object.type !== 'object') throw blenderRefusal(`"${object.name}" is a ${object.type}. Choose a Casting object.`, 'VALIDATION_ERROR');
    const media = await listMediaForIngredient(object.id);
    const usable = media.filter((row) => row.library?.review?.status !== 'bad');
    const portrait = usable.find((row) => row.kind === 'portrait');
    const sheet = usable.find((row) => row.role === 'sheet:product');
    const canonical = portrait?.mediaKey ?? object.payload?.primaryImageRef ?? null;
    const own = [
      canonical ? { filename: canonical, label: `${object.name} · canonical image` } : null,
      sheet ? { filename: sheet.mediaKey, label: `${object.name} · product sheet` } : null,
    ].filter((image) => image && galleryPath(image.filename));
    const base = incoming.images ?? sourceOf(model).images;
    incoming.images = [...own, ...base.filter((image) => !own.some((mine) => mine.filename === image.filename))];
    incoming.name = object.name;
    if (patch.size === undefined && !sourceOf(model).size.trim()) incoming.size = String(object.payload?.size ?? '').trim();
  }
  const known = new Set(sourceOf(model).images.map((image) => image.filename));
  for (const image of incoming.images ?? []) {
    if (!known.has(image.filename) && !galleryPath(image.filename)) throw blenderRefusal(`${image.filename} is not in the image library`, 'VALIDATION_ERROR');
  }
  await store.mutateModel(id, (current) => {
    const next = { ...sourceOf(current), ...incoming };
    if (next.images.length > MAX_SOURCE_IMAGES) {
      throw blenderRefusal(`A model takes at most ${MAX_SOURCE_IMAGES} source images (this would be ${next.images.length}). Remove some first.`, 'BLENDER_MODEL_TOO_MANY_SOURCES');
    }
    return { ...current, referenceSource: next };
  });
}

export async function addBlenderModelCloseup(id, mechanism) {
  await requireModel(id);
  await store.mutateModel(id, (current) => {
    const slots = slotsOf(current);
    const closeups = slots.filter((slot) => slot.role === 'closeup');
    if (closeups.some((slot) => slot.mechanism.toLowerCase() === mechanism.toLowerCase())) throw conflict('That mechanism already has a close-up plate.', 'BLENDER_MODEL_MECHANISM_EXISTS');
    if (closeups.length >= MAX_CLOSEUPS) throw conflict(`A model takes at most ${MAX_CLOSEUPS} close-up plates.`, 'BLENDER_MODEL_TOO_MANY_CLOSEUPS');
    const slot = { id: `closeup-${randomUUID().slice(0, 8)}`, role: 'closeup', mechanism, words: '', approvedImageId: null, file: null, images: [] };
    return { ...current, references: [...slots, slot] };
  });
}

/** Drop a close-up plate and its copy in src/refs/; its gallery images stay. */
export const removeBlenderModelCloseup = (id, referenceId) => serialize(id, async () => {
  const slot = requireSlot(await requireModel(id), referenceId);
  if (slot.role !== 'closeup') throw conflict('The overall sheet cannot be removed.', 'BLENDER_MODEL_OVERALL_REQUIRED');
  await store.mutateModel(id, (current) => ({
    ...current,
    references: slotsOf(current).filter((entry) => entry.id !== referenceId),
    // What was compared against the plate goes with it; a recorded difference stays.
    cameras: (current.cameras || []).filter((camera) => camera.referenceId !== referenceId),
    differences: (current.differences || []).map((entry) => (entry.referenceId === referenceId ? { ...entry, referenceId: null } : entry)),
  }));
  if (slot.file) await removeReferenceFile(id, slot.file);
});

async function removeReferenceFile(id, file) {
  const { absolute } = await resolveSourceFile(blenderModelSourceDirs(id), file);
  await rm(absolute, { force: true });
}

// The object the prompts describe: the live Casting record when one is linked, else the model itself.
async function describedObject(model) {
  const source = sourceOf(model);
  let object = { name: model.name, description: model.description };
  if (source.ingredientId) {
    const { getIngredient } = await import('../catalog/catalogDB.js');
    const ingredient = await getIngredient(source.ingredientId);
    if (ingredient) object = { ...ingredient.payload, name: ingredient.name };
  }
  return { ...object, size: source.size };
}

// Every chosen image goes, or nothing does: never a silently shorter set.
function inputRefusal(images) {
  const withStatus = (status) => images.filter((image) => image.status === status);
  if (withStatus('unsupported').length) return 'This renderer takes no reference images. Choose FLUX.2 or Qwen Image 2.1 locally, or a cloud image backend.';
  const missing = withStatus('missing');
  if (missing.length) return `Missing from the image library: ${missing.map((image) => image.filename).join(', ')}. Restore or remove it.`;
  const over = withStatus('limit').length;
  return over ? `This renderer takes ${images.length - over} reference images and this would send ${images.length}. Remove ${over} or choose another renderer.` : null;
}

/** The queued image params for one slot: the preview and the render both come from here. */
async function prepareReferenceRender(model, slot, words) {
  requireUnlocked(model, slot);
  const source = sourceOf(model);
  if (slot.role === 'overall' && !source.size.trim()) {
    throw blenderRefusal('Enter the real size first. The sheet states it, and the model is built to it.', 'BLENDER_MODEL_SIZE_REQUIRED');
  }
  const overall = slot.role === 'closeup' ? approvedImage(requireSlot(model, OVERALL_ID)) : null;
  const candidates = [
    ...(overall ? [{ filename: overall.filename, source: 'Approved overall sheet' }] : []),
    ...source.images.map(({ filename, label }) => ({ filename, source: label || 'Source image' })),
  ];
  const [object, { buildSheetRenderParams }, prompts, { recordRenderPin }] = await Promise.all([
    describedObject(model), import('../universeCharacterSheet.js'), import('../catalog/modelSheetPrompts.js'), import('../../lib/renderTargets.js'),
  ]);
  const renderPin = recordRenderPin(source);
  const built = slot.role === 'overall'
    ? prompts.buildModelOverallSheetPrompt(object, { words, hasReferences: candidates.length > 0 })
    : prompts.buildModelCloseupPrompt(object, { mechanism: slot.mechanism, words });
  const sheet = await buildSheetRenderParams({
    built, renderPin, referenceCandidates: candidates, identityGuide: false, referenceLimit: REFERENCE_LIMIT,
    negativesLabel: 'Reference sheet negatives',
    // buildSheetRenderParams reads a local model from options; a cloud model comes from the pin.
    options: renderPin.mode === 'local' && renderPin.modelId ? { modelId: renderPin.modelId } : {},
  });
  sheet.params.promptAdditions = [...built.additions, ...(sheet.params.promptAdditions || [])];
  return { ...sheet, refusal: inputRefusal(sheet.referenceImages) };
}

/** What rendering this slot with `words` would send, and why it would be refused (`refusal`), if it would. */
export async function previewBlenderModelReference(id, referenceId, { words = '' }) {
  const model = await requireModel(id);
  const { params, settings, referenceImages, refusal } = await prepareReferenceRender(model, requireSlot(model, referenceId), words);
  const { previewPreparedImagePrompt } = await import('../imageGen/promptPreview.js');
  return { promptAdditions: [], ...await previewPreparedImagePrompt({ params, settings }), referenceImages, refusal };
}

/** Queue one image for a slot. Completion is attached by referenceImageHook.js from the job's own tag. */
export const renderBlenderModelReference = (id, referenceId, { words = '' }) => serialize(id, async () => {
  const model = await requireModel(id);
  const slot = requireSlot(model, referenceId);
  for (const image of slot.images) {
    if (image.status === 'rendering' && await findLiveJob(image.jobId)) throw conflict('This image is already rendering.', 'BLENDER_MODEL_REFERENCE_RENDERING');
  }
  const { params, refusal } = await prepareReferenceRender(model, slot, words);
  if (refusal) throw blenderRefusal(refusal, 'BLENDER_MODEL_REFERENCE_INPUTS');
  const imageId = `img-${randomUUID()}`;
  const basedOn = slot.role === 'closeup' ? approvedOverallId(model) : null;
  const { enqueueJob } = await import('../mediaJobQueue/index.js');
  const { jobId } = await enqueueJob({ kind: 'image', params: { ...params, [BLENDER_MODEL_REFERENCE_TAG]: { modelId: id, referenceId, imageId, basedOn } } });
  await store.mutateModel(id, (current) => replaceSlot(current, referenceId, (entry) => ({
    words,
    // A fast job may already be attached, and its result must not go back to rendering.
    images: entry.images.some((image) => image.id === imageId) ? entry.images
      : [...entry.images, { id: imageId, filename: null, jobId, status: 'rendering', note: '', error: null, basedOn, createdAt: new Date().toISOString() }],
  })));
  console.log(`🧊 Blender model ${id.slice(0, 15)} reference ${referenceId} queued job=${jobId.slice(0, 8)}`);
  return { jobId, imageId };
});

const liveSlot = async ({ modelId, referenceId }) => {
  const model = await store.getModel(modelId);
  return model && slotsOf(model).some((slot) => slot.id === referenceId);
};

/** A finished render becomes the image up for review. Null when the model or slot is gone, or it already attached. */
export async function attachRenderedReference({ modelId, referenceId, imageId, basedOn, jobId, filename }) {
  if (!await liveSlot({ modelId, referenceId })) return null;
  let attached = null;
  await store.mutateModel(modelId, (current) => {
    const existing = slotsOf(current).find((slot) => slot.id === referenceId)?.images.find((image) => image.id === imageId);
    if (existing?.filename || !slotsOf(current).some((slot) => slot.id === referenceId)) return null;
    attached = { note: '', createdAt: new Date().toISOString(), ...existing, id: imageId, filename, jobId, basedOn, status: 'review', error: null };
    return replaceSlot(current, referenceId, (slot) => ({ images: addForReview(slot.images, attached) }));
  });
  return attached;
}

export async function failRenderedReference({ modelId, referenceId, imageId }, status, error) {
  if (!await liveSlot({ modelId, referenceId })) return;
  await store.mutateModel(modelId, (current) => replaceSlot(current, referenceId, (slot) => ({
    images: slot.images.map((image) => (image.id === imageId && image.status === 'rendering'
      ? { ...image, status: 'failed', error: status === 'canceled' ? 'Canceled' : String(error || 'The render failed') } : image)),
  })));
}

/** Put an existing library image up for review instead of rendering one (a product sheet already drawn, an upload). */
export async function useBlenderModelReferenceImage(id, referenceId, filename) {
  await requireModel(id);
  if (!galleryPath(filename)) throw blenderRefusal('That image is not in the image library', 'VALIDATION_ERROR');
  await store.mutateModel(id, (current) => {
    const slot = requireSlot(current, referenceId);
    requireUnlocked(current, slot);
    const image = {
      id: `img-${randomUUID()}`, filename, jobId: null, status: 'review', note: '', error: null,
      basedOn: slot.role === 'closeup' ? approvedOverallId(current) : null, createdAt: new Date().toISOString(),
    };
    return replaceSlot(current, referenceId, (entry) => ({ images: addForReview(entry.images, image) }));
  });
}

// Copy beside the target and rename, so a build never reads a half-written sheet.
async function copyIntoRefs(id, file, from) {
  const { absolute } = await resolveSourceFile(blenderModelSourceDirs(id), file);
  await mkdir(dirname(absolute), { recursive: true });
  // The folder now exists: check again so a link planted there is refused.
  await assertInsideWithoutSymlinks(blenderModelWorkspaceDir(id), absolute);
  const temp = `${absolute}.${randomUUID()}.tmp`;
  try {
    await copyFileGuarded(from, temp);
    await rename(temp, absolute);
  } finally {
    await rm(temp, { force: true });
  }
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'mechanism';

/**
 * Approve an image (its copy lands in src/refs/ and the previously approved one
 * becomes superseded), or send one back. Redo keeps an approved image approved
 * until its replacement is; the note joins the words of the next render.
 */
export const reviewBlenderModelReference = (id, referenceId, imageId, { decision, note = '' }) => serialize(id, async () => {
  const model = await requireModel(id);
  const slot = requireSlot(model, referenceId);
  const image = slot.images.find((entry) => entry.id === imageId);
  if (!image) throw notFound('That image is not on this reference');
  if (!image.filename) throw conflict('That image has not finished rendering.', 'BLENDER_MODEL_REFERENCE_NOT_READY');
  if (decision === 'redo') {
    await store.mutateModel(id, (current) => replaceSlot(current, referenceId, (entry) => ({
      words: [entry.words, note].filter((text) => text.trim()).join('\n'),
      images: entry.images.map((candidate) => (candidate.id === imageId
        ? { ...candidate, note, status: candidate.status === 'approved' ? 'approved' : 'superseded' } : candidate)),
    })));
    return;
  }
  requireUnlocked(model, slot);
  const from = galleryPath(image.filename);
  if (!from) throw conflict('That image file is missing from the image library.', 'BLENDER_MODEL_REFERENCE_MISSING');
  const extension = extname(image.filename).toLowerCase();
  const file = slot.role === 'overall' ? `refs/overall${extension}` : `refs/${slug(slot.mechanism)}-${slot.id.slice(-8)}${extension}`;
  await withBackupAssetPublication(async () => {
    await copyIntoRefs(id, file, from);
    await store.mutateModel(id, (current) => replaceSlot(current, referenceId, (entry) => ({
      approvedImageId: imageId, file,
      images: entry.images.map((candidate) => {
        if (candidate.id === imageId) return { ...candidate, status: 'approved', note };
        return candidate.status === 'approved' || candidate.status === 'review' ? { ...candidate, status: 'superseded' } : candidate;
      }),
    })));
  });
  if (slot.file && slot.file !== file) await removeReferenceFile(id, slot.file);
});

/** The parts brief a coding agent reads before modeling, prefilled with what the references already say. */
function partsBriefTemplate(model) {
  const source = sourceOf(model);
  const slots = slotsOf(model);
  const closeups = slots.filter((slot) => slot.role === 'closeup');
  return [
    `# ${source.name || model.name}: parts brief`, '',
    '## Axes and size', '', 'Meters, Z up, front facing -Y.', `Real size: ${source.size.trim() || '(state it: width x depth x height)'}`, '',
    '## How it carries its own weight', '', '(What stands on what, what holds each part up, where the load reaches the ground.)', '',
    '## Parts', '', '| id | What it is | Attached to | Material |', '|---|---|---|---|', '|  |  |  |  |', '',
    '## Joints', '', '| Joint | Type (hinge, slide, wheel) | Axis and origin | Range |', '|---|---|---|---|',
    ...(closeups.length ? closeups.map((slot) => `| ${slot.mechanism.replaceAll('|', '/')} |  |  |  |`) : ['|  |  |  |  |']), '',
    '## Which view wins', '', 'Where sheets disagree, the overall sheet decides proportions and a close-up plate decides its own mechanism. Note exceptions here.', '',
    ...slots.filter((slot) => slot.file).map((slot) => `- \`${slot.file}\`: ${slot.role === 'overall' ? 'overall sheet' : slot.mechanism}`), '',
  ].join('\n');
}

/** Create src/PARTS.md from the template; refuses once there is one. */
export const createBlenderModelPartsBrief = (id) => serialize(id, async () => {
  const model = await requireModel(id);
  const dirs = blenderModelSourceDirs(id);
  const { absolute } = await resolveSourceFile(dirs, 'PARTS.md');
  if (await lstat(absolute).catch(() => null)) throw conflict('This model already has src/PARTS.md.', 'BLENDER_MODEL_PARTS_EXISTS');
  await writeSourceText(dirs, 'PARTS.md', partsBriefTemplate(model));
  store.announceBlenderModel(id);
});
