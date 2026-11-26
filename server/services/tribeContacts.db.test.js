import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkHealth, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { loadContactIndex } from './contactsSync.js';
import * as tribe from './tribe.js';
import { enrichTribeFromContacts, importContactToTribe } from './tribeContacts.js';

vi.mock('./contactsSync.js', () => ({ loadContactIndex: vi.fn() }));
vi.mock('./humanActivity.js', () => ({}));

const health = await checkHealth();
const runDb = requireDbOrSkip('services/tribeContacts.db.test', health.connected, health.error);
const prefix = `Tribe Contacts Example ${randomUUID()}`;
const originalPhone = '+12025550101';
const editedPhone = '+12025550102';
const contactPhone = '+12025550103';
const editedEmail = 'edited@example.com';
const contactEmail = 'contact@example.com';

afterAll(async () => {
  if (!runDb) return;
  try {
    await query('DELETE FROM tribe_people WHERE name LIKE $1', [`${prefix} %`]);
  } finally {
    await close();
  }
});

describe.skipIf(!runDb)('Tribe Contacts writes', () => {
  it('merges into the live identifiers and counts only records actually changed', async () => {
    const edited = await tribe.createPerson({
      name: `${prefix} Edited`,
      phones: [originalPhone],
      emails: ['original@example.com'],
    });
    const deleted = await tribe.createPerson({ name: `${prefix} Deleted` });
    const satisfied = await tribe.createPerson({ name: `${prefix} Satisfied` });
    // The contact read follows the initial Tribe snapshot. Interleave the other
    // tab's update, delete and already-applied fill at that boundary.
    loadContactIndex.mockImplementationOnce(async () => {
      await Promise.all([
        tribe.updatePerson(edited.id, { phones: [editedPhone], emails: [editedEmail] }),
        tribe.deletePerson(deleted.id),
        tribe.updatePerson(satisfied.id, { emails: ['satisfied@example.com'] }),
      ]);
      return {
        contacts: [
          { id: 'edited', displayName: edited.name, phones: [contactPhone], emails: [contactEmail] },
          { id: 'deleted', displayName: deleted.name, emails: ['deleted@example.com'] },
          { id: 'satisfied', displayName: satisfied.name, emails: ['satisfied@example.com'] },
        ],
      };
    });

    const result = await enrichTribeFromContacts();

    expect(result).toMatchObject({ matched: 3, updated: 1 });
    expect(await tribe.getPerson(edited.id)).toMatchObject({
      phones: [editedPhone, contactPhone],
      emails: [editedEmail, contactEmail],
    });
    expect(await tribe.getPerson(deleted.id)).toBeNull();
  });

  it('imports the same contact only once on concurrent requests', async () => {
    const name = `${prefix} Imported`;
    const requests = [
      importContactToTribe({ name, phones: ['(202) 555-0141'], emails: [' IMPORTED@EXAMPLE.COM '] }),
      importContactToTribe({ name, phones: ['+12025550141'], emails: ['imported@example.com'] }),
    ];
    const results = await Promise.all(requests);

    expect(results.filter((result) => result.created)).toHaveLength(1);
    const [created, duplicate] = results.sort((a, b) => Number(b.created) - Number(a.created));
    expect(duplicate).toMatchObject({ created: false, person: { id: created.person.id }, reason: 'phone-match' });
    const { rows } = await query('SELECT id FROM tribe_people WHERE name = $1 AND deleted = FALSE', [name]);
    expect(rows).toEqual([{ id: created.person.id }]);
  });
});
