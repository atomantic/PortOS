import { describe, it, expect } from 'vitest';
import {
  contactDisplayName,
  normalizeContactRecord,
  mergeContacts,
  buildContactIndex,
  resolveHandleAgainstContacts,
} from './contactsSync.js';

// Fixtures use reserved NANP 555 numbers only — never real contact data.

describe('contactsSync pure helpers', () => {
  describe('contactDisplayName', () => {
    it('prefers first + last over organization', () => {
      expect(contactDisplayName({
        firstName: 'Jane',
        lastName: 'Doe',
        organization: 'Acme',
      })).toBe('Jane Doe');
    });

    it('falls back to organization for company contacts', () => {
      expect(contactDisplayName({ organization: 'Acme Repair Co' })).toBe('Acme Repair Co');
    });

    it('uses nickname when no first/last', () => {
      expect(contactDisplayName({ nickname: 'Skip' })).toBe('Skip');
    });
  });

  describe('normalizeContactRecord', () => {
    it('normalizes phones and emails', () => {
      const c = normalizeContactRecord({
        id: '1',
        uniqueId: 'u1',
        firstName: 'Alex',
        lastName: 'Example',
        phones: ['15551234567', '+1 (555) 123-4567'],
        emails: ['Alex@Example.COM'],
      });
      expect(c.phones).toEqual(['+15551234567']);
      expect(c.emails).toEqual(['alex@example.com']);
      expect(c.displayName).toBe('Alex Example');
    });

    it('returns null when empty', () => {
      expect(normalizeContactRecord({ phones: [], emails: [] })).toBeNull();
    });
  });

  describe('mergeContacts + resolve', () => {
    it('dedupes across sources by phone', () => {
      const merged = mergeContacts([
        [{ uniqueId: 'a', firstName: 'Jane', phones: ['5551234567'], emails: [] }],
        [{ uniqueId: 'b', firstName: 'Jane', lastName: 'Doe', phones: ['+1 555 123 4567'], emails: ['jane@x.com'] }],
      ]);
      expect(merged).toHaveLength(1);
      expect(merged[0].emails).toContain('jane@x.com');
      expect(merged[0].phones).toEqual(['+15551234567']);
    });

    it('resolves handle against contact index', () => {
      const contacts = mergeContacts([[
        { uniqueId: '1', firstName: 'Pat', lastName: 'Lee', phones: ['+1 (555) 987-6543'], emails: [] },
      ]]);
      const index = buildContactIndex(contacts);
      const hit = resolveHandleAgainstContacts('5559876543', index);
      expect(hit.displayName).toBe('Pat Lee');
      expect(hit.source).toBe('contacts');
      expect(resolveHandleAgainstContacts('+19999999999', index)).toBeNull();
    });
  });
});
