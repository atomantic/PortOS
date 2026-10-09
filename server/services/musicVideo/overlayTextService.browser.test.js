/**
 * The overlay text check end to end in a real headless Chrome: a document that
 * draws a corner readout under a big lyric, a pale caption on a pale frame, a
 * line past the right edge, a tiny tag and a DOM caption is staged like a
 * render, probed at its text moments, and each problem comes back once —
 * while a word ringed in a wide ink outline passes on the same pale frame. The
 * shipped layered template (lyricType.js) passes on a pale still, data readout
 * included.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

const chrome = [process.env.CHROME_PATH, chromium.executablePath(), '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((path) => path && existsSync(path));

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('mv-overlay-text-') }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../browserService.js', () => ({ loadConfig: async () => ({ chromePath: chrome }) }));

const { PATHS } = await import('../../lib/paths.js');
const projects = await import('./projects.js');
const { importDocumentDirectory, importDocumentTemplate } = await import('./compositionDocument.js');
const { startOverlayTextCheck } = await import('./overlayTextService.js');
const { productionReadiness } = await import('./productionReview.js');

afterAll(() => cleanupTempDataRoots());

const PAGE = `<!doctype html><html><head><style>
  html, body { margin: 0; background: #f3ead7; }
  canvas { display: block; }
  #dom { position: absolute; left: 860px; top: 300px; color: #ffffff; font: 600 34px sans-serif; }
</style></head><body><canvas id="c" width="1280" height="720"></canvas><div id="dom">DOM CAPTION</div>
<script src="portos-mv.js"></script><script src="app.js"></script></body></html>`;

const APP = `
const ctx = document.getElementById('c').getContext('2d');
function draw() {
  ctx.fillStyle = '#f3ead7'; ctx.fillRect(0, 0, 1280, 720);
  // A corner readout on a plate too short for it, under a big outlined lyric.
  ctx.fillStyle = '#141217'; ctx.fillRect(40, 60, 380, 60);
  ctx.font = '500 40px monospace'; ctx.fillStyle = '#f3ead7'; ctx.fillText('20 MILLION YEARS', 56, 104);
  ctx.font = '900 96px sans-serif'; ctx.lineJoin = 'round'; ctx.lineWidth = 14; ctx.strokeStyle = '#141217';
  ctx.strokeText('WHOLE', 300, 130); ctx.fillStyle = '#f3ead7'; ctx.fillText('WHOLE', 300, 130);
  // Ringed in ink on the pale frame: readable.
  ctx.strokeText('BLOOM', 80, 330); ctx.fillText('BLOOM', 80, 330);
  // Pale on pale, no outline.
  ctx.font = '700 64px sans-serif'; ctx.fillStyle = '#fffaf0'; ctx.fillText('DISAPPEAR', 80, 480);
  // Past the right edge.
  ctx.fillStyle = '#141217'; ctx.fillText('OFF THE EDGE', 1040, 640);
  // Too small for a phone.
  ctx.font = '14px sans-serif'; ctx.fillText('tiny tag', 80, 600);
}
globalThis.portosComposition = { durationSec: 4, fps: 12, width: 1280, height: 720, async seek() { draw(); } };
`;

describe.skipIf(!chrome)('overlay text check (headless Chrome)', () => {
  it('flags each text problem once, names the shot, and passes outlined type', async () => {
    const source = join(PATHS.data, 'overlay-doc');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'index.html'), PAGE);
    await writeFile(join(source, 'app.js'), APP);
    const created = await projects.createProject({ name: 'Overlay', composition: { mode: 'document' } });
    await projects.mutateProjectRecord(created.id, (current) => ({ project: { ...current,
      audioAnalysis: { durationSec: 4, beats: [], downbeats: [], sections: [] },
      lyricCues: [{ id: 'l1', text: 'whole species bloom', startSec: 0.5, endSec: 3, words: [] }] } }));
    await importDocumentDirectory(created.id, 'overlay-doc');

    const started = await startOverlayTextCheck(created.id);
    expect(started.readiness.storyboard.text.status).toBe('running');
    const check = await started.done;
    expect(check.status).toBe('complete');
    expect(check.textSamples).toBeGreaterThan(0);

    const kinds = (text) => check.findings.filter((f) => f.texts.some((t) => t.includes(text))).map((f) => f.kind).sort();
    expect(kinds('20 MILLION YEARS')).toContain('overlap');
    expect(check.findings.find((f) => f.kind === 'overlap').texts).toEqual(expect.arrayContaining(['20 MILLION YEARS', 'WHOLE']));
    expect(kinds('DISAPPEAR')).toEqual(['contrast']);
    expect(kinds('OFF THE EDGE')).toEqual(['off-frame']);
    expect(kinds('tiny tag')).toContain('small');
    expect(kinds('DOM CAPTION')).toEqual(['contrast']);
    expect(kinds('BLOOM')).toEqual([]);
    // One finding per problem however many frames showed it, errors first.
    expect(new Set(check.findings.map((f) => f.id)).size).toBe(check.findings.length);
    expect(check.findings[0].severity).toBe('error');

    const report = productionReadiness(await projects.getProject(created.id)).storyboard.text;
    expect(report).toMatchObject({ status: 'complete', current: true });
    expect(report.counts.errors).toBe(2);
  }, 120000);

  it('passes the shipped layered template: lyricType lines and a data readout on a pale still', async () => {
    const { default: sharp } = await import('sharp');
    await mkdir(PATHS.images, { recursive: true });
    await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#f1ece0' } }).png().toFile(join(PATHS.images, 'pale.png'));
    const created = await projects.createProject({ name: 'Layered', composition: { mode: 'document' } });
    await projects.mutateProjectRecord(created.id, (current) => ({ project: { ...current,
      audioAnalysis: { durationSec: 12, beats: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], downbeats: [1, 5, 9], sections: [{ label: 'Verse', startSec: 0, endSec: 6 }, { label: 'Chorus', startSec: 6, endSec: 12 }] },
      scenes: [{ sceneId: 's1', order: 0, label: 'One', startSec: 0, endSec: 6, textZone: 'lower-left', referenceImageId: 'pale.png' }, { sceneId: 's2', order: 1, label: 'Two', startSec: 6, endSec: 12, textZone: 'upper-right', lyricRole: 'data', referenceImageId: 'pale.png' }],
      lyricCues: [
        { id: 'l1', text: 'whole species bloom and disappear', startSec: 0.5, endSec: 3, words: [] },
        { id: 'l2', text: 'twenty million years a second', startSec: 3.2, endSec: 5.5, words: [] },
        { id: 'l3', text: 'years since launch 764,465', startSec: 6.5, endSec: 9, words: [] },
        { id: 'l4', text: 'welcome to the club', startSec: 9.2, endSec: 11.5, words: [] }] } }));
    await importDocumentTemplate(created.id, 'layered');
    const started = await startOverlayTextCheck(created.id);
    const check = await started.done;
    expect(check).toMatchObject({ status: 'complete', findings: [] });
    expect(check.textSamples).toBeGreaterThan(4);
  }, 120000);
});
