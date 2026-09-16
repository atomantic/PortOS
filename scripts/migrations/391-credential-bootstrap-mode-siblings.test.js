import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './391-credential-bootstrap-mode-siblings.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const BOOTSTRAP = { command: 'token-cli', args: ['run'] };
const pair = (extra = {}) => ({
  example: { id: 'example', name: 'Example CLI', type: 'cli', command: 'example', args: ['--print'], enabled: true, models: ['a'], ...extra.cli },
  'example-tui': { id: 'example-tui', name: 'Example TUI', type: 'tui', command: 'example', args: [], enabled: true, models: ['a'], ...extra.tui },
});

describe('migration 391 — credential bootstrap on mode siblings', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-391-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('gives the sibling the pair’s one bootstrap, and re-runs clean', async () => {
    writeJson(providersPath, { activeProvider: 'example', providers: pair({ cli: { credentialBootstrap: BOOTSTRAP } }) });

    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, updated: 1 });
    const out = readJson(providersPath);
    expect(out.providers['example-tui'].credentialBootstrap).toEqual(BOOTSTRAP);
    // Mode-specific argv is untouched — only the connection's auth converges.
    expect(out.providers['example-tui'].args).toEqual([]);
    expect(out.activeProvider).toBe('example');

    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, updated: 0 });
    expect(readJson(providersPath)).toEqual(out);
  });

  it('leaves a pair alone when both modes name a bootstrap, and when they are not the same connection', async () => {
    const other = { command: 'other-cli' };
    const providers = {
      ...pair({ cli: { credentialBootstrap: BOOTSTRAP }, tui: { credentialBootstrap: other } }),
      // Same harness, different backend: two connections, not one card.
      split: { id: 'split', type: 'cli', command: 'split', models: [], envVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' }, credentialBootstrap: BOOTSTRAP },
      'split-tui': { id: 'split-tui', type: 'tui', command: 'split', models: [], envVars: {} },
    };
    writeJson(providersPath, { providers });

    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, updated: 0 });
    const out = readJson(providersPath).providers;
    expect(out['example-tui'].credentialBootstrap).toEqual(other);
    expect(out['split-tui']).not.toHaveProperty('credentialBootstrap');
  });

  it('skips an install with no providers file', async () => {
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'no-file', updated: 0 });
  });
});
