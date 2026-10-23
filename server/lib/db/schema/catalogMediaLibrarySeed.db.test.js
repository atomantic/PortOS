/**
 * Postgres-backed test for the boot-time `catalog_ingredient_media.library`
 * classification (#12992). `ensureSchema` adds the column nullable, seeds every
 * NULL row with four ordered UPDATEs, then sets DEFAULT '{}' and NOT NULL. The
 * statements are selected from the shipped `catalogDdl` (not copied) and run
 * against a transaction-local temp table, so the shared `portos_test` schema is
 * never altered.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { checkHealth, close, withTransaction } from '../../db.js';
import { requireDbOrSkip } from '../../dbTestGate.js';
import { catalogDdl } from './catalog.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (health.connected) dbReady = true;
  else skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
}
const runDb = requireDbOrSkip('lib/db/schema/catalogMediaLibrarySeed.db.test', dbReady, skipReason);

const SEED_PREFIX = 'UPDATE catalog_ingredient_media SET library';
const seedStatements = catalogDdl.filter((sql) => sql.startsWith(SEED_PREFIX));
const defaultStatement = catalogDdl.find((sql) => /ALTER COLUMN library SET DEFAULT/.test(sql));
const notNullStatement = catalogDdl.find((sql) => /ALTER COLUMN library SET NOT NULL/.test(sql));

afterAll(async () => {
  if (dbReady) await close();
});

const LONG_ID = 'w'.repeat(80);
const LONG_ROLE = `look:${LONG_ID}`;
const SHEET_ROLE = 'Character-SHEET front';
const EDITED = { tags: ['edited'], guide: false };

// [media_key, kind, role, deleted (false = live), library]
const ROWS = [
  ['live-portrait', 'portrait', null, false, null],
  ['deleted-portrait', 'portrait', null, true, null],
  ['null-deleted-portrait', 'portrait', null, null, null],
  ['long-look', 'reference', LONG_ROLE, false, null],
  ['bare-look', 'reference', 'look:', false, null],
  ['sheet', 'reference', SHEET_ROLE, false, null],
  ['sheet-portrait-kind', 'still', SHEET_ROLE, false, null],
  ['live-portrait-look', 'portrait', 'look:casual', false, null],
  ['other', 'reference', 'plain', false, null],
  ['edited-live-portrait', 'portrait', null, false, EDITED],
  ['empty-live-portrait', 'portrait', 'look:x', false, {}],
];

async function withSeededTable(fn) {
  await withTransaction(async (client) => {
    // pg_temp first so the unqualified statements hit the shadow table.
    await client.query('SET LOCAL search_path = pg_temp');
    await client.query(`CREATE TEMP TABLE catalog_ingredient_media (
      ingredient_id text NOT NULL DEFAULT 'ing', media_key text NOT NULL, kind text NOT NULL,
      role text, deleted boolean, library jsonb
    ) ON COMMIT DROP`);
    for (const [key, kind, role, deleted, library] of ROWS) {
      await client.query(
        'INSERT INTO catalog_ingredient_media (media_key, kind, role, deleted, library) VALUES ($1, $2, $3, $4, $5::jsonb)',
        [key, kind, role, deleted, library === null ? null : JSON.stringify(library)],
      );
    }
    await fn(client);
  });
}

const snapshot = async (client) => {
  const { rows } = await client.query('SELECT media_key, library FROM catalog_ingredient_media ORDER BY media_key');
  return Object.fromEntries(rows.map((r) => [r.media_key, r.library]));
};

describe.skipIf(!runDb)('catalog_ingredient_media.library boot seed (#12992)', () => {
  it('selects the shipped statements in classification order', () => {
    expect(seedStatements).toHaveLength(4);
    expect(seedStatements[0]).toContain(`'{"guide": true}'`);
    expect(seedStatements[1]).toContain("LIKE 'look:_%'");
    expect(seedStatements[2]).toContain("ILIKE '%sheet%'");
    expect(seedStatements[3]).toContain("'{}'::jsonb WHERE library IS NULL");
    expect(defaultStatement).toBeTruthy();
    expect(notNullStatement).toBeTruthy();
    expect(catalogDdl.indexOf(seedStatements[3])).toBeLessThan(catalogDdl.indexOf(defaultStatement));
    expect(catalogDdl.indexOf(defaultStatement)).toBeLessThan(catalogDdl.indexOf(notNullStatement));
  });

  it('classifies each NULL row, leaves edited rows alone, and is idempotent', async () => {
    await withSeededTable(async (client) => {
      for (const sql of seedStatements) await client.query(sql);
      const seeded = await snapshot(client);

      expect(seeded['live-portrait']).toEqual({ guide: true });
      expect(seeded['deleted-portrait']).toEqual({});
      expect(seeded['null-deleted-portrait']).toEqual({});
      expect(seeded['long-look']).toEqual({
        variant: { wardrobeId: LONG_ID.slice(0, 59), label: LONG_ROLE.slice(0, 120) },
      });
      expect(seeded['long-look'].guide).toBeUndefined();
      expect(seeded['bare-look']).toEqual({});
      expect(seeded.sheet).toEqual({ variant: { label: SHEET_ROLE } });
      expect(seeded.sheet['variant'].wardrobeId).toBeUndefined();
      // The sheet predicate is limited to kind = 'reference'.
      expect(seeded['sheet-portrait-kind']).toEqual({});
      // First update wins: a live portrait that is also a look is only a guide.
      expect(seeded['live-portrait-look']).toEqual({ guide: true });
      expect(seeded.other).toEqual({});
      expect(seeded['edited-live-portrait']).toEqual(EDITED);
      expect(seeded['empty-live-portrait']).toEqual({});

      for (const sql of seedStatements) await client.query(sql);
      expect(await snapshot(client)).toEqual(seeded);
    });
  });

  it('applies DEFAULT and NOT NULL after the seed without touching existing libraries', async () => {
    await withSeededTable(async (client) => {
      for (const sql of seedStatements) await client.query(sql);
      const seeded = await snapshot(client);
      await client.query(defaultStatement);
      await client.query(notNullStatement);

      await client.query("INSERT INTO catalog_ingredient_media (media_key, kind) VALUES ('omitted', 'portrait')");
      const after = await snapshot(client);
      expect(after.omitted).toEqual({});
      delete after.omitted;
      expect(after).toEqual(seeded);
    });
  });
});
