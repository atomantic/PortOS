/**
 * Suno adapter (#9282): publish one of the director's songs with the release
 * cover and a caption linking the video, pinned to their profile. prepare()
 * opens the song's own Publish dialog and fills it; submit() presses Publish.
 * Lyrics and styles are left exactly as the director made them.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, clickVisibleText, ensureToggleBeside, loginRequired, step } from './browser.js';

const label = 'Suno';

export const sunoAdapter = {
  label,
  async prepare(page, payload) {
    await step(label, 'open the song', () => page.goto(payload.songUrl, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(5000);
    if (!(await page.locator("button[aria-label='More options']").count())) throw loginRequired(label, payload.songUrl);
    await step(label, 'open the Publish dialog', async () => {
      await page.locator("button[aria-label='More options']").first().click({ timeout: T });
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
