import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './323-eidoverse-world-design-v2.js';
import { EIDOVERSE_WORLD_DESIGN_V1 } from '../../server/lib/eidoverseWorldDesign.js';

let rootDir;
const statePath = () => join(rootDir, 'data', 'eidoverse', 'portos-world.json');
const readState = async () => JSON.parse(await readFile(statePath(), 'utf8'));

afterEach(async () => {
  vi.restoreAllMocks();
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

describe('migration 323 — Eidoverse World Design V2', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    rootDir = await mkdtemp(join(tmpdir(), 'portos-eidoverse-design-'));
    await mkdir(join(rootDir, 'data', 'eidoverse'), { recursive: true });
  });

  it('upgrades the V1 default and leaves V2 pending for online reconciliation', async () => {
    await writeFile(statePath(), JSON.stringify({ schemaVersion: 1, world: 'example-world', recipe: EIDOVERSE_WORLD_DESIGN_V1 }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1, preservedOverrides: [] });
    expect(await readState()).toMatchObject({
      schemaVersion: 2,
      world: 'example-world',
      selectedDesignVersion: 2,
      lastAppliedDesignVersion: 1,
      pendingDesignVersion: 2,
      reconciliation: { status: 'pending', checkpoint: 'migration-complete' },
    });
  });

  it('preserves customized leaves and unrelated install-local fields', async () => {
    await writeFile(statePath(), JSON.stringify({
      schemaVersion: 1,
      world: 'example-world',
      extraLocalField: { preserve: true },
      recipe: {
        ...EIDOVERSE_WORLD_DESIGN_V1,
        includes: { ...EIDOVERSE_WORLD_DESIGN_V1.includes, jira: false },
        limits: { ...EIDOVERSE_WORLD_DESIGN_V1.limits, apps: 2 },
      },
    }));

    await migration.up({ rootDir });
    expect(await readState()).toMatchObject({
      extraLocalField: { preserve: true },
      userOverrides: { includes: { jira: false }, limits: { apps: 2 } },
      recipe: { version: 2, includes: { jira: false }, limits: { apps: 2 } },
    });
  });

  it('is idempotent and fails soft without rewriting invalid or newer state', async () => {
    await writeFile(statePath(), JSON.stringify({ schemaVersion: 1, recipe: EIDOVERSE_WORLD_DESIGN_V1 }));
    await migration.up({ rootDir });
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });

    await writeFile(statePath(), '{broken');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-json' });
    expect(await readFile(statePath(), 'utf8')).toBe('{broken');

    await writeFile(statePath(), JSON.stringify({ schemaVersion: 99 }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'newer-state-schema' });

    await writeFile(statePath(), JSON.stringify({ schemaVersion: 2, selectedDesignVersion: 99 }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'newer-design-version' });

    await writeFile(statePath(), JSON.stringify({ schemaVersion: 0 }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-state-schema' });
    expect(console.warn).toHaveBeenCalledTimes(4);
  });

  it('does nothing on a fresh install without state', async () => {
    await rm(statePath(), { force: true });
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-state' });
  });
});
