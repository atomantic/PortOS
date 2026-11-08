import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { recordEvents } from '../../services/humanActivity.js';
import { spotifyListenCandidate } from '../../services/spotifySync.js';
import { spotifyRecordToCandidate } from '../../services/spotifyImport.js';
import { up } from './029-spotify-live-keys-whole-second.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('db-migrations/029-spotify-live-keys-whole-second.db.test', health.connected, 'disposable PostgreSQL unavailable');

const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
const track = (n) => `t${nonce}${n}`;
const live = (n, ms = '123') => spotifyListenCandidate({ played_at: `2024-03-10T15:30:00.${ms}Z`, track: { id: track(n), name: 'Song' } });
const imported = (n) => spotifyRecordToCandidate({ ts: '2024-03-10T15:30:00Z', ms_played: 1000, master_metadata_track_name: 'Song', spotify_track_uri: `spotify:track:${track(n)}` });
const keysFor = async (n) => (await query("SELECT dedupe_key FROM human_activity_events WHERE source = 'spotify' AND dedupe_key LIKE $1", [`%:${track(n)}`])).rows.map((r) => r.dedupe_key);
const insertRaw = (source, key) => query(
  "INSERT INTO human_activity_events (id, source, kind, happened_at, dedupe_key) VALUES ($1, $2, 'media.listen', NOW(), $3)",
  [randomUUID(), source, key],
);

afterAll(async () => {
  if (runDb) {
    await query("DELETE FROM human_activity_events WHERE dedupe_key LIKE $1", [`%${nonce}%`]);
    await close();
  }
});

describe.skipIf(!runDb)('spotify whole-second keys (#15309)', () => {
  it('live then import stores one row; import then live stores one row', async () => {
    await recordEvents([live(1)]);
    await recordEvents([imported(1)]);
    expect(await keysFor(1)).toHaveLength(1);
    await recordEvents([imported(2)]);
    await recordEvents([live(2)]);
    expect(await keysFor(2)).toHaveLength(1);
  });

  it('migration collapses pairs, re-keys unpaired rows, ignores other sources, and is idempotent', async () => {
    const legacyKey = (n, ms) => `spotify:2024-03-10T15:30:00.${ms}Z:${track(n)}`;
    const floored = (n) => `spotify:2024-03-10T15:30:00.000Z:${track(n)}`;
    await insertRaw('spotify', legacyKey(3, '123'));
    await insertRaw('spotify', floored(3));
    await insertRaw('spotify', legacyKey(4, '456'));
    await insertRaw('spotify', legacyKey(5, '111'));
    await insertRaw('spotify', legacyKey(5, '222'));
    const otherSource = `other-${nonce}`;
    await insertRaw(otherSource, legacyKey(6, '789'));

    for (let i = 0; i < 2; i++) await withTransaction((client) => up(client));

    expect(await keysFor(3)).toEqual([floored(3)]);
    expect(await keysFor(4)).toEqual([floored(4)]);
    expect(await keysFor(5)).toEqual([floored(5)]);
    const { rows } = await query('SELECT dedupe_key FROM human_activity_events WHERE source = $1', [otherSource]);
    expect(rows.map((r) => r.dedupe_key)).toEqual([legacyKey(6, '789')]);
    await query('DELETE FROM human_activity_events WHERE source = $1', [otherSource]);
  });
});
