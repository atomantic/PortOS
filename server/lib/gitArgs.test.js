import { describe, it, expect } from 'vitest';
import { PROTECTED_BRANCHES, validateFilePaths } from './gitArgs.js';

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
});
