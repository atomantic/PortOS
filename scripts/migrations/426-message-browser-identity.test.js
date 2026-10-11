import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import migration from './426-message-browser-identity.js';

let rootDir;
let directory;
const filename = '11111111-1111-1111-1111-111111111111.json';
beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'portos-message-identity-'));
  directory = join(rootDir, 'data', 'messages', 'cache');
});
afterEach(() => rm(rootDir, { recursive: true, force: true }));

it('pins only unambiguous legacy events while retaining records, evaluations, and existing aliases', async () => {
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  const messages = [
    { id: 'local', externalId: 'old-summary', providerRowId: 'row-a', evaluation: { score: 7 } },
    { id: 'ambiguous-a', externalId: 'collision', providerRowId: 'row-b' },
    { id: 'ambiguous-b', externalId: 'collision', providerRowId: 'row-c' },
    { id: 'current', externalId: 'current', browserMessageKind: 'row', activityIdentity: 'retained' }
  ];
  await writeFile(path, JSON.stringify({ syncCursor: 'cursor', messages }));
  expect(await migration.up({ rootDir })).toEqual({ updated: 1 });
  const cache = JSON.parse(await readFile(path, 'utf8'));
  expect(cache).toEqual({ syncCursor: 'cursor', messages: [
    { ...messages[0], activityIdentity: 'old-summary' }, ...messages.slice(1)
  ] });
  expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
});

it('creates no missing cache and leaves malformed caches untouched', async () => {
  expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  for (const raw of ['{broken', '{"messages":[null]}']) {
    await writeFile(path, raw);
    expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
    expect(await readFile(path, 'utf8')).toBe(raw);
  }
});
