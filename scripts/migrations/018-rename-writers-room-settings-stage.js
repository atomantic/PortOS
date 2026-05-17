/**
 * Rename the `writers-room-settings` stage key to `writers-room-places` in
 * the installed `data/prompts/stage-config.json`, and migrate the matching
 * `.md` prompt template.
 *
 * Background: commit be903564 renamed the prompt file
 * `writers-room-settings.md` → `writers-room-places.md` (Universe rename PR)
 * but deferred the corresponding stage-key rename. Existing installs that
 * upgrade through this commit still have the old `writers-room-settings`
 * key in their config — at runtime the prompt service looks up
 * `data/prompts/stages/writers-room-settings.md`, finds nothing (the file
 * is now `…-places.md`), and throws `Template for writers-room-settings
 * not found`.
 *
 * Update flow ordering caveat (Copilot review on PR #265): `setup-data.js`
 * runs *before* migrations, with two side effects this migration must
 * counteract:
 *
 *   1. `JSON_MERGE_TARGETS` merges any new sample stage entries — so by the
 *      time this migration runs, an existing install will typically have
 *      BOTH stage-config keys: `writers-room-settings` (user's, possibly
 *      customized) and `writers-room-places` (fresh sample defaults).
 *      Naively keeping the auto-seeded `…-places` entry would silently
 *      discard any model/provider/variable customizations the user had on
 *      `…-settings`.
 *
 *   2. `ensureSampleContent` copies missing prompt files — so
 *      `data/prompts/stages/writers-room-places.md` will be auto-seeded
 *      from data.sample (full post-rename + post-migration-007 content)
 *      while the user's old `writers-room-settings.md` is left orphaned.
 *      Switching the stage key to `…-places` makes the runtime use the
 *      freshly seeded sample template, ignoring any customizations the
 *      user had in `…-settings.md`.
 *
 * Resolution for both: when the corresponding `…-places` artifact (entry
 * or file) byte-for-byte matches the sample default, treat it as an
 * auto-seed. Then decide whether the legacy artifact is genuinely
 * customized:
 *
 *   - stage-config entry: compared structurally against the sample default.
 *     Equal → unmodified, drop in favor of the seed; different → customized,
 *     promote into `…-places`.
 *   - `.md` prompt file: compared against an *embedded pre-rename baseline
 *     hash* (`LEGACY_PROMPT_SHIPPED_MD5`), not the current sample. The
 *     current sample includes migration 007's intExt/timeOfDay fields, so
 *     an install that never ran 007 will *correctly* show the legacy file
 *     as unmodified-baseline (matching the hash) — keeping the freshly
 *     seeded modern sample is the right move. Only files whose hash
 *     diverges from the baseline are treated as user customizations.
 *
 * If `…-places` differs from the sample, treat it as a deliberate user
 * edit and keep it. The legacy `…-settings.md` file is removed once the
 * migration has either preserved its content or detected that it was
 * untouched.
 *
 * Idempotent: skips when only `writers-room-places` is present (and no
 * legacy key/file), or when neither key/file exists (fresh installs get
 * the post-rename sample copy).
 */

import { readFile, writeFile, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

const STAGE_CONFIG_REL_PATH = 'data/prompts/stage-config.json';
const SAMPLE_CONFIG_REL_PATH = 'data.sample/prompts/stage-config.json';
const LEGACY_KEY = 'writers-room-settings';
const NEW_KEY = 'writers-room-places';

const PROMPTS_STAGES_DIR_REL = 'data/prompts/stages';
const SAMPLE_STAGES_DIR_REL = 'data.sample/prompts/stages';
const LEGACY_PROMPT_FILE = 'writers-room-settings.md';
const NEW_PROMPT_FILE = 'writers-room-places.md';

// MD5 of the pre-rename `writers-room-settings.md` shipped baseline (the
// content that existed in data.sample right before commit be903564 renamed
// the file to `writers-room-places.md`). An installed legacy file at this
// hash is an *unmodified* default — the user did not customize it. This
// also happens to equal migration 007's `OLD_SHIPPED_MD5` for the renamed
// file, since be903564 only renamed (no content change).
//
// Used so we can distinguish "user customized legacy prompt → preserve"
// from "user never ran migration 007 + never customized → keep the freshly
// seeded modern sample with intExt/timeOfDay fields".
const LEGACY_PROMPT_SHIPPED_MD5 = '7f1f80eb63d67a21161994cde115045e';

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

const readTextOrNull = async (path) => readFile(path, 'utf-8').catch((err) => {
  if (err.code === 'ENOENT') return null;
  throw err;
});

const fileExists = async (path) => stat(path).then(() => true, (err) => {
  if (err.code === 'ENOENT') return false;
  throw err;
});

// Migrate the `.md` prompt template. Mirrors the stage-config conflict
// policy: when both legacy and new files exist and `…-places.md` matches
// the sample default, replace it with the legacy content (preserving the
// user's customizations). Otherwise keep the user-customized `…-places.md`.
// Always remove the now-orphan `…-settings.md` when its content has been
// preserved or it matches the pre-rename baseline (== sample default).
const migratePromptFile = async (rootDir) => {
  const dataDir = join(rootDir, PROMPTS_STAGES_DIR_REL);
  const sampleDir = join(rootDir, SAMPLE_STAGES_DIR_REL);
  const legacyPath = join(dataDir, LEGACY_PROMPT_FILE);
  const newPath = join(dataDir, NEW_PROMPT_FILE);
  const samplePath = join(sampleDir, NEW_PROMPT_FILE);

  const legacyExists = await fileExists(legacyPath);
  if (!legacyExists) {
    return; // already migrated or fresh install
  }

  const legacyContent = await readTextOrNull(legacyPath);
  const newContent = await readTextOrNull(newPath);
  const sampleContent = await readTextOrNull(samplePath);

  if (legacyContent == null) {
    // race / disappeared between stat and read — let next run resolve
    return;
  }

  if (newContent != null && sampleContent != null && newContent === sampleContent) {
    // `…-places.md` was just auto-seeded from data.sample. Decide whether
    // the legacy file is an unmodified default (keep the modern auto-seed)
    // or carries real user customizations (preserve those over the seed).
    //
    // Compare against the pre-rename shipped baseline hash, NOT the current
    // sample — for installs that never ran migration 007, the unmodified
    // legacy file is *expected* to differ from the current sample (which
    // has migration 007's intExt / timeOfDay fields). Treating any
    // difference as "customized" would overwrite the freshly seeded modern
    // template with an older default and silently undo migration 007.
    const legacyHash = md5(legacyContent);
    const legacyIsUnmodifiedDefault =
      legacyHash === LEGACY_PROMPT_SHIPPED_MD5 || legacyContent === sampleContent;

    if (!legacyIsUnmodifiedDefault) {
      await writeFile(newPath, legacyContent);
      console.warn(
        `⚠️  ${PROMPTS_STAGES_DIR_REL}/${NEW_PROMPT_FILE}: replaced auto-seeded sample with your customized ${LEGACY_PROMPT_FILE}.\n` +
        `   Note: if you had not picked up migration 007 (intExt / timeOfDay fields), diff against\n` +
        `     ${SAMPLE_STAGES_DIR_REL}/${NEW_PROMPT_FILE}\n` +
        `   and merge the new field bullets + JSON keys manually.`,
      );
    } else {
      console.log(`📝 ${PROMPTS_STAGES_DIR_REL}/${NEW_PROMPT_FILE}: legacy file matched shipped baseline, kept auto-seeded copy`);
    }
  } else if (newContent != null) {
    // `…-places.md` exists but differs from sample → user customized it
    // (or sample missing). Respect that and just drop the legacy orphan.
    console.log(`📝 ${PROMPTS_STAGES_DIR_REL}/${NEW_PROMPT_FILE}: user-customized, kept as-is (legacy ${LEGACY_PROMPT_FILE} discarded)`);
  } else {
    // `…-places.md` missing entirely (setup-data didn't run). Apply the
    // same baseline check as the auto-seeded branch: if the legacy file
    // is the unmodified pre-rename baseline AND we have a current sample,
    // install the modern sample (so users picking up this migration cold
    // also pick up migration 007's intExt / timeOfDay fields). Otherwise
    // the legacy file carries user customizations (or there's no sample
    // available) — promote it in place.
    const legacyHash = md5(legacyContent);
    if (legacyHash === LEGACY_PROMPT_SHIPPED_MD5 && sampleContent != null) {
      await writeFile(newPath, sampleContent);
      console.log(`📝 ${PROMPTS_STAGES_DIR_REL}/${NEW_PROMPT_FILE}: legacy matched shipped baseline, installed current sample`);
    } else {
      await writeFile(newPath, legacyContent);
      // Mirror the auto-seeded customized path's warning: the promoted
      // legacy content lacks migration 007's intExt / timeOfDay fields,
      // so the user needs to know to re-merge them manually.
      console.warn(
        `⚠️  ${PROMPTS_STAGES_DIR_REL}/${NEW_PROMPT_FILE}: promoted from legacy ${LEGACY_PROMPT_FILE}.\n` +
        `   Note: if you had not picked up migration 007 (intExt / timeOfDay fields), diff against\n` +
        `     ${SAMPLE_STAGES_DIR_REL}/${NEW_PROMPT_FILE}\n` +
        `   and merge the new field bullets + JSON keys manually.`,
      );
    }
  }

  await unlink(legacyPath).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
  console.log(`🧹 removed orphan ${PROMPTS_STAGES_DIR_REL}/${LEGACY_PROMPT_FILE}`);
};

export default {
  async up({ rootDir }) {
    // Migrate the `.md` prompt template first — even if the stage-config
    // is already on `writers-room-places`, an orphan legacy prompt file
    // may still need cleanup.
    await migratePromptFile(rootDir);

    const path = join(rootDir, STAGE_CONFIG_REL_PATH);
    const raw = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (raw == null) {
      console.log(`📄 ${STAGE_CONFIG_REL_PATH} not present — skipping (fresh install will copy from data.sample)`);
      return;
    }

    let config;
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.log(`⚠️ ${STAGE_CONFIG_REL_PATH}: invalid JSON, skipping migration (${err.message})`);
      return;
    }

    const stages = config?.stages;
    if (!stages || typeof stages !== 'object') {
      console.log(`⚠️ ${STAGE_CONFIG_REL_PATH}: no stages map — skipping`);
      return;
    }

    if (!stages[LEGACY_KEY]) {
      console.log(`✅ ${STAGE_CONFIG_REL_PATH}: already on ${NEW_KEY}, no changes`);
      return;
    }

    // When both keys are present, decide which value to keep. The most
    // common case on `npm run setup && npm run migrations` flow is that
    // setup-data just auto-seeded `writers-room-places` with sample
    // defaults — in that case we must prefer the user's legacy entry so
    // their customizations survive.
    let prefersLegacyValue = true;
    if (stages[NEW_KEY]) {
      const sample = await readJsonOrNull(join(rootDir, SAMPLE_CONFIG_REL_PATH));
      const sampleEntry = sample?.stages?.[NEW_KEY];
      if (sampleEntry && JSON.stringify(stages[NEW_KEY]) === JSON.stringify(sampleEntry)) {
        // Installed `…-places` is byte-for-byte the sample default → it
        // was just auto-seeded by setup-data.js. Replace with the user's
        // legacy entry.
        prefersLegacyValue = true;
      } else {
        // User has hand-customized `…-places` (or sample lookup failed).
        // Respect that and discard the legacy entry.
        prefersLegacyValue = false;
      }
    }

    // Preserve order: walk keys and emit a fresh stages object with the
    // renamed key in the same slot the legacy key occupied. When both
    // keys exist and we're keeping the user's `…-places` entry, drop the
    // legacy slot entirely (the existing `…-places` slot stays in place).
    const renamed = {};
    for (const [key, value] of Object.entries(stages)) {
      if (key === LEGACY_KEY) {
        if (stages[NEW_KEY] && !prefersLegacyValue) continue;
        renamed[NEW_KEY] = value;
      } else if (key === NEW_KEY) {
        if (prefersLegacyValue && stages[LEGACY_KEY]) continue;
        renamed[NEW_KEY] = value;
      } else {
        renamed[key] = value;
      }
    }
    config.stages = renamed;

    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
    if (stages[NEW_KEY] && prefersLegacyValue) {
      console.log(`📝 ${STAGE_CONFIG_REL_PATH}: replaced auto-seeded ${NEW_KEY} with legacy ${LEGACY_KEY} entry (preserving user customizations)`);
    } else if (stages[NEW_KEY] && !prefersLegacyValue) {
      console.log(`📝 ${STAGE_CONFIG_REL_PATH}: discarded legacy ${LEGACY_KEY} (user-customized ${NEW_KEY} already present)`);
    } else {
      console.log(`📝 ${STAGE_CONFIG_REL_PATH}: renamed ${LEGACY_KEY} → ${NEW_KEY}`);
    }
  },
};
