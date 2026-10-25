import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { startOwnedBrowserFixture } from '../../test/browserFixture.js';
import { createTestPhaseDiagnostics } from '../../test/testPhaseDiagnostics.js';
import { createOwnedFixtureSetup } from '../../test/ownedFixtureSetup.js';
import { browserSuiteCanRun, resolveTestChrome, resolveClientBundler } from '../../lib/browserSuiteGate.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { filmLookPreset } from '../../lib/filmLook.js';
import { buildLyricPlaythroughPreview } from './lyricPlaythrough.js';

// Bundled StoryboardAnimatic.jsx exercises musicVideoFrameCapture.js and FrameStepper.jsx.
// These source references are the fixture's CI dependency contract: generated JSX has no static import edge.
const client = resolve(import.meta.dirname, '../../../client');
const bundlers = resolveClientBundler(resolve(client, '..'));
const chrome = resolveTestChrome();
const ffmpeg = await findFfmpeg();
const canRun = browserSuiteCanRun('animatic frame capture', { Chrome: chrome, ffmpeg, 'client dependencies': bundlers });

const still = { sceneId: 'still', order: 0, label: 'Example still', startSec: 0, endSec: 4, visualLayer: 'still', referenceImageId: 'grid.png', stillMove: 'hold' };
const project = (scenes = [still], extra = {}) => ({ id: 'capture-fixture', name: 'Example capture', scenes, composition: { mode: 'composed' }, ...extra });
let dir, server, fixture, page, lyricProject, ffmpegVersion;
const colorReferences = new Map();
const colorYuvReferences = new Map();
const chartColors = [[0, 255, 255], [255, 0, 255], [255, 255, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0]];
const chartRgb = (x, y, frame) => {
  if (y < 120) return chartColors[Math.floor(x / 60)];
  const gray = Math.floor(x / 30) * 17;
  return y < 200 ? [gray, gray, gray] : frame % 2 ? [230, 40, 190] : [frame * 2, 255 - frame * 2, frame];
};
const errors = [];
const setup = createOwnedFixtureSetup({ cleanup: async () => {
  // A failed browser close must not leave the HTTP listener open.
  const outcomes = await Promise.allSettled([fixture?.close(), server && new Promise((done, reject) => server.close(error => error ? reject(error) : done()))]);
  // The generated workspace is independent of the owned browser profile.
  outcomes.push(...await Promise.allSettled([dir && rm(dir, { recursive: true, force: true })]));
  const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
  if (failures.length) throw new AggregateError(failures, 'Animatic fixture cleanup failed');
} });
afterAll(() => setup.close());

describe.skipIf(!canRun)('saved storyboard pixels in a real browser', () => {
  beforeAll(() => setup.run(async phase => {
    ffmpegVersion = await phase('ffmpeg-version', timeout => execFileSync(ffmpeg, ['-version'], { timeout, killSignal: 'SIGKILL', encoding: 'utf8' }).split('\n')[0]);
    await phase('workspace', async () => {
      dir = await mkdtemp(join(tmpdir(), 'portos-animatic-capture-'));
      await symlink(join(client, 'node_modules'), join(dir, 'node_modules'), 'dir');
      const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Animatic from ${JSON.stringify(join(client, 'src/components/musicVideo/StoryboardAnimatic.jsx'))};import toast,{Toaster}from ${JSON.stringify(join(client, 'src/components/ui/Toast.jsx'))};
window.uploads=[];window.captureErrors=[];const report=toast.error;toast.error=(message,...args)=>{window.captureErrors.push(message);return report(message,...args)};const realFetch=window.fetch;window.fetch=async(url,options)=>{if(url==='/api/image-gen/upload'){window.uploads.push(Array.from(new Uint8Array(await options.body.get('file').arrayBuffer())));return Response.json({filename:'synthetic.png'});}return realFetch(url,options)};
const filterRevision=root=>{const filter=root?.querySelector('filter');return filter?[filter,...filter.querySelectorAll('*')].map(el=>[el.localName,[...el.attributes].filter(a=>a.name!=='style'&&!a.name.startsWith('xmlns')).map(a=>[a.name,a.value]).sort()]):null};
window.previewMetadata=()=>{
  const root=document.querySelector('figure')?.firstElementChild;
  const box=root?.getBoundingClientRect();
  return {songTime:document.querySelector('audio')?.currentTime,songFrame:Math.round((document.querySelector('audio')?.currentTime||0)*24),
    box:box&&[box.width,box.height],look:root?.dataset.filmLook,filterFrame:root?.dataset.filmLookFrame,
    filterSize:[root?.dataset.filmLookWidth,root?.dataset.filmLookHeight],filter:filterRevision(root),
    videos:[...document.querySelectorAll('video[data-preview-video]')].map(v=>({label:v.getAttribute('aria-label'),
      source:new URL(v.currentSrc||v.src,location.href).pathname.split('/').pop(),time:v.currentTime,pausedFrame:v.dataset.pausedFrame,
      seeking:v.seeking,readyState:v.readyState,opacity:getComputedStyle(v.parentElement).opacity,
      canvasVisible:getComputedStyle(v.nextElementSibling).visibility,canvasSize:[v.nextElementSibling.width,v.nextElementSibling.height]}))};
};
window.gateCaptureOnce=(hold=true)=>{
  const decode=Image.prototype.decode;
  window.captureDecodePending=false;
  window.captureFrozen=null;window.captureSerialized=null;
  let release;
  const pending=new Promise(done=>{release=done});
  window.releaseCapture=release;
  Image.prototype.decode=function(){
    Image.prototype.decode=decode;
    window.captureFrozen=window.previewMetadata();
    const doc=new DOMParser().parseFromString(decodeURIComponent(this.src.slice(this.src.indexOf(',')+1)),'image/svg+xml');
    const root=doc.querySelector('[data-film-look]');
    window.captureSerialized={filter:filterRevision(doc),filterFrame:root?.dataset.filmLookFrame,
      filterSize:[root?.dataset.filmLookWidth,root?.dataset.filmLookHeight]};
    window.captureDecodePending=true;
    if(!hold) release();
    return pending.then(()=>decode.call(this));
  };
};
function App(){const[state,setState]=useState(null);window.show=(project,t)=>{window.fixtureScenes=project.scenes;window.captureErrors=[];setState({project,seek:{t,n:(window.seq=(window.seq||0)+1)}})};return <><main style={{width:642}}>{state&&<Animatic project={state.project} audioUrl='/song.wav' seekRequest={state.seek}/>}</main><Toaster/></>};createRoot(document.getElementById('root')).render(<App/>);`;
      await writeFile(join(dir, 'entry.jsx'), `import ${JSON.stringify(join(client, 'src/index.css'))};\n${entry}`);
      await writeFile(join(dir, 'index.html'), '<html><head></head><body style="margin:0"><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    });
    await phase('bundle', async () => {
      const { build } = await import(bundlers[0]);
      const { default: react } = await import(bundlers[1]);
      const { default: tailwind } = await import(bundlers[2]);
      await build({ configFile: false, root: dir, publicDir: join(client, 'public'), plugins: [react()], css: { postcss: { plugins: [tailwind({ base: client })] } }, build: { outDir: join(dir, 'dist'), emptyOutDir: true }, logLevel: 'warn' });
    });
    await phase('still-images', async () => {
      const grid = '<svg width="1200" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="400" fill="#164080"/><rect width="200" height="400" fill="#ff3010"/><rect x="400" width="200" height="400" fill="#20dd50"/><rect x="1000" width="200" height="400" fill="#f5cf10"/><circle cx="650" cy="100" r="50" fill="white"/></svg>';
      await sharp(Buffer.from(grid)).png().toFile(join(dir, 'grid.png'));
      await sharp({ create: { width: 200, height: 400, channels: 3, background: '#ff00ff' } }).png().toFile(join(dir, 'end.png'));
    });
    // Tiny fixtures use one codec thread; host-wide defaults can dominate setup.
    await phase('clip-encode', timeout => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=cyan:s=120x240:r=24:d=4', '-c:v', 'libvpx', '-threads', '1', join(dir, 'clip.webm')], { timeout, killSignal: 'SIGKILL' }));
    // RGB chart -> explicit limited-range YUV matrix, never a metadata-only retag.
    const frames = await phase('chart-rgb', () => {
      const frames = Buffer.alloc(480 * 240 * 3 * 96);
      for (let f = 0; f < 96; f++) for (let y = 0; y < 240; y++) for (let x = 0; x < 480; x++) {
        const rgb = chartRgb(x, y, f);
        const offset = ((f * 240 + y) * 480 + x) * 3;
        for (let c = 0; c < 3; c++) frames[offset + c] = rgb[c];
      }
      return frames;
    });
    for (const matrix of ['smpte170m', 'bt709']) {
      const path = join(dir, `${matrix}.webm`);
      await phase(`${matrix}-encode`, timeout => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '480x240', '-framerate', '24', '-i', 'pipe:0',
        '-vf', `scale=out_color_matrix=${matrix}:out_range=tv,format=yuv420p`, '-colorspace', matrix, '-color_primaries', matrix, '-color_trc', matrix, '-color_range', 'tv',
        '-c:v', 'libvpx-vp9', '-threads', '1', '-crf', '4', '-b:v', '2M', path], { timeout, killSignal: 'SIGKILL', input: frames }));
      // Retain RGB as diagnostic evidence. CPU/GPU browser conversion need not
      // match FFmpeg RGB; raw decoded YUV independently verifies the source.
      const rgb = await phase(`${matrix}-rgb-decode`, timeout => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-vf', `scale=in_color_matrix=${matrix}:in_range=tv:out_range=pc,format=rgb24`,
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout, killSignal: 'SIGKILL', maxBuffer: frames.length + 1024 }));
      colorReferences.set(matrix, rgb);
      colorYuvReferences.set(matrix, await phase(`${matrix}-yuv-decode`, timeout => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'],
        { timeout, killSignal: 'SIGKILL', maxBuffer: frames.length + 1024 })));
    }
    await phase('audio-encode', timeout => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', join(dir, 'song.wav')], { timeout, killSignal: 'SIGKILL' }));
    await phase('http-server', async () => {
      const app = express();
      app.get('/data/images/:id', (req, res) => res.sendFile(join(dir, req.params.id)));
      app.get('/api/video-gen/history/:id', (req, res) => res.json({ id: req.params.id, filename: colorReferences.has(req.params.id) ? `${req.params.id}.webm` : 'clip.webm', fps: 24, numFrames: 96, width: 120, height: 240 }));
      app.get('/api/music-video/:id/stats-outro', (req, res) => res.json({ stats: { shots: 2, stills: { made: 3, kept: 1 }, clips: { made: 2, kept: 1 }, floorImages: [] } }));
      app.get('/api/music-video/:id/lyrics/overlay/preview', async (req, res, next) => {
        try { res.json(await buildLyricPlaythroughPreview(lyricProject, { overlay: true })); }
        catch (error) { next(error); }
      });
      app.get('/data/videos/:name', (req, res) => res.sendFile(join(dir, req.params.name)));
      app.get('/song.wav', (req, res) => res.sendFile(join(dir, 'song.wav')));
      app.use(express.static(join(dir, 'dist')));
      await new Promise((done, reject) => {
        server = app.listen(0, '127.0.0.1', done);
        server.once('error', reject);
      });
    });
    await phase('browser-acquire', async () => {
      fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true, args: ['--force-color-profile=srgb'] } });
    });
    await phase('page-acquire', async () => {
      page = await fixture.browser.newPage({ viewport: { width: 1000, height: 800 } });
      page.on('pageerror', (error) => errors.push(error.message));
    });
    await phase('navigation', () => page.goto(`http://127.0.0.1:${server.address().port}`));
    await phase('readiness', () => page.waitForFunction(() => typeof window.show === 'function'));
  }), 30000);

  let phase, captureEvidence, caseNumber = 0;
  beforeEach(({ onTestFailed }) => {
    phase = createTestPhaseDiagnostics(onTestFailed);
    captureEvidence = null;
    const number = ++caseNumber;
    onTestFailed(async () => {
      const root = process.env.PORTOS_CI_DIAGNOSTICS_PATH ? dirname(process.env.PORTOS_CI_DIAGNOSTICS_PATH) : process.env.PORTOS_CI_DIAGNOSTICS_DIR;
      if (!root || !captureEvidence) return;
      const destination = join(root, 'animatic-capture', `case-${number}`);
      await mkdir(destination, { recursive: true });
      const { saved, displayed, ...metadata } = captureEvidence;
      // Only the synthetic fixture's frame, not a page screenshot, enters CI artifacts.
      for (const [name, png] of Object.entries({ saved, displayed })) {
        if (png && png.length <= 2 * 1024 * 1024) await writeFile(join(destination, `${name}.png`), png);
      }
      const filters = [];
      for (const key of ['frozen', 'serialized', 'beforeScreenshot', 'afterScreenshot', 'afterUpload']) {
        if (!metadata[key]) continue;
        const { filter, ...snapshot } = metadata[key];
        const signature = JSON.stringify(filter);
        let revision = filters.findIndex(value => JSON.stringify(value) === signature);
        if (revision < 0) { revision = filters.length; filters.push(filter); }
        metadata[key] = { ...snapshot, filterRevision: revision };
      }
      const json = JSON.stringify({ ...metadata, filters });
      if (Buffer.byteLength(json) > 65536) throw new Error('Capture diagnostics exceeded their bound');
      await writeFile(join(destination, 'frame.json'), json);
    });
  });

  const show = async (value, t) => {
    await phase('show-render', () => page.evaluate(({ value, t }) => { window.uploads = []; window.show(value, t); }, { value, t }));
    // Assigning currentTime is synchronous; its seeked handler can still leave Ending later.
    await phase('show-song-seek', () => page.waitForFunction((t) => Math.abs(document.querySelector('audio')?.currentTime - t) < 0.00001 && !document.querySelector('audio').seeking, t));
    await phase('show-images-ready', () => page.waitForFunction(() => [...document.querySelectorAll('figure img')].every((image) => image.complete && image.naturalWidth > 0)));
  };
  const capture = async (label = '') => {
    await phase('capture-reset', () => page.evaluate(() => { window.uploads = []; window.captureErrors = []; }));
    await phase('capture-video-ready', () => page.waitForFunction(() => [...document.querySelectorAll('video[data-preview-video]')].every(video => Number(getComputedStyle(video.parentElement).opacity) === 0 || (!video.seeking && video.dataset.pausedFrame === String(video.currentTime)))));
    captureEvidence = { label, platform: process.platform, arch: process.arch, browser: fixture.browser.version(), ffmpegVersion };
    // Observe serialization without delaying normal decode/upload timing. Only
    // the mutation negative controls hold decode while changing the preview.
    await phase('capture-observe', () => page.evaluate(() => window.gateCaptureOnce(false)));
    await phase('capture-click', () => page.getByRole('button', { name: 'Save frame', exact: true }).click());
    await phase('capture-upload-or-error', () => page.waitForFunction(() => window.uploads.length > 0 || window.captureErrors.length > 0));
    captureEvidence.frozen = await page.evaluate(() => window.captureFrozen);
    captureEvidence.serialized = await page.evaluate(() => window.captureSerialized);
    captureEvidence.afterUpload = await page.evaluate(() => window.previewMetadata());
    captureEvidence.scenes = await page.evaluate(() => window.fixtureScenes);
    captureEvidence.errors = await phase('capture-read-errors', () => page.evaluate(() => window.captureErrors));
    expect(captureEvidence.errors, label).toEqual([]);
    const saved = Buffer.from(await phase('capture-read-upload', () => page.evaluate(() => window.uploads.at(-1))));
    captureEvidence.saved = saved;
    const picture = page.getByLabel('Storyboard animatic', { exact: true }).locator(':scope > div').first();
    captureEvidence.beforeScreenshot = await page.evaluate(() => window.previewMetadata());
    captureEvidence.displayed = await phase('capture-screenshot', () => picture.screenshot({ style: '[data-toast-id]{visibility:hidden}' }));
    captureEvidence.afterScreenshot = await page.evaluate(() => window.previewMetadata());
    const displayed = captureEvidence.displayed;
    const a = await phase('capture-decode-saved', () => sharp(saved).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
    const b = await phase('capture-decode-displayed', () => sharp(displayed).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
    expect([a.info.width, a.info.height]).toEqual([b.info.width, b.info.height]);
    let difference = 0, opaque = 0;
    for (let i = 0; i < a.data.length; i += 1) {
      difference += Math.abs(a.data[i] - b.data[i]);
      if (i % 4 === 3 && a.data[i] === 255) opaque += 1;
    }
    captureEvidence.meanDifference = difference / a.data.length;
    expect(captureEvidence.serialized).toEqual({ filter: captureEvidence.frozen.filter, filterFrame: captureEvidence.frozen.filterFrame, filterSize: captureEvidence.frozen.filterSize });
    const revision = ({ videos, ...rest }) => ({ ...rest, videos: videos.filter(video => Number(video.opacity) > 0) });
    expect(revision(captureEvidence.beforeScreenshot), 'Preview revision at freeze').toEqual(revision(captureEvidence.frozen));
    expect(revision(captureEvidence.afterScreenshot), 'Preview revision through screenshot').toEqual(revision(captureEvidence.frozen));
    expect(revision(captureEvidence.afterUpload), 'Preview revision after upload').toEqual(revision(captureEvidence.frozen));
    expect(captureEvidence.meanDifference, label).toBeLessThan(1);
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
      await capture(frameFit);
    }
  });

  it('keeps BT601/709 saturated colors and grayscale identical across paused preview, decoded pixels and PNG', async () => {
    const points = [...Array.from({ length: 8 }, (_, i) => [i * 60 + 30, 60]), ...Array.from({ length: 16 }, (_, i) => [i * 30 + 15, 160]), [240, 220]];
    const samples = (data, width, channels, locations) => locations.map(([x, y]) => [...data.subarray((y * width + x) * channels, (y * width + x) * channels + 3)]);
    for (const matrix of ['smpte170m', 'bt709']) {
      const value = project([{ ...still, referenceImageId: null, visualLayer: 'footage', videoHistoryId: matrix, frameFit: 'black' }]);
      for (const t of [0.02, 2.02, 1.02, 1.06, 1.02]) {
        await show(value, t);
        const saved = await capture(`${matrix} @ ${t}`);
        const pixels = await page.evaluate(async (points) => {
          const video = document.querySelector('video[data-ready="true"]');
          const canvas = video.nextElementSibling;
          const ctx = canvas.getContext('2d');
          const frame = new VideoFrame(video, { timestamp: 0 });
          try {
            const metadata = frame.colorSpace.toJSON();
            const format = frame.format;
            if (!['I420', 'NV12'].includes(format)) throw new Error(`Unexpected synthetic VP9 pixel format: ${format}`);
            const bytes = new Uint8Array(frame.allocationSize());
            const layout = await frame.copyTo(bytes);
            const yuv = points.map(([x, y]) => [bytes[layout[0].offset + y * layout[0].stride + x], ...[1, 2].map(i => {
              const plane = layout[format === 'NV12' ? 1 : i];
              return bytes[plane.offset + Math.floor(y / 2) * plane.stride + (format === 'NV12' ? 2 * Math.floor(x / 2) + i - 1 : Math.floor(x / 2))];
            })]);
            // Read a new draw of the source video, never the product canvas.
            const fresh = document.createElement('canvas'); fresh.width = video.videoWidth; fresh.height = video.videoHeight;
            const decoded = fresh.getContext('2d', { colorSpace: 'srgb' }); decoded.drawImage(video, 0, 0);
            const read = context => points.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3));
            return { metadata, format, yuv, currentTime: video.currentTime, samples: read(ctx), fresh: read(decoded) };
          } finally { frame.close(); }
        }, points);
        expect(pixels.currentTime).toBeCloseTo(t, 5);
        expect(pixels.metadata).toEqual({ matrix, primaries: matrix, transfer: matrix, fullRange: false });
        const raw = await sharp(saved).raw().toBuffer({ resolveWithObject: true });
        const scale = raw.info.width / 480;
        const pngPoints = points.map(([x, y]) => [Math.floor(x * scale), Math.floor((raw.info.height - 240 * scale) / 2 + y * scale)]);
        const exported = samples(raw.data, raw.info.width, raw.info.channels, pngPoints);
        const frameIndex = Math.floor(t * 24);
        const offset = frameIndex * 480 * 240 * 3;
        const yuv = colorYuvReferences.get(matrix).subarray(frameIndex * 480 * 240 * 3 / 2);
        const sourceYuv = points.map(([x, y]) => [yuv[y * 480 + x], yuv[480 * 240 + Math.floor(y / 2) * 240 + Math.floor(x / 2)],
          yuv[480 * 240 * 5 / 4 + Math.floor(y / 2) * 240 + Math.floor(x / 2)]]);
        const [kr, kb] = matrix === 'bt709' ? [0.2126, 0.0722] : [0.299, 0.114];
        const expectedYuv = points.map(([x, y]) => {
          const [r, g, b] = chartRgb(x, y, frameIndex).map(channel => channel / 255);
          const luma = kr * r + (1 - kr - kb) * g + kb * b;
          return [16 + 219 * luma, 128 + 112 * (b - luma) / (1 - kb), 128 + 112 * (r - luma) / (1 - kr)].map(Math.round);
        });
        const reference = samples(colorReferences.get(matrix).subarray(offset), 480, 3, points);
        let displayed;
        if (t === 0.02) {
          // Retain native-display negative evidence; it is diagnostic, not the
          // reference used to relax the strict actual-preview capture assertion.
          const video = page.locator('video[data-ready="true"]');
          await video.evaluate(v => { v.style.visibility = ''; v.nextElementSibling.style.visibility = 'hidden'; });
          let native;
          try { native = await video.screenshot(); }
          finally { await video.evaluate(v => { v.style.visibility = 'hidden'; v.nextElementSibling.style.visibility = ''; }); }
          const nativePixels = await sharp(native).raw().toBuffer({ resolveWithObject: true });
          displayed = samples(nativePixels.data, nativePixels.info.width, nativePixels.info.channels, pngPoints);
          console.log(`🎨 ${process.platform}/${process.arch} ${fixture.browser.version()} ${matrix} limited YUV -> sRGB: ${JSON.stringify({ native: displayed, decoded: pixels.samples, png: exported, ffmpeg: reference })}`);
        }
        // CI intentionally silences console output. Preserve the complete
        // independent measurements in the assertion failure, before bailing.
        const evidence = JSON.stringify({ platform: process.platform, arch: process.arch, browser: fixture.browser.version(), ffmpegVersion,
          matrix, t, metadata: pixels.metadata, format: pixels.format, native: displayed, decoded: pixels.samples, fresh: pixels.fresh,
          png: exported, ffmpeg: reference, sourceYuv, browserYuv: pixels.yuv, expectedYuv });
        expect(pixels.yuv, `Source frame ${matrix} @ ${t}: ${evidence}`).toEqual(sourceYuv);
        expect(pixels.samples, `Paused frame ${matrix} @ ${t}: ${evidence}`).toEqual(pixels.fresh);
        for (let i = 0; i < points.length; i++) for (let c = 0; c < 3; c++) {
          expect(Math.abs(exported[i][c] - pixels.samples[i][c]), `PNG ${matrix} ${i}/${c}: ${evidence}`).toBeLessThanOrEqual(1);
          // Quantization from the lossy VP9 chart is bounded independently of
          // any browser or FFmpeg RGB conversion and checked for every frame.
          expect(Math.abs(sourceYuv[i][c] - expectedYuv[i][c]), `Encoded YUV ${matrix} ${i}/${c}: ${evidence}`).toBeLessThanOrEqual(2);
        }
      }
    }
  }, 30000);

  it('uses native continuous playback, then freezes the selected source frame on pause and resume', async () => {
    await show(project([{ ...still, referenceImageId: null, visualLayer: 'footage', videoHistoryId: 'bt709' }]), 0.02);
    await capture();
    await page.evaluate(async () => { await document.querySelector('audio').play(); });
    await page.waitForFunction(() => { const v = document.querySelector('video'); return !v.paused && v.currentTime > 0.3 && !v.dataset.pausedFrame && getComputedStyle(v).visibility === 'visible'; });
    await page.evaluate(() => document.querySelector('audio').pause());
    await capture();
    await page.evaluate(async () => { await document.querySelector('audio').play(); });
    await page.waitForFunction(() => !document.querySelector('video').paused && !document.querySelector('video').dataset.pausedFrame);
    await page.evaluate(() => document.querySelector('audio').pause());
    await capture();
  });

  it('shares both footage surfaces through an incoming dissolve and the selected exact film look', async () => {
    await show(project([
      { ...still, visualLayer: 'footage', videoHistoryId: 'smpte170m', cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { ...still, sceneId: 'incoming', order: 1, startSec: 4, endSec: 8, visualLayer: 'footage', videoHistoryId: 'bt709' },
    ], { filmLook: filmLookPreset('vhs') }), 3.5);
    await capture();
    expect(await page.locator('canvas[data-paused-video]:visible').count()).toBe(2);
    expect(await page.locator('[data-film-look="exact"]').count()).toBe(1);
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
    await phase('outro-enable-look', async () => {
      if (await look.getAttribute('aria-pressed') === 'false') await look.click();
    });
    // The canvas mounts with provisional counts, so its presence/fonts do not
    // establish a capture basis. Wait for the tally, then let React paint it.
    const statsReady = page.waitForResponse('**/api/music-video/*/stats-outro');
    await phase('outro-activate', () => page.getByRole('button', { name: 'Ending', exact: true }).click());
    await phase('outro-canvas-ready', () => page.getByTestId('animatic-stats-outro').waitFor());
    const statsResponse = await phase('outro-stats-response', () => statsReady);
    expect(statsResponse.ok()).toBe(true);
    expect(await phase('outro-stats-finished', () => statsResponse.finished())).toBeNull();
    await phase('outro-fonts-ready', () => page.evaluate(() => document.fonts.ready));
    await phase('outro-paint-settled', () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));
    const saved = await capture();
    expect(await phase('outro-exact-look', () => page.locator('[data-film-look="exact"]').count())).toBe(1);
    await phase('outro-repeat-paint', () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))));
    await phase('outro-repeat-reset', () => page.evaluate(() => { window.uploads = []; }));
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
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.gateCaptureOnce());
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureDecodePending);
    expect(pendingStats).toBeTruthy();
    // The old success fixture's entire readiness condition is now true, yet
    // the statistics request is still held and capture has not uploaded.
    const controlState = () => page.evaluate(() => ({
      seeking: document.querySelector('audio').seeking,
      time: document.querySelector('audio').currentTime,
      ending: document.querySelector('[data-testid="animatic-stats-outro"]') !== null,
      errors: window.captureErrors, uploads: window.uploads.length,
    }));
    expect(await controlState()).toEqual({ seeking: false, time: 1, ending: true, errors: [], uploads: 0 });
    await pendingStats.fulfill({ json: { stats: { shots: 9, floorImages: [] } } });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    expect(await controlState()).toEqual({ seeking: false, time: 1, ending: true, errors: [], uploads: 0 });
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => window.captureErrors.length > 0);
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Preview changed during capture');
    await page.unroute('**/api/music-video/*/stats-outro');
    // With that same Ending paused and its response applied, capture succeeds
    // and keeps the exact displayed pixels on a second independent save.
    const saved = await capture();
    expect(Buffer.compare(saved, await capture())).toBe(0);
  });
  it('rejects a late exact-filter resize while keeping the selected song and footage frames frozen', async () => {
    await show(project([
      { ...still, visualLayer: 'footage', videoHistoryId: 'smpte170m', cutEffect: { style: 'dissolve', enabled: true, overlapSec: 1 } },
      { ...still, sceneId: 'incoming', order: 1, startSec: 4, endSec: 8, visualLayer: 'footage', videoHistoryId: 'bt709' },
    ], { filmLook: filmLookPreset('vhs') }), 3.5);
    const look = page.getByRole('button', { name: 'Film look', exact: true });
    if (await look.getAttribute('aria-pressed') === 'false') await look.click();
    await page.evaluate(() => { window.uploads = []; window.gateCaptureOnce(); });
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureDecodePending);
    await page.locator('video[data-preview-video][aria-hidden="true"]').first().evaluate(video => { video.dataset.ready = 'false'; });
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => window.uploads.length > 0 || window.captureErrors.length > 0);
    expect(await page.evaluate(() => window.captureErrors)).toEqual([]);
    expect(await page.evaluate(() => window.uploads.length)).toBe(1);
    await page.evaluate(() => { window.uploads = []; window.gateCaptureOnce(); });
    await page.getByRole('button', { name: 'Save frame', exact: true }).click();
    await page.waitForFunction(() => window.captureDecodePending);
    const frozen = await page.evaluate(() => window.captureFrozen);
    // No audio seek or project edit: only the box and the size-dependent SVG
    // change after the actual preview has already been serialized.
    await page.locator('main').evaluate(el => { el.style.width = '602px'; });
    await page.waitForFunction(() => document.querySelector('[data-film-look-width="600"]'));
    const resized = await page.evaluate(() => window.previewMetadata());
    expect(resized.songFrame).toBe(frozen.songFrame);
    expect(resized.videos).toEqual(frozen.videos);
    expect(resized.filter).not.toEqual(frozen.filter);
    await page.evaluate(() => window.releaseCapture());
    await page.waitForFunction(() => window.captureErrors.length > 0 || window.uploads.length > 0);
    expect(await page.evaluate(() => window.uploads.length)).toBe(0);
    expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Preview changed during capture');
    try { await capture(); }
    finally { await page.locator('main').evaluate(el => { el.style.width = '642px'; }); }
  });

  it('reports an unavailable paused color surface without uploading a different native-video image', async () => {
    await page.evaluate(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      window.restoreContext = () => { HTMLCanvasElement.prototype.getContext = original; };
      HTMLCanvasElement.prototype.getContext = function(...args) { return this.dataset.pausedVideo ? null : original.apply(this, args); };
    });
    try {
      await show(project([{ ...still, visualLayer: 'footage', videoHistoryId: 'smpte170m' }]), 1.02);
      await page.waitForFunction(() => document.querySelector('video')?.dataset.previewError);
      await page.getByRole('button', { name: 'Save frame', exact: true }).click();
      await page.waitForFunction(() => window.captureErrors.length > 0);
      expect(await page.evaluate(() => window.uploads.length)).toBe(0);
      expect(await page.evaluate(() => window.captureErrors.at(-1))).toContain('Frame capture unavailable');
      expect(await page.locator('video').evaluate(v => getComputedStyle(v).visibility)).toBe('hidden');
    } finally { await page.evaluate(() => window.restoreContext()); }
    expect(errors).toEqual([]);
  });

});
