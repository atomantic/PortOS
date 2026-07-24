/**
 * Test for migration 206 — bump the Claude CLI/TUI (+ Bedrock) provider opus
 * tier from `claude-opus-4-8` to `claude-opus-5`, mapping the Bedrock `[1m]`
 * long-context variant like-for-like. Picked up by
 * server/vitest.config.js's `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './206-claude-default-opus-5.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const OLD_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'];
const NEW_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'];

const BEDROCK_OLD = [
  'us.anthropic.claude-haiku-4-5',
  'us.anthropic.claude-sonnet-5',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-opus-4-8[1m]',
];
const BEDROCK_NEW = [
  'us.anthropic.claude-haiku-4-5',
  'us.anthropic.claude-sonnet-5',
  'global.anthropic.claude-opus-5',
  'global.anthropic.claude-opus-5[1m]',
];

const opus48Trio = (overrides = {}) => ({
  id: 'claude-code',
  models: [...OLD_MODELS],
  defaultModel: 'claude-opus-4-8',
  lightModel: 'claude-haiku-4-5',
  mediumModel: 'claude-sonnet-5',
  heavyModel: 'claude-opus-4-8',
  ...overrides,
});

const bedrockOpus48 = (overrides = {}) => ({
  id: 'claude-code-bedrock',
  models: [...BEDROCK_OLD],
  defaultModel: 'global.anthropic.claude-opus-4-8[1m]',
  lightModel: 'us.anthropic.claude-haiku-4-5',
  mediumModel: 'us.anthropic.claude-sonnet-5',
  heavyModel: 'global.anthropic.claude-opus-4-8[1m]',
  ...overrides,
});

describe('migration 206 — Claude CLI/TUI default opus tier → opus-5', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-206-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('upgrades the opus-4-8 trio to the opus-5 trio (models + default/heavy pointers)', async () => {
    writeJson(providersPath, { providers: { 'claude-code': opus48Trio() } });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-opus-5');
    expect(after.heavyModel).toBe('claude-opus-5');
    expect(after.lightModel).toBe('claude-haiku-4-5'); // untouched
    expect(after.mediumModel).toBe('claude-sonnet-5'); // untouched
  });

  it('preserves a still-current pin (sonnet default) while bumping the opus tier', async () => {
    writeJson(providersPath, {
      providers: { 'claude-code': opus48Trio({ defaultModel: 'claude-sonnet-5' }) },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.models).toEqual(NEW_MODELS);
    expect(after.defaultModel).toBe('claude-sonnet-5');
    expect(after.heavyModel).toBe('claude-opus-5');
  });

  it('repairs an orphan opus-4-8 pointer when models are already the new trio', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-code': {
          id: 'claude-code',
          models: [...NEW_MODELS],
          defaultModel: 'claude-opus-4-8', // orphan: not in NEW_MODELS
          lightModel: 'claude-haiku-4-5',
          mediumModel: 'claude-sonnet-5',
          heavyModel: 'claude-opus-5',
        },
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code'];
    expect(after.defaultModel).toBe('claude-opus-5');
    expect(after.models).toContain(after.defaultModel);
  });

  it('is a no-op when models AND pointers are already opus-5', async () => {
    const current = {
      id: 'claude-code',
      models: [...NEW_MODELS],
      defaultModel: 'claude-opus-5',
      lightModel: 'claude-haiku-4-5',
      mediumModel: 'claude-sonnet-5',
      heavyModel: 'claude-opus-5',
    };
    writeJson(providersPath, { providers: { 'claude-code': current } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('skips a customized models list (user dropped haiku, etc.)', async () => {
    const customized = {
      id: 'claude-code',
      models: ['claude-sonnet-5', 'claude-opus-4-8'],
      defaultModel: 'claude-opus-4-8',
    };
    writeJson(providersPath, { providers: { 'claude-code': customized } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('treats a reordered trio as customization (skip)', async () => {
    const reordered = {
      id: 'claude-code',
      models: ['claude-opus-4-8', 'claude-haiku-4-5', 'claude-sonnet-5'],
      defaultModel: 'claude-opus-4-8',
    };
    writeJson(providersPath, { providers: { 'claude-code': reordered } });
    const beforeBytes = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(beforeBytes);
  });

  it('processes claude-code and claude-code-tui together, leaving others alone', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-code': opus48Trio(),
        'claude-code-tui': opus48Trio({ id: 'claude-code-tui' }),
        'codex': { id: 'codex', models: ['codex-configured-default'] },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath).providers;
    expect(out['claude-code'].defaultModel).toBe('claude-opus-5');
    expect(out['claude-code-tui'].defaultModel).toBe('claude-opus-5');
    expect(out['codex'].models).toEqual(['codex-configured-default']);
  });

  it('upgrades the Bedrock providers, preserving the [1m] long-context pin', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-code-bedrock': bedrockOpus48(),
        'claude-code-tui-bedrock': bedrockOpus48({ id: 'claude-code-tui-bedrock' }),
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath).providers;
    for (const id of ['claude-code-bedrock', 'claude-code-tui-bedrock']) {
      expect(out[id].models).toEqual(BEDROCK_NEW);
      expect(out[id].defaultModel).toBe('global.anthropic.claude-opus-5[1m]');
      expect(out[id].heavyModel).toBe('global.anthropic.claude-opus-5[1m]');
      // Other Bedrock tiers untouched.
      expect(out[id].lightModel).toBe('us.anthropic.claude-haiku-4-5');
      expect(out[id].mediumModel).toBe('us.anthropic.claude-sonnet-5');
    }
  });

  it('maps a plain (non-[1m]) Bedrock opus pin to the plain new id, not the [1m] one', async () => {
    writeJson(providersPath, {
      providers: {
        'claude-code-bedrock': bedrockOpus48({
          defaultModel: 'global.anthropic.claude-opus-4-8',
          heavyModel: 'global.anthropic.claude-opus-4-8',
        }),
      },
    });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['claude-code-bedrock'];
    expect(after.defaultModel).toBe('global.anthropic.claude-opus-5');
    expect(after.heavyModel).toBe('global.anthropic.claude-opus-5');
    expect(after.models).toContain(after.defaultModel);
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
