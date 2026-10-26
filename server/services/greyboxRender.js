import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { PATHS } from '../lib/fileUtils.js';
import { PREVIEW_PAGE_CSP } from '../lib/generatedPreviewSandbox.js';
import { greyboxCaptureSettings } from '../lib/greyboxCapture.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { getGreyboxCapturePage } from './greyboxCapturePage.js';

const renderQueue = createKeyCachedQueue();

// Each call owns its scratch root and OS-jailed browser. Only these two static
// files and the supplied declarative scene can enter its disposable context.
export const renderGreyboxPng = (scene, shot) => renderQueue('browser', () => capture(scene, shot));

async function capture(scene, shot) {
  const { html, script } = await getGreyboxCapturePage();
  const { openComposition } = await import('./htmlComposition/browser.js');
  const parent = join(PATHS.data, 'greybox-renders');
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, 'capture-'));
  let page;
  try {
    await writeFile(join(scratch, 'index.html'), html);
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
