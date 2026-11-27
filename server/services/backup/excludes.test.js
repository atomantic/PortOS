import { describe, expect, it } from 'vitest';
import { computeEffectiveExcludes, DEFAULT_EXCLUDES, isRestorePreservedPath } from './excludes.js';

const machineLocalCredentialPaths = [
  '/calendar/google-auth/',
  '/spotify/credentials.json',
  '/spotify/tokens.json',
  '/spotify/cache/',
  '/openclaw/',
  '/jira.json',
  '/datadog.json',
  '/auth-sessions.json',
  '/agents/accounts.json',
  '/agents/accounts.json.*.tmp',
];

describe('Machine-local OAuth and OpenClaw backup exclusions (#19173)', () => {
  it.each(machineLocalCredentialPaths)('keeps %s out of backups even if disabled', (path) => {
    expect(DEFAULT_EXCLUDES).toContainEqual(expect.objectContaining({ path, overridable: false }));
    expect(computeEffectiveExcludes({ disabledDefaultExcludes: [path] })).toContain(path);
  });

  it('anchors credential excludes to the data root', () => {
    const excludes = computeEffectiveExcludes();
    for (const path of machineLocalCredentialPaths) expect(excludes).toContain(path);
    expect(excludes).not.toContain('google-auth/');
    expect(excludes).not.toContain('credentials.json');
    expect(excludes).not.toContain('tokens.json');
    expect(excludes).not.toContain('cache/');
    expect(excludes).not.toContain('openclaw/');
  });

  it.each([
    ['calendar/google-auth', 'Calendar/Google-Auth/credentials.json'],
    ['spotify/credentials.json', 'Spotify/Credentials.JSON'],
    ['spotify/tokens.json', 'SPOTIFY/TOKENS.JSON'],
    ['spotify/cache', 'Spotify/Cache/raw/response.json'],
    ['openclaw', 'OpenClaw/profiles/default/token.json'],
    ['jira.json', 'JIRA.JSON'],
    ['datadog.json', 'Datadog.JSON'],
    ['auth-sessions.json', 'AUTH-SESSIONS.JSON'],
  ])('preserves %s and nested paths case-insensitively', (root, nested) => {
    expect(isRestorePreservedPath(root)).toBe(true);
    expect(isRestorePreservedPath(nested)).toBe(true);
  });
});

describe('Machine-local peer authority backup exclusions', () => {
  it.each([
    '/peer-admin-grants.json',
    '/peer-execution-grants.json',
    '/peer-execution-catalog.json',
    '/peer-execution-authority.json',
    '/peer-execution-recovery.jsonl',
    '/peer-execution/',
    '/peer-admin-grants.json.*.tmp',
    '/peer-execution-grants.json.*.tmp',
  ])('keeps %s local even if the backup exclusion is disabled', path => {
    expect(computeEffectiveExcludes({ disabledDefaultExcludes: [path] })).toContain(path);
    expect(isRestorePreservedPath(path.slice(1).replace(/\/$/, '').replace('*', 'example').toUpperCase())).toBe(true);
  });
});

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
