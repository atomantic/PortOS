/**
 * Suno Hook adapter (#10375): a Hook is Suno's short 9:16 video set to a window
 * of one of the director's songs (suno.com/hooks/create). prepare() uploads the
 * vertical cut, picks the song, sets the audio window to the cut's start and
 * writes the caption; submit() presses Post. Nothing is posted before then.
 *
 * The window is a fixed box over a waveform with no numeric field, so it is set
 * in two tries: keyboard nudges on a slider role when the page exposes one,
 * else a drag calibrated at WAVEFORM_PX_PER_SEC. Either way the page's own m:ss
 * label is read back and the fill fails rather than post the wrong stretch.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, clickVisibleText, loginRequired, step } from './browser.js';

const CREATE_URL = 'https://suno.com/hooks/create';
const label = 'Suno Hook';
// Measured on the 2026-10 picker: one waveform second is about this many CSS px; dragging right moves the window earlier.
const WAVEFORM_PX_PER_SEC = 23.6;
// The page's readout is a rounded m:ss, so a one-second miss is the finest check it can support.
const READBACK_TOLERANCE_SEC = 1;

const fmtClock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const parseClock = (text) => {
  const m = String(text).match(/(\d+):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Which picker row is the song: by id when a row carries it, else by the one
 * row with the song's length, else the only row. Pure; rows are `{ text, html }`.
 */
export function pickSongRow(rows, { songId, durationSec, title }) {
  const byId = rows.findIndex((r) => songId && r.html.toLowerCase().includes(songId.toLowerCase()));
  if (byId >= 0) return byId;
  const named = rows.map((r, i) => [r, i]).filter(([r]) => !title || r.text.toLowerCase().includes(title.toLowerCase()));
  const pool = named.length ? named : rows.map((r, i) => [r, i]);
  if (pool.length === 1) return pool[0][1];
  const clock = Number.isFinite(durationSec) ? fmtClock(Math.round(durationSec)) : null;
  const sameLength = clock ? pool.filter(([r]) => r.text.includes(clock)) : [];
  if (sameLength.length === 1) return sameLength[0][1];
  return -1;
}

async function selectSong(page, payload) {
  await page.locator('text=Select Song').first().click({ timeout: T });
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

/** The window's start as the page reports it, in seconds (null when no readout is found). */
const readWindowStart = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('span,div')].find((e) => e.children.length === 0 && /^\d+:\d{2}$/.test(e.textContent.trim()) && e.offsetParent);
  return el ? el.textContent.trim() : null;
}).then((text) => (text ? parseClock(text) : null));

async function setWindowStart(page, startSec) {
  if (!(startSec > 0)) return 0; // the page opens the window at 0:00
  const slider = page.locator('[role=slider]').first();
  if (await slider.count()) {
    await slider.focus();
    for (let i = 0; i < 400; i += 1) {
      const now = Number(await slider.getAttribute('aria-valuenow'));
      const gap = startSec - now;
      if (Number.isFinite(now) && Math.abs(gap) <= 0.1) return now;
      await page.keyboard.press(gap > 0 ? 'ArrowRight' : 'ArrowLeft');
    }
  }
  const box = await page.locator('[class*=waveform], [data-testid*=waveform], canvas').first().boundingBox();
  if (!box) throw new Error('no waveform to set the window on');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - startSec * WAVEFORM_PX_PER_SEC, y, { steps: 20 }); // dragging right moves the window earlier
  await page.mouse.up();
  await page.waitForTimeout(500);
  const got = await readWindowStart(page);
  if (got == null || Math.abs(got - startSec) > READBACK_TOLERANCE_SEC) {
    throw new Error(`the window reads ${got == null ? 'nothing' : fmtClock(got)}, wanted ${fmtClock(startSec)}`);
  }
  return got;
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
    return { songUrl: payload.songUrl, windowStart, caption: payload.caption, showLyrics: lyrics };
  },
  async submit(page) {
    await step(label, 'post', () => clickVisibleText(page, 'Post'));
    await step(label, 'confirm it posted', () => page.waitForFunction(() => !document.querySelector('textarea[placeholder="Add a caption..."]'), null, { timeout: 60_000 }));
    return { url: null };
  },
};
