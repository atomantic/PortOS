/**
 * Test for migration 195 — add the Cerebras API provider to existing installs.
 * Picked up by server/vitest.config.js's `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './195-cerebras-provider.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 195 — Cerebras provider', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-195-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds the Cerebras API provider to an existing install', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);

    const api = out.providers.cerebras;
    expect(api.type).toBe('api');
    expect(api.endpoint).toBe('https://api.cerebras.ai/v1');
    expect(api.defaultModel).toBe('gpt-oss-120b');
    expect(api.models).toEqual(['gpt-oss-120b']);
    // ships inert — no key, disabled, so nothing calls the provider unprompted
    expect(api.apiKey).toBe('');
    expect(api.enabled).toBe(false);

    // unrelated providers + active provider untouched
    expect(out.providers['claude-code']).toBeDefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('does not overwrite a user-customized cerebras entry', async () => {
    writeJson(providersPath, {
      providers: {
        cerebras: {
          id: 'cerebras',
          type: 'api',
          endpoint: 'https://api.cerebras.ai/v1',
          enabled: true,
          apiKey: 'csk-secret',
          defaultModel: 'zai-glm-4.7',
          models: ['zai-glm-4.7', 'gpt-oss-120b'],
        },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    // stored key, enablement, and a refreshed model list all survive
    expect(out.providers.cerebras.enabled).toBe(true);
    expect(out.providers.cerebras.apiKey).toBe('csk-secret');
    expect(out.providers.cerebras.defaultModel).toBe('zai-glm-4.7');
    expect(out.providers.cerebras.models).toEqual(['zai-glm-4.7', 'gpt-oss-120b']);
  });

  it('deep-copies shipped arrays/objects so mutating the install cannot corrupt the frozen defaults', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const first = readJson(providersPath);
    first.providers.cerebras.models.push('mutated');

    // A second install run must still ship the pristine model list.
    const rootDir2 = mkdtempSync(join(tmpdir(), 'migration-195-b-'));
    mkdirSync(join(rootDir2, 'data'), { recursive: true });
    const providersPath2 = join(rootDir2, 'data/providers.json');
    writeJson(providersPath2, { providers: {} });
    await migration.up({ rootDir: rootDir2 });
    expect(readJson(providersPath2).providers.cerebras.models).not.toContain('mutated');
    rmSync(rootDir2, { recursive: true, force: true });
  });

  it('is idempotent — a second run makes no changes', async () => {
    writeJson(providersPath, {
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });
    const afterFirst = readFileSync(providersPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(providersPath, 'utf-8')).toBe(afterFirst);
  });

  it('is a no-op when data/providers.json does not exist (fresh install)', async () => {
    await migration.up({ rootDir });
    expect(existsSync(providersPath)).toBe(false);
  });

  it('does not modify the file on invalid JSON', async () => {
    writeFileSync(providersPath, '{ not valid json');
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('does not modify the file when the providers map is missing', async () => {
    writeJson(providersPath, { activeProvider: 'claude-code' });
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });
});
