/**
 * Migration 345. What this uniquely catches: a gate keyed on the migration's
 * own OUTPUT (which would let a shipped seed stand where the user's record was)
 * and a stamp that overwrites a pin the user already made.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './345-codex-ignore-user-config.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 345 — codex ignoreUserConfig', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-345-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('stamps the field off on codex records, including a path-configured clone', async () => {
    writeJson(providersPath, {
      providers: {
        codex: { id: 'codex', type: 'cli', command: 'codex' },
        'codex-tui': { id: 'codex-tui', type: 'tui', command: '/opt/tools/codex' },
        'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' },
      },
    });

    expect(await migration.up({ rootDir })).toMatchObject({ ok: true, updated: 2 });
    const out = readJson(providersPath).providers;
    expect(out.codex.ignoreUserConfig).toBe(false);
    expect(out['codex-tui'].ignoreUserConfig).toBe(false);
    expect(out['claude-code']).not.toHaveProperty('ignoreUserConfig');
  });

  it('never overwrites a pin the user already made, and is a no-op on re-run', async () => {
    writeJson(providersPath, {
      providers: { codex: { id: 'codex', type: 'cli', command: 'codex', ignoreUserConfig: true } },
    });

    expect(await migration.up({ rootDir })).toMatchObject({ reason: 'already-current', updated: 0 });
    expect(readJson(providersPath).providers.codex.ignoreUserConfig).toBe(true);
  });

  it('skips an install with no codex record rather than inventing one', async () => {
    writeJson(providersPath, {
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    expect(await migration.up({ rootDir })).toMatchObject({ reason: 'no-codex-records', updated: 0 });
  });

  it('skips a missing providers file', async () => {
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, updated: 0 });
  });
});
