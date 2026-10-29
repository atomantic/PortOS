import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './449-peer-media-delete-capability.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('peer media.delete capability migration', () => {
  it('migration sets true only where absent and is re-runnable', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'peer-media-delete-'));
    roots.push(rootDir);
    await mkdir(join(rootDir, 'data'), { recursive: true });
    const path = join(rootDir, 'data', 'instances.json');
    await writeFile(path, JSON.stringify({ self: { instanceId: 's' }, peers: [{ id: 'a' }, { id: 'b', mediaDeleteAllowed: false }, { id: 'c', mediaDeleteAllowed: true }] }));
    expect(await migration.up({ rootDir })).toEqual({ updated: 1 });
    const after = JSON.parse(await readFile(path, 'utf8'));
    expect(after.self).toEqual({ instanceId: 's' });
    expect(after.peers.map(p => p.mediaDeleteAllowed)).toEqual([true, false, true]);
    expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(after);
  });

  it('leaves a missing store untouched', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'peer-media-delete-'));
    roots.push(rootDir);
    expect(await migration.up({ rootDir })).toMatchObject({ updated: 0 });
  });
});
