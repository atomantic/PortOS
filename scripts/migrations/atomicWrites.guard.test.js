/**
 * Guard: a migration that rewrites a persisted store must swap it in
 * atomically (`writeJsonAtomic` / `writeTextAtomic` from `_lib.js`: temp file
 * + rename).
 *
 * A plain `writeFile()` truncates the target first, so a crash, power loss or
 * full disk mid-write leaves a half-written file. For `data/providers.json`
 * that costs the user every stored API key; for `task-schedule.json` /
 * `apps.json` / `settings.json` it strands the whole install's configuration,
 * and the migration never records itself applied, so the retry reads the
 * corrupt file as "unreadable" and skips it. A truncated stage prompt is worse:
 * its hash matches neither table, so the prompt-replace pass calls it
 * "customized" and leaves it in place forever (#12044).
 *
 * The guard matches the WRITER, not the data argument (#12043): every
 * `writeFile` / `writeFileSync` call whose first argument is not a temp path
 * is an in-place write, whether the body is an inline `JSON.stringify`, a
 * variable serialized on an earlier line, or a text rewrite of a `.json` store.
 * A temp path is an identifier named `tmp`, `temp` or `temporary` (optionally
 * suffixed, e.g. `tempPath`) — the first half of an atomic swap.
 *
 * The frozen list is the pre-existing set of applied migrations that still
 * write in place. Applied migrations are never edited, and the list is never
 * extended — a new migration uses the `_lib.js` writers.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');

const WRITER_CALL = /\bwriteFile(?:Sync)?\(\s*([^,)]*)/g;
const TEMP_PATH_ARG = /^(?:tmp|temp|temporary)(?:[A-Z_$][\w$]*)?$/;

// Prose about `writeFile(path, …)` in a doc comment is not a write. `//` that
// follows `:` (a URL inside a string) is kept.
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** First arguments of every in-place `writeFile` call in a migration source. */
const inPlaceWrites = (source) => [...stripComments(source).matchAll(WRITER_CALL)]
  .map(([, firstArg]) => firstArg.trim())
  .filter((firstArg) => !TEMP_PATH_ARG.test(firstArg));

const FROZEN_IN_PLACE_WRITERS = new Set([
  '001-merge-worldbuilder-collections.js', '002-cd-evaluate-image-strength.js',
  '007-places-int-ext-time-of-day.js', '009-heal-sharing-cursor-drops.js',
  '011-renumber-pipeline-issues-by-volume.js', '012-mark-flux1-dev-gated.js',
  '014-attribute-existing-annotations.js', '015-importer-stage-prompts.js',
  '016-importer-fence-source.js', '018-categorize-universe-buckets.js',
  '018-rename-writers-room-settings-stage.js', '019-character-description-to-physical.js',
  '020-importer-screenplay-user-requested-count.js', '021-link-orphan-universe-collections.js',
  '022-character-extended-fields.js', '022-rename-bible-setting-to-place.js',
  '024-lock-canon-and-variations.js', '026-remove-visual-style-fields.js',
  '028-backfill-universe-builder-image-sidecars.js', '031-world-to-universe-data-rename.js',
  '039-adopt-orphan-series-into-universes.js', '040-init-conflict-journal-store.js',
  '061-browser-config-headed-default.js', '067-pipeline-audio-mode-cues.js',
  '073-seed-500-miles-score.js', '074-seed-musical-rounds.js', '075-correct-500-miles-melody.js',
  '076-seed-500-miles-harmony-parts.js', '080-brain-tombstone-and-synclog-cleanup.js',
  '081-brain-daily-log-inbox-sync.js', '086-seed-round-harmony-parts.js',
  '120-rename-songs-to-rounds-data.js', '125-beat-continuity-prompts.js',
  '146-claude-ollama-providers.js', '148-cd-treatment-catalog-cast.js',
  '154-post-memory-spaced-repetition.js', '157-seed-500-miles-references.js',
  '158-fix-hey-ho-melody.js', '159-post-session-modules-default.js',
  '188-cos-learning-recent-outcomes-ring.js', '190-seed-songbook-songs.js',
  '192-post-dates-to-local-timezone.js', '214-fix-hey-ho-fourth-phrase.js',
  '215-post-durable-memory-mastery.js', '216-post-review-verification-passes.js',
  '268-cd-evaluate-image-strength-crlf.js',
]);

const migrationSources = () => readdirSync(HERE)
  .filter((file) => /^\d.*\.js$/.test(file) && !file.endsWith('.test.js'))
  .map((file) => [file, readFileSync(resolve(HERE, file), 'utf8')]);

describe('migration store writes are atomic', () => {
  it('no migration outside the frozen list writes a store in place', () => {
    const offenders = migrationSources()
      .filter(([file, source]) => !FROZEN_IN_PLACE_WRITERS.has(file))
      .flatMap(([file, source]) => inPlaceWrites(source).map((arg) => `${file}: writeFile(${arg}, …)`));
    expect(offenders, 'in-place writeFile in a migration — use writeJsonAtomic (JSON store) or writeTextAtomic (text) from _lib.js').toEqual([]);
  });

  it('the frozen list only names migrations that still write in place', () => {
    const live = new Set(migrationSources().filter(([, source]) => inPlaceWrites(source).length > 0).map(([file]) => file));
    expect([...FROZEN_IN_PLACE_WRITERS].filter((file) => !live.has(file))).toEqual([]);
  });

  describe('writer matching', () => {
    it('flags a JSON.stringify serialized on an earlier line', () => {
      const source = [
        "const body = JSON.stringify(doc, null, 2);",
        "await writeFile(providersPath, body);",
      ].join('\n');
      expect(inPlaceWrites(source)).toEqual(['providersPath']);
    });

    it('flags a text rewrite of a .json store', () => {
      const source = [
        "const next = raw.replace('\"songs\"', '\"rounds\"');",
        "await writeFile(join(rootDir, 'data', 'songbook.json'), next);",
      ].join('\n');
      expect(inPlaceWrites(source)).toEqual(["join(rootDir"]);
    });

    it('flags writeFileSync and a `templatePath` (not a temp path) alike', () => {
      expect(inPlaceWrites("writeFileSync(settingsPath, JSON.stringify(doc));")).toEqual(['settingsPath']);
      expect(inPlaceWrites("await writeFile(templatePath, next);")).toEqual(['templatePath']);
    });

    it('passes the temp half of an atomic swap and the _lib.js writers', () => {
      const source = [
        "const tmp = `${path}.tmp-${process.pid}`;",
        "await writeFile(tmp, JSON.stringify(value, null, 2));",
        "await writeFile(tempPath, body);",
        "await writeFile(temporaryPath, body);",
        "await rename(tmp, path);",
        "await writeJsonAtomic(path, value);",
        "await writeTextAtomic(path, body);",
      ].join('\n');
      expect(inPlaceWrites(source)).toEqual([]);
    });

    it('ignores prose about writeFile in comments', () => {
      const source = [
        "// a plain writeFile(path, body) would truncate the store",
        "/* see writeFile(configPath, …) in migration 061 — https://example.com/x */",
        "await writeJsonAtomic(path, value);",
      ].join('\n');
      expect(inPlaceWrites(source)).toEqual([]);
    });
  });
});
