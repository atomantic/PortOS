/**
 * Mood board imports against a backup cut (#9982). Downloads run outside
 * admission; the board row that first names the downloaded files commits under
 * the lease, so a cut that arrives mid-commit drains it. URL-keyed downloads
 * rewrite their file in place, so that write waits out a held cut too. An item
 * write that names no new bytes never waits on a cut.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/databaseMaintenanceJournal.js', async (importOriginal) => ({
  ...(await importOriginal()),
  assertDatabaseAdmission: () => {},
}));
const store = {
  getBoard: vi.fn(),
  appendImportedItems: vi.fn(),
  applyLocalizedItemImages: vi.fn(),
  addBoardItem: vi.fn(),
};
vi.mock('./db.js', () => store);
const net = { fetchPublicText: vi.fn(), fetchPublicBinary: vi.fn() };
vi.mock('../../lib/safeUrlFetch.js', () => net);
vi.mock('../sharing/recordEvents.js', () => ({
  emitRecordUpdated: vi.fn(),
  emitRecordDeleted: vi.fn(),
  autoSubscribeRecordToAllPeers: vi.fn(async () => {}),
}));
const writeFileGuarded = vi.fn(async () => {});
vi.mock('../browserService.js', () => ({ getHealthStatus: vi.fn(), navigateToUrlPinned: vi.fn() }));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  PATHS: { images: '/mock/images', videos: '/mock/videos' },
  ensureDir: vi.fn(async () => {}),
  writeFileGuarded: (...args) => writeFileGuarded(...args),
}));

const { importXPost } = await import('./xPost.js');
const { localizeBoardMedia } = await import('./localize.js');
const { addBoardItem } = await import('./index.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const BOARD_ID = 'mb-example';
const POST_URL = 'https://x.com/example/status/42';
const REMOTE_IMAGE = 'https://cdn.example.com/pin.jpg';

/** Pauses the row commit under test until released. */
let hold;
const held = (result) => async (...args) => {
  await hold?.();
  return typeof result === 'function' ? result(...args) : result;
};

/**
 * Pause a workflow at its row commit, request a cut, and prove the cut waits
 * for that commit to settle before it is granted.
 */
async function expectCutDrainsCommit(start) {
  let reachedCommit;
  const reached = new Promise((resolve) => { reachedCommit = resolve; });
  let finishCommit;
  const commitDone = new Promise((resolve) => { finishCommit = resolve; });
  hold = async () => { reachedCommit(); await commitDone; };

  const pending = start();
  await reached;
  let cutReady = false;
  const cut = acquireBackupSnapshotCut().then((release) => { cutReady = true; return release; });
  try {
    await settle();
    expect(cutReady, 'cut granted while a row naming new bytes was committing').toBe(false);
  } finally {
    finishCommit();
    (await cut)();
  }
  return pending;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  hold = null;
  net.fetchPublicBinary.mockResolvedValue({ buffer: JPEG_BYTES, contentType: 'image/jpeg' });
  net.fetchPublicText.mockResolvedValue(JSON.stringify({ photos: [{ url: 'https://pbs.example.com/a.jpg' }] }));
  store.getBoard.mockResolvedValue({ id: BOARD_ID, items: [{ id: 'mbi-remote', type: 'image', imageUrl: REMOTE_IMAGE }] });
  store.appendImportedItems.mockImplementation(held((_id, imported) => ({ board: { id: BOARD_ID }, added: imported.length })));
  store.applyLocalizedItemImages.mockImplementation(held((_id, replacements) => ({ board: { id: BOARD_ID }, changed: replacements.length })));
  store.addBoardItem.mockImplementation(held((_id, item) => ({ id: 'mbi-new', ...item })));
});

describe('mood board imports and a backup cut', () => {
  it('holds an X post download and its board append behind a held cut', async () => {
    const release = await acquireBackupSnapshotCut();
    let pending;
    try {
      pending = importXPost(BOARD_ID, { url: POST_URL });
      await settle();
      expect(net.fetchPublicBinary).toHaveBeenCalled();
      expect(writeFileGuarded).not.toHaveBeenCalled();
      expect(store.appendImportedItems).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await expect(pending).resolves.toMatchObject({ added: 1 });
    expect(writeFileGuarded).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an X post import', () => importXPost(BOARD_ID, { url: POST_URL })],
    ['re-hosting a board', () => localizeBoardMedia(BOARD_ID)],
    ['adding a remote image item', () => addBoardItem(BOARD_ID, { type: 'image', imageUrl: REMOTE_IMAGE, caption: 'Example' })],
  ])('drains a cut behind the row commit for %s', async (_name, start) => {
    await expectCutDrainsCommit(start);
  });

  it('commits an item that names no downloaded bytes while a cut is held', async () => {
    const release = await acquireBackupSnapshotCut();
    try {
      await expect(addBoardItem(BOARD_ID, { type: 'text', text: 'Example note' })).resolves.toMatchObject({ id: 'mbi-new' });
    } finally {
      release();
    }
    expect(net.fetchPublicBinary).not.toHaveBeenCalled();
  });
});
