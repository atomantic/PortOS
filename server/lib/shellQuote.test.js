import { describe, it, expect } from 'vitest';
import { shellQuote } from './shellQuote.js';

describe('shellQuote', () => {
  it('passes bare-safe tokens through unquoted', () => {
    expect(shellQuote('claim/issue-1814')).toBe('claim/issue-1814');
    expect(shellQuote('main')).toBe('main');
    expect(shellQuote('feature_v2.1')).toBe('feature_v2.1');
    expect(shellQuote('a:b=c+d-e/f')).toBe('a:b=c+d-e/f');
  });

  it('single-quotes values containing shell metacharacters', () => {
    expect(shellQuote('weird;rm -rf')).toBe("'weird;rm -rf'");
    expect(shellQuote('a b')).toBe("'a b'");
    expect(shellQuote('$(whoami)')).toBe("'$(whoami)'");
    expect(shellQuote('back`tick`')).toBe("'back`tick`'");
  });

  it('escapes embedded single quotes with the POSIX \'\\\'\' sequence', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('stringifies null/undefined to an empty quoted string', () => {
    expect(shellQuote(null)).toBe("''");
    expect(shellQuote(undefined)).toBe("''");
  });
});
