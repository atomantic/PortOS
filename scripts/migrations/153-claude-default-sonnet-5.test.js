/**
 * Test for migration 153 — bump the Claude CLI/TUI (+ Bedrock) provider medium
 * tier from `claude-sonnet-4-6` to `claude-sonnet-5`. Picked up by
 * server/vitest.config.js's `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './153-claude-default-sonnet-5.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const OLD_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'];
const NEW_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'];

const BEDROCK_OLD = ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-4-6', 'global.anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8[1m]'];
const BEDROCK_NEW = ['us.anthropic.claude-haiku-4-5', 'us.anthropic.claude-sonnet-5', 'global.anthropic.claude-opus-4-8', 'global.anthropic.claude-opus-4-8[1m]'];

const sonnet46Trio = (overrides = {}) => ({
  id: 'claude-code',
  models: [...OLD_MODELS],
  defaultModel: 'claude-opus-4-8',
  lightModel: 'claude-haiku-4-5',
  mediumModel: 'claude-sonnet-4-6',
  heavyModel: 'claude-opus-4-8',
  ...overrides,
});

const bedrockSonnet46 = (overrides = {}) => ({
  id: 'claude-code-bedrock',
  models: [...BEDROCK_OLD],
  defaultModel: 'global.anthropic.claude-opus-4-8[1m]',
  lightModel: 'us.anthropic.claude-haiku-4-5',
  mediumModel: 'us.anthropic.claude-sonnet-4-6',
  heavyModel: 'global.anthropic.claude-opus-4-8[1m]',
  ...overrides,
});

describe('migration 153 — Claude CLI/TUI default sonnet tier → sonnet-5', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-153-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('upgrades the sonnet-4-6 trio to the sonnet-5 trio (models + medium pointer)', async () => {
    writeJson(providersPath, { providers: { 'claude-code': sonnet46Trio() } });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.mediumModel).toBe('claude-sonnet-5');
    expect(after.lightModel).toBe('claude-haiku-4-5'); // untouched
    expect(after.defaultModel).toBe('claude-opus-4-8'); // untouched
    expect(after.heavyModel).toBe('claude-opus-4-8'); // untouched
  });

  it('preserves a still-current pin (opus default) while bumping the sonnet tier', async () => {
    writeJson(providersPath, {
      providers: { 'claude-code': sonnet46Trio({ defaultModel: 'claude-opus-4-8' }) },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-opus-4-8');
    expect(after.mediumModel).toBe('claude-sonnet-5');
  });

  it('repairs an orphan sonnet-4-6 pointer when models are already the new trio', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-code': {
          id: 'claude-code',
          models: [...NEW_MODELS],
          defaultModel: 'claude-opus-4-8',
          lightModel: 'claude-haiku-4-5',
          mediumModel: 'claude-sonnet-4-6', // orphan: not in NEW_MODELS
          heavyModel: 'claude-opus-4-8',
        },
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.mediumModel).toBe('claude-sonnet-5');
    expect(after.models).toContain(after.mediumModel);
  });

  it('is a no-op when models AND pointers are already sonnet-5', async () => {
    const current = {
      id: 'claude-code',
      models: [...NEW_MODELS],
      defaultModel: 'claude-opus-4-8',
      lightModel: 'claude-haiku-4-5',
      mediumModel: 'claude-sonnet-5',
      heavyModel: 'claude-opus-4-8',
    };
    writeJson(providersPath, { providers: { 'claude-code': current } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('skips a customized models list (user dropped haiku, etc.)', async () => {
    const customized = {
      id: 'claude-code',
      models: ['claude-sonnet-4-6', 'claude-opus-4-8'],
      mediumModel: 'claude-sonnet-4-6',
    };
    writeJson(providersPath, { providers: { 'claude-code': customized } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('treats a reordered trio as customization (skip)', async () => {
    const reordered = {
      id: 'claude-code',
      models: ['claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-8'],
      mediumModel: 'claude-sonnet-4-6',
    };
    writeJson(providersPath, { providers: { 'claude-code': reordered } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('processes claude-code and claude-code-tui together, leaving others alone', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-code': sonnet46Trio(),
        'claude-code-tui': sonnet46Trio({ id: 'claude-code-tui' }),
        'codex': { id: 'codex', models: ['codex-configured-default'] },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath).providers;
    expect(out['claude-code'].mediumModel).toBe('claude-sonnet-5');
    expect(out['claude-code-tui'].mediumModel).toBe('claude-sonnet-5');
    expect(out['codex'].models).toEqual(['codex-configured-default']);
  });

  it('upgrades the Bedrock providers (region-prefixed sonnet id)', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-code-bedrock': bedrockSonnet46(),
        'claude-code-tui-bedrock': bedrockSonnet46({ id: 'claude-code-tui-bedrock' }),
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath).providers;
    expect(out['claude-code-bedrock'].models).toEqual(BEDROCK_NEW);
    expect(out['claude-code-bedrock'].mediumModel).toBe('us.anthropic.claude-sonnet-5');
    expect(out['claude-code-tui-bedrock'].models).toEqual(BEDROCK_NEW);
    expect(out['claude-code-tui-bedrock'].mediumModel).toBe('us.anthropic.claude-sonnet-5');
    // Other Bedrock tiers untouched.
    expect(out['claude-code-bedrock'].heavyModel).toBe('global.anthropic.claude-opus-4-8[1m]');
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
