/**
 * Normalize legacy character.description → character.physicalDescription
 * across every store that persists a `characters[]` array.
 *
 * Background: pipeline early on used `description` as the visual descriptor
 * field for characters; the writers-room/canon refactor moved everything to
 * `physicalDescription`. `sanitizeCharacter` keeps a defensive read-side
 * fallback (`raw.physicalDescription || raw.description`) so a load that
 * happens before this migration runs doesn't silently drop the text on save,
 * but the persisted alias is otherwise dead weight — this migration rewrites
 * any character record that still carries it so the on-disk shape matches
 * what the sanitizer writes back.
 *
 * Targeted files (each may or may not exist depending on the install):
 *   data/pipeline-series.json   — series.characters[]
 *   data/universe-builder.json  — universes[].characters[]
 *
 * Idempotent: a record that already has `physicalDescription` (or that
 * never had a `description` field) is left alone. A record where both
 * fields are present has the legacy `description` field deleted (the
 * sanitizer was already preferring `physicalDescription` in that case).
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

async function readJsonOr(path, fallback) {
  if (!existsSync(path)) return fallback;
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (!raw) return fallback;
  return JSON.parse(raw);
}

// Returns { changed, character } — changed=true only when a write is needed.
function normalizeCharacter(raw) {
  if (!raw || typeof raw !== 'object') return { changed: false, character: raw };
  if (!('description' in raw)) return { changed: false, character: raw };
  const { description, ...rest } = raw;
  // If physicalDescription is missing/blank, lift description into it.
  // Otherwise (both present) drop the legacy alias and keep physicalDescription.
  if (typeof rest.physicalDescription !== 'string' || !rest.physicalDescription.trim()) {
    const lifted = typeof description === 'string' ? description : '';
    return { changed: true, character: { ...rest, physicalDescription: lifted } };
  }
  return { changed: true, character: rest };
}

function normalizeCharacterList(list) {
  if (!Array.isArray(list)) return { changed: false, list };
  let changed = false;
  const next = list.map((c) => {
    const { changed: cChanged, character } = normalizeCharacter(c);
    if (cChanged) changed = true;
    return character;
  });
  return { changed, list: next };
}

async function migrateSeriesFile(path) {
  if (!existsSync(path)) return { changed: false, recordsTouched: 0, charactersTouched: 0 };
  const state = await readJsonOr(path, null);
  if (!state || !Array.isArray(state.series)) return { changed: false, recordsTouched: 0, charactersTouched: 0 };
  let recordsTouched = 0;
  let charactersTouched = 0;
  const next = state.series.map((s) => {
    if (!s || typeof s !== 'object' || !Array.isArray(s.characters)) return s;
    const { changed, list } = normalizeCharacterList(s.characters);
    if (!changed) return s;
    recordsTouched += 1;
    charactersTouched += list.filter((c, i) => c !== s.characters[i]).length;
    return { ...s, characters: list };
  });
  if (recordsTouched === 0) return { changed: false, recordsTouched: 0, charactersTouched: 0 };
  await writeFile(path, JSON.stringify({ ...state, series: next }, null, 2));
  return { changed: true, recordsTouched, charactersTouched };
}

async function migrateUniverseFile(path) {
  if (!existsSync(path)) return { changed: false, recordsTouched: 0, charactersTouched: 0 };
  const state = await readJsonOr(path, null);
  if (!state || !Array.isArray(state.universes)) return { changed: false, recordsTouched: 0, charactersTouched: 0 };
  let recordsTouched = 0;
  let charactersTouched = 0;
  const next = state.universes.map((u) => {
    if (!u || typeof u !== 'object' || !Array.isArray(u.characters)) return u;
    const { changed, list } = normalizeCharacterList(u.characters);
    if (!changed) return u;
    recordsTouched += 1;
    charactersTouched += list.filter((c, i) => c !== u.characters[i]).length;
    return { ...u, characters: list };
  });
  if (recordsTouched === 0) return { changed: false, recordsTouched: 0, charactersTouched: 0 };
  await writeFile(path, JSON.stringify({ ...state, universes: next }, null, 2));
  return { changed: true, recordsTouched, charactersTouched };
}

export default {
  async up({ rootDir }) {
    const seriesPath = join(rootDir, 'data', 'pipeline-series.json');
    const universePath = join(rootDir, 'data', 'universe-builder.json');

    const [seriesResult, universeResult] = await Promise.all([
      migrateSeriesFile(seriesPath),
      migrateUniverseFile(universePath),
    ]);

    const totalRecords = seriesResult.recordsTouched + universeResult.recordsTouched;
    const totalChars = seriesResult.charactersTouched + universeResult.charactersTouched;

    if (totalRecords === 0) {
      return { changed: false, reason: 'no-legacy-description-fields' };
    }
    console.log(
      `📝 migration 019: normalized character.description → physicalDescription on ${totalRecords} record(s), ${totalChars} character(s) (series=${seriesResult.recordsTouched}, universe=${universeResult.recordsTouched})`,
    );
    return { changed: true, seriesRecords: seriesResult.recordsTouched, universeRecords: universeResult.recordsTouched, charactersTouched: totalChars };
  },
};
