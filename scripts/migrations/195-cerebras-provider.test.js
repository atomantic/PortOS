/**
 * Test for migration 195 — add the Cerebras API provider to existing installs.
 * Picked up by server/vitest.config.js's `../scripts/**\/*.test.js` glob.
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
});
