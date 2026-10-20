import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './430-retire-nvidia-kimi-after-ultra-tier.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The record an install upgraded through 357 and the original 402 still holds.
const strandedPreset = () => ({
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
  timeout: 300000,
  enabled: false,
  envVars: {},
  ultraModel: null,
});

describe('migration 430 — retire NVIDIA Kimi stranded by the ultra-tier stamp', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-430-nvidia-kimi-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('removes the preset 402 kept, and leaves user-owned records alone', async () => {
    writeJson(providersPath, {
      activeProvider: 'nvidia-nim',
      providers: { 'nvidia-kimi': strandedPreset(), 'nvidia-nim': { id: 'nvidia-nim', enabled: true } },
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'removed', removed: true });
    expect(readJson(providersPath)).toEqual({
      activeProvider: 'nvidia-nim',
      providers: { 'nvidia-nim': { id: 'nvidia-nim', enabled: true } },
    });

    const keyed = { ...strandedPreset(), apiKey: 'nvapi-example' };
    writeJson(providersPath, { providers: { 'nvidia-kimi': keyed } });
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ reason: 'customized', removed: false });
    expect(readJson(providersPath).providers['nvidia-kimi']).toEqual(keyed);
  });
});
