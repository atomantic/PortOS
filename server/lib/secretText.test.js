import { afterEach, describe, expect, it } from 'vitest';
import {
  clearEphemeralSecrets, registerEphemeralSecret, scrubEphemeralSecrets, scrubEphemeralSecretsDeep, scrubSecretTokens, scrubSecretTokensDeep,
} from './secretText.js';

describe('scrubSecretTokens', () => {
  it('redacts well-known credential shapes by value', () => {
    const cases = [
      'queued with sk-abcdefghijklmnopqrstuvwx set',
      'sk-ant-api03-abcdefghijklmnop1234 pasted',
      'push with ghp_abcdefghijklmnopqrstuv please',
      'github_pat_11ABCDEFGHIJKLMNOPQRST_more',
      'slack xoxb-1234567890-abcdefghij done',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdef123456 here',
      'aws AKIAIOSFODNN7EXAMPLE key',
      'header Authorization: Bearer abcdef1234567890abcdef',
      `hex ${'a1'.repeat(30)} blob`,
    ];
    for (const text of cases) {
      expect(scrubSecretTokens(text), text).toContain('[REDACTED]');
    }
  });

  it('leaves prose, git SHAs, and short ids untouched', () => {
    const sha = 'a'.repeat(40);
    const cases = [
      'Ran scheduled task branch-reconcile on demand',
      `merged commit ${sha} to main`,
      'task-mtiw9qyv finished with rating 4',
      'set threshold to 12345678',
    ];
    for (const text of cases) {
      expect(scrubSecretTokens(text), text).toBe(text);
    }
  });

  it('passes non-strings and empty strings through', () => {
    expect(scrubSecretTokens(null)).toBeNull();
    expect(scrubSecretTokens(42)).toBe(42);
    expect(scrubSecretTokens('')).toBe('');
  });
});

describe('scrubSecretTokensDeep', () => {
  it('scrubs string values through nested objects and arrays', () => {
    expect(scrubSecretTokensDeep({
      prompt: 'deploy with sk-abcdefghijklmnopqrstuvwx now',
      nested: { notes: ['fine', 'token ghp_abcdefghijklmnopqrstuv here'] },
      count: 3,
      flag: true,
    })).toEqual({
      prompt: 'deploy with [REDACTED] now',
      nested: { notes: ['fine', 'token [REDACTED] here'] },
      count: 3,
      flag: true,
    });
  });

  it('leaves non-plain objects and primitives alone', () => {
    const when = new Date(0);
    expect(scrubSecretTokensDeep(when)).toBe(when);
    expect(scrubSecretTokensDeep(null)).toBeNull();
    expect(scrubSecretTokensDeep(7)).toBe(7);
  });
});

describe('ephemeral literal secrets', () => {
  afterEach(() => clearEphemeralSecrets());

  it('redacts a registered literal in both scrubbers until its TTL lapses', () => {
    const now = Date.now();
    expect(registerEphemeralSecret('hunter2-example', { ttlMs: 1_000, now })).toBe(true);
    expect(scrubSecretTokens('typed hunter2-example into the form')).toBe('typed [REDACTED] into the form');
    expect(scrubEphemeralSecretsDeep({ rows: [{ value: 'hunter2-example' }], count: 1 }))
      .toEqual({ rows: [{ value: '[REDACTED]' }], count: 1 });
    clearEphemeralSecrets();
    registerEphemeralSecret('hunter2-example', { ttlMs: 1, now: now - 10 });
    expect(scrubEphemeralSecrets('hunter2-example')).toBe('hunter2-example');
  });

  it('touches only registered literals in the literal-only pass', () => {
    registerEphemeralSecret('482913', { ttlMs: 60_000 });
    const text = 'code 482913 and key sk-abcdefghijklmnopqrstuvwx';
    expect(scrubEphemeralSecrets(text)).toBe('code [REDACTED] and key sk-abcdefghijklmnopqrstuvwx');
  });

  it('redacts the longest literal first so a containing secret is removed whole', () => {
    registerEphemeralSecret('4829', { ttlMs: 60_000 });
    registerEphemeralSecret('pass4829word', { ttlMs: 60_000 });
    expect(scrubEphemeralSecrets('pass4829word / 4829')).toBe('[REDACTED] / [REDACTED]');
  });

  it('refuses literals too short to scrub safely or without a TTL', () => {
    expect(registerEphemeralSecret('abc', { ttlMs: 60_000 })).toBe(false);
    expect(registerEphemeralSecret('long-enough', { ttlMs: 0 })).toBe(false);
    expect(registerEphemeralSecret(12345678, { ttlMs: 60_000 })).toBe(false);
    expect(scrubEphemeralSecrets('abc long-enough')).toBe('abc long-enough');
  });
});

describe('ephemeral secret TTLs', () => {
  afterEach(() => clearEphemeralSecrets());

  it('never lets a re-registration shorten an existing expiry', () => {
    const now = Date.now();
    registerEphemeralSecret('pw-kept-longer-0071', { ttlMs: 60_000, now });
    registerEphemeralSecret('pw-kept-longer-0071', { ttlMs: 1, now: now - 10 });
    expect(scrubEphemeralSecrets('pw-kept-longer-0071')).toBe('[REDACTED]');
  });
});
