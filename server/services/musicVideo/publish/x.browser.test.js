import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun, resolveTestChrome } from '../../../lib/browserSuiteGate.js';
import { startOwnedBrowserFixture } from '../../../test/browserFixture.js';
import { xAdapter } from './x.js';
import { typeXText } from './xTyping.js';
import { CROSS_LINK_ADAPTERS } from './crossLinkEdits.js';

const chrome = resolveTestChrome();
const canRun = browserSuiteCanRun('X draft browser', { Chrome: chrome });
const html = `<!doctype html><html><body>
  <div role="dialog"><div id="posts"></div><button data-testid="addButton">Add</button>
  <button data-testid="tweetButton" onclick="window.sent++">Post</button></div>
  <input id="other"><button id="otherButton" onclick="window.sent++">Other</button>
  <script>
    window.sent = 0; window.inputs = 0; window.keys = 0; window.pastes = 0;
    function add() {
      const el = document.createElement('div'); el.contentEditable = 'true';
      el.dataset.testid = 'tweetTextarea_' + document.querySelectorAll('[contenteditable]').length;
      el.style.cssText = 'min-height:40px;width:400px;border:1px solid';
      let lines = [''];
      function render() {
        el.replaceChildren(...lines.map(line => {
          const block = document.createElement('div'); block.dataset.block = 'true';
          block.textContent = line; if (!line) block.append(document.createElement('br'));
          return block;
        }));
        const range = document.createRange(); range.selectNodeContents(el.lastChild); range.collapse(false);
        const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
      el.addEventListener('beforeinput', event => {
        if (event.inputType !== 'insertText') return;
        event.preventDefault(); lines[lines.length - 1] += event.data; window.inputs++; render();
      });
      el.addEventListener('paste', () => window.pastes++);
      el.addEventListener('keydown', event => {
        window.keys++;
        if (event.key !== 'Enter') return;
        event.preventDefault(); lines.push(''); window.inputs++; render();
      });
      document.getElementById('posts').append(el); render();
    }
    document.querySelector('[data-testid=addButton]').onclick = add; add();
  </script></body></html>`;

describe.skipIf(!canRun)('X paced draft preparation in an isolated browser', () => {
  let fixture;
  beforeAll(async () => { fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } }); }, 30000);
  afterAll(() => fixture?.close());

  async function newPage() {
    const context = await fixture.browser.newContext({ serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === 'https://x.com' && route.request().resourceType() === 'document'
        ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort();
    });
    const page = await context.newPage();
    page.waitForTimeout = async () => {};
    return { context, page };
  }

  it('fills a thread with Unicode, blank lines, and a URL on repeated runs without posting', async () => {
    const posts = [{ text: 'Hi 👩🏽‍💻 é\n\nhttps://example.com/a' }, { text: 'Last\nline\n' }];
    for (let run = 0; run < 2; run++) {
      const { context, page } = await newPage();
      try {
        await xAdapter.prepare(page, { posts });
        for (const [i, post] of posts.entries()) {
          expect(await page.locator(`[data-testid=tweetTextarea_${i}] [data-block=true]`).allTextContents()).toEqual(post.text.split('\n'));
        }
        expect(await page.evaluate(() => ({ sent: window.sent, pastes: window.pastes, keys: window.keys > 0 }))).toEqual({ sent: 0, pastes: 0, keys: true });
      } finally { await context.close(); }
    }
  }, 30000);

  it('types a cross-link reply without pre-filling or sending it', async () => {
    const { context, page } = await newPage();
    try {
      const text = 'Film: https://example.com/f\nSong: https://example.com/s';
      const summary = await CROSS_LINK_ADAPTERS.x.prepare(page, { url: 'https://x.com/example/status/42', text, missing: [{ url: 'https://example.com/f' }] });
      expect(page.url()).toBe('https://x.com/intent/post?in_reply_to=42');
      expect(await page.locator('[data-block=true]').allTextContents()).toEqual(text.split('\n'));
      expect(summary.leftForYou).toEqual(['Reply']);
      expect(await page.evaluate(() => window.sent)).toBe(0);
    } finally { await context.close(); }
  }, 30000);

  it('does not overwrite an existing editor', async () => {
    const { context, page } = await newPage();
    try {
      await page.goto('https://x.com/compose/post');
      await page.locator('[data-testid=tweetTextarea_0]').click();
      await page.keyboard.insertText('Existing');
      await expect(typeXText(page, '[data-testid=tweetTextarea_0]', 'Replacement')).rejects.toMatchObject({ code: 'PUBLISH_EDIT_INTERRUPTED' });
      expect(await page.locator('[data-block=true]').allTextContents()).toEqual(['Existing']);
      expect(await page.evaluate(() => window.sent)).toBe(0);
    } finally { await context.close(); }
  });

  it('stops after a person moves focus, without typing into another field or submitting', async () => {
    const { context, page } = await newPage();
    try {
      await page.goto('https://x.com/compose/post');
      const typing = typeXText(page, '[data-testid=tweetTextarea_0]', 'Long draft\nwith more text');
      const outcome = typing.then(() => null, error => error);
      await page.waitForFunction(() => window.inputs >= 1);
      await page.locator('#other').click();
      expect(await outcome).toMatchObject({ code: 'PUBLISH_EDIT_INTERRUPTED' });
      expect(await page.locator('#other').inputValue()).toBe('');
      expect(await page.evaluate(() => window.sent)).toBe(0);
    } finally { await context.close(); }
  }, 30000);
});
