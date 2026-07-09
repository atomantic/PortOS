import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { NEW_SESSION_MODULES } from './159-post-session-modules-default.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 159 — upgrade legacy POST sessionModules default', () => {
  let rootDir;
  let configPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-159-'));
    mkdirSync(join(rootDir, 'data', 'meatspace'), { recursive: true });
    configPath = join(rootDir, 'data', 'meatspace', 'post-config.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('no-ops when the config file is missing', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'no-file' });
    expect(existsSync(configPath)).toBe(false);
  });

  it('upgrades the exact legacy value and preserves other keys', async () => {
    writeJson(configPath, { sessionModules: ['mental-math'], adaptive: { enabled: true } });
    const result = await migration.up({ rootDir });
    expect(result.updated).toBe(1);
    const data = readJson(configPath);
    expect(data.sessionModules).toEqual(NEW_SESSION_MODULES);
    expect(data.adaptive).toEqual({ enabled: true });
  });

  it('leaves a customized (non-legacy) sessionModules untouched', async () => {
    writeJson(configPath, { sessionModules: ['mental-math', 'llm-drills'] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'not-legacy' });
    expect(readJson(configPath).sessionModules).toEqual(['mental-math', 'llm-drills']);
  });

  it('leaves an already-upgraded config untouched', async () => {
    writeJson(configPath, { sessionModules: ['mental-math', 'cognitive'] });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'not-legacy' });
  });

  it('no-ops when sessionModules is absent', async () => {
    writeJson(configPath, { adaptive: { enabled: false } });
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'not-legacy' });
  });

  it('is idempotent across re-runs', async () => {
    writeJson(configPath, { sessionModules: ['mental-math'] });
    await migration.up({ rootDir });
    const afterFirst = readJson(configPath);
    const second = await migration.up({ rootDir });
    expect(second).toEqual({ updated: 0, reason: 'not-legacy' });
    expect(readJson(configPath)).toEqual(afterFirst);
  });

  it('skips a malformed config file without throwing', async () => {
    writeFileSync(configPath, '{ not json');
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ updated: 0, reason: 'invalid-json' });
  });
});
