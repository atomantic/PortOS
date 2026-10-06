/**
 * Suno adapter (#9282): publish one of the director's songs with the release
 * cover and a caption linking the video, pinned to their profile. prepare()
 * opens the song's own Publish dialog and fills it; submit() presses Publish.
 * Lyrics and styles are left exactly as the director made them.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, clickVisibleText, ensureToggleBeside, loginRequired, step } from './browser.js';
import { markSunoSongMenu } from '../../../lib/sunoPage.js';

const label = 'Suno';

const songIdOf = (url) => String(url).match(/\/song\/([0-9a-f-]{36})/i)?.[1] || null;

export const sunoAdapter = {
  label,
  async prepare(page, payload) {
    await step(label, 'open the song', () => page.goto(payload.songUrl, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(5000);
    if (!(await page.locator("button[aria-label='More options']").count())) throw loginRequired(label, payload.songUrl);
    await step(label, 'open the Publish dialog', async () => {
      // A cover's page lists the song it covers first, with its own menu, so the
      // page song's menu is picked by which song card it sits in.
      // A share link or redirect can land on the song under another URL; the page's own wins.
      const songId = songIdOf(page.url()) || songIdOf(payload.songUrl);
      if (!songId) throw new Error(`no song id in ${payload.songUrl}`);
      if (!(await page.evaluate(markSunoSongMenu, songId))) throw new Error("no menu could be tied to this page's own song (its title or own-song link)");
      await page.locator('[data-portos-song-menu]').click({ timeout: T });
      await page.locator('[role=menuitem]').filter({ hasText: /^Publish$/ }).first().click({ timeout: T });
      await page.locator('[role=dialog]').first().waitFor({ timeout: T });
    });
    let cover = false;
    if (payload.cover) {
      await step(label, 'upload the cover', async () => {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: T }),
          page.locator('[role=dialog] button').filter({ hasText: 'Upload' }).first().click(),
        ]);
        await chooser.setFiles(payload.cover.path);
        await page.waitForTimeout(3000);
      });
      cover = true;
    }
    if (payload.caption) {
      await step(label, 'write the caption', async () => {
        await page.locator('[role=dialog]').getByText('Edit caption, lyrics and styles').first().click({ timeout: T });
        await page.locator("[role=dialog] textarea[placeholder='Add a caption']").fill(payload.caption);
        await page.waitForTimeout(500);
        await clickVisibleText(page, 'Save'); // the details dialog's Save, stacked above the Publish dialog's
        await page.waitForTimeout(2500);
      });
    }
    const pinned = payload.pin ? await step(label, 'pin it to the profile', () => ensureToggleBeside(page, 'Pin song to profile')) : false;
    return { songUrl: payload.songUrl, cover, caption: payload.caption, pinned: pinned === true };
  },
  async submit(page, payload) {
    await step(label, 'publish', () => clickVisibleText(page, 'Publish'));
    await step(label, 'confirm it published', () => page.waitForFunction(() => /Published/.test(document.body.innerText), null, { timeout: 60_000 }));
    return { url: payload.songUrl };
  },
};
