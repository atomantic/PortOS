import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './325-eidoverse-video-companion.js';

let rootDir;
const appsPath = () => join(rootDir, 'data', 'apps.json');
const videoPath = () => join(rootDir, 'data', 'repos', 'anima-research', 'eidoverse-video');
const readApps = async () => JSON.parse(await readFile(appsPath(), 'utf8'));

afterEach(async () => {
  vi.restoreAllMocks();
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

describe('migration 325 — Eidoverse Video companion registration', () => {
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-eidoverse-companion-'));
    await mkdir(join(rootDir, 'data'), { recursive: true });
  });

  it('adds the Video checkout to an older Eidoverse managed-app record', async () => {
    await writeFile(appsPath(), JSON.stringify({
      apps: {
        'app-eidoverse': {
          name: 'Eidoverse Worlds',
          repoPath: '/example/worlds',
          pm2ProcessNames: ['eidoverse-worlds'],
        },
        'app-other': {
          name: 'Example App',
          companionRepoPaths: ['/example/companion'],
          pm2ProcessNames: ['example-app'],
        },
      },
      preserved: true,
    }));

    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 1 });
    const result = await readApps();
    expect(result.apps['app-eidoverse'].companionRepoPaths).toEqual([videoPath()]);
    expect(result.apps['app-other'].companionRepoPaths).toEqual(['/example/companion']);
    expect(result.preserved).toBe(true);
  });

  it('preserves existing companions, deduplicates, and is idempotent', async () => {
    await writeFile(appsPath(), JSON.stringify({
      apps: {
        'app-eidoverse': {
          pm2ProcessNames: ['eidoverse-worlds'],
          companionRepoPaths: ['/example/helper', '/example/helper'],
        },
      },
    }));

    await migration.up({ rootDir });
    expect((await readApps()).apps['app-eidoverse'].companionRepoPaths)
      .toEqual(['/example/helper', videoPath()]);
    await expect(migration.up({ rootDir })).resolves.toEqual({
      updated: 0,
      reason: 'already-applied',
    });
  });

  it('does nothing when no Eidoverse app is registered', async () => {
    await writeFile(appsPath(), JSON.stringify({ apps: {} }));
    await expect(migration.up({ rootDir })).resolves.toEqual({
      updated: 0,
      reason: 'already-applied',
    });
  });

  it('fails soft without overwriting a missing or invalid registry', async () => {
    await rm(appsPath(), { force: true });
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'no-apps' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await writeFile(appsPath(), '{broken');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-apps' });
    expect(await readFile(appsPath(), 'utf8')).toBe('{broken');
    expect(warn).toHaveBeenCalledOnce();
  });
});
