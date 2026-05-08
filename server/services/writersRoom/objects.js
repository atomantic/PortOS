/**
 * Writers Room — editable recurring-objects bible.
 *
 * Mirrors the characters/settings bible pattern (per-work canonical roster
 * stored at data/writers-room/works/<workId>/objects.json). Distinct from the
 * immutable analysis snapshot — the snapshot is history; this is the working
 * bible that survives across runs and accepts hand-edits.
 *
 * Merge rule: a re-run of `objects` analysis fills empty fields and adds new
 * objects, but never overwrites a non-empty field on an existing profile. The
 * writer's edits are authoritative.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, ensureDir, readJSONFile } from '../../lib/fileUtils.js';
import { nowIso, badRequest, notFound, assertValidWorkId } from './_shared.js';

const OBJECT_ID_RE = /^wr-object-[0-9a-f-]+$/i;

const root = () => join(PATHS.data, 'writers-room');
const objectsFile = (workId) => {
  assertValidWorkId(workId);
  return join(root(), 'works', workId, 'objects.json');
};

const EDITABLE_FIELDS = ['name', 'aliases', 'description', 'significance', 'notes'];

function emptyProfile() {
  return {
    id: '',
    name: '',
    aliases: [],
    description: '',
    significance: '',
    notes: '',
    firstAppearance: null,
    evidence: [],
    missingFromProse: [],
    source: 'user',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

function isBlank(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

async function loadFile(workId) {
  const fallback = { objects: [], updatedAt: null };
  const parsed = await readJSONFile(objectsFile(workId), fallback);
  return parsed && Array.isArray(parsed.objects) ? parsed : fallback;
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
  if (state.objects.some((o) => normalizeName(o.name) === normalizeName(name))) {
    throw badRequest(`An object named "${name}" already exists`);
  }
  const profile = {
    ...emptyProfile(),
    id: `wr-object-${randomUUID()}`,
    name,
    source: 'user',
  };
  for (const field of EDITABLE_FIELDS) {
    if (field === 'name') continue;
    if (patch[field] !== undefined) profile[field] = patch[field];
  }
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
      const conflict = state.objects.some((o) => o.id !== objectId && normalizeName(o.name) === normalizeName(newName));
      if (conflict) throw badRequest(`An object named "${newName}" already exists`);
      next.name = newName;
    } else if (field === 'aliases') {
      next.aliases = Array.isArray(patch.aliases)
        ? patch.aliases.map((a) => String(a).trim()).filter(Boolean)
        : [];
    } else {
      next[field] = patch[field];
    }
  }
  next.source = 'user';
  next.updatedAt = nowIso();
  state.objects[idx] = next;
  await saveFile(workId, state);
  return next;
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

/**
 * Merge an AI-extracted object set into the editable bible.
 * Mirrors the characters merge: existing entries (by case-insensitive name OR
 * alias) keep every non-blank field, only blanks fill from incoming. New
 * objects are inserted with source: 'ai'. firstAppearance/evidence/
 * missingFromProse always refresh from the latest analysis.
 */
export async function mergeExtractedObjects(workId, extracted) {
  if (!Array.isArray(extracted)) return listObjects(workId);
  const state = await loadFile(workId);
  const byKey = new Map();
  const indexObject = (o) => {
    const nameKey = normalizeName(o.name);
    if (nameKey) byKey.set(nameKey, o);
    for (const alias of o.aliases || []) {
      const aliasKey = normalizeName(alias);
      if (aliasKey) byKey.set(aliasKey, o);
    }
  };
  for (const o of state.objects) indexObject(o);
  for (const incoming of extracted) {
    if (!incoming || !incoming.name) continue;
    const key = normalizeName(incoming.name);
    const existing = byKey.get(key);
    if (existing) {
      for (const field of ['description', 'significance']) {
        if (isBlank(existing[field]) && !isBlank(incoming[field])) {
          existing[field] = incoming[field];
        }
      }
      if (isBlank(existing.aliases) && Array.isArray(incoming.aliases)) {
        existing.aliases = incoming.aliases.map((a) => String(a).trim()).filter(Boolean);
        indexObject(existing);
      }
      // firstAppearance is prose-derived metadata that the latest analysis
      // run is authoritative for: replace verbatim, including explicit null
      // (the object may no longer have a clear first scene after edits, and
      // pinning the stale value would mislead the bible).
      existing.firstAppearance = incoming.firstAppearance ?? null;
      existing.evidence = Array.isArray(incoming.evidence) ? incoming.evidence : (existing.evidence || []);
      existing.missingFromProse = Array.isArray(incoming.missingFromProse) ? incoming.missingFromProse : [];
      existing.updatedAt = nowIso();
    } else {
      const profile = {
        ...emptyProfile(),
        id: `wr-object-${randomUUID()}`,
        name: String(incoming.name).trim(),
        aliases: Array.isArray(incoming.aliases) ? incoming.aliases.map((a) => String(a).trim()).filter(Boolean) : [],
        description: String(incoming.description || '').trim(),
        significance: String(incoming.significance || '').trim(),
        firstAppearance: incoming.firstAppearance ?? null,
        evidence: Array.isArray(incoming.evidence) ? incoming.evidence : [],
        missingFromProse: Array.isArray(incoming.missingFromProse) ? incoming.missingFromProse : [],
        source: 'ai',
      };
      state.objects.push(profile);
      indexObject(profile);
    }
  }
  await saveFile(workId, state);
  return state.objects.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
