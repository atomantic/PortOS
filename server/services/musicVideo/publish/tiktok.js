/**
 * TikTok adapter (#9282), driving TikTok Studio's web upload. prepare()
 * uploads the vertical cut, writes the caption, sets a chosen cover (the
 * default is frame 0, often a title card) and turns on the AI-generated label
 * (a switch with its own confirm dialog). submit() presses Post.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, clickVisibleText, loginRequired, replaceEditorText, step } from './browser.js';

const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload';
const label = 'TikTok';
const TOUR = '.react-joyride__overlay';
// Joyride renders each step's tooltip (stock or custom) inside its floater.
const TOUR_BUTTONS = '.__floater button, .react-joyride__tooltip button';

/**
 * Close TikTok Studio's onboarding tooltips ("Preview your video on your
 * phone"…). Their overlay covers the whole form, so every click times out
 * until it is gone. Joyride mounts a step a beat after the upload, so the
 * first check waits `waitMs` for one to appear. A tour can chain several
 * steps, and once dismissed it does not come back for the account. Only the
 * tooltip's own buttons are pressed; Escape is the fallback.
 */
async function dismissStudioTour(page, { attempts = 5, waitMs = 3000 } = {}) {
  if (waitMs) await page.locator(TOUR).first().waitFor({ state: 'attached', timeout: waitMs }).catch(() => {});
  for (let i = 0; i < attempts; i += 1) {
    if (!(await page.locator(TOUR).count())) return true;
    const press = (text) => clickVisibleText(page, text, { selector: TOUR_BUTTONS }).then(() => true, () => false);
    if (!(await press('Got it')) && !(await press('Skip'))) await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
  }
  return !(await page.locator(TOUR).count());
}

/** Close a tour step that mounted after the last check, before a click it would swallow. */
const clearTour = (page) => dismissStudioTour(page, { waitMs: 0 });

export const tiktokAdapter = {
  label,
  async prepare(page, payload) {
    await step(label, 'open TikTok Studio', () => page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(5000);
    if (/\/login/.test(page.url())) throw loginRequired(label, UPLOAD_URL);
    await step(label, 'upload the video', () => page.locator('input[type=file][accept*=video]').first().setInputFiles(payload.video.path, { timeout: T }));
    await step(label, 'wait for the caption editor', () => page.locator('[contenteditable=true]').first().waitFor({ timeout: T }));
    await step(label, 'close the Studio tour', async () => {
      if (!(await dismissStudioTour(page))) throw new Error('an onboarding tooltip still covers the form');
    });
    if (payload.caption) {
      await step(label, 'write the caption', () => replaceEditorText(page, '[contenteditable=true]', payload.caption));
      await page.keyboard.press('Escape'); // closes the hashtag suggestion popup, nothing else
    }
    let cover = false;
    if (payload.cover) {
      await step(label, 'set the cover frame', async () => {
        await clearTour(page);
        await page.locator('text=Edit cover').first().click({ timeout: T });
        await page.locator('input[type=file][accept*=image]').first().setInputFiles(payload.cover.path, { timeout: T });
        await page.waitForTimeout(2500);
        await clickVisibleText(page, 'Save');
        await page.waitForTimeout(1500);
      });
      cover = true;
    }
    await step(label, 'open the post settings', async () => {
      await clearTour(page);
      await page.locator('text=Show more').first().click({ timeout: T });
    });
    const aiLabel = await step(label, 'turn on the AI-generated label', async () => {
      const was = await page.evaluate(() => {
        const text = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === 'AI-generated content');
        let node = text;
        for (let i = 0; i < 8 && node; i += 1) {
          node = node.parentElement;
          const sw = node?.querySelector('[role=switch]');
          if (sw) {
            const on = sw.getAttribute('aria-checked') === 'true' || /checked|on/i.test(sw.className);
            if (!on) sw.click();
            return on;
          }
        }
        return null;
      });
      if (was === null) throw new Error('no AI-generated content switch');
      if (was === false) {
        await page.waitForTimeout(800);
        await clickVisibleText(page, 'Turn on').catch(() => {}); // the confirm dialog, when TikTok shows one
      }
      return true;
    });
    const checks = await page.evaluate(() => (document.body.innerText.match(/Content check lite[^\n]*\n?[^\n]{0,120}/) || [])[0] || null);
    return { caption: payload.caption, cover, aiLabel, checks };
  },
  async submit(page) {
    await step(label, 'post', () => clickVisibleText(page, 'Post'));
    const url = await step(label, 'find the new post', async () => {
      await page.waitForURL(/tiktokstudio\/content/, { timeout: 120_000 });
      await page.waitForTimeout(3000);
      return page.evaluate(() => [...document.querySelectorAll('a[href*="/video/"]')].map((a) => a.href)[0] || null);
    });
    return { url };
  },
};
