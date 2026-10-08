/**
 * One-shot import for Pinterest boards that are visible only to the signed-in
 * PortOS browser profile. The page read is pinned through the browser service's
 * CDP SSRF guard; only Pinterest pin permalinks and i.pinimg.com image URLs
 * leave the page, and the images are re-hosted into the normal mood-board asset
 * store. No cookies, credentials, or recurring sync state are persisted.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir } from '../../lib/fileUtils.js';
import { isBlockedIngestHost } from '../../lib/catalogValidation.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
import { normalizePinterestFeedUrl } from '../../lib/pinterestFeed.js';
import { getHealthStatus, navigateToUrlPinned } from '../browserService.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';
import { MAX_ITEMS_PER_BOARD } from './logic.js';
import * as store from './db.js';
import { downloadPinImage } from './pinterest.js';
import { resolvePinterestBoardUrl } from './pinterestUrl.js';

const PINTEREST_PAGE_SETTLE_MS = 2500;
// The pinned DOM scan can take up to roughly 58 seconds: a 32 × 250 ms
// board-title wait, one 300 ms reset, then 140 × 350 ms scroll/load steps.
const PINTEREST_PAGE_READ_TIMEOUT_MS = 70000;
const DOWNLOAD_CONCURRENCY = 3;

// Runs only on the user-triggered import path. The page is opened in a fresh
// tab in the PortOS browser's existing profile, and the bounded scroll loop
// collects only the board's pin grid (never recommendation carousels).
const PINTEREST_BOARD_SNAPSHOT_EXPRESSION = `(() => new Promise(async (resolve) => {
  const maxPins = __MAX_PINS__;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  const boardTitle = () => (document.querySelector('#board-name')?.innerText || '').trim();
  const isLoginPage = () => /^\\/(?:login|session\\/login)(?:\\/|$)/i.test(location.pathname)
    || Boolean(document.querySelector('input[type="password"]'))
    || (!boardTitle() && /log in to pinterest|sign in to pinterest/i.test(document.body?.innerText || ''));
  const expectedPinCount = () => {
    const text = (document.body?.innerText || '').slice(0, 5000);
    const match = text.match(/\\b([\\d,]+)\\s+Pins?\\b/i);
    return match ? Number(match[1].replace(/,/g, '')) : null;
  };
  const pins = new Map();
  const safeImageUrl = (raw) => {
    try {
      const url = new URL(raw, location.href);
      return url.protocol === 'https:' && url.hostname === 'i.pinimg.com' ? url.href : '';
    } catch {
      return '';
    }
  };
  const collect = () => {
    const grid = document.querySelector('[data-test-id="masonry-container"]');
    if (!grid) return;
    for (const anchor of grid.querySelectorAll('a[href*="/pin/"]')) {
      let pin;
      try { pin = new URL(anchor.href); } catch { continue; }
      if (!['www.pinterest.com', 'pinterest.com'].includes(pin.hostname)) continue;
      const pinId = pin.pathname.match(/^\\/pin\\/(\\d+)\\/?$/)?.[1];
      if (!pinId) continue;
      const source = 'https://www.pinterest.com/pin/' + pinId + '/';
      if (anchor.closest('[data-test-id="carousel-pin"]')) continue;
      const card = anchor.closest('[data-test-id="pin"]') || anchor;
      const img = card.querySelector('img');
      const srcset = (img?.getAttribute('srcset') || img?.getAttribute('data-srcset') || '')
        .split(',').map((entry) => entry.trim().split(/\\s+/)[0]).filter(Boolean);
      const imageCandidates = [...new Set([
        ...srcset,
        img?.currentSrc,
        img?.getAttribute('data-src'),
        img?.src,
      ].map(safeImageUrl).filter(Boolean))];
      const original = imageCandidates.find((url) => url.includes('/originals/')) || '';
      const imageUrl = imageCandidates.find((url) => url.includes('/736x/'))
        || imageCandidates.find((url) => url.includes('/474x/'))
        || imageCandidates[0]
        || '';
      const rawCaption = (img?.alt
        || card.querySelector('h1,h2,h3,[data-test-id*="title"]')?.textContent
        || '').replace(/^This may contain:\\s*/i, '').trim();
      const prior = pins.get(source) || {};
      pins.set(source, {
        source,
        imageUrl: imageUrl || prior.imageUrl || '',
        imageUrlOriginal: original || prior.imageUrlOriginal || '',
        caption: rawCaption || prior.caption || null,
      });
    }
  };

  for (let i = 0; i < 32 && !boardTitle() && !isLoginPage(); i++) await sleep(250);
  const loginRequired = isLoginPage();
  const expectedCount = expectedPinCount();
  if (loginRequired || !boardTitle()) {
    resolve({ loginRequired, boardTitle: boardTitle(), expectedCount, pins: [] });
    return;
  }

  window.scrollTo(0, 0);
  await sleep(300);
  const targetCount = Math.min(expectedCount ?? maxPins, maxPins);
  const hasEnoughPinsAndImages = () => pins.size >= targetCount
    && [...pins.values()].filter((pin) => pin.imageUrl).length >= targetCount;
  let stableAtBottom = 0;
  let lastProgress = '';
  let lastY = -1;
  for (let i = 0; i < 140; i++) {
    collect();
    const progress = () => [pins.size, [...pins.values()].filter((pin) => pin.imageUrl).length].join(':');
    if (hasEnoughPinsAndImages()) break;

    const beforeY = window.scrollY;
    const beforeProgress = progress();
    window.scrollBy(0, Math.max(500, Math.round(window.innerHeight * 0.8)));
    await sleep(350);
    collect();

    const pageHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    const atBottom = window.scrollY + window.innerHeight >= pageHeight - 8;
    const currentProgress = progress();
    const noProgress = window.scrollY <= beforeY + 1 && currentProgress === beforeProgress;
    stableAtBottom = atBottom && (noProgress || (currentProgress === lastProgress && window.scrollY === lastY))
      ? stableAtBottom + 1
      : 0;
    lastProgress = currentProgress;
    lastY = window.scrollY;
    if (stableAtBottom >= 8) break;
  }
  collect();
  resolve({ boardTitle: boardTitle(), loginRequired: false, expectedCount, pins: [...pins.values()].slice(0, maxPins) });
}))()` .replace('__MAX_PINS__', String(MAX_ITEMS_PER_BOARD));

function sameBoardPath(left, right) {
  const leftPath = new URL(left).pathname.replace(/\/+$/, '');
  const rightPath = new URL(right).pathname.replace(/\/+$/, '');
  return leftPath === rightPath;
}

/**
 * Import the visible pins from a private Pinterest board using the signed-in
 * PortOS CDP browser. Images download outside the mood-board row lock, then the
 * store performs a locked, source-deduplicated append.
 *
 * @returns {Promise<{ board: object, added: number, found: number, skipped: number }>}
 */
export async function importPrivatePinterestBoard(boardId, { url }) {
  const { boardUrl } = await resolvePinterestBoardUrl(url);
  const board = await store.getBoard(boardId);
  if (!board) throw new ServerError('Mood board not found', { status: 404, code: 'NOT_FOUND' });

  const browser = await getHealthStatus();
  if (!browser.connected) {
    throw new ServerError('The PortOS browser is not running', { status: 503, code: 'BROWSER_UNAVAILABLE' });
  }

  const page = await navigateToUrlPinned(boardUrl, {
    verifyRemoteIp: (ip) => !isBlockedIngestHost(ip),
    settleMs: PINTEREST_PAGE_SETTLE_MS,
    evaluateExpression: PINTEREST_BOARD_SNAPSHOT_EXPRESSION,
    evaluateTimeoutMs: PINTEREST_PAGE_READ_TIMEOUT_MS,
  }).catch(() => {
    throw new ServerError('Could not read the Pinterest board in the PortOS browser', {
      status: 502,
      code: 'PINTEREST_BROWSER_READ_FAILED',
    });
  });

  const snapshot = page.evalResult;
  if (!snapshot || typeof snapshot !== 'object') {
    throw new ServerError('Pinterest did not return a readable board page', { status: 502, code: 'PINTEREST_BOARD_UNREADABLE' });
  }
  if (snapshot.loginRequired) {
    throw new ServerError('Sign in to Pinterest in the PortOS browser, then retry the import', {
      status: 401,
      code: 'PINTEREST_LOGIN_REQUIRED',
    });
  }
  if (!snapshot.boardTitle) {
    throw new ServerError('Pinterest did not show this board in the PortOS browser', {
      status: 403,
      code: 'PINTEREST_BOARD_UNAVAILABLE',
    });
  }

  const landedBoardUrl = normalizePinterestFeedUrl(page.url).boardUrl;
  if (!sameBoardPath(landedBoardUrl, boardUrl)) {
    throw new ServerError('Pinterest opened a different board than the one requested', {
      status: 502,
      code: 'PINTEREST_BOARD_REDIRECTED',
    });
  }

  const pins = Array.isArray(snapshot.pins) ? snapshot.pins : [];
  const expectedCount = Number.isInteger(snapshot.expectedCount) && snapshot.expectedCount >= 0
    ? snapshot.expectedCount
    : null;
  const found = expectedCount ?? pins.length;
  if (expectedCount !== null && expectedCount <= MAX_ITEMS_PER_BOARD && pins.length < expectedCount) {
    throw new ServerError('Pinterest did not load every pin; retry the import when the board is available', {
      status: 502,
      code: 'PINTEREST_BOARD_INCOMPLETE',
    });
  }
  if (found === 0) return { board, added: 0, found: 0, skipped: 0 };
  if (!pins.length) {
    throw new ServerError('No Pinterest pins could be read from this board', {
      status: 502,
      code: 'PINTEREST_NO_PINS_READ',
    });
  }

  const items = Array.isArray(board.items) ? board.items : [];
  const seen = new Set(items.map((item) => item?.source).filter(Boolean));
  const capacity = Math.max(0, MAX_ITEMS_PER_BOARD - items.length);
  const candidates = pins.filter((pin) => pin?.source && pin?.imageUrl && !seen.has(pin.source)).slice(0, capacity);
  if (!candidates.length) return { board, added: 0, found, skipped: found };

  await ensureDir(PATHS.images);
  const imported = [];
  for (let i = 0; i < candidates.length; i += DOWNLOAD_CONCURRENCY) {
    const batch = candidates.slice(i, i + DOWNLOAD_CONCURRENCY);
    const results = await Promise.all(batch.map(async (pin) => {
      const imageUrl = await downloadPinImage({ ...pin, pinUrl: pin.source }).catch(() => null);
      return imageUrl
        ? { imageUrl, caption: pin.caption || null, source: pin.source }
        : null;
    }));
    for (const result of results) if (result) imported.push(result);
  }
  if (!imported.length) {
    throw new ServerError('Pinterest pin images could not be downloaded', {
      status: 502,
      code: 'PINTEREST_IMAGE_DOWNLOAD_FAILED',
    });
  }

  // The append first names the downloaded pins, so it commits under the backup lease (#9982).
  const { board: nextBoard, added } = await withBackupAssetPublication(() => store.appendImportedItems(boardId, imported));
  if (added > 0) emitRecordUpdated('moodBoard', boardId);
  return { board: nextBoard, added, found, skipped: Math.max(0, found - added) };
}
