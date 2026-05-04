/**
 * Writers Room — editable setting/world bible.
 *
 * Per-location bible keyed by screenplay slugline (e.g. `INT. KITCHEN — NIGHT`)
 * so SceneCard can match a scene's slugline to its canonical setting and
 * inject the description into the image prompt.
 *
 * Stored at data/writers-room/works/<workId>/settings.json. Same merge rule
 * as characters: a re-run of `settings` analysis fills empty fields and adds
 * new locations, but never overwrites a non-empty field on an existing entry.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, ensureDir, readJSONFile } from '../../lib/fileUtils.js';
import { nowIso, badRequest, notFound } from './_shared.js';

const SETTING_ID_RE = /^wr-setting-[0-9a-f-]+$/i;

const root = () => join(PATHS.data, 'writers-room');
const settingsFile = (workId) => join(root(), 'works', workId, 'settings.json');

const EDITABLE_FIELDS = ['name', 'slugline', 'description', 'palette', 'era', 'weather', 'recurringDetails', 'notes'];

function emptySetting() {
  return {
    id: '',
    name: '',
    slugline: '',
    description: '',
    palette: '',
    era: '',
    weather: '',
    recurringDetails: '',
    notes: '',
    firstAppearance: null,
    evidence: [],
    missingFromProse: [],
    source: 'user',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

// Sluglines are matched case-insensitively with whitespace+punctuation
// collapsed so `INT. KITCHEN — NIGHT` and `INT KITCHEN - NIGHT` resolve to
// the same bible entry. Em-dashes vs hyphens vs spaces in user-edited prose
// would otherwise fragment a single location across multiple records.
export function normalizeSlugline(s) {
  return String(s || '')
    .toUpperCase()
    .replace(/[—–-]/g, ' ')
    .replace(/[.,:;]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBlank(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'string') return v.trim() === '';
  return false;
}

async function loadFile(workId) {
  const fallback = { settings: [], updatedAt: null };
  const parsed = await readJSONFile(settingsFile(workId), fallback);
  return parsed && Array.isArray(parsed.settings) ? parsed : fallback;
}

async function saveFile(workId, state) {
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
  const key = normalizeSlugline(slugline || name);
  if (state.settings.some((s) => normalizeSlugline(s.slugline || s.name) === key)) {
    throw badRequest(`A setting matching "${slugline || name}" already exists`);
  }
  const profile = {
    ...emptySetting(),
    id: `wr-setting-${randomUUID()}`,
    slugline,
    name: name || slugline,
    source: 'user',
  };
  for (const field of EDITABLE_FIELDS) {
    if (field === 'slugline' || field === 'name') continue;
    if (patch[field] !== undefined) profile[field] = patch[field];
  }
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
  for (const field of EDITABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    if (field === 'slugline' || field === 'name') {
      const newVal = String(patch[field] || '').trim();
      const key = normalizeSlugline(newVal);
      if (key) {
        const conflict = state.settings.some((s) => s.id !== settingId && normalizeSlugline(s.slugline || s.name) === key);
        if (conflict) throw badRequest(`A setting matching "${newVal}" already exists`);
      }
      next[field] = newVal;
    } else {
      next[field] = patch[field];
    }
  }
  // Enforce the same invariant as `createSetting`: at least one of
  // `slugline` / `name` must be non-empty. Without this final check, a
  // PATCH that blanks the only non-empty identifier (e.g. a name-only
  // setting receiving `{ name: '' }`, or a slugline-only setting being
  // sent `{ slugline: '' }`) would silently leave the setting unaddressable.
  if (!next.slugline && !next.name) {
    throw badRequest('Setting needs slugline or name');
  }
  next.source = 'user';
  next.updatedAt = nowIso();
  state.settings[idx] = next;
  await saveFile(workId, state);
  return next;
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

/**
 * Merge an AI-extracted setting set into the editable bible.
 * - Existing settings (matched by normalized slugline OR name) keep every
 *   non-blank field. Only blank fields get filled from `extracted`.
 * - New settings are inserted with `source: 'ai'`.
 * - `firstAppearance`, `evidence`, `missingFromProse` always reflect the
 *   latest analysis.
 */
export async function mergeExtractedSettings(workId, extracted) {
  if (!Array.isArray(extracted)) return listSettings(workId);
  const state = await loadFile(workId);
  const byKey = new Map();
  // Index a setting under BOTH its normalized slugline and its normalized
  // name so an extracted entry that references the location via either
  // identifier resolves to one canonical record. Indexing by only one of
  // those keys lets a slugline-only incoming entry collide with a name-only
  // existing entry (or vice versa) and create a duplicate setting.
  const indexSetting = (s) => {
    const slugKey = normalizeSlugline(s.slugline);
    const nameKey = normalizeSlugline(s.name);
    if (slugKey) byKey.set(slugKey, s);
    if (nameKey) byKey.set(nameKey, s);
  };
  for (const s of state.settings) indexSetting(s);
  for (const incoming of extracted) {
    if (!incoming || (!incoming.slugline && !incoming.name)) continue;
    const slugKey = normalizeSlugline(incoming.slugline);
    const nameKey = normalizeSlugline(incoming.name);
    const existing = (slugKey && byKey.get(slugKey)) || (nameKey && byKey.get(nameKey)) || null;
    if (existing) {
      for (const field of ['description', 'palette', 'era', 'weather', 'recurringDetails']) {
        if (isBlank(existing[field]) && !isBlank(incoming[field])) {
          existing[field] = incoming[field];
        }
      }
      if (isBlank(existing.name) && !isBlank(incoming.name)) {
        existing.name = String(incoming.name).trim();
        // Re-index now that name is populated so a subsequent entry in the
        // same batch keyed by that name resolves to this record.
        indexSetting(existing);
      }
      // Back-fill slugline when the existing record was created name-only
      // (typical for hand-edited entries). Without this, a storyboard scene's
      // slugline can never match this setting record so setting injection
      // silently no-ops even though the merge correctly de-duped. Re-index
      // afterward so later batch entries keyed by the new slugline resolve.
      if (isBlank(existing.slugline) && !isBlank(incoming.slugline)) {
        existing.slugline = String(incoming.slugline).trim();
        indexSetting(existing);
      }
      existing.firstAppearance = incoming.firstAppearance ?? existing.firstAppearance ?? null;
      existing.evidence = Array.isArray(incoming.evidence) ? incoming.evidence : (existing.evidence || []);
      existing.missingFromProse = Array.isArray(incoming.missingFromProse) ? incoming.missingFromProse : [];
      existing.updatedAt = nowIso();
    } else {
      const profile = {
        ...emptySetting(),
        id: `wr-setting-${randomUUID()}`,
        slugline: String(incoming.slugline || '').trim(),
        name: String(incoming.name || incoming.slugline || '').trim(),
        description: String(incoming.description || '').trim(),
        palette: String(incoming.palette || '').trim(),
        era: String(incoming.era || '').trim(),
        weather: String(incoming.weather || '').trim(),
        recurringDetails: String(incoming.recurringDetails || '').trim(),
        firstAppearance: incoming.firstAppearance ?? null,
        evidence: Array.isArray(incoming.evidence) ? incoming.evidence : [],
        missingFromProse: Array.isArray(incoming.missingFromProse) ? incoming.missingFromProse : [],
        source: 'ai',
      };
      state.settings.push(profile);
      indexSetting(profile);
    }
  }
  await saveFile(workId, state);
  return state.settings.sort((a, b) => (a.slugline || a.name || '').localeCompare(b.slugline || b.name || ''));
}
