/**
 * Music Video scene takes (#8965) — pure record transforms.
 *
 * A scene slot (`referenceImageId` for the still, `videoHistoryId` for the
 * clip) used to hold only the newest render: every completion overwrote it, so
 * an earlier render the director preferred was lost, and two out-of-order jobs
 * could replace a frame the director had already approved. Now every asset
 * offered for a slot becomes an immutable take in `scene.takes`, and the slot
 * field is the director's explicit SELECTION of one of them:
 *
 *   - a completed/imported asset is APPENDED as a candidate and only fills the
 *     slot while the slot is empty (initial generation) — it never replaces a
 *     selection;
 *   - selecting a take is an explicit action (`selectSceneTake`);
 *   - rejecting the selected take clears the slot, so the next completion (or
 *     "Generate missing") fills it — selective regeneration.
 *
 * The slot fields keep their names so render.js, the peer-sync asset manifest
 * and older records read the selection unchanged. Pre-#8965 scenes carry no
 * `takes`; `ensureSceneTakes` materializes their selected asset as a `legacy`
 * take the first time a take operation touches the scene (no record rewrite).
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';

export const TAKE_SLOT = Object.freeze({ image: 'referenceImageId', video: 'videoHistoryId' });

// Per-scene cap. Takes are small pointer records, but an unattended "regenerate
// until it looks right" loop must not grow one project row without bound. When
// full, the oldest rejected take is dropped first, then the oldest unselected
// candidate; a selected take is never pruned.
export const MAX_SCENE_TAKES = 60;

// Optional provenance text: bounded, and null (not '') when absent.
const clip = (v, max) => (isNonBlankStr(v) ? trimTo(v, max) : null);

// A basename only — an imported file's name is provenance, never a path.
const takeOriginalName = (name) => (isNonBlankStr(name) ? clip(name.split(/[\\/]/).pop(), 200) : null);

function buildTake({ kind, assetId, source, provider = null, jobId = null, prompt = null, sourceImageId = null, originalName = null, shotInstruction = null, use = 'final', now }) {
  return {
    takeId: `mvt-${randomUUID()}`,
    kind,
    assetId,
    source,
    provider: clip(provider, 40),
    jobId: clip(jobId, 128),
    prompt: clip(prompt, 2000),
    sourceImageId: clip(sourceImageId, 256),
    originalName: takeOriginalName(originalName),
    status: 'candidate',
    // #8980 — 'motion-reference' scaffolding never fills the slot on its own.
    use: use === 'motion-reference' ? 'motion-reference' : 'final',
    note: null,
    createdAt: now,
    // #8977: the immutable record of what a performance take was generated
    // against (audio revision, song interval, edit in/out, cues, capability).
    // Present only on takes that carry one, so other takes keep their shape.
    ...(shotInstruction && typeof shotInstruction === 'object' ? { shotInstruction: structuredClone(shotInstruction) } : {}),
  };
}

/**
 * The scene's takes, with any selected slot asset that has no take yet
 * materialized as a take — `legacy` for a pre-#8965 record, `manual` for a slot
 * set through the plain scene PATCH. Returns the same array when nothing needed
 * adding.
 */
export function ensureSceneTakes(scene, now = new Date().toISOString(), source = 'legacy') {
  const takes = Array.isArray(scene?.takes) ? scene.takes : [];
  const added = [];
  for (const [kind, field] of Object.entries(TAKE_SLOT)) {
    const assetId = scene?.[field];
    if (!isNonBlankStr(assetId)) continue;
    if (takes.some((t) => t?.kind === kind && t.assetId === assetId)) continue;
    added.push(buildTake({ kind, assetId, source, now }));
  }
  return added.length ? [...takes, ...added] : takes;
}

// Drop the oldest prunable take until the list fits the cap.
function pruneTakes(takes, scene) {
  if (takes.length <= MAX_SCENE_TAKES) return takes;
  const selected = new Set(Object.entries(TAKE_SLOT)
    .map(([kind, field]) => (isNonBlankStr(scene[field]) ? `${kind}:${scene[field]}` : null))
    .filter(Boolean));
  const next = takes.slice();
  for (const wanted of ['rejected', 'candidate']) {
    for (let i = 0; i < next.length && next.length > MAX_SCENE_TAKES;) {
      const t = next[i];
      if (t.status === wanted && !selected.has(`${t.kind}:${t.assetId}`)) next.splice(i, 1);
      else i += 1;
    }
  }
  return next;
}

function findSceneIndex(project, sceneId) {
  const idx = (project.scenes || []).findIndex((s) => s.sceneId === sceneId);
  if (idx < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  return idx;
}

function replaceScene(project, idx, scene) {
  const scenes = project.scenes.slice();
  scenes[idx] = scene;
  return { ...project, scenes, updatedAt: new Date().toISOString() };
}

/**
 * Append candidate takes to one scene. Idempotent per asset: an asset already
 * present as a take of that kind is not duplicated (a replayed job completion
 * or a re-import is a no-op for the list). A slot is filled only while it is
 * empty, by the first appended take of that kind; an existing selection is
 * never replaced, and a motion-reference take (#8980) never fills a slot — it
 * becomes final picture only by an explicit select. Returns `{ scene, appended }` — `appended` lists the take
 * for every input, whether newly created or already present.
 */
function appendToScene(scene, inputs, now) {
  let takes = ensureSceneTakes(scene, now);
  const next = { ...scene };
  const appended = [];
  for (const input of inputs) {
    const existing = takes.find((t) => t.kind === input.kind && t.assetId === input.assetId);
    const take = existing || buildTake({ ...input, now });
    if (!existing) takes = [...takes, take];
    appended.push(take);
    const field = TAKE_SLOT[input.kind];
    if (!isNonBlankStr(next[field]) && take.status !== 'rejected' && take.use !== 'motion-reference') next[field] = take.assetId;
  }
  next.takes = pruneTakes(takes, next);
  return { scene: next, appended };
}

/** Append takes to one scene. Throws 404 for a deleted/unknown scene. */
export function appendSceneTakes(project, sceneId, inputs) {
  const idx = findSceneIndex(project, sceneId);
  const { scene, appended } = appendToScene(project.scenes[idx], inputs, new Date().toISOString());
  return { project: replaceScene(project, idx, scene), scene, appended };
}

/**
 * Append takes across scenes in one record write (a handoff import). `items`
 * are `{ sceneId, ...takeInput }`; every sceneId must exist or the whole batch
 * is refused, so a partially applied import can't strand half a handoff.
 */
export function appendTakesAcrossScenes(project, items) {
  const bySceneId = new Map();
  items.forEach((item, index) => {
    findSceneIndex(project, item.sceneId);
    const list = bySceneId.get(item.sceneId) || [];
    list.push({ item, index });
    bySceneId.set(item.sceneId, list);
  });
  const now = new Date().toISOString();
  // Reported in INPUT order, so a caller can pair each result with its item.
  const appended = new Array(items.length);
  const scenes = project.scenes.map((scene) => {
    const entries = bySceneId.get(scene.sceneId);
    if (!entries) return scene;
    const result = appendToScene(scene, entries.map((e) => e.item), now);
    entries.forEach((e, i) => { appended[e.index] = { sceneId: scene.sceneId, take: result.appended[i] }; });
    return result.scene;
  });
  return { project: { ...project, scenes, updatedAt: now }, appended };
}

function locateTake(project, sceneId, takeId) {
  const idx = findSceneIndex(project, sceneId);
  const scene = project.scenes[idx];
  const takes = ensureSceneTakes(scene);
  const take = takes.find((t) => t.takeId === takeId);
  if (!take) throw new ServerError('Take not found', { status: 404, code: 'NOT_FOUND' });
  return { idx, scene, takes, take };
}

/** Explicitly select a take for its slot. Selecting a rejected take restores it. */
export function selectSceneTake(project, sceneId, takeId) {
  const { idx, scene, takes, take } = locateTake(project, sceneId, takeId);
  const nextTakes = takes.map((t) => (t.takeId === takeId && t.status === 'rejected' ? { ...t, status: 'candidate' } : t));
  const next = { ...scene, takes: nextTakes, [TAKE_SLOT[take.kind]]: take.assetId };
  return { project: replaceScene(project, idx, next), scene: next };
}

/**
 * Reject/restore a take and/or set its review note. Rejecting the SELECTED take
 * clears the slot so the scene reads as "needs a take" again.
 */
export function reviewSceneTake(project, sceneId, takeId, { status, note }) {
  const { idx, scene, takes, take } = locateTake(project, sceneId, takeId);
  const updated = {
    ...take,
    ...(status !== undefined ? { status } : {}),
    ...(note !== undefined ? { note: note && note.trim() ? note.trim().slice(0, 1000) : null } : {}),
  };
  const field = TAKE_SLOT[take.kind];
  const next = {
    ...scene,
    takes: takes.map((t) => (t.takeId === takeId ? updated : t)),
    ...(updated.status === 'rejected' && scene[field] === take.assetId ? { [field]: null } : {}),
  };
  return { project: replaceScene(project, idx, next), scene: next };
}
