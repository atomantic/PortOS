/**
 * Writers Room — editable recurring-objects bible.
 *
 * Per-work canonical roster stored at data/writers-room/works/<workId>/
 * objects.json. Shape + extraction-merge live in `server/lib/storyBible.js`;
 * this module owns CRUD, file I/O, and the writers-room id prefix
 * (`wr-object-`).
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, ensureDir, readJSONFile } from '../../lib/fileUtils.js';
import {
  sanitizeObject,
  sanitizeBibleList,
  mergeExtractedBible,
  normalizeBibleName,
} from '../../lib/storyBible.js';
import { nowIso, badRequest, notFound, assertValidWorkId } from './_shared.js';

const OBJECT_ID_RE = /^wr-object-[0-9a-f-]+$/i;
const ID_PREFIX = 'wr-object-';

const root = () => join(PATHS.data, 'writers-room');
const objectsFile = (workId) => {
  assertValidWorkId(workId);
  return join(root(), 'works', workId, 'objects.json');
};

const EDITABLE_FIELDS = ['name', 'aliases', 'description', 'significance', 'notes'];

async function loadFile(workId) {
  const fallback = { objects: [], updatedAt: null };
  const parsed = await readJSONFile(objectsFile(workId), fallback);
  if (!parsed || !Array.isArray(parsed.objects)) return fallback;
  return { ...parsed, objects: sanitizeBibleList(parsed.objects, 'object', { idPrefix: ID_PREFIX }) };
}

async function saveFile(workId, state) {
  assertValidWorkId(workId);
  await ensureDir(join(root(), 'works', workId));
  await atomicWrite(objectsFile(workId), { ...state, updatedAt: nowIso() });
}

export async function listObjects(workId) {
  const state = await loadFile(workId);
  return state.objects.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function getObject(workId, objectId) {
  if (!OBJECT_ID_RE.test(objectId)) throw badRequest('Invalid object id');
  const state = await loadFile(workId);
  const found = state.objects.find((o) => o.id === objectId);
  if (!found) throw notFound('Object');
  return found;
}

export async function createObject(workId, patch = {}) {
  const name = String(patch.name || '').trim();
  if (!name) throw badRequest('Object name required');
  const state = await loadFile(workId);
  if (state.objects.some((o) => normalizeBibleName(o.name) === normalizeBibleName(name))) {
    throw badRequest(`An object named "${name}" already exists`);
  }
  const draft = { id: `${ID_PREFIX}${randomUUID()}`, name, source: 'user' };
  for (const field of EDITABLE_FIELDS) {
    if (field === 'name') continue;
    if (patch[field] !== undefined) draft[field] = patch[field];
  }
  const profile = sanitizeObject(draft, { idPrefix: ID_PREFIX, preserveTimestamps: false });
  state.objects.push(profile);
  await saveFile(workId, state);
  return profile;
}

export async function updateObject(workId, objectId, patch = {}) {
  if (!OBJECT_ID_RE.test(objectId)) throw badRequest('Invalid object id');
  const state = await loadFile(workId);
  const idx = state.objects.findIndex((o) => o.id === objectId);
  if (idx < 0) throw notFound('Object');
  const next = { ...state.objects[idx] };
  for (const field of EDITABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    if (field === 'name') {
      const newName = String(patch.name || '').trim();
      if (!newName) throw badRequest('Object name cannot be blank');
      const conflict = state.objects.some((o) => o.id !== objectId && normalizeBibleName(o.name) === normalizeBibleName(newName));
      if (conflict) throw badRequest(`An object named "${newName}" already exists`);
      next.name = newName;
    } else {
      next[field] = patch[field];
    }
  }
  next.source = 'user';
  state.objects[idx] = sanitizeObject(
    { ...next, updatedAt: nowIso() },
    { idPrefix: ID_PREFIX, preserveTimestamps: true },
  );
  await saveFile(workId, state);
  return state.objects[idx];
}

export async function deleteObject(workId, objectId) {
  if (!OBJECT_ID_RE.test(objectId)) throw badRequest('Invalid object id');
  const state = await loadFile(workId);
  const before = state.objects.length;
  state.objects = state.objects.filter((o) => o.id !== objectId);
  if (state.objects.length === before) throw notFound('Object');
  await saveFile(workId, state);
  return { ok: true };
}

export async function mergeExtractedObjects(workId, extracted) {
  if (!Array.isArray(extracted)) return listObjects(workId);
  const state = await loadFile(workId);
  state.objects = mergeExtractedBible(state.objects, extracted, 'object', { idPrefix: ID_PREFIX });
  await saveFile(workId, state);
  return state.objects;
}
