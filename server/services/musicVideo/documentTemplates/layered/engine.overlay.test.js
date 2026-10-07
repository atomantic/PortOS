import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { chromium } from 'playwright-core';
import { gateAutoReview } from '../../autoReviewJudge.js';

// The layered engine is a browser template copied into each document, so the overlay
// guard is exercised by evaluating just that helper against a recording fake context.
const engine = readFileSync(new URL('./engine.js', import.meta.url), 'utf8');
const helper = engine.slice(engine.indexOf('  const FOOTAGE_WASH_ALPHA'), engine.indexOf('  // Compare the same camera-transformed footage'));
const W = 1920; const H = 1080;
const footageOverlayContext = new Function('W', 'H', `${helper}\nreturn footageOverlayContext;`)(W, H);

function fakeContext(transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) {
  const calls = [];
  return {
    calls, globalAlpha: 1, fillStyle: '#000', globalCompositeOperation: 'source-over',
    getTransform() { return transform; },
    fillRect(x, y, w, h) { calls.push(['fillRect', w, h, this.globalAlpha]); },
    clearRect(x, y, w, h) { calls.push(['clearRect', w, h]); },
    beginPath() { calls.push(['beginPath']); },
  };
}

describe('layered engine footage overlay guard', () => {
  it('turns a full-canvas fill over footage into a faint wash and drops a full clear', () => {
    const ctx = fakeContext();
    const view = footageOverlayContext(ctx);
    view.fillRect(0, 0, W, H);
    view.clearRect(0, 0, W, H);
    expect(ctx.calls).toEqual([['fillRect', W, H, 0.25]]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('measures the on-canvas area: a mostly off-screen panel passes, a scaled unit fill is caught', () => {
    const ctx = fakeContext();
    footageOverlayContext(ctx).fillRect(-W * 0.8, 0, W, H);
    expect(ctx.calls).toEqual([['fillRect', W, H, 1]]);
    const scaled = fakeContext({ a: W, b: 0, c: 0, d: H, e: 0, f: 0 });
    footageOverlayContext(scaled).fillRect(0, 0, 1, 1);
    expect(scaled.calls).toEqual([['fillRect', 1, 1, 0.25]]);
  });

  it('refuses the copy composite mode and passes everything else through', () => {
    const ctx = fakeContext();
    const view = footageOverlayContext(ctx);
    view.globalCompositeOperation = 'copy';
    expect(ctx.globalCompositeOperation).toBe('source-over');
    view.globalCompositeOperation = 'screen';
    view.globalAlpha = 0.6;
    view.fillStyle = '#fff';
    view.fillRect(10, 10, 200, 100);
    view.clearRect(0, 0, 50, 50);
    view.beginPath();
    expect(ctx.globalCompositeOperation).toBe('screen');
    expect(ctx.fillStyle).toBe('#fff');
    expect(ctx.calls).toEqual([['fillRect', 200, 100, 0.6], ['clearRect', 50, 50], ['beginPath']]);
  });
});

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

describe.skipIf(!chrome)('layered footage review through rendered browser pixels', () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: chrome, headless: true }); }, 30000);
  afterAll(async () => { await browser?.close(); });

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
      await page.addScriptTag({ content: engine });
      return await page.evaluate(async () => {
        await portosComposition.seek(3, { reviewFootage: true });
        return portosComposition.footageVisibility;
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
