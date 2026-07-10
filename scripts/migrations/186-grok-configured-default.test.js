/**
 * Test for migration 186 — rewrite Grok Build CLI/TUI from `grok-build` to
 * the `grok-configured-default` sentinel. Picked up by server/vitest.config.js's
 * `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './186-grok-configured-default.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 186 — Grok Build configured-default sentinel', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-186-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('rewrites grok-build model fields on grok-cli and grok-tui', async () => {
    writeJson(providersPath, {
      providers: {
        'grok-cli': {
          id: 'grok-cli',
          models: ['grok-build'],
          defaultModel: 'grok-build',
          lightModel: 'grok-build',
          mediumModel: 'grok-build',
          heavyModel: 'grok-build',
        },
        'grok-tui': {
          id: 'grok-tui',
          models: ['grok-build'],
          defaultModel: 'grok-build',
          lightModel: 'grok-build',
          mediumModel: 'grok-build',
          heavyModel: 'grok-build',
        },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    for (const id of ['grok-cli', 'grok-tui']) {
      const p = out.providers[id];
      expect(p.models).toEqual(['grok-configured-default']);
      expect(p.defaultModel).toBe('grok-configured-default');
      expect(p.lightModel).toBe('grok-configured-default');
      expect(p.mediumModel).toBe('grok-configured-default');
      expect(p.heavyModel).toBe('grok-configured-default');
    }
  });

  it('leaves a custom pinned model alone', async () => {
    writeJson(providersPath, {
      providers: {
        'grok-cli': {
          id: 'grok-cli',
          models: ['grok-code-fast-1'],
          defaultModel: 'grok-code-fast-1',
          lightModel: 'grok-code-fast-1',
        },
      },
    });

    await migration.up({ rootDir });

    const cli = readJson(providersPath).providers['grok-cli'];
    expect(cli.models).toEqual(['grok-code-fast-1']);
    expect(cli.defaultModel).toBe('grok-code-fast-1');
  });

  it('only rewrites grok-build entries in a mixed models list', async () => {
    writeJson(providersPath, {
      providers: {
        'grok-cli': {
          id: 'grok-cli',
          models: ['grok-build', 'grok-code-fast-1'],
          defaultModel: 'grok-build',
        },
      },
    });

    await migration.up({ rootDir });

    const cli = readJson(providersPath).providers['grok-cli'];
    expect(cli.models).toEqual(['grok-configured-default', 'grok-code-fast-1']);
    expect(cli.defaultModel).toBe('grok-configured-default');
  });

  it('does not touch the xAI Grok API provider', async () => {
    writeJson(providersPath, {
      providers: {
        grok: {
          id: 'grok',
          models: ['grok-4', 'grok-3'],
          defaultModel: 'grok-4',
        },
        'grok-cli': {
          id: 'grok-cli',
          models: ['grok-build'],
          defaultModel: 'grok-build',
        },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);
    expect(out.providers.grok.defaultModel).toBe('grok-4');
    expect(out.providers.grok.models).toEqual(['grok-4', 'grok-3']);
    expect(out.providers['grok-cli'].defaultModel).toBe('grok-configured-default');
  });

  it('is idempotent', async () => {
    writeJson(providersPath, {
      providers: {
        'grok-cli': { id: 'grok-cli', models: ['grok-build'], defaultModel: 'grok-build' },
      },
    });

    await migration.up({ rootDir });
    const afterFirst = readFileSync(providersPath, 'utf-8');
    await migration.up({ rootDir });
    expect(readFileSync(providersPath, 'utf-8')).toBe(afterFirst);
  });

  it('is a no-op when data/providers.json does not exist', async () => {
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
