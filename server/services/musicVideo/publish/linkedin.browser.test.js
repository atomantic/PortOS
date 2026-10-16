import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun } from '../../../lib/browserSuiteGate.js';
import { startOwnedBrowserFixture } from '../../../test/browserFixture.js';
import { linkedinAdapter } from './linkedin.js';

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(path => path && existsSync(path));
const canRun = browserSuiteCanRun('LinkedIn draft browser', { Chrome: chrome });
const POST_URL = 'https://www.linkedin.com/feed/update/urn:li:activity:123456789/';
const text = 'Example film.\n\nA second paragraph.\n\n\nFinal paragraph.';
const comment = 'Full film: https://example.com/film\n\nSong: https://example.com/song';

// Both pages are inline synthetic documents: every browser request is fulfilled
// here or refused. No account profile, live page or external connection is used.
function fixtureHtml({ legacy, posted = false }) {
  return String.raw`<!doctype html><html><head><style>
    [hidden] { display: none !important; }
    [contenteditable] { min-height: 80px; width: 400px; border: 1px solid; }
    [role=dialog] { position: fixed; inset: 20px; background: white; }
    video { display: block; width: 200px; height: 80px; }
  </style></head><body>
  <button onclick="window.startClicks++">Start a post</button>
  <div class="ProseMirror" contenteditable="true" id="unrelated">Unrelated editor</div>
  <dialog><div class="ProseMirror" contenteditable="true">Closed composer</div></dialog>
  <div id="fixture"></div><script>
    window.startClicks = 0; window.publishClicks = []; window.commentInputs = 0;
    const root = ${legacy} ? document.getElementById('fixture').attachShadow({ mode: 'open' }) : document.getElementById('fixture');
    const editorClass = ${legacy} ? 'ql-editor' : 'tiptap ProseMirror';
    const editor = id => '<div id="' + id + '" class="' + editorClass + '" contenteditable="true" role="textbox"><p><br></p></div>';
    const composer = ${legacy} ? '<div role="dialog" id="composer">' : '<dialog id="composer">';
    const end = ${legacy} ? '</div>' : '</dialog>';
    root.innerHTML = ${posted}
      ? '<article><p>Example film.</p><div class="comments-comment-texteditor">' + editor('comment') + '<button id="comment-send">Comment</button></div></article>'
      : composer + '<section id="post-body">' + editor('post') + '<button id="media" aria-label="${legacy ? 'Add media' : 'Media'}">Attach clip</button><input type="file" hidden id="file"><button id="post-send">Post</button></section><section id="media-body" hidden><video></video><button id="next">Next</button></section>' + end;
    for (const id of ['post-send', 'comment-send']) root.querySelector('#' + id)?.addEventListener('click', () => window.publishClicks.push(id));
    root.querySelector('#comment')?.addEventListener('input', () => window.commentInputs++);
    if (${legacy}) {
      // The old editor accepts synthetic paste. The current editor ignores it,
      // exercising real browser insertion and paragraph creation via Enter.
      root.addEventListener('paste', event => {
        event.preventDefault();
        const paragraphs = event.clipboardData.getData('text/plain').split('\n').map(line => {
          const p = document.createElement('p'); p.textContent = line;
          if (!line) p.append(document.createElement('br'));
          return p;
        });
        event.target.replaceChildren(...paragraphs);
      });
    }
    if (!${posted}) {
      root.querySelector('#media').onclick = () => root.querySelector('#file').click();
      root.querySelector('#file').onchange = () => {
        root.querySelector('#post-body').hidden = true;
        root.querySelector('#media-body').hidden = false;
      };
      root.querySelector('#next').onclick = () => {
        root.querySelector('#post-body').hidden = false;
        root.querySelector('#media-body').hidden = true;
      };
      if (!${legacy}) root.querySelector('#composer').showModal();
    }
  </script></body></html>`;
}

describe.skipIf(!canRun)('LinkedIn synthetic draft UI in Chrome', () => {
  let fixture;
  let video;
  beforeAll(async () => {
    fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
    video = join(fixture.temp, 'synthetic.mp4');
    await writeFile(video, 'Synthetic upload fixture');
  }, 30000);
  afterAll(() => fixture?.close());

  it.each([{ legacy: false, name: 'native dialog / ProseMirror keyboard fallback' },
    { legacy: true, name: 'role dialog / shadow Quill paste' }])('prepares $name and leaves Post and Comment to the operator', async ({ legacy }) => {
    const context = await fixture.browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    // Fixture state transitions are synchronous; production upload waits are not
    // part of this selector/contenteditable contract.
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.waitForTimeout = async () => { expect(errors).toEqual([]); };
    const unexpected = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === 'https://www.linkedin.com' && route.request().resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html', body: fixtureHtml({ legacy, posted: url.href === POST_URL }) });
      }
      unexpected.push(url.protocol);
      return route.abort();
    });
    const payload = { video: { path: video }, text, firstComment: comment };
    try {
      const summary = await linkedinAdapter.prepare(page, payload);
      const editor = page.locator('#post');
      expect(await editor.locator('p').allTextContents()).toEqual(text.split('\n'));
      expect(await page.locator('input[type=file]').evaluate(input => input.files[0].name)).toBe('synthetic.mp4');
      expect(await page.locator('#unrelated').innerText()).toBe('Unrelated editor');
      expect(await page.evaluate(() => ({ starts: window.startClicks, publishes: window.publishClicks }))).toEqual({ starts: 0, publishes: [] });
      expect(summary.characters).toBeGreaterThan(0);
      expect(await page.getByRole('button', { name: 'Post', exact: true }).isEnabled()).toBe(true);
      await page.goto(POST_URL);
      expect(await linkedinAdapter.findPost(page, payload)).toBe(POST_URL);
      expect(await page.locator('#comment p').allTextContents()).toEqual(comment.split('\n'));
      const inputs = await page.evaluate(() => window.commentInputs);
      expect(await linkedinAdapter.findPost(page, payload)).toBe(POST_URL);
      expect(await page.evaluate(() => window.commentInputs)).toBe(inputs);
      expect(await page.evaluate(() => window.publishClicks)).toEqual([]);
      expect(unexpected).toEqual([]);
    } finally { await context.close(); }
  }, 30000);
});
