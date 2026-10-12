/**
 * A music video's media pool: every still and clip generated for the project,
 * kept in the project's own media collection (`mvc-<projectId>`) so nothing a
 * shot drops is lost, and listed for the shot card's "Swap from unused" picker.
 *
 * Filing happens when a take lands (projects.js appendSceneTakes), when a
 * change drops takes from the board (a cut shot, a merge, a re-plan, a pruned
 * take), and on every pool read, which also backfills whatever the project
 * already holds. A clip's still is kept on its video history entry
 * (`musicVideo.sourceImageId`), so a clip on the floor still pairs with its
 * still after the shot that held both is gone.
 */

import { TAKE_SLOT } from './takes.js';

const KIND_OF_SLOT = { image: 'image', endImage: 'image', video: 'video' };

/** The still a video take was rendered from, when it recorded one. */
function takeSourceImageId(take) {
  if (take?.sourceImageId) return take.sourceImageId;
  return take?.dependencies?.references?.find((ref) => ref?.role === 'plate')?.assetId || null;
}

/** Every asset the project's shots hold as a take or a selection: `{ kind, ref, sceneId, take }`. */
export function projectTakeAssets(project) {
  const assets = [];
  for (const scene of project?.scenes || []) {
    const seen = new Set();
    for (const take of Array.isArray(scene.takes) ? scene.takes : []) {
      const kind = KIND_OF_SLOT[take?.kind];
      if (!kind || typeof take.assetId !== 'string' || !take.assetId) continue;
      seen.add(`${kind}:${take.assetId}`);
      assets.push({ kind, ref: take.assetId, sceneId: scene.sceneId, take });
    }
    for (const [slot, field] of Object.entries(TAKE_SLOT)) {
      const ref = scene[field];
      const kind = KIND_OF_SLOT[slot];
      if (typeof ref === 'string' && ref && !seen.has(`${kind}:${ref}`)) {
        seen.add(`${kind}:${ref}`);
        assets.push({ kind, ref, sceneId: scene.sceneId, take: null });
      }
    }
  }
  return assets;
}

/** Assets held by `before` that `after` no longer holds anywhere on its board. */
export function droppedTakeAssets(before, after) {
  const kept = new Set(projectTakeAssets(after).map((asset) => `${asset.kind}:${asset.ref}`));
  return projectTakeAssets(before).filter((asset) => !kept.has(`${asset.kind}:${asset.ref}`));
}

const usedKeys = (project) => new Set((project?.scenes || []).flatMap((scene) => Object.entries(TAKE_SLOT)
  .map(([slot, field]) => (scene[field] ? `${KIND_OF_SLOT[slot]}:${scene[field]}` : null)).filter(Boolean)));

/**
 * The pool the picker shows: every asset in the collection or on the board that
 * no shot uses now (not selected in any shot's still, clip or end frame slot).
 * Each item names the shot whose takes hold it (null on the floor), the take's
 * prompt and status, a clip's still, and the clips rendered from a still.
 * `history` maps a video id to its history entry. Newest first.
 */
function buildMediaPool(project, collectionItems = [], history = new Map()) {
  const used = usedKeys(project);
  const byKey = new Map();
  const add = (kind, ref, fields) => {
    const key = `${kind}:${ref}`;
    const current = byKey.get(key);
    // A take's details win over a bare collection row; the first shot holding it names it.
    if (!current) byKey.set(key, { kind, assetId: ref, sceneId: null, takeStatus: null, prompt: null, sourceImageId: null, addedAt: null, ...fields });
    else if (!current.sceneId && fields.sceneId) byKey.set(key, { ...current, ...fields, addedAt: current.addedAt || fields.addedAt });
  };
  for (const { kind, ref, sceneId, take } of projectTakeAssets(project)) {
    add(kind, ref, { sceneId, takeStatus: take?.status || null, prompt: take?.prompt || null,
      sourceImageId: kind === 'video' ? takeSourceImageId(take) : null, addedAt: take?.createdAt || null });
  }
  for (const item of collectionItems) {
    if (item?.kind !== 'image' && item?.kind !== 'video') continue;
    const entry = item.kind === 'video' ? history.get(item.ref) : null;
    add(item.kind, item.ref, { sourceImageId: entry?.musicVideo?.sourceImageId || null, prompt: entry?.prompt || null, addedAt: item.addedAt || null });
  }
  const items = [...byKey.values()];
  const clipsByStill = new Map();
  for (const item of items) {
    if (item.kind !== 'video' || !item.sourceImageId) continue;
    clipsByStill.set(item.sourceImageId, [...(clipsByStill.get(item.sourceImageId) || []), item.assetId]);
  }
  return items
    .filter((item) => !used.has(`${item.kind}:${item.assetId}`))
    .map((item) => (item.kind === 'image' ? { ...item, clipIds: clipsByStill.get(item.assetId) || [] } : item))
    .sort((a, b) => String(b.addedAt || '').localeCompare(String(a.addedAt || '')));
}

/**
 * File assets into the project's collection, and record each clip's shot and
 * still on its video history entry. Best-effort bookkeeping: a failure is
 * logged, never thrown into the render or edit that triggered it.
 */
export async function fileMusicVideoMedia(project, assets) {
  if (!project?.id || !assets?.length) return;
  try {
    const { findOrCreateMusicVideoCollection, bulkUpdateCollectionItems } = await import('../mediaCollections.js');
    const collection = await findOrCreateMusicVideoCollection({ projectId: project.id, projectName: project.name });
    const present = new Set(collection.items.map((item) => `${item.kind}:${item.ref}`));
    const add = [];
    for (const { kind, ref } of assets) {
      const key = `${kind}:${ref}`;
      if (present.has(key) || ref.includes(':') || ref.includes('/')) continue;
      present.add(key);
      add.push({ kind, ref });
    }
    if (add.length) await bulkUpdateCollectionItems(collection.id, { add });
    const clips = new Map(assets.filter((asset) => asset.kind === 'video')
      .map((asset) => [asset.ref, { projectId: project.id, sceneId: asset.sceneId || null, sourceImageId: takeSourceImageId(asset.take) }]));
    if (clips.size) await stampClipProvenance(clips);
  } catch (err) {
    console.error(`❌ music-video media pool: filing for ${project.id} failed: ${err.message}`);
  }
}

async function stampClipProvenance(clips) {
  const { mutateVideoHistory, HISTORY_UNCHANGED } = await import('../videoGen/history.js');
  await mutateVideoHistory((history) => {
    let changed = false;
    for (const entry of history) {
      const tag = entry && clips.get(entry.id);
      if (!tag || entry.musicVideo?.projectId === tag.projectId) continue;
      entry.musicVideo = tag;
      changed = true;
    }
    return changed ? history : HISTORY_UNCHANGED;
  });
}

/**
 * The unused stills and clips for a project's picker, backfilling its
 * collection first. An asset no longer in the media library (deleted from the
 * gallery or history) is left out rather than shown as a broken tile.
 */
export async function getMusicVideoMediaPool(project) {
  await fileMusicVideoMedia(project, projectTakeAssets(project));
  const [{ getCollection, musicVideoCollectionId }, { loadHistory }, { resolveGalleryImage }] = await Promise.all([
    import('../mediaCollections.js'), import('../videoGen/history.js'), import('../../lib/pathSafety.js'),
  ]);
  const collection = await getCollection(musicVideoCollectionId(project.id)).catch(() => null);
  const history = new Map((await loadHistory()).filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  const items = buildMediaPool(project, collection?.items || [], history)
    .filter((item) => (item.kind === 'video' ? history.has(item.assetId) : Boolean(resolveGalleryImage(item.assetId))))
    // A partner that is gone is not offered, so "Use … + its still|clip" always works.
    .map((item) => (item.clipIds ? { ...item, clipIds: item.clipIds.filter((id) => history.has(id)) }
      : item.sourceImageId && !resolveGalleryImage(item.sourceImageId) ? { ...item, sourceImageId: null } : item));
  return { collectionId: collection?.id || null, items };
}
