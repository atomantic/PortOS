import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './415-message-draft-send-attempts.js';

let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });

it('preserves legacy draft content and states, existing attempt history, and invalid snapshots', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'message-attempt-migration-'));
  expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
  await mkdir(join(rootDir, 'data', 'messages'), { recursive: true });
  const file = join(rootDir, 'data', 'messages', 'drafts.json');
  const legacy = { id: 'example-draft', status: 'sending', body: 'Invented message', futureField: true };
  const current = { id: 'other-draft', status: 'sent', sendAttemptId: 'example-attempt', sendAttempts: [{ id: 'example-attempt', outcome: 'sent' }] };
  await writeFile(file, JSON.stringify([legacy, current]));
  expect(await migration.up({ rootDir })).toEqual({ updated: 1 });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([{ ...legacy, sendAttemptId: null, sendAttempts: [] }, current]);
  expect(await migration.up({ rootDir })).toEqual({ updated: 0 });
  for (const invalid of ['{invalid', '{}', '[null]']) {
    await writeFile(file, invalid);
    await expect(migration.up({ rootDir })).rejects.toThrow('Invalid message drafts snapshot');
    expect(await readFile(file, 'utf8')).toBe(invalid);
  }
});
