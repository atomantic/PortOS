/**
 * Test for migration 164 — backfill the OpenCode Ollama providers' inline
 * config with a declared `models` map (issue-2190). Picked up by
 * server/vitest.config.js's `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './164-opencode-ollama-config-models-map.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const BASE_CONFIG = '{"permission":"allow","provider":{"ollama":{"npm":"@ai-sdk/openai-compatible","name":"Ollama (local)","options":{"baseURL":"http://localhost:11434/v1"}}}}';

const opencodeProvider = (overrides = {}) => ({
  id: 'opencode-ollama',
  type: 'cli',
  command: 'opencode',
  ollamaBacked: true,
  models: [],
  defaultModel: null,
  envVars: { OPENCODE_CONFIG_CONTENT: BASE_CONFIG },
  ...overrides,
});

describe('migration 164 — OpenCode Ollama config models map', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-164-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('injects a models map from a configured defaultModel', async () => {
    writeJson(providersPath, {
      providers: { 'opencode-ollama': opencodeProvider({ defaultModel: 'qwen2.5:7b' }) },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    const cfg = JSON.parse(out.providers['opencode-ollama'].envVars.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.ollama.models).toEqual({ 'qwen2.5:7b': { name: 'qwen2.5:7b', tool_call: true } });
    // base config preserved
    expect(cfg.permission).toBe('allow');
    expect(cfg.provider.ollama.options.baseURL).toBe('http://localhost:11434/v1');
  });

  it('unions the models array + defaultModel across both providers', async () => {
    writeJson(providersPath, {
      providers: {
        'opencode-ollama': opencodeProvider({ models: ['qwen2.5:7b', 'llama3.1:8b'], defaultModel: 'qwen2.5:7b' }),
        'opencode-ollama-tui': opencodeProvider({ id: 'opencode-ollama-tui', type: 'tui', models: ['mistral:7b'] }),
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    const cli = JSON.parse(out.providers['opencode-ollama'].envVars.OPENCODE_CONFIG_CONTENT);
    expect(Object.keys(cli.provider.ollama.models).sort()).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
    const tui = JSON.parse(out.providers['opencode-ollama-tui'].envVars.OPENCODE_CONFIG_CONTENT);
    expect(Object.keys(tui.provider.ollama.models)).toEqual(['mistral:7b']);
  });

  it('strips the ollama/ namespace from stored ids', async () => {
    writeJson(providersPath, {
      providers: { 'opencode-ollama': opencodeProvider({ models: ['ollama/qwen2.5:7b'] }) },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    const cfg = JSON.parse(out.providers['opencode-ollama'].envVars.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.ollama.models['qwen2.5:7b']).toBeDefined();
    expect(cfg.provider.ollama.models['ollama/qwen2.5:7b']).toBeUndefined();
  });

  it('leaves the stored config untouched when no models are configured', async () => {
    writeJson(providersPath, {
      providers: { 'opencode-ollama': opencodeProvider() },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['opencode-ollama'].envVars.OPENCODE_CONFIG_CONTENT).toBe(BASE_CONFIG);
  });

  it('is idempotent — a second run makes no further change', async () => {
    writeJson(providersPath, {
      providers: { 'opencode-ollama': opencodeProvider({ defaultModel: 'qwen2.5:7b' }) },
    });

    await migration.up({ rootDir });
    const first = readFileSync(providersPath, 'utf-8');
    await migration.up({ rootDir });
    const second = readFileSync(providersPath, 'utf-8');
    expect(second).toBe(first);
  });

  it('leaves unrelated providers and active provider untouched', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: {
        'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' },
        'opencode-ollama': opencodeProvider({ defaultModel: 'qwen2.5:7b' }),
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.activeProvider).toBe('claude-code');
    expect(out.providers['claude-code']).toEqual({ id: 'claude-code', type: 'cli', command: 'claude' });
  });

  it('skips gracefully when providers.json is missing', async () => {
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });

  it('skips a provider whose OPENCODE_CONFIG_CONTENT is not valid JSON', async () => {
    writeJson(providersPath, {
      providers: {
        'opencode-ollama': opencodeProvider({ defaultModel: 'qwen2.5:7b', envVars: { OPENCODE_CONFIG_CONTENT: 'not json' } }),
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers['opencode-ollama'].envVars.OPENCODE_CONFIG_CONTENT).toBe('not json');
  });
});
