/**
 * Test for migration 201 — add the Moonshot AI Kimi Code process-provider pair
 * (CLI + TUI) to existing installs. Picked up by server/vitest.config.js's
 * `../scripts/**\/*.test.js` glob.
 *
 * The shell shared by all six provider-seed migrations (read → guard → add
 * missing ids → conditional write) is asserted once against
 * `makeProviderSeedMigration` in _lib.test.js; what stays here is this
 * migration's own frozen payload.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
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
});
