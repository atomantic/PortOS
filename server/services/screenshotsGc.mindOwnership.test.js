import { afterAll, beforeEach, expect, it as vitestIt, vi } from 'vitest';
import { mkdir, readFile, readdir, rm, utimes, writeFile } from 'fs/promises';
import { basename, join } from 'path';
import { createTempDataRoot, makePathsProxy, ownTestBodies } from '../lib/mockPathsDataRoot.js';

const root = createTempDataRoot('screenshots-mind-ownership-');
const dir = join(root, 'screenshots');
const stateFile = join(root, 'state.json');
const { it, drain } = ownTestBodies(vitestIt);
const DAY = 24 * 60 * 60 * 1000;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';

vi.mock('../lib/fileUtils.js', async (importOriginal) => ({
  ...makePathsProxy(await importOriginal(), { dataRoot: root }),
  resolveScreenshot: (name) => typeof name === 'string' && basename(name) === name ? join(dir, name) : null,
}));
vi.mock('./cosState.js', () => ({
  loadState: async () => JSON.parse(await readFile(stateFile, 'utf8')),
  saveState: async (state) => writeFile(stateFile, JSON.stringify(state)),
  withStateLock: (fn) => fn(),
}));
vi.mock('./updateChecker.js', () => ({ isUpdateInProgress: () => false }));
vi.mock('./cosTaskStore.js', () => ({ getAllTasks: async () => ({ user: { tasks: [] }, cos: { tasks: [] } }) }));

const { createPersistentMindAttachment, cleanupPersistentMindAttachments } = await import('./persistentMindAttachments.js');
const { _sweepScreenshots } = await import('./screenshotsGc.js');
const { purgeCategory } = await import('./dataManager.js');

beforeEach(async () => {
  await drain();
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(stateFile, '{}');
});
afterAll(async () => {
  await drain();
  await rm(root, { recursive: true, force: true });
});

it('survives overlapping generic cleanup with unreadable Mind state and leaves expired uploads to the owner', async () => {
  const claimed = await createPersistentMindAttachment({ filename: 'claimed.png', data: PNG });
  const expired = await createPersistentMindAttachment({ filename: 'expired.png', data: PNG });
  expect(claimed.success).toBe(true);
  expect(expired.success).toBe(true);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.persistentMind.pendingAttachments[0].claimedBy = 'completed-message';
  state.persistentMind.pendingAttachments[0].expiresAt = null;
  const now = Date.now();
  state.persistentMind.pendingAttachments[1].expiresAt = new Date(now - DAY).toISOString();
  await writeFile(join(dir, '.mind-pending-interrupted'), '');
  await writeFile(join(dir, 'mind-interrupted-.stage-image.png'), Buffer.from(PNG, 'base64'));
  await writeFile(join(dir, 'ordinary.png'), 'ordinary');
  for (const name of await readdir(dir)) {
    const old = new Date(now - 90 * DAY);
    await utimes(join(dir, name), old, old);
  }

  // A restore or temporarily unreadable state file cannot surrender ownership.
  await writeFile(stateFile, '{truncated');
  await expect(cleanupPersistentMindAttachments({ now })).rejects.toThrow();
  await Promise.all([_sweepScreenshots({ now }), purgeCategory('screenshots')]);
  expect((await readdir(dir)).sort()).toEqual([
    '.mind-pending-interrupted', claimed.attachment.filename, expired.attachment.filename,
    'mind-interrupted-.stage-image.png',
  ].sort());

  await writeFile(stateFile, JSON.stringify(state));
  await expect(cleanupPersistentMindAttachments({ now })).resolves.toMatchObject({ success: true, removed: 2 });
  expect(await readdir(dir)).toEqual([claimed.attachment.filename]);

  // Claimed files remain durable after the bounded attachment index is pruned.
  await writeFile(stateFile, '{}');
  await Promise.all([_sweepScreenshots({ now }), purgeCategory('screenshots'), cleanupPersistentMindAttachments({ now })]);
  expect(await readdir(dir)).toEqual([claimed.attachment.filename]);
  await expect(cleanupPersistentMindAttachments({ now })).resolves.toMatchObject({ success: true, removed: 0 });
});
