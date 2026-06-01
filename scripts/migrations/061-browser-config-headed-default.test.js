/**
 * Test for migration 061 — flip the managed-browser default from headless to
 * headed for existing installs. Picked up by server/vitest.config.js's
 * `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './061-browser-config-headed-default.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const legacySeed = (overrides = {}) => ({
  cdpPort: 5556,
  cdpHost: '127.0.0.1',
  healthPort: 5557,
  autoConnect: true,
  headless: true,
  userDataDir: '',
  ...overrides,
});

describe('migration 061 — browser-config headed default', () => {
  let rootDir;
  let configPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-061-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    configPath = join(rootDir, 'data/browser-config.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('flips the legacy headless:true default to false', async () => {
    writeJson(configPath, legacySeed());

    await migration.up({ rootDir });

    expect(readJson(configPath).headless).toBe(false);
  });

  it('preserves all other config keys when flipping', async () => {
    writeJson(configPath, legacySeed({ chromePath: '/Apps/Canary', userDataDir: '/data/p' }));

    await migration.up({ rootDir });

    const after = readJson(configPath);
    expect(after.headless).toBe(false);
    expect(after.chromePath).toBe('/Apps/Canary');
    expect(after.userDataDir).toBe('/data/p');
    expect(after.cdpPort).toBe(5556);
  });

  it('leaves a user-customized headless:false untouched (byte-identical)', async () => {
    writeJson(configPath, legacySeed({ headless: false }));
    const before = readFileSync(configPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('leaves a config with no headless key untouched', async () => {
    const noKey = legacySeed();
    delete noKey.headless;
    writeJson(configPath, noKey);
    const before = readFileSync(configPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('does not treat a truthy non-boolean as the legacy default', async () => {
    writeJson(configPath, legacySeed({ headless: 'true' }));
    const before = readFileSync(configPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('is a no-op when data/browser-config.json does not exist (fresh install)', async () => {
    await migration.up({ rootDir });

    expect(existsSync(configPath)).toBe(false);
  });

  it('does not modify the file on invalid JSON (logs a warning and skips)', async () => {
    writeFileSync(configPath, '{ not valid json');
    const before = readFileSync(configPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });
});
