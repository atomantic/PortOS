/**
 * Test for migration 246 — repair `fallbackModel` pins left dangling by the
 * Claude tier bumps (058 / 153 / 206), which remapped the four tier pointers
 * but never `fallbackModel`. Picked up by server/vitest.config.js's
 * `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './246-fallback-model-retired-claude-ids.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const CLAUDE_TUI_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'];
const BEDROCK_TUI_MODELS = [
  'us.anthropic.claude-sonnet-5',
  'global.anthropic.claude-opus-5',
  'global.anthropic.claude-opus-5[1m]',
];

// The shape the bug leaves behind: codex/codex-tui each pin a Claude fallback
// model that migration 206 retired out from under them.
const staleConfig = () => ({
  activeProvider: 'codex-tui',
  providers: {
    codex: {
      id: 'codex',
      models: ['gpt-5.6-terra'],
      fallbackProvider: 'claude-code-tui',
      fallbackModel: 'claude-opus-4-8',
    },
    'codex-tui': {
      id: 'codex-tui',
      models: ['gpt-5.6-terra'],
      fallbackProvider: 'claude-code-tui-bedrock',
      fallbackModel: 'global.anthropic.claude-opus-4-8',
    },
    'claude-code-tui': { id: 'claude-code-tui', models: [...CLAUDE_TUI_MODELS] },
    'claude-code-tui-bedrock': { id: 'claude-code-tui-bedrock', models: [...BEDROCK_TUI_MODELS] },
  },
});

describe('migration 246 — repair retired fallbackModel pins', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-246-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('remaps a retired pin to the replacement the fallback provider lists', async () => {
    writeJson(providersPath, staleConfig());

    await migration.up({ rootDir });

    const out = readJson(providersPath).providers;
    expect(out.codex.fallbackModel).toBe('claude-opus-5');
    expect(out['codex-tui'].fallbackModel).toBe('global.anthropic.claude-opus-5');
  });

  it('maps the Bedrock [1m] long-context pin like-for-like', async () => {
    const config = staleConfig();
    config.providers['codex-tui'].fallbackModel = 'global.anthropic.claude-opus-4-8[1m]';
    writeJson(providersPath, config);

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers['codex-tui'].fallbackModel)
      .toBe('global.anthropic.claude-opus-5[1m]');
  });

  it('collapses an older chained id (opus-4-7) straight to the current one', async () => {
    const config = staleConfig();
    config.providers.codex.fallbackModel = 'claude-opus-4-7';
    writeJson(providersPath, config);

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers.codex.fallbackModel).toBe('claude-opus-5');
  });

  it('leaves a pin the fallback provider still lists untouched', async () => {
    const config = staleConfig();
    // A user who curated `claude-code-tui` to keep sonnet-4-6 alive still has a
    // working pin — an older id is not automatically a dead one.
    config.providers['claude-code-tui'].models = ['claude-sonnet-4-6', 'claude-opus-5'];
    config.providers.codex.fallbackModel = 'claude-sonnet-4-6';
    writeJson(providersPath, config);

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers.codex.fallbackModel).toBe('claude-sonnet-4-6');
  });

  it('leaves a dead pin alone when the replacement is not listed either', async () => {
    const config = staleConfig();
    config.providers['claude-code-tui'].models = ['claude-haiku-4-5'];
    writeJson(providersPath, config);

    await migration.up({ rootDir });

    // Nothing to safely swap to — runtime `usableFallbackModel` drops it to the
    // provider default instead of this migration guessing.
    expect(readJson(providersPath).providers.codex.fallbackModel).toBe('claude-opus-4-8');
  });

  it('skips a provider whose fallbackProvider does not exist', async () => {
    const config = staleConfig();
    config.providers.codex.fallbackProvider = 'deleted-provider';
    writeJson(providersPath, config);

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers.codex.fallbackModel).toBe('claude-opus-4-8');
  });

  it('skips a fallbackProvider named after an Object.prototype member', async () => {
    const config = staleConfig();
    config.providers.codex.fallbackProvider = 'constructor';
    writeJson(providersPath, config);

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers.codex.fallbackModel).toBe('claude-opus-4-8');
  });

  it('does not rewrite the file when nothing is stale', async () => {
    const config = staleConfig();
    config.providers.codex.fallbackModel = 'claude-opus-5';
    config.providers['codex-tui'].fallbackModel = 'global.anthropic.claude-opus-5';
    writeJson(providersPath, config);
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('ignores a pin named after an Object.prototype member', async () => {
    const config = staleConfig();
    config.providers.codex.fallbackModel = 'constructor';
    writeJson(providersPath, config);

    await migration.up({ rootDir });

    expect(readJson(providersPath).providers.codex.fallbackModel).toBe('constructor');
  });

  it('is a no-op when providers.json is absent', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    expect(existsSync(providersPath)).toBe(false);
  });

  it('is a no-op on invalid JSON', async () => {
    writeFileSync(providersPath, '{ not json');
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    expect(readFileSync(providersPath, 'utf-8')).toBe('{ not json');
  });

  it('is a no-op when there is no providers map', async () => {
    writeJson(providersPath, { activeProvider: 'codex' });
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });
});
