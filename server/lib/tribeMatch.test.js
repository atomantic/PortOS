import { describe, it, expect } from 'vitest';
import {
  normalizeIdentifier,
  buildPersonMatchIndex,
  matchPerson,
  matchPeople,
} from './tribeMatch.js';

const PEOPLE = [
  { id: 'ada', name: 'Ada Lovelace', emails: ['ada@work.com', 'ADA@home.com'] },
  { id: 'grace', name: 'Grace Hopper', emails: ['grace@navy.mil'] },
  // Two people share the first name "Sam" — an ambiguous name must not resolve.
  { id: 'sam1', name: 'Sam', emails: [] },
  { id: 'sam2', name: 'Sam', emails: [] },
  { id: 'lin', name: 'Lin', emails: [] },
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
    it('drops unmatched and empty identities', () => {
      const ids = matchPeople([null, '', { email: 'x@x.com' }, { name: 'Sam' }], index);
      expect(ids.size).toBe(0);
    });
  });
});
