import { describe, it, expect, vi } from 'vitest';
import { buildPersonMatchIndex } from '../lib/tribeMatch.js';
import { mergeContacts, buildContactIndex } from './contactsSync.js';
import { enrichTribeFromContacts } from './tribeContacts.js';
import * as tribe from './tribe.js';
import {
  matchContactToPerson,
  computePhoneEmailFill,
} from './tribeContacts.js';

vi.mock('./tribe.js', () => ({ listPeople: vi.fn(), updatePerson: vi.fn() }));
vi.mock('./humanActivity.js', () => ({}));
vi.mock('./contactsSync.js', async (orig) => {
  const actual = await orig();
  return { ...actual, loadContactIndex: vi.fn() };
});

describe('enrichTribeFromContacts with a shared household phone', () => {
  it("does not copy Bob's mobile onto Alice", async () => {
    const { loadContactIndex } = await import('./contactsSync.js');
    const contacts = mergeContacts([[
      { uniqueId: 'A', firstName: 'Alice', lastName: 'Example', phones: ['+1 555 010 0001', '+1 555 010 9999'] },
      { uniqueId: 'B', firstName: 'Bob', lastName: 'Example', phones: ['+1 555 010 0002', '+1 555 010 9999'] },
    ]]);
    loadContactIndex.mockResolvedValue({ contacts, index: buildContactIndex(contacts) });
    tribe.listPeople.mockResolvedValue([
      { id: 'p1', name: 'Alice Example', phones: ['+15550100001'], emails: [] },
    ]);
    const result = await enrichTribeFromContacts({ dryRun: true });
    const all = result.changes.flatMap((c) => c.addPhones);
    expect(all).not.toContain('+15550100002');
  });
});

describe('tribeContacts pure helpers', () => {
  const people = [
    { id: 'p1', name: 'Jane Doe', phones: [], emails: ['jane@work.com'] },
    { id: 'p2', name: 'Bob', phones: ['+15551112222'], emails: [] },
  ];
  const index = buildPersonMatchIndex(people);

  it('matches contact by email then returns person id', () => {
    const id = matchContactToPerson({
      displayName: 'Jane',
      emails: ['jane@work.com'],
      phones: ['+15559998888'],
    }, index);
    expect(id).toBe('p1');
  });

  it('matches contact by exact unique name', () => {
    const id = matchContactToPerson({
      displayName: 'Bob',
      phones: [],
      emails: [],
    }, index);
    expect(id).toBe('p2');
  });

  it('computes only missing phones/emails', () => {
    const fill = computePhoneEmailFill(
      { phones: ['+15551112222'], emails: [] },
      { phones: ['+15551112222', '+15553334444'], emails: ['bob@x.com'] },
    );
    expect(fill.addPhones).toEqual(['+15553334444']);
    expect(fill.addEmails).toEqual(['bob@x.com']);
    expect(fill.phones).toEqual(['+15551112222', '+15553334444']);
  });

  it('returns null when nothing to add', () => {
    expect(computePhoneEmailFill(
      { phones: ['+15551112222'], emails: ['bob@x.com'] },
      { phones: ['+15551112222'], emails: ['bob@x.com'] },
    )).toBeNull();
  });
});
