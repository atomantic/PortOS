// The page the jailed preview and poster browsers actually load: the host policy,
// audio global and import map must be parsed before any model-written markup.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('code-animation-page-') }));

import { PREVIEW_PAGE_CSP } from '../../lib/generatedPreviewSandbox.js';
import { stageCodeAnimationPage } from './codeAnimationPage.js';

afterAll(() => cleanupTempDataRoots('code-animation-page-'));

const POLICY = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_PAGE_CSP}">`;
let runs = 0;
async function stage(html, options) {
  const { composition } = await stageCodeAnimationPage(`run-${runs++}`, html, options);
  return readFile(join(composition, 'index.html'), 'utf8');
}

describe('stageCodeAnimationPage', () => {
  it('installs the policy and audio global first in a well-formed head', async () => {
    const page = await stage('<!DOCTYPE html><html><head><title>x</title></head><body></body></html>', { audioGlobal: 'AUDIO', audioDataUrl: 'data:audio/mpeg;base64,AA' });
    expect(page).toBe(`<!DOCTYPE html><html><head>${POLICY}<script>window["AUDIO"] = "data:audio/mpeg;base64,AA";</script><title>x</title></head><body></body></html>`);
  });

  it.each([
    '<!-- <head> --><canvas></canvas>',
    '<html data-example="<head>"><body><canvas></canvas></body></html>',
    "<script>const label = '<head>';</script>",
    '<img src="preview.png"><head></head>',
  ])('puts the policy before %s rather than inside it', async (markup) => {
    const page = await stage(`<!DOCTYPE html>${markup}`);
    expect(page).toBe(`<!DOCTYPE html><head>${POLICY}</head>${markup}`);
  });

  it("replaces a policy the page declares with the host's", async () => {
    const page = await stage('<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>');
    expect(page.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(page).toContain(POLICY);
  });

  it('keeps the three.js import map after the policy and ahead of the document', async () => {
    const markup = '<!-- <head> --><script type="module">import "three";</script>';
    const page = await stage(`<!DOCTYPE html>${markup}`);
    expect(page.startsWith(`<!DOCTYPE html><head>${POLICY}<script type="importmap">`)).toBe(true);
    expect(page.endsWith(`</script></head>${markup}`)).toBe(true);
  });

  it('cannot break out of the script tag through the audio data URL', async () => {
    const page = await stage('<!DOCTYPE html><html><head></head></html>', { audioGlobal: 'AUDIO', audioDataUrl: 'data:x"</script><script>alert(1)//' });
    expect(page).toContain('"data:x\\"\\u003c/script>\\u003cscript>alert(1)//"');
  });
});
