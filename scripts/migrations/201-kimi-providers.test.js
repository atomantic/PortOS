/**
 * Test for migration 201 — add the Moonshot AI Kimi Code process-provider pair
 * (CLI + TUI) to existing installs. Picked up by server/vitest.config.js's
 * `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './201-kimi-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 201 — Kimi providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-201-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds the cli and tui Kimi providers to an existing install', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);

    const cli = out.providers['kimi-cli'];
    expect(cli.type).toBe('cli');
    expect(cli.command).toBe('kimi');
    expect(cli.args).toEqual(['--print']);
    expect(cli.defaultModel).toBe('kimi-configured-default');
    expect(cli.contextWindow).toBe(256000);
    expect(cli.enabled).toBe(false);

    const tui = out.providers['kimi-tui'];
    expect(tui.type).toBe('tui');
    expect(tui.command).toBe('kimi');
    expect(tui.args).toEqual(['--yolo']);
    expect(tui.tuiPromptDelayMs).toBe(2500);
    expect(tui.tuiIdleTimeoutMs).toBe(180000);

    // unrelated providers + active provider untouched
    expect(out.providers['claude-code']).toBeDefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('does not overwrite a user-customized kimi entry', async () => {
    writeJson(providersPath, {
      providers: {
        'kimi-cli': { id: 'kimi-cli', type: 'cli', command: 'kimi', enabled: true, defaultModel: 'kimi-k2' },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    // existing entry preserved untouched
    expect(out.providers['kimi-cli'].enabled).toBe(true);
    expect(out.providers['kimi-cli'].defaultModel).toBe('kimi-k2');
    // the still-missing TUI sibling is added alongside it
    expect(out.providers['kimi-tui']).toBeDefined();
  });

  it('deep-copies shipped arrays/objects so mutating the install cannot corrupt the frozen defaults', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const first = readJson(providersPath);
    first.providers['kimi-cli'].models.push('mutated');

    // A second install run must still ship the pristine model list.
    const rootDir2 = mkdtempSync(join(tmpdir(), 'migration-201-b-'));
    mkdirSync(join(rootDir2, 'data'), { recursive: true });
    const providersPath2 = join(rootDir2, 'data/providers.json');
    writeJson(providersPath2, { providers: {} });
    await migration.up({ rootDir: rootDir2 });
    expect(readJson(providersPath2).providers['kimi-cli'].models).not.toContain('mutated');
    rmSync(rootDir2, { recursive: true, force: true });
  });

  it('is idempotent — a second run makes no changes', async () => {
    writeJson(providersPath, {
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const afterFirst = readFileSync(providersPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(providersPath, 'utf-8')).toBe(afterFirst);
  });

  it('is a no-op when data/providers.json does not exist (fresh install)', async () => {
    await migration.up({ rootDir });
    expect(existsSync(providersPath)).toBe(false);
  });

  it('does not modify the file on invalid JSON', async () => {
    writeFileSync(providersPath, '{ not valid json');
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });
});
