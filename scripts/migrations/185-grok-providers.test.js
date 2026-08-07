/**
 * Test for migration 185 — add the xAI Grok provider trio (API + Grok Build
 * CLI + TUI) to existing installs. Picked up by server/vitest.config.js's
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

import migration from './185-grok-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 185 — Grok providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-185-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds the api, cli, and tui Grok providers to an existing install', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);

    const api = out.providers.grok;
    expect(api.type).toBe('api');
    expect(api.endpoint).toBe('https://api.x.ai/v1');
    expect(api.defaultModel).toBe('grok-4');
    expect(api.enabled).toBe(false);

    const cli = out.providers['grok-cli'];
    expect(cli.type).toBe('cli');
    expect(cli.command).toBe('grok');
    expect(cli.defaultModel).toBe('grok-build');

    const tui = out.providers['grok-tui'];
    expect(tui.type).toBe('tui');
    expect(tui.command).toBe('grok');
    expect(tui.tuiPromptDelayMs).toBe(2500);

    // unrelated providers + active provider untouched
    expect(out.providers['claude-code']).toBeDefined();
    expect(out.activeProvider).toBe('claude-code');
  });
});
