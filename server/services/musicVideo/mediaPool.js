/**
 * A music video's media pool: every still and clip generated for the project,
 * kept in the project's own media collection (`mvc-<projectId>`) so nothing a
 * shot drops is lost, and listed for the shot card's "Swap from unused" picker.
 *
 * Filing happens when a take lands (projects.js appendSceneTakes), when any
 * render naming the video completes (musicVideoCollectionHook.js), when a
 * change drops takes from the board (a cut shot, a merge, a re-plan, a pruned
 * take), and on every pool read, which also backfills whatever the project
 * already holds and every clip stamped with it. A clip's still is kept on its video history entry
 * (`musicVideo.sourceImageId`), so a clip on the floor still pairs with its
 * still after the shot that held both is gone.
 */

import { TAKE_SLOT } from './takes.js';
import { ServerError } from '../../lib/errorHandler.js';
import { isFileBackend } from '../../lib/pgFileFacade.js';

export const KIND_OF_SLOT = { image: 'image', endImage: 'image', video: 'video' };

/** The still a video take was rendered from, when it recorded one. */
function takeSourceImageId(take) {
  if (take?.sourceImageId) return take.sourceImageId;
  return take?.dependencies?.references?.find((ref) => ref?.role === 'plate')?.assetId || null;
}

function selectedVideoFrameMismatch(scene) {
  const video = (scene.takes || []).find((take) => take.kind === 'video' && take.assetId === scene.videoHistoryId);
  const source = takeSourceImageId(video);
  return Boolean(source && scene.referenceImageId && source !== scene.referenceImageId);
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

/**
 * Mark assets ★ ingredient (good, unplaced) or ✕ bad (to clean up); null
 * clears the mark. Marks live on the project (`assetMarks`, keyed
 * `<image|video>:<ref>`), so a still bad for one video stays fine in another.
 * When an asset marked bad is currently selected on a shot (frame, end frame
 * or clip), the shot falls back to its next available take of that kind (most
 * recent first; for a clip, only one built on the shot's current frame), and
 * the bad take is rejected. If no candidate take remains, the selection stays
 * and the shot is flagged `selectedTakeMarkedBad`. Bad also rejects the
 * asset's takes on every shot not using it now.
 * Pass `{ keepInUse: true }` to retain selections without fallback.
 * Resolves `{ project, scenes, changes }`.
 */
export function markPoolAssets(project, keys, mark, options = {}) {
  if (Object.hasOwn(options, 'expectedMark') && keys.some((key) => (project.assetMarks?.[key] || null) !== options.expectedMark)) {
    throw new ServerError('This asset has a newer mark; Undo kept it.', { status: 409, code: 'MUSIC_VIDEO_UNDO_CONFLICT' });
  }
  const assetMarks = { ...(project.assetMarks || {}) };
  for (const key of keys) {
    if (mark) assetMarks[key] = mark;
    else delete assetMarks[key];
  }
  if (mark !== 'bad') {
    let cleaned = false;
    const scenes = (project.scenes || []).map((scene) => {
      if (!scene.selectedTakeMarkedBad) return scene;
      const isBad = (slot, field) => {
        const ref = scene[field];
        return Boolean(ref && assetMarks[`${KIND_OF_SLOT[slot]}:${ref}`] === 'bad');
      };
      const stillBad = Object.entries(TAKE_SLOT).some(([slot, field]) => isBad(slot, field)) || selectedVideoFrameMismatch(scene);
      if (!stillBad) {
        cleaned = true;
        const { selectedTakeMarkedBad: _flag, ...rest } = scene;
        return rest;
      }
      return scene;
    });
    return {
      project: { ...project, assetMarks, ...(cleaned ? { scenes } : {}) },
      scenes: cleaned ? scenes.filter((s, i) => s !== project.scenes[i]) : [],
      changes: [],
    };
  }

  const bad = new Set(keys);
  if (options.keepInUse === true) {
    const changed = [];
    const scenes = (project.scenes || []).map((scene) => {
      if (!Array.isArray(scene.takes)) return scene;
      const reject = (take) => take?.status !== 'rejected' && bad.has(`${KIND_OF_SLOT[take?.kind]}:${take?.assetId}`)
        && scene[TAKE_SLOT[take.kind]] !== take.assetId;
      if (!scene.takes.some(reject)) return scene;
      const next = { ...scene, takes: scene.takes.map((take) => (reject(take) ? { ...take, status: 'rejected' } : take)) };
      changed.push(next);
      return next;
    });
    return { project: { ...project, assetMarks, scenes }, scenes: changed, changes: [] };
  }

  const changed = [];
  const changes = [];
  const scenes = (project.scenes || []).map((scene) => {
    const current = { ...scene };
    let takes = Array.isArray(scene.takes) ? [...scene.takes] : [];
    let modified = false;

    const fallBackSelection = (slot, { force = false, extraCandidate, reason } = {}) => {
      const field = TAKE_SLOT[slot];
      const markKind = KIND_OF_SLOT[slot];
      const fromAssetId = scene[field];
      const newlyBad = bad.has(`${markKind}:${fromAssetId}`);
      if (!fromAssetId || (!newlyBad && !force)) return;

      const candidate = takes.findLast(take =>
        take.kind === slot &&
        take.assetId !== fromAssetId &&
        take.status !== 'rejected' &&
        assetMarks[`${markKind}:${take.assetId}`] !== 'bad' &&
        (!extraCandidate || extraCandidate(take)),
      );
      const previousTakeId = candidate ? takes.find(take => take.kind === slot && take.assetId === fromAssetId)?.takeId || null : null;
      modified = true;
      if (candidate) {
        current[field] = candidate.assetId;
        if (newlyBad) {
          takes = takes.map(take => take.kind === slot && take.assetId === fromAssetId ? { ...take, status: 'rejected' } : take);
        }
      } else {
        current.selectedTakeMarkedBad = true;
      }
      changes.push({
        sceneId: scene.sceneId,
        label: scene.label || null,
        action: candidate ? 'moved' : 'flagged',
        slot,
        fromAssetId,
        toAssetId: candidate ? candidate.assetId : fromAssetId,
        toTakeId: candidate?.takeId ?? null,
        previousTakeId,
        ...(!candidate && reason && assetMarks[`${markKind}:${fromAssetId}`] !== 'bad' && { reason }),
      });
    };

    fallBackSelection('image');
    fallBackSelection('endImage');
    const currentFrame = current.referenceImageId;
    fallBackSelection('video', {
      force: currentFrame !== scene.referenceImageId && selectedVideoFrameMismatch({ ...current, takes }),
      extraCandidate: take => Boolean(currentFrame) && takeSourceImageId(take) === currentFrame,
      reason: 'clip-frame-mismatch',
    });

    // 4. Reject unselected takes whose assets are bad
    takes = takes.map((take) => {
      const isSelected = current[TAKE_SLOT[take.kind]] === take.assetId;
      if (!isSelected && take.status !== 'rejected' && bad.has(`${KIND_OF_SLOT[take.kind]}:${take.assetId}`)) {
        modified = true;
        return { ...take, status: 'rejected' };
      }
      return take;
    });

    // 5. Clear selectedTakeMarkedBad if all selected slots are clean
    if (current.selectedTakeMarkedBad) {
      const isBad = (slot, field) => {
        const ref = current[field];
        return Boolean(ref && assetMarks[`${KIND_OF_SLOT[slot]}:${ref}`] === 'bad');
      };
      const stillBad = Object.entries(TAKE_SLOT).some(([slot, field]) => isBad(slot, field)) || selectedVideoFrameMismatch({ ...current, takes });
      if (!stillBad) {
        delete current.selectedTakeMarkedBad;
        modified = true;
      }
    }

    if (modified) {
      current.takes = takes;
      changed.push(current);
      return current;
    }
    return scene;
  });
  return { project: { ...project, assetMarks, scenes }, scenes: changed, changes };
}

/**
 * Forget assets whose files are gone: their takes on every shot that does not
 * use them now, and their marks. A shot still using one keeps it, so its
 * missing media is reported where the shot is, not silently cleared.
 */
export function forgetPoolAssets(project, keys) {
  const gone = new Set(keys);
  const used = usedKeys(project);
  let removed = 0;
  const scenes = (project.scenes || []).map((scene) => {
    if (!Array.isArray(scene.takes)) return scene;
    const takes = scene.takes.filter((take) => {
      const key = `${KIND_OF_SLOT[take?.kind]}:${take?.assetId}`;
      const drop = gone.has(key) && !used.has(key);
      if (drop) removed += 1;
      return !drop;
    });
    return takes.length === scene.takes.length ? scene : { ...scene, takes };
  });
  const assetMarks = Object.fromEntries(Object.entries(project.assetMarks || {}).filter(([key]) => !gone.has(key)));
  return { project: { ...project, scenes, assetMarks }, removed };
}

export const usedKeys = (project) => new Set((project?.scenes || []).flatMap((scene) => Object.entries(TAKE_SLOT)
  .map(([slot, field]) => (scene[field] ? `${KIND_OF_SLOT[slot]}:${scene[field]}` : null)).filter(Boolean)));

/** Revalidate newly selected local media while project mutation admission is held.
 * Existing missing selections and peer-qualified references retain their legacy semantics.
 */
export async function assertNewMediaSelections(before, after) {
  const previous = usedKeys(before);
  const added = [...usedKeys(after)].filter(key => !previous.has(key));
  if (!added.length) return;
  const [{ resolveGalleryImage }, { getHistoryItem }] = await Promise.all([
    import('../../lib/pathSafety.js'), import('../videoGen/history.js'),
  ]);
  for (const key of added) {
    const separator = key.indexOf(':');
    const kind = key.slice(0, separator);
    const assetId = key.slice(separator + 1);
    if (assetId.includes(':') || assetId.includes('/')) continue;
    const exists = kind === 'image' ? resolveGalleryImage(assetId) : await getHistoryItem(assetId);
    if (!exists) throw new ServerError(`${kind === 'image' ? 'Image' : 'Video'} not found in this install's media library`, { status: 400, code: 'TAKE_ASSET_NOT_FOUND' });
  }
}

/** Each `<kind>:<id>` a shot uses now, mapped to the shots using it (still, clip or end frame slot), in board order. */
const shotsUsing = (project) => {
  const using = new Map();
  for (const scene of project?.scenes || []) {
    for (const [slot, field] of Object.entries(TAKE_SLOT)) {
      if (!scene[field]) continue;
      const key = `${KIND_OF_SLOT[slot]}:${scene[field]}`;
      const ids = using.get(key) || [];
      if (!ids.includes(scene.sceneId)) using.set(key, [...ids, scene.sceneId]);
    }
  }
  return using;
};

/**
 * The pool the picker shows: every asset in the collection or on the board,
 * including ones a shot uses now, since a frame placed on one shot can be right
 * for another too. `inUseBy` lists the shots using it (still, clip or end frame
 * slot). Each item names the shot whose takes hold it (else the first shot using
 * it, else null on the floor), the take's prompt and status, a clip's still, and
 * the clips rendered from a still. `history` maps a video id to its history entry.
 * Newest first.
 */
function buildMediaPool(project, collectionItems = [], history = new Map()) {
  const using = shotsUsing(project);
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
  const marks = project?.assetMarks || {};
  return items
    .map((item) => {
      const inUseBy = using.get(`${item.kind}:${item.assetId}`) || [];
      return { ...item, sceneId: item.sceneId || inUseBy[0] || null, inUseBy };
    })
    // Bad is only ever the director's own mark: a take rejected from one shot may be right for another.
    .map((item) => ({ ...item, mark: marks[`${item.kind}:${item.assetId}`] || null }))
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

/** File takes that just landed on shots (`{ sceneId, take }`) into the project's collection. */
export function fileAppendedTakes(project, placed) {
  return fileMusicVideoMedia(project, placed.filter(({ take }) => take?.assetId)
    .map(({ sceneId, take }) => ({ kind: take.kind === 'video' ? 'video' : 'image', ref: take.assetId, sceneId, take })));
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
 * Every still and clip for a project's picker, backfilling its
 * collection first. An asset no longer in the media library (deleted from the
 * gallery or history) is left out rather than shown as a broken tile.
 */
export async function getMusicVideoMediaPool(project) {
  const [{ getCollection, musicVideoCollectionId }, { readHistorySnapshot }, { resolveGalleryImage }] = await Promise.all([
    import('../mediaCollections.js'), import('../videoGen/history.js'), import('../../lib/pathSafety.js'),
  ]);
  const history = new Map((await readHistorySnapshot()).filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  // A clip stamped with this video (a trim or upscale of one of its clips copies the stamp) belongs here too.
  const stamped = [...history.values()].filter((entry) => entry.musicVideo?.projectId === project.id)
    .map((entry) => ({ kind: 'video', ref: entry.id }));
  await fileMusicVideoMedia(project, [...projectTakeAssets(project), ...stamped]);
  const collection = await getCollection(musicVideoCollectionId(project.id)).catch(() => null);
  const items = buildMediaPool(project, collection?.items || [], history)
    .filter((item) => (item.kind === 'video' ? history.has(item.assetId) : Boolean(resolveGalleryImage(item.assetId))))
    // A partner that is gone is not offered, so "Use … + its still|clip" always works.
    .map((item) => (item.clipIds ? { ...item, clipIds: item.clipIds.filter((id) => history.has(id)) }
      : item.sourceImageId && !resolveGalleryImage(item.sourceImageId) ? { ...item, sourceImageId: null } : item));
  return { collectionId: collection?.id || null, items };
}

/**
 * File every still and clip of another video's pool (an earlier draft of the
 * same song) into `project`'s collection, so its Assets page and stats outro
 * count them. References only: no file is copied, the other video is not
 * changed, and its clips keep their own provenance stamp. Resolves
 * `{ added, total }`: how many were new here, of the other video's pool.
 */
export async function importMusicVideoPool(project, fromProject) {
  const [{ findOrCreateMusicVideoCollection, bulkUpdateCollectionItems }, { items }] = await Promise.all([
    import('../mediaCollections.js'), getMusicVideoMediaPool(fromProject),
  ]);
  const collection = await findOrCreateMusicVideoCollection({ projectId: project.id, projectName: project.name });
  const present = new Set([...collection.items.map((item) => `${item.kind}:${item.ref}`),
    ...projectTakeAssets(project).map((asset) => `${asset.kind}:${asset.ref}`)]);
  const add = items.filter((item) => !present.has(`${item.kind}:${item.assetId}`)
    && !item.assetId.includes(':') && !item.assetId.includes('/'))
    .map((item) => ({ kind: item.kind, ref: item.assetId }));
  if (add.length) await bulkUpdateCollectionItems(collection.id, { add });
  console.log(`🗂️ music-video media pool: filed ${add.length} of ${items.length} item(s) from ${fromProject.id} into ${project.id}`);
  return { added: add.length, total: items.length };
}

const LIBRARY_MATCH_MAX = 300;

/**
 * Stills and clips in the whole media library whose prompts hold every word of
 * `query` and that are not in `project`'s pool yet: media made for the video
 * but never filed (rendered before renders named their video). Newest first,
 * at most 300: `{ items: [{ kind, assetId, prompt, createdAt }], more }`.
 */
export async function searchMediaLibraryForPool(project, query) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { items: [], more: false };
  const [{ items: pool }, { readHistorySnapshot }] = await Promise.all([
    getMusicVideoMediaPool(project), import('../videoGen/history.js'),
  ]);
  const imagesInPool = new Set(pool.filter(item => item.kind === 'image').map(item => item.assetId));
  const videosInPool = new Set(pool.filter(item => item.kind === 'video').map(item => item.assetId));
  const matches = (prompt) => {
    if (typeof prompt !== 'string') return false;
    const text = prompt.toLowerCase();
    return words.every(word => text.includes(word));
  };
  const images = isFileBackend()
    ? (await (await import('../imageGen/local.js')).listGallery())
      .filter(image => matches(image.prompt) && !imagesInPool.has(image.filename))
      .map(image => ({ ref: image.filename, prompt: image.prompt, createdAt: image.createdAt }))
    : await (await import('../mediaAssetIndex/db.js')).searchImagePrompts(words, LIBRARY_MATCH_MAX + 1, [...imagesInPool]);
  const found = [
    ...images.map(image => ({ kind: 'image', assetId: image.ref, prompt: image.prompt, createdAt: image.createdAt || null })),
    ...(await readHistorySnapshot()).filter((entry) => entry?.id && matches(entry.prompt) && !videosInPool.has(entry.id))
      .map((entry) => ({ kind: 'video', assetId: entry.id, prompt: entry.prompt, createdAt: entry.createdAt || null })),
  ].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)
    || compareLibraryMatches(a, b));
  return { items: found.slice(0, LIBRARY_MATCH_MAX), more: found.length > LIBRARY_MATCH_MAX };
}

// Match the SQL image tie-breaker so limiting before the merge keeps the same page.
function compareLibraryMatches(a, b) {
  if (a.kind !== b.kind) return a.kind === 'image' ? -1 : 1;
  return Buffer.compare(Buffer.from(String(a.assetId)), Buffer.from(String(b.assetId)));
}

/**
 * File stills and clips from the media library into `project`'s collection
 * (the Assets page's "Add from the library"). Only files the library holds;
 * a clip keeps whatever provenance stamp it has. Resolves `{ added }`.
 */
export async function addLibraryMediaToPool(project, items) {
  const [{ findOrCreateMusicVideoCollection, bulkUpdateCollectionItems }, { resolveGalleryImage }, { getHistoryItem }] = await Promise.all([
    import('../mediaCollections.js'), import('../../lib/pathSafety.js'), import('../videoGen/history.js'),
  ]);
  for (const { kind, assetId } of items) {
    const exists = kind === 'image' ? resolveGalleryImage(assetId) : await getHistoryItem(assetId);
    if (!exists) throw new ServerError(`${kind === 'image' ? 'Image' : 'Video'} not found in this install's media library`, { status: 400, code: 'TAKE_ASSET_NOT_FOUND' });
  }
  const collection = await findOrCreateMusicVideoCollection({ projectId: project.id, projectName: project.name });
  const present = new Set(collection.items.map((item) => `${item.kind}:${item.ref}`));
  const add = [...new Map(items.filter(({ kind, assetId }) => !present.has(`${kind}:${assetId}`))
    .map(({ kind, assetId }) => [`${kind}:${assetId}`, { kind, ref: assetId }])).values()];
  if (add.length) await bulkUpdateCollectionItems(collection.id, { add });
  return { added: add.length };
}

/**
 * The pool items (`{ kind, assetId }`) whose prompts hold every word of `query`, case-insensitively:
 * the take's prompt, the prompt saved beside a still (its image sidecar) and a clip's history prompt.
 * Swap searches here because a still on the floor has no take left to carry its prompt.
 */
export async function searchMusicVideoMediaPool(project, query) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const [{ items }, { loadHistory }, { readImageSidecar }] = await Promise.all([
    getMusicVideoMediaPool(project), import('../videoGen/history.js'), import('../imageGen/local.js'),
  ]);
  const history = new Map((await loadHistory()).filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  const sidecarPrompt = (assetId) => readImageSidecar(assetId)
    .then(({ metadata }) => (typeof metadata?.prompt === 'string' ? metadata.prompt : '')).catch(() => '');
  const texts = await Promise.all(items.map(async (item) => [item.prompt || '',
    item.kind === 'video' ? history.get(item.assetId)?.prompt || '' : await sidecarPrompt(item.assetId)].join('\n').toLowerCase()));
  return items.filter((_, index) => words.every((word) => texts[index].includes(word)))
    .map(({ kind, assetId }) => ({ kind, assetId }));
}
