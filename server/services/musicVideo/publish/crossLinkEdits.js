/**
 * Backfill cross-links: open a post that is already up and add the links to
 * the release's posts made after it. Each prepare() fills a form in its own
 * tab and stops there: the director reviews it and presses Save (YouTube,
 * Suno) or Reply (X, Stacker News). PortOS never saves, posts or deletes.
 *
 * `row` is one `crossLinkBackfill()` entry: `{ target, url, missing, text }`,
 * `text` being the `Label: url` lines to add.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, loginRequired, pasteText, step } from './browser.js';
import { markSunoSongMenu } from '../../../lib/sunoPage.js';

const youtubeIdOf = (url) => String(url).match(/(?:youtu\.be\/|[?&]v=|\/shorts\/)([\w-]{6,})/)?.[1] || null;
const tweetIdOf = (url) => String(url).match(/\/status\/(\d+)/)?.[1] || null;
const sunoSongIdOf = (url) => String(url).match(/\/song\/([0-9a-f-]{36})/i)?.[1] || null;

/** The lines of `text` whose link `existing` does not already show. */
const linesNotIn = (text, existing) => text.split('\n').filter((line) => line && !existing.includes(line.slice(line.indexOf(': ') + 2)));

const youtube = {
  label: 'YouTube',
  async prepare(page, row) {
    const id = youtubeIdOf(row.url);
    if (!id) throw new Error(`no video id in ${row.url}`);
    const url = `https://studio.youtube.com/video/${id}/edit`;
    await step(this.label, 'open the video details', () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(4000);
    if (/accounts\.google\.com/.test(page.url())) throw loginRequired(this.label, url);
    const box = page.locator('#description-textarea #textbox').first();
    await step(this.label, 'wait for the description', () => box.waitFor({ timeout: T }));
    const lines = linesNotIn(row.text, await box.innerText());
    if (lines.length) {
      await step(this.label, 'add the links to the description', async () => {
        await box.click();
        await page.keyboard.press('ControlOrMeta+End');
        await page.keyboard.insertText(`\n\n${lines.join('\n')}`);
      });
    }
    return { added: lines.length ? lines : ['Nothing: the description already has every link'], leftForYou: ['Save (top right)'] };
  },
};

const suno = {
  label: 'Suno',
  async prepare(page, row) {
    await step(this.label, 'open the song', () => page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(5000);
    if (!(await page.locator("button[aria-label='More options']").count())) throw loginRequired(this.label, row.url);
    // Suno moves its menus around: a miss leaves the lines for the director to paste, never fails the card.
    const caption = await (async () => {
      const songId = sunoSongIdOf(page.url()) || sunoSongIdOf(row.url);
      if (!songId || !(await page.evaluate(markSunoSongMenu, songId))) return null;
      await page.locator('[data-portos-song-menu]').click({ timeout: 15_000 });
      await page.waitForTimeout(600);
      const item = (re) => page.locator('[role=menuitem]').filter({ hasText: re }).first();
      if (await item(/^Edit$/).isVisible().catch(() => false)) {
        await item(/^Edit$/).hover();
        await page.waitForTimeout(600);
      }
      const details = item(/Song Details|Edit Details|Details/);
      if (!(await details.isVisible().catch(() => false))) return null;
      await details.click({ timeout: 15_000 });
      const field = page.locator("[role=dialog] textarea[placeholder='Add a caption'], [role=dialog] textarea[aria-label*='caption' i]").first();
      await field.waitFor({ timeout: 15_000 });
      return field;
    })().catch(() => null);
    if (!caption) return { added: [], leftForYou: [`Open the song's details and add to its caption:\n${row.text}`, 'Save'] };
    const current = await caption.inputValue();
    const lines = linesNotIn(row.text, current);
    if (lines.length) await step(this.label, 'add the links to the caption', () => caption.fill([current.trimEnd(), lines.join('\n')].filter(Boolean).join('\n')));
    return { added: lines.length ? lines : ['Nothing: the caption already has every link'], leftForYou: ['Save'] };
  },
};

const x = {
  label: 'X',
  async prepare(page, row) {
    const id = tweetIdOf(row.url);
    if (!id) throw new Error(`no post id in ${row.url}`);
    const url = `https://x.com/intent/post?in_reply_to=${id}&text=${encodeURIComponent(row.text)}`;
    await step(this.label, 'open a reply to the post', () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(4000);
    if (/\/login|\/i\/flow/.test(page.url())) throw loginRequired(this.label, url);
    const editor = '[data-testid=tweetTextarea_0]';
    await step(this.label, 'wait for the reply composer', () => page.locator(editor).first().waitFor({ timeout: T }));
    // The intent link normally prefills the text; paste it when it did not.
    const shown = await page.locator(editor).first().innerText().catch(() => '');
    if (!shown.includes(row.missing[0]?.url || row.text)) await step(this.label, 'write the reply', () => pasteText(page, editor, row.text));
    return { added: row.text.split('\n'), leftForYou: ['Reply'] };
  },
};

const stackerNews = {
  label: 'Stacker News',
  async prepare(page, row) {
    await step(this.label, 'open the post', () => page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: T }));
    await page.waitForTimeout(3000);
    const editor = 'div[contenteditable=true]';
    if (!(await page.locator(editor).count())) throw loginRequired(this.label, 'https://stacker.news/login');
    await step(this.label, 'write the comment', async () => {
      await page.locator(editor).first().click();
      await pasteText(page, editor, row.text);
    });
    return { added: row.text.split('\n'), leftForYou: ['reply'] };
  },
};

export const CROSS_LINK_ADAPTERS = Object.freeze({ youtube, suno, x, stackerNews });
