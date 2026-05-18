/**
 * Rename the bible-domain `setting` entity to `place` across persisted state.
 *
 * Migration 018 already renamed the stage-config key + prompt file. This
 * migration extends the rename through every other persisted surface so the
 * runtime contract (`BIBLE_KIND.PLACE: 'place'`, `BIBLE_FIELD[PLACE]: 'places'`)
 * matches what's on disk:
 *
 *   1. `data/universe-builder.json`:
 *      - `state.universes[].settings: [...]`  → `state.universes[].places: [...]`
 *      - `categories[k].kind === 'settings'`  → `'places'`
 *
 *   2. `data/pipeline-series.json`:
 *      - `state.series[].settings: [...]`     → `state.series[].places: [...]`
 *        (legacy field — canon now lives on the linked universe, but old
 *        records may still carry the array; renaming keeps reads consistent.)
 *
 *   3. `data/writers-room/works/<workId>/`:
 *      - rename file `settings.json`           → `places.json`
 *      - rewrite top-level JSON key `settings` → `places` inside
 *
 *   4. `data/prompts/stages/writers-room-places.md`:
 *      - rewrite `{{existingSettingsJson}}`    → `{{existingPlacesJson}}`
 *      - rewrite `"settings": [`               → `"places": [`
 *
 *   5. `data/prompts/_partials/bible-deference.md`:
 *      - rewrite `{{existingSettingsJson}}`    → `{{existingPlacesJson}}`
 *
 *   6. `data/prompts/stages/writers-room-places.md` + bible-deference.md:
 *      auto-update the shipped templates when the user hasn't customized
 *      them (matches OLD_SHIPPED_MD5). Customized templates are left alone
 *      so the user's edits aren't clobbered; the drift surfaces in
 *      setup-data.js's hash-check warning.
 *
 * Idempotent: re-runs skip universes/series/works that already carry the
 * post-rename shape, and prompt templates that already match the new
 * shipped MD5.
 *
 * NOT TOUCHED:
 *   - The per-entry id prefix `set-` on existing pipeline canon entries
 *     (purely cosmetic — ids are opaque after creation).
 *   - The per-work file `data/writers-room/works/<id>/places.json` if the
 *     user already migrated by hand (we keep their version).
 *   - Stage-config key `writers-room-places` (handled by migration 018).
 */

import { readFile, writeFile, unlink, readdir, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const md5 = (str) => {
  const normalized = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return createHash('md5').update(normalized).digest('hex');
};

const readJsonOrNull = async (path) => {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const writeJson = async (path, data) => {
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
};

const fileExists = async (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

const readDirOrEmpty = async (path) => readdir(path, { withFileTypes: true }).catch((err) => {
  if (err.code === 'ENOENT') return [];
  throw err;
});

// Pre-rename shipped hashes. Auto-update only matches; customized templates
// are left for the user to merge manually (setup-data.js will flag the drift).
const OLD_PROMPTS_PLACES_MD5 = '24a33628cc94d80fa5ca60831d973daf';
const NEW_PROMPTS_PLACES_MD5 = 'a7f68e51dd6b4421d20f5bd9d855d9b4';
const OLD_PROMPTS_DEFERENCE_MD5 = '218f0e85643609ed85a12b1ccc7b5a8d';
const NEW_PROMPTS_DEFERENCE_MD5 = 'a4681348c27776e414acf6e0be566a99';

const PROMPT_TEMPLATES = [
  {
    rel: 'data/prompts/stages/writers-room-places.md',
    oldHash: OLD_PROMPTS_PLACES_MD5,
    newHash: NEW_PROMPTS_PLACES_MD5,
  },
  {
    rel: 'data/prompts/_partials/bible-deference.md',
    oldHash: OLD_PROMPTS_DEFERENCE_MD5,
    newHash: NEW_PROMPTS_DEFERENCE_MD5,
  },
];

const migrateUniverseState = async (rootDir) => {
  const path = join(rootDir, 'data/universe-builder.json');
  const state = await readJsonOrNull(path);
  if (!state || !Array.isArray(state.universes)) return;
  let touched = 0;
  for (const u of state.universes) {
    let changed = false;
    if (Array.isArray(u.settings) && !Array.isArray(u.places)) {
      u.places = u.settings;
      delete u.settings;
      changed = true;
    } else if ('settings' in u && Array.isArray(u.places)) {
      // Both keys present (a partial prior migration or hand-edit) —
      // keep the post-rename `places` and drop the legacy `settings`.
      delete u.settings;
      changed = true;
    }
    if (u.categories && typeof u.categories === 'object') {
      for (const cat of Object.values(u.categories)) {
        if (cat && cat.kind === 'settings') {
          cat.kind = 'places';
          changed = true;
        }
      }
    }
    if (changed) touched += 1;
  }
  if (touched > 0) {
    await writeJson(path, state);
    console.log(`📝 data/universe-builder.json: renamed setting→place on ${touched} universe${touched === 1 ? '' : 's'}`);
  } else {
    console.log(`✅ data/universe-builder.json: already on places shape`);
  }
};

const migrateSeriesState = async (rootDir) => {
  const path = join(rootDir, 'data/pipeline-series.json');
  const state = await readJsonOrNull(path);
  if (!state || !Array.isArray(state.series)) return;
  let touched = 0;
  for (const s of state.series) {
    if (Array.isArray(s.settings) && !Array.isArray(s.places)) {
      s.places = s.settings;
      delete s.settings;
      touched += 1;
    } else if ('settings' in s) {
      delete s.settings;
      touched += 1;
    }
  }
  if (touched > 0) {
    await writeJson(path, state);
    console.log(`📝 data/pipeline-series.json: renamed setting→place on ${touched} series record${touched === 1 ? '' : 's'}`);
  } else {
    console.log(`✅ data/pipeline-series.json: already on places shape`);
  }
};

const migrateWritersRoomWorks = async (rootDir) => {
  const worksDir = join(rootDir, 'data/writers-room/works');
  const entries = await readDirOrEmpty(worksDir);
  let renamedFiles = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workDir = join(worksDir, entry.name);
    const legacyPath = join(workDir, 'settings.json');
    const newPath = join(workDir, 'places.json');
    const legacyExists = await fileExists(legacyPath);
    if (!legacyExists) continue;
    const newExists = await fileExists(newPath);
    if (newExists) {
      // Both files exist — `places.json` is the post-rename truth (a prior
      // partial migration run or hand-edit produced it). Drop the legacy
      // `settings.json` orphan so the next migration tick doesn't re-fire
      // this branch every run. We can't safely merge two parallel writes,
      // and `places.json` is what the runtime reads.
      await unlink(legacyPath).catch((err) => {
        console.warn(`⚠️ ${join('data/writers-room/works', entry.name)}: failed to remove legacy settings.json — ${err.message}`);
      });
      console.log(`🧹 ${join('data/writers-room/works', entry.name)}: both settings.json and places.json existed — kept places.json, removed legacy settings.json`);
      continue;
    }
    const raw = await readFile(legacyPath, 'utf-8').catch(() => null);
    if (raw == null) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (parsed && Array.isArray(parsed.settings)) {
      parsed.places = parsed.settings;
      delete parsed.settings;
      await writeJson(newPath, parsed);
    } else {
      await writeJson(newPath, parsed || { places: [], updatedAt: null });
    }
    await unlink(legacyPath).catch((err) => {
      console.warn(`⚠️ ${join('data/writers-room/works', entry.name)}: failed to remove legacy settings.json after writing places.json — ${err.message}`);
    });
    renamedFiles += 1;
  }
  if (renamedFiles > 0) {
    console.log(`📝 data/writers-room/works/: renamed settings.json → places.json in ${renamedFiles} work director${renamedFiles === 1 ? 'y' : 'ies'}`);
  } else if (entries.length > 0) {
    console.log(`✅ data/writers-room/works/: already on places.json shape`);
  }
};

const migratePromptTemplate = async (rootDir, { rel, oldHash, newHash }) => {
  const path = join(rootDir, rel);
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return;
  const currentHash = md5(raw);
  if (currentHash === newHash) {
    console.log(`✅ ${rel}: already at new shipped baseline`);
    return;
  }
  if (currentHash !== oldHash) {
    console.log(`⚠️ ${rel}: customized (hash ${currentHash.slice(0, 8)}) — not auto-updating. Diff against data.sample to pick up the {{existingPlacesJson}} rename.`);
    return;
  }
  const next = raw
    .replace(/\{\{existingSettingsJson\}\}/g, '{{existingPlacesJson}}')
    .replace(/"settings":\s*\[/g, '"places": [')
    .replace(/Setting \/ World Bible Extraction/g, 'Place / World Bible Extraction')
    .replace(/setting bible \(canonical/g, 'places bible (canonical')
    .replace(/## Setting bible/g, '## Places bible');
  await writeFile(path, next);
  console.log(`📝 ${rel}: updated existingSettingsJson → existingPlacesJson + "settings": → "places":`);
};

export default {
  async up({ rootDir }) {
    await migrateUniverseState(rootDir);
    await migrateSeriesState(rootDir);
    await migrateWritersRoomWorks(rootDir);
    for (const tpl of PROMPT_TEMPLATES) {
      await migratePromptTemplate(rootDir, tpl);
    }
  },
};
