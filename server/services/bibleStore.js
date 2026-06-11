/**
 * bibleStore — per-work CRUD + merge factory for the writers-room bible
 * (characters / places / objects).
 *
 * Extracted from server/lib/storyBible.js (issue #1154) so the lib stays a
 * pure catalog of sanitizers/transformers and the storage factory (which does
 * file I/O under data/writers-room/works/) lives in the services layer.
 * storyBible.js re-exports `createBibleStore` from here so existing
 * `import { createBibleStore } from '../../lib/storyBible.js'` call sites
 * (characters.js / places.js / objects.js) keep working.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import { PATHS, atomicWrite, ensureDir, readJSONFile } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import {
  SANITIZERS,
  sortKey,
  nowIso,
  sanitizeBibleList,
  mergeExtractedBible,
} from '../lib/storyBible.js';

const WORK_ID_RE = /^wr-work-[0-9a-f-]+$/i;
const ID_SUFFIX_RE = /^[0-9a-f-]+$/i;
const FILE_NAME = Object.freeze({ character: 'characters.json', place: 'places.json', object: 'objects.json' });
const LIST_KEY = Object.freeze({ character: 'characters', place: 'places', object: 'objects' });
const badReq = (message) => new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
const notFoundErr = (what) => new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });
const wrDir = (workId) => {
  if (typeof workId !== 'string' || !WORK_ID_RE.test(workId)) throw badReq('Invalid work id');
  return join(PATHS.data, 'writers-room', 'works', workId);
};

export function createBibleStore(opts) {
  const {
    kind, idPrefix, dedupKey, primaryFields,
    editableFields, requireOnCreate, validateAfterUpdate, conflictMessage,
    notFoundLabel, invalidIdMessage,
  } = opts;
  const sanitizer = SANITIZERS[kind];
  const fileName = FILE_NAME[kind];
  const listKey = LIST_KEY[kind];
  if (!sanitizer || !fileName) throw new Error(`createBibleStore: unknown kind "${kind}"`);
  const sortKeyFn = sortKey(kind);
  const filePath = (workId) => join(wrDir(workId), fileName);
  const assertId = (id) => {
    if (typeof id !== 'string' || !id.startsWith(idPrefix) || !ID_SUFFIX_RE.test(id.slice(idPrefix.length))) {
      throw badReq(invalidIdMessage);
    }
  };

  async function load(workId) {
    const fallback = { [listKey]: [], updatedAt: null };
    const parsed = await readJSONFile(filePath(workId), fallback);
    if (!parsed || !Array.isArray(parsed[listKey])) return fallback;
    return { ...parsed, [listKey]: sanitizeBibleList(parsed[listKey], kind, { idPrefix }) };
  }

  async function save(workId, state) {
    await ensureDir(wrDir(workId));
    await atomicWrite(filePath(workId), { ...state, updatedAt: nowIso() });
  }

  async function list(workId) {
    const state = await load(workId);
    return state[listKey].sort((a, b) => sortKeyFn(a).localeCompare(sortKeyFn(b)));
  }

  async function get(workId, entryId) {
    assertId(entryId);
    const state = await load(workId);
    const found = state[listKey].find((e) => e.id === entryId);
    if (!found) throw notFoundErr(notFoundLabel);
    return found;
  }

  async function create(workId, patch = {}) {
    const requireErr = requireOnCreate(patch);
    if (requireErr) throw badReq(requireErr);
    const state = await load(workId);
    const keyOfPatch = dedupKey(patch);
    if (keyOfPatch && state[listKey].some((e) => dedupKey(e) === keyOfPatch)) {
      throw badReq(conflictMessage(patch));
    }
    const draft = { id: `${idPrefix}${randomUUID()}`, source: 'user' };
    for (const field of primaryFields) {
      if (patch[field] !== undefined) draft[field] = String(patch[field] || '').trim();
    }
    for (const field of editableFields) {
      if (patch[field] !== undefined) draft[field] = patch[field];
    }
    // Places: if both name and slugline are primary, missing name + present
    // slugline → mirror slugline → name (preserves old createPlace behavior).
    if (primaryFields.includes('name') && primaryFields.includes('slugline') && !draft.name && draft.slugline) {
      draft.name = draft.slugline;
    }
    const profile = sanitizer(draft, { idPrefix, preserveTimestamps: false });
    state[listKey].push(profile);
    await save(workId, state);
    return profile;
  }

  async function update(workId, entryId, patch = {}) {
    assertId(entryId);
    const state = await load(workId);
    const idx = state[listKey].findIndex((e) => e.id === entryId);
    if (idx < 0) throw notFoundErr(notFoundLabel);
    const next = { ...state[listKey][idx] };
    // Primary fields: single-primary kinds reject blank; multi-primary
    // places allow blanks here and rely on validateAfterUpdate for the
    // combined-blank invariant.
    for (const field of primaryFields) {
      if (patch[field] === undefined) continue;
      const newVal = String(patch[field] || '').trim();
      if (primaryFields.length === 1 && !newVal) {
        throw badReq(`${notFoundLabel} ${field} cannot be blank`);
      }
      if (newVal) {
        const newKey = dedupKey({ ...next, [field]: newVal });
        if (newKey && state[listKey].some((e) => e.id !== entryId && dedupKey(e) === newKey)) {
          throw badReq(conflictMessage({ [field]: newVal }));
        }
      }
      next[field] = newVal;
    }
    for (const field of editableFields) {
      if (patch[field] !== undefined) next[field] = patch[field];
    }
    if (validateAfterUpdate) validateAfterUpdate(next);
    next.source = 'user';
    state[listKey][idx] = sanitizer({ ...next, updatedAt: nowIso() }, { idPrefix, preserveTimestamps: true });
    await save(workId, state);
    return state[listKey][idx];
  }

  async function remove(workId, entryId) {
    assertId(entryId);
    const state = await load(workId);
    const before = state[listKey].length;
    state[listKey] = state[listKey].filter((e) => e.id !== entryId);
    if (state[listKey].length === before) throw notFoundErr(notFoundLabel);
    await save(workId, state);
    return { ok: true };
  }

  async function mergeExtracted(workId, extracted) {
    if (!Array.isArray(extracted)) return list(workId);
    const state = await load(workId);
    state[listKey] = mergeExtractedBible(state[listKey], extracted, kind, { idPrefix });
    await save(workId, state);
    return state[listKey];
  }

  return { list, get, create, update, remove, mergeExtracted };
}
