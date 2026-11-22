import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { zodToOpenApiSchema } from './apiContractSchemas.js';
import {
  browserVaultFillSchema,
  browserVaultListInputSchema,
  normalizeLoginOrigin,
  websiteLoginCreateSchema,
  websiteLoginUpdateSchema,
} from './websiteLoginValidation.js';

const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const base = { label: 'Example portal', origins: ['https://example.com'], username: 'alice@example.com', password: 'correct horse' };

describe('normalizeLoginOrigin', () => {
  it.each([
    ['https://Example.COM', 'https://example.com'],
    ['https://example.com:443/login?next=/', 'https://example.com'],
    ['http://192.0.2.10:8080/app', 'http://192.0.2.10:8080'],
    ['https://example.com:8443', 'https://example.com:8443'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeLoginOrigin(input)).toBe(expected);
  });

  it.each([
    ['a bare hostname', 'example.com'],
    ['a non-http scheme', 'ftp://example.com'],
    ['javascript:', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/html,hi'],
    ['embedded credentials', 'https://user:pass@example.com'],
    ['an empty string', '   '],
  ])('refuses %s', (_label, input) => {
    expect(normalizeLoginOrigin(input)).toBeNull();
  });
});

describe('websiteLoginCreateSchema', () => {
  it('normalizes and de-duplicates origins', () => {
    const parsed = websiteLoginCreateSchema.parse({ ...base, origins: ['https://example.com/login', 'https://EXAMPLE.com', 'https://id.example.com'] });
    expect(parsed.origins).toEqual(['https://example.com', 'https://id.example.com']);
  });

  it('accepts an empty or valid TOTP setup key and rejects an invalid one without echoing it', () => {
    expect(websiteLoginCreateSchema.safeParse({ ...base, totpSecret: '' }).success).toBe(true);
    expect(websiteLoginCreateSchema.safeParse({ ...base, totpSecret: SEED }).success).toBe(true);
    const bad = websiteLoginCreateSchema.safeParse({ ...base, totpSecret: 'NOT!A!SEED' });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error.issues)).not.toContain('NOT!A!SEED');
  });

  it('requires at least one valid origin', () => {
    expect(websiteLoginCreateSchema.safeParse({ ...base, origins: [] }).success).toBe(false);
    expect(websiteLoginCreateSchema.safeParse({ ...base, origins: ['example.com'] }).success).toBe(false);
  });
});

describe('websiteLoginUpdateSchema', () => {
  it('lets null clear the TOTP seed and keeps absent keys absent', () => {
    expect(websiteLoginUpdateSchema.parse({ totpSecret: null })).toEqual({ totpSecret: null });
    expect(websiteLoginUpdateSchema.parse({ label: 'Renamed' })).toEqual({ label: 'Renamed' });
  });
});

describe('tool input schemas survive the JSON Schema round trip', () => {
  it.each([
    ['fill', browserVaultFillSchema, { targetId: 'ABC123', loginId: '00000000-0000-4000-8000-000000000002', fields: ['password'], selectors: { password: '#pw' } }],
    ['list', browserVaultListInputSchema, { origin: 'https://example.com' }],
  ])('%s', (_name, schema, sample) => {
    const roundTripped = z.fromJSONSchema(zodToOpenApiSchema(schema));
    expect(roundTripped.parse(sample)).toEqual(sample);
    expect(roundTripped.safeParse({ ...sample, extra: true }).success).toBe(false);
  });
});
