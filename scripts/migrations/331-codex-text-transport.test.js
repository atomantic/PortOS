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

  it('stamps every Codex harness record, clones included, and leaves others alone', async () => {
    writeProviders({
      codex: { ...CODEX, command: '/opt/bin/codex', name: 'My Codex' },
      'codex-review': { id: 'codex-review', type: 'cli', command: 'codex', enabled: true },
      'codex-tui': { id: 'codex-tui', type: 'tui', command: 'codex', enabled: false },
      openrouter: { id: 'openrouter', type: 'api', endpoint: 'https://example.com/v1', apiKey: 'secret' },
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'updated', updated: 3 });

    const providers = readProviders();
    // Keyed on the COMMAND, so a renamed clone and the disabled TUI record are
    // covered too — an upgraded install then matches what data.reference seeds.
    for (const id of ['codex', 'codex-review', 'codex-tui']) {
      expect(providers[id].textTransport).toBe('codex-app-server');
    }
    expect(providers.openrouter).toEqual({
      id: 'openrouter', type: 'api', endpoint: 'https://example.com/v1', apiKey: 'secret',
    });
  });

  it('matches the runtime predicate exactly on command spelling', async () => {
    // A record this stamps but `providerDeclaresCodexTextTransport` then rejects
    // advertises a capability the toggle can never switch on; one it skips never
    // gets the flag at all. Both halves must apply the same rule: lowercase the
    // basename, strip only `.exe`.
    writeProviders({
      codex: { ...CODEX, command: 'Codex' },
      'codex-exe': { id: 'codex-exe', type: 'cli', command: 'C:\\bin\\CODEX.EXE', enabled: true },
      'codex-cmd': { id: 'codex-cmd', type: 'cli', command: 'codex.cmd', enabled: true },
    });

    await migration.up({ rootDir });

    const providers = readProviders();
    expect(providers.codex.textTransport).toBe('codex-app-server');
    expect(providers['codex-exe'].textTransport).toBe('codex-app-server');
    // `.cmd` is not directly spawnable and the runtime gate rejects it, so the
    // migration must not advertise it either.
    expect(providers['codex-cmd'].textTransport).toBeUndefined();
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
