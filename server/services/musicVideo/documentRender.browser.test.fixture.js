/** Real Chrome, synthetic data, and owned capture cleanup for both document render suites. */
import { afterAll, beforeAll, beforeEach, expect, it as vitestIt, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from '../../lib/childProcess.js';
import { createDocumentRenderBrowserFixture } from './testDocumentRenderBrowserFixture.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../../lib/mockPathsDataRoot.js';
import { chromeWithH264, resolveTestChrome } from '../../lib/browserSuiteGate.js';

const testBodies = ownTestBodies(vitestIt);
export const { it } = testBodies;
const lifecycle = vi.hoisted(() => ({ ownedChildren: [], chromeProcess: null, fixtureWritersSettled: false, endpoint: null }));
vi.mock('../../lib/childProcess.js', async original => {
  const actual = await original();
  return { ...actual, spawn(...args) {
    const child = actual.spawn(...args);
    const arg = args[1]?.find?.(value => value.startsWith('--user-data-dir=') && value.includes('portos-composition-browser-'));
    if (arg) {
      const owned = { profile: arg.slice('--user-data-dir='.length), closed: false };
      child.once('close', () => { owned.closed = true; });
      lifecycle.ownedChildren.push(owned);
    }
    return child;
  } };
});
export const ownedChildren = lifecycle.ownedChildren;
export const testDeadline = { signal: undefined };

// This suite measures encoder pixels; the actual operator boundary is exercised in musicVideoProductionReview.browser.test.js.
vi.mock('./productionReview.js', async original => ({ ...await original(), assertProductionApproval: () => {} }));

vi.mock('../htmlComposition/encode.js', async importOriginal => {
  const actual = await importOriginal();
  const { _withTestCaptureDiagnostics } = await import('../htmlComposition/testBrowserCleanup.js');
  return { ...actual, encodeComposition: _withTestCaptureDiagnostics(actual.encodeComposition, { getTestSignal: () => testDeadline.signal }) };
});

beforeEach(({ signal }) => { testDeadline.signal = signal; });

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-browser-'),
}));

export { cleanupTempDataRoots };

const { findFfmpeg } = await import('../../lib/ffmpeg.js');
const { _testBrowserCleanupSettled, _testChromeCaptureArgs } = await import('../htmlComposition/testBrowserCleanup.js');

afterAll(() => {
  if (!lifecycle.chromeProcess || (lifecycle.fixtureWritersSettled && _testBrowserCleanupSettled(lifecycle.chromeProcess))) cleanupTempDataRoots();
});

const chrome = resolveTestChrome();
export const mockCaptureBrowserService = () => ({
  loadConfig: async () => ({ chromePath: chrome }),
  cdpRequest: vi.fn(path => fetch(`${lifecycle.endpoint}${path}`)),
});
export const refuseCompositionVideoPublication = () => { throw new Error('Document render fixture must not publish composition videos'); };

export const ffmpeg = await findFfmpeg();
// Imported discovery helpers can initialize mocked paths even on a skip.
export const prerequisites = { 'Chrome with H.264': await chromeWithH264(chrome), ffmpeg };

export const near = (actual, expected, tolerance) => actual.forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThan(tolerance));

export let browser, PATHS, encodeDocumentComposition, prepareDocumentRender, importDocumentTemplate;
export let buildDocumentPreview, PREVIEW_MEDIA_BUDGET_BYTES, projects;

export function useDocumentRenderBrowserFixture() {
  const { openFixture, closeFixture } = createDocumentRenderBrowserFixture(lifecycle);
  beforeAll(async () => {
    // Keep collection read-only when Chrome/ffmpeg prerequisites skip the suite.
    ({ PATHS } = await import('../../lib/paths.js'));
    const renderer = await import('./documentRender.js');
    ({ prepareDocumentRender } = renderer);
    // The test deadline owns staging, Chrome, capture and muxing together.
    // An encoder-only signal leaves Chrome alive when Vitest times out.
    encodeDocumentComposition = options => renderer.encodeDocumentComposition({
      ...options, signal: AbortSignal.any([options.signal, testDeadline.signal].filter(Boolean)),
    });
    ({ importDocumentTemplate } = await import('./compositionDocument.js'));
    ({ buildDocumentPreview, PREVIEW_MEDIA_BUDGET_BYTES } = await import('./documentPreview.js'));
    projects = await import('./projects.js');
    const profile = join(PATHS.data, 'chrome-test-profile');
    const proc = spawn(chrome, _testChromeCaptureArgs(profile), { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
    browser = await openFixture(proc);
  }, 30000);
  afterAll(async () => {
    try {
      await testBodies.drain();
      for (const owned of ownedChildren) {
        expect(owned.closed, `owned capture child closed before fixture teardown`).toBe(true);
        expect(existsSync(owned.profile), `owned capture profile removed before fixture teardown`).toBe(false);
      }
      lifecycle.fixtureWritersSettled = true;
    } finally { await closeFixture(); }
  }, 35000);
}
