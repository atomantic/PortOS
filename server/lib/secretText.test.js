import { describe, expect, it } from 'vitest';
import { scrubSecretTokens, scrubSecretTokensDeep } from './secretText.js';

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
