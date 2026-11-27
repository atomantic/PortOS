import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from './469-private-personal-stores.js';

let rootDir;
const dataPath = rel => join(rootDir, 'data', rel);
const mode = async path => (await stat(path)).mode & 0o777;
const payload = 'Synthetic legacy record\n';

async function fixture(path) {
  await mkdir(dirname(path), { recursive: true });
  await chmod(dirname(path), 0o755);
  await writeFile(path, payload);
  await chmod(path, 0o644);
}

beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'private-personal-stores-')); });
afterEach(() => rm(rootDir, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('personal-store permission repair', () => {
  it('protects legacy records and atomic remnants without rewriting bytes', async () => {
    const files = [
      'messages/drafts.json', 'messages/cache/account.json', 'calendar/accounts.json', 'calendar/cache/account.json',
      'health/2026-01-01.json', 'meatspace/blood-tests.json', 'insights/narrative.json',
      'digital-twin/example.md', 'digital-twin/autobiography/stories.json', 'ask-conversations/example.json',
      'imessage-sync-state.json', 'signal-sync-state.json',
      'messages/drafts.json.12.1740000000000.11111111-2222-3333-4444-555555555555.tmp',
    ].map(dataPath);
    for (const file of files) await fixture(file);
    const unrelated = dataPath('other.json');
    await fixture(unrelated);

    await migration.up({ rootDir });
    await migration.up({ rootDir });

    for (const file of files) {
      expect(await mode(file)).toBe(0o600);
      expect(await mode(dirname(file))).toBe(0o700);
      expect(await readFile(file, 'utf8')).toBe(payload);
    }
    expect(await mode(unrelated)).toBe(0o644);
  });

  it('leaves missing stores, symlink targets and stricter owner modes alone', async () => {
    const external = join(rootDir, 'example', 'accounts.json');
    await fixture(external);
    await fixture(dataPath('messages/accounts.json'));
    await chmod(dataPath('messages/accounts.json'), 0o400);
    await symlink(external, dataPath('messages/drafts.json'));
    await symlink(dirname(external), dataPath('calendar'));

    await migration.up({ rootDir });

    expect(await mode(external)).toBe(0o644);
    expect(await mode(dirname(external))).toBe(0o755);
    expect(await mode(dataPath('messages/accounts.json'))).toBe(0o400);
    expect((await lstat(dataPath('messages/drafts.json'))).isSymbolicLink()).toBe(true);
    await expect(lstat(dataPath('health'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
