import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  getBoard: vi.fn(),
  appendImportedItems: vi.fn(),
}));
vi.mock('./db.js', () => store);

const browser = vi.hoisted(() => ({
  getHealthStatus: vi.fn(),
  navigateToUrlPinned: vi.fn(),
}));
vi.mock('../browserService.js', () => browser);

const fileUtils = vi.hoisted(() => ({
  ensureDir: vi.fn(),
  PATHS: { images: '/tmp/portos-mood-board-tests/images' },
}));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    PATHS: { ...original.PATHS, ...fileUtils.PATHS },
    ensureDir: (...args) => fileUtils.ensureDir(...args),
  };
});

const resolvePublicUrl = vi.hoisted(() => vi.fn());
vi.mock('../../lib/safeUrlFetch.js', () => ({ resolvePublicUrl }));

const downloadPinImage = vi.hoisted(() => vi.fn());
vi.mock('./pinterest.js', () => ({ downloadPinImage }));

const emitRecordUpdated = vi.hoisted(() => vi.fn());
vi.mock('../sharing/recordEvents.js', () => ({ emitRecordUpdated }));

import { importPrivatePinterestBoard } from './privatePinterest.js';

const BOARD_URL = 'https://www.pinterest.com/example-user/example-board/';
const firstPin = {
  source: 'https://www.pinterest.com/pin/9999999999999999999/',
  imageUrl: 'https://i.pinimg.com/736x/example/first.jpg',
  imageUrlOriginal: 'https://i.pinimg.com/originals/example/first.jpg',
  caption: 'Example pin one',
};
const secondPin = {
  source: 'https://www.pinterest.com/pin/9999999999999999998/',
  imageUrl: 'https://i.pinimg.com/736x/example/second.jpg',
  imageUrlOriginal: '',
  caption: 'Example pin two',
};

function mockReadableBoard(snapshot) {
  browser.getHealthStatus.mockResolvedValue({ connected: true });
  browser.navigateToUrlPinned.mockResolvedValue({ url: BOARD_URL, evalResult: snapshot });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.getBoard.mockResolvedValue({ id: 'mb-example', items: [] });
  store.appendImportedItems.mockImplementation(async (_id, items) => ({
    board: { id: 'mb-example', items },
    added: items.length,
  }));
  downloadPinImage.mockResolvedValue('/data/images/pinterest-example.jpg');
});

describe('importPrivatePinterestBoard', () => {
  it('opens the resolved canonical board for a share link and imports its pins', async () => {
    resolvePublicUrl.mockResolvedValue(BOARD_URL + '?invite_code=example');
    mockReadableBoard({ boardTitle: 'Example Board', loginRequired: false, expectedCount: 1, pins: [firstPin] });
    expect(await importPrivatePinterestBoard('mb-example', { url: 'https://pin.it/example' }))
      .toMatchObject({ added: 1, found: 1 });
    expect(browser.navigateToUrlPinned).toHaveBeenCalledWith(BOARD_URL, expect.anything());
    expect(store.appendImportedItems.mock.calls[0][1][0]).toMatchObject({ source: firstPin.source });
  });

  it.each(['https://www.pinterest.com/pin/123/', 'https://example.com/example/board/'])
    ('rejects a non-board share destination before opening the browser: %s', async (destination) => {
      resolvePublicUrl.mockResolvedValue(destination);
      await expect(importPrivatePinterestBoard('mb-example', { url: 'https://pin.it/example' }))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_PINTEREST_URL' });
      expect(browser.navigateToUrlPinned).not.toHaveBeenCalled();
      expect(store.appendImportedItems).not.toHaveBeenCalled();
    });

  it('reads the requested board through pinned CDP and appends re-hosted, source-deduped images', async () => {
    store.getBoard.mockResolvedValue({
      id: 'mb-example',
      items: [{ source: firstPin.source }],
    });
    mockReadableBoard({ boardTitle: 'Example Board', loginRequired: false, expectedCount: 2, pins: [firstPin, secondPin] });

    const result = await importPrivatePinterestBoard('mb-example', { url: BOARD_URL });

    expect(browser.navigateToUrlPinned).toHaveBeenCalledWith(BOARD_URL, expect.objectContaining({
      settleMs: expect.any(Number),
      evaluateTimeoutMs: 70000,
      evaluateExpression: expect.any(String),
      verifyRemoteIp: expect.any(Function),
    }));
    const verifyRemoteIp = browser.navigateToUrlPinned.mock.calls[0][1].verifyRemoteIp;
    expect(verifyRemoteIp('93.184.216.34')).toBe(true);
    expect(verifyRemoteIp('127.0.0.1')).toBe(false);
    expect(fileUtils.ensureDir).toHaveBeenCalledWith(fileUtils.PATHS.images);
    expect(downloadPinImage).toHaveBeenCalledTimes(1);
    expect(downloadPinImage).toHaveBeenCalledWith(expect.objectContaining({ ...secondPin, pinUrl: secondPin.source }));
    expect(store.appendImportedItems).toHaveBeenCalledWith('mb-example', [{
      imageUrl: '/data/images/pinterest-example.jpg',
      caption: secondPin.caption,
      source: secondPin.source,
    }]);
    expect(result).toMatchObject({ added: 1, found: 2, skipped: 1 });
    expect(emitRecordUpdated).toHaveBeenCalledWith('moodBoard', 'mb-example');
  });

  it('reports the signed-in-browser login requirement without writing board items', async () => {
    mockReadableBoard({ boardTitle: '', loginRequired: true, expectedCount: null, pins: [] });

    await expect(importPrivatePinterestBoard('mb-example', { url: BOARD_URL }))
      .rejects.toMatchObject({ status: 401, code: 'PINTEREST_LOGIN_REQUIRED' });

    expect(downloadPinImage).not.toHaveBeenCalled();
    expect(store.appendImportedItems).not.toHaveBeenCalled();
  });

  it('fails closed when Pinterest reports more pins than the snapshot loaded', async () => {
    mockReadableBoard({ boardTitle: 'Example Board', loginRequired: false, expectedCount: 2, pins: [firstPin] });

    await expect(importPrivatePinterestBoard('mb-example', { url: BOARD_URL }))
      .rejects.toMatchObject({ status: 502, code: 'PINTEREST_BOARD_INCOMPLETE' });

    expect(downloadPinImage).not.toHaveBeenCalled();
    expect(store.appendImportedItems).not.toHaveBeenCalled();
  });

  it('does not navigate when the PortOS browser is unavailable', async () => {
    browser.getHealthStatus.mockResolvedValue({ connected: false });

    await expect(importPrivatePinterestBoard('mb-example', { url: BOARD_URL }))
      .rejects.toMatchObject({ status: 503, code: 'BROWSER_UNAVAILABLE' });

    expect(browser.navigateToUrlPinned).not.toHaveBeenCalled();
  });
});
