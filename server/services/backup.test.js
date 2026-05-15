/**
 * Unit tests for computeEffectiveExcludes — the pure function that decides
 * which paths rsync sees as `--exclude`. Tests the defensive Array.isArray
 * guards (settings.json is hand-editable, so a non-array value must not
 * throw) and the overridable allow-list (non-overridable defaults can never
 * be disabled by user input).
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_EXCLUDES, computeEffectiveExcludes } from './backup.js';

const overridable = DEFAULT_EXCLUDES.filter(e => e.overridable).map(e => e.path);
const nonOverridable = DEFAULT_EXCLUDES.filter(e => !e.overridable).map(e => e.path);

describe('computeEffectiveExcludes', () => {
  it('includes every DEFAULT_EXCLUDES path when nothing is disabled', () => {
    const result = computeEffectiveExcludes({ excludePaths: [], disabledDefaultExcludes: [] });
    for (const path of DEFAULT_EXCLUDES.map(e => e.path)) {
      expect(result).toContain(path);
    }
  });

  it('honors disabling an overridable default', () => {
    const target = overridable[0];
    const result = computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: [target]
    });
    expect(result).not.toContain(target);
  });

  it('ignores attempts to disable a non-overridable default', () => {
    const target = nonOverridable[0];
    const result = computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: [target]
    });
    expect(result).toContain(target);
  });

  it('merges user excludePaths on top of active defaults', () => {
    const result = computeEffectiveExcludes({
      excludePaths: ['my/custom/path', 'cache/'],
      disabledDefaultExcludes: []
    });
    expect(result).toContain('my/custom/path');
    expect(result).toContain('cache/');
  });

  it('dedupes when a user exclude matches an active default', () => {
    const target = overridable[0];
    const result = computeEffectiveExcludes({
      excludePaths: [target],
      disabledDefaultExcludes: []
    });
    expect(result.filter(p => p === target)).toHaveLength(1);
  });

  it('drops falsy entries from excludePaths', () => {
    const result = computeEffectiveExcludes({
      excludePaths: ['', null, undefined, 'real/path'],
      disabledDefaultExcludes: []
    });
    expect(result).toContain('real/path');
    expect(result).not.toContain('');
    expect(result).not.toContain(null);
  });

  it('tolerates a non-array disabledDefaultExcludes without throwing', () => {
    // Simulates a hand-edited settings.json with bad shape — should not crash.
    expect(() => computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: 'loras/*.safetensors'
    })).not.toThrow();

    const result = computeEffectiveExcludes({
      excludePaths: [],
      disabledDefaultExcludes: { bogus: true }
    });
    // Bogus value is ignored — all defaults stay active.
    for (const path of DEFAULT_EXCLUDES.map(e => e.path)) {
      expect(result).toContain(path);
    }
  });

  it('tolerates a non-array excludePaths without throwing', () => {
    expect(() => computeEffectiveExcludes({
      excludePaths: 'just/one/string',
      disabledDefaultExcludes: []
    })).not.toThrow();

    const result = computeEffectiveExcludes({
      excludePaths: null,
      disabledDefaultExcludes: []
    });
    // Null user list is treated as empty — only defaults remain.
    expect(result).toEqual(DEFAULT_EXCLUDES.map(e => e.path));
  });

  it('handles being called with no arguments (defensive)', () => {
    expect(() => computeEffectiveExcludes()).not.toThrow();
    const result = computeEffectiveExcludes();
    expect(result).toEqual(DEFAULT_EXCLUDES.map(e => e.path));
  });
});
