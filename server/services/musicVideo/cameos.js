/**
 * Music Video cameo roster (#14821) — record transforms behind the
 * `/api/music-video/:id/cameos` routes. The pure rules (which shots inherit a
 * still, coverage, document data) live in lib/musicVideoCameos.js; each edit
 * that changes a still refills the linked shots in the same write.
 */

import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import {
  MUSIC_VIDEO_MAX_CAMEOS, MUSIC_VIDEO_CAMEO_MAX_REFERENCES, MUSIC_VIDEO_CAMEO_MAX_VARIANTS,
  fillSceneFromCameo, fillCameoShots, musicVideoCameos, cameoStillFor,
} from '../../lib/musicVideoCameos.js';
import { mutateProjectRecord } from './projects.js';

const notFound = (what) => new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });
const invalid = (message) => new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });

function assertGalleryImages(ids) {
  for (const id of ids) if (id && !resolveGalleryImage(id)) throw new ServerError(`Gallery image not found: ${id}`, { status: 404, code: 'NOT_FOUND' });
}

const touch = (project, fields) => ({ ...project, ...fields, updatedAt: new Date().toISOString() });

function withCameo(project, cameoId, edit) {
  const cameos = musicVideoCameos(project);
  const index = cameos.findIndex((s) => s.cameoId === cameoId);
  if (index < 0) throw notFound('Cameo');
  const cameo = edit(cameos[index]);
  const next = cameos.slice();
  next[index] = { ...cameo, updatedAt: new Date().toISOString() };
  return { project: fillCameoShots(touch(project, { cameos: next }), cameoId), cameo: next[index] };
}

// Every edit answers the roster and the shots it may have refilled, for the board to apply.
const answer = ({ project, ...rest }) => ({ ...rest, cameos: musicVideoCameos(project), scenes: project.scenes || [], updatedAt: project.updatedAt });
const mutate = async (projectId, transform) => answer(await mutateProjectRecord(projectId, transform));

export async function createCameos(projectId, inputs) {
  return mutate(projectId, (project) => {
    const cameos = musicVideoCameos(project);
    if (cameos.length + inputs.length > MUSIC_VIDEO_MAX_CAMEOS) {
      throw invalid(`A video holds up to ${MUSIC_VIDEO_MAX_CAMEOS} cameos (${cameos.length} now, adding ${inputs.length})`);
    }
    const now = new Date().toISOString();
    const fresh = inputs.map((input) => ({
      cameoId: `mvcam-${randomUUID()}`,
      name: input.name,
      label: input.label || '',
      description: input.description || '',
      research: { status: 'unverified', notes: '', sources: [] },
      references: [],
      stillImageId: null,
      variants: [],
      createdAt: now,
      updatedAt: now,
    }));
    return { project: touch(project, { cameos: [...cameos, ...fresh] }), created: fresh };
  });
}

export async function updateCameo(projectId, cameoId, patch) {
  if (patch.stillImageId) assertGalleryImages([patch.stillImageId]);
  return mutate(projectId, (project) => withCameo(project, cameoId, (current) => ({
    ...current,
    ...('name' in patch ? { name: patch.name } : {}),
    ...('label' in patch ? { label: patch.label } : {}),
    ...('description' in patch ? { description: patch.description } : {}),
    ...('stillImageId' in patch ? { stillImageId: patch.stillImageId } : {}),
    ...(patch.research ? { research: { status: 'unverified', notes: '', sources: [], ...current.research, ...patch.research } } : {}),
  })));
}

/** Remove a cameo; its shots unlink and drop the still they inherited from it. */
export async function deleteCameo(projectId, cameoId) {
  return mutate(projectId, (project) => {
    const cameos = musicVideoCameos(project);
    if (!cameos.some((s) => s.cameoId === cameoId)) throw notFound('Cameo');
    const scenes = (project.scenes || []).map((scene) => {
      if (scene.cameoId !== cameoId) return scene;
      const { cameoId: _id, cameoVariantId: _variant, cameoLabel: _label, ...rest } = fillSceneFromCameo(scene, null);
      return rest;
    });
    return { project: touch(project, { cameos: cameos.filter((s) => s.cameoId !== cameoId), scenes }) };
  });
}

export async function addCameoReferences(projectId, cameoId, references) {
  assertGalleryImages(references.map((r) => r.imageId));
  return mutate(projectId, (project) => withCameo(project, cameoId, (current) => {
    const existing = current.references || [];
    const now = new Date().toISOString();
    const added = references.filter((r, i) => !existing.some((e) => e.imageId === r.imageId)
      && references.findIndex((o) => o.imageId === r.imageId) === i)
      .map((r) => ({ imageId: r.imageId, source: r.source || 'gallery',
        ...(r.sourceUrl ? { sourceUrl: r.sourceUrl } : {}), ...(r.pageUrl ? { pageUrl: r.pageUrl } : {}), addedAt: now }));
    if (existing.length + added.length > MUSIC_VIDEO_CAMEO_MAX_REFERENCES) {
      throw invalid(`A cameo keeps up to ${MUSIC_VIDEO_CAMEO_MAX_REFERENCES} reference photos`);
    }
    return { ...current, references: [...existing, ...added] };
  }));
}

export async function removeCameoReference(projectId, cameoId, imageId) {
  return mutate(projectId, (project) => withCameo(project, cameoId, (current) => ({
    ...current, references: (current.references || []).filter((r) => r.imageId !== imageId),
  })));
}

export async function addCameoVariant(projectId, cameoId, input) {
  if (input.imageId) assertGalleryImages([input.imageId]);
  return mutate(projectId, (project) => withCameo(project, cameoId, (current) => {
    const variants = current.variants || [];
    if (variants.length >= MUSIC_VIDEO_CAMEO_MAX_VARIANTS) throw invalid(`A cameo keeps up to ${MUSIC_VIDEO_CAMEO_MAX_VARIANTS} variants`);
    return { ...current, variants: [...variants, {
      variantId: `mvcamv-${randomUUID()}`, label: input.label, prompt: input.prompt || '', imageId: input.imageId || null,
    }] };
  }));
}

export async function updateCameoVariant(projectId, cameoId, variantId, patch) {
  if (patch.imageId) assertGalleryImages([patch.imageId]);
  return mutate(projectId, (project) => withCameo(project, cameoId, (current) => {
    const variants = current.variants || [];
    if (!variants.some((v) => v.variantId === variantId)) throw notFound('Variant');
    return { ...current, variants: variants.map((v) => (v.variantId === variantId ? { ...v, ...patch } : v)) };
  }));
}

/** Remove a variant; shots that picked it fall back to the cameo's own still. */
export async function deleteCameoVariant(projectId, cameoId, variantId) {
  return mutate(projectId, (project) => {
    const scenes = (project.scenes || []).map((scene) => {
      if (scene.cameoId !== cameoId || scene.cameoVariantId !== variantId) return scene;
      const { cameoVariantId: _variant, ...rest } = scene;
      return rest;
    });
    return withCameo({ ...project, scenes }, cameoId, (current) => {
      if (!(current.variants || []).some((v) => v.variantId === variantId)) throw notFound('Variant');
      return { ...current, variants: current.variants.filter((v) => v.variantId !== variantId) };
    });
  });
}

/** Link several shots to the cameo (optionally a variant) in one write. */
export async function linkCameoShots(projectId, cameoId, { sceneIds, variantId = null }) {
  return mutate(projectId, (project) => {
    const cameo = musicVideoCameos(project).find((s) => s.cameoId === cameoId);
    if (!cameo) throw notFound('Cameo');
    if (variantId && !(cameo.variants || []).some((v) => v.variantId === variantId)) throw invalid('That variant is not on this cameo');
    const wanted = new Set(sceneIds);
    const known = new Set((project.scenes || []).map((s) => s.sceneId));
    const missing = sceneIds.filter((id) => !known.has(id));
    if (missing.length) throw notFound(`Shot ${missing[0]}`);
    const still = cameoStillFor(cameo, variantId);
    const scenes = project.scenes.map((scene) => {
      if (!wanted.has(scene.sceneId)) return scene;
      const same = scene.cameoId === cameoId && (scene.cameoVariantId || null) === variantId;
      if (same) return scene;
      // Leaving another cameo: its inherited still and the alias it showed go with it.
      const leaving = scene.cameoId && scene.cameoId !== cameoId;
      const { cameoVariantId: _old, cameoLabel, ...base } = leaving ? fillSceneFromCameo(scene, null) : scene;
      return fillSceneFromCameo({ ...base, cameoId, ...(variantId ? { cameoVariantId: variantId } : {}),
        ...(!leaving && cameoLabel ? { cameoLabel } : {}) }, still);
    });
    return { project: touch(project, { scenes }) };
  });
}

/**
 * Use a linked shot's selected still as the cameo's still (or a variant's):
 * the way a variant made with a shot's Refine becomes the variant every other
 * shot picking it shows.
 */
export async function useShotStillForCameo(projectId, cameoId, { sceneId, variantId = null }) {
  return mutate(projectId, (project) => {
    const scene = (project.scenes || []).find((s) => s.sceneId === sceneId);
    if (!scene) throw notFound('Shot');
    const imageId = scene.referenceImageId;
    if (!imageId) throw invalid('That shot has no still yet');
    return withCameo(project, cameoId, (current) => {
      if (!variantId) return { ...current, stillImageId: imageId };
      if (!(current.variants || []).some((v) => v.variantId === variantId)) throw notFound('Variant');
      return { ...current, variants: current.variants.map((v) => (v.variantId === variantId ? { ...v, imageId } : v)) };
    });
  });
}

/** Unlink shots from whatever cameo they show; each drops the still it inherited. */
export async function unlinkCameoShots(projectId, { sceneIds }) {
  return mutate(projectId, (project) => {
    const wanted = new Set(sceneIds);
    const scenes = (project.scenes || []).map((scene) => {
      if (!wanted.has(scene.sceneId) || !scene.cameoId) return scene;
      const { cameoId: _id, cameoVariantId: _variant, cameoLabel: _label, ...rest } = fillSceneFromCameo(scene, null);
      return rest;
    });
    return { project: touch(project, { scenes }) };
  });
}
