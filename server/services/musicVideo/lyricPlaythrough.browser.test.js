import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { startOwnedBrowserFixture } from '../../test/browserFixture.js';
import { browserSuiteCanRun, resolveTestChrome } from '../../lib/browserSuiteGate.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-lyric-playthrough-browser-'),
}));

const { buildLyricPlaythroughPreview } = await import('./lyricPlaythrough.js');
const { NETWORK_FREEZE_SCRIPT } = await import('../htmlComposition/browser.js');

const chrome = resolveTestChrome();
const canRun = browserSuiteCanRun('lyric playthrough browser', { Chrome: chrome });
const words = (text, start) => text.split(' ').map((w, i) => ({ w, startSec: start + i * 0.4, endSec: start + i * 0.4 + 0.35, conf: 'matched' }));

// Uniquely catches the preview bootstrap throwing on the composition host's
// frozen network constructors, which left the timing playthrough blank.
describe.skipIf(!canRun)('lyric timing playthrough page (browser pixels)', () => {
  let browserFixture;
  beforeAll(async () => {
    browserFixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
  }, 30000);
  afterAll(async () => { await browserFixture?.close(); cleanupTempDataRoots(); });

  it('draws the sung words under the host network freeze', async () => {
    const preview = await buildLyricPlaythroughPreview({
      id: 'mv-example', name: 'Example Song', audioAnalysis: { durationSec: 30, bpm: 120, sections: [] },
      lyricCues: [{ id: 'c1', text: 'walking through the static', startSec: 4, endSec: 6, words: words('walking through the static', 4) }],
      lyricMarkers: [], scenes: [], lyricOverlayEnabled: false,
    });
    const page = await browserFixture.browser.newPage({ viewport: { width: preview.width, height: preview.height } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.addInitScript(`(() => { const report = () => {}; ${NETWORK_FREEZE_SCRIPT} })()`);
      await page.route('https://composition.invalid/**', (route) => route.fulfill({ contentType: 'text/html', body: preview.html }));
      await page.goto('https://composition.invalid/index.html');
      const seeked = page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => resolve('no answer'), 5000);
        addEventListener('message', (event) => {
          if (event.data?.type === 'portos-mv:seeked' || event.data?.type === 'portos-mv:error') resolve(event.data.type);
        });
      }));
      await page.evaluate(() => {
        window.postMessage({ type: 'portos-mv:manifest', keys: [] }, '*');
        window.postMessage({ type: 'portos-mv:seek', t: 5 }, '*');
      });
      expect(await seeked).toBe('portos-mv:seeked');
      const bright = await page.evaluate(() => {
        const canvas = document.getElementById('stage');
        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 150 && data[i + 1] > 150 && data[i + 2] > 150) count++;
        return count;
      });
      expect(errors).toEqual([]);
      expect(bright).toBeGreaterThan(1000);
    } finally { await page.close(); }
  }, 30000);
});
