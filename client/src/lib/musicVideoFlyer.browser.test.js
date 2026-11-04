// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { resolveTestChrome } from '../../../scripts/lib/testChrome.js';
import { buildFlyerHtml, resolveFlyer } from './musicVideoFlyer.js';

const chrome = resolveTestChrome();
const CREDITS = ['Starring the pups', 'Directed by Example Person', 'Music by Example Band', 'Animation by Example Studio', 'Thanks to everyone', 'Filmed on location', 'Human directed. Human imagined.'].join('\n');

// Uniquely catches printed content clipped off the letter sheet (.page hides overflow) or text
// colliding with the credits: the QR must give way to the text, not the other way round.
describe.skipIf(!chrome)('printed flyer layout in Chromium', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: chrome }); });
  afterAll(async () => { await browser?.close(); });

  it.each(['full', 'half'])('fits a title, tagline, label and seven credit lines on the %s layout without an image', async (layout) => {
    const flyer = resolveFlyer({ name: 'Example Song', publishKit: { flyer: { layout, image: 'none', byline: 'Example Artist', tagline: 'Coming soon to streaming.', details: CREDITS } } }, { youtubeUrl: 'https://youtu.be/AbCdEf12345' });
    const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
    await page.setContent(buildFlyerHtml(flyer));
    const sheets = await page.evaluate(() => [...document.querySelectorAll('.page')].map((sheet) => {
      const bottom = sheet.getBoundingClientRect().bottom - parseFloat(getComputedStyle(sheet).paddingBottom);
      const blocks = [...sheet.querySelectorAll('.info > *, .scan, .details')].map((el) => el.getBoundingClientRect());
      const details = sheet.querySelector('.details').getBoundingClientRect();
      return {
        overflowPx: Math.max(...blocks.map((r) => r.bottom)) - bottom,
        clash: [...sheet.querySelectorAll('.info > *, .scan')].some((el) => el.getBoundingClientRect().bottom > details.top + 0.5),
        qrIn: sheet.querySelector('.qr').getBoundingClientRect().width / 96,
      };
    }));
    await page.close();
    expect(sheets).toHaveLength(layout === 'half' ? 2 : 1);
    for (const sheet of sheets) {
      expect(sheet.overflowPx).toBeLessThanOrEqual(0.5);
      expect(sheet.clash).toBe(false);
      expect(sheet.qrIn).toBeGreaterThan(2.5);
    }
  });
});
