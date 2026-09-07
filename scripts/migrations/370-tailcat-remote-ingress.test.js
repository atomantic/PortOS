import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration from './370-tailcat-remote-ingress.js';
import { PORTS } from '../../server/lib/ports.js';
let rootDir;
beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'tailcat-migration-')); await mkdir(join(rootDir, 'data')); });
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

it('moves managed serve to remote ingress while preserving consent, identity and legacy forwards', async () => {
  const serve = { enabled: true, localPort: 5555, status: 'active', keyName: 'example', tcAddress: 'tcEXAMPLE' };
  const path = join(rootDir, 'data', 'tailcat-serve.json');
  const forwardPath = join(rootDir, 'data', 'tailcat-forwards.json');
  const forwards = JSON.stringify({ version: 1, forwards: [{ remotePort: 5555 }] });
  await writeFile(path, JSON.stringify({ version: 1, serve }));
  await writeFile(forwardPath, forwards);
  await migration.up({ rootDir });
  await migration.up({ rootDir });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, serve: { ...serve, localPort: PORTS.TAILCAT_INGRESS, status: 'stopped' } });
  expect(await readFile(forwardPath, 'utf8')).toBe(forwards);
});

it('does not enable a fresh install or replace corrupt config', async () => {
  await migration.up({ rootDir });
  const path = join(rootDir, 'data', 'tailcat-serve.json');
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path, '{invalid');
  await expect(migration.up({ rootDir })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('{invalid');
});
