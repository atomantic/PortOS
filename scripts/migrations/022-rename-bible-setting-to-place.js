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

import { readFile, writeFile, unlink, rename, readdir, stat } from 'fs/promises';
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

// Each template has a sample twin at the same relative path under
// `data.sample/…`. When an installed copy still hashes to the pre-rename
// baseline (`oldHash`), the migration prefers copying the bundled
// `data.sample` file verbatim — that picks up *every* string the rename
// touched (`## Existing settings` → `## Existing places`, etc.) without
// enumerating the full prose diff. If the bundled sample is missing
// (distributions that strip `data.sample/`, or tests that point `rootDir`
// at a relocated data tree), we fall back to a surgical replace covering
// the rename-critical substitutions so the prompt's runtime contract
// (`{{existingPlacesJson}}` envelope variable + `"places":` LLM output
// envelope key) still works — better to leave some stale prose in
// section headers than to break the extractor on the next request.
const RENAME_SUBSTITUTIONS = [
  // Rename-critical: variable + envelope key. The extractor breaks
  // without these, so they MUST land regardless of fallback path.
  [/\{\{existingSettingsJson\}\}/g, '{{existingPlacesJson}}'],
  [/"settings":\s*\[/g, '"places": ['],
  // Cosmetic but cheap and exhaustive over the known shipped templates.
  [/Setting \/ World Bible Extraction/g, 'Place / World Bible Extraction'],
  [/## Existing settings/g, '## Existing places'],
  [/## Setting bible/g, '## Places bible'],
  [/setting bible \(canonical/g, 'places bible (canonical'],
  [/back to settings automatically/g, 'back to places automatically'],
  [/attach a setting to a scene/g, 'attach a place to a scene'],
  [/the setting's baseline description/g, "the place's baseline description"],
];

const PROMPT_TEMPLATES = [
  {
    rel: 'data/prompts/stages/writers-room-places.md',
    sampleRel: 'data.sample/prompts/stages/writers-room-places.md',
    oldHash: OLD_PROMPTS_PLACES_MD5,
    newHash: NEW_PROMPTS_PLACES_MD5,
  },
  {
    rel: 'data/prompts/_partials/bible-deference.md',
    sampleRel: 'data.sample/prompts/_partials/bible-deference.md',
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
      // partial migration run or hand-edit produced it). Move the legacy
      // `settings.json` aside as `.bak-022` rather than `unlink`-ing it: if
      // the two diverged (e.g. user hand-created `places.json` from a
      // non-empty subset), the legacy file may contain entries the user
      // would otherwise lose silently. The next migration tick won't re-fire
      // this branch because `settings.json` is gone; the .bak sits as a
      // recovery breadcrumb the user can diff if anything looks missing.
      const backupPath = `${legacyPath}.bak-022`;
      await rename(legacyPath, backupPath).catch((err) => {
        console.warn(`⚠️ ${join('data/writers-room/works', entry.name)}: failed to back up legacy settings.json → settings.json.bak-022 — ${err.message}`);
      });
      console.log(`🧹 ${join('data/writers-room/works', entry.name)}: both settings.json and places.json existed — kept places.json, backed up legacy settings.json → settings.json.bak-022 (diff if anything looks missing)`);
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
    // Try unlink first (clean removal of the now-redundant legacy file).
    // If unlink fails (Windows file-lock, EACCES, etc.) the residual
    // `settings.json` would otherwise be re-discovered by the next
    // migration tick as a phantom "both files exist" case — confusing the
    // user with a "diff if anything looks missing" warning even though
    // both files came from the same migration run. Fall back to renaming
    // it aside as `.bak-022` so the next run sees only `places.json` and
    // exits cleanly.
    const unlinkErr = await unlink(legacyPath).then(() => null, (err) => err);
    if (unlinkErr) {
      const backupPath = `${legacyPath}.bak-022`;
      await rename(legacyPath, backupPath).catch((renameErr) => {
        console.warn(
          `⚠️ ${join('data/writers-room/works', entry.name)}: failed to clean up legacy settings.json after writing places.json — ` +
          `unlink: ${unlinkErr.message}; rename to .bak-022: ${renameErr.message}. ` +
          `Next migration run will treat this as a phantom "both files exist" case.`,
        );
      });
    }
    renamedFiles += 1;
  }
  if (renamedFiles > 0) {
    console.log(`📝 data/writers-room/works/: renamed settings.json → places.json in ${renamedFiles} work director${renamedFiles === 1 ? 'y' : 'ies'}`);
  } else if (entries.length > 0) {
    console.log(`✅ data/writers-room/works/: already on places.json shape`);
  }
};

const migratePromptTemplate = async (rootDir, { rel, sampleRel, oldHash, newHash }) => {
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
  // Pre-rename baseline. Prefer copying the bundled `data.sample` twin
  // verbatim — it carries every prose substitution the rename touched.
  // When `data.sample` is missing (stripped distribution, relocated
  // rootDir), fall back to a surgical replace covering the
  // rename-critical substitutions enumerated in RENAME_SUBSTITUTIONS,
  // so the prompt's runtime contract still works even if some prose
  // strings stay stale. Hash check above guarantees we only rewrite an
  // unmodified shipped default — customized templates land in the
  // warning branch and the user-customized version is preserved.
  const samplePath = join(rootDir, sampleRel);
  const sample = await readFile(samplePath, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (sample != null) {
    await writeFile(path, sample);
    console.log(`📝 ${rel}: replaced pre-rename shipped default with current data.sample bundle`);
    return;
  }
  const next = RENAME_SUBSTITUTIONS.reduce((acc, [from, to]) => acc.replace(from, to), raw);
  await writeFile(path, next);
  console.warn(
    `⚠️ ${rel}: bundled sample missing at ${sampleRel} — fell back to surgical replace ` +
    `(rename-critical substitutions applied; some stale prose may remain in section headers).`,
  );
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
