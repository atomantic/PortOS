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

    const alice = { uniqueId: 'A', firstName: 'Alice', lastName: 'Example', organization: 'Acme', phones: ['+1 555 010 0001', '+1 555 010 9999'], emails: ['alice@example.com'] };
    const bob = { uniqueId: 'B', firstName: 'Bob', lastName: 'Example', phones: ['+1 555 010 0002', '+1 555 010 9999'], emails: [] };

    it('keeps two different people who share a phone number apart', () => {
      const out = mergeContacts([[alice, bob]]);
      expect(out).toHaveLength(2);
      const index = buildContactIndex(out);
      expect(resolveHandleAgainstContacts('+15550100002', index).displayName).toBe('Bob Example');
      expect(resolveHandleAgainstContacts('+15550100001', index).displayName).toBe('Alice Example');
      expect(resolveHandleAgainstContacts('+15550109999', index).displayName).toBe('Alice Example');
      expect(out.find((c) => c.uniqueId === 'B').phones).not.toContain('+15550100001');
    });

    it('collapses the same uniqueId even when names differ', () => {
      const out = mergeContacts([
        [{ uniqueId: 'X', firstName: 'Alice', phones: ['+15550100001'] }],
        [{ uniqueId: 'X', firstName: 'Bob', phones: ['+15550100002'] }],
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].phones).toHaveLength(2);
    });

    it('does not chain distinct people through shared phone then shared email', () => {
      const out = mergeContacts([[
        { uniqueId: 'A', firstName: 'Alice', phones: ['+15550100001'] },
        { uniqueId: 'B', firstName: 'Bob', phones: ['+15550100001'], emails: ['shared@example.com'] },
        { uniqueId: 'C', firstName: 'Carol', emails: ['shared@example.com'] },
      ]]);
      expect(out.map((c) => c.displayName)).toEqual(['Alice', 'Bob', 'Carol']);
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
