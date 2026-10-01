/**
 * X thread adapter (#9282). prepare() composes the whole thread in one
 * composer: each post's text goes in by paste (the Draft.js editor keeps its
 * line breaks that way), media attaches through the focused post's file input,
 * and the thread waits until every upload reports Ready. X builds a post's
 * link card from its LAST link; the payload already orders links for that.
 * submit() presses "Post all" and finds the new thread on the profile.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, loginRequired, pasteText, step } from './browser.js';

const COMPOSE_URL = 'https://x.com/compose/post';
const label = 'X';

export const xAdapter = {
  label,
  async prepare(page, payload) {
    await step(label, 'open the composer', () => page.goto(COMPOSE_URL, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(4000);
    if (/\/login|\/i\/flow/.test(page.url())) throw loginRequired(label, COMPOSE_URL);
    const account = await page.evaluate(() => (document.querySelector('[data-testid=AppTabBar_Profile_Link]')?.getAttribute('href') || '').replace(/^\//, '') || null).catch(() => null);
    for (const [i, post] of payload.posts.entries()) {
      const editor = `[data-testid=tweetTextarea_${i}]`;
      if (i > 0) await step(label, `add post ${i + 1}`, () => page.locator('[data-testid=addButton]').click({ timeout: T }));
      await step(label, `write post ${i + 1}`, async () => {
        await page.locator(editor).waitFor({ timeout: T });
        await pasteText(page, editor, post.text);
      });
      if (post.media) {
        await step(label, `attach media to post ${i + 1}`, async () => {
          await page.locator(editor).click();
          await page.locator('input[data-testid=fileInput]').first().setInputFiles(post.media.path, { timeout: T });
        });
      }
    }
    await step(label, 'wait for the uploads', () => page.waitForFunction(() => {
      const button = document.querySelector('[data-testid=tweetButton]');
      const uploading = [...document.querySelectorAll('[data-testid=attachments]')].some((a) => /Uploading|Processing/i.test(a.innerText));
      return button && button.getAttribute('aria-disabled') !== 'true' && !uploading;
    }, null, { timeout: 600_000 }));
    const lengths = await page.evaluate((n) => Array.from({ length: n }, (_, i) => document.querySelector(`[data-testid=tweetTextarea_${i}]`)?.innerText.length ?? 0), payload.posts.length);
    return { account, posts: payload.posts.length, lengths };
  },
  async submit(page, payload) {
    await step(label, 'post the thread', () => page.locator('[data-testid=tweetButton]').click({ timeout: T }));
    await step(label, 'wait for it to send', () => page.waitForURL((url) => !/compose/.test(url.toString()), { timeout: 180_000 }));
    const url = await step(label, 'find the new thread', async () => {
      const profile = await page.locator('[data-testid=AppTabBar_Profile_Link]').getAttribute('href', { timeout: T });
      await page.goto(`https://x.com${profile}`, { waitUntil: 'domcontentloaded', timeout: T });
      await page.waitForTimeout(5000);
      const opening = payload.posts[0].text.slice(0, 40);
      return page.evaluate((start) => {
        const article = [...document.querySelectorAll('article')].find((a) => (a.querySelector('[data-testid=tweetText]')?.innerText || '').startsWith(start));
        const href = article && [...article.querySelectorAll('a[href*="/status/"]')].map((a) => a.getAttribute('href')).find((h) => /\/status\/\d+$/.test(h));
        return href ? `https://x.com${href}` : null;
      }, opening);
    });
    return { url };
  },
};
