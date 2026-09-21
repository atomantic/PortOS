import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { isUntouchedShippedNvidiaKimi } from './402-retire-nvidia-kimi-provider.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const shippedProvider = () => ({
  id: 'nvidia-kimi',
  name: 'NVIDIA Kimi K2.5',
  type: 'api',
  endpoint: 'https://integrate.api.nvidia.com/v1',
  apiKey: '',
  models: ['moonshotai/kimi-k2.5', 'moonshotai/kimi-k2-instruct', 'moonshotai/kimi-k2-thinking'],
  defaultModel: 'moonshotai/kimi-k2.5',
  lightModel: 'moonshotai/kimi-k2-instruct',
  mediumModel: 'moonshotai/kimi-k2.5',
  heavyModel: 'moonshotai/kimi-k2-thinking',
  fallbackProvider: null,
  timeout: 300000,
  enabled: false,
  envVars: {},
  secretEnvVars: [],
});

describe('migration 402 — retire NVIDIA Kimi provider', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-402-nvidia-kimi-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('removes the untouched normalized seed and preserves other providers', async () => {
    writeJson(providersPath, {
      activeProvider: 'nvidia-nim',
      providers: { 'nvidia-kimi': shippedProvider(), 'nvidia-nim': { id: 'nvidia-nim', enabled: false } },
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'removed', removed: true });
    expect(readJson(providersPath)).toEqual({
      activeProvider: 'nvidia-nim',
      providers: { 'nvidia-nim': { id: 'nvidia-nim', enabled: false } },
    });
  });

  it('removes the older seed shape and ignores graph-owned fields', async () => {
    const provider = shippedProvider();
    delete provider.fallbackProvider;
    delete provider.secretEnvVars;
    Object.assign(provider, { harnessId: 'direct', method: 'api', serviceId: 'nvidia-kimi', servicePlan: 'paid' });
    writeJson(providersPath, { providers: { 'nvidia-kimi': provider } });

    expect(isUntouchedShippedNvidiaKimi(provider)).toBe(true);
    await migration.up({ rootDir });
    expect(readJson(providersPath).providers).toEqual({});
  });

  it('preserves enabled, keyed, renamed, selected, customized, or referenced records', async () => {
    const cases = [
      { enabled: true },
      { apiKey: 'nvapi-example' },
      { name: 'My NVIDIA Kimi' },
      { defaultModel: 'moonshotai/kimi-k2-thinking' },
      { models: ['custom/model'] },
    ];
    for (const change of cases) {
      const provider = { ...shippedProvider(), ...change };
      writeJson(providersPath, { providers: { 'nvidia-kimi': provider } });
      await expect(migration.up({ rootDir })).resolves.toMatchObject({ reason: 'customized', removed: false });
      expect(readJson(providersPath).providers['nvidia-kimi']).toEqual(provider);
    }

    const provider = shippedProvider();
    writeJson(providersPath, {
      activeProvider: 'nvidia-kimi',
      providers: { 'nvidia-kimi': provider, primary: { fallbackProvider: 'nvidia-kimi' } },
    });
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ reason: 'customized', removed: false });
    expect(readJson(providersPath).providers['nvidia-kimi']).toEqual(provider);
  });

  it('is a no-op when absent and does not create a fresh providers file', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: false, reason: 'no-file', removed: false });
    expect(() => readFileSync(providersPath, 'utf8')).toThrow();

    writeJson(providersPath, { providers: {} });
    const before = readFileSync(providersPath, 'utf8');
    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'absent', removed: false });
    expect(readFileSync(providersPath, 'utf8')).toBe(before);
  });
});
