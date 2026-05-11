/**
 * Writers Room — editable character profile bible.
 *
 * Per-work canonical roster stored at data/writers-room/works/<workId>/
 * characters.json. Distinct from the immutable analysis snapshots — the
 * snapshot is history; this file is the working bible that survives across
 * runs and accepts hand-edits.
 *
 * Shape + extraction-merge live in `server/lib/storyBible.js`; this module
 * owns CRUD, file I/O, and the writers-room id prefix (`wr-char-`).
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, ensureDir, readJSONFile } from '../../lib/fileUtils.js';
import {
  sanitizeCharacter,
  sanitizeBibleList,
  mergeExtractedBible,
  normalizeBibleName,
} from '../../lib/storyBible.js';
import { nowIso, badRequest, notFound, assertValidWorkId } from './_shared.js';

const CHAR_ID_RE = /^wr-char-[0-9a-f-]+$/i;
const ID_PREFIX = 'wr-char-';

const root = () => join(PATHS.data, 'writers-room');
const charsFile = (workId) => {
  // Defense-in-depth: routes validate the URL parameter, but this module is
  // also imported directly (mergeExtractedCharacters from the analysis
  // pipeline). Refusing path-traversal-shaped ids here makes workId-as-fs-
  // path safe regardless of caller.
  assertValidWorkId(workId);
  return join(root(), 'works', workId, 'characters.json');
};

const EDITABLE_FIELDS = ['name', 'aliases', 'role', 'physicalDescription', 'personality', 'background', 'notes'];

async function loadFile(workId) {
  const fallback = { characters: [], updatedAt: null };
  const parsed = await readJSONFile(charsFile(workId), fallback);
  if (!parsed || !Array.isArray(parsed.characters)) return fallback;
  return { ...parsed, characters: sanitizeBibleList(parsed.characters, 'character', { idPrefix: ID_PREFIX }) };
}

async function saveFile(workId, state) {
  assertValidWorkId(workId);
  await ensureDir(join(root(), 'works', workId));
  await atomicWrite(charsFile(workId), { ...state, updatedAt: nowIso() });
}

export async function listCharacters(workId) {
  const state = await loadFile(workId);
  return state.characters.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

export async function getCharacter(workId, characterId) {
  if (!CHAR_ID_RE.test(characterId)) throw badRequest('Invalid character id');
  const state = await loadFile(workId);
  const found = state.characters.find((c) => c.id === characterId);
  if (!found) throw notFound('Character');
  return found;
}

export async function createCharacter(workId, patch = {}) {
  const name = String(patch.name || '').trim();
  if (!name) throw badRequest('Character name required');
  const state = await loadFile(workId);
  if (state.characters.some((c) => normalizeBibleName(c.name) === normalizeBibleName(name))) {
    throw badRequest(`A character named "${name}" already exists`);
  }
  // Merge user-supplied editable fields into the canonical empty profile,
  // then route through the shared sanitizer so caps/array-cleanup apply.
  const draft = { id: `${ID_PREFIX}${randomUUID()}`, name, source: 'user' };
  for (const field of EDITABLE_FIELDS) {
    if (field === 'name') continue;
    if (patch[field] !== undefined) draft[field] = patch[field];
  }
  const profile = sanitizeCharacter(draft, { idPrefix: ID_PREFIX, preserveTimestamps: false });
  state.characters.push(profile);
  await saveFile(workId, state);
  return profile;
}

export async function updateCharacter(workId, characterId, patch = {}) {
  if (!CHAR_ID_RE.test(characterId)) throw badRequest('Invalid character id');
  const state = await loadFile(workId);
  const idx = state.characters.findIndex((c) => c.id === characterId);
  if (idx < 0) throw notFound('Character');
  const next = { ...state.characters[idx] };
  for (const field of EDITABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    if (field === 'name') {
      const newName = String(patch.name || '').trim();
      if (!newName) throw badRequest('Character name cannot be blank');
      const conflict = state.characters.some((c) => c.id !== characterId && normalizeBibleName(c.name) === normalizeBibleName(newName));
      if (conflict) throw badRequest(`A character named "${newName}" already exists`);
      next.name = newName;
    } else {
      next[field] = patch[field];
    }
  }
  next.source = 'user';
  // Re-sanitize so freshly-supplied fields get capped/cleaned consistently.
  state.characters[idx] = sanitizeCharacter(
    { ...next, updatedAt: nowIso() },
    { idPrefix: ID_PREFIX, preserveTimestamps: true },
  );
  await saveFile(workId, state);
  return state.characters[idx];
}

export async function deleteCharacter(workId, characterId) {
  if (!CHAR_ID_RE.test(characterId)) throw badRequest('Invalid character id');
  const state = await loadFile(workId);
  const before = state.characters.length;
  state.characters = state.characters.filter((c) => c.id !== characterId);
  if (state.characters.length === before) throw notFound('Character');
  await saveFile(workId, state);
  return { ok: true };
}

/**
 * Merge an AI-extracted character set into the editable bible. Delegates
 * to `mergeExtractedBible` so the writers-room and pipeline-side merges
 * follow byte-identical rules.
 */
export async function mergeExtractedCharacters(workId, extracted) {
  if (!Array.isArray(extracted)) return listCharacters(workId);
  const state = await loadFile(workId);
  state.characters = mergeExtractedBible(state.characters, extracted, 'character', { idPrefix: ID_PREFIX });
  await saveFile(workId, state);
  return state.characters;
}
