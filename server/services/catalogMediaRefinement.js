import { ServerError } from '../lib/errorHandler.js';
import { catalogAppearance } from '../lib/catalogAppearance.js';
import { pickGuideMedia, rejectedReferenceKeys } from '../lib/catalogMediaLibrary.js';
import { promptAddition } from '../lib/modelInput.js';
import { RENDER_TARGET, recordRenderPin } from '../lib/renderTargets.js';
import { IMAGE_GEN_MODE, QUEUEABLE_IMAGE_MODES } from '../lib/generationModes.js';
import { maxInputImages } from '../lib/imageGenCapabilities.js';
import { resolveImageInputPath } from '../lib/pathSafety.js';
import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from '../lib/imageLimits.js';
import { isFlux2 } from '../lib/mediaModels.js';
import { getIngredient } from './catalogDB/ingredients.js';
import { listMediaForIngredient } from './catalogDB/media.js';
import { assertCatalogIdentityWritable } from './catalogDB/identityAccess.js';
import { getSettings } from './settings.js';
import { getPrimitiveContext } from './catalogPrimitives.js';
import { universeAestheticLine } from '../lib/universeVisualStyle.js';
import { resolveRenderTargetConfig } from './imageGen/cloudProviderConfig.js';
import { prepareGenerateParams, resolveLocalImageModel, selectLocalImageModelFromSettings } from './imageGen/prepareParams.js';
import { previewImagePrompt } from './imageGen/promptPreview.js';
import { readImageDimensions } from './imageGen/regen.js';
import { enqueueJob } from './mediaJobQueue/index.js';

export async function refineCatalogMedia(id, input, { preview = false } = {}) {
  await assertCatalogIdentityWritable(id);
  const item = await getIngredient(id);
  if (!item) throw new ServerError('Ingredient not found', { status: 404 });
  if (item.payload?.locked === true) throw new ServerError('Unlock this item before refining a reference image', { status: 409 });
  const media = await listMediaForIngredient(id);
  const source = media.find(m => !m.deleted && !m.readOnly && !m.retained
    && (!m.ingredientId || m.ingredientId === item.id) && m.mediaKey === input.mediaKey && m.kind === input.kind);
  if (!source) throw new ServerError('Editable reference not found', { status: 404 });
  const variant = source.library?.variant || {};
  const forms = Array.isArray(item.payload?.forms) ? item.payload.forms : [];
  const byAge = Number.isInteger(variant.age) ? forms.filter(f => String(f.age).trim() === String(variant.age)) : [];
  const form = variant.formId ? forms.find(f => f.id === variant.formId) : byAge.length === 1 ? byAge[0] : null;
  if (variant.formId && !form) throw new ServerError('Assign this reference to an existing age or look before refining', { status: 409 });
  if (!form && Number.isInteger(variant.age) && String(variant.age) !== String(item.payload?.age).trim()) {
    throw new ServerError('Assign this reference to a described age or look before refining', { status: 409 });
  }
  const appearance = catalogAppearance(item.type, item.payload || {}, form);
  const age = /^\d+$/.test(String(appearance.age).trim()) ? Number(appearance.age) : undefined;
  const want = { ...variant, ...(age !== undefined ? { age } : {}), ...(form ? { formId: form.id, era: undefined } : {}) };
  const dimensions = await readEditSourceDimensions(source.mediaKey);
  const target = await resolveCatalogImageTarget(id);
  const { universe, settings, local, cloud, maxGuides } = target;
  const rejected = rejectedReferenceKeys(media);
  const guides = pickGuideMedia(media.filter(m => m.mediaKey !== source.mediaKey && !rejected.has(m.mediaKey)
    && !/^(?:archive:|sheet:|look:)/.test(m.role || '')), want, maxGuides);
  // A look image (tagged by variant or by its look:<id> role) is refined in
  // that look's outfit. The record's or form's free-text appearance often
  // names an everyday outfit, so it is not sent then and cannot fight the
  // look; the source image and guides carry the face, the form its age.
  const wardrobeId = variant.wardrobeId || (source.role?.startsWith('look:') ? source.role.slice('look:'.length) : null);
  const wardrobe = wardrobeId ? item.payload?.wardrobes?.find(w => w.id === wardrobeId) : null;
  const additions = [
    promptAddition('reference-guidance-heading', 'Editing guidance heading', 'Editing guidance:'),
    promptAddition('reference-edit', 'Reference refinement', 'Refine the FIRST attached image as a new version. Preserve its subject, framing, pose and photographic treatment unless the editing guidance asks to change them. Remaining images are identity guides. Preserve facial identity; apply only the requested age/look hairstyle and clothing, rather than copying incompatible styling from another age. Follow the editing guidance when correcting an inaccurate source. No text or watermark.'),
    promptAddition('reference-identity', 'Shared facial identity', appearance.visualIdentity),
    promptAddition('reference-appearance', 'Requested age, hair and clothing', [
      `Subject: ${item.name}`, form?.label, `Age: ${want.age ?? appearance.age ?? 'as depicted'}`,
      ...(wardrobe
        ? [`Outfit: ${wardrobe.name}. This outfit replaces any other clothing.`, wardrobe.description]
        : [appearance.physicalDescription || appearance.description]),
    ].filter(Boolean).join('\n')),
    promptAddition('reference-style', 'Universe visual style', universe ? universeAestheticLine(universe) : ''),
  ].filter(Boolean);
  const body = {
    ...catalogImageBackend(target),
    prompt: [additions[0].text, input.feedback, ...additions.slice(1).map(a => a.text)].join('\n\n'), promptAdditions: additions,
    initImageFile: source.mediaKey, referenceImageFiles: guides.map(m => m.mediaKey),
    ...dimensions,
  };
  if (preview) return previewImagePrompt(body);
  return enqueueCatalogImage(body, { settings, local, cloud, catalogAttach: { ingredientId: id, kind: 'reference', role: 'refinement',
    library: { ...(source.library || {}), variant: want, guide: false, review: { status: 'unreviewed', feedback: input.feedback },
      derivedFrom: { mediaKey: source.mediaKey, kind: source.kind } } } });
}

/** An edit source's dimensions, refused when the file is missing or outside generation limits. */
export async function readEditSourceDimensions(filename) {
  const sourcePath = resolveImageInputPath(filename);
  if (!sourcePath) throw new ServerError('Reference image is not available on this machine', { status: 422 });
  const dimensions = await readImageDimensions(sourcePath);
  if (!dimensions) throw new ServerError('Could not read the source image dimensions', { status: 422 });
  if (dimensions.width > MAX_IMAGE_EDGE || dimensions.height > MAX_IMAGE_EDGE
    || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS || dimensions.width < 64 || dimensions.height < 64) {
    throw new ServerError('Source dimensions exceed image generation limits. Use a smaller reference image before refining.', { status: 422 });
  }
  return dimensions;
}

// The record's render target (its universe's pin, else the character-sheet
// default) and how many identity guides that backend takes beside an init image.
export async function resolveCatalogImageTarget(id) {
  const ownership = await getPrimitiveContext(id, { includeDerived: false });
  if (ownership.status === 'conflict') throw new ServerError('Resolve universe ownership before refining', { status: 409 });
  const { getUniverse } = await import('./universeBuilder/crud.js');
  const universe = ownership.owner ? await getUniverse(ownership.owner.refId) : null;
  const settings = await getSettings();
  const pin = recordRenderPin(universe || {});
  const target = resolveRenderTargetConfig(settings, RENDER_TARGET.UNIVERSE_CHARACTER_SHEET, {
    recordMode: pin.mode, recordModel: pin.modelId,
    fallbackMode: IMAGE_GEN_MODE.LOCAL,
  });
  if (!QUEUEABLE_IMAGE_MODES.includes(target.mode)) throw new ServerError('Choose a queueable image backend in Settings before refining references', { status: 400 });
  const cloud = target.cloud;
  if (cloud && !cloud.enabled) throw cloud.disabledError;
  const local = target.mode === IMAGE_GEN_MODE.LOCAL
    ? selectLocalImageModelFromSettings(settings, undefined, undefined, target.modelCandidates) : null;
  const supportsGuides = !local || isFlux2(local) || local.pipelineClass === 'QwenImage21Pipeline';
  const maxGuides = supportsGuides ? Math.max(0, Math.min(3, (maxInputImages(target.mode, cloud?.modelId) ?? 4) - 1)) : 0;
  return { universe, settings, mode: target.mode, local, cloud, maxGuides };
}

/** The request body's backend fields for a resolved target. */
export const catalogImageBackend = ({ mode, local, cloud }) => ({
  mode, ...(local ? { modelId: local.id } : {}),
  ...(cloud ? { cloudModel: cloud.modelId, cloudModelIsShippedDefault: cloud.modelIsShippedDefault === true } : {}),
});

/** Queue one image render whose result the catalog attach hook files on the record. */
export async function enqueueCatalogImage(body, { settings, local, cloud, catalogAttach }) {
  const { data: params } = await prepareGenerateParams({ data: body, referenceImageFields: [] });
  delete params.cloudModel;
  delete params.cloudModelIsShippedDefault;
  const localParams = local ? resolveLocalImageModel(settings, params) : null;
  params.catalogAttach = catalogAttach;
  return enqueueJob({ kind: 'image', params: { ...(cloud?.jobParams || {}), ...params,
    ...(localParams ? { pythonPath: localParams.pythonPath, modelId: localParams.selectedModel.id } : {}) } });
}
