import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import migration from './444-tailcat-device-policy.js';
let rootDir;
beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'tailcat-policy-')); await mkdir(join(rootDir, 'data')); });
afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

it('preserves legacy identity and consent without claiming device protection; preserves already enrolled v2 state on rerun', async () => {
  const path = join(rootDir, 'data', 'tailcat-serve.json');
  const serve = { enabled: true, keyName: 'example', tcAddress: 'tcEXAMPLE', localPort: 5565 };
  await writeFile(path, JSON.stringify({ version: 1, serve }));
  await migration.up({ rootDir });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 2, serve: { ...serve, deviceEnforcement: false, devices: [] } });
  const enrolled = JSON.stringify({ version: 2, serve: { ...serve, deviceEnforcement: true, devices: [] } });
  await writeFile(path, enrolled);
  await migration.up({ rootDir });
  expect(await readFile(path, 'utf8')).toBe(enrolled);
});

it('does not seed a fresh listener or replace unreadable policy', async () => {
  const path = join(rootDir, 'data', 'tailcat-serve.json');
  await migration.up({ rootDir });
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path, '{invalid');
  await expect(migration.up({ rootDir })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('{invalid');
});
