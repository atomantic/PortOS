import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './347-lmstudio-harness-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const IDS = ['opencode-lmstudio', 'opencode-lmstudio-tui', 'codex-lmstudio'];

describe('migration 347 — LM Studio harness providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-347-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds all three presets, disabled, without changing the active provider', async () => {
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
    // The Codex wrapper rides the SAME marker as the OpenCode pair — that is
    // what makes `codexOssLocalProvider` emit `--local-provider lmstudio`
    // without a codex-specific flag.
    expect(out.providers['codex-lmstudio']).toMatchObject({
      name: 'Codex LM Studio (local model)',
      type: 'cli',
      command: 'codex',
      lmstudioBacked: true,
      enabled: false,
    });
    expect(out.providers['codex-lmstudio'].textTransport).toBeUndefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('declares the lmstudio namespace at the local server in the OpenCode config', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });

    for (const id of ['opencode-lmstudio', 'opencode-lmstudio-tui']) {
      const config = JSON.parse(readJson(providersPath).providers[id].envVars.OPENCODE_CONFIG_CONTENT);
      expect(config.provider.lmstudio.options.baseURL).toBe('http://localhost:1234/v1');
    }
    // Codex resolves the daemon itself from `--local-provider lmstudio`, so its
    // wrapper carries no OpenCode config at all.
    expect(readJson(providersPath).providers['codex-lmstudio'].envVars).toEqual({});
  });

  it('pins numCtx as a prompt budget and seeds no thinking default', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const out = readJson(providersPath);

    for (const id of IDS) {
      // PortOS cannot reload LM Studio at this window — it is what the prompt
      // budget reads, and what the operator should load the instance with.
      expect(out.providers[id].numCtx).toBe(32768);
      expect(out.providers[id].thinking).toBeUndefined();
    }
  });

  it('is a no-op on a second run and never resurrects a renamed or disabled row', async () => {
    const customized = {
      id: 'codex-lmstudio',
      name: 'My Codex on LM Studio',
      type: 'cli',
      command: 'codex',
      lmstudioBacked: true,
      enabled: false,
    };
    writeJson(providersPath, { providers: { 'codex-lmstudio': customized } });

    await migration.up({ rootDir });
    const first = readJson(providersPath);
    expect(first.providers['codex-lmstudio']).toEqual(customized);
    expect(first.providers['opencode-lmstudio']).toBeDefined();

    await migration.up({ rootDir });
    expect(readJson(providersPath)).toEqual(first);
  });

  it('skips an install that has no provider file rather than creating one', async () => {
    await migration.up({ rootDir });
    expect(existsSync(providersPath)).toBe(false);
  });
});
