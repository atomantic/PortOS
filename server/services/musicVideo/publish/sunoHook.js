/**
 * Suno Hook adapter (#10375): a Hook is Suno's short 9:16 video set to a window
 * of one of the director's songs (suno.com/hooks/create). prepare() uploads the
 * vertical cut, picks the song, sets the audio window to the cut's start and
 * writes the caption; submit() presses Post. Nothing is posted before then.
 *
 * The window is a fixed box over a waveform with no numeric field or slider,
 * and it opens wherever Suno suggests (not 0:00). Its start is the m:ss pill
 * above the box; the player clock ("0:00 / 0:26") beside it is not. So the
 * window is set by read, drag, re-read: each drag is sized from the gap at the
 * current px-per-second estimate, recalibrated from what the drag moved, and
 * the fill fails rather than post the wrong stretch (#10860). The pill shows
 * whole seconds (and start plus elapsed while the preview plays), so where the
 * page shows a hover time under the waveform the window is set from that.
 */
import { SUNO_LEGACY_CLASSES } from '../sunoControls.js';
import { pickSongRow } from '../../../lib/sunoSongPicker.js';
import { PUBLISH_STEP_TIMEOUT_MS as T, clickVisibleText, loginRequired, step } from './browser.js';

const CREATE_URL = 'https://suno.com/hooks/create';
const label = 'Suno Hook';
// Measured on the 2026-10 picker (200 px moved 2:38 to 2:29); only the first drag's estimate, each drag recalibrates it.
const WAVEFORM_PX_PER_SEC = 22.2;
// The page's readout is a rounded m:ss, so a one-second miss is the finest check it can support.
const READBACK_TOLERANCE_SEC = 1;
// Hovering the waveform shows the song time under the pointer to the millisecond (2026-11
// editor), which lets the window be set and checked far finer than the pill's whole seconds.
const EXACT_TOLERANCE_SEC = 0.1;
const EXACT_STEP_SEC = 0.03;
const HOVER_SPAN_PX = 150;
const HOVER_TRIES = 6;
const HOVER_SETTLE_MS = 200;
// One drag stays on the waveform, so a window far from the target takes several.
const MAX_DRAGS = 20;
const WAVEFORM = '[data-portos-hook-waveform]';
// The readout belongs immediately above the window, not elsewhere on the page. Suno's pill
// straddles the window's top edge by a few pixels, so "above" is judged by the pill's middle.
const WINDOW_READOUT_GAP_PX = 48;
const SONG_RESULTS_POLL_MS = 250;
// One search gets this many polls (10 s) to answer and settle.
const SONG_RESULTS_POLLS = 40;
const SONG_RESULTS_STABLE_POLLS = 3;
// Suno limits searches (HTTP 429) right after other work on the account. A failed search is
// left this many polls (3 s) for the page's own retry, then the title is typed again.
const SEARCH_FAILED_GRACE_POLLS = 12;
const SEARCH_TRIES = 3;
const SEARCH_RETRY_WAIT_MS = { min: 2_000, max: 15_000 };

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const parseClock = (text) => {
  const m = String(text).match(/(\d+):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function searchResultContainsSong(value, songId) {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && typeof value.id === 'string' && value.id.toLowerCase() === songId.toLowerCase()) return true;
  return Object.values(value).some(entry => searchResultContainsSong(entry, songId));
}

async function selectSong(page, payload) {
  // A restored draft shows Replace Song and keeps a hidden Select Song; only a visible one can be clicked.
  await page.locator('button:visible').filter({ hasText: /Replace Song|Select Song/ }).first().click({ timeout: T });
  await page.locator('[role=dialog]').first().waitFor({ timeout: T });
  const search = page.locator('textarea[placeholder*="Search by song name"]').first();
  const readRows = () => page.evaluate(() => [...document.querySelectorAll('[role=dialog] button')]
    .filter((b) => (b.innerText || '').trim() === 'Use')
    .map((b) => {
      let row = b.parentElement || b;
      for (let i = 0; i < 4 && row.parentElement && row.parentElement.querySelectorAll('button').length < 3; i += 1) row = row.parentElement;
      return { text: row.innerText || '', html: row.innerHTML };
    }));
  const beforeSearch = JSON.stringify((await readRows()).map(({ text, html }) => [text, html]));
  const activeRequests = new Set();
  const searchRequests = new Set();
  // A failed search stops blocking once the same request succeeds: the page retries on its own,
  // and typing the title again repeats it. A failure nothing repeats (another call that carries
  // the title) keeps blocking unless the song is identified outright.
  const failedSearches = new Map();
  let successfulSearches = 0;
  let lastFailure = null;
  let sawLoading = false;
  let responseContainsSong = false;
  const searchKey = (request) => `${request.method?.() || 'GET'} ${request.url()} ${request.postData() || ''}`;
  // Named in a failure so the log says which call was refused; the query (the song title) is left out.
  const endpoint = (request) => {
    if (!URL.canParse(request.url(), CREATE_URL)) return 'Suno';
    const url = new URL(request.url(), CREATE_URL);
    return `${url.host}${url.pathname}`;
  };
  const failed = (request, failure) => {
    lastFailure = failure;
    failedSearches.set(searchKey(request), failure);
  };
  const normalizedTitle = String(payload.title || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const encodedTitle = encodeURIComponent(String(payload.title || '').trim()).toLowerCase();
  const onRequest = (request) => {
    if (!['fetch', 'xhr'].includes(request.resourceType())) return;
    const requestText = `${request.url()} ${request.postData() || ''}`.replace(/\+/g, ' ').toLowerCase();
    if (requestText.includes(normalizedTitle) || requestText.includes(encodedTitle)) searchRequests.add(request);
    activeRequests.add(request);
  };
  const onRequestDone = (request) => activeRequests.delete(request);
  const onResponse = (response) => {
    const request = response.request();
    if (!searchRequests.has(request)) return;
    if (response.ok()) {
      successfulSearches += 1;
      failedSearches.delete(searchKey(request));
      if (payload.songId) void response.json().then(result => {
        if (searchResultContainsSong(result, payload.songId)) responseContainsSong = true;
      }).catch(() => {});
      return;
    }
    const retryAfterSec = Number(response.headers?.()?.['retry-after']);
    failed(request, {
      status: response.status(),
      reason: `Suno search failed (HTTP ${response.status()} from ${endpoint(request)})`,
      waitMs: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 0,
    });
  };
  const onRequestFailed = (request) => {
    activeRequests.delete(request);
    if (searchRequests.has(request)) failed(request, { status: null, reason: `Suno search request failed (${endpoint(request)})`, waitMs: 0 });
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onRequestDone);
  page.on('requestfailed', onRequestFailed);
  let previous = beforeSearch;
  let stablePolls = 0;
  let failedPolls = 0;
  let polls = 0;
  let tries = 1;
  let rows = [];
  try {
    await search.fill(payload.title, { timeout: T });
    for (;;) {
      const searchValue = await search.inputValue();
      rows = await readRows();
      const snapshot = JSON.stringify(rows.map(({ text, html }) => [text, html]));
      const loading = await page.locator('[role=dialog] [aria-busy="true"], [role=dialog] [role=progressbar]').count();
      if (loading && searchRequests.size) sawLoading = true;
      const idle = activeRequests.size === 0 && loading === 0;
      // Identical results need no DOM change: the response and the selected row
      // must both identify this exact song. Title/length alone cannot prove that.
      const confirmedSongRow = responseContainsSong && rows.some(row => row.html.toLowerCase().includes(payload.songId.toLowerCase()));
      const searchSucceeded = confirmedSongRow || (successfulSearches > 0 && failedSearches.size === 0);
      const resultsVerified = snapshot !== beforeSearch || sawLoading || confirmedSongRow;
      stablePolls = searchValue === payload.title && searchSucceeded && resultsVerified && idle && snapshot === previous ? stablePolls + 1 : 0;
      if (stablePolls >= SONG_RESULTS_STABLE_POLLS) break;
      previous = snapshot;
      polls += 1;
      failedPolls = failedSearches.size && idle ? failedPolls + 1 : 0;
      if (failedPolls >= SEARCH_FAILED_GRACE_POLLS) {
        if (tries >= SEARCH_TRIES) break;
        // Stale rows are never picked after a failed search: wait as Suno asks, then search again.
        await page.waitForTimeout(clamp(lastFailure.waitMs || SEARCH_RETRY_WAIT_MS.min * tries, SEARCH_RETRY_WAIT_MS.min, SEARCH_RETRY_WAIT_MS.max));
        tries += 1;
        polls = 0;
        failedPolls = 0;
        await search.fill('', { timeout: T });
        await search.fill(payload.title, { timeout: T });
        continue;
      }
      if (polls >= SONG_RESULTS_POLLS) break;
      await page.waitForTimeout(SONG_RESULTS_POLL_MS);
    }
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', onRequestDone);
    page.off('requestfailed', onRequestFailed);
  }
  if (stablePolls < SONG_RESULTS_STABLE_POLLS) {
    if (failedSearches.size) {
      const limited = lastFailure.status === 429 ? '. Suno is limiting requests: wait a minute, then Fill again' : '';
      throw new Error(`${lastFailure.reason} on each of ${tries} ${tries === 1 ? 'try' : 'tries'}${limited}`);
    }
    throw new Error(`${rows.length} rows match "${payload.title}" and Suno search did not complete and settle within ${SONG_RESULTS_POLLS * SONG_RESULTS_POLL_MS} ms`);
  }
  const index = pickSongRow(rows, payload);
  if (index < 0) throw new Error(`${rows.length} rows match "${payload.title}" and none could be told apart by id or length`);
  await page.locator('[role=dialog] button').filter({ hasText: /^Use$/ }).nth(index).click({ timeout: T });
  await search.locator('xpath=ancestor::*[@role="dialog"][1]').waitFor({ state: 'hidden', timeout: T });
  await page.waitForFunction(markHookWaveform, { legacyWaveformSelector: SUNO_LEGACY_CLASSES.waveformSelector, maxReadoutGap: WINDOW_READOUT_GAP_PX }, { timeout: T });
}

/**
 * Prefer an identified waveform, then a named window/audio slider. A canvas is
 * a last resort after the centralized legacy class selector, bounded to a wide
 * visible strip with a time label just above it. Multiple strips are ambiguous.
 * Runs in the page without module scope.
 */
function markHookWaveform({ legacyWaveformSelector, maxReadoutGap }) {
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const clocks = [...document.querySelectorAll('body *')].filter((el) => el.children.length === 0
    && /^\d+:\d{2}$/.test(el.textContent.trim()) && visible(el)
    && !/^\s*\d+:\d{2}\s*\/\s*\d+:\d{2}\s*$/.test(el.parentElement?.textContent || ''));
  for (const old of document.querySelectorAll('[data-portos-hook-waveform]')) old.removeAttribute('data-portos-hook-waveform');
  const identified = [...document.querySelectorAll('[data-testid*="waveform" i]')].filter(visible);
  const sliders = [...document.querySelectorAll('[role="slider"]')].filter((el) => visible(el)
    && /waveform|audio window|song window|clip window/i.test(el.getAttribute('aria-label') || document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || ''));
  const legacy = [...document.querySelectorAll(legacyWaveformSelector)].filter(visible);
  const canvases = [...document.querySelectorAll('canvas')].filter((el) => {
    if (!visible(el)) return false;
    const box = el.getBoundingClientRect();
    return box.width >= 160 && box.height >= 24 && clocks.some((clock) => {
      const label = clock.getBoundingClientRect();
      return (label.top + label.bottom) / 2 <= box.top && box.top - label.bottom <= maxReadoutGap && label.right >= box.left && label.left <= box.right;
    });
  });
  const candidates = identified.length ? identified : sliders.length ? sliders : legacy.length ? legacy : canvases;
  // A nested marker describes the same waveform; separate strips are ambiguous.
  const outer = candidates.filter((el) => !candidates.some((other) => other !== el && other.contains(el)));
  if (outer.length !== 1) return false;
  outer[0].setAttribute('data-portos-hook-waveform', '');
  return true;
}

/** The closest visible m:ss readout above this waveform, excluding player clocks (null when ambiguous). */
function pickWindowPill(labels, box) {
  const candidates = labels.filter((entry) => /^\d+:\d{2}$/.test(entry.text)
    && !entry.playerClock
    && (entry.top + entry.bottom) / 2 <= box.y && box.y - entry.bottom <= WINDOW_READOUT_GAP_PX && entry.right >= box.x && entry.left <= box.x + box.width)
    .sort((a, b) => b.bottom - a.bottom);
  if (!candidates.length || candidates[1]?.bottom === candidates[0].bottom) return null;
  return candidates[0];
}

/** The window's pill as the page shows it: its whole seconds and where its centre is (null when ambiguous). */
async function readWindowPill(page) {
  const box = await page.locator(WAVEFORM).boundingBox();
  if (!box) return null;
  const labels = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((el) => el.children.length === 0 && /^\d+:\d{2}$/.test(el.textContent.trim())
      && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
    .map((el) => {
      let parent = el.parentElement;
      let playerClock = false;
      // A clock may split its two times over nested spans. Stop before reaching
      // a container that also holds the waveform/window readout.
      while (parent && !parent.querySelector('[data-portos-hook-waveform]')) {
        if (/^\s*\d+:\d{2}\s*\/\s*\d+:\d{2}\s*$/.test(parent.textContent)) { playerClock = true; break; }
        parent = parent.parentElement;
      }
      const rect = el.getBoundingClientRect();
      return { text: el.textContent.trim(), playerClock,
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
  const pill = pickWindowPill(labels, box);
  return pill ? { seconds: parseClock(pill.text), cx: (pill.left + pill.right) / 2 } : null;
}

/** The window's start as the pill reports it, in whole seconds (null when ambiguous). */
const readWindowStart = async (page) => (await readWindowPill(page))?.seconds ?? null;

/** The song time Suno shows under the pointer at (x, y) on the waveform, in seconds (null when it shows none). */
async function hoverSongTime(page, x, y) {
  for (let attempt = 0; attempt < HOVER_TRIES; attempt += 1) {
    // The label appears a beat after the pointer moves, and only for a move it sees.
    await page.mouse.move(x - 4 - attempt, y - 2);
    await page.mouse.move(x, y, { steps: 4 });
    await page.waitForTimeout(HOVER_SETTLE_MS);
    const text = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .find((el) => el.children.length === 0 && /^\d+:\d{2}\.\d{3}$/.test(el.textContent.trim())
        && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')?.textContent.trim() ?? null);
    const match = /^(\d+):(\d{2})\.(\d{3})$/.exec(text || '');
    if (match) return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 1000;
  }
  return null;
}

/**
 * The window's start to the millisecond and the waveform's scale, from two hover times either
 * side of the pill. The window box is centred on its pill and is as long as the cut, so it starts
 * half a cut before the time under the pill's centre. Null when the page offers no hover time
 * (an older editor) or no cut length: the pill's whole seconds are then all there is.
 */
async function measureWindow(page, { cx, y, left, right }) {
  const cutSec = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => v.duration).find((d) => d > 0) ?? null);
  const span = Math.min(HOVER_SPAN_PX, cx - left - 8, right - cx - 8);
  if (!cutSec || span < 40) return null;
  const before = await hoverSongTime(page, cx - span, y);
  if (before == null) return null;
  const after = await hoverSongTime(page, cx + span, y);
  if (after == null || after <= before) return null;
  return { start: (before + after) / 2 - cutSec / 2, pxPerSec: (2 * span) / (after - before) };
}

const fmtExact = (sec) => `${Math.floor(sec / 60)}:${(sec % 60).toFixed(2).padStart(5, '0')}`;

/**
 * Move the window to `startSec` from wherever Suno opened it by dragging the waveform under the
 * fixed box (right moves the window earlier). Where the page shows a hover time the window is set
 * and checked to a tenth of a second, since a second's error shows against the picture; otherwise
 * by the pill: read, drag, re-read until within a second.
 */
async function setWindowStart(page, startSec) {
  const target = Math.max(0, Number(startSec) || 0);
  const pill = await readWindowPill(page);
  if (!pill) throw new Error('no window label to read');
  let at = pill.seconds;
  const box = await page.locator(WAVEFORM).first().boundingBox();
  if (!box) throw new Error('no waveform to set the window on');
  const viewport = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // The strip may be thousands of pixels wide and translated offscreen. Its
  // bounding-box midpoint is then outside the browser, where dragging does nothing.
  const left = Math.max(0, box.x), right = Math.min(viewport.width, box.x + box.width);
  const top = Math.max(0, box.y), bottom = Math.min(viewport.height, box.y + box.height);
  if (right - left <= 32 || bottom <= top) throw new Error('no visible waveform area to drag');
  const x = (left + right) / 2;
  const y = (top + bottom) / 2;
  const reach = (right - left) / 2 - 16;
  const drag = async (dx) => {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 20 });
    await page.mouse.up();
  };

  const place = { cx: pill.cx, y, left, right };
  let exact = await measureWindow(page, place);
  if (exact) {
    let still = 0;
    for (let n = 0; n < MAX_DRAGS && Math.abs(exact.start - target) > EXACT_STEP_SEC; n += 1) {
      const dx = clamp((exact.start - target) * exact.pxPerSec, -reach, reach);
      if (Math.abs(dx) < 1) break; // under a pixel is as close as a drag gets
      await drag(dx);
      const next = await measureWindow(page, place);
      if (!next) throw new Error(`the hover time went missing (the window started at ${fmtExact(exact.start)}, wanted ${fmtExact(target)})`);
      still = Math.abs(next.start - exact.start) < EXACT_STEP_SEC ? still + 1 : 0;
      exact = next;
      if (still >= 2) break; // the window no longer moves (the song's edge)
    }
    if (Math.abs(exact.start - target) > EXACT_TOLERANCE_SEC) {
      throw new Error(`the window starts at ${fmtExact(exact.start)}, wanted ${fmtExact(target)}`);
    }
    // The pill shows the start's whole second while the preview is stopped; a hover time that
    // disagrees with it was not read off this window.
    const shown = await readWindowStart(page);
    if (shown != null && Math.abs(shown - Math.floor(exact.start)) > READBACK_TOLERANCE_SEC) {
      throw new Error(`the window label reads ${fmtClock(shown)} but the hover time puts it at ${fmtExact(exact.start)}`);
    }
    return Math.round(exact.start * 100) / 100;
  }

  if (Math.abs(at - target) <= READBACK_TOLERANCE_SEC) return at;
  let pxPerSec = WAVEFORM_PX_PER_SEC;
  let direction = 1; // +1: dragging right moves the window earlier
  let still = 0;
  for (let n = 0; n < MAX_DRAGS && Math.abs(at - target) > READBACK_TOLERANCE_SEC; n += 1) {
    const dx = clamp((at - target) * pxPerSec * direction, -reach, reach);
    await drag(dx);
    // Poll the readout after a drag; an unchanged value at the edge is handled below.
    const deadline = Date.now() + 2000;
    let now = await readWindowStart(page);
    while (now === at && Date.now() < deadline) {
      await page.waitForTimeout(100); // bounded readout polling, not a readiness delay
      now = await readWindowStart(page);
    }
    if (now == null) throw new Error(`the window label went missing (it read ${fmtClock(at)}, wanted ${fmtClock(target)})`);
    const moved = at - now; // seconds earlier
    // A drag that moved the window the other way flips the direction; the rate comes from what it moved.
    if (moved !== 0 && Math.sign(moved) !== Math.sign(dx) * direction) direction = -direction;
    if (Math.abs(moved) >= 2) pxPerSec = clamp(Math.abs(dx / moved), 2, 400);
    still = moved === 0 ? still + 1 : 0;
    at = now;
    if (still >= 2) break; // the window no longer moves (the song's edge, or the drag missed the waveform)
  }
  if (Math.abs(at - target) > READBACK_TOLERANCE_SEC) {
    throw new Error(`the window reads ${fmtClock(at)}, wanted ${fmtClock(target)}`);
  }
  return at;
}

async function setShowLyrics(page, wanted) {
  const named = page.getByRole('switch', { name: /^Show Lyrics$/i })
    .or(page.getByRole('checkbox', { name: /^Show Lyrics$/i }));
  let control = named;
  const count = await named.count();
  if (count > 1) throw new Error('multiple Show Lyrics controls');
  if (!count) {
    // Older UI labels an adjacent control rather than giving it an accessible
    // name. Locator traversal also works inside open shadow roots.
    let row = page.getByText('Show Lyrics', { exact: true });
    if (await row.count() !== 1) throw new Error('no unambiguous Show Lyrics label');
    for (let depth = 0; depth < 8; depth += 1) {
      row = row.locator('..');
      control = row.locator('[role=switch],input[type=checkbox]');
      const matches = await control.count();
      if (matches > 1) throw new Error('multiple controls beside Show Lyrics');
      if (matches === 1) break;
    }
    if (await control.count() !== 1) throw new Error('no Show Lyrics switch');
  }
  const read = () => control.evaluate(el => {
    const aria = el.getAttribute('aria-checked');
    return aria === 'true' ? true : aria === 'false' ? false : typeof el.checked === 'boolean' ? el.checked : null;
  });
  const before = await read();
  if (before === null) throw new Error('cannot read Show Lyrics state');
  if (before !== wanted) await control.click({ timeout: T });
  await page.waitForFunction(({ element, wanted }) => {
    const aria = element.getAttribute('aria-checked');
    const state = aria === 'true' ? true : aria === 'false' ? false : typeof element.checked === 'boolean' ? element.checked : null;
    return state === wanted;
  }, { element: await control.elementHandle(), wanted }, { timeout: T });
  return wanted;
}

export const sunoHookAdapter = {
  label,
  async prepare(page, payload) {
    await step(label, 'open Create Hook', () => page.goto(CREATE_URL, { waitUntil: 'domcontentloaded', timeout: T }));
    const readiness = await step(label, 'wait for the video upload control or sign-in page', () => page.waitForFunction(() => {
      if (/sign-?in|login|accounts\./i.test(location.href)) return 'signed-out';
      return document.querySelector('input[type=file][accept*=mp4]') ? 'ready' : false;
    }, null, { timeout: T }).then(result => result.jsonValue()));
    if (readiness === 'signed-out') throw loginRequired(label, CREATE_URL);
    await step(label, 'upload the vertical cut', async () => {
      const previous = await page.locator('video').evaluateAll(videos => videos.map(video => video.currentSrc || video.src));
      await page.locator('input[type=file][accept*=mp4]').first().setInputFiles(payload.video.path, { timeout: T });
      await page.waitForFunction(before => [...document.querySelectorAll('video')]
        .some(video => video.readyState >= 2 && video.videoWidth > 0 && (video.currentSrc || video.src) && !before.includes(video.currentSrc || video.src)), previous, { timeout: T });
    });
    await step(label, 'select the song', () => selectSong(page, payload));
    const windowStart = await step(label, 'set the audio window', () => setWindowStart(page, payload.startSec));
    await step(label, 'open the Post Hook dialog', async () => {
      // Next stays disabled while Suno processes the upload; a click on it then does nothing.
      await page.waitForFunction(() => [...document.querySelectorAll('button,[role=button]')]
        .some((b) => b.offsetParent && (b.innerText || '').trim() === 'Next' && !b.disabled && b.getAttribute?.('aria-disabled') !== 'true'), null, { timeout: T });
      await clickVisibleText(page, 'Next');
      await page.locator('textarea[placeholder="Add a caption..."]').first().waitFor({ timeout: T });
    });
    if (payload.caption) await step(label, 'write the caption', () => page.locator('textarea[placeholder="Add a caption..."]').first().fill(payload.caption));
    const lyrics = await step(label, 'set Show Lyrics', () => setShowLyrics(page, payload.showLyrics === true));
    return {
      songUrl: payload.songUrl, windowStart, caption: payload.caption, showLyrics: lyrics,
      ...(payload.cutLayout === 'fit' ? { cut: 'Fitted: the 16:9 frame over a blurred fill, so it reads as a square' } : {}),
    };
  },
  async submit(page) {
    await step(label, 'post', () => clickVisibleText(page, 'Post'));
    await step(label, 'confirm it posted', () => page.waitForFunction(() => !document.querySelector('textarea[placeholder="Add a caption..."]'), null, { timeout: 60_000 }));
    return { url: null };
  },
};
