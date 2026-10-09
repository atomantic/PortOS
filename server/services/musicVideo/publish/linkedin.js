/**
 * LinkedIn adapter: a native video post (LinkedIn shows uploaded video to far
 * more people than a post with an outside link), with short text and the
 * links, when the director wants them, saved for the first comment instead.
 *
 * prepare() opens the feed's share box, uploads the 1080p encode through the
 * Add media chooser, steps through the media editor's Next (that only returns
 * to the composer), pastes the text, and waits for the upload. PortOS never
 * presses Post.
 *
 * LinkedIn stays on the feed after Post and offers "View post" in a toast.
 * Once the director opens it, findPost records the post's link and, when there
 * is a first comment, types it into the post's comment box: the director
 * presses Comment.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, clickVisibleText, landedOnPost, loginRequired, pasteText, step } from './browser.js';

const label = 'LinkedIn';
const SHARE_URL = 'https://www.linkedin.com/feed/?shareActive=true';
const SIGN_IN = /linkedin\.com\/(?:login|authwall|checkpoint|uas\/login|signup)/;
const DIALOG = '[role=dialog]';
const EDITOR = `${DIALOG} .ql-editor[contenteditable=true]`;
const COMMENT_EDITOR = '.comments-comment-box .ql-editor[contenteditable=true], .comments-comment-texteditor .ql-editor[contenteditable=true]';
const POST_URL = /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(?:activity|share|ugcPost):\d+/;

/** The post's opening words, as the post page shows them (its first line; LinkedIn folds the rest under "see more"). */
const opening = (text) => String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';

async function openComposer(page) {
  await step(label, 'open the share box', () => page.goto(SHARE_URL, { waitUntil: 'domcontentloaded', timeout: T }));
  await page.waitForTimeout(4000);
  if (SIGN_IN.test(page.url())) throw loginRequired(label, 'https://www.linkedin.com/login');
  // ?shareActive opens the share box itself; when it doesn't, press "Start a post".
  const open = await page.locator(EDITOR).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (!open) {
    await step(label, 'start a post', async () => {
      await clickVisibleText(page, 'Start a post');
      await page.locator(EDITOR).first().waitFor({ timeout: T });
    });
  }
}

async function attachVideo(page, video) {
  await step(label, 'attach the video', async () => {
    const button = page.locator(`${DIALOG} button[aria-label="Add media"], ${DIALOG} button[aria-label="Add a video"]`).first();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: T }), button.click({ timeout: T })]);
    await chooser.setFiles(video.path);
  });
  // The media editor opens over the composer with the clip; Next returns to the composer.
  await step(label, 'return to the post', async () => {
    await page.locator(`${DIALOG} video`).first().waitFor({ timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    for (const name of ['Next', 'Done']) {
      if (await page.locator(EDITOR).first().isVisible().catch(() => false)) break;
      await clickVisibleText(page, name).catch(() => {});
      await page.waitForTimeout(1500);
    }
    await page.locator(EDITOR).first().waitFor({ timeout: T });
  });
}

export const linkedinAdapter = {
  label,
  async prepare(page, payload) {
    await openComposer(page);
    await attachVideo(page, payload.video);
    await step(label, 'write the post', async () => {
      await page.locator(EDITOR).first().click({ timeout: T });
      await pasteText(page, EDITOR, payload.text);
    });
    await step(label, 'wait for the upload', () => page.waitForFunction((dialog) => {
      const box = document.querySelector(dialog);
      const post = [...(box?.querySelectorAll('button') || [])].find((b) => (b.innerText || '').trim() === 'Post');
      const uploading = box?.querySelector('[role=progressbar], progress') || /Uploading|Processing/i.test(box?.innerText || '');
      return post && !post.disabled && post.getAttribute('aria-disabled') !== 'true' && !uploading;
    }, DIALOG, { timeout: 600_000 }));
    const length = await page.evaluate((sel) => document.querySelector(sel)?.innerText.trim().length ?? 0, EDITOR).catch(() => null);
    return {
      characters: length,
      firstComment: payload.firstComment ? 'Typed into the comment box once you press Post, then View post' : null,
    };
  },
  async findPost(page, payload) {
    const url = await landedOnPost(page, POST_URL, opening(payload.text), ([match]) => `${match}/`);
    if (url && payload.firstComment) {
      // Typed, never sent: the director presses Comment. A miss still records the post.
      await page.locator(COMMENT_EDITOR).first().click({ timeout: 10_000 })
        .then(() => pasteText(page, COMMENT_EDITOR, payload.firstComment))
        .catch((err) => console.warn(`⚠️ ${label}: could not type the first comment (${err?.message?.split('\n')[0]})`));
    }
    return url;
  },
};
