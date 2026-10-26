import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { startOwnedBrowserFixture } from '../test/browserFixture.js';
import { createOwnedFixtureSetup } from '../test/ownedFixtureSetup.js';
import { browserSuiteCanRun, resolveClientBundler, resolveTestChrome } from '../lib/browserSuiteGate.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { greyboxSceneSchema } from '../lib/greyboxScene.js';
import { greyboxCaptureSettings } from '../lib/greyboxCapture.js';

vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('portos-greybox-render-') }));
vi.mock('./browserService.js', () => ({ loadConfig: async () => ({ chromePath: resolveTestChrome() }) }));

const root = fileURLToPath(new URL('../../', import.meta.url));
const client = join(root, 'client');
const requireClient = createRequire(join(client, 'package.json'));
const chrome = resolveTestChrome();
const canRun = browserSuiteCanRun('Greybox capture parity', { Chrome: chrome, clientBundler: resolveClientBundler(root) });
// As with previewIsolation.egress.test.js, the real OS-jail proof runs only on
// hosts providing its mechanism. Other hosts still run browser pixel parity.
const isolatedHost = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
  || process.platform === 'linux' && existsSync('/usr/bin/bwrap');
const { greyboxViewerBundle, GREYBOX_CAPTURE_HTML, renderGreyboxPng } = await import('./greyboxRender.js');
const scene = greyboxSceneSchema.parse({
  parts: [
    { id: 'floor', type: 'box', size: [12, 0.1, 10], position: [0, -0.05, 0] },
    { id: 'column', type: 'cylinder', radius: 0.6, height: 3, position: [-2, 1.5, 0] },
    { id: 'stage', type: 'extrude', outline: [[-2, -2], [2, -2], [1, 1], [-1, 1]], height: 0.8, position: [2, 0, -2] },
  ],
  anchors: [{ id: 'figure', label: 'Example figure', kind: 'figure', position: [1, 0, 2] }],
  landmarks: [{ id: 'pin', label: 'Hidden helper', position: [0, 2, 0] }],
  shots: [{ id: 'wide', label: 'Wide', position: [8, 6, 12], target: [0, 1, 0], focalLengthMm: 28, aspect: '16:9' }],
});

describe.skipIf(!canRun)('greybox captures in real Chrome', () => {
  let fixture;
  let server;
  let script;
  const setup = createOwnedFixtureSetup({ cleanup: async () => {
    try {
      const outcomes = await Promise.allSettled([fixture?.close(), server?.close()]);
      const failures = outcomes.filter((r) => r.status === 'rejected').map((r) => r.reason);
      if (failures.length) throw new AggregateError(failures, 'Greybox fixture cleanup failed');
    } finally { cleanupTempDataRoots(); }
  } });
  beforeAll(() => setup.run(async (phase) => {
    const { createServer } = await import(pathToFileURL(requireClient.resolve('vite')).href);
    const { default: react } = await import(pathToFileURL(requireClient.resolve('@vitejs/plugin-react')).href);
    await phase('vite', async () => {
      server = await createServer({
        configFile: false, root: client, cacheDir: join(lazyTempDataRoot('portos-greybox-render-'), 'vite-cache'),
        optimizeDeps: { entries: ['src/components/catalog/GreyboxCapture.jsx'], include: ['react', 'react-dom/client', 'three', '@react-three/fiber', '@react-three/drei'] },
        plugins: [react(), { name: 'greybox-fixture', configureServer(server) {
          server.middlewares.use('/greybox-test', async (_req, res) => {
            res.setHeader('Content-Type', 'text/html');
            res.end(await server.transformIndexHtml('/greybox-test', GREYBOX_CAPTURE_HTML.replace('<script src="/viewer.js"></script>', '<script type="module" src="/src/components/catalog/GreyboxCapture.jsx"></script>')));
          });
        } }],
        server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
      });
      await server.listen();
    });
    await phase('browser', async () => { fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } }); });
    script = await phase('bundle', greyboxViewerBundle);
  }));
  afterAll(() => setup.close());

  it('matches interactive source and standalone capture pixels across lenses and landscape/portrait frames', async () => {
    expect(script).not.toContain(root);
    const captures = [];
    for (const [aspect, focalLengthMm] of [['16:9', 28], ['9:16', 50], ['21:9', 18]]) {
      const shot = { ...scene.shots[0], aspect, focalLengthMm };
      const tab = await fixture.browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
      const standalone = await fixture.browser.newPage({ viewport: { width: 600, height: 500 } });
      try {
        await tab.goto(`${server.resolvedUrls.local[0]}greybox-test`);
        await tab.waitForFunction(() => typeof globalThis.captureGreybox === 'function');
        const inTab = await tab.evaluate(({ scene, shot }) => globalThis.captureGreybox(scene, shot), { scene, shot });
        await standalone.setContent(GREYBOX_CAPTURE_HTML.replace('<script src="/viewer.js"></script>', ''));
        await standalone.addScriptTag({ content: script });
        const headless = await standalone.evaluate(({ scene, shot }) => globalThis.captureGreybox(scene, shot), { scene, shot });
        const reference = await sharp(Buffer.from(inTab.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true });
        const actual = await sharp(Buffer.from(headless.split(',')[1], 'base64')).raw().toBuffer({ resolveWithObject: true });
        const { width, height } = greyboxCaptureSettings(shot);
        expect({ width: actual.info.width, height: actual.info.height }).toEqual({ width, height });
        expect(actual.info).toEqual(reference.info);
        const meanError = actual.data.reduce((sum, value, index) => sum + Math.abs(value - reference.data[index]), 0) / actual.data.length;
        // Allow GPU antialias rounding: mean absolute channel error <= 1/255.
        expect(meanError).toBeLessThanOrEqual(1);
        const colors = new Set();
        for (let i = 0; i < actual.data.length; i += actual.info.channels) colors.add(actual.data.subarray(i, i + 3).toString('hex'));
        expect(colors.size).toBeGreaterThan(20);
        captures.push(headless);
      } finally { await tab.close(); await standalone.close(); }
    }
    expect(new Set(captures).size).toBe(3);
  });

  it.skipIf(!isolatedHost)('renders with the production OS jail and no Greybox tab, then removes its scratch files', async () => {
    const data = await renderGreyboxPng(scene, scene.shots[0]);
    const { width, height } = await sharp(Buffer.from(data, 'base64')).metadata();
    expect({ width, height }).toEqual({ width: 1280, height: 720 });
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(lazyTempDataRoot('portos-greybox-render-'), 'greybox-renders'))).toEqual([]);
  });
});
