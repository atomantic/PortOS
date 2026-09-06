import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import migration from './346-codex-ollama-provider.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const ID = 'codex-ollama';

describe('migration 346 — Codex Ollama provider', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-345-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('adds the preset disabled, without touching the cloud codex row or the active provider', async () => {
    const codex = { id: 'codex', type: 'cli', command: 'codex', enabled: true, textTransport: 'codex-app-server' };
    writeJson(providersPath, { activeProvider: 'codex', providers: { codex } });

    await migration.up({ rootDir });
    const out = readJson(providersPath);

    expect(out.providers[ID]).toMatchObject({
      name: 'Codex Ollama (local model)',
      type: 'cli',
      command: 'codex',
      ollamaBacked: true,
      enabled: false,
      defaultModel: null,
      models: [],
    });
    expect(out.providers.codex).toEqual(codex);
    expect(out.activeProvider).toBe('codex');
  });

  it('pins numCtx — an unpinned local prefill at codex\'s native window is the #6191 trap', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    expect(readJson(providersPath).providers[ID].numCtx).toBe(131072);
  });

  it('carries NO textTransport — the app-server transport is the ChatGPT path', async () => {
    // A local-backed record runs the ordinary `codex exec` argv, which is what
    // carries the --oss flags; the app-server transport would bypass them.
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    expect(readJson(providersPath).providers[ID].textTransport).toBeUndefined();
  });

  it('marks the backing with the SHARED local-runtime axis, not a codex-only flag', async () => {
    // `ollamaBacked` is what makes isOllamaBackedProvider / localRuntimeNamespace
    // / ensureOllamaAgentContext pick the row up with no new call site.
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const row = readJson(providersPath).providers[ID];
    expect(row.ollamaBacked).toBe(true);
    expect(Object.keys(row).filter((key) => key.endsWith('Backed'))).toEqual(['ollamaBacked']);
  });

  it('preserves a customized or disabled row rather than resurrecting the shipped one', async () => {
    const existing = {
      id: ID, name: 'My Codex Ollama', type: 'cli', command: '/opt/tools/codex',
      ollamaBacked: true, numCtx: 32768, enabled: true,
    };
    writeJson(providersPath, { providers: { [ID]: existing } });

    await migration.up({ rootDir });
    expect(readJson(providersPath).providers[ID]).toEqual(existing);
  });

  it('is idempotent — a second run changes nothing', async () => {
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const first = readFileSync(providersPath, 'utf-8');

    const second = await migration.up({ rootDir });
    expect(second).toMatchObject({ ok: true, reason: 'already-present', added: 0 });
    expect(readFileSync(providersPath, 'utf-8')).toBe(first);
  });

  it('skips a fresh install with no providers file — data.reference seeds that one', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toMatchObject({ ok: false, reason: 'no-file', added: 0 });
  });

  it('ships the same record all three seed copies do', async () => {
    // Three populations, three sources: the migration upgrades an existing
    // install, data.reference seeds a fresh one, and providers.sample.json is
    // loadProviders()'s fallback. A divergence gives them different providers.
    writeJson(providersPath, { providers: {} });
    await migration.up({ rootDir });
    const migrated = readJson(providersPath).providers[ID];
    const reference = readJson(resolve(__dirname, '../../data.reference/providers.json')).providers[ID];
    const sample = readJson(resolve(__dirname, '../../server/lib/aiToolkit/defaults/providers.sample.json')).providers[ID];

    expect(migrated).toEqual(reference);
    expect(sample).toEqual(reference);
  });
});
