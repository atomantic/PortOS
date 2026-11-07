/**
 * Postgres-backed proof that blocking an iMessage handle with `purgeExisting`
 * erases its activity events AND the chat's `imsg:<chat>:<day>` Tribe
 * touchpoints (with their audit snapshots) in one transaction, including for a
 * handle that was already on the blocklist (#15171).
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`.
 * Placeholder data with a per-run nonce; the blocklist file is redirected to a
 * temp data root so the install's real blocklist is never touched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { createTempDataRoot } from '../lib/mockPathsDataRoot.js';

const root = vi.hoisted(() => ({ dir: '' }));
vi.mock('../lib/fileUtils.js', async (original) => ({ ...await original(), dataPath: (...parts) => join(root.dir, ...parts) }));

import * as humanActivity from './humanActivity.js';
import * as tribe from './tribe.js';
import { imessageActivityCandidate } from './imessageSync.js';
import { addToBlocklist, readBlocklist } from './imessageManage.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    dbReady = true;
  }
}
const runDb = requireDbOrSkip('services/imessageManage.db.test', dbReady, skipReason);

const nonce = `imblk${Date.now()}`;
const BLOCKED = `blocked-${nonce}@example.com`;
const BLOCKED_RAW = `Blocked-${nonce}@Example.com`; // stored form differs from the normalized key
const OTHER = `other-${nonce}@example.com`;
const SOLO = `solo;${nonce}`; // 1:1 chat with the blocked handle
const GROUP = `group;${nonce}`; // blocked handle + another participant
const UNRELATED = `unrelated;${nonce}`;
const DAY = '2026-07-04';
const personIds = [];

beforeAll(() => { root.dir = createTempDataRoot('imessage-manage-db-'); });
afterAll(async () => {
  if (dbReady) {
    await query(`DELETE FROM human_activity_events WHERE source = 'imessage' AND metadata->>'chatGuid' = ANY($1::text[])`, [[SOLO, GROUP, UNRELATED]]).catch(() => {});
    if (personIds.length) {
      await query('DELETE FROM tribe_people WHERE id = ANY($1::uuid[])', [personIds]).catch(() => {});
      await query(`DELETE FROM record_audit WHERE table_name = 'tribe_touchpoints' AND row_snapshot->>'person_id' = ANY($1::text[])`, [personIds]).catch(() => {});
    }
    await close();
  }
  rmSync(root.dir, { recursive: true, force: true });
});

const count = async (sql, params) => Number((await query(sql, params)).rows[0].n);
const chatEvents = (chatGuid) => count(`SELECT COUNT(*) AS n FROM human_activity_events WHERE source = 'imessage' AND metadata->>'chatGuid' = $1`, [chatGuid]);
const chatTouchpoints = (chatGuid) => count(`SELECT COUNT(*) AS n FROM tribe_touchpoints WHERE person_id = $1 AND dedupe_key = $2`, [personIds[0], `imsg:${chatGuid}:${DAY}`]);

async function seed() {
  if (!personIds.length) {
    const person = await tribe.createPerson({ name: `Example Person ${nonce}`, emails: [`p-${nonce}@example.com`] });
    personIds.push(person.id);
  }
  const at = new Date('2026-07-04T15:00:00Z');
  const msg = (n, chatGuid, fields) => imessageActivityCandidate({ guid: `${nonce}-${n}`, at, text: 'Example text', service: 'iMessage', chatGuid, chatName: 'Example chat', ...fields });
  await humanActivity.recordEvents([
    msg('s1', SOLO, { isFromMe: false, handle: BLOCKED_RAW, participants: [BLOCKED_RAW] }),
    msg('s2', SOLO, { isFromMe: true, handle: '', participants: [BLOCKED_RAW] }),
    msg('g1', GROUP, { isFromMe: false, handle: BLOCKED_RAW, participants: [BLOCKED_RAW, OTHER] }),
    msg('g2', GROUP, { isFromMe: false, handle: OTHER, participants: [BLOCKED_RAW, OTHER] }),
    msg('g3', GROUP, { isFromMe: true, handle: '', participants: [BLOCKED_RAW, OTHER] }),
    msg('u1', UNRELATED, { isFromMe: false, handle: OTHER, participants: [OTHER] }),
  ]);
  for (const chatGuid of [SOLO, GROUP, UNRELATED]) {
    await tribe.autoCreateTouchpoint(personIds[0], { happenedAt: at.toISOString(), channel: 'iMessage', summary: 'Example chat', source: 'imessage', dedupeKey: `imsg:${chatGuid}:${DAY}` });
  }
}

describe.skipIf(!runDb)('addToBlocklist purgeExisting (#15171)', () => {
  it('erases the blocked handle\'s events and now-empty chat touchpoints, sparing chats that still hold other people\'s events', async () => {
    await seed();
    const result = await addToBlocklist([BLOCKED], { purgeExisting: true });
    expect(result).toMatchObject({ added: [BLOCKED], purged: 3, touchpoints: 1 });
    expect(await chatEvents(SOLO)).toBe(0); // received + from-me (all participants blocked)
    expect(await chatTouchpoints(SOLO)).toBe(0);
    expect(await chatEvents(GROUP)).toBe(2); // OTHER's message + the from-me message that includes OTHER
    expect(await chatTouchpoints(GROUP)).toBe(1);
    expect(await chatEvents(UNRELATED)).toBe(1);
    expect(await chatTouchpoints(UNRELATED)).toBe(1);
  });

  it('purges again for a handle that is already blocklisted (cleans up rows that leaked in later)', async () => {
    await seed(); // dedupe keys make this re-insert the rows the first purge removed
    expect((await readBlocklist()).handles).toContain(BLOCKED);
    const result = await addToBlocklist([BLOCKED], { purgeExisting: true });
    expect(result.added).toEqual([]);
    expect(result.purged).toBeGreaterThan(0);
    expect(await chatEvents(SOLO)).toBe(0);
    expect(await chatTouchpoints(SOLO)).toBe(0);
  });
});
