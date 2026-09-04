import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './339-cos-config-split.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 339 — split CoS config out of state.json', () => {
  let rootDir;
  let statePath;
  let configPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-339-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    statePath = join(rootDir, 'data', 'cos', 'state.json');
    configPath = join(rootDir, 'data', 'cos', 'config.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('lifts config into its own file and rewrites state.json without it', async () => {
    writeJson(statePath, {
      running: false,
      paused: false,
      config: { maxConcurrentAgents: 7, persistentMindPrompt: { body: 'keep me' } },
      stats: { tasksCompleted: 4 },
      agents: { 'agent-1': { status: 'running' } },
    });

    const result = await migration.up({ rootDir });

    expect(result.split).toBe(true);
    expect(readJson(configPath)).toEqual({
      maxConcurrentAgents: 7,
      persistentMindPrompt: { body: 'keep me' },
    });
    const state = readJson(statePath);
    expect(state.config).toBeUndefined();
    // Everything that is NOT config stays exactly where it was.
    expect(state).toEqual({
      running: false,
      paused: false,
      stats: { tasksCompleted: 4 },
      agents: { 'agent-1': { status: 'running' } },
    });
  });

  it('is idempotent — a second run leaves the split files untouched', async () => {
    writeJson(statePath, { running: true, config: { maxConcurrentAgents: 7 }, agents: {} });
    await migration.up({ rootDir });
    const configAfterFirst = readFileSync(configPath, 'utf-8');
    const stateAfterFirst = readFileSync(statePath, 'utf-8');

    const result = await migration.up({ rootDir });

    expect(result.split).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(configAfterFirst);
    expect(readFileSync(statePath, 'utf-8')).toBe(stateAfterFirst);
  });

  // A pre-existing config.json is the newer, authoritative copy. Overwriting it
  // from a stale `config` slice still sitting in state.json would silently roll
  // the user's settings back.
  it('never overwrites an existing config.json from a stale state.json slice', async () => {
    writeJson(configPath, { maxConcurrentAgents: 9 });
    writeJson(statePath, { running: false, config: { maxConcurrentAgents: 2 }, agents: {} });

    const result = await migration.up({ rootDir });

    expect(result.split).toBe(false);
    expect(readJson(configPath)).toEqual({ maxConcurrentAgents: 9 });
  });

  // The sidecar mirrored config out of state.json because the two shared a
  // file. Nothing reads it after the split, and a stale "last known good
  // config" left on disk only invites a restore that undoes newer settings.
  it('removes the retired config.last-known-good.json sidecar', async () => {
    const sidecar = join(rootDir, 'data', 'cos', 'config.last-known-good.json');
    writeJson(sidecar, { maxConcurrentAgents: 2 });
    writeJson(statePath, { running: false, config: { maxConcurrentAgents: 7 }, agents: {} });

    expect((await migration.up({ rootDir })).removedBackup).toBe(true);
    expect(existsSync(sidecar)).toBe(false);
    expect(readJson(configPath)).toEqual({ maxConcurrentAgents: 7 });
  });

  // An install that reached the split shape some other way still has one.
  it('removes the sidecar even when the lift itself is a no-op', async () => {
    const sidecar = join(rootDir, 'data', 'cos', 'config.last-known-good.json');
    writeJson(sidecar, { maxConcurrentAgents: 2 });
    writeJson(configPath, { maxConcurrentAgents: 9 });

    const result = await migration.up({ rootDir });

    expect(result).toMatchObject({ split: false, removedBackup: true });
    expect(existsSync(sidecar)).toBe(false);
    expect(readJson(configPath)).toEqual({ maxConcurrentAgents: 9 });
  });

  it('is a no-op when state.json is missing, unreadable, or carries no config', async () => {
    expect((await migration.up({ rootDir })).split).toBe(false);
    expect(existsSync(configPath)).toBe(false);

    writeFileSync(statePath, '{"running": tru');
    expect((await migration.up({ rootDir })).split).toBe(false);
    expect(existsSync(configPath)).toBe(false);

    writeJson(statePath, { running: false, agents: {} });
    expect((await migration.up({ rootDir })).split).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });
});
