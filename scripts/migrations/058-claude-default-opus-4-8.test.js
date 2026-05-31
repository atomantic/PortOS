/**
 * Test for migration 058 — bump Claude CLI/TUI providers from the opus-4-7
 * trio to the opus-4-8 trio. Picked up by server/vitest.config.js's
 * `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './058-claude-default-opus-4-8.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const OLD_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'];
const NEW_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'];

const opus47Trio = (overrides = {}) => ({
  id: 'claude-code',
  models: [...OLD_MODELS],
  defaultModel: 'claude-opus-4-7',
  lightModel: 'claude-haiku-4-5',
  mediumModel: 'claude-sonnet-4-6',
  heavyModel: 'claude-opus-4-7',
  ...overrides,
});

describe('migration 058 — Claude CLI/TUI default to opus-4-8', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-058-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('upgrades the opus-4-7 trio to the opus-4-8 trio (models + default + heavy)', async () => {
    writeJson(providersPath, { providers: { 'claude-code': opus47Trio() } });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-opus-4-8');
    expect(after.lightModel).toBe('claude-haiku-4-5');
    expect(after.mediumModel).toBe('claude-sonnet-4-6');
    expect(after.heavyModel).toBe('claude-opus-4-8');
  });

  it('preserves a still-current pin (sonnet-4-6 default) while bumping the opus tier', async () => {
    writeJson(providersPath, {
      providers: { 'claude-code': opus47Trio({ defaultModel: 'claude-sonnet-4-6' }) },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-sonnet-4-6'); // user pin survives
    expect(after.heavyModel).toBe('claude-opus-4-8'); // opus tier still bumped
  });

  it('repairs an orphan opus-4-7 pointer when models are already the new trio', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-code': {
          id: 'claude-code',
          models: [...NEW_MODELS],
          defaultModel: 'claude-opus-4-7', // orphan: not in NEW_MODELS
          lightModel: 'claude-haiku-4-5',
          mediumModel: 'claude-sonnet-4-6',
          heavyModel: 'claude-opus-4-8',
        },
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.defaultModel).toBe('claude-opus-4-8');
    expect(after.models).toContain(after.defaultModel);
  });

  it('is a no-op when models AND pointers are already opus-4-8', async () => {
    const current = {
      id: 'claude-code',
      models: [...NEW_MODELS],
      defaultModel: 'claude-opus-4-8',
      lightModel: 'claude-haiku-4-5',
      mediumModel: 'claude-sonnet-4-6',
      heavyModel: 'claude-opus-4-8',
    };
    writeJson(providersPath, { providers: { 'claude-code': current } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('skips a customized models list (user dropped sonnet, etc.)', async () => {
    const customized = {
      id: 'claude-code',
      models: ['claude-haiku-4-5', 'claude-opus-4-7'],
      defaultModel: 'claude-opus-4-7',
    };
    writeJson(providersPath, { providers: { 'claude-code': customized } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('treats a reordered trio as customization (skip)', async () => {
    const reordered = {
      id: 'claude-code',
      models: ['claude-opus-4-7', 'claude-haiku-4-5', 'claude-sonnet-4-6'],
      defaultModel: 'claude-opus-4-7',
    };
    writeJson(providersPath, { providers: { 'claude-code': reordered } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('processes claude-code and claude-code-tui together, leaving others alone', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-code': opus47Trio(),
        'claude-code-tui': opus47Trio({ id: 'claude-code-tui' }),
        'codex': { id: 'codex', models: ['codex-configured-default'] },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath).providers;
    expect(out['claude-code'].defaultModel).toBe('claude-opus-4-8');
    expect(out['claude-code-tui'].defaultModel).toBe('claude-opus-4-8');
    expect(out['codex'].models).toEqual(['codex-configured-default']);
  });

  it('does not touch the bedrock provider (different model ids)', async () => {
    const bedrock = {
      id: 'claude-code-bedrock',
      models: ['us.anthropic.claude-opus-4-7-v1:0'],
      defaultModel: 'us.anthropic.claude-opus-4-7-v1:0',
    };
    writeJson(providersPath, { providers: { 'claude-code-bedrock': bedrock } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('is a no-op when data/providers.json does not exist (fresh install)', async () => {
    await migration.up({ rootDir });

    expect(existsSync(providersPath)).toBe(false);
  });

  it('does not modify the file on invalid JSON (logs a warning and skips)', async () => {
    writeFileSync(providersPath, '{ not valid json');
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });
});
