/**
 * Guard: a migration that rewrites a persisted JSON store must swap it in
 * atomically (`writeJsonAtomic` from `_lib.js`: temp file + rename).
 *
 * A plain `writeFile()` truncates the target first, so a crash, power loss or
 * full disk mid-write leaves a half-written file. For `data/providers.json`
 * that costs the user every stored API key; for `task-schedule.json` /
 * `apps.json` / `settings.json` it strands the whole install's configuration,
 * and the migration never records itself applied, so the retry reads the
 * corrupt file as "unreadable" and skips it. Provider, schedule, app and
 * settings migrations were converted when this guard landed.
 *
 * The frozen list is the pre-existing set of older migrations that still write
 * in place. Never add to it — use `writeJsonAtomic`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');

// A `writeFile(...)` whose argument list serializes JSON, excluding writes to a
// temp path (the first half of an atomic swap).
const IN_PLACE_JSON_WRITE = /writeFile(Sync)?\((?!tmp|temp)[^;]*JSON\.stringify/;

const FROZEN_IN_PLACE_WRITERS = new Set([
  '001-merge-worldbuilder-collections.js', '009-heal-sharing-cursor-drops.js',
  '011-renumber-pipeline-issues-by-volume.js', '012-mark-flux1-dev-gated.js',
  '014-attribute-existing-annotations.js', '015-importer-stage-prompts.js',
  '018-categorize-universe-buckets.js', '018-rename-writers-room-settings-stage.js',
  '019-character-description-to-physical.js', '021-link-orphan-universe-collections.js',
  '022-character-extended-fields.js', '022-rename-bible-setting-to-place.js',
  '024-lock-canon-and-variations.js', '026-remove-visual-style-fields.js',
  '028-backfill-universe-builder-image-sidecars.js', '031-world-to-universe-data-rename.js',
  '039-adopt-orphan-series-into-universes.js', '040-init-conflict-journal-store.js',
  '061-browser-config-headed-default.js', '067-pipeline-audio-mode-cues.js',
  '073-seed-500-miles-score.js', '074-seed-musical-rounds.js', '075-correct-500-miles-melody.js',
  '076-seed-500-miles-harmony-parts.js', '080-brain-tombstone-and-synclog-cleanup.js',
  '081-brain-daily-log-inbox-sync.js', '086-seed-round-harmony-parts.js',
  '120-rename-songs-to-rounds-data.js', '125-beat-continuity-prompts.js',
  '154-post-memory-spaced-repetition.js', '157-seed-500-miles-references.js',
  '158-fix-hey-ho-melody.js', '159-post-session-modules-default.js',
  '188-cos-learning-recent-outcomes-ring.js', '190-seed-songbook-songs.js',
  '192-post-dates-to-local-timezone.js', '214-fix-hey-ho-fourth-phrase.js',
  '215-post-durable-memory-mastery.js', '216-post-review-verification-passes.js',
]);

const migrationSources = () => readdirSync(HERE)
  .filter((file) => /^\d.*\.js$/.test(file) && !file.endsWith('.test.js'))
  .map((file) => [file, readFileSync(resolve(HERE, file), 'utf8')]);

describe('migration JSON writes are atomic', () => {
  it('no migration outside the frozen list rewrites a JSON store in place', () => {
    const offenders = migrationSources()
      .filter(([file, source]) => IN_PLACE_JSON_WRITE.test(source) && !FROZEN_IN_PLACE_WRITERS.has(file))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('the frozen list only names migrations that still write in place', () => {
    const live = new Set(migrationSources().filter(([, source]) => IN_PLACE_JSON_WRITE.test(source)).map(([file]) => file));
    expect([...FROZEN_IN_PLACE_WRITERS].filter((file) => !live.has(file))).toEqual([]);
  });
});
