import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './293-openrouter-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 293 — OpenRouter providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-293-'));
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
    const api = out.providers.openrouter;
    const cli = out.providers['opencode-openrouter'];
    const tui = out.providers['opencode-openrouter-tui'];

    expect(api).toMatchObject({
      endpoint: 'https://openrouter.ai/api/v1',
      apiKey: '',
      models: ['openrouter/auto'],
      enabled: false,
    });
    expect(cli).toMatchObject({ type: 'cli', gatewayBacked: 'openrouter', enabled: false });
    expect(tui).toMatchObject({ type: 'tui', gatewayBacked: 'openrouter', enabled: false, tuiIdleTimeoutMs: 180000 });
    // The wrappers stay keyless on disk — the key is attached to the
    // execution-time copy from the sibling API record (`withGatewayApiKey`).
    expect(JSON.parse(cli.envVars.OPENCODE_CONFIG_CONTENT).provider.openrouter.options.apiKey).toBeUndefined();
    expect(JSON.parse(tui.envVars.OPENCODE_CONFIG_CONTENT).provider.openrouter.options.apiKey).toBeUndefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('preserves an existing OpenRouter API key and custom provider', async () => {
    const existing = { id: 'openrouter', name: 'My Router', type: 'api', apiKey: 'sk-or-example', enabled: true };
    writeJson(providersPath, { providers: { openrouter: existing } });

    await migration.up({ rootDir });
    expect(readJson(providersPath).providers.openrouter).toEqual(existing);
  });

  it('is a no-op on re-run', async () => {
    writeJson(providersPath, { activeProvider: 'claude-code', providers: {} });

    await migration.up({ rootDir });
    const first = readFileSync(providersPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(providersPath, 'utf-8')).toBe(first);
  });

  it('leaves the OrcaRouter presets untouched', async () => {
    const orca = { id: 'orcarouter', type: 'api', apiKey: 'sk-orca-example' };
    writeJson(providersPath, { providers: { orcarouter: orca } });

    await migration.up({ rootDir });
    expect(readJson(providersPath).providers.orcarouter).toEqual(orca);
  });
});
