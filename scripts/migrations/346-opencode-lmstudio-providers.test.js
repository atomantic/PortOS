import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './346-opencode-lmstudio-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 346 — OpenCode LM Studio providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-346-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds both OpenCode LM Studio presets, disabled, without changing the active provider', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const out = readJson(providersPath);

    expect(out.providers['opencode-lmstudio']).toMatchObject({
      name: 'OpenCode LM Studio (local model)',
      type: 'cli',
      command: 'opencode',
      models: [],
      defaultModel: null,
      lmstudioBacked: true,
      enabled: false,
    });
    expect(out.providers['opencode-lmstudio-tui']).toMatchObject({
      type: 'tui',
      lmstudioBacked: true,
      enabled: false,
      tuiPromptDelayMs: 2500,
    });
    expect(out.activeProvider).toBe('claude-code');
  });

  it('declares the lmstudio namespace at the local server in the OpenCode config', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });

    for (const id of ['opencode-lmstudio', 'opencode-lmstudio-tui']) {
      const config = JSON.parse(readJson(providersPath).providers[id].envVars.OPENCODE_CONFIG_CONTENT);
      expect(config.provider.lmstudio.options.baseURL).toBe('http://localhost:1234/v1');
    }
  });

  it('pins no numCtx or thinking default — both are load-time choices in LM Studio', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    for (const id of ['opencode-lmstudio', 'opencode-lmstudio-tui']) {
      expect(out.providers[id].numCtx).toBeUndefined();
      expect(out.providers[id].thinking).toBeUndefined();
    }
  });

  it('is a no-op on a second run and never resurrects a renamed or disabled row', async () => {
    const customized = {
      id: 'opencode-lmstudio-tui',
      name: 'My LM Studio TUI',
      type: 'tui',
      command: 'opencode',
      lmstudioBacked: true,
      enabled: false,
    };
    writeJson(providersPath, { providers: { 'opencode-lmstudio-tui': customized } });

    await migration.up({ rootDir });
    const first = readJson(providersPath);
    expect(first.providers['opencode-lmstudio-tui']).toEqual(customized);
    expect(first.providers['opencode-lmstudio']).toBeDefined();

    await migration.up({ rootDir });
    expect(readJson(providersPath)).toEqual(first);
  });

  it('skips an install that has no provider file rather than creating one', async () => {
    await migration.up({ rootDir });
    expect(existsSync(providersPath)).toBe(false);
  });
});
