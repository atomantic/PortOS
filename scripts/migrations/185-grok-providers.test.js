/**
 * Test for migration 185 — add the xAI Grok provider trio (API + Grok Build
 * CLI + TUI) to existing installs. Picked up by server/vitest.config.js's
 * `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './185-grok-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 185 — Grok providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-185-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds the api, cli, and tui Grok providers to an existing install', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);

    const api = out.providers.grok;
    expect(api.type).toBe('api');
    expect(api.endpoint).toBe('https://api.x.ai/v1');
    expect(api.defaultModel).toBe('grok-4');
    expect(api.enabled).toBe(false);

    const cli = out.providers['grok-cli'];
    expect(cli.type).toBe('cli');
    expect(cli.command).toBe('grok');
    expect(cli.defaultModel).toBe('grok-build');

    const tui = out.providers['grok-tui'];
    expect(tui.type).toBe('tui');
    expect(tui.command).toBe('grok');
    expect(tui.tuiPromptDelayMs).toBe(2500);

    // unrelated providers + active provider untouched
    expect(out.providers['claude-code']).toBeDefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  it('does not overwrite a user-customized grok entry', async () => {
    writeJson(providersPath, {
      providers: {
        grok: { id: 'grok', type: 'api', endpoint: 'https://api.x.ai/v1', enabled: true, apiKey: 'sk-secret', defaultModel: 'grok-3' },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    // existing entry preserved untouched
    expect(out.providers.grok.enabled).toBe(true);
    expect(out.providers.grok.apiKey).toBe('sk-secret');
    expect(out.providers.grok.defaultModel).toBe('grok-3');
    // the still-missing CLI/TUI siblings are added alongside it
    expect(out.providers['grok-cli']).toBeDefined();
    expect(out.providers['grok-tui']).toBeDefined();
  });

  it('deep-copies shipped arrays/objects so mutating the install cannot corrupt the frozen defaults', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const first = readJson(providersPath);
    first.providers.grok.models.push('mutated');

    // A second install run must still ship the pristine model list.
    const rootDir2 = mkdtempSync(join(tmpdir(), 'migration-185-b-'));
    mkdirSync(join(rootDir2, 'data'), { recursive: true });
    const providersPath2 = join(rootDir2, 'data/providers.json');
    writeJson(providersPath2, { providers: {} });
    await migration.up({ rootDir: rootDir2 });
    expect(readJson(providersPath2).providers.grok.models).not.toContain('mutated');
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
});
