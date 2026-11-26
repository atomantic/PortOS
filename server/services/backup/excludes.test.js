import { describe, expect, it } from 'vitest';
import { computeEffectiveExcludes, DEFAULT_EXCLUDES } from './excludes.js';

describe('Autofixer session backup exclusions', () => {
  it('keeps repair session artifacts out of backups even if the exclusion is disabled', () => {
    const path = '/autofixer/sessions/';
    expect(DEFAULT_EXCLUDES).toContainEqual(expect.objectContaining({ path, overridable: false }));
    expect(computeEffectiveExcludes({ disabledDefaultExcludes: [path] })).toContain(path);
  });
});

describe('Managed Python environment backup exclusions', () => {
  it.each(['/python/', '/venvs/'])('keeps %s out of backups even if disabled', (path) => {
    expect(DEFAULT_EXCLUDES).toContainEqual(expect.objectContaining({ path, overridable: false }));
    expect(computeEffectiveExcludes({ disabledDefaultExcludes: [path] })).toContain(path);
  });

  it('anchors the excludes so a user music/python/ directory is not matched', () => {
    const excludes = computeEffectiveExcludes();
    expect(excludes).not.toContain('python/');
    expect(excludes).not.toContain('venvs/');
  });
});

describe('HTTPS certificate backup exclusion', () => {
  it('keeps machine-local HTTPS material out of backups even if disabled', () => {
    const path = '/certs/';
    expect(DEFAULT_EXCLUDES).toContainEqual(expect.objectContaining({ path, overridable: false }));
    expect(computeEffectiveExcludes({ disabledDefaultExcludes: [path] })).toContain(path);
  });
});

describe('Machine-local lock and scratch backup exclusions', () => {
  it.each([
    '/database-maintenance/',
    '/database-authority-*.pending',
    '/.peer-execution-authority-lock',
    '/.peer-execution-authority-*.pending',
    '/.peer-execution-adoption-*.pending',
    '/migrations.lock/',
    '/migrations.applied.json.tmp-*',
  ])('keeps %s out of backups even if disabled', (path) => {
    expect(DEFAULT_EXCLUDES).toContainEqual(expect.objectContaining({ path, overridable: false }));
    expect(computeEffectiveExcludes({ disabledDefaultExcludes: [path] })).toContain(path);
  });
});
