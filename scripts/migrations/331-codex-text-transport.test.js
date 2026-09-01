import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './331-codex-text-transport.js';

const CODEX = {
  id: 'codex', name: 'Codex CLI', type: 'cli', command: 'codex', enabled: true,
};

describe('migration 331 — codex text transport', () => {
  let rootDir;
  let providersPath;

  const writeProviders = (providers) => {
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    writeFileSync(providersPath, `${JSON.stringify({ activeProvider: 'codex', providers }, null, 2)}\n`);
  };
  const readProviders = () => JSON.parse(readFileSync(providersPath, 'utf8')).providers;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-331-'));
    providersPath = join(rootDir, 'data', 'providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('skips a fresh install with no providers.json (data.reference already ships the flag)', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: false, reason: 'no-file', updated: 0 });
  });

  it('advertises the transport without enabling it', async () => {
    writeProviders({ codex: { ...CODEX } });

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'updated', updated: 1 });

    const codex = readProviders().codex;
    expect(codex.textTransport).toBe('codex-app-server');
    // The capability must stay OFF: a migration that enabled it would start
    // routing existing background features at the user's ChatGPT subscription
    // the moment they updated.
    expect(codex.textTransportEnabled).toBeUndefined();
    expect(codex).toMatchObject(CODEX);
  });

  it('matches a renamed clone by its command, and leaves other providers alone', async () => {
    writeProviders({
      codex: { ...CODEX, command: '/opt/bin/codex', name: 'My Codex' },
      openrouter: { id: 'openrouter', type: 'api', endpoint: 'https://example.com/v1', apiKey: 'secret' },
    });

    await migration.up({ rootDir });

    const providers = readProviders();
    expect(providers.codex.textTransport).toBe('codex-app-server');
    expect(providers.openrouter).toEqual({
      id: 'openrouter', type: 'api', endpoint: 'https://example.com/v1', apiKey: 'secret',
    });
  });

  it('leaves a record the user repointed at a different binary untouched', async () => {
    writeProviders({ codex: { ...CODEX, command: 'my-wrapper' } });

    await expect(migration.up({ rootDir })).resolves.toEqual({
      ok: true, reason: 'already-current-or-custom', updated: 0,
    });
    expect(readProviders().codex.textTransport).toBeUndefined();
  });

  it('is a no-op on a second run', async () => {
    writeProviders({ codex: { ...CODEX } });
    await migration.up({ rootDir });

    await expect(migration.up({ rootDir })).resolves.toEqual({
      ok: true, reason: 'already-current-or-custom', updated: 0,
    });
  });
});
