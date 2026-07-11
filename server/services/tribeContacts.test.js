import { describe, it, expect } from 'vitest';
import { buildPersonMatchIndex } from '../lib/tribeMatch.js';
import {
  matchContactToPerson,
  computePhoneEmailFill,
} from './tribeContacts.js';

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
