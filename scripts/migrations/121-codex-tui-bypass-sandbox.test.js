/**
 * Test for migration 121 — flip the Codex TUI provider from the partial
 * `--ask-for-approval never` posture (sandbox still on, network blocked) to the
 * full `--dangerously-bypass-approvals-and-sandbox` headless posture. Picked up
 * by server/vitest.config.js's `../scripts/**\/*.test.js` glob.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './121-codex-tui-bypass-sandbox.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

const OLD_ARGS = ['--ask-for-approval', 'never'];
const NEW_ARGS = ['--dangerously-bypass-approvals-and-sandbox'];

const codexTui = (overrides = {}) => ({
  id: 'codex-tui',
  name: 'Codex TUI',
  type: 'tui',
  command: 'codex',
  args: [...OLD_ARGS],
  enabled: false,
  ...overrides,
});

describe('migration 121 — Codex TUI bypass sandbox', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-121-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('rewrites the old `--ask-for-approval never` args to the full bypass flag', async () => {
    writeJson(providersPath, { providers: { 'codex-tui': codexTui() } });

    await migration.up({ rootDir });

    const after = readJson(providersPath).providers['codex-tui'];
    expect(after.args).toEqual(NEW_ARGS);
    // unrelated fields preserved
    expect(after.command).toBe('codex');
    expect(after.enabled).toBe(false);
  });

  it('is a no-op when args are already the bypass flag', async () => {
    writeJson(providersPath, { providers: { 'codex-tui': codexTui({ args: [...NEW_ARGS] }) } });
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('leaves customized args alone (user pinned their own sandbox)', async () => {
    const customized = codexTui({ args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'] });
    writeJson(providersPath, { providers: { 'codex-tui': customized } });
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('treats reordered args as customization (skip)', async () => {
    const reordered = codexTui({ args: ['never', '--ask-for-approval'] });
    writeJson(providersPath, { providers: { 'codex-tui': reordered } });
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('does not touch other providers', async () => {
    writeJson(providersPath, {
      providers: {
        'codex-tui': codexTui(),
        'codex': { id: 'codex', type: 'cli', command: 'codex', args: [] },
        'claude-code-tui': { id: 'claude-code-tui', type: 'tui', args: ['-p', '-'] },
      },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath).providers;
    expect(out['codex-tui'].args).toEqual(NEW_ARGS);
    expect(out['codex'].args).toEqual([]);
    expect(out['claude-code-tui'].args).toEqual(['-p', '-']);
  });

  it('is a no-op when codex-tui provider is absent', async () => {
    writeJson(providersPath, { providers: { 'codex': { id: 'codex', args: [] } } });
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('is a no-op when data/providers.json does not exist (fresh install)', async () => {
    await migration.up({ rootDir });

    expect(existsSync(providersPath)).toBe(false);
  });

  it('does not modify the file on invalid JSON (logs a warning and skips)', async () => {
    writeFileSync(providersPath, '{ not valid json');
    const before = readFileSync(providersPath, 'utf-8');

    await migration.up({ rootDir });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });
});
