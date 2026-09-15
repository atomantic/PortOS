import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './387-nvidia-nim-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 387 — NVIDIA NIM providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-387-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds disabled presets without changing the active provider', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const out = readJson(providersPath);
    const api = out.providers['nvidia-nim'];
    const cli = out.providers['opencode-nvidia-nim'];
    const tui = out.providers['opencode-nvidia-nim-tui'];

    expect(api).toMatchObject({
      endpoint: 'https://integrate.api.nvidia.com/v1',
      apiKey: '',
      models: ['google/gemma-4-31b-it', 'poolside/laguna-xs-2.1'],
      defaultModel: 'poolside/laguna-xs-2.1',
      lightModel: 'google/gemma-4-31b-it',
      enabled: false,
    });
    expect(cli).toMatchObject({ type: 'cli', gatewayBacked: 'nvidia-nim', enabled: false });
    expect(tui).toMatchObject({ type: 'tui', gatewayBacked: 'nvidia-nim', enabled: false, tuiIdleTimeoutMs: 180000 });
    // The wrappers stay keyless on disk — the key is attached to the
    // execution-time copy from the sibling API record (`withGatewayApiKey`).
    expect(JSON.parse(cli.envVars.OPENCODE_CONFIG_CONTENT).provider['nvidia-nim'].options.apiKey).toBeUndefined();
    expect(JSON.parse(tui.envVars.OPENCODE_CONFIG_CONTENT).provider['nvidia-nim'].options.apiKey).toBeUndefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('preserves an existing NVIDIA NIM API key and custom provider', async () => {
    const existing = { id: 'nvidia-nim', name: 'My NIM', type: 'api', apiKey: 'nvapi-example', enabled: true };
    writeJson(providersPath, { providers: { 'nvidia-nim': existing } });

    await migration.up({ rootDir });
    expect(readJson(providersPath).providers['nvidia-nim']).toEqual(existing);
  });

  it('is a no-op on re-run', async () => {
    writeJson(providersPath, { activeProvider: 'claude-code', providers: {} });

    await migration.up({ rootDir });
    const first = readFileSync(providersPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(providersPath, 'utf-8')).toBe(first);
  });

  it('leaves the Kimi-on-NIM catalog untouched', async () => {
    const kimi = { id: 'nvidia-kimi', type: 'api', apiKey: 'nvapi-kimi-example', models: ['moonshotai/kimi-k2.5'] };
    writeJson(providersPath, { providers: { 'nvidia-kimi': kimi } });

    await migration.up({ rootDir });
    expect(readJson(providersPath).providers['nvidia-kimi']).toEqual(kimi);
    expect(readJson(providersPath).providers['nvidia-nim'].models).toEqual([
      'google/gemma-4-31b-it',
      'poolside/laguna-xs-2.1',
    ]);
  });
});
