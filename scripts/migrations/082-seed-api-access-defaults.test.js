import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { computeApiAccessSeed, API_ACCESS_DEFAULTS } from './082-seed-api-access-defaults.js';

let rootDir;
let dataDir;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'migration-082-'));
  dataDir = join(rootDir, 'data');
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

const writeSettings = (obj) => writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(obj, null, 2) + '\n');
const readSettings = () => JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf-8'));

describe('computeApiAccessSeed (pure)', () => {
  it('adds the default apiAccess block when absent', () => {
    const { settings, changed } = computeApiAccessSeed({ timezone: 'UTC' });
    expect(changed).toBe(true);
    expect(settings.apiAccess).toEqual(API_ACCESS_DEFAULTS);
    expect(settings.timezone).toBe('UTC'); // preserved
  });

  it('leaves an existing apiAccess value untouched (idempotent)', () => {
    const existing = { apiAccess: { voice: { exposed: true, requireAuth: true } } };
    const { settings, changed } = computeApiAccessSeed(existing);
    expect(changed).toBe(false);
    expect(settings.apiAccess.voice.exposed).toBe(true);
  });

  it('does not overwrite a partial hand-edited apiAccess', () => {
    const existing = { apiAccess: { sdapi: { exposed: true } } };
    const { changed } = computeApiAccessSeed(existing);
    expect(changed).toBe(false);
  });

  it('handles a non-object input gracefully', () => {
    expect(computeApiAccessSeed(null).changed).toBe(false);
  });
});

describe('migration 082 up()', () => {
  it('skips when settings.json is absent (fresh install)', async () => {
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('no-state');
    expect(existsSync(join(dataDir, 'settings.json'))).toBe(false);
  });

  it('seeds the default block when missing', async () => {
    writeSettings({ timezone: 'UTC' });
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('seeded');
    expect(readSettings().apiAccess).toEqual(API_ACCESS_DEFAULTS);
  });

  it('is a no-op when apiAccess already present', async () => {
    writeSettings({ apiAccess: { voice: { exposed: true, requireAuth: false } } });
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('already-present');
    expect(readSettings().apiAccess.voice.exposed).toBe(true);
  });

  it('skips invalid JSON without throwing', async () => {
    writeFileSync(join(dataDir, 'settings.json'), '{ not valid');
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('invalid-json');
  });

  it('re-running after seeding is idempotent', async () => {
    writeSettings({ timezone: 'UTC' });
    await migration.up({ rootDir });
    const result = await migration.up({ rootDir });
    expect(result.reason).toBe('already-present');
  });
});
