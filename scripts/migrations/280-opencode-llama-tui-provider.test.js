import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './280-opencode-llama-tui-provider.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 280 — OpenCode llama TUI provider', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-280-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds enabled OpenCode llama TUI preset without changing the active provider', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const out = readJson(providersPath);
    const tui = out.providers['opencode-llama-tui'];

    expect(tui).toMatchObject({
      name: 'OpenCode llama TUI',
      type: 'tui',
      command: 'opencode',
      endpoint: 'http://127.0.0.1:8080/v1',
      models: ['dflash', 'qwen3.8-27b-dflash2', 'Muse-Glimmer-30B-DFlash2'],
      defaultModel: 'dflash',
      llamaBacked: true,
      enabled: true,
      tuiIdleTimeoutMs: 180000,
    });
    expect(JSON.parse(tui.envVars.OPENCODE_CONFIG_CONTENT).provider.llama.options.baseURL).toBe('http://127.0.0.1:8080/v1');
    expect(out.activeProvider).toBe('claude-code');
  });

  it('preserves an existing custom OpenCode llama TUI configuration', async () => {
    const existing = {
      id: 'opencode-llama-tui',
      name: 'Custom Llama TUI',
      type: 'tui',
      endpoint: 'http://custom-host:8080/v1',
      enabled: false,
    };
    writeJson(providersPath, { providers: { 'opencode-llama-tui': existing } });

    await migration.up({ rootDir });
    expect(readJson(providersPath).providers['opencode-llama-tui']).toEqual(existing);
  });
});
