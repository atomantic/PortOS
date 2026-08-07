/**
 * Test for migration 149 — add the OpenCode Ollama CLI provider to existing
 * installs. Picked up by server/vitest.config.js's
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

import migration from './149-opencode-ollama-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 149 — OpenCode Ollama providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-149-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds the OpenCode Ollama CLI provider to an existing install', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    const cli = out.providers['opencode-ollama'];
    expect(cli.type).toBe('cli');
    expect(cli.command).toBe('opencode');
    expect(cli.args).toEqual(['run']);
    expect(cli.ollamaBacked).toBe(true);
    expect(cli.enabled).toBe(false);
    // only the CLI variant ships (TUI completion path is a follow-up)
    expect(out.providers['opencode-ollama-tui']).toBeUndefined();
    // unrelated providers + active provider untouched
    expect(out.providers['claude-code']).toBeDefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('declares a valid inline OpenCode config pointing at the local Ollama daemon', async () => {
    writeJson(providersPath, { providers: {} });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    const cfg = JSON.parse(out.providers['opencode-ollama'].envVars.OPENCODE_CONFIG_CONTENT);
    expect(cfg.permission).toBe('allow');
    expect(cfg.provider.ollama.npm).toBe('@ai-sdk/openai-compatible');
    expect(cfg.provider.ollama.options.baseURL).toBe('http://localhost:11434/v1');
  });
});
