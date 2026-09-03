/**
 * Test for migration 335 — update Antigravity CLI and TUI model catalog to include Gemini 3.8.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './335-antigravity-gemini-3-8-models.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const SENTINEL = 'antigravity-configured-default';

const OLD_MODELS = [
  SENTINEL,
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.5-flash-high',
  'gemini-3.5-flash-medium',
  'gemini-3.5-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

const NEW_MODELS = [
  SENTINEL,
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

describe('migration 335 — Antigravity Gemini 3.8 model catalog', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-335-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('updates prior seeded models list on antigravity-cli and antigravity-tui', async () => {
    writeJson(providersPath, {
      providers: {
        'antigravity-cli': {
          id: 'antigravity-cli',
          type: 'cli',
          command: 'agy',
          models: [...OLD_MODELS],
          defaultModel: SENTINEL,
        },
        'antigravity-tui': {
          id: 'antigravity-tui',
          type: 'tui',
          command: 'agy',
          models: [...OLD_MODELS],
          defaultModel: SENTINEL,
        },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['antigravity-cli'].models).toEqual(NEW_MODELS);
    expect(out.providers['antigravity-tui'].models).toEqual(NEW_MODELS);
  });

  it('updates sentinel-only antigravity providers', async () => {
    writeJson(providersPath, {
      providers: {
        'antigravity-cli': {
          id: 'antigravity-cli',
          type: 'cli',
          command: 'agy',
          models: [SENTINEL],
          defaultModel: SENTINEL,
        },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['antigravity-cli'].models).toEqual(NEW_MODELS);
  });

  it('leaves already-current model lists alone', async () => {
    writeJson(providersPath, {
      providers: {
        'antigravity-cli': {
          id: 'antigravity-cli',
          type: 'cli',
          command: 'agy',
          models: [...NEW_MODELS],
          defaultModel: SENTINEL,
        },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['antigravity-cli'].models).toEqual(NEW_MODELS);
  });

  it('leaves customized model lists alone', async () => {
    const customModels = [SENTINEL, 'my-custom-model', 'gemini-3.6-flash-high'];
    writeJson(providersPath, {
      providers: {
        'antigravity-cli': {
          id: 'antigravity-cli',
          type: 'cli',
          command: 'agy',
          models: [...customModels],
          defaultModel: 'my-custom-model',
        },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['antigravity-cli'].models).toEqual(customModels);
  });

  it('is a no-op when data/providers.json does not exist (fresh install)', async () => {
    rmSync(providersPath, { force: true });
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
  });

  it('skips gracefully when providers.json is invalid JSON', async () => {
    writeFileSync(providersPath, 'not-json');
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
  });
});
