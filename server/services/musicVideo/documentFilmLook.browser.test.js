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
});
