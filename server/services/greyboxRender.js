import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { PREVIEW_PAGE_CSP } from '../lib/generatedPreviewSandbox.js';
import { greyboxCaptureSettings } from '../lib/greyboxCapture.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';

const clientRoot = fileURLToPath(new URL('../../client/', import.meta.url));
const requireClient = createRequire(new URL('../../client/package.json', import.meta.url));
let bundle;
const renderQueue = createKeyCachedQueue();

// Compile the same viewer on first demand, never at boot. Nothing is served by
// Vite: its in-memory output is staged as the jailed browser's only script.
export function greyboxViewerBundle() {
  bundle ??= (async () => {
    const { build } = await import(pathToFileURL(requireClient.resolve('vite')).href);
    const result = await build({
      configFile: false, envFile: false, publicDir: false, root: clientRoot, logLevel: 'error',
      cacheDir: join(clientRoot, '.cache/vite-greybox'),
      resolve: { conditions: ['module', 'browser', 'production'], dedupe: ['react', 'react-dom', 'three'] },
      oxc: { jsx: { runtime: 'automatic', development: false } },
      define: { 'process.env.NODE_ENV': JSON.stringify('production') },
      build: {
        write: false,
        lib: { entry: join(clientRoot, 'src/components/catalog/GreyboxCapture.jsx'), name: 'GreyboxCapture', formats: ['iife'] },
      },
    });
    const chunks = [result].flat().flatMap((output) => output.output).filter((asset) => asset.type === 'chunk');
    if (chunks.length !== 1 || chunks[0].imports.length || chunks[0].dynamicImports.length) {
      throw new Error('Greybox viewer must be a self-contained bundle');
    }
    return chunks[0].code;
  })().catch((error) => { bundle = undefined; throw error; });
  return bundle;
}

export const GREYBOX_CAPTURE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body,#root{margin:0;width:100%;height:100%}canvas{display:block}</style>
</head><body><div id="root"></div><script src="/viewer.js"></script></body></html>`;

// Each call owns its scratch root and OS-jailed browser. Only these two static
// files and the supplied declarative scene can enter its disposable context.
export const renderGreyboxPng = (scene, shot) => renderQueue('browser', () => capture(scene, shot));

async function capture(scene, shot) {
  const script = await greyboxViewerBundle();
  const { openComposition } = await import('./htmlComposition/browser.js');
  const parent = join(PATHS.data, 'greybox-renders');
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, 'capture-'));
  let page;
  try {
    await writeFile(join(scratch, 'index.html'), GREYBOX_CAPTURE_HTML);
    await writeFile(join(scratch, 'viewer.js'), script);
    page = await openComposition(relative(PATHS.data, scratch), {
      ownedBrowser: true, isolation: 'required', contentSecurityPolicy: PREVIEW_PAGE_CSP,
      signal: AbortSignal.timeout(45_000), lockLoopback: true,
    });
    const { width, height } = greyboxCaptureSettings(shot);
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    const png = await page.evaluate(`globalThis.captureGreybox(${JSON.stringify(scene)}, ${JSON.stringify(shot)})`, 'greybox capture');
    if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,') || png.length > 32 * 1024 * 1024) {
      throw new Error('Greybox viewer did not return a PNG');
    }
    return png.slice('data:image/png;base64,'.length);
  } finally {
    // A failed owned close preserves its evidence and must not report success.
    try { await page?.close(); }
    finally { await rm(scratch, { recursive: true, force: true }); }
  }
}
