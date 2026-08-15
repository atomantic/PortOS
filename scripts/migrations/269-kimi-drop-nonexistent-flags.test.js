/**
 * Test for migration 269 — strip the non-existent `--print` / `--afk` flags from
 * the stored Kimi Code providers (issue #4139). Picked up by
 * server/vitest.config.js's `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './269-kimi-drop-nonexistent-flags.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const kimiCli = (overrides = {}) => ({
  id: 'kimi-cli',
  name: 'Kimi Code CLI',
  type: 'cli',
  command: 'kimi',
  args: ['--print'],
  enabled: false,
  ...overrides,
});

const kimiTui = (overrides = {}) => ({
  id: 'kimi-tui',
  name: 'Kimi Code TUI',
  type: 'tui',
  command: 'kimi',
  args: ['--yolo'],
  enabled: false,
  ...overrides,
});

describe('migration 269 — drop non-existent kimi flags', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-269-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('empties the seeded `--print` args on kimi-cli', async () => {
    writeJson(providersPath, { providers: { 'kimi-cli': kimiCli() } });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['kimi-cli'];
    expect(after.args).toEqual([]);
    // unrelated fields preserved
    expect(after.command).toBe('kimi');
    expect(after.enabled).toBe(false);
  });

  it('strips the dead flags out of a curated list and keeps the rest in order', async () => {
    writeJson(providersPath, {
      providers: {
        'kimi-cli': kimiCli({ args: ['--print', '--model', 'kimi-k2', '--afk'] }),
      },
    });

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers['kimi-cli'].args).toEqual(['--model', 'kimi-k2']);
  });

  it('strips a user-pinned `--afk` from kimi-tui but leaves --yolo', async () => {
    writeJson(providersPath, { providers: { 'kimi-tui': kimiTui({ args: ['--yolo', '--afk'] }) } });

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers['kimi-tui'].args).toEqual(['--yolo']);
  });

  it('is a no-op when the Kimi providers are already clean', async () => {
    writeJson(providersPath, {
      providers: { 'kimi-cli': kimiCli({ args: [] }), 'kimi-tui': kimiTui() },
    });
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('does not touch other providers that legitimately use --print', async () => {
    writeJson(providersPath, {
      providers: {
        'kimi-cli': kimiCli(),
        'claude-code': { id: 'claude-code', type: 'cli', command: 'claude', args: ['--print'] },
        'antigravity': { id: 'antigravity', type: 'cli', command: 'agy', args: ['--print', '--dangerously-skip-permissions'] },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath).providers;
    expect(out['kimi-cli'].args).toEqual([]);
    expect(out['claude-code'].args).toEqual(['--print']);
    expect(out['antigravity'].args).toEqual(['--print', '--dangerously-skip-permissions']);
  });

  it('is a no-op when no kimi provider is present', async () => {
    writeJson(providersPath, { providers: { 'codex': { id: 'codex', args: [] } } });
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('tolerates a kimi provider with a non-array args field', async () => {
    writeJson(providersPath, { providers: { 'kimi-cli': kimiCli({ args: null }) } });
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('is a no-op when data/providers.json does not exist (fresh install)', async () => {
    await migration.up({ rootDir });

    expect(existsSync(providersPath)).toBe(false);
  });

  it('does not modify the file on invalid JSON (logs a warning and skips)', async () => {
    writeFileSync(providersPath, '{ not valid json');
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });
});
