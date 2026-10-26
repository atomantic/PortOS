// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../scripts/lib/testChrome.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const chrome = resolveTestChrome();
const isolate = origin => route => {
  const url = new URL(route.request().url());
  return url.origin === new URL(origin).origin && !url.pathname.startsWith('/api/') ? route.continue() : route.abort();
};

describe.skipIf(!chrome)('Blender greybox in Chromium', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({ name: 'greybox-glb', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--enable-unsafe-swiftshader'] },
      viteConfig: temp => ({
        configFile: false, cacheDir: join(temp, 'vite-cache'),
        root: fileURLToPath(new URL('../../..', import.meta.url)),
        resolve: { dedupe: ['three'] },
        optimizeDeps: { entries: ['src/components/catalog/GreyboxViewer.jsx'], include: ['react', 'react-dom/client', 'three', 'three/examples/jsm/exporters/GLTFExporter.js', '@react-three/fiber', '@react-three/drei'] },
        plugins: [react(), {
          name: 'greybox-glb-fixture',
          resolveId(id) { if (id === '/greybox-glb-fixture.jsx') return '\0greybox-glb-fixture.jsx'; },
          load(id) {
            if (id !== '\0greybox-glb-fixture.jsx') return;
            return `
              import React, {useRef, useState} from 'react';
              import {createRoot} from 'react-dom/client';
              import {BoxGeometry, Mesh, MeshStandardMaterial, Scene} from 'three';
              import {GLTFExporter} from 'three/examples/jsm/exporters/GLTFExporter.js';
              import GreyboxViewer from '/src/components/catalog/GreyboxViewer.jsx';
              import {blankGreybox} from '/src/lib/greybox.js';
              import '/src/index.css';
              const authored = new Scene();
              const mesh = new Mesh(new BoxGeometry(8, 4, 2), new MeshStandardMaterial({color:'#ff0000', metalness:1, roughness:0}));
              mesh.position.y = 2;
              authored.add(mesh);
              const bytes = await new GLTFExporter().parseAsync(authored, {binary:true});
              const modelSrc = URL.createObjectURL(new Blob([bytes], {type:'model/gltf-binary'}));
              const scene = blankGreybox();
              scene.source = 'glb';
              scene.anchors = [{id:'figure', label:'Example figure', kind:'figure', position:[5,0,0], facingDegrees:0, heightMeters:1.7}];
              scene.landmarks = [{id:'mark', label:'Example landmark', position:[-5,0,0], note:''}];
              scene.shots = [{id:'front', label:'Front', position:[0,2,14], target:[0,2,0], focalLengthMm:35, aspect:'16:9', figures:[]}];
              function Fixture() {
                const ref = useRef(null);
                const [source, setSource] = useState('glb');
                window.capture = () => ref.current?.capture();
                window.view = () => ref.current?.getView();
                window.setSource = setSource;
                return React.createElement(GreyboxViewer, {ref, scene:{...scene,source}, modelSrc, shotView:scene.shots[0], activeShot:scene.shots[0]});
              }
              createRoot(document.getElementById('root')).render(React.createElement(Fixture));
            `;
          },
          configureServer(vite) {
            vite.middlewares.use('/greybox-glb-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/greybox-glb-test', '<div id="root" style="padding:8px"></div><script type="module" src="/greybox-glb-fixture.jsx"></script>'));
            });
          },
        }], server: { host: '127.0.0.1', port: 0 },
      }),
      warmup: async (page, origin) => {
        await page.route('**/*', isolate(origin));
        await page.goto(`${origin}greybox-glb-test`);
        await page.waitForFunction(() => Boolean(window.capture?.()));
      },
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  it('captures real neutral geometry at the saved camera and keeps it through source switches', async () => {
    const page = await fixture.browser.newPage({ viewport: { width: 900, height: 800 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.route('**/*', isolate(fixture.origin));
      await page.goto(`${fixture.origin}greybox-glb-test`);
      await page.waitForFunction(() => Boolean(window.capture?.()));
      await page.getByText('Example figure', { exact: true }).waitFor();
      await page.getByText('Example landmark', { exact: true }).waitFor();
      expect(await page.evaluate(() => window.view())).toEqual({ position: [expect.closeTo(0), expect.closeTo(2), expect.closeTo(14)], target: [0, 2, 0] });
      const pixels = await page.evaluate(async () => {
        const png = await createImageBitmap(await (await fetch(window.capture())).blob());
        const canvas = document.createElement('canvas');
        canvas.width = png.width; canvas.height = png.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(png, 0, 0);
        const bytes = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let neutral = 0; let red = 0;
        for (let i = 0; i < bytes.length; i += 4) {
          const [r,g,b] = bytes.slice(i, i + 3);
          if (r > 60 && Math.max(r,g,b) - Math.min(r,g,b) < 15) neutral++;
          if (r > 80 && r > g * 1.5 && r > b * 1.5) red++;
        }
        return {width:png.width, height:png.height, neutral, red};
      });
      expect(pixels).toMatchObject({ width: 1280, height: 720, red: 0 });
      expect(pixels.neutral).toBeGreaterThan(20000);
      const initial = await page.evaluate(() => window.capture());
      await page.evaluate(() => window.setSource('spec'));
      await page.waitForFunction(initial => window.capture?.() && window.capture() !== initial, initial);
      await page.evaluate(() => window.setSource('glb'));
      await page.waitForFunction(initial => window.capture?.() === initial, initial);
      expect(await page.evaluate(() => window.view())).toEqual({ position: [expect.closeTo(0), expect.closeTo(2), expect.closeTo(14)], target: [0, 2, 0] });
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
});
