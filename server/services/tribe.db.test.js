/**
 * Postgres-backed proof for #8451: `tribe_people.last_contact_on` (a `DATE`)
 * must not drift by a day depending on the server process's UTC offset.
 *
 * Before the fix, node-pg had no type parser registered for `DATE` (OID 1082),
 * so it returned `last_contact_on` as a JS `Date` at LOCAL midnight. Every
 * read-modify-write of a person (`getPerson` → `updatePerson`) then re-derived
 * the date with `toISOString().slice(0, 10)`, which is the PREVIOUS calendar
 * day on any server east of UTC (e.g. Europe/Berlin) — so saving a person's
 * notes silently aged their last-contact date by one day, every time.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`
 * (registered in vitest.config.db.js). Every assertion is scoped to this run's
 * own ids so concurrent suites sharing the test DB are unaffected. Fixtures use
 * placeholder names and handles only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import * as tribe from './tribe.js';

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
const runDb = requireDbOrSkip('services/tribe.db.test', dbReady, skipReason);

const nonce = `tribedate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdPersonIds = [];

afterAll(async () => {
  if (!dbReady) return;
  if (createdPersonIds.length) {
    await query('DELETE FROM tribe_people WHERE id = ANY($1::uuid[])', [createdPersonIds]).catch(() => {});
  }
  await close();
});

// Force the process onto a UTC+ timezone (matching the acceptance criterion) so
// this test reproduces the drift the un-registered DATE type parser caused,
// regardless of the machine actually running the suite.
let originalTZ;
beforeAll(() => {
  originalTZ = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
});
afterAll(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

describe.skipIf(!runDb)('tribe last_contact_on — UTC-offset round-trip (#8451)', () => {
  it('leaves last_contact_on unchanged across a read-modify-write that never touches it', async () => {
    const person = await tribe.createPerson({ name: `Example Person ${nonce}` });
    createdPersonIds.push(person.id);
    await tribe.createTouchpoint(person.id, { happenedAt: '2026-06-15T12:00:00.000Z', channel: 'call' });

    const before = await tribe.getPerson(person.id);
    expect(before.lastContact).toBe('2026-06-15');

    // A save that never mentions lastContact must not perturb it — this is
    // exactly the updatePerson(id, { notes }) path #8451 flagged.
    const updated = await tribe.updatePerson(person.id, { notes: 'updated notes' });
    expect(updated.lastContact).toBe('2026-06-15');

    const after = await tribe.getPerson(person.id);
    expect(after.lastContact).toBe('2026-06-15');
  });

  it('stores the raw YYYY-MM-DD DATE value as a string, not a JS Date at local midnight', async () => {
    const person = await tribe.createPerson({ name: `Example Person ${nonce}-raw` });
    createdPersonIds.push(person.id);
    await tribe.createTouchpoint(person.id, { happenedAt: '2026-03-01T08:00:00.000Z', channel: 'call' });

    const { rows } = await query('SELECT last_contact_on FROM tribe_people WHERE id = $1', [person.id]);
    expect(typeof rows[0].last_contact_on).toBe('string');
    expect(rows[0].last_contact_on).toBe('2026-03-01');
  });
});
