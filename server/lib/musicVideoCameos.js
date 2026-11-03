/**
 * Music Video cameos (#14821): light, per-video references for things a video
 * shows in many shots (each dog in a roll call) that do not need a Casting
 * record: a name, label, notes, a few photos and one chosen still. A shot links one cameo (`scene.cameoId`, optionally a variant
 * `scene.cameoVariantId`); while the shot has no still of its own, the
 * cameo's chosen still (or the variant's) is written into its slot as a take
 * with `source: 'cameo'`, so every renderer, the player and peer sync read it
 * like any other selection. Changing the still refills exactly those shots.
 *
 * A shot "has its own take" when its selected start frame is any take that did
 * not come from the cameo. Pure: no I/O.
 */

export const MUSIC_VIDEO_MAX_CAMEOS = 500;
export const MUSIC_VIDEO_CAMEO_MAX_REFERENCES = 12;
export const MUSIC_VIDEO_CAMEO_MAX_VARIANTS = 8;
export const MUSIC_VIDEO_CAMEO_MAX_SOURCES = 12;
export const MUSIC_VIDEO_CAMEO_RESEARCH_STATUSES = Object.freeze(['unverified', 'verified']);
export const MUSIC_VIDEO_CAMEO_REFERENCE_SOURCES = Object.freeze(['upload', 'gallery', 'research', 'shot']);
export const MUSIC_VIDEO_CAMEO_ID_PATTERN = /^mvcam-[A-Za-z0-9-]{1,64}$/;
export const MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN = /^mvcamv-[A-Za-z0-9-]{1,64}$/;
/** What a shot's take records when its still came from the cameo. */
export const CAMEO_TAKE_SOURCE = 'cameo';

const str = (v) => (typeof v === 'string' ? v : '');

/** The project's roster, tolerant of missing or malformed records. */
export function musicVideoCameos(project) {
  return (Array.isArray(project?.cameos) ? project.cameos : [])
    .filter((s) => s && typeof s.cameoId === 'string');
}

export function findMusicVideoCameo(project, cameoId) {
  return cameoId ? musicVideoCameos(project).find((s) => s.cameoId === cameoId) || null : null;
}

/** The image a shot linked to this cameo (and variant) shows; null when none is chosen yet. */
export function cameoStillFor(cameo, variantId = null) {
  if (!cameo) return null;
  if (variantId) {
    const variant = (cameo.variants || []).find((v) => v?.variantId === variantId);
    return variant?.imageId || null;
  }
  return cameo.stillImageId || null;
}

/** True when the shot's start frame is the cameo's (or empty), so a cameo still may fill it. */
export function shotInheritsCameoStill(scene) {
  if (!scene?.referenceImageId) return true;
  const take = (scene.takes || []).find((t) => t?.kind === 'image' && t.assetId === scene.referenceImageId);
  return take?.source === CAMEO_TAKE_SOURCE;
}

/**
 * The scene with its start frame set to `imageId` (null clears it) as a cameo
 * take, dropping the earlier cameo takes it replaces. A shot with its own
 * selected still is returned unchanged.
 */
export function fillSceneFromCameo(scene, imageId, now = new Date().toISOString()) {
  if (!shotInheritsCameoStill(scene)) return scene;
  const current = scene.referenceImageId || null;
  if (current === (imageId || null)) return scene;
  const takes = (Array.isArray(scene.takes) ? scene.takes : [])
    .filter((t) => !(t?.kind === 'image' && t.source === CAMEO_TAKE_SOURCE && t.assetId !== imageId));
  const has = imageId && takes.some((t) => t?.kind === 'image' && t.assetId === imageId);
  const added = imageId && !has ? [{
    takeId: `mvt-cameo-${scene.sceneId}-${imageId}`.slice(0, 128),
    kind: 'image', assetId: imageId, source: CAMEO_TAKE_SOURCE, provider: 'portos', jobId: null,
    prompt: null, sourceImageId: null, originalName: null, status: 'candidate', use: 'final', note: null, createdAt: now,
  }] : [];
  return { ...scene, referenceImageId: imageId || null, takes: [...takes, ...added] };
}

/** Refill every shot linked to `cameoId` from the cameo's current stills. */
export function fillCameoShots(project, cameoId, now = new Date().toISOString()) {
  const cameo = findMusicVideoCameo(project, cameoId);
  let changed = false;
  const scenes = (project.scenes || []).map((scene) => {
    if (scene?.cameoId !== cameoId) return scene;
    const next = fillSceneFromCameo(scene, cameoStillFor(cameo, scene.cameoVariantId || null), now);
    if (next !== scene) changed = true;
    return next;
  });
  return changed ? { ...project, scenes } : project;
}

/** Every gallery image the roster points at (references, stills, variants), for peer sync. */
export function musicVideoCameoImageIds(project) {
  return [...new Set(musicVideoCameos(project).flatMap((s) => [
    ...(s.references || []).map((r) => r?.imageId),
    s.stillImageId,
    ...(s.variants || []).map((v) => v?.imageId),
  ]).filter((id) => typeof id === 'string' && id))];
}

/**
 * What each cameo still needs and how many shots it fills: `needs` lists
 * 'research' (not verified), 'references' (none), 'still' (none chosen) and
 * 'variant' (a linked shot picks a variant with no image yet).
 */
export function musicVideoCameoCoverage(project) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const cameos = musicVideoCameos(project).map((cameo) => {
    const linked = scenes.filter((s) => s?.cameoId === cameo.cameoId);
    const filled = linked.filter((s) => s.referenceImageId).length;
    const variantsMissing = [...new Set(linked.map((s) => s.cameoVariantId).filter(Boolean))]
      .filter((id) => !cameoStillFor(cameo, id));
    const needs = [
      ...(cameo.research?.status === 'verified' ? [] : ['research']),
      ...((cameo.references || []).length ? [] : ['references']),
      ...(cameo.stillImageId ? [] : ['still']),
      ...(variantsMissing.length ? ['variant'] : []),
    ];
    return { cameoId: cameo.cameoId, name: str(cameo.name), shots: linked.length, filled, needs };
  });
  const count = (need) => cameos.filter((s) => s.needs.includes(need)).length;
  return {
    cameos,
    totals: {
      cameos: cameos.length,
      linkedShots: cameos.reduce((n, s) => n + s.shots, 0),
      unlinked: cameos.filter((s) => !s.shots).length,
      research: count('research'), references: count('references'), still: count('still'), variant: count('variant'),
    },
  };
}

/** The roster as a composition document reads it (`PORTOS_MV.cameos`). */
export function documentCameos(project) {
  return musicVideoCameos(project).map((s) => ({
    cameoId: s.cameoId,
    name: str(s.name),
    label: str(s.label) || str(s.name),
    hasStill: Boolean(s.stillImageId),
    variants: (s.variants || []).map((v) => ({ variantId: v.variantId, label: str(v.label), hasStill: Boolean(v.imageId) })),
  }));
}

/** A linked shot's cameo fields for the document: id, variant and the on-screen label. */
export function documentSceneCameo(project, scene) {
  const cameo = findMusicVideoCameo(project, scene?.cameoId);
  if (!cameo) return {};
  return {
    cameoId: cameo.cameoId,
    cameoVariantId: scene.cameoVariantId || null,
    cameoLabel: str(scene.cameoLabel) || str(cameo.label) || str(cameo.name),
  };
}

/**
 * The cameo's reference photos as frame-render conditioning chips (the shot's
 * References row), leading a linked shot's automatic references.
 */
export function musicVideoCameoReferences(project, scene) {
  const cameo = findMusicVideoCameo(project, scene?.cameoId);
  if (!cameo) return [];
  const name = str(cameo.name) || 'Cameo';
  return (cameo.references || []).filter((r) => typeof r?.imageId === 'string' && r.imageId)
    .map((r, i) => ({
      id: `mvr-cameo-${cameo.cameoId}-${i}`.slice(0, 128),
      imageId: r.imageId,
      role: 'character',
      label: `${name} · photo ${i + 1}`.slice(0, 120),
      cameoReference: true,
    }));
}
