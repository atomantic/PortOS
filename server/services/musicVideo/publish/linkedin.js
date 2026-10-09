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
 *
 * LinkedIn draws the share box inside a shadow root, which `document` queries
 * never reach, so everything here goes through Playwright locators (they pierce
 * open shadow roots), including the paste.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, loginRequired, step } from './browser.js';

const label = 'LinkedIn';
const SHARE_URL = 'https://www.linkedin.com/feed/?shareActive=true';
const SIGN_IN = /linkedin\.com\/(?:login|authwall|checkpoint|uas\/login|signup)/;
const DIALOG = '[role=dialog]';
const EDITOR = `${DIALOG} .ql-editor[contenteditable=true]`;
const COMMENT_EDITOR = '.comments-comment-box .ql-editor[contenteditable=true], .comments-comment-texteditor .ql-editor[contenteditable=true]';
// Drafts whose first comment was already typed: a reload of the post page must not type it twice.
const commented = new WeakSet();
const UPLOAD_WAIT_MS = 600_000;
const POST_URL = /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(?:activity|share|ugcPost):\d+/;

/** The post's opening words, as the post page shows them (its first line; LinkedIn folds the rest under "see more"). */
const opening = (text) => String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';

/** The last visible button reading exactly `name` (a dialog stacks its own buttons last). */
const button = (page, name) => page.locator('button:visible, [role=button]:visible', { hasText: new RegExp(`^\\s*${name}\\s*$`) }).last();

/**
 * Write `text` into the Quill editor `locator` matches. A synthetic paste keeps
 * the line breaks; when Quill ignores it, the lines are typed with Enter between.
 */
async function pasteInto(page, locator, text) {
  await locator.click({ timeout: T });
  await locator.evaluate((el, txt) => {
    el.focus();
    const data = new DataTransfer();
    data.setData('text/plain', txt);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await page.waitForTimeout(500);
  if ((await locator.innerText()).trim()) return;
  for (const [i, line] of String(text).split('\n').entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    if (line) await page.keyboard.insertText(line);
  }
}

/** Whether the share box is done uploading: Post enabled, no progress bar or Uploading/Processing note. */
async function uploadSettled(page) {
  const post = button(page, 'Post');
  if (!(await post.count()) || !(await post.isEnabled())) return false;
  if (await page.locator(`${DIALOG} [role=progressbar], ${DIALOG} progress`).count()) return false;
  return !(await page.locator(DIALOG).filter({ hasText: /Uploading|Processing/i }).count());
}

async function openComposer(page) {
  await step(label, 'open the share box', () => page.goto(SHARE_URL, { waitUntil: 'domcontentloaded', timeout: T }));
  await page.waitForTimeout(4000);
  if (SIGN_IN.test(page.url())) throw loginRequired(label, 'https://www.linkedin.com/login');
  // ?shareActive opens the share box itself; when it doesn't, press "Start a post".
  const open = await page.locator(EDITOR).first().waitFor({ timeout: 8000 }).then(() => true, () => false);
  if (!open) {
    await step(label, 'start a post', async () => {
      await button(page, 'Start a post').click({ timeout: T });
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
      await button(page, name).click({ timeout: 5000 }).catch(() => {});
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
    await step(label, 'write the post', () => pasteInto(page, page.locator(EDITOR).first(), payload.text));
    await step(label, 'wait for the upload', async () => {
      const deadline = Date.now() + UPLOAD_WAIT_MS;
      while (!(await uploadSettled(page))) {
        if (Date.now() > deadline) throw new Error('the upload did not finish');
        await page.waitForTimeout(2000);
      }
    });
    const length = await page.locator(EDITOR).first().innerText().then((t) => t.trim().length, () => null);
    return {
      characters: length,
      firstComment: payload.firstComment ? 'Typed into the comment box once you press Post, then View post' : null,
    };
  },
  async findPost(page, payload) {
    const match = page.url().match(POST_URL);
    const want = opening(payload.text).slice(0, 40);
    if (!match || !want) return null;
    const shown = await page.getByText(want).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const url = shown ? `${match[0]}/` : null;
    if (url && payload.firstComment && !commented.has(payload)) {
      commented.add(payload);
      // Typed, never sent: the director presses Comment. A miss still records the post.
      await pasteInto(page, page.locator(COMMENT_EDITOR).first(), payload.firstComment)
        .catch((err) => console.warn(`⚠️ ${label}: could not type the first comment (${err?.message?.split('\n')[0]})`));
    }
    return url;
  },
};
