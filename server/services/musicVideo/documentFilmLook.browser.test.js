import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { startOwnedBrowserFixture } from '../../test/browserFixture.js';
import { browserSuiteCanRun, resolveTestChrome } from '../../lib/browserSuiteGate.js';
import { filmLookPreset } from '../../lib/filmLook.js';
import { documentRenderInitScripts } from './documentRender.js';

const chrome = resolveTestChrome();
const canRun = browserSuiteCanRun('document shot film look', { Chrome: chrome });

describe.skipIf(!canRun)('document shot film looks in Chrome', () => {
  let fixture, page;
  const project = { filmLook: filmLookPreset('vhs'), scenes: [
    { startSec: 0, endSec: 2 },
    { startSec: 2, endSec: 4, filmLook: filmLookPreset('none') },
    { startSec: 4, endSec: 6, filmLook: filmLookPreset('super8') },
  ] };
  const seek = async t => {
    await page.evaluate(t => globalThis.portosComposition.seek(t), t);
    return page.screenshot({ animations: 'disabled' });
  };
  const look = () => page.evaluate(() => globalThis.__portosFilmLook.look?.preset ?? null);
  beforeAll(async () => {
    fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
    page = await fixture.browser.newPage({ viewport: { width: 320, height: 180 } });
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  it('uses pinned, inherited and clean shots with identical pixels on reverse seeks and preview commands', async () => {
    await page.setContent(`<html><head><style>html,body{margin:0;background:#808080}</style>${documentRenderInitScripts(project).map(source => `<script>${source}</script>`).join('')}</head><body>
      <script>globalThis.portosComposition={fps:30,seek(t){return t;}};</script></body></html>`);
    const inherited = await seek(1);
    expect(await look()).toBe('vhs');
    const clean = await seek(2);
    expect(await look()).toBe(null);
    const pinned = await seek(4.5);
    expect(await look()).toBe('super8');
    expect(clean.equals(inherited)).toBe(false);
    expect(pinned.equals(clean)).toBe(false);
    expect((await seek(1)).equals(inherited)).toBe(true);
    expect((await seek(2)).equals(clean)).toBe(true);
    expect((await seek(4.5)).equals(pinned)).toBe(true);
    await seek(6); // gap/outro returns to the project's look
    expect(await look()).toBe('vhs');
    await seek(4.5);
    await page.evaluate(() => globalThis.__portosFilmLook.apply(null));
    expect(await look()).toBe(null);
    expect((await page.screenshot()).equals(clean)).toBe(true);
    await page.evaluate(() => globalThis.__portosFilmLook.apply({ preset: 'none' }));
    expect(await look()).toBe('super8');
    expect((await page.screenshot()).equals(pinned)).toBe(true);
    await seek(1);
    expect(await look()).toBe('none');
    // Cooperative playback commits through the same frame API without calling seek.
    await page.evaluate(() => globalThis.__portosFilmLook.frame(135));
    expect((await page.screenshot()).equals(pinned)).toBe(true);
  });

  it('installs the finish for shot-only looks when the video itself is clean', async () => {
    await page.goto('about:blank');
    const scripts = documentRenderInitScripts({ scenes: project.scenes });
    expect(scripts).toHaveLength(1);
    await page.setContent(`<html><head>${scripts.map(source => `<script>${source}</script>`).join('')}</head><body><script>globalThis.portosComposition={fps:24,seek(){}};</script></body></html>`);
    await seek(4.5);
    expect(await look()).toBe('super8');
    await seek(1);
    expect(await look()).toBe(null);
  });

  it('matches shot color before the film look and leaves skipped shots and unmatched overlays clean', async () => {
    const cam1 = { id: 'cam1', name: 'Main' };
    const cam2 = { id: 'cam2', name: 'Raw', doNotMatch: true };
    const shot1 = {
      sceneId: 's1',
      startSec: 0,
      endSec: 2,
      shotSheet: { cameraId: 'cam1', location: 'Studio', timeOfDay: 'Day' },
      referenceImageId: 'img1',
      takes: [{
        kind: 'image',
        assetId: 'img1',
        colorMatch: {
          enabled: true,
          strength: 1,
          correction: { black: 0, white: 1.5, gamma: 1, balanceR: 1, balanceB: 1, saturation: 1 },
        },
      }],
    };
    const shot2 = {
      sceneId: 's2',
      startSec: 2,
      endSec: 4,
      shotSheet: { cameraId: 'cam1', location: 'Studio', timeOfDay: 'Day' },
      referenceImageId: 'img2',
      takes: [{
        kind: 'image',
        assetId: 'img2',
        colorMatch: {
          enabled: true,
          strength: 1,
          correction: { black: 0, white: 0.75, gamma: 1, balanceR: 1, balanceB: 1, saturation: 1 },
        },
      }],
    };
    const shot3 = {
      sceneId: 's3',
      startSec: 4,
      endSec: 6,
      shotSheet: { cameraId: 'cam2', location: 'Studio', timeOfDay: 'Day' },
      referenceImageId: 'img3',
      takes: [{
        kind: 'image',
        assetId: 'img3',
        colorMatch: {
          enabled: true,
          strength: 1,
          correction: { black: 0.05, white: 1.3, gamma: 0.9, balanceR: 1, balanceB: 1, saturation: 1 },
        },
      }],
    };
    const shot4 = {
      sceneId: 's4',
      startSec: 6,
      endSec: 8,
      imageEffect: 'flash-develop',
      shotSheet: { cameraId: 'cam1', location: 'Studio', timeOfDay: 'Day' },
      referenceImageId: 'img4',
      takes: [{
        kind: 'image',
        assetId: 'img4',
        colorMatch: {
          enabled: true,
          strength: 1,
          correction: { black: 0.05, white: 1.3, gamma: 0.9, balanceR: 1, balanceB: 1, saturation: 1 },
        },
      }],
    };
    const matchedProject = {
      cameras: [cam1, cam2],
      scenes: [shot1, shot2, shot3, shot4],
    };
    const scripts = documentRenderInitScripts(matchedProject);
    expect(scripts.some((s) => s.includes('__portosColorMatch'))).toBe(true);
    expect(scripts.some((s) => s.includes('portos-color-match-s1'))).toBe(true);
    expect(scripts.some((s) => s.includes('portos-color-match-s2'))).toBe(true);
    expect(scripts.some((s) => s.includes('portos-color-match-s3'))).toBe(false);
    expect(scripts.some((s) => s.includes('portos-color-match-s4'))).toBe(false);

    await page.goto('about:blank');
    await page.setContent(`<html><head><style>html,body{margin:0;background:#000}</style>${scripts.map(s => `<script>${s}</script>`).join('')}</head>
      <body><canvas id="c" width="320" height="180"></canvas>
      <script>
        const c = document.getElementById('c');
        const ctx = c.getContext('2d');
        globalThis.portosComposition = {
          fps: 24,
          seek(t) {
            ctx.clearRect(0, 0, 320, 180);
            ctx.save();
            const sceneId = t < 2 ? 's1' : t < 4 ? 's2' : t < 6 ? 's3' : 's4';
            const filter = globalThis.__portosColorMatch?.filterCss(sceneId);
            if (filter) ctx.filter = filter;
            ctx.fillStyle = t < 2 ? '#646464' : t < 4 ? '#c8c8c8' : '#808080';
            ctx.fillRect(0, 0, 320, 180);
            ctx.restore();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(10, 10, 20, 20);
          }
        };
      </script></body></html>`);

    await page.evaluate(() => globalThis.portosComposition.seek(1));
    const p1 = await page.evaluate(() => Array.from(document.getElementById('c').getContext('2d').getImageData(160, 90, 1, 1).data));
    await page.evaluate(() => globalThis.portosComposition.seek(3));
    const p2 = await page.evaluate(() => Array.from(document.getElementById('c').getContext('2d').getImageData(160, 90, 1, 1).data));
    expect(Math.abs(p1[0] - p2[0])).toBeLessThanOrEqual(3);
    expect(Math.abs(p1[1] - p2[1])).toBeLessThanOrEqual(3);
    expect(Math.abs(p1[2] - p2[2])).toBeLessThanOrEqual(3);

    const lyric1 = await page.evaluate(() => Array.from(document.getElementById('c').getContext('2d').getImageData(15, 15, 1, 1).data));
    expect(lyric1[0]).toBe(255);
    expect(lyric1[1]).toBe(255);
    expect(lyric1[2]).toBe(255);

    expect(await page.evaluate(() => globalThis.__portosColorMatch.filterCss('s3'))).toBeNull();
    expect(await page.evaluate(() => globalThis.__portosColorMatch.filterCss('s4'))).toBeNull();

    const projectOff = {
      ...matchedProject,
      scenes: matchedProject.scenes.map(s => ({
        ...s,
        takes: [{ ...s.takes[0], colorMatch: { ...s.takes[0].colorMatch, enabled: false } }],
      })),
    };
    expect(documentRenderInitScripts(projectOff)).toHaveLength(0);
  });
});
