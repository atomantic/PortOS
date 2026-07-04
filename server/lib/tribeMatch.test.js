import { describe, it, expect } from 'vitest';
import {
  normalizeIdentifier,
  normalizePhone,
  identityFromHandle,
  buildPersonMatchIndex,
  matchPerson,
  matchPeople,
} from './tribeMatch.js';

const PEOPLE = [
  { id: 'ada', name: 'Ada Lovelace', emails: ['ada@work.com', 'ADA@home.com'] },
  { id: 'grace', name: 'Grace Hopper', emails: ['grace@navy.mil'], phones: ['+1 (555) 123-4567'] },
  // Two people share the first name "Sam" — an ambiguous name must not resolve.
  { id: 'sam1', name: 'Sam', emails: [] },
  { id: 'sam2', name: 'Sam', emails: [] },
  { id: 'lin', name: 'Lin', emails: [], phones: ['5559876543'] },
];

describe('tribeMatch', () => {
  describe('normalizeIdentifier', () => {
    it('lowercases and trims', () => {
      expect(normalizeIdentifier('  Ada@Work.COM ')).toBe('ada@work.com');
    });
    it('returns empty string for nullish', () => {
      expect(normalizeIdentifier(null)).toBe('');
      expect(normalizeIdentifier(undefined)).toBe('');
    });
  });

  describe('normalizePhone', () => {
    it('passes through an explicit + country code, stripping punctuation', () => {
      expect(normalizePhone('+1 (555) 123-4567')).toBe('+15551234567');
      expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    });
    it('prefixes + on an 11-digit US number starting with 1', () => {
      expect(normalizePhone('15551234567')).toBe('+15551234567');
    });
    it('assumes +1 for a bare 10-digit NANP number', () => {
      expect(normalizePhone('555-123-4567')).toBe('+15551234567');
      expect(normalizePhone('5551234567')).toBe('+15551234567');
    });
    it('collides two spellings of the same number', () => {
      expect(normalizePhone('(555) 123 4567')).toBe(normalizePhone('+1 555 123 4567'));
    });
    it('is empty for an email or an empty/nullish value', () => {
      expect(normalizePhone('grace@navy.mil')).toBe('');
      expect(normalizePhone('')).toBe('');
      expect(normalizePhone(null)).toBe('');
    });
  });

  describe('identityFromHandle', () => {
    it('classifies an @-bearing handle as an email', () => {
      expect(identityFromHandle('Grace@Navy.mil')).toEqual({ email: 'grace@navy.mil' });
    });
    it('classifies a phone handle as an E.164 phone', () => {
      expect(identityFromHandle('+1 (555) 123-4567')).toEqual({ phone: '+15551234567' });
    });
    it('returns an empty object for a blank handle', () => {
      expect(identityFromHandle('')).toEqual({});
      expect(identityFromHandle(null)).toEqual({});
    });
  });

  describe('buildPersonMatchIndex', () => {
    it('indexes every email case-insensitively, first claimant wins', () => {
      const { byIdentifier } = buildPersonMatchIndex(PEOPLE);
      expect(byIdentifier.get('ada@work.com')).toBe('ada');
      expect(byIdentifier.get('ada@home.com')).toBe('ada');
      expect(byIdentifier.get('grace@navy.mil')).toBe('grace');
    });
    it('collects every owner of a name so ambiguity is detectable', () => {
      const { byName } = buildPersonMatchIndex(PEOPLE);
      expect(byName.get('sam')).toEqual(['sam1', 'sam2']);
      expect(byName.get('lin')).toEqual(['lin']);
    });
    it('indexes phones E.164-normalized, first claimant wins', () => {
      const { byPhone } = buildPersonMatchIndex(PEOPLE);
      expect(byPhone.get('+15551234567')).toBe('grace');
      expect(byPhone.get('+15559876543')).toBe('lin');
    });
    it('skips people without an id', () => {
      const { byIdentifier } = buildPersonMatchIndex([{ name: 'X', emails: ['x@x.com'] }]);
      expect(byIdentifier.size).toBe(0);
    });
  });

  describe('matchPerson', () => {
    const index = buildPersonMatchIndex(PEOPLE);
    it('matches by email regardless of case', () => {
      expect(matchPerson({ email: 'ADA@WORK.com' }, index)).toBe('ada');
    });
    it('falls back to an exact unique name when no email match', () => {
      expect(matchPerson({ name: 'lin' }, index)).toBe('lin');
    });
    it('matches by phone (E.164-normalized) when no email', () => {
      expect(matchPerson({ phone: '555-123-4567' }, index)).toBe('grace');
      expect(matchPerson({ phone: '+15559876543' }, index)).toBe('lin');
    });
    it('prefers email over phone', () => {
      // email → grace, phone → lin. Email wins.
      expect(matchPerson({ email: 'grace@navy.mil', phone: '5559876543' }, index)).toBe('grace');
    });
    it('refuses an ambiguous name (multiple owners)', () => {
      expect(matchPerson({ name: 'Sam' }, index)).toBeNull();
    });
    it('prefers email over name', () => {
      // email belongs to grace, name says ada — email wins.
      expect(matchPerson({ email: 'grace@navy.mil', name: 'Ada Lovelace' }, index)).toBe('grace');
    });
    it('returns null for an unknown identity', () => {
      expect(matchPerson({ email: 'nobody@x.com' }, index)).toBeNull();
      expect(matchPerson({}, index)).toBeNull();
      expect(matchPerson(null, index)).toBeNull();
    });
  });

  describe('matchPeople', () => {
    const index = buildPersonMatchIndex(PEOPLE);
    it('de-duplicates the same person appearing twice (organizer + attendee)', () => {
      const ids = matchPeople(
        [{ email: 'ada@work.com' }, { email: 'ada@home.com' }, { name: 'Ada Lovelace' }],
        index,
      );
      expect([...ids]).toEqual(['ada']);
    });
    it('accepts bare email strings as well as { email, name } objects', () => {
      const ids = matchPeople(['grace@navy.mil', { name: 'lin' }], index);
      expect(ids.has('grace')).toBe(true);
      expect(ids.has('lin')).toBe(true);
      expect(ids.size).toBe(2);
    });
    it('classifies a bare phone-handle string and matches by phone', () => {
      // A raw chat.db handle like "+15551234567" resolves to the person by phone.
      const ids = matchPeople(['+1 (555) 123-4567', '5559876543'], index);
      expect(ids.has('grace')).toBe(true);
      expect(ids.has('lin')).toBe(true);
      expect(ids.size).toBe(2);
    });
    it('drops unmatched and empty identities', () => {
      const ids = matchPeople([null, '', { email: 'x@x.com' }, { name: 'Sam' }], index);
      expect(ids.size).toBe(0);
    });
  });
});
