import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import express from 'express';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { startOwnedBrowserFixture } from '../../test/browserFixture.js';
import { browserSuiteCanRun } from '../../lib/browserSuiteGate.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { filmLookPreset } from '../../lib/filmLook.js';
import { buildLyricPlaythroughPreview } from './lyricPlaythrough.js';

const client = resolve(import.meta.dirname, '../../../client');
// Bundled StoryboardAnimatic.jsx exercises musicVideoFrameCapture.js and FrameStepper.jsx.
// These source references are the fixture's CI dependency contract: generated JSX has no static import edge.
const requireClient = createRequire(join(client, 'package.json'));
let bundlers;
try { bundlers = ['vite', '@vitejs/plugin-react', '@tailwindcss/postcss'].map((name) => requireClient.resolve(name)); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
const chrome = [process.env.CHROME_PATH, chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => path && existsSync(path));
const ffmpeg = await findFfmpeg();
const canRun = browserSuiteCanRun('animatic frame capture', { Chrome: chrome, ffmpeg, 'client dependencies': bundlers });

const still = { sceneId: 'still', order: 0, label: 'Example still', startSec: 0, endSec: 4, visualLayer: 'still', referenceImageId: 'grid.png', stillMove: 'hold' };
const project = (scenes = [still], extra = {}) => ({ id: 'capture-fixture', name: 'Example capture', scenes, composition: { mode: 'composed' }, ...extra });
let dir, server, fixture, page, lyricProject;
const errors = [];
afterAll(async () => {
  await fixture?.close();
  if (server) await new Promise((done) => server.close(done));
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!canRun)('saved storyboard pixels in a real browser', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-animatic-capture-'));
    await symlink(join(client, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Animatic from ${JSON.stringify(join(client, 'src/components/musicVideo/StoryboardAnimatic.jsx'))};import toast,{Toaster}from ${JSON.stringify(join(client, 'src/components/ui/Toast.jsx'))};
window.uploads=[];window.captureErrors=[];const report=toast.error;toast.error=(message,...args)=>{window.captureErrors.push(message);return report(message,...args)};const realFetch=window.fetch;window.fetch=async(url,options)=>{if(url==='/api/image-gen/upload'){window.uploads.push(Array.from(new Uint8Array(await options.body.get('file').arrayBuffer())));return Response.json({filename:'synthetic.png'});}return realFetch(url,options)};
window.gateCaptureOnce=()=>{const decode=Image.prototype.decode;window.captureDecodePending=false;let release;const pending=new Promise(done=>{release=done});window.releaseCapture=release;Image.prototype.decode=function(){Image.prototype.decode=decode;window.captureDecodePending=true;return pending.then(()=>decode.call(this))}};
function App(){const[state,setState]=useState(null);window.show=(project,t)=>{window.captureErrors=[];setState({project,seek:{t,n:(window.seq=(window.seq||0)+1)}})};return <><main style={{width:642}}>{state&&<Animatic project={state.project} audioUrl='/song.wav' seekRequest={state.seek}/>}</main><Toaster/></>};createRoot(document.getElementById('root')).render(<App/>);`;
    await writeFile(join(dir, 'entry.jsx'), `import ${JSON.stringify(join(client, 'src/index.css'))};\n${entry}`);
    await writeFile(join(dir, 'index.html'), '<html><head></head><body style="margin:0"><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    const { build } = await import(bundlers[0]);
    const { default: react } = await import(bundlers[1]);
    const { default: tailwind } = await import(bundlers[2]);
    await build({ configFile: false, root: dir, publicDir: join(client, 'public'), plugins: [react()], css: { postcss: { plugins: [tailwind({ base: client })] } }, build: { outDir: join(dir, 'dist'), emptyOutDir: true }, logLevel: 'warn' });
    const grid = '<svg width="1200" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="400" fill="#164080"/><rect width="200" height="400" fill="#ff3010"/><rect x="400" width="200" height="400" fill="#20dd50"/><rect x="1000" width="200" height="400" fill="#f5cf10"/><circle cx="650" cy="100" r="50" fill="white"/></svg>';
    await sharp(Buffer.from(grid)).png().toFile(join(dir, 'grid.png'));
    await sharp({ create: { width: 200, height: 400, channels: 3, background: '#ff00ff' } }).png().toFile(join(dir, 'end.png'));
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=cyan:s=120x240:r=24:d=4', '-c:v', 'libvpx', join(dir, 'clip.webm')]);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', join(dir, 'song.wav')]);
    const app = express();
    app.get('/data/images/:id', (req, res) => res.sendFile(join(dir, req.params.id)));
    app.get('/api/video-gen/history/:id', (req, res) => res.json({ id: req.params.id, filename: 'clip.webm', fps: 24, numFrames: 96, width: 120, height: 240 }));
    app.get('/api/music-video/:id/stats-outro', (req, res) => res.json({ stats: { shots: 2, stills: { made: 3, kept: 1 }, clips: { made: 2, kept: 1 }, floorImages: [] } }));
    app.get('/api/music-video/:id/lyrics/overlay/preview', async (req, res, next) => {
      try { res.json(await buildLyricPlaythroughPreview(lyricProject, { overlay: true })); }
      catch (error) { next(error); }
    });
    app.get('/data/videos/clip.webm', (req, res) => res.sendFile(join(dir, 'clip.webm')));
    app.get('/song.wav', (req, res) => res.sendFile(join(dir, 'song.wav')));
    app.use(express.static(join(dir, 'dist')));
    server = await new Promise((done) => { const listener = app.listen(0, '127.0.0.1', () => done(listener)); });
    fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
    page = await fixture.browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => typeof window.show === 'function');
  }, 30000);

  const show = async (value, t) => {
    await page.evaluate(({ value, t }) => { window.uploads = []; window.show(value, t); }, { value, t });
    await page.waitForFunction((t) => Math.abs(document.querySelector('audio')?.currentTime - t) < 0.00001, t);
    await page.waitForFunction(() => [...document.querySelectorAll('figure img')].every((image) => image.complete && image.naturalWidth > 0));
  };
  const capture = async (label = '', { decodedVideoReference = false } = {}) => {
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.uploads.length > 0 || window.captureErrors.length > 0);
    expect(await page.evaluate(() => window.captureErrors), label).toEqual([]);
    const saved = Buffer.from(await page.evaluate(() => window.uploads.at(-1)));
    const picture = page.getByLabel('Storyboard animatic', { exact: true }).locator(':scope > div').first();
    if (decodedVideoReference) await picture.evaluate((root) => {
      // Chrome's native VIDEO display and Canvas2D currently convert source colors
      // differently (tracked in #11630). Compare framing/effects to decoded pixels through the actual
      // CSS layout, retaining the native-display discrepancy as separate evidence.
      window.restoreVideoReference = [];
      for (const video of root.querySelectorAll('video[data-ready="true"]:not([aria-hidden="true"])')) {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        canvas.className = video.className; canvas.style.cssText = video.style.cssText;
        video.replaceWith(canvas);
        window.restoreVideoReference.push(() => canvas.replaceWith(video));
      }
    });
    // Global notification chrome is outside the video frame being saved.
    let displayed;
    try { displayed = await picture.screenshot({ style: '[data-toast-id]{visibility:hidden}' }); }
    finally {
      if (decodedVideoReference) await page.evaluate(() => window.restoreVideoReference.forEach((restore) => restore()));
    }
    const a = await sharp(saved).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(displayed).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([a.info.width, a.info.height]).toEqual([b.info.width, b.info.height]);
    let difference = 0, opaque = 0;
    for (let i = 0; i < a.data.length; i += 1) {
      difference += Math.abs(a.data[i] - b.data[i]);
      if (i % 4 === 3 && a.data[i] === 255) opaque += 1;
    }
    expect(difference / a.data.length, label).toBeLessThan(1);
    expect(opaque).toBe(a.info.width * a.info.height);
    return saved;
  };

  it('saves actual cover crops and camera endpoints for asymmetric push/pan stills', async () => {
    for (const move of ['hold', 'push', 'pan']) {
      await show(project([{ ...still, stillMove: move }]), 0);
      const first = await capture();
      await show(project([{ ...still, stillMove: move }]), 4 - 1 / 24);
      const last = await capture();
      expect(Buffer.compare(first, last) === 0).toBe(move === 'hold');
    }
    expect(errors).toEqual([]);
  });

  it('saves decoded footage with black, still, fill and VHS fitting while ignoring hidden preloads', async () => {
    for (const frameFit of ['black', 'still', 'fill', 'vhs']) {
      await show(project([{ ...still, visualLayer: 'footage', videoHistoryId: 'clip', frameFit },
        { ...still, sceneId: 'next', order: 1, startSec: 4, endSec: 8, visualLayer: 'footage', videoHistoryId: 'preloaded' }]), 1);
      await page.waitForFunction(() => document.querySelector('video[data-ready="true"]:not([aria-hidden="true"])')?.seeking === false);
      await capture(frameFit, { decodedVideoReference: true });
    }
  });

  it('saves end-frame effects, flash/develop, incoming dissolves and fade-black in their displayed order', async () => {
    for (const [effect, t] of [['end-fade', 1.3], ['end-fade', 3], ['flash-develop', 0.1], ['flash-develop', 1]]) {
      await show(project([{ ...still, imageEffect: effect, imageEffectSec: 1, endImageId: 'end.png', stillMove: 'pan' }]), t);
      await capture();
    }
    await show(project([{ ...still, cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { ...still, sceneId: 'next', order: 1, startSec: 4, endSec: 8, referenceImageId: 'end.png', stillMove: 'push' }]), 3.5);
    await capture();
    await show(project([{ ...still, cutEffect: { style: 'fade-black', enabled: true, overlapSec: 1 } }]), 3.8);
    await capture();
  });

  it('captures the exact paused film-look filter after freezing a newer audio clock across a shot boundary', async () => {
    const look = filmLookPreset('vhs');
    await show(project([still, { ...still, sceneId: 'next', startSec: 4, endSec: 8, order: 1, referenceImageId: 'end.png' }], { filmLook: look }), 3);
    await page.evaluate(() => {
      const audio = document.querySelector('audio');
      audio.currentTime = 4.5;
      audio.dispatchEvent(new Event('play'));
    });
    const styled = await capture();
    expect(await page.locator('[data-film-look="exact"]').count()).toBe(1);
    expect(await page.locator('figure img').first().getAttribute('src')).toBe('/data/images/end.png');
    await page.getByRole('button', { name: 'Film look', exact: true }).click();
    await page.evaluate(() => { window.uploads = []; });
    const clean = await capture();
    expect(Buffer.compare(styled, clean)).not.toBe(0);
  });

  it('captures the opaque lyric and title canvases only after the requested song seek completes', async () => {
    const extra = { audioAnalysis: { durationSec: 8 }, lyricCues: [{ id: 'line', text: 'EXAMPLE WORDS', startSec: 1, endSec: 4 }],
      titleCard: { enabled: true, title: 'Example title', artist: 'Example artist', startSec: 0, endSec: 5 } };
    lyricProject = project([{ ...still, referenceImageId: null }], extra);
    await show(project([still], extra), 2);
    const frame = page.frameLocator('iframe');
    await frame.locator('#stage').waitFor();
    const withWords = await capture();
    await page.getByRole('button', { name: 'Lyrics', exact: true }).click();
    await page.evaluate(() => { window.uploads = []; });
    const withoutWords = await capture();
    expect(Buffer.compare(withWords, withoutWords)).not.toBe(0);
  });

  it('rejects a loading video-only shot without uploading a blank or a preloaded frame', async () => {
    await page.route('**/data/videos/clip.webm', (route) => route.abort());
    await show(project([{ ...still, referenceImageId: null, visualLayer: 'footage', videoHistoryId: 'loading' }]), 1);
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureErrors.length > 0);
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Video frame is still loading');
    await page.unroute('**/data/videos/clip.webm');
  });

  it('freezes the displayed outro canvas and exact look before capture', async () => {
    await show(project([still], { statsOutro: { enabled: true, durationSec: 8 }, filmLook: filmLookPreset('polaroid') }), 1);
    const look = page.getByRole('button', { name: 'Film look', exact: true });
    if (await look.getAttribute('aria-pressed') === 'false') await look.click();
    await page.getByRole('button', { name: 'Ending', exact: true }).click();
    await page.getByTestId('animatic-stats-outro').waitFor();
    await page.evaluate(() => document.fonts.ready);
    const saved = await capture();
    expect(await page.locator('[data-film-look="exact"]').count()).toBe(1);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.evaluate(() => { window.uploads = []; });
    expect(Buffer.compare(saved, await capture())).toBe(0);
  });

  it('rejects a project change or late outro statistics while async frame rasterization is pending', async () => {
    await show(project(), 1);
    await page.evaluate(() => window.gateCaptureOnce());
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureDecodePending);
    await show(project([{ ...still, referenceImageId: 'end.png' }]), 1);
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => window.captureErrors.length > 0);
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Preview changed during capture');

    let pendingStats;
    await page.route('**/api/music-video/*/stats-outro', (route) => { pendingStats = route; });
    await show(project([still], { statsOutro: { enabled: true, durationSec: 8 } }), 1);
    await page.getByRole('button', { name: 'Ending', exact: true }).click();
    await page.getByTestId('animatic-stats-outro').waitFor();
    await page.evaluate(() => window.gateCaptureOnce());
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureDecodePending);
    expect(pendingStats).toBeTruthy();
    await pendingStats.fulfill({ json: { stats: { shots: 9, floorImages: [] } } });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => window.captureErrors.length > 0);
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Preview changed during capture');
    await page.unroute('**/api/music-video/*/stats-outro');
  });
});
