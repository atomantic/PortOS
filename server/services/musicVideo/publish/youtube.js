/**
 * YouTube + YouTube Shorts adapter (#9282), driving YouTube Studio's upload
 * dialog. A Short is the same upload of a vertical cut under 3 minutes.
 * prepare() uploads and fills everything up to the Visibility step with
 * Public selected; submit() presses Publish. Studio saves an upload as a
 * private draft as soon as the file lands, so a discarded draft stays in the
 * channel's Content list as Private.
 */
import { PUBLISH_STEP_TIMEOUT_MS as T, loginRequired, step } from './browser.js';

const UPLOAD_URL = 'https://www.youtube.com/upload';
// The dialog shows the watch link with or without its scheme (Shorts omit it).
const LINK_RE = /(https?:\/\/)?(youtu\.be|(www\.)?youtube\.com\/shorts)\/[\w-]+/;
const normalizeLink = (link) => (link ? (link.startsWith('http') ? link : `https://${link}`) : null);

async function selectDropdownItem(page, triggerSelector, itemText) {
  await page.evaluate((sel) => {
    const t = document.querySelector(sel);
    t.scrollIntoView({ block: 'center' });
    t.click();
  }, triggerSelector);
  await page.waitForTimeout(800);
  const picked = await page.evaluate((want) => {
    const item = [...document.querySelectorAll('tp-yt-paper-item')].find((e) => e.offsetParent && e.innerText.trim() === want);
    if (!item) return false;
    item.scrollIntoView({ block: 'center' });
    item.click();
    return true;
  }, itemText);
  if (!picked) throw new Error(`no "${itemText}" option`);
}

function adapter(label) {
  return {
    label,
    async prepare(page, payload) {
      await step(label, 'open the upload dialog', () => page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded', timeout: T }));
      await page.waitForTimeout(4000);
      if (/accounts\.google\.com/.test(page.url())) throw loginRequired(label, UPLOAD_URL);
      await step(label, 'upload the video', () => page.locator('input[type=file][name=Filedata]').first().setInputFiles(payload.video.path, { timeout: T }));
      const title = page.locator('#title-textarea #textbox');
      await step(label, 'wait for the details form', () => title.waitFor({ timeout: T }));
      await step(label, 'set the title', async () => {
        await title.click();
        await page.keyboard.press('ControlOrMeta+A');
        await page.keyboard.press('Backspace');
        await page.keyboard.insertText(payload.title);
      });
      if (payload.description) {
        await step(label, 'set the description', async () => {
          await page.locator('#description-textarea #textbox').click();
          await page.keyboard.insertText(payload.description);
        });
      }
      let thumbnail = false;
      if (payload.thumbnail) {
        // Custom thumbnails need a verified channel; without one the input is absent.
        const input = page.locator('input#file-loader[accept*=image]');
        if (await input.count()) {
          await step(label, 'upload the thumbnail', () => input.first().setInputFiles(payload.thumbnail.path, { timeout: T }));
          thumbnail = true;
        }
      }
      await step(label, 'mark it not made for kids', () => page.locator('tp-yt-paper-radio-button[name=VIDEO_MADE_FOR_KIDS_NOT_MFK]').click({ timeout: T }));
      await step(label, 'open the advanced details', () => page.locator('#toggle-button').filter({ hasText: 'Show more' }).first().click({ timeout: T }));
      await step(label, 'declare no paid promotion', () => page.locator('tp-yt-paper-radio-button[name=VIDEO_PAID_PRODUCT_PLACEMENT_NO]').click({ timeout: T }));
      // The singer is a realistic AI-generated person: YouTube requires the disclosure.
      await step(label, 'disclose altered or synthetic content', () => page.locator('tp-yt-paper-radio-button[name=VIDEO_HAS_ALTERED_CONTENT_YES]').click({ timeout: T }));
      if (payload.tags?.length) {
        await step(label, 'add the tags', async () => {
          await page.locator("input[aria-label='Tags']").click();
          await page.keyboard.insertText(`${payload.tags.join(', ')},`);
        });
      }
      await step(label, 'set the Music category', () => selectDropdownItem(page, 'ytcp-form-select#category ytcp-dropdown-trigger', 'Music'));
      await step(label, 'go to Video elements', () => page.locator('#next-button').click({ timeout: T }));
      let captions = false;
      if (payload.captions) {
        await step(label, 'upload the lyric captions', async () => {
          await page.locator('ytcp-button').filter({ hasText: /^Add$/ }).first().click({ timeout: T });
          await page.locator('button').filter({ hasText: 'Upload file' }).first().click({ timeout: T });
          await page.locator('#captions-file-loader').setInputFiles(payload.captions.path, { timeout: T });
          await page.waitForTimeout(3000);
          await page.locator('button').filter({ hasText: /^Done$/ }).last().click({ timeout: T });
        });
        captions = true;
      }
      await step(label, 'go to Visibility', async () => {
        await page.locator('#next-button').click({ timeout: T });
        await page.waitForTimeout(1500);
        await page.locator('#next-button').click({ timeout: T });
      });
      await step(label, 'choose Public', () => page.locator('tp-yt-paper-radio-button[name=PUBLIC]').click({ timeout: T }));
      const link = normalizeLink(await page.evaluate((re) => (document.querySelector('ytcp-uploads-dialog')?.innerText.match(new RegExp(re)) || [])[0] || null, LINK_RE.source));
      return { title: payload.title, link, thumbnail, captions };
    },
    async submit(page) {
      await step(label, 'publish', () => page.locator('#done-button').click({ timeout: T }));
      const url = await step(label, 'confirm it published', async () => {
        await page.waitForFunction(() => /Video published|published/i.test(document.body.innerText), null, { timeout: 120_000 });
        return normalizeLink(await page.evaluate((re) => (document.body.innerText.match(new RegExp(re)) || [])[0] || null, LINK_RE.source));
      });
      return { url };
    },
  };
}

export const youtubeAdapter = adapter('YouTube');
export const shortsAdapter = adapter('YouTube Shorts');
