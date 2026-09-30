/**
 * Instagram Reels adapter (#9282), driving instagram.com's create flow (a
 * video post is shared as a reel). Hard-won rules: keep the Original crop (the
 * default square crop cuts a 9:16 cut in half), type the caption into the
 * focused box (it ignores synthetic paste) with no "@" (the mention picker
 * swallows the next word — payloads strip it), turn on "Add AI label" under
 * Advanced settings, and NEVER press Escape: it opens "Discard post?".
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, clickVisibleText, ensureToggleBeside, loginRequired, step } from './browser.js';

const HOME_URL = 'https://www.instagram.com/';
const label = 'Instagram';

export const instagramAdapter = {
  label,
  async prepare(page, payload) {
    await step(label, 'open Instagram', () => page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(5000);
    if (/accounts\/login/.test(page.url()) || await page.locator('input[name=password]').count()) throw loginRequired(label, HOME_URL);
    await step(label, 'start a new post', async () => {
      await page.evaluate(() => {
        const icon = [...document.querySelectorAll('svg[aria-label="New post"]')].find((s) => s.getBoundingClientRect().width > 0);
        (icon?.closest('a,[role=link],[role=button]') || icon?.parentElement)?.click();
      });
      await page.waitForTimeout(1500);
      await page.evaluate(() => [...document.querySelectorAll('a,[role=link],[role=button]')].find((e) => e.offsetParent && e.innerText.trim() === 'Post')?.click());
    });
    await step(label, 'upload the video', () => page.locator('input[type=file][accept*=video]').first().setInputFiles(payload.video.path, { timeout: T }));
    await page.waitForTimeout(6000);
    await clickVisibleText(page, 'OK').catch(() => {}); // "Video posts are now shared as reels"
    await step(label, 'keep the original 9:16 crop', async () => {
      await page.evaluate(() => [...document.querySelectorAll('svg[aria-label="Select crop"]')][0]?.closest('button,[role=button],div')?.click());
      await page.waitForTimeout(1000);
      await page.evaluate(() => {
        const opts = [...document.querySelectorAll('span,div')].filter((e) => e.offsetParent && e.children.length <= 1 && e.innerText.trim() === 'Original');
        opts[opts.length - 1]?.click();
      });
    });
    for (const where of ['go to Edit', 'go to the caption']) {
      await step(label, where, async () => {
        await clickVisibleText(page, 'Next', { selector: '[role=dialog] [role=button],[role=dialog] button' });
        await page.waitForTimeout(2500);
      });
    }
    if (payload.caption) {
      await step(label, 'write the caption', async () => {
        await page.evaluate(() => {
          const box = document.querySelector('[aria-label="Add a caption..."]');
          box.focus();
          const sel = window.getSelection();
          sel.selectAllChildren(box);
          sel.collapseToEnd();
        });
        await page.keyboard.type(payload.caption, { delay: 5 });
      });
    }
    const aiLabel = await step(label, 'turn on the AI label', async () => {
      await page.evaluate(() => [...document.querySelectorAll('[role=dialog] [role=button],[role=dialog] div')].find((e) => e.offsetParent && e.innerText.trim() === 'Advanced settings')?.click());
      await page.waitForTimeout(1200);
      return ensureToggleBeside(page, 'Add AI label');
    });
    return { caption: payload.caption, aiLabel: aiLabel === true };
  },
  async submit(page) {
    await step(label, 'share', () => clickVisibleText(page, 'Share'));
    await step(label, 'wait for the reel to be shared', () => page.waitForFunction(() => /Your reel has been shared|Reel shared/i.test(document.body.innerText), null, { timeout: 180_000 }));
    return { url: null };
  },
};
