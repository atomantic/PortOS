// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright-core', { paths: [
  fileURLToPath(new URL('../../..', import.meta.url)),
  fileURLToPath(new URL('../../../../server', import.meta.url)),
] }));
const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));

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

describe.skipIf(!chrome)('MediaLightbox native video keyboard controls', () => {
  let server;
  let browser;
  let browserTemp;
  let origin;
  beforeAll(async () => {
    browserTemp = await mkdtemp(join(tmpdir(), 'lightbox-chrome-'));
    server = await createServer({
      cacheDir: join(browserTemp, 'vite'),
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
            import '/src/index.css';
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 360;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#547fa2'; ctx.fillRect(0, 0, 640, 360);
            const audio = new AudioContext();
            await audio.resume();
            const oscillator = audio.createOscillator();
            const output = audio.createMediaStreamDestination();
            oscillator.connect(output); oscillator.start();
            const stream = canvas.captureStream(10);
            stream.addTrack(output.stream.getAudioTracks()[0]);
            const chunks = [];
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
            const recorded = new Promise(resolve => { recorder.onstop = resolve; });
            recorder.ondataavailable = event => chunks.push(event.data);
            recorder.start();
            // Several frames plus audio make seek and volume real controls.
            const paint = setInterval(() => ctx.fillRect(0, 0, 640, 360), 50);
            await new Promise(resolve => setTimeout(resolve, 1200));
            recorder.stop(); await recorded;
            clearInterval(paint); stream.getTracks().forEach(track => track.stop());
            oscillator.stop(); await audio.close();
            const clip = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
            const image = canvas.toDataURL();
            function Fixture() {
              const [item, setItem] = useState(null);
              const [index, setIndex] = useState(0);
              const video = { key: 'video:synthetic', kind: 'video', filename: 'synthetic.webm', downloadUrl: clip };
              const images = [0, 1].map(i => ({ key: 'image:synthetic-' + i, kind: 'image', filename: 'synthetic-' + i + '.png', previewUrl: image, prompt: 'Synthetic image ' + i }));
              const showImage = i => { setIndex(i); setItem(images[i]); };
              return React.createElement(React.Fragment, null,
                React.createElement('button', { id: 'opener', onClick: () => setItem(video) }, 'Open video'),
                React.createElement('button', { id: 'gallery', onClick: () => showImage(0) }, 'Open image gallery'),
                React.createElement(MediaLightbox, { item, onClose: () => setItem(null),
                  hasPrevious: item?.kind === 'image' && index > 0,
                  hasNext: item?.kind === 'image' && index < 1,
                  onPrevious: () => showImage(index - 1), onNext: () => showImage(index + 1) })
              );
            }
            createRoot(document.getElementById('root')).render(React.createElement(Fixture));
          `;
        },
        configureServer(vite) {
          vite.middlewares.use('/lightbox-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await vite.transformIndexHtml('/lightbox-test',
              '<div id="root"></div><script type="module" src="/lightbox-fixture.jsx"></script>'));
          });
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    });
    await server.listen();
    origin = server.resolvedUrls.local[0];
    browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
      env: { ...process.env, TMPDIR: browserTemp, TMP: browserTemp, TEMP: browserTemp },
    });
  }, 60000);
  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await server?.close();
      if (browserTemp) await rm(browserTemp, { recursive: true, force: true });
    }
  });

  it.each([false, true])('includes native controls in both directions (fullscreen=%s)', async fullScreen => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    try {
      await page.route('**/api/**', route => route.fulfill({ json: { providers: [], items: [] } }));
      await page.goto(`${origin}lightbox-test`);
      await page.locator('#opener').click();
      const video = page.locator('video');
      await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
      await video.evaluate(v => { v.pause(); v.currentTime = 0; });
      if (fullScreen) await page.getByRole('button', { name: 'Full screen', exact: true }).click();
      const close = page.getByRole('button', { name: 'Close', description: 'Close (Esc)', exact: true });
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
      await page.getByRole('img', { name: 'Synthetic image 0', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Next media' }).click();
      await page.getByRole('img', { name: 'Synthetic image 1', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Previous media' }).click();
      await page.getByRole('img', { name: 'Synthetic image 0', exact: true }).waitFor();
      const close = page.getByRole('button', { name: 'Close', description: 'Close (Esc)', exact: true });
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
});
