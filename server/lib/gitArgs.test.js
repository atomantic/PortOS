import { describe, it, expect } from 'vitest';
import { PROTECTED_BRANCHES, validateFilePaths, toLiteralPathspec } from './gitArgs.js';

describe('PROTECTED_BRANCHES', () => {
  it('lists the branches that must never be deleted', () => {
    expect(PROTECTED_BRANCHES).toEqual(['main', 'master', 'dev', 'develop', 'release']);
  });
});

describe('validateFilePaths', () => {
  it('passes through clean relative paths', () => {
    expect(validateFilePaths(['src/a.js', 'docs/b.md'])).toEqual(['src/a.js', 'docs/b.md']);
  });

  it('accepts a single string and returns an array', () => {
    expect(validateFilePaths('src/a.js')).toEqual(['src/a.js']);
  });

  it('rejects shell metacharacters and null bytes', () => {
    expect(() => validateFilePaths(['a.js; rm -rf /'])).toThrow(/Invalid character/);
    expect(() => validateFilePaths(['a.js`whoami`'])).toThrow(/Invalid character/);
    expect(() => validateFilePaths(['a.js|cat'])).toThrow(/Invalid character/);
    expect(() => validateFilePaths(['a$.js'])).toThrow(/Invalid character/);
    expect(() => validateFilePaths(['a\0.js'])).toThrow(/Invalid character/);
  });

  it('rejects absolute paths and parent-directory traversal', () => {
    expect(() => validateFilePaths(['/etc/passwd'])).toThrow(/Invalid file path/);
    expect(() => validateFilePaths(['../secrets'])).toThrow(/Invalid file path/);
    expect(() => validateFilePaths(['a/../b'])).toThrow(/Invalid file path/);
  });

  it('accepts filenames containing pathspec wildcards (Next.js dynamic routes etc.)', () => {
    // Glob-expansion safety lives in toLiteralPathspec at the call site, not
    // in rejection here — these are legitimate on-disk filenames.
    expect(validateFilePaths(['app/[id].jsx'])).toEqual(['app/[id].jsx']);
    expect(validateFilePaths(['what?.md', 'star*.txt'])).toEqual(['what?.md', 'star*.txt']);
  });
});

describe('toLiteralPathspec', () => {
  it('prefixes the path with the :(literal) pathspec magic', () => {
    expect(toLiteralPathspec('app/[id].jsx')).toBe(':(literal)app/[id].jsx');
    expect(toLiteralPathspec('src/a.js')).toBe(':(literal)src/a.js');
  });
});
