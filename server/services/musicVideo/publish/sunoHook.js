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
 * the fill fails rather than post the wrong stretch (#10860).
 */
import { pickSongRow } from '../../../lib/sunoSongPicker.js';
import { PUBLISH_STEP_TIMEOUT_MS as T, clickVisibleText, loginRequired, step } from './browser.js';

const CREATE_URL = 'https://suno.com/hooks/create';
const label = 'Suno Hook';
// Measured on the 2026-10 picker (200 px moved 2:38 to 2:29); only the first drag's estimate, each drag recalibrates it.
const WAVEFORM_PX_PER_SEC = 22.2;
// The page's readout is a rounded m:ss, so a one-second miss is the finest check it can support.
const READBACK_TOLERANCE_SEC = 1;
// One drag stays on the waveform, so a window far from the target takes several.
const MAX_DRAGS = 20;
const WAVEFORM = '[class*=waveform], [data-testid*=waveform], canvas';

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const parseClock = (text) => {
  const m = String(text).match(/(\d+):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

async function selectSong(page, payload) {
  // A restored draft shows Replace Song and keeps a hidden Select Song; only a visible one can be clicked.
  await page.locator('button:visible').filter({ hasText: /Replace Song|Select Song/ }).first().click({ timeout: T });
  await page.locator('[role=dialog]').first().waitFor({ timeout: T });
  const search = page.locator('textarea[placeholder*="Search by song name"]').first();
  await search.fill(payload.title, { timeout: T });
  await page.waitForTimeout(2500);
  const rows = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] button')]
    .filter((b) => (b.innerText || '').trim() === 'Use')
    .map((b) => {
      let row = b;
      for (let i = 0; i < 4 && row.parentElement && row.parentElement.querySelectorAll('button').length < 3; i += 1) row = row.parentElement;
      return { text: row.innerText || '', html: row.innerHTML };
    }));
  const index = pickSongRow(rows, payload);
  if (index < 0) throw new Error(`${rows.length} rows match "${payload.title}" and none could be told apart by id or length`);
  await page.locator('[role=dialog] button').filter({ hasText: /^Use$/ }).nth(index).click({ timeout: T });
  await page.waitForTimeout(1500);
}

/**
 * The window's start among the page's visible m:ss labels (`{ text, cls, parentText }`), in
 * seconds: the rounded-full font-mono pill above the box, never the player clock ("0:00 / 0:26").
 * Without a pill, a lone label that isn't the clock; null when it can't be told.
 */
function pickWindowStart(labels) {
  const isClock = (l) => /\d+:\d{2}\s*\/\s*\d+:\d{2}/.test(l.parentText || '');
  const candidates = labels.filter((l) => !isClock(l));
  const pills = candidates.filter((l) => /(^|\s)rounded-full(\s|$)/.test(l.cls || '') && /(^|\s)font-mono(\s|$)/.test(l.cls || ''));
  const pick = pills.length ? pills : candidates;
  return pick.length === 1 ? parseClock(pick[0].text) : null;
}

/** The window's start as the page reports it, in seconds (null when no readout is found). */
const readWindowStart = (page) => page.evaluate(() => [...document.querySelectorAll('span,div')]
  .filter((e) => e.children.length === 0 && /^\d+:\d{2}$/.test(e.textContent.trim()) && e.offsetParent)
  .map((e) => ({ text: e.textContent.trim(), cls: String(e.className || ''), parentText: (e.parentElement?.textContent || '').trim() })))
  .then(pickWindowStart);

/**
 * Move the window to `startSec` from wherever Suno opened it: read the pill, drag the waveform
 * under the fixed box (right moves the window earlier), re-read, repeat until within a second.
 */
async function setWindowStart(page, startSec) {
  const target = Math.max(0, Number(startSec) || 0);
  let at = await readWindowStart(page);
  if (at == null) throw new Error('no window label to read');
  if (Math.abs(at - target) <= READBACK_TOLERANCE_SEC) return at;
  const box = await page.locator(WAVEFORM).first().boundingBox();
  if (!box) throw new Error('no waveform to set the window on');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const reach = Math.max(20, box.width / 2 - 16); // a drag from the middle stays on the waveform
  let pxPerSec = WAVEFORM_PX_PER_SEC;
  let direction = 1; // +1: dragging right moves the window earlier
  let still = 0;
  for (let drag = 0; drag < MAX_DRAGS && Math.abs(at - target) > READBACK_TOLERANCE_SEC; drag += 1) {
    const dx = clamp((at - target) * pxPerSec * direction, -reach, reach);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 20 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const now = await readWindowStart(page);
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

export const sunoHookAdapter = {
  label,
  async prepare(page, payload) {
    await step(label, 'open Create Hook', () => page.goto(CREATE_URL, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(4000);
    if (/\/(login|sign-?in)/.test(page.url()) || !(await page.locator('input[type=file][accept*=mp4]').count())) throw loginRequired(label, CREATE_URL);
    await step(label, 'upload the vertical cut', async () => {
      await page.locator('input[type=file][accept*=mp4]').first().setInputFiles(payload.video.path, { timeout: T });
      await page.waitForTimeout(4000);
    });
    await step(label, 'select the song', () => selectSong(page, payload));
    const windowStart = await step(label, 'set the audio window', () => setWindowStart(page, payload.startSec));
    await step(label, 'open the Post Hook dialog', async () => {
      await clickVisibleText(page, 'Next');
      await page.locator('textarea[placeholder="Add a caption..."]').first().waitFor({ timeout: T });
    });
    if (payload.caption) await step(label, 'write the caption', () => page.locator('textarea[placeholder="Add a caption..."]').first().fill(payload.caption));
    // Show Lyrics is on by default; a cut that carries its own lyric text would show them twice.
    const lyrics = payload.showLyrics ? true : await step(label, 'turn off Show Lyrics', async () => {
      const state = await page.evaluate(() => {
        const text = [...document.querySelectorAll('span,div,label')].find((e) => e.children.length === 0 && e.textContent.trim() === 'Show Lyrics');
        let node = text;
        for (let i = 0; i < 8 && node; i += 1) {
          node = node.parentElement;
          const sw = node?.querySelector('[role=switch],input[type=checkbox]');
          if (sw) {
            const on = sw.getAttribute('aria-checked') === 'true' || sw.checked === true;
            if (on) sw.click();
            return true;
          }
        }
        return null;
      });
      if (state === null) throw new Error('no Show Lyrics switch');
      return false;
    });
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
