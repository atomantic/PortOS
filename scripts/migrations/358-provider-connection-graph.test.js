/**
 * Migration 358 parks a pre-graph recovery copy of `data/providers.json`
 * (#6367).
 *
 * The gate direction is the regression worth a test: gating on the OUTPUT's
 * absence is the shape that silently left shipped defaults where a user's data
 * was (see `scripts/migrations/340-cos-config-seed-repair.js`). This one gates
 * on the INPUT, and a re-run must never overwrite the parked copy with a
 * post-graph file.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './358-provider-connection-graph.js';
import { MIGRATION_OWNED_PATHS } from '../lib/migrationOwnedPaths.js';

let rootDir;
const recoveryPath = () => join(rootDir, 'data/private/providers.pre-graph.json');

const PROVIDERS = {
  activeProvider: 'example-cli',
  providers: {
    'example-cli': {
      id: 'example-cli', name: 'Example', type: 'cli', command: 'claude', enabled: true,
      envVars: { ANTHROPIC_AUTH_TOKEN: 'example-token' },
    },
    'example-disabled': { id: 'example-disabled', name: 'Off', type: 'tui', command: 'claude', enabled: false },
  },
};

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-migration-358-'));
  await mkdir(join(rootDir, 'data'), { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
});

describe('358-provider-connection-graph', () => {
  it('parks an exact copy of the provider file, disabled records included', async () => {
    await writeFile(join(rootDir, 'data/providers.json'), JSON.stringify(PROVIDERS));

    expect(await migration.up({ rootDir })).toEqual({ success: true });
    expect(JSON.parse(await readFile(recoveryPath(), 'utf-8'))).toEqual(PROVIDERS);
  });

  it('skips when the INPUT is absent rather than seeding anything', async () => {
    expect(await migration.up({ rootDir })).toEqual({ success: true, skipped: 'no providers.json' });
    await expect(readFile(recoveryPath(), 'utf-8')).rejects.toThrow();
  });

  it('never overwrites an existing recovery copy with a post-graph file', async () => {
    // A re-run after the graph has already rewritten providers.json must leave
    // the pre-graph copy alone — that copy is the whole point.
    await writeFile(join(rootDir, 'data/providers.json'), JSON.stringify(PROVIDERS));
    await migration.up({ rootDir });
    await writeFile(join(rootDir, 'data/providers.json'), JSON.stringify({ activeProvider: null, providers: {} }));

    expect(await migration.up({ rootDir })).toEqual({ success: true, skipped: 'recovery copy already parked' });
    expect(JSON.parse(await readFile(recoveryPath(), 'utf-8'))).toEqual(PROVIDERS);
  });

  it('fails loudly on an unreadable provider file rather than parking nothing', async () => {
    await writeFile(join(rootDir, 'data/providers.json'), '{ not json');
    await expect(migration.up({ rootDir })).rejects.toThrow(/unreadable/i);
  });

  it('declares its derived output so no data.reference seed can shadow it', () => {
    expect(MIGRATION_OWNED_PATHS.has('private/providers.pre-graph.json')).toBe(true);
  });
});
