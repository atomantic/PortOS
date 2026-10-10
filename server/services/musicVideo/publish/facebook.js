/**
 * Facebook adapter: a native video post (Facebook shows uploaded video to far
 * more people than a post with an outside link, and since 2025 every uploaded
 * video is shared as a reel), with short text and the links, when the
 * director wants them, saved for the first comment instead.
 *
 * prepare() opens the feed's "What's on your mind" composer, pastes the text,
 * hands the 1080p encode to the composer's file input (its drop zone holds one
 * from the start; older layouts show it behind a Photo/video button), waits for
 * the upload (the caption box then reads "Describe your reel") and turns on
 * Facebook's AI label unless the director said not to. PortOS never presses
 * Next or Post, and leaves the audience as Facebook has it. The composer posts
 * as whichever profile is active in the PortOS Browser, so a Page posts the
 * same way once the director switches to it.
 *
 * Facebook stays on the feed after Post. Once the director opens the new post
 * (its timestamp), findPost records the post's link and, when there is a
 * first comment, types it into the comment box: the director presses Enter.
 *
 * Like LinkedIn's share box, everything goes through Playwright locators
 * (they pierce open shadow roots), never `document` queries.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, loginRequired, step } from './browser.js';

const label = 'Facebook';
const HOME_URL = 'https://www.facebook.com/';
const SIGN_IN = /facebook\.com\/(?:login|checkpoint|recover|r\.php)/;
const TEXTBOX = '[role=textbox][contenteditable=true]';
// The composer is the dialog holding the post's text box (a notification can be another dialog).
const COMPOSER = `[role=dialog]:has(${TEXTBOX})`;
const COMMENT_BOX = `${TEXTBOX}[aria-label*="comment" i]`;
// Drafts whose first comment was already typed: a reload of the post page must not type it twice.
const commented = new WeakSet();
const UPLOAD_WAIT_MS = 600_000;
const MEDIA_BUTTON = /Add photos(?:\/| or )videos/i;
const AI_LABEL = /^\s*Add AI label/i;
// A post's own page: a reel (every uploaded video), a video, a post, or a permalink.
const POST_URL = /^https:\/\/(?:www|web|m)\.facebook\.com\/(?:reel\/\d+|[\w.-]+\/(?:posts|videos)\/[\w.-]+|permalink\.php\?[^#]*story_fbid=[\w-]+[^#]*|watch\/?\?v=\d+)/;

/** The post's opening words, as the post page shows them (Facebook folds the rest under "See more"). */
const opening = (text) => String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';

/** The last visible button named exactly `name` (its text or aria-label: Photo/video is an icon) inside `scope`. */
const button = (scope, name) => scope.getByRole('button', { name, exact: true }).filter({ visible: true }).last();

/**
 * Write `text` into the Lexical editor `locator` matches. A synthetic paste
 * keeps the line breaks (and opens no @mention picker); when Lexical ignores
 * it, the lines are typed with Enter between.
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

/**
 * Whether the composer is done uploading: an "Uploaded media" section with a
 * Remove video button, and no Uploading/Processing note or progress bar.
 */
async function uploadSettled(page) {
  const composer = page.locator(COMPOSER).last();
  if (!(await page.locator(COMPOSER).filter({ hasText: /Uploaded media/i }).count())) return false;
  if (!(await button(composer, 'Remove video').count())) return false;
  if (await composer.locator('[role=progressbar], progress').count()) return false;
  return !(await page.locator(COMPOSER).filter({ hasText: /Uploading|Processing/i }).count());
}

async function openComposer(page) {
  await step(label, 'open Facebook', () => page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: T }));
  await page.waitForTimeout(4000);
  if (await facebookSignedOut(page)) throw loginRequired(label, 'https://www.facebook.com/login');
  await step(label, 'open the post composer', async () => {
    await page.locator('[role=button]:visible', { hasText: /on your mind/i }).first().click({ timeout: T });
    await page.locator(`${COMPOSER} ${TEXTBOX}`).first().waitFor({ timeout: T });
  });
}

async function attachVideo(page, video) {
  await step(label, 'attach the video', async () => {
    const composer = page.locator(COMPOSER).last();
    const input = composer.locator('input[type=file]').first();
    const hasInput = () => input.waitFor({ state: 'attached', timeout: 5000 }).then(() => true, () => false);
    // The drop zone's input is there from the start; an older layout adds it behind Photo/video.
    if (!(await hasInput())) await button(composer, 'Photo/video').click({ timeout: 10_000 }).catch(() => {});
    if (await hasInput()) {
      await input.setInputFiles(video.path);
      return;
    }
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: T }),
      composer.locator('[role=button]', { hasText: MEDIA_BUTTON }).first().click({ timeout: T }),
    ]);
    await chooser.setFiles(video.path);
  });
}

/**
 * Turn on the composer's "Add AI label" row. Its switch has no useful name
 * ("Off"), so the row is found by its text and the switch inside it read for
 * its state. Resolves 'On', or null when the row is missing or did not turn on.
 */
async function labelAsAi(composer) {
  const row = composer.locator('[role=button]').filter({ hasText: AI_LABEL }).first();
  if (!(await row.count())) return null;
  const toggle = row.locator('[role=switch]').first();
  const on = async () => (await toggle.getAttribute('aria-checked', { timeout: 5000 }).catch(() => null)) === 'true';
  if (await on()) return 'On';
  await ((await toggle.count()) ? toggle : row).click({ timeout: 10_000 });
  return (await on()) ? 'On' : null;
}

/** Type `text` into the open post's comment box (never sent: the director presses Enter). */
export const typeFacebookComment = (page, text) => pasteInto(page, page.locator(COMMENT_BOX).first(), text);

/** Whether a page shows Facebook's sign-in form instead of the signed-in site. */
export const facebookSignedOut = async (page) => SIGN_IN.test(page.url()) || (await page.locator('input[name=pass]').count()) > 0;

export const facebookAdapter = {
  label,
  async prepare(page, payload) {
    await openComposer(page);
    await step(label, 'write the post', () => pasteInto(page, page.locator(`${COMPOSER} ${TEXTBOX}`).first(), payload.text));
    await attachVideo(page, payload.video);
    await step(label, 'wait for the upload', async () => {
      const deadline = Date.now() + UPLOAD_WAIT_MS;
      while (!(await uploadSettled(page))) {
        if (Date.now() > deadline) throw new Error('the upload did not finish');
        await page.waitForTimeout(2000);
      }
    });
    const composer = page.locator(COMPOSER).last();
    const aiLabel = payload.aiLabel === false ? 'Off (you chose)'
      // A miss never fails the draft: the summary asks the director to turn it on.
      : (await labelAsAi(composer).catch(() => null)) || 'Not turned on: switch on Add AI label yourself';
    const length = await composer.locator(TEXTBOX).first().innerText().then((t) => t.trim().length, () => null);
    const next = await button(composer, 'Next').count().catch(() => 0);
    return {
      characters: length,
      aiLabel,
      audience: 'As Facebook has it (check Post audience)',
      // A video post may ask for Next (post settings) before Post; neither is pressed here.
      youPress: next ? 'Next, then Post' : 'Post',
      firstComment: payload.firstComment ? 'Typed into the comment box once you press Post and open the post' : null,
    };
  },
  async findPost(page, payload) {
    const match = page.url().match(POST_URL);
    const want = opening(payload.text).slice(0, 30);
    if (!match || !want) return null;
    const shown = await page.getByText(want).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const url = shown ? match[0] : null;
    if (url && payload.firstComment && !commented.has(payload)) {
      commented.add(payload);
      // Typed, never sent: the director presses Enter. A miss still records the post.
      await typeFacebookComment(page, payload.firstComment)
        .catch((err) => console.warn(`⚠️ ${label}: could not type the first comment (${err?.message?.split('\n')[0]})`));
    }
    return url;
  },
};
