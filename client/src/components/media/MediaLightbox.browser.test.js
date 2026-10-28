// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../scripts/lib/testChrome.js';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [
  fileURLToPath(new URL('../../..', import.meta.url)),
  fileURLToPath(new URL('../../../../server', import.meta.url)),
] }));
const chrome = resolveTestChrome();

async function waitForVideoData(video) {
  await video.evaluate(element => new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(deadline);
      element.removeEventListener('loadeddata', ready);
      element.removeEventListener('error', ready);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => {
      if (element.error) finish(new Error(`Synthetic video failed to decode (code=${element.error.code})`));
      else if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish();
    };
    const deadline = setTimeout(() => finish(new Error(
      `Synthetic video data timed out (readyState=${element.readyState}, networkState=${element.networkState})`,
    )), 30000);
    element.addEventListener('loadeddata', ready);
    element.addEventListener('error', ready);
    ready();
  }));
}

// The document's activeElement stays VIDEO throughout native control traversal.
// CDP reads its user-agent shadow root without changing the player or tab order.
async function nativeFocusReader(page) {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'video' });
  const { node } = await cdp.send('DOM.describeNode', { nodeId, depth: 1, pierce: true });
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: node.shadowRoots[0].backendNodeId });
  return async () => {
    const { result } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function() { return this.activeElement?.getAttribute("pseudo") || null; }',
      returnByValue: true,
    });
    return result.value;
  };
}

// Vitest reports a timeout only as "Test timed out in 60000ms". The clock names
// the phase in flight and what each finished phase cost (#12657); phase names
// are a fixed set, so the line stays bounded.
function phaseClock() {
  const finished = new Map();
  const startedAt = performance.now();
  let current = null;
  return {
    async run(name, work) {
      current = { name, at: performance.now() };
      try {
        return await work();
      } finally {
        const prior = finished.get(name) ?? { count: 0, ms: 0 };
        finished.set(name, { count: prior.count + 1, ms: prior.ms + performance.now() - current.at });
        current = null;
      }
    },
    describe() {
      const done = [...finished].map(([name, { count, ms }]) => `${name} ${count}x ${Math.round(ms)}ms`).join(', ');
      const running = current ? `; in flight: ${current.name} ${Math.round(performance.now() - current.at)}ms` : '';
      return `${Math.round(performance.now() - startedAt)}ms elapsed${running}; finished: ${done || 'none'}`;
    },
  };
}

// Counts only, never URLs or messages. The fixture is static (watcher and HMR
// off, #12230), so one navigation and no reload, page error or failing request
// is the baseline; the client's routine "[vite] connecting/connected" lines are
// not counted.
function countPageEvents(page) {
  const seen = { navigations: 0, pageErrors: 0, viteReloads: 0, httpErrors: 0 };
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) seen.navigations += 1; });
  page.on('pageerror', () => { seen.pageErrors += 1; });
  page.on('console', message => { if (/^\[vite\] (page reload|hot updated|server connection lost)/.test(message.text())) seen.viteReloads += 1; });
  page.on('response', response => { if (response.status() >= 400) seen.httpErrors += 1; });
  return () => Object.entries(seen).map(([name, count]) => `${name}=${count}`).join(' ');
}

const REACHABLE_VIEWPORTS = [[360, 640], [390, 667], [360, 800], [768, 1024], [1440, 900]];

describe.skipIf(!chrome)('MediaLightbox native video keyboard controls', () => {
  let browser;
  let fixture;
  let origin;
  beforeAll(async () => {
    // Each startup phase is bounded and cleaned up inside the hook (#10543).
    fixture = await startBrowserFixture({ name: 'lightbox-chrome', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] }, viteConfig: temp => ({
      cacheDir: join(temp, 'vite'),
      // Pre-bundle only what this fixture renders, not the whole app's graph.
      optimizeDeps: { entries: ['src/components/media/MediaLightbox.jsx'], include: ['react', 'react-dom/client'] },
      configFile: false,
      root: fileURLToPath(new URL('../../..', import.meta.url)),
      plugins: [react(), {
        name: 'lightbox-browser-fixture',
        resolveId(id) { if (id === '/lightbox-fixture.jsx') return '\0lightbox-fixture.jsx'; },
        load(id) {
          if (id.endsWith('/src/services/socket.js')) return 'export default { on() {}, off() {} };';
          if (id !== '\0lightbox-fixture.jsx') return;
          return `
            import React, { useState } from 'react';
            import { createRoot } from 'react-dom/client';
            import MediaLightbox from '/src/components/media/MediaLightbox.jsx';
            import MediaCard from '/src/components/media/MediaCard.jsx';
            import clip from '/src/test/fixtures/lightbox-controls.webm?url';
            import '/src/index.css';
            import { getTheme } from '/src/themes/portosThemes.js';
            const theme = getTheme(new URLSearchParams(location.search).get('theme') || 'classic-midnight');
            for (const [key, value] of Object.entries({ ...theme.colors, ...theme.tokens })) document.documentElement.style.setProperty(key, value);
            document.documentElement.dataset.portTheme = theme.id;
            document.documentElement.dataset.portThemeFamily = theme.family;
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 360;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#547fa2'; ctx.fillRect(0, 0, 640, 360);
            const image = canvas.toDataURL();
            function Fixture() {
              const [item, setItem] = useState(null);
              const [index, setIndex] = useState(0);
              const video = { id: 'synthetic', key: 'video:synthetic', kind: 'video', filename: 'synthetic.webm', downloadUrl: clip, previewUrl: image, prompt: 'Synthetic video' };
              const images = [0, 1].map(i => ({ key: 'image:synthetic-' + i, kind: 'image', downloadUrl: image, filename: 'synthetic-' + i + '.png', previewUrl: image, prompt: 'Synthetic image ' + i, width: 1600, height: 900, model: 'Synthetic model', seed: 123 }));
              const noop = async () => {};
              const showImage = i => { setIndex(i); setItem(images[i]); };
              return React.createElement(React.Fragment, null,
                React.createElement('button', { id: 'opener', onClick: () => setItem(video) }, 'Open video'),
                React.createElement('div', { id: 'cards', className: 'grid grid-cols-2 md:grid-cols-4 gap-4 p-4' }, images.map(image => React.createElement(MediaCard, { key: image.key, item: image, onRemix: noop, onSendToImage: noop, onSendToVideo: noop, onSendTo3d: noop, onAnnotate: noop, onToggleStar: noop, onDelete: noop }))),
                new URLSearchParams(location.search).has('missingPoster') && React.createElement('div', { id: 'fallback-card', style: { width: 250 } },
                  React.createElement(MediaCard, { item: { ...video, previewUrl: '/data/video-thumbnails/unavailable.jpg' }, showCollectionMenu: false, showMoodBoardMenu: false })),
                new URLSearchParams(location.search).has('peerImages') && ['working', 'unavailable'].map(name =>
                  React.createElement('div', { id: name + '-image-card', key: name, style: { width: 250 } },
                    React.createElement(MediaCard, { item: { ...images[0], filename: name + '.png', previewUrl: '/data/images/' + name + '.png', thumbnailUrl: '/data/image-thumbnails/' + name + '.webp' }, showCollectionMenu: false, showMoodBoardMenu: false }))),
                React.createElement('button', { id: 'gallery', onClick: () => showImage(0) }, 'Open image gallery'),
                React.createElement(MediaLightbox, { item, onClose: () => setItem(null),
                  hasPrevious: item?.kind === 'image' && index > 0,
                  hasNext: item?.kind === 'image' && index < 1,
                  onPrevious: () => showImage(index - 1), onNext: () => showImage(index + 1),
                  onPromptChange: noop, onAnnotationChange: noop, annotation: { note: 'Synthetic note' },
                  onRemix: noop, onSendToImage: noop, onSendToVideo: noop, onSendTo3d: noop,
                  onClean: noop, onRegenerate: noop, regenAvailable: true, onRemoveWatermark: noop,
                  onRefine: noop, onPromptFrom: noop, onContinue: noop, onPosterChange: noop })
              );
            }
            createRoot(document.getElementById('root')).render(React.createElement(Fixture));
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/lightbox-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/lightbox-test',
              '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/lightbox-fixture.jsx"></script>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    }) });
    ({ browser, origin } = fixture);
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it('decodes a video frame in a card when the hosted poster times out', async () => {
    const page = await browser.newPage();
    try {
      await page.route('**/data/video-thumbnails/unavailable.jpg', route => route.fulfill({ status: 502 }));
      await page.goto(`${origin}lightbox-test?missingPoster=1`);
      const video = page.locator('#fallback-card video');
      await waitForVideoData(video);
      const pixel = await video.evaluate(element => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.drawImage(element, 0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      });
      expect(pixel[2]).toBeGreaterThan(100);
      expect(pixel[3]).toBe(255);
      expect(await page.locator('#fallback-card').getByText('Syncing').count()).toBe(0);
    } finally {
      await page.close();
    }
  });

  it('decodes a peer image thumbnail or its original after a thumbnail timeout', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    const paths = [];
    let pageErrors = 0;
    page.on('pageerror', () => { pageErrors += 1; });
    onTestFailed(() => console.error(`Image fallback fixture failed: requests=${paths.length}, pageErrors=${pageErrors}`));
    try {
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 2;
        canvas.getContext('2d').fillRect(0, 0, 2, 2);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      await page.route(/^https?:\/\/[^/]+\/data\/(image-thumbnails|images)\//, route => {
        const path = new URL(route.request().url()).pathname;
        paths.push(path);
        if (path === '/data/image-thumbnails/unavailable.webp') return route.fulfill({ status: 502 });
        return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(png, 'base64') });
      });
      await page.goto(`${origin}lightbox-test?peerImages=1`);
      const working = page.locator('#working-image-card img');
      const fallback = page.locator('#unavailable-image-card img');
      await working.waitFor({ timeout: 5000 });
      await working.scrollIntoViewIfNeeded();
      await working.evaluate(image => image.decode());
      await fallback.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('#unavailable-image-card img')?.getAttribute('src') === '/data/images/unavailable.png', null, { timeout: 5000 });
      await fallback.evaluate(image => image.decode());
      expect(await working.getAttribute('src')).toBe('/data/image-thumbnails/working.webp');
      expect(await fallback.getAttribute('src')).toBe('/data/images/unavailable.png');
      expect(paths).toContain('/data/image-thumbnails/unavailable.webp');
      expect(paths).toContain('/data/images/unavailable.png');
      expect(await page.getByText('Syncing').count()).toBe(0);
      expect(pageErrors).toBe(0);
    } finally {
      await page.close();
    }
  });

  it.each([false, true])('includes native controls in both directions (fullscreen=%s)', async fullScreen => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.route('**/api/**', route => route.fulfill({ json: { providers: [], items: [] } }));
      await page.goto(`${origin}lightbox-test`);
      await page.locator('#opener').click();
      const video = page.locator('video');
      await waitForVideoData(video);
      expect(await video.evaluate(v => Number.isFinite(v.duration) && v.duration > 0)).toBe(true);
      expect(await video.evaluate(v => [v.videoWidth, v.videoHeight])).toEqual([640, 360]);
      await video.evaluate(v => { v.pause(); v.currentTime = 0; });
      if (fullScreen) await page.getByRole('button', { name: 'Full screen', exact: true }).click();
      const close = page.locator('button[title="Close (Esc)"]');
      await close.focus();
      await page.keyboard.press('Tab');
      expect(await video.evaluate(v => v === document.activeElement)).toBe(true);
      const readNativeFocus = await nativeFocusReader(page);
      const fullScreenButton = page.getByRole('button', { name: fullScreen ? 'Exit full screen' : 'Full screen', exact: true });
      const forward = [await readNativeFocus()];
      for (let i = 0; i < 12; i += 1) {
        await page.keyboard.press('Tab');
        expect(await page.getByRole('dialog').evaluate(el => el.contains(document.activeElement))).toBe(true);
        if (await fullScreenButton.evaluate(el => el === document.activeElement)) break;
        expect(await video.evaluate(v => v === document.activeElement)).toBe(true);
        const control = await readNativeFocus();
        forward.push(control);
        if (control === '-webkit-media-controls-play-button') {
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => !document.querySelector('video').paused);
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.querySelector('video').paused);
        }
        if (control === '-webkit-media-controls-volume-slider') {
          const volume = await video.evaluate(v => v.volume);
          await page.keyboard.press('ArrowLeft');
          expect(await video.evaluate(v => v.volume)).toBeLessThan(volume);
        }
      }
      expect(await fullScreenButton.evaluate(el => el === document.activeElement)).toBe(true);
      expect(forward).toContain('-webkit-media-controls-play-button');
      expect(forward).toContain('-webkit-media-controls-volume-slider');
      expect(forward).toContain('-webkit-media-controls-timeline');
      // Reverse traversal must visit the same native stops in reverse order,
      // including the host stop, then return to Close without leaving the trap.
      const reverse = [];
      for (let i = 0; i < forward.length; i += 1) {
        await page.keyboard.press('Shift+Tab');
        expect(await video.evaluate(v => v === document.activeElement)).toBe(true);
        reverse.push(await readNativeFocus());
      }
      expect(reverse).toEqual([...forward].reverse());
      await page.keyboard.press('Shift+Tab');
      expect(await close.evaluate(el => el === document.activeElement)).toBe(true);
      // Boundary wrapping still works around the whole lightbox.
      await page.keyboard.press('Shift+Tab');
      expect(await page.getByRole('dialog').evaluate(el => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Tab');
      expect(await close.evaluate(el => el === document.activeElement)).toBe(true);
      if (fullScreen) {
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Full screen', exact: true }).waitFor();
        expect(await page.getByRole('dialog').count()).toBe(1);
      }
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]') && document.activeElement.id === 'opener');
    } finally {
      await page.close();
    }
  }, 60000);

  it('preserves image gallery navigation and restores focus after the fullscreen Escape cascade', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.route('**/api/**', route => route.fulfill({ json: { providers: [], items: [] } }));
      await page.goto(`${origin}lightbox-test`);
      await page.locator('#gallery').click();
      await page.getByRole('dialog').getByRole('img', { name: 'Synthetic image 0', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Next media' }).click();
      await page.getByRole('dialog').getByRole('img', { name: 'Synthetic image 1', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Previous media' }).click();
      await page.getByRole('dialog').getByRole('img', { name: 'Synthetic image 0', exact: true }).waitFor();
      const close = page.locator('button[title="Close (Esc)"]');
      await close.focus();
      await page.keyboard.press('Tab');
      expect(await page.getByRole('button', { name: 'Full screen', exact: true }).evaluate(el => el === document.activeElement)).toBe(true);
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Exit full screen' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Full screen', exact: true }).waitFor();
      expect(await page.getByRole('dialog').count()).toBe(1);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]') && document.activeElement.id === 'gallery');
    } finally {
      await page.close();
    }
  }, 60000);

  it.each([[360, 568], [360, 640], [390, 667], [360, 800]])('keeps phone navigation inside media and settings Close clickable at %dx%d', async (width, height) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.route('**/api/**', route => route.fulfill({ json: { providers: [], items: [] } }));
      await page.goto(`${origin}lightbox-test`);
      await page.locator('#gallery').click();
      const media = page.getByRole('dialog').locator(':scope > div > div').first();
      const assertInsideMedia = async locator => {
        const box = await locator.boundingBox();
        const surface = await media.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(surface.x - 1);
        expect(box.y).toBeGreaterThanOrEqual(surface.y - 1);
        expect(box.x + box.width).toBeLessThanOrEqual(surface.x + surface.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(surface.y + surface.height + 1);
      };
      const clickAtCenter = async locator => {
        const box = await locator.boundingBox();
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        expect(await page.evaluate(({ x, y, name }) => document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label') === name,
          { x, y, name: await locator.getAttribute('aria-label') })).toBe(true);
        await page.mouse.click(x, y);
      };

      const close = page.locator('aside header button[aria-label="Close"]');
      await clickAtCenter(close);
      await page.getByRole('dialog').waitFor({ state: 'detached' });

      await page.locator('#gallery').click();
      const next = page.getByRole('button', { name: 'Next media' });
      await assertInsideMedia(next);
      await clickAtCenter(next);
      await page.getByRole('dialog').getByRole('img', { name: 'Synthetic image 1', exact: true }).waitFor();
      const previous = page.getByRole('button', { name: 'Previous media' });
      await assertInsideMedia(previous);
      await clickAtCenter(previous);
      await page.getByRole('dialog').getByRole('img', { name: 'Synthetic image 0', exact: true }).waitFor();
    } finally {
      await page.close();
    }
  }, 60000);

  // This catches footer-induced body collapse using real CSS rectangles, not
  // class names. All media and callbacks are synthetic and requests intercepted.
  // One case per theme and viewport, like the cases around it: the combined loop
  // held ~1,300 browser round trips in a single 60s budget, so a loaded host
  // overran it with no single stalled phase (#12657).
  it.each(['classic-midnight', 'kestrel-neon'].flatMap(theme => REACHABLE_VIEWPORTS.map(([width, height]) => [theme, width, height])))(
    'keeps settings and image/video actions reachable in %s at %dx%d', async (theme, width, height) => {
      const phases = phaseClock();
      const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
      const pageEvents = countPageEvents(page);
      onTestFailed(() => console.error(`❌ lightbox ${theme} ${width}x${height} failed after ${phases.describe()}; ${pageEvents()}`));
      try {
        await page.route('**/api/**', route => route.fulfill({ json: { providers: [], items: [] } }));
        await phases.run('goto', () => page.goto(`${origin}lightbox-test?theme=${theme}`));
        for (const opener of ['#gallery', '#opener']) {
          await phases.run('open', () => page.locator(opener).click());
          const aside = page.locator('aside');
          const prompt = aside.locator('#media-prompt');
          await phases.run('fill', () => prompt.fill('Synthetic multiline prompt\nSecond invented line\nThird invented line'));
          await phases.run('reach', async () => {
            const scroll = aside.locator('header + div');
            const roomy = width >= 640 && height >= 800;
            const body = roomy ? scroll.locator(':scope > div') : scroll;
            const bounds = await body.boundingBox();
            expect(bounds.height, `${width}x${height} editing region`).toBeGreaterThan(120);
            const header = await aside.locator('header').boundingBox();
            const assertReachable = async locator => {
              await locator.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
              const rect = await locator.boundingBox();
              const viewport = await body.boundingBox();
              // Roomy footers sit outside the body scroller by design.
              if (!(roomy && await locator.evaluate(el => !!el.closest('footer')))) {
                expect(rect.y).toBeGreaterThanOrEqual(viewport.y - 1);
                expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
              }
              const close = await aside.getByRole('button', { name: 'Close', exact: true }).boundingBox();
              expect(close.y).toBeGreaterThanOrEqual(0);
              expect(close.y + close.height).toBeLessThanOrEqual(height);
              expect((await aside.locator('header').boundingBox()).y).toBeCloseTo(header.y);
              const card = await aside.evaluate(el => el.parentElement.getBoundingClientRect().toJSON());
              expect(card.y).toBeGreaterThanOrEqual(0);
              expect(card.bottom).toBeLessThanOrEqual(height);
            };
            await assertReachable(prompt);
            await assertReachable(aside.getByRole('button', { name: 'Save prompt' }));
            for (const control of await aside.locator('footer button, footer a, button:has-text("Save prompt")').all()) {
              const rect = await control.boundingBox();
              expect(rect.height).toBeGreaterThanOrEqual(44);
              expect(rect.width).toBeGreaterThanOrEqual(44);
            }
            const fullScreen = await page.getByRole('button', { name: 'Full screen', exact: true }).boundingBox();
            expect(fullScreen.width).toBeGreaterThanOrEqual(44);
            expect(fullScreen.height).toBeGreaterThanOrEqual(44);
            await assertReachable(aside.getByRole('textbox', { name: 'Note' }));
            for (const control of await aside.locator('footer button, footer a').all()) await assertReachable(control);
            if (!roomy) expect(await scroll.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
          });
          // Pointer overlap from gallery arrows is tracked independently in #10690.
          await phases.run('dismiss', async () => {
            await page.keyboard.press('Escape');
            await page.getByRole('dialog').waitFor({ state: 'detached' });
          });
        }
      } finally {
        await phases.run('teardown', () => page.close());
      }
    }, 60000);

  // Real card/menu primitives catch shrinking flex targets and neighboring hits.
  it.each([[360, 800], [768, 1024], [1440, 900]])('gives touch media actions independent 44px targets at %dx%d', async (width, height) => {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: true, isMobile: true });
    let writes = 0;
    try {
      await page.route('**/api/**', route => {
        if (route.request().method() !== 'GET') writes += 1;
        return route.fulfill({ json: [{ id: 'synthetic', name: 'Synthetic organization', items: [] }] });
      });
      await page.goto(`${origin}lightbox-test`);
      const card = page.locator('#cards > div').first();
      for (const control of await card.locator('button, a').all()) {
        await control.scrollIntoViewIfNeeded();
        const rect = await control.boundingBox();
        expect(rect.width).toBeGreaterThanOrEqual(44);
        expect(rect.height).toBeGreaterThanOrEqual(44);
        const cardRect = await card.boundingBox();
        expect(rect.x).toBeGreaterThanOrEqual(cardRect.x);
        expect(rect.x + rect.width).toBeLessThanOrEqual(cardRect.x + cardRect.width);
        expect(await control.evaluate(el => {
          const r = el.getBoundingClientRect();
          return [-16, 16].every(offset => el.contains(document.elementFromPoint(r.x + r.width / 2 + offset, r.y + r.height / 2)));
        })).toBe(true);
      }
      expect(await card.getByRole('button', { name: 'Remix' }).innerText()).toBe('Remix');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const name of ['Add to collection', 'Pin to mood board']) {
        const trigger = card.getByRole('button', { name, exact: true });
        await trigger.click();
        const row = page.getByRole('button', { name: 'Synthetic organization', exact: true });
        await row.waitFor();
        expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(43.99);
        await row.focus();
        await page.keyboard.press('Escape');
        await row.waitFor({ state: 'detached' });
        expect(await trigger.evaluate(el => document.activeElement === el)).toBe(true);
      }
      await card.getByRole('button', { name: 'Delete', exact: true }).click();
      await card.getByText('Delete this image?').waitFor();
      expect(writes).toBe(0);
    } finally {
      await page.close();
    }
  }, 60000);

});
