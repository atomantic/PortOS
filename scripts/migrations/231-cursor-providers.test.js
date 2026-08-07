/**
 * Test for migration 231 — add the Cursor Agent process-provider pair (CLI + TUI)
 * to existing installs. Picked up by server/vitest.config.js's
 * `../scripts/**\/*.test.js` glob.
 *
 * The shell shared by all six provider-seed migrations (read → guard → add
 * missing ids → conditional write) is asserted once against
 * `makeProviderSeedMigration` in _lib.test.js; what stays here is this
 * migration's own frozen payload.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './231-cursor-providers.js';

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 231 — Cursor providers', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-231-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('adds the cli and tui Cursor providers to an existing install', async () => {
    writeJson(providersPath, {
      activeProvider: 'claude-code',
      providers: { 'claude-code': { id: 'claude-code', type: 'cli', command: 'claude' } },
    });

    await migration.up({ rootDir });

    const out = readJson(providersPath);

    const cli = out.providers['cursor-cli'];
    expect(cli.type).toBe('cli');
    expect(cli.command).toBe('cursor-agent');
    // `--force` clears the workspace-trust gate as well as auto-approving tools;
    // without it a headless run exits before doing any work.
    expect(cli.args).toEqual(['--print', '--force']);
    expect(cli.defaultModel).toBe('auto');
    expect(cli.models).toContain('auto');
    expect(cli.enabled).toBe(false);

    const tui = out.providers['cursor-tui'];
    expect(tui.type).toBe('tui');
    expect(tui.command).toBe('cursor-agent');
    expect(tui.args).toEqual(['--force']);
    expect(tui.tuiPromptDelayMs).toBe(2500);
    expect(tui.tuiIdleTimeoutMs).toBe(180000);

    // unrelated providers + active provider untouched
    expect(out.providers['claude-code']).toBeDefined();
    expect(out.activeProvider).toBe('claude-code');
  });

  // Replaces a pair of "deep-copy isolation" tests that could not fail: they
  // mutated a value re-parsed from disk, which has no reference relationship to
  // the module-level CURSOR_MODELS, so `structuredClone` could be deleted
  // outright and they would still pass. What is actually worth pinning is the
  // frozen payload this migration installs — it is the historical record an
  // upgraded install receives, and it must match what a fresh install seeds.
  it('installs the exact frozen model catalog and tier pointers', () => {
    writeJson(providersPath, { providers: {} });
    return migration.up({ rootDir }).then(() => {
      const out = readJson(providersPath);
      for (const id of ['cursor-cli', 'cursor-tui']) {
        const p = out.providers[id];
        expect(p.defaultModel).toBe('auto');
        expect(p.lightModel).toBe('composer-2.5');
        expect(p.mediumModel).toBe('claude-sonnet-5-thinking-high');
        expect(p.heavyModel).toBe('claude-opus-5-thinking-high');
        expect(p.models).toHaveLength(27);
        // Every tier pointer must be selectable, or the picker renders blank.
        for (const tier of [p.defaultModel, p.lightModel, p.mediumModel, p.heavyModel]) {
          expect(p.models, `${id}: ${tier} missing from models`).toContain(tier);
        }
      }
      // Both entries are built from one shared CURSOR_MODELS constant — they must
      // ship the same catalog, or a user's CLI and TUI offer different models.
      expect(out.providers['cursor-cli'].models).toEqual(out.providers['cursor-tui'].models);
    });
  });
});
