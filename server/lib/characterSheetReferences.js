import { basename, join, relative } from 'node:path';
import { PATHS } from './paths.js';
import { isSafeFilename, resolveImageInputPath } from './pathSafety.js';
import { MAX_CAST_GUIDES, pickGuideMedia, rejectedReferenceKeys, matchesReferenceVariant } from './catalogMediaLibrary.js';
import { maxInputImages } from './imageGenCapabilities.js';
import { CLOUD_IMAGE_GEN_MODES, IMAGE_GEN_MODE } from './generationModes.js';
import { RUNNER_FAMILIES } from './runners.js';

const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const DERIVED_ROLE = /^(?:sheet:|look:|archive:)/;

// Same variant filter as the reference candidates, so a rejected portrait or
// one assigned to another age/look never becomes an edit base.
function eligibleImages(character, media, want) {
  const age = typeof character.age === 'string' && /^\d+$/.test(character.age.trim()) ? Number(character.age) : undefined;
  want = { ...(age !== undefined ? { age } : {}), ...want };
  const formMatches = (m) => !m.library?.variant?.formId || m.library.variant.formId === want.formId
    || (!want.formId && m.kind === 'portrait' && Number.isInteger(want.age) && m.library.variant.age === want.age);
  const rejected = rejectedReferenceKeys(media);
  const images = media.filter((m) => m && !m.deleted && ['portrait', 'reference'].includes(m.kind)
    && !rejected.has(m.mediaKey) && matchesReferenceVariant(m, want) && formMatches(m));
  return { want, formMatches, rejected, images };
}

// While an age or look renders, each candidate says whether it is that form's
// own image or a canonical (other-age) one, so the preview and prompt can tell them apart.
const ownForm = (m, want) => !!want.formId && m.library?.variant?.formId === want.formId;
const scoped = (want, scope) => (want.formId ? { scope } : {});

// Explicit guides own selection. Automatic fallback excludes derived looks,
// sheets and archived media so a previous off-model render cannot seed itself.
export function characterSheetReferenceCandidates(character, media = [], want = {}) {
  const { want: wanted, formMatches, rejected, images } = eligibleImages(character, media, want);
  want = wanted;
  const guides = images.filter((m) => m.library?.guide === true);
  const scopeOf = (m) => scoped(want, ownForm(m, want) ? 'form' : 'canonical');
  if (guides.length) return pickGuideMedia(guides, want).map((m) => ({
    filename: m.mediaKey, source: 'Render guide', ...scopeOf(m),
  }));
  const candidates = pickGuideMedia(images.filter((m) => !DERIVED_ROLE.test(m.role || '')), want)
    .map((m) => ({ filename: m.mediaKey, source: m.kind === 'portrait' ? 'Portrait' : 'Reference library', ...scopeOf(m) }));
  const excluded = new Set(media.filter((m) => !m.deleted && (rejected.has(m.mediaKey) || !matchesReferenceVariant(m, want) || !formMatches(m))).map(m => m.mediaKey));
  const canon = [
    { filename: character.primaryImageRef, source: 'Primary canon image' },
    ...(Array.isArray(character.imageRefs) ? character.imageRefs : []).map((filename) => ({ filename, source: 'Canon image' })),
  ].filter((ref) => ref.filename && !excluded.has(ref.filename)).map((ref) => ({ ...ref, ...scoped(want, 'canonical') }));
  // Keep the selected portrait first, then the authored canon references.
  return [...candidates.filter((c) => c.source === 'Portrait'), ...canon,
    ...candidates.filter((c) => c.source !== 'Portrait')];
}

/**
 * The image this render may edit from. The canonical form edits the record's
 * live portrait (the image its card shows) when it is not rejected, archived,
 * derived or assigned to another age or look. An age or look edits only from
 * an image assigned to it — its render guide first, then a portrait, then any
 * reference — never from the canonical portrait, which shows another age.
 * Null when there is none, so the render generates fresh.
 */
export function characterSheetEditBase(character, media = [], want = {}) {
  const { want: wanted, images } = eligibleImages(character, media, want);
  const usable = images.filter((m) => !DERIVED_ROLE.test(m.role || ''));
  if (wanted.formId) {
    const own = usable.filter((m) => ownForm(m, wanted));
    const pick = own.find((m) => m.library?.guide === true) || own.find((m) => m.kind === 'portrait') || pickGuideMedia(own, wanted)[0];
    if (!pick) return null;
    const source = pick.library?.guide === true ? 'Render guide' : pick.kind === 'portrait' ? 'Portrait' : 'Reference library';
    return { filename: pick.mediaKey, source, scope: 'form' };
  }
  const portrait = usable.find((m) => m.kind === 'portrait');
  return portrait ? { filename: portrait.mediaKey, source: 'Portrait' } : null;
}

// Cloud image tools take an input image as an instruction-following edit, so
// they can restage the portrait. The local runners apply an init image as an
// img2img start latent that keeps its framing, so a headshot cannot become a
// full-body look or a sheet there.
function portraitEditUnsupportedReason(mode, modelId) {
  if (!CLOUD_IMAGE_GEN_MODES.includes(mode)) {
    return 'The local image backend uses a source image as an img2img starting point that keeps its framing, so the portrait is not edited here. Choose a cloud image backend to edit from the portrait.';
  }
  if ((maxInputImages(mode, modelId) ?? 1) < 1) return 'The selected image model takes no input image, so the portrait cannot be edited.';
  return null;
}

const scopeField = (candidate) => (candidate.scope ? { scope: candidate.scope } : {});

const viewableImage = (filename) => {
  const safe = isSafeFilename(filename, EXTENSIONS);
  // Only persistent, publicly viewable image roots can be character sources.
  const path = safe ? resolveImageInputPath(join(PATHS.images, filename))
    || resolveImageInputPath(join(PATHS.imageRefs, filename)) : null;
  return {
    safe, path,
    entry: (fields) => ({ filename: safe ? filename : 'Invalid image filename', ...fields,
      ...(path ? { url: `/data/${relative(PATHS.imageRefs, path) === basename(path) ? 'image-refs' : 'images'}/${encodeURIComponent(filename)}` } : {}) }),
  };
};

/**
 * Resolve once for both the preview and queued job; never expose host paths.
 * With an `editBase` the backend can edit, that portrait becomes the render's
 * init image (`initPath`, listed first with `role: 'edit-base'`) and the other
 * candidates follow as identity guides in the remaining input slots. When the
 * backend cannot edit, `editBase` reports why and the candidates resolve as
 * plain references, exactly as without a portrait.
 */
export function resolveCharacterSheetReferences(candidates, mode, modelId, localModel, editBaseCandidate = null) {
  const limit = Math.min(MAX_CAST_GUIDES, maxInputImages(mode, modelId) ?? MAX_CAST_GUIDES);
  const supported = mode !== IMAGE_GEN_MODE.LOCAL || localModel?.runner === RUNNER_FAMILIES.FLUX2
    || localModel?.pipelineClass === 'QwenImage21Pipeline';
  const seen = new Set();
  const paths = [];
  const images = [];
  let initPath = null;
  let editBase = null;
  if (editBaseCandidate) {
    const reason = portraitEditUnsupportedReason(mode, modelId);
    const base = viewableImage(editBaseCandidate.filename);
    if (reason) {
      editBase = base.entry({ source: editBaseCandidate.source, status: 'fallback', reason, ...scopeField(editBaseCandidate) });
    } else {
      seen.add(editBaseCandidate.filename);
      const status = base.path ? 'included' : 'missing';
      if (base.path) initPath = base.path;
      editBase = base.entry({ source: editBaseCandidate.source, status, ...scopeField(editBaseCandidate) });
      images.push(base.entry({ source: editBaseCandidate.source, status, role: 'edit-base', ...scopeField(editBaseCandidate) }));
    }
  }
  const guideLimit = initPath ? limit - 1 : limit;
  for (const candidate of candidates) {
    const filename = candidate.filename;
    if (seen.has(filename)) continue;
    seen.add(filename);
    const { path, entry } = viewableImage(filename);
    const status = paths.length >= guideLimit ? 'limit' : !path ? 'missing' : !supported ? 'unsupported' : 'included';
    if (status === 'included') paths.push(path);
    images.push(entry({ source: candidate.source, status, ...scopeField(candidate), ...(candidate.relative ? { relative: candidate.relative } : {}) }));
  }
  return { paths, images, initPath, editBase };
}
