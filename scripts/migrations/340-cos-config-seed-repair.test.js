import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { isDeepStrictEqual } from 'util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import migration, { RETIRED_SEED } from './340-cos-config-seed-repair.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

// The retired data.reference/cos/config.json, extracted verbatim from the commit
// that shipped it (ed19786aa) and checked in here. Every other test writes
// RETIRED_SEED as its own fixture, so `isDeepStrictEqual` would compare the
// constant to itself and pass for ANY value it held — the migration would then
// no-op on 100% of affected installs with the suite still green. This is the
// independent witness that closes that.
const retiredSeedPath = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'retired-cos-config-seed.json');

describe('migration 340 — repair a CoS config.json overwritten by the shipped seed', () => {
  it('RETIRED_SEED matches the config.json data.reference actually shipped', () => {
    const shipped = JSON.parse(readFileSync(retiredSeedPath, 'utf-8'));
    expect(isDeepStrictEqual(RETIRED_SEED, shipped)).toBe(true);
  });

  let rootDir;
  let statePath;
  let configPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-340-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    statePath = join(rootDir, 'data', 'cos', 'state.json');
    configPath = join(rootDir, 'data', 'cos', 'config.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('lifts the settings still in state.json over the seed', async () => {
    writeJson(configPath, RETIRED_SEED);
    writeJson(statePath, {
      running: true,
      config: { maxConcurrentAgents: 12, alwaysOn: true },
      agents: { 'agent-1': { status: 'running' } },
    });

    const result = await migration.up({ rootDir });

    expect(result).toEqual({ repaired: 'lifted', keys: 2 });
    expect(readJson(configPath)).toEqual({ maxConcurrentAgents: 12, alwaysOn: true });
    expect(readJson(statePath)).toEqual({ running: true, agents: { 'agent-1': { status: 'running' } } });
  });

  it('recovers from the newest quarantined state.json.corrupted.* holding a slice', async () => {
    writeJson(configPath, RETIRED_SEED);
    writeJson(statePath, { running: false, agents: {} });
    writeJson(`${statePath}.corrupted.1788000000000`, { config: { maxConcurrentAgents: 4 } });
    writeJson(`${statePath}.corrupted.1788472679099`, { config: { maxConcurrentAgents: 20, alwaysOn: true } });
    // Newer still, but carries no slice — must be skipped, not treated as empty.
    writeJson(`${statePath}.corrupted.1788999999999`, { running: false, agents: {} });

    const result = await migration.up({ rootDir });

    expect(result).toEqual({ repaired: 'recovered', keys: 2, source: 'state.json.corrupted.1788472679099' });
    expect(readJson(configPath)).toEqual({ maxConcurrentAgents: 20, alwaysOn: true });
  });

  it('deletes the seed when nothing anywhere has settings left to lift, so CoS reads DEFAULT_CONFIG', async () => {
    writeJson(configPath, RETIRED_SEED);
    writeJson(statePath, { running: false, agents: {} });

    const result = await migration.up({ rootDir });

    expect(result).toEqual({ repaired: 'removed' });
    expect(existsSync(configPath)).toBe(false);
    // The runtime file is not this migration's to touch on the delete branch.
    expect(readJson(statePath)).toEqual({ running: false, agents: {} });
  });

  it('leaves a user-written config.json — and its legacy slice — alone', async () => {
    const userConfig = { ...RETIRED_SEED, maxConcurrentAgents: 12 };
    writeJson(configPath, userConfig);
    writeJson(statePath, { running: false, config: { maxConcurrentAgents: 3 }, agents: {} });

    const result = await migration.up({ rootDir });

    expect(result).toEqual({ repaired: false, reason: 'config.json carries real settings' });
    expect(readJson(configPath)).toEqual(userConfig);
    // Deleting the slice here would destroy the only remaining pre-split copy.
    expect(readJson(statePath).config).toEqual({ maxConcurrentAgents: 3 });
  });

  it('is a no-op when config.json is absent (healthy or fresh install)', async () => {
    writeJson(statePath, { running: false, agents: {} });

    expect(await migration.up({ rootDir })).toEqual({ repaired: false, reason: 'no readable config.json' });
    expect(existsSync(configPath)).toBe(false);
  });

  it('leaves an unreadable config.json to the state loader’s quarantine path', async () => {
    writeFileSync(configPath, '{ truncated');

    expect(await migration.up({ rootDir })).toEqual({ repaired: false, reason: 'no readable config.json' });
    expect(existsSync(configPath)).toBe(true);
  });
});
