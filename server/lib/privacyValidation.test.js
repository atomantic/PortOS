import { describe, it, expect } from 'vitest';
import { privacyOrgCreateSchema, privacyOrgUpdateSchema } from './privacyValidation.js';

describe('privacyValidation — org website/portalUrl safe-scheme guard', () => {
  describe('privacyOrgCreateSchema', () => {
    it('rejects a javascript: website URL', () => {
      const result = privacyOrgCreateSchema.safeParse({ name: 'X', website: 'javascript:alert(1)' });
      expect(result.success).toBe(false);
      expect(result.error.issues.some((i) => i.path.join('.') === 'website' && i.message === 'must be an http(s) URL')).toBe(true);
    });

    it('accepts a valid https website URL', () => {
      const result = privacyOrgCreateSchema.safeParse({ name: 'X', website: 'https://ok.com' });
      expect(result.success).toBe(true);
      expect(result.data.website).toBe('https://ok.com');
    });

    it('accepts an absent website field (optional, unchanged)', () => {
      const result = privacyOrgCreateSchema.safeParse({ name: 'X' });
      expect(result.success).toBe(true);
      expect(result.data.website).toBeUndefined();
    });

    it('accepts an empty-string website (existing empty-handling preserved)', () => {
      const result = privacyOrgCreateSchema.safeParse({ name: 'X', website: '' });
      expect(result.success).toBe(true);
      expect(result.data.website).toBe('');
    });

    it('rejects a javascript: contact.portalUrl', () => {
      const result = privacyOrgCreateSchema.safeParse({
        name: 'X',
        contact: { portalUrl: 'javascript:alert(1)' },
      });
      expect(result.success).toBe(false);
      expect(result.error.issues.some((i) => i.path.join('.') === 'contact.portalUrl' && i.message === 'must be an http(s) URL')).toBe(true);
    });

    it('accepts a valid https contact.portalUrl', () => {
      const result = privacyOrgCreateSchema.safeParse({
        name: 'X',
        contact: { portalUrl: 'https://portal.ok.com' },
      });
      expect(result.success).toBe(true);
      expect(result.data.contact.portalUrl).toBe('https://portal.ok.com');
    });

    it('accepts an absent contact.portalUrl field (optional, unchanged)', () => {
      const result = privacyOrgCreateSchema.safeParse({ name: 'X', contact: { email: 'a@b.com' } });
      expect(result.success).toBe(true);
      expect(result.data.contact.portalUrl).toBeUndefined();
    });

    it('accepts an empty-string contact.portalUrl (existing empty-handling preserved)', () => {
      const result = privacyOrgCreateSchema.safeParse({ name: 'X', contact: { portalUrl: '' } });
      expect(result.success).toBe(true);
      expect(result.data.contact.portalUrl).toBe('');
    });
  });

  describe('privacyOrgUpdateSchema', () => {
    it('rejects a javascript: website URL on partial update', () => {
      const result = privacyOrgUpdateSchema.safeParse({ website: 'data:text/html,x' });
      expect(result.success).toBe(false);
      expect(result.error.issues.some((i) => i.path.join('.') === 'website')).toBe(true);
    });

    it('accepts a valid https website URL on partial update', () => {
      const result = privacyOrgUpdateSchema.safeParse({ website: 'https://ok.com' });
      expect(result.success).toBe(true);
      expect(result.data.website).toBe('https://ok.com');
    });

    it('rejects a javascript: contact.portalUrl on partial update', () => {
      const result = privacyOrgUpdateSchema.safeParse({ contact: { portalUrl: 'vbscript:x' } });
      expect(result.success).toBe(false);
      expect(result.error.issues.some((i) => i.path.join('.') === 'contact.portalUrl')).toBe(true);
    });
  });
});
