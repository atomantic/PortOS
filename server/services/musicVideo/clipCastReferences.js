/**
 * The character sheets a Music Video shot's Grok clip carries beside its still
 * (videoGen/grok.js sends them to reference_to_video). The still fixes the
 * opening frame; these keep the people the same once the clip moves past it,
 * as when a hidden face turns into view. They are the identity
 * references the shot's still was conditioned on (productionDispatch.js), set
 * plates and the storyboard panel left out: the still already holds the place.
 */

import { basename } from 'node:path';
import { resolveGalleryImage, resolveImageInputPath } from '../../lib/pathSafety.js';
import { MUSIC_VIDEO_GROK_CLIP_REFERENCE_LIMIT, MUSIC_VIDEO_MAX_REFERENCE_CHOICES, musicVideoClipConditioningReferences, musicVideoClipReferenceChoices, isLegacyCatalogReference } from '../../lib/musicVideoConditioning.js';
import { ServerError } from '../../lib/errorHandler.js';
import { loadSceneCastMedia } from './castGuideMedia.js';

/**
 * Re-resolve at dispatch so a render uses the catalog's current images. Only
 * links a render cannot resolve (a missing record, look or image) refuse it;
 * an unapproved or changed check-in is review state, never a render gate.
 */
export async function requireCatalogRenderReady(project) {
  if (project?.castAndSets?.source !== 'catalog') return project;
  const { withCatalogCheckin, assertCatalogCheckinReady } = await import('./catalogCheckin.js');
  const current = await withCatalogCheckin(project);
  const { catalogCheckin } = current.castAndSets;
  // A shot with no catalog subjects still renders from its own prompt and references.
  assertCatalogCheckinReady({ ...catalogCheckin, problems: catalogCheckin.problems.filter(p => p.code !== 'CATALOG_SUBJECTS_REQUIRED') });
  return current;
}

/** Bind caller-selected files to the catalog snapshot shown in its reference picker. */
export function assertCatalogInputBasis(project, basis, { required = false } = {}) {
  if (project?.castAndSets?.source !== 'catalog') return;
  if ((required || basis != null) && basis !== project.castAndSets.catalogCheckin?.basis) {
    throw new ServerError('The catalog references changed. Reload this shot and select the current references before rendering.',
      { status: 409, code: 'CAST_SETS_CATALOG_REFERENCE_CHANGED' });
  }
}

/** Submitted file lists must not reintroduce saved generated sheets behind the reference picker. */
export function assertCatalogReferenceFiles(project, files) {
  if (files.some(imageId => imageId && isLegacyCatalogReference(project, { imageId }))) {
    throw new ServerError('Generated Cast & Sets sheets are historical. Select the current catalog references before rendering.',
      { status: 409, code: 'CAST_SETS_CATALOG_REFERENCE_CHANGED' });
  }
}

/** Final queued or synchronous dispatch guard, after every input-preparation step. */
export async function assertCatalogRenderParams(params, snapshot = null) {
  if (!params?.musicVideo?.sceneId) return;
  const { getProject } = await import('./projects.js');
  const project = await requireCatalogRenderReady(snapshot || await getProject(params.musicVideo.projectId));
  const basis = project?.castAndSets?.catalogCheckin?.basis;
  if (project?.castAndSets?.source === 'catalog' && basis) {
    if (params.musicVideoCatalogBasis && params.musicVideoCatalogBasis !== basis) {
      throw new ServerError('The catalog check-in changed after these render inputs were prepared. Submit again with current references.',
        { status: 409, code: 'CAST_SETS_CATALOG_REFERENCE_CHANGED' });
    }
    params.musicVideoCatalogBasis = basis;
  }
  assertCatalogReferenceFiles(project, [params.initImagePath, params.imagePath, params.lastImagePath,
    ...(params.referenceImagePaths || []), ...(params.icReferencePaths || []),
    ...(params.castReferences || []).map(ref => ref.path),
    ...(params.remoteMedia?.inputAssets || []).map(asset => asset.path),
  ].filter(Boolean).map(file => basename(file)));
}

/** Ordered references for a tagged shot, resolved once before the job is queued. */
export async function musicVideoClipReferences({ projectId, sceneId } = {}, limit = MUSIC_VIDEO_MAX_REFERENCE_CHOICES, { excludePath = null, excludeImageId = null, project: snapshot = null, includePromptLabels = false } = {}) {
  if (!projectId || !sceneId || limit < 1) return [];
  const { getProject } = await import('./projects.js');
  const project = await requireCatalogRenderReady(snapshot || await getProject(projectId));
  const scene = project?.scenes?.find((entry) => entry.sceneId === sceneId);
  if (!scene) return [];
  const castMedia = await loadSceneCastMedia(scene, { project });
  const choices = musicVideoClipReferenceChoices(project, scene, castMedia);
  if (Array.isArray(scene.clipReferenceIds) && scene.clipReferenceIds.some((id) => !choices.some((ref) => ref.id === id))) {
    throw new ServerError('A selected clip reference is unavailable. Restore it or reset the clip references.', { status: 409, code: 'MUSIC_VIDEO_CLIP_REFERENCE_MISSING' });
  }
  const references = musicVideoClipConditioningReferences(project, scene, castMedia);
  const resolved = [];
  for (const ref of references) {
    if (resolved.length >= limit) break;
    if (ref.imageId === excludeImageId) continue;
    const path = (ref.castGuide || ref.linkedCast || ref.catalogSubjectId) ? resolveImageInputPath(ref.imageId) : resolveGalleryImage(ref.imageId);
    if (!path) throw new ServerError(`The clip reference ${ref.label || ref.imageId} is missing. Restore it or select another.`,
      { status: 409, code: 'MUSIC_VIDEO_CLIP_REFERENCE_MISSING' });
    if (path === excludePath || resolved.some((item) => item.path === path)) continue;
    resolved.push({ path, label: ref.label || '', ...(ref.role && ref.role !== 'character' ? { role: ref.role } : {}),
      ...(includePromptLabels ? { promptLabel: ref.label || ref.role || 'visual reference' } : {}) });
  }
  return resolved;
}

/**
 * A hosted clip's references: the shot's selected greybox camera plate leads as
 * its set reference, then the clip references fill the remaining slots. The
 * default limit is Grok's: its CLI does not expose its video-model id.
 */
export async function musicVideoHostedClipReferences(tag = {}, limit = MUSIC_VIDEO_GROK_CLIP_REFERENCE_LIMIT, { excludePath = null } = {}) {
  if (!tag.projectId || !tag.sceneId || limit < 1) return [];
  const [{ getProject }, { loadMusicVideoGreybox }] = await Promise.all([import('./projects.js'), import('./greyboxReferences.js')]);
  const project = await requireCatalogRenderReady(await getProject(tag.projectId));
  const scene = project?.scenes?.find((entry) => entry.sceneId === tag.sceneId);
  const greybox = scene && await loadMusicVideoGreybox(project, scene);
  const lead = greybox && greybox.path !== excludePath
    ? [{ path: greybox.path, label: greybox.reference.label, role: 'set', greybox: true }] : [];
  const rest = await musicVideoClipReferences(tag, limit - lead.length, { excludePath, excludeImageId: greybox?.reference.imageId, project });
  return [...lead, ...rest];
}

/** The tagged shot's selected greybox camera, or null. */
export async function musicVideoShotGreybox({ projectId, sceneId } = {}) {
  const [{ getProject }, { loadMusicVideoGreybox }] = await Promise.all([import('./projects.js'), import('./greyboxReferences.js')]);
  const project = await getProject(projectId);
  return loadMusicVideoGreybox(project, project?.scenes?.find((entry) => entry.sceneId === sceneId));
}

/**
 * Resolved paths of the shot's cast sheets for a local reference-to-video model
 * (`maxReferenceImages` counts the source still first, so `limit` is the rest):
 * the still provides the scene reference and these help preserve its cast.
 */
export async function musicVideoLocalReferencePaths({ projectId, sceneId } = {}, limit = 0, { excludePath = null } = {}) {
  const references = await musicVideoClipReferences({ projectId, sceneId }, limit, { excludePath });
  return references.map((ref) => ref.path);
}
