import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './339-claude-ollama-num-ctx.js';

const CLAUDE_OLLAMA = {
  id: 'claude-ollama',
  name: 'Claude Ollama (local model)',
  type: 'cli',
  command: 'claude',
  ollamaBacked: true,
  enabled: false,
};

describe('migration 339 — claude-ollama context window pin', () => {
  let rootDir;
  let providersPath;

  const writeProviders = (providers) => {
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    writeFileSync(providersPath, `${JSON.stringify({ activeProvider: 'claude', providers }, null, 2)}\n`);
  };
  const readProviders = () => JSON.parse(readFileSync(providersPath, 'utf8')).providers;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-339-'));
    providersPath = join(rootDir, 'data', 'providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('skips a fresh install with no providers.json (data.reference already ships the window)', async () => {
    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: false, reason: 'no-file', updated: 0 });
  });

  it('pins 131072 on a record that carries no numCtx', async () => {
    writeProviders({ 'claude-ollama': { ...CLAUDE_OLLAMA } });

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'updated', updated: 1 });

    const provider = readProviders()['claude-ollama'];
    expect(provider.numCtx).toBe(131072);
    expect(provider).toMatchObject(CLAUDE_OLLAMA);
  });

  it('treats a normalized null numCtx as unset', async () => {
    // `createProvider` writes `numCtx: null` for every absent value, so a stored
    // null is indistinguishable from never-set — and is the state essentially
    // every real install is in. Skipping it would make this migration a no-op.
    writeProviders({ 'claude-ollama': { ...CLAUDE_OLLAMA, numCtx: null } });

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'updated', updated: 1 });
    expect(readProviders()['claude-ollama'].numCtx).toBe(131072);
  });

  it('stamps every Ollama-backed Claude harness record, clones included, and leaves others alone', async () => {
    writeProviders({
      'claude-ollama': { ...CLAUDE_OLLAMA, command: '/opt/bin/claude', name: 'My Claude Ollama' },
      'claude-ollama-tui': { ...CLAUDE_OLLAMA, id: 'claude-ollama-tui', type: 'tui' },
      'claude-ollama-review': { ...CLAUDE_OLLAMA, id: 'claude-ollama-review', command: 'CLAUDE.EXE' },
      // Ollama-backed but a different harness: OpenCode sizes its own window.
      'opencode-ollama': { id: 'opencode-ollama', type: 'cli', command: 'opencode', ollamaBacked: true },
      // The cloud Claude CLI is not Ollama-backed at all.
      claude: { id: 'claude', type: 'cli', command: 'claude', enabled: true },
      ollama: { id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' },
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: true, reason: 'updated', updated: 3 });

    const providers = readProviders();
    for (const id of ['claude-ollama', 'claude-ollama-tui', 'claude-ollama-review']) {
      expect(providers[id].numCtx).toBe(131072);
    }
    expect(providers['opencode-ollama'].numCtx).toBeUndefined();
    expect(providers.claude.numCtx).toBeUndefined();
    expect(providers.ollama).toEqual({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' });
  });

  it('leaves a window the user chose alone, larger or smaller', async () => {
    writeProviders({
      'claude-ollama': { ...CLAUDE_OLLAMA, numCtx: 32768 },
      'claude-ollama-tui': { ...CLAUDE_OLLAMA, id: 'claude-ollama-tui', type: 'tui', numCtx: 262144 },
    });

    await expect(migration.up({ rootDir })).resolves.toEqual({
      ok: true, reason: 'already-current-or-custom', updated: 0,
    });

    const providers = readProviders();
    expect(providers['claude-ollama'].numCtx).toBe(32768);
    expect(providers['claude-ollama-tui'].numCtx).toBe(262144);
  });

  it('leaves a record the user repointed at a different binary untouched', async () => {
    writeProviders({ 'claude-ollama': { ...CLAUDE_OLLAMA, command: 'my-wrapper' } });

    await expect(migration.up({ rootDir })).resolves.toEqual({
      ok: true, reason: 'already-current-or-custom', updated: 0,
    });
    expect(readProviders()['claude-ollama'].numCtx).toBeUndefined();
  });

  it('is a no-op on a second run', async () => {
    writeProviders({ 'claude-ollama': { ...CLAUDE_OLLAMA } });
    await migration.up({ rootDir });

    await expect(migration.up({ rootDir })).resolves.toEqual({
      ok: true, reason: 'already-current-or-custom', updated: 0,
    });
  });

  it('reports an unreadable providers.json instead of throwing', async () => {
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    writeFileSync(providersPath, '{ not json');

    await expect(migration.up({ rootDir })).resolves.toEqual({ ok: false, reason: 'unreadable', updated: 0 });
  });
});
