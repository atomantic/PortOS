import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun, resolveTestChrome } from '../../../lib/browserSuiteGate.js';
import { startOwnedBrowserFixture } from '../../../test/browserFixture.js';
import { sunoHookAdapter } from './sunoHook.js';

const chrome = resolveTestChrome();
const canRun = browserSuiteCanRun('Suno Hook draft browser', { Chrome: chrome });
const ID = '12345678-abcd-4abc-8abc-123456789abc';

// Every request is intercepted. This synthetic page deliberately gives the
// waveform an offscreen midpoint, as a translated long song strip would have.
function fixtureHtml(kind, initiallyOn) {
  return String.raw`<!doctype html><html><head><style>
    body { margin: 0; overflow: hidden; }
    [hidden] { display: none !important; }
    .waveform { position: absolute; left: -3873px; top: 150px; width: 5550px; height: 80px; background: gray; }
    #pill { position: absolute; top: 100px; }
    #songs { position: absolute; top: 300px; }
    #post { position: absolute; top: 400px; }
  </style></head><body>
    <input type="file" accept="video/mp4"><button id="select">Select Song</button>
    <div id="songs" role="dialog" hidden><textarea placeholder="Search by song name"></textarea>
      <div><a href="/song/${ID}">Synthetic song</a><button id="use">Use</button><button>A</button><button>B</button></div>
    </div>
    <span id="pill" class="rounded-full font-mono">2:38</span><div class="waveform"></div>
    <button id="next">Next</button>
    <section id="post" hidden><textarea placeholder="Add a caption..."></textarea><div id="lyrics"></div><button id="publish">Post</button></section>
    <script>
      window.windowAt = 158; window.publishClicks = 0; window.points = []; window.dragCount = 0;
      const strip = document.querySelector('.waveform');
      let down = null;
      strip.addEventListener('mousedown', event => { down = event.clientX; window.points.push([event.clientX, event.clientY]); });
      document.addEventListener('mouseup', event => {
        if (down === null) return;
        window.points.push([event.clientX, event.clientY]); window.dragCount++;
        window.windowAt = Math.max(0, window.windowAt - (event.clientX - down) / 21.4);
        document.getElementById('pill').textContent = Math.floor(window.windowAt / 60) + ':' + String(Math.floor(window.windowAt % 60)).padStart(2, '0');
        down = null;
      });
      document.getElementById('select').onclick = () => document.getElementById('songs').hidden = false;
      document.getElementById('use').onclick = () => document.getElementById('songs').hidden = true;
      document.getElementById('next').onclick = () => document.getElementById('post').hidden = false;
      document.getElementById('publish').onclick = () => window.publishClicks++;
      const kind = '${kind}';
      const host = document.getElementById('lyrics');
      const root = kind === 'shadow' ? host.attachShadow({ mode: 'open' }) : host;
      const checked = ${initiallyOn};
      const toggle = named => '<button role="switch" ' + (named ? 'aria-label="Show Lyrics" ' : '') + 'aria-checked="' + checked + '">Toggle</button>';
      if (kind === 'checkbox') root.innerHTML = '<label>Show Lyrics<input type="checkbox" ' + (checked ? 'checked' : '') + '></label>';
      else if (kind === 'fallback') root.innerHTML = '<div><span>Show Lyrics</span>' + toggle(false) + '</div>';
      else if (kind !== 'missing') root.innerHTML = toggle(true) + (kind === 'ambiguous' ? toggle(true) : '');
      for (const button of root.querySelectorAll('[role=switch]')) button.onclick = () => setTimeout(() => button.setAttribute('aria-checked', button.getAttribute('aria-checked') !== 'true'), 50);
    </script></body></html>`;
}

describe.skipIf(!canRun)('Suno Hook synthetic draft UI in Chrome', () => {
  let fixture;
  let video;
  beforeAll(async () => {
    fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
    video = join(fixture.temp, 'synthetic.mp4');
    await writeFile(video, 'Synthetic upload fixture');
  }, 30000);
  afterAll(() => fixture?.close());

  it.each([
    { kind: 'checkbox', initial: true, wanted: false },
    { kind: 'shadow', initial: false, wanted: true },
    { kind: 'fallback', initial: true, wanted: false },
    { kind: 'ambiguous', initial: true, wanted: false, problem: /multiple Show Lyrics controls/ },
    { kind: 'missing', initial: true, wanted: false, problem: /no unambiguous Show Lyrics label/ },
  ])('drags the visible strip and verifies $kind lyrics without posting', async ({ kind, initial, wanted, problem }) => {
    const context = await fixture.browser.newContext({ viewport: { width: 1000, height: 700 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [], unexpected = [];
    page.on('pageerror', error => errors.push(error.message));
    page.waitForTimeout = async () => { expect(errors).toEqual([]); };
    await context.route('**/*', route => {
      if (route.request().url() === 'https://suno.com/hooks/create' && route.request().resourceType() === 'document') {
        return route.fulfill({ contentType: 'text/html', body: fixtureHtml(kind, initial) });
      }
      unexpected.push(route.request().resourceType());
      return route.abort();
    });
    try {
      const prepare = sunoHookAdapter.prepare(page, { video: { path: video }, songId: ID, title: 'Synthetic song',
        durationSec: 258, startSec: 20, caption: 'Synthetic caption', showLyrics: wanted });
      if (problem) await expect(prepare).rejects.toThrow(problem);
      else {
        expect(await prepare).toMatchObject({ showLyrics: wanted, caption: 'Synthetic caption' });
        const control = page.locator('[role=switch],input[type=checkbox]');
        expect(await control.evaluate(el => el.getAttribute('aria-checked') === 'true' || el.checked === true)).toBe(wanted);
      }
      const state = await page.evaluate(() => ({ at: window.windowAt, points: window.points, drags: window.dragCount, posts: window.publishClicks }));
      expect(Math.abs(state.at - 20)).toBeLessThanOrEqual(1);
      expect(state.drags).toBeGreaterThan(1);
      expect(state.points.every(([x, y]) => x >= 0 && x < 1000 && y >= 150 && y <= 230)).toBe(true);
      expect(state.posts).toBe(0);
      expect(await page.locator('input[type=file]').evaluate(input => input.files[0].name)).toBe('synthetic.mp4');
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 30000);
});
