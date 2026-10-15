import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { chromium } from 'playwright-core';
import { browserSuiteCanRun } from '../../../../lib/browserSuiteGate.js';
import { startOwnedBrowserFixture } from '../../../../test/browserFixture.js';
import { gateAutoReview } from '../../autoReviewJudge.js';

const engine = readFileSync(new URL('./engine.js', import.meta.url), 'utf8');
const lyricType = readFileSync(new URL('../shared/lyricType.js', import.meta.url), 'utf8');

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));
const canRun = browserSuiteCanRun('layered overlay browser', { Chrome: chrome });

describe.skipIf(!canRun)('layered footage review through rendered browser pixels', () => {
  let browser, browserFixture;
  beforeAll(async () => {
    browserFixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
    browser = browserFixture.browser;
  }, 30000);
  afterAll(async () => { await browserFixture?.close(); });

  async function composed(source, flat = false) {
    const page = await browser.newPage();
    try {
      await page.setContent('<canvas id="stage"></canvas>');
      await page.evaluate(({ source, flat }) => {
        const texture = document.createElement('canvas'); texture.width = 320; texture.height = 180;
        const c = texture.getContext('2d');
        for (let y = 0; y < 180; y += 4) for (let x = 0; x < 320; x += 4) {
          c.fillStyle = flat ? '#336699' : ((x + y) % 8 ? '#2581da' : '#edc75f'); c.fillRect(x, y, 4, 4);
        }
        window.PORTOS_MV = { render: { width: 320, height: 180, fps: 24, durationSec: 8 }, song: {},
          scenes: [{ sceneId: 'synthetic-shot', startSec: 0, endSec: 8, visualLayer: 'footage', media: { kind: 'image', src: texture.toDataURL() } }] };
        window.PORTOS_MV_GENERATED = { song: { sections: [{ id: 'opening', startSec: 0, endSec: 8 }] },
          sections: { opening: new Function('ctx', 'env', source) } };
      }, { source, flat });
      await page.addScriptTag({ content: lyricType, type: 'module' });
      await page.waitForFunction(() => globalThis.PORTOS_LYRIC_TYPE);
      await page.addScriptTag({ content: engine });
      return await page.evaluate(async () => {
        await globalThis.portosComposition.seek(3, { reviewFootage: true });
        return globalThis.portosComposition.footageVisibility;
      });
    } finally { await page.close(); }
  }
  const review = (sample) => gateAutoReview({
    parsed: { checks: { composition: 'pass', continuity: 'pass', motion: 'pass' }, findings: [] },
    analysis: { ok: true, spanSec: 8, avDriftSec: 0, freezes: [] },
    evidence: { temporal: { status: 'not-applicable', shots: [] }, footageVisibility: [{ ...sample, status: 'measured', atSec: 3 }] },
  });

  it('keeps the reported 48% panel translucent over actual transformed footage', async () => {
    const sample = await composed('ctx.fillStyle="#070b25"; ctx.fillRect(env.width*.1,env.height*.2,env.width*.8,env.height*.6);');
    expect(sample.visibleFraction).toBeGreaterThan(0.8);
    expect(review(sample).verdict).toBe('pass');
  });

  it('blocks a mostly opaque path even when the model passes with zero findings', async () => {
    const sample = await composed('ctx.fillStyle="#070b25"; ctx.beginPath(); ctx.rect(0,0,env.width*.8,env.height); ctx.fill();');
    expect(sample.hiddenFraction).toBeGreaterThan(0.65);
    const result = review(sample);
    expect(result.verdict).toBe('revise');
    expect(result.findings).toContainEqual(expect.objectContaining({ atSec: 3, severity: 'blocking', failureCategory: 'composition', source: 'analysis' }));
    expect(result.findings[0].note).toContain('Footage hidden');
  });

  it('allows a translucent styled path and stays inconclusive for a solid source', async () => {
    const translucent = await composed('ctx.globalAlpha=.25; ctx.fillStyle="#a02050"; ctx.beginPath(); ctx.rect(0,0,env.width,env.height); ctx.fill();');
    expect(review(translucent).verdict).toBe('pass');
    const flat = await composed('ctx.fillStyle="#070b25"; ctx.beginPath(); ctx.rect(0,0,env.width,env.height); ctx.fill();', true);
    expect(flat.measuredFraction).toBe(0);
    expect(review(flat).verdict).toBe('inconclusive');
    expect(review(flat).findings).toEqual([]);
  });
});
