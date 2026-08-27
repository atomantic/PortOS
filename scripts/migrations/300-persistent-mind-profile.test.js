import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './300-persistent-mind-profile.js';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 300 — persistent mind profile', () => {
  let rootDir;
  let statePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-300-persistent-mind-profile-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    statePath = join(rootDir, 'data', 'cos', 'state.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds a disabled profile without changing existing config or runtime state', async () => {
    writeFileSync(statePath, JSON.stringify({ config: { alwaysOn: true }, persistentMind: { enabled: true } }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    expect(readJson(statePath)).toMatchObject({
      config: { alwaysOn: true, persistentMindProfile: { enabled: false, thinkingInterface: 'text' } },
      persistentMind: { enabled: true },
    });
  });

  it('is idempotent and leaves malformed input for normal CoS recovery', async () => {
    writeFileSync(statePath, JSON.stringify({ config: { persistentMindProfile: { enabled: true } } }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });
    writeFileSync(statePath, '{broken');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-state' });
    expect(readFileSync(statePath, 'utf8')).toBe('{broken');
  });
});
