/**
 * Substack adapter: a newsletter post on the director's publication with the
 * full video embedded at the top, then the title, subtitle and body. Substack
 * turns a YouTube link pasted on its own line into a video embed; when it does
 * not, the link stays in the post as plain text, and the summary says which.
 *
 * Substack saves a post as a draft in the publication the moment it is typed
 * into, so a filled draft also appears under the publication's Drafts. PortOS
 * never presses Continue or Publish: sending to subscribers stays with the director.
 */
import { escapeRegExp } from '../../../lib/textUtils.js';
import { PUBLISH_STEP_TIMEOUT_MS as T, landedOnPost, loginRequired, pasteText, step } from './browser.js';

const label = 'Substack';
const TITLE = '[data-testid="post-title"], textarea#post-title, textarea.post-title, textarea[placeholder="Title"]';
const SUBTITLE = '[data-testid="post-subtitle"], textarea#post-subtitle, textarea.subtitle, textarea[placeholder^="Add a subtitle"]';
const BODY = '.ProseMirror[contenteditable="true"]';

export const substackAdapter = {
  label,
  async prepare(page, payload) {
    const editorUrl = `https://${payload.publication}/publish/post?type=newsletter`;
    await step(label, 'open a new post', () => page.goto(editorUrl, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(4000);
    if (/\/sign-?in|\/account\/login/.test(page.url())) throw loginRequired(label, editorUrl);
    await step(label, 'write the title', async () => {
      await page.locator(TITLE).first().waitFor({ timeout: T });
      await page.locator(TITLE).first().fill(payload.title);
    });
    if (payload.subtitle) {
      await step(label, 'write the subtitle', () => page.locator(SUBTITLE).first().fill(payload.subtitle, { timeout: T }));
    }
    await step(label, 'embed the video', async () => {
      await page.locator(BODY).first().click({ timeout: T });
      await pasteText(page, BODY, payload.videoUrl);
      await page.waitForTimeout(3000);
    });
    if (payload.body) {
      await step(label, 'write the body', async () => {
        // No click: once the URL became an embed, the editor's middle is the
        // embed, and a click there would send keys to the player or select the
        // embed for the paste to replace. Refocus the editor and go to its end.
        await page.evaluate((sel) => document.querySelector(sel)?.focus(), BODY);
        await page.keyboard.press('ControlOrMeta+End');
        await page.keyboard.press('Enter');
        await pasteText(page, BODY, payload.body);
      });
    }
    const embedded = await page.evaluate((sel) => !!document.querySelector(sel)?.querySelector('iframe[src*="youtube"], [class*="youtube"]'), BODY).catch(() => false);
    return {
      publication: payload.publication, title: payload.title, subtitle: payload.subtitle || null,
      video: embedded ? `Embedded: ${payload.videoUrl}` : `Link (not embedded): ${payload.videoUrl}`,
      saved: 'Substack keeps this under Drafts; each Fill again saves another draft there',
    };
  },
  // Published, the post lives at /p/<slug> on the publication.
  findPost: (page, payload) => landedOnPost(page, new RegExp(`^https://${escapeRegExp(payload.publication)}/p/[^/?#]+`), payload.title),
};
