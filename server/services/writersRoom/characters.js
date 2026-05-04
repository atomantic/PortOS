/**
 * Writers Room — editable character profile bible.
 *
 * Canonical, user-editable character roster per work, stored at
 * data/writers-room/works/<workId>/characters.json. Distinct from analysis
 * snapshots: the snapshot in data/.../analysis/ is immutable history; this
 * file is the working bible that survives across analysis runs and can be
 * hand-edited by the writer.
 *
 * Merge rule: a re-run of `characters` analysis fills empty fields and adds
 * new characters, but never overwrites a non-empty field on an existing
 * profile. The writer's edits are authoritative.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, ensureDir, readJSONFile } from '../../lib/fileUtils.js';
import { nowIso, badRequest, notFound, assertValidWorkId } from './_shared.js';

const CHAR_ID_RE = /^wr-char-[0-9a-f-]+$/i;

const root = () => join(PATHS.data, 'writers-room');
const charsFile = (workId) => {
  // Defense-in-depth: the route layer validates the URL parameter, but this
  // module is also imported directly (e.g. by mergeExtractedCharacters from
  // the analysis pipeline). Refusing path-traversal-shaped ids here makes
  // workId-as-filesystem-path safe regardless of caller.
  assertValidWorkId(workId);
  return join(root(), 'works', workId, 'characters.json');
};

const EDITABLE_FIELDS = ['name', 'aliases', 'role', 'physicalDescription', 'personality', 'background', 'notes'];

function emptyProfile() {
  return {
    id: '',
    name: '',
    aliases: [],
    role: '',
    physicalDescription: '',
    personality: '',
    background: '',
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
  const fallback = { characters: [], updatedAt: null };
  const parsed = await readJSONFile(charsFile(workId), fallback);
  return parsed && Array.isArray(parsed.characters) ? parsed : fallback;
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
  if (state.characters.some((c) => normalizeName(c.name) === normalizeName(name))) {
    throw badRequest(`A character named "${name}" already exists`);
  }
  const profile = {
    ...emptyProfile(),
    id: `wr-char-${randomUUID()}`,
    name,
    source: 'user',
  };
  for (const field of EDITABLE_FIELDS) {
    if (field === 'name') continue;
    if (patch[field] !== undefined) profile[field] = patch[field];
  }
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
      const conflict = state.characters.some((c) => c.id !== characterId && normalizeName(c.name) === normalizeName(newName));
      if (conflict) throw badRequest(`A character named "${newName}" already exists`);
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
  state.characters[idx] = next;
  await saveFile(workId, state);
  return next;
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
 * Merge an AI-extracted character set into the editable bible.
 * - Existing characters (matched by case-insensitive name OR by an alias)
 *   keep every non-blank field. Only blank fields get filled from `extracted`.
 * - New characters are inserted with `source: 'ai'`.
 * - `firstAppearance`, `evidence`, and `missingFromProse` always reflect the
 *   latest analysis (they're prose-derived, not user-curated).
 *
 * Returns the merged character list.
 */
export async function mergeExtractedCharacters(workId, extracted) {
  if (!Array.isArray(extracted)) return listCharacters(workId);
  const state = await loadFile(workId);
  const byKey = new Map();
  // Index every character by its name AND every alias so a later batch entry
  // referencing the same person via any of those tokens resolves to one
  // canonical profile (no duplicates).
  const indexCharacter = (c) => {
    const nameKey = normalizeName(c.name);
    if (nameKey) byKey.set(nameKey, c);
    for (const alias of c.aliases || []) {
      const aliasKey = normalizeName(alias);
      if (aliasKey) byKey.set(aliasKey, c);
    }
  };
  for (const c of state.characters) indexCharacter(c);
  for (const incoming of extracted) {
    if (!incoming || !incoming.name) continue;
    const key = normalizeName(incoming.name);
    const existing = byKey.get(key);
    if (existing) {
      // Fill in only blank user-editable fields. Prose-derived metadata
      // (firstAppearance / evidence / missingFromProse) always refreshes.
      for (const field of ['role', 'physicalDescription', 'personality', 'background']) {
        if (isBlank(existing[field]) && !isBlank(incoming[field])) {
          existing[field] = incoming[field];
        }
      }
      if (isBlank(existing.aliases) && Array.isArray(incoming.aliases)) {
        existing.aliases = incoming.aliases.map((a) => String(a).trim()).filter(Boolean);
        // Re-index this character under its newly-filled aliases so later
        // entries in the same batch that reference the character via one of
        // those aliases resolve to this profile instead of being inserted
        // as a duplicate.
        indexCharacter(existing);
      }
      existing.firstAppearance = incoming.firstAppearance ?? existing.firstAppearance ?? null;
      existing.evidence = Array.isArray(incoming.evidence) ? incoming.evidence : (existing.evidence || []);
      existing.missingFromProse = Array.isArray(incoming.missingFromProse) ? incoming.missingFromProse : [];
      existing.updatedAt = nowIso();
    } else {
      const profile = {
        ...emptyProfile(),
        id: `wr-char-${randomUUID()}`,
        name: String(incoming.name).trim(),
        aliases: Array.isArray(incoming.aliases) ? incoming.aliases.map((a) => String(a).trim()).filter(Boolean) : [],
        role: String(incoming.role || '').trim(),
        physicalDescription: String(incoming.physicalDescription || '').trim(),
        personality: String(incoming.personality || '').trim(),
        background: String(incoming.background || '').trim(),
        firstAppearance: incoming.firstAppearance ?? null,
        evidence: Array.isArray(incoming.evidence) ? incoming.evidence : [],
        missingFromProse: Array.isArray(incoming.missingFromProse) ? incoming.missingFromProse : [],
        source: 'ai',
      };
      state.characters.push(profile);
      // Index the new profile under both its name and any aliases so a
      // later entry in this batch that uses one of those aliases as its
      // `name` matches this character instead of creating a second one.
      indexCharacter(profile);
    }
  }
  await saveFile(workId, state);
  return state.characters.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}
