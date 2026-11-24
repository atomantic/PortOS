import { describe, expect, it } from 'vitest';
import { computeEffectiveExcludes, DEFAULT_EXCLUDES } from './excludes.js';

describe('Autofixer session backup exclusions', () => {
  it('keeps repair session artifacts out of backups even if the exclusion is disabled', () => {
    const path = '/autofixer/sessions/';
    expect(DEFAULT_EXCLUDES).toContainEqual(expect.objectContaining({ path, overridable: false }));
    expect(computeEffectiveExcludes({ disabledDefaultExcludes: [path] })).toContain(path);
  });
});
