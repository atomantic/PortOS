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

  it('leaves a pair alone when the two modes CONTRADICT each other', async () => {
    const other = { command: 'other-cli' };
    const providers = {
      ...pair({ cli: { credentialBootstrap: BOOTSTRAP }, tui: { credentialBootstrap: other } }),
      // Two backends named outright: two connections, not one card. The
      // contradiction disqualifies the whole group, so the bootstrap only the
      // CLI names must not reach the TUI either — a credential entered for one
      // backend never follows the pair to another (#7500).
      split: { id: 'split', type: 'cli', command: 'split', models: [], envVars: { EXAMPLE_BASE_URL: 'http://127.0.0.1:11434' }, credentialBootstrap: BOOTSTRAP },
      'split-tui': { id: 'split-tui', type: 'tui', command: 'split', models: [], envVars: { EXAMPLE_BASE_URL: 'https://api.example.com' } },
    };
    writeJson(providersPath, { providers });

    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, updated: 0 });
    const out = readJson(providersPath).providers;
    expect(out['example-tui'].credentialBootstrap).toEqual(other);
    expect(out['split-tui']).not.toHaveProperty('credentialBootstrap');
  });

  it('converges a pair that carries the whole connection on only ONE mode', async () => {
    // The reserved `<stem>` / `<stem>-tui` id pair IS the declaration that two
    // records are one harness in two modes, so a sibling carrying nothing is an
    // INCOMPLETE pair, not a second connection — a second connection gets its
    // own id. Deciding that for endpoint/apiKey/envVars as well as the
    // bootstrap is what #7500 settled; a contradiction still blocks the fill.
    writeJson(providersPath, { providers: pair({ cli: {
      endpoint: 'https://api.example.com', apiKey: 'k', envVars: { EXAMPLE_BASE_URL: 'https://api.example.com' },
    } }) });

    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, updated: 1 });
    const out = readJson(providersPath).providers;
    expect(out['example-tui']).toMatchObject({
      endpoint: 'https://api.example.com', apiKey: 'k', envVars: { EXAMPLE_BASE_URL: 'https://api.example.com' },
    });
    expect(out['example-tui'].args).toEqual([]);
  });

  it('skips an install with no providers file', async () => {
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'no-file', updated: 0 });
  });
});
