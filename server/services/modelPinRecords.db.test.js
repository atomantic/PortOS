/**
 * Per-record retired-model-pin scan against real PostgreSQL (#7326).
 *
 * modelPinRecords.test.js pins the collector's behavior with `lib/db.js`
 * mocked; what only a real database can answer is whether the SQL itself is
 * right — that every family's table and JSON column exist and are spelled
 * correctly, that the filter excludes unpinned and tombstoned rows, and that a
 * clear lands as an absent model beside an untouched `imageMode`.
 *
 * Seeds and reads back through raw SQL, and reaches each record service only
 * the way production does — through the lazy `import()` inside `clearRecordPin`.
 * A static `import` of one here would put that service's whole subtree in this
 * file's closure, which the suite-wide budget in lib/importScoping.test.js
 * charges for (see the "Import scoping" section of server/AGENTS.md).
 *
 * Runs only against portos_test.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { RECORD_PIN_FAMILIES, clearRecordPin, collectRecordPins } from './modelPinRecords.js';

const health = await checkHealth().catch((error) => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('services/modelPinRecords.db.test', health.connected, health.error);
if (ready) await ensureSchema();

// Every family keyed by name, so a case seeds by the same id the collector reports.
const byFamily = Object.fromEntries(RECORD_PIN_FAMILIES.map((family) => [family.family, family]));

// The id column is TEXT everywhere but decks, which key on UUID — the seeded
// ids below follow suit, and cleanup has to cast to match.
const DECK_ID = '00000000-7326-4000-8000-00000000000d';
const SEEDED = {
  universe: 'pin-audit-universe',
  series: 'pin-audit-series',
  sprite: 'pin-audit-sprite',
  musicVideo: 'pin-audit-music-video',
  deck: DECK_ID,
};

// `deck_cards` cascade from the deck row, so one delete per table is enough.
const cleanup = async () => {
  for (const [family, id] of Object.entries(SEEDED)) {
    const { table } = byFamily[family];
    const cast = family === 'deck' ? '::uuid' : '::text';
    await query(`DELETE FROM ${table} WHERE id = $1${cast}`, [id]);
  }
};

// Columns a family's DDL requires beyond the id/document/deleted trio every one
// of them shares — a mirrored `name` where the list query needs one, plus the
// deck's NOT NULL `kind`. Anything absent keeps its DDL default.
const REQUIRED_COLUMNS = {
  universe: { name: 'Pin Audit' },
  series: { name: 'Pin Audit' },
  sprite: {},
  musicVideo: {},
  deck: { name: 'Pin Audit', kind: 'playing' },
};

/**
 * Seed one family's row carrying `document` as its stored record. One seeder
 * serves all five because they differ only in the map above.
 */
const seed = async (family, { id = SEEDED[family], document = {}, deleted = false } = {}) => {
  const { table, json } = byFamily[family];
  const required = REQUIRED_COLUMNS[family];
  const columns = ['id', ...Object.keys(required), json, 'deleted'];
  const values = [id, ...Object.values(required), JSON.stringify(document), deleted];
  await query(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  );
};

// The stored pair as the RESOLVERS read it: `->>` yields SQL NULL for an absent
// key and for a JSON null alike, which is the point — each family's clear lands
// one shape or the other (decks write `imageModelId: null`; the series/universe
// sanitizers drop the key outright) and both mean the same thing to
// `recordRenderPin`, to this module's own scan filter, and to every enqueue site.
const storedPin = async (family) => {
  const { table, json } = byFamily[family];
  const { rows } = await query(
    `SELECT ${json} ->> 'imageMode' AS mode, ${json} ->> 'imageModelId' AS model
       FROM ${table} WHERE id = $1${family === 'deck' ? '::uuid' : '::text'}`,
    [SEEDED[family]],
  );
  return rows[0];
};

// Only the ids this suite seeded — portos_test is shared with 46 other suites,
// and asserting on the whole scan would couple this file to their cleanup.
const SEEDED_PIN_IDS = new Set(Object.entries(SEEDED).map(([family, id]) => `record:${family}:${id}`));
const pinIds = async () => (await collectRecordPins())
  .map((pin) => pin.id)
  .filter((id) => SEEDED_PIN_IDS.has(id));
const cloudPin = { imageMode: 'codex', imageModelId: 'gpt-4o' };

beforeEach(async () => { if (ready) await cleanup(); });
afterAll(async () => {
  if (ready) await cleanup();
  await close();
});

describe.skipIf(!ready)('per-record model-pin scan', () => {
  it('reads the pin out of every family\'s own table and column', async () => {
    // A table or JSON column renamed out from under a family fails HERE, rather
    // than as a section of the audit that is silently empty on a real install.
    for (const family of Object.keys(SEEDED)) await seed(family, { document: cloudPin });

    expect((await pinIds()).sort()).toEqual([...SEEDED_PIN_IDS].sort());
  });

  it('returns only rows that carry a pin and are still live', async () => {
    await seed('universe', { document: cloudPin });
    await seed('series', { document: { name: 'Unpinned' } });
    await seed('sprite', { document: { name: 'Mode only', imageMode: 'codex' } });
    await seed('deck', { document: cloudPin, deleted: true });

    expect(await pinIds()).toEqual([`record:universe:${SEEDED.universe}`]);
  });

  it('clears a pin back to inherit and leaves the backend choice intact', async () => {
    await seed('deck', { document: cloudPin });

    const [pin] = await collectRecordPins();
    await clearRecordPin(pin);

    // Back to inherit, with the backend choice untouched — `imageMode` is a
    // separate decision the user did not ask to undo.
    expect(await storedPin('deck')).toEqual({ mode: 'codex', model: null });
    expect(await pinIds()).toEqual([]);
  });
});
