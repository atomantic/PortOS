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

/**
 * The CSS prefix that scopes selectors to the composer we opened. /compose/post opens as a modal over the
 * home timeline, whose own inline composer reuses the same data-testids (tweetTextarea_0, tweetButton,
 * fileInput), so an unscoped selector matches both. Without a modal (a full-page composer) it is empty.
 */
async function composerScope(page) {
  const inDialog = await page.locator('[role=dialog] [data-testid=tweetTextarea_0]').count().catch(() => 0);
  return inDialog > 0 ? '[role=dialog] ' : '';
}

export const xAdapter = {
  label,
  async prepare(page, payload) {
    await step(label, 'open the composer', () => page.goto(COMPOSE_URL, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(4000);
    if (/\/login|\/i\/flow/.test(page.url())) throw loginRequired(label, COMPOSE_URL);
    const account = await page.evaluate(() => (document.querySelector('[data-testid=AppTabBar_Profile_Link]')?.getAttribute('href') || '').replace(/^\//, '') || null).catch(() => null);
    const scope = await composerScope(page);
    for (const [i, post] of payload.posts.entries()) {
      const editor = `${scope}[data-testid=tweetTextarea_${i}]`;
      if (i > 0) await step(label, `add post ${i + 1}`, () => page.locator(`${scope}[data-testid=addButton]`).click({ timeout: T }));
      await step(label, `write post ${i + 1}`, async () => {
        await page.locator(editor).waitFor({ timeout: T });
        await pasteText(page, editor, post.text);
      });
      if (post.media) {
        await step(label, `attach media to post ${i + 1}`, async () => {
          await page.locator(editor).click();
          await page.locator(`${scope}input[data-testid=fileInput]`).first().setInputFiles(post.media.path, { timeout: T });
        });
      }
    }
    await step(label, 'wait for the uploads', () => page.waitForFunction((sc) => {
      const button = document.querySelector(`${sc}[data-testid=tweetButton]`);
      const uploading = [...document.querySelectorAll(`${sc}[data-testid=attachments]`)].some((a) => /Uploading|Processing/i.test(a.innerText));
      return button && button.getAttribute('aria-disabled') !== 'true' && !uploading;
    }, scope, { timeout: 600_000 }));
    const lengths = await page.evaluate(([n, sc]) => Array.from({ length: n }, (_, i) => document.querySelector(`${sc}[data-testid=tweetTextarea_${i}]`)?.innerText.length ?? 0), [payload.posts.length, scope]);
    return { account, posts: payload.posts.length, lengths };
  },
  async submit(page, payload) {
    const scope = await composerScope(page);
    await step(label, 'post the thread', () => page.locator(`${scope}[data-testid=tweetButton]`).click({ timeout: T }));
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
