import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './310-nvidia-kimi-k2-5-model-id.js';

const OLD_MODEL = 'moonshotai/kimi-k2-5';
const NEW_MODEL = 'moonshotai/kimi-k2.5';
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const shippedProvider = () => ({
  id: 'nvidia-kimi',
  models: [OLD_MODEL, 'moonshotai/kimi-k2-instruct', 'moonshotai/kimi-k2-thinking'],
  defaultModel: OLD_MODEL,
  lightModel: 'moonshotai/kimi-k2-instruct',
  mediumModel: OLD_MODEL,
  heavyModel: 'moonshotai/kimi-k2-thinking',
});

describe('migration 310 — NVIDIA Kimi K2.5 model id', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-310-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('repairs the shipped list and tier pointers without changing the other tiers', async () => {
    writeJson(providersPath, { providers: { 'nvidia-kimi': shippedProvider() } });

    const result = await migration.up({ rootDir });
    const provider = readJson(providersPath).providers['nvidia-kimi'];

    expect(result).toMatchObject({ ok: true, reason: 'updated', updated: 1 });
    expect(provider).toMatchObject({ defaultModel: NEW_MODEL, mediumModel: NEW_MODEL });
    expect(provider.models).toEqual([
      NEW_MODEL,
      'moonshotai/kimi-k2-instruct',
      'moonshotai/kimi-k2-thinking',
    ]);
    expect(provider.lightModel).toBe('moonshotai/kimi-k2-instruct');
    expect(provider.heavyModel).toBe('moonshotai/kimi-k2-thinking');
  });

  it('preserves custom models while replacing and de-duplicating only the invalid id', async () => {
    const provider = shippedProvider();
    provider.models = ['custom/model', OLD_MODEL, NEW_MODEL];
    provider.defaultModel = 'custom/model';
    writeJson(providersPath, { providers: { 'nvidia-kimi': provider } });

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers['nvidia-kimi']).toMatchObject({
      models: ['custom/model', NEW_MODEL],
      defaultModel: 'custom/model',
      mediumModel: NEW_MODEL,
    });
  });

  it('repairs a fallback model explicitly pinned to NVIDIA Kimi', async () => {
    writeJson(providersPath, {
      providers: {
        'nvidia-kimi': shippedProvider(),
        primary: { fallbackProvider: 'nvidia-kimi', fallbackModel: OLD_MODEL },
        unrelated: { fallbackProvider: 'other', fallbackModel: OLD_MODEL },
      },
    });

    const result = await migration.up({ rootDir });
    const providers = readJson(providersPath).providers;

    expect(result.updated).toBe(2);
    expect(providers.primary.fallbackModel).toBe(NEW_MODEL);
    expect(providers.unrelated.fallbackModel).toBe(OLD_MODEL);
  });

  it('does not rewrite an already-current provider document', async () => {
    const provider = shippedProvider();
    provider.models[0] = NEW_MODEL;
    provider.defaultModel = NEW_MODEL;
    provider.mediumModel = NEW_MODEL;
    writeJson(providersPath, { providers: { 'nvidia-kimi': provider } });
    const before = readFileSync(providersPath, 'utf8');

    const result = await migration.up({ rootDir });

    expect(result).toMatchObject({ ok: true, reason: 'already-current', updated: 0 });
    expect(readFileSync(providersPath, 'utf8')).toBe(before);
  });

  it('skips a fresh install without creating providers.json', async () => {
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: false, reason: 'no-file' });
    expect(existsSync(providersPath)).toBe(false);
  });
});
