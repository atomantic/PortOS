import { basename, join, relative } from 'node:path';
import { PATHS } from './paths.js';
import { isSafeFilename, resolveImageInputPath } from './pathSafety.js';
import { MAX_CAST_GUIDES, pickGuideMedia } from './catalogMediaLibrary.js';
import { maxInputImages } from './imageGenCapabilities.js';
import { IMAGE_GEN_MODE } from './generationModes.js';
import { RUNNER_FAMILIES } from './runners.js';

const EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

// Explicit guides own selection. Automatic fallback excludes derived looks,
// sheets and archived media so a previous off-model render cannot seed itself.
export function characterSheetReferenceCandidates(character, media = [], want = {}) {
  const images = media.filter((m) => m && !m.deleted && ['portrait', 'reference'].includes(m.kind)
    && (!m.library?.variant?.formId || m.library.variant.formId === want.formId));
  const guides = images.filter((m) => m.library?.guide === true);
  if (guides.length) return pickGuideMedia(guides, want).map((m) => ({
    filename: m.mediaKey, source: 'Render guide',
  }));
  const candidates = pickGuideMedia(images.filter((m) => !/^(?:sheet:|look:|archive:)/.test(m.role || '')), want)
    .map((m) => ({ filename: m.mediaKey, source: m.kind === 'portrait' ? 'Portrait' : 'Reference library' }));
  const canon = [
    { filename: character.primaryImageRef, source: 'Primary canon image' },
    ...(Array.isArray(character.imageRefs) ? character.imageRefs : []).map((filename) => ({ filename, source: 'Canon image' })),
  ].filter((ref) => ref.filename);
  // Keep the selected portrait first, then the authored canon references.
  return [...candidates.filter((c) => c.source === 'Portrait'), ...canon,
    ...candidates.filter((c) => c.source !== 'Portrait')];
}

/** Resolve once for both the preview and queued job; never expose host paths. */
export function resolveCharacterSheetReferences(candidates, mode, modelId, localModel) {
  const limit = Math.min(MAX_CAST_GUIDES, maxInputImages(mode, modelId) ?? MAX_CAST_GUIDES);
  const supported = mode !== IMAGE_GEN_MODE.LOCAL || localModel?.runner === RUNNER_FAMILIES.FLUX2
    || localModel?.pipelineClass === 'QwenImage21Pipeline';
  const seen = new Set();
  const paths = [];
  const images = [];
  for (const candidate of candidates) {
    const filename = candidate.filename;
    if (seen.has(filename)) continue;
    seen.add(filename);
    const safe = isSafeFilename(filename, EXTENSIONS);
    // Only persistent, publicly viewable image roots can be character sources.
    const path = safe ? resolveImageInputPath(join(PATHS.images, filename))
      || resolveImageInputPath(join(PATHS.imageRefs, filename)) : null;
    const status = paths.length >= limit ? 'limit' : !path ? 'missing' : !supported ? 'unsupported' : 'included';
    if (status === 'included') paths.push(path);
    images.push({ filename: safe ? filename : 'Invalid image filename', source: candidate.source, status,
      ...(path ? { url: `/data/${relative(PATHS.imageRefs, path) === basename(path) ? 'image-refs' : 'images'}/${encodeURIComponent(filename)}` } : {}),
    });
  }
  return { paths, images };
}
