import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { up } from './038-compact-music-video-review-records.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('db-migrations/038-compact-music-video-review-records.db.test', health.connected, 'disposable PostgreSQL unavailable');

const ids = { old: `mv-compact-old-${randomUUID()}`, current: `mv-compact-current-${randomUUID()}`, bare: `mv-compact-bare-${randomUUID()}` };
const stamp = '2026-01-01T00:00:00.000Z';
const lock = { approvedAt: stamp, basis: 'still-1', v: 2, reviewer: 'director', fromBoardApproval: true };
const approval = { stage: 'storyboard', basis: 'board-1', inputs: { shots: 'hash' }, values: { shots: 'text' } };
const ownLock = { approvedAt: stamp, basis: 'still-2', v: 2 };
// A lock written before shot locks were compacted: the whole board approval copied into it.
const records = {
  old: { updatedAt: stamp, scenes: [{ sceneId: 's1', takes: [{ takeId: 't1', promptLines: [0] }] }], takePromptPool: ['A take prompt'],
    productionReview: { approvals: { storyboard: approval }, shotApprovals: { s1: { ...approval, ...lock }, s2: ownLock } } },
  current: { updatedAt: stamp, productionReview: { approvals: { storyboard: approval }, shotApprovals: { s1: lock } } },
  bare: { updatedAt: stamp },
};

const stored = async (id) => (await query('SELECT data, updated_at, xmin::text AS version FROM music_video_projects WHERE id = $1', [id])).rows[0];

describe.skipIf(!runDb)('db-migration 038 - compact music video review records', () => {
  afterAll(async () => {
    await query('DELETE FROM music_video_projects WHERE id = ANY($1)', [Object.values(ids)]);
    await close();
  });

  it('removes the copied board approval from shot locks and leaves everything else as stored', async () => {
    for (const [name, data] of Object.entries(records)) {
      await query('INSERT INTO music_video_projects (id, data, created_at, updated_at) VALUES ($1, $2::jsonb, $3, $3)',
        [ids[name], JSON.stringify(data), stamp]);
    }
    const before = { current: await stored(ids.current), bare: await stored(ids.bare), old: await stored(ids.old) };

    await withTransaction(up);

    const old = await stored(ids.old);
    expect(old.data).toEqual({ ...records.old, productionReview: { ...records.old.productionReview, shotApprovals: { s1: lock, s2: ownLock } } });
    expect(old.updated_at).toEqual(before.old.updated_at);
    // Rows with nothing to compact are not rewritten at all.
    expect(await stored(ids.current)).toEqual(before.current);
    expect(await stored(ids.bare)).toEqual(before.bare);

    await withTransaction(up);
    expect(await stored(ids.old)).toEqual(old);
  });
});
