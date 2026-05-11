/**
 * Writers Room — editable setting/world bible.
 *
 * Per-location bible keyed by screenplay slugline so SceneCard can match a
 * scene's slugline to its canonical setting and inject the description into
 * the image prompt.
 *
 * Per-work file at data/writers-room/works/<workId>/settings.json. Shape +
 * extraction-merge live in `server/lib/storyBible.js`; this module owns
 * CRUD, file I/O, and the writers-room id prefix (`wr-setting-`).
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, ensureDir, readJSONFile } from '../../lib/fileUtils.js';
import { normalizeSlugline as canonicalNormalizeSlugline } from '../../lib/scenePrompt.js';
import {
  sanitizeSetting,
  sanitizeBibleList,
  mergeExtractedBible,
} from '../../lib/storyBible.js';
import { nowIso, badRequest, notFound, assertValidWorkId } from './_shared.js';

const SETTING_ID_RE = /^wr-setting-[0-9a-f-]+$/i;
const ID_PREFIX = 'wr-setting-';

const root = () => join(PATHS.data, 'writers-room');
const settingsFile = (workId) => {
  // Defense-in-depth: refuse path-traversal-shaped workIds before
  // interpolating them into the on-disk path.
  assertValidWorkId(workId);
  return join(root(), 'works', workId, 'settings.json');
};

// `name` + `slugline` handled separately (identifier rule + conflict check).
const EDITABLE_FIELDS = ['description', 'palette', 'era', 'weather', 'recurringDetails', 'notes'];

// Re-export under the historical name for the existing test + import surface.
// Canonical implementation in server/lib/scenePrompt.js.
export const normalizeSlugline = canonicalNormalizeSlugline;

async function loadFile(workId) {
  const fallback = { settings: [], updatedAt: null };
  const parsed = await readJSONFile(settingsFile(workId), fallback);
  if (!parsed || !Array.isArray(parsed.settings)) return fallback;
  return { ...parsed, settings: sanitizeBibleList(parsed.settings, 'setting', { idPrefix: ID_PREFIX }) };
}

async function saveFile(workId, state) {
  assertValidWorkId(workId);
  await ensureDir(join(root(), 'works', workId));
  await atomicWrite(settingsFile(workId), { ...state, updatedAt: nowIso() });
}

export async function listSettings(workId) {
  const state = await loadFile(workId);
  return state.settings.sort((a, b) => (a.slugline || a.name || '').localeCompare(b.slugline || b.name || ''));
}

export async function getSetting(workId, settingId) {
  if (!SETTING_ID_RE.test(settingId)) throw badRequest('Invalid setting id');
  const state = await loadFile(workId);
  const found = state.settings.find((s) => s.id === settingId);
  if (!found) throw notFound('Setting');
  return found;
}

export async function createSetting(workId, patch = {}) {
  const slugline = String(patch.slugline || '').trim();
  const name = String(patch.name || '').trim();
  if (!slugline && !name) throw badRequest('Setting requires either a slugline or a name');
  const state = await loadFile(workId);
  const key = canonicalNormalizeSlugline(slugline || name);
  if (state.settings.some((s) => canonicalNormalizeSlugline(s.slugline || s.name) === key)) {
    throw badRequest(`A setting matching "${slugline || name}" already exists`);
  }
  const draft = {
    id: `${ID_PREFIX}${randomUUID()}`,
    slugline,
    name: name || slugline,
    source: 'user',
  };
  for (const field of EDITABLE_FIELDS) {
    if (patch[field] !== undefined) draft[field] = patch[field];
  }
  const profile = sanitizeSetting(draft, { idPrefix: ID_PREFIX, preserveTimestamps: false });
  state.settings.push(profile);
  await saveFile(workId, state);
  return profile;
}

export async function updateSetting(workId, settingId, patch = {}) {
  if (!SETTING_ID_RE.test(settingId)) throw badRequest('Invalid setting id');
  const state = await loadFile(workId);
  const idx = state.settings.findIndex((s) => s.id === settingId);
  if (idx < 0) throw notFound('Setting');
  const next = { ...state.settings[idx] };
  for (const field of ['slugline', 'name']) {
    if (patch[field] === undefined) continue;
    const newVal = String(patch[field] || '').trim();
    const key = canonicalNormalizeSlugline(newVal);
    if (key) {
      const conflict = state.settings.some((s) => s.id !== settingId && canonicalNormalizeSlugline(s.slugline || s.name) === key);
      if (conflict) throw badRequest(`A setting matching "${newVal}" already exists`);
    }
    next[field] = newVal;
  }
  for (const field of EDITABLE_FIELDS) {
    if (patch[field] !== undefined) next[field] = patch[field];
  }
  // A PATCH that blanks the only non-empty identifier (e.g. name-only
  // setting receiving `{ name: '' }`) would leave the setting unaddressable.
  if (!next.slugline && !next.name) {
    throw badRequest('Setting needs slugline or name');
  }
  next.source = 'user';
  state.settings[idx] = sanitizeSetting(
    { ...next, updatedAt: nowIso() },
    { idPrefix: ID_PREFIX, preserveTimestamps: true },
  );
  await saveFile(workId, state);
  return state.settings[idx];
}

export async function deleteSetting(workId, settingId) {
  if (!SETTING_ID_RE.test(settingId)) throw badRequest('Invalid setting id');
  const state = await loadFile(workId);
  const before = state.settings.length;
  state.settings = state.settings.filter((s) => s.id !== settingId);
  if (state.settings.length === before) throw notFound('Setting');
  await saveFile(workId, state);
  return { ok: true };
}

export async function mergeExtractedSettings(workId, extracted) {
  if (!Array.isArray(extracted)) return listSettings(workId);
  const state = await loadFile(workId);
  state.settings = mergeExtractedBible(state.settings, extracted, 'setting', { idPrefix: ID_PREFIX });
  await saveFile(workId, state);
  return state.settings;
}
