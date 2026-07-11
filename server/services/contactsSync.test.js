import { describe, it, expect } from 'vitest';
import {
  contactDisplayName,
  normalizeContactRecord,
  mergeContacts,
  buildContactIndex,
  resolveHandleAgainstContacts,
} from './contactsSync.js';

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
      expect(contactDisplayName({ organization: 'LG Repair Guy' })).toBe('LG Repair Guy');
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
        firstName: 'Aiden',
        lastName: 'Eller',
        phones: ['12062951558', '+1 (206) 295-1558'],
        emails: ['Aiden@Example.COM'],
      });
      expect(c.phones).toEqual(['+12062951558']);
      expect(c.emails).toEqual(['aiden@example.com']);
      expect(c.displayName).toBe('Aiden Eller');
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
        { uniqueId: '1', firstName: 'Jen', lastName: 'McD', phones: ['+1 (206) 293-8313'], emails: [] },
      ]]);
      const index = buildContactIndex(contacts);
      const hit = resolveHandleAgainstContacts('2062938313', index);
      expect(hit.displayName).toBe('Jen McD');
      expect(hit.source).toBe('contacts');
      expect(resolveHandleAgainstContacts('+19999999999', index)).toBeNull();
    });
  });
});
