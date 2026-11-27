// Owns the shared storyboard browser, synthetic media and capture diagnostics for animatic suites.
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { startOwnedBrowserFixture } from '../../test/browserFixture.js';
import { createTestPhaseDiagnostics } from '../../../lib/testPhaseDiagnostics.js';
import { buildRecordedViteFixture, createRecordedStaticServer } from '../../../scripts/lib/browserServedFiles.js';
import { createOwnedFixtureSetup } from '../../test/ownedFixtureSetup.js';
import { resolveTestChrome, resolveClientBundler } from '../../lib/browserSuiteGate.js';
import { execFileSync } from '../../lib/childProcess.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { buildLyricPlaythroughPreview } from './lyricPlaythrough.js';

const client = resolve(import.meta.dirname, '../../../client');
const bundlers = resolveClientBundler(resolve(client, '..'));
const chrome = resolveTestChrome();
const ffmpeg = await findFfmpeg();
export const prerequisites = { Chrome: chrome, ffmpeg, 'client dependencies': bundlers };

export const still = { sceneId: 'still', order: 0, label: 'Example still', startSec: 0, endSec: 4, visualLayer: 'still', referenceImageId: 'grid.png', stillMove: 'hold' };
export const project = (scenes = [still], extra = {}) => ({ id: 'capture-fixture', name: 'Example capture', scenes, composition: { mode: 'composed' }, ...extra });
const colorMatrices = ['smpte170m', 'bt709'];
const chartColors = [[0, 255, 255], [255, 0, 255], [255, 255, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0]];
export const chartRgb = (x, y, frame) => {
  if (y < 120) return chartColors[Math.floor(x / 60)];
  const gray = Math.floor(x / 30) * 17;
  return y < 200 ? [gray, gray, gray] : frame % 2 ? [230, 40, 190] : [frame * 2, 255 - frame * 2, frame];
};

export function useAnimaticCaptureBrowserFixture(suite, { readColorReferences = false } = {}) {
  let dir, server, fixture, page;
  const colorReferences = new Map();
  const colorYuvReferences = new Map();
  const errors = [];
  const state = { page: null, browserVersion: null, ffmpegVersion: null, captureEvidence: null, lyricProject: null };

  const setup = createOwnedFixtureSetup({ cleanup: async () => {
    // A failed browser close must not leave the HTTP listener open.
    const outcomes = await Promise.allSettled([fixture?.close(), server && new Promise((done, reject) => server.close(error => error ? reject(error) : done()))]);
    // The generated workspace is independent of the owned browser profile.
    outcomes.push(...await Promise.allSettled([dir && rm(dir, { recursive: true, force: true })]));
    const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
    if (failures.length) throw new AggregateError(failures, 'Animatic fixture cleanup failed');
  } });
  afterAll(() => setup.close());

  beforeAll(() => setup.run(async phase => {
    state.ffmpegVersion = await phase('ffmpeg-version', timeout => execFileSync(ffmpeg, ['-version'], { timeout, killSignal: 'SIGKILL', encoding: 'utf8' }).split('\n')[0]);
    await phase('workspace', async () => {
      dir = await mkdtemp(join(tmpdir(), 'portos-animatic-capture-'));
      await symlink(join(client, 'node_modules'), join(dir, 'node_modules'), 'dir');
      const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import Animatic from ${JSON.stringify(join(client, 'src/components/musicVideo/StoryboardAnimatic.jsx'))};import toast,{Toaster}from ${JSON.stringify(join(client, 'src/components/ui/Toast.jsx'))};import{capturePreviewFrame}from ${JSON.stringify(join(client, 'src/lib/musicVideoFrameCapture.js'))};window.capturePreviewFrame=capturePreviewFrame;
window.uploads=[];window.captureErrors=[];const report=toast.error;toast.error=(message,...args)=>{window.captureErrors.push(message);return report(message,...args)};const realFetch=window.fetch;window.fetch=async(url,options)=>{if(url==='/api/image-gen/upload'){window.uploads.push(Array.from(new Uint8Array(await options.body.get('file').arrayBuffer())));return Response.json({filename:'synthetic.png'});}return realFetch(url,options)};
const filterRevision=root=>{const filter=root?.querySelector('filter');return filter?[filter,...filter.querySelectorAll('*')].map(el=>[el.localName,[...el.attributes].filter(a=>a.name!=='style'&&!a.name.startsWith('xmlns')).map(a=>[a.name,a.value]).sort()]):null};
const surfaceRevision=canvas=>{if(!canvas?.width||!canvas.height)return null;const bytes=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;let hash=2166136261;for(const byte of bytes)hash=Math.imul(hash^byte,16777619);return hash>>>0};
window.previewMetadata=()=>{
  const root=document.querySelector('figure')?.firstElementChild;
  const box=root?.getBoundingClientRect();
  return {songTime:document.querySelector('audio')?.currentTime,songFrame:Math.round((document.querySelector('audio')?.currentTime||0)*24),
    box:box&&[box.width,box.height],look:root?.dataset.filmLook,filterFrame:root?.dataset.filmLookFrame,
    filterSize:[root?.dataset.filmLookWidth,root?.dataset.filmLookHeight],filter:filterRevision(root),
    videos:[...document.querySelectorAll('video[data-preview-video]')].map(v=>({label:v.getAttribute('aria-label'),
      source:new URL(v.currentSrc||v.src,location.href).pathname.split('/').pop(),time:v.currentTime,pausedFrame:v.dataset.pausedFrame,
      seeking:v.seeking,readyState:v.readyState,opacity:getComputedStyle(v.parentElement).opacity,
      canvasVisible:getComputedStyle(v.nextElementSibling).visibility,canvasSize:[v.nextElementSibling.width,v.nextElementSibling.height],
      canvasRevision:surfaceRevision(v.nextElementSibling)}))};
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
      const { build, react, tailwind } = await import('../../../client/src/test/clientBundler.js');
      await buildRecordedViteFixture({
        build,
        recordedRoot: client,
        temp: dir,
        config: { configFile: false, root: dir, publicDir: join(client, 'public'), plugins: [react()], css: { postcss: { plugins: [tailwind({ base: client })] } }, build: { outDir: join(dir, 'dist'), emptyOutDir: true }, logLevel: 'warn' },
      });
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
    for (const matrix of colorMatrices) {
      const path = join(dir, `${matrix}.webm`);
      await phase(`${matrix}-encode`, timeout => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', '480x240', '-framerate', '24', '-i', 'pipe:0',
        '-vf', `scale=out_color_matrix=${matrix}:out_range=tv,format=yuv420p`, '-colorspace', matrix, '-color_primaries', matrix, '-color_trc', matrix, '-color_range', 'tv',
        '-c:v', 'libvpx-vp9', '-threads', '1', '-crf', '4', '-b:v', '2M', path], { timeout, killSignal: 'SIGKILL', input: frames }));
      // Retain RGB as diagnostic evidence. CPU/GPU browser conversion need not
      // match FFmpeg RGB; raw decoded YUV independently verifies the source.
      if (!readColorReferences) continue;
      const rgb = await phase(`${matrix}-rgb-decode`, timeout => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-vf', `scale=in_color_matrix=${matrix}:in_range=tv:out_range=pc,format=rgb24`,
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { timeout, killSignal: 'SIGKILL', maxBuffer: frames.length + 1024 }));
      colorReferences.set(matrix, rgb);
      colorYuvReferences.set(matrix, await phase(`${matrix}-yuv-decode`, timeout => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1'],
        { timeout, killSignal: 'SIGKILL', maxBuffer: frames.length + 1024 })));
    }
    await phase('audio-encode', timeout => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', join(dir, 'song.wav')], { timeout, killSignal: 'SIGKILL' }));
    await phase('http-server', async () => {
      const app = express();
      const staticFiles = createRecordedStaticServer(express);
      app.get('/data/images/:id', (req, res) => res.sendFile(join(dir, req.params.id)));
      app.get('/api/video-gen/history/:id', (req, res) => res.json({ id: req.params.id, filename: colorMatrices.includes(req.params.id) ? `${req.params.id}.webm` : 'clip.webm', fps: 24, numFrames: 96, width: 120, height: 240 }));
      app.get('/api/music-video/:id/stats-outro', (req, res) => res.json({ stats: { shots: 2, stills: { made: 3, kept: 1 }, clips: { made: 2, kept: 1 }, floorImages: [] } }));
      app.get('/api/music-video/:id/lyrics/overlay/preview', async (req, res, next) => {
        try { res.json(await buildLyricPlaythroughPreview(state.lyricProject, { overlay: true })); }
        catch (error) { next(error); }
      });
      app.get('/data/videos/:name', (req, res) => res.sendFile(join(dir, req.params.name)));
      app.get('/song.wav', (req, res) => res.sendFile(join(dir, 'song.wav')));
      app.use(staticFiles.serve(join(dir, 'dist')));
      server = await staticFiles.start(app);
    });
    await phase('browser-acquire', async () => {
      fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true, args: ['--force-color-profile=srgb'] } });
    });
    await phase('page-acquire', async () => {
      state.browserVersion = fixture.browser.version();
      page = state.page = await fixture.browser.newPage({ viewport: { width: 1000, height: 800 } });
      page.on('pageerror', (error) => errors.push(error.message));
    });
    await phase('navigation', () => page.goto(`http://127.0.0.1:${server.address().port}`));
    await phase('readiness', () => page.waitForFunction(() => typeof window.show === 'function'));
  }), 30000);

  let phase, caseNumber = 0;
  beforeEach(({ onTestFailed }) => {
    phase = createTestPhaseDiagnostics(onTestFailed);
    state.captureEvidence = null;
    const number = ++caseNumber;
    onTestFailed(async () => {
      const root = process.env.PORTOS_CI_DIAGNOSTICS_PATH ? dirname(process.env.PORTOS_CI_DIAGNOSTICS_PATH) : process.env.PORTOS_CI_DIAGNOSTICS_DIR;
      if (!root || !state.captureEvidence) return;
      const destination = join(root, 'animatic-capture', `case-${suite}-${number}`);
      await mkdir(destination, { recursive: true });
      const { saved, displayed, ...metadata } = state.captureEvidence;
      // Only the synthetic fixture's frame, not a page screenshot, enters CI artifacts.
      for (const [name, png] of Object.entries({ saved, displayed })) {
        if (png && png.length <= 2 * 1024 * 1024) await writeFile(join(destination, `${name}.png`), png);
      }
      const filters = [];
      for (const key of ['frozen', 'serialized', 'beforeScreenshot', 'afterScreenshot', 'afterUpload', 'beforeFilterCommit', 'afterFilterCommit']) {
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
  const enableFilmLook = async () => {
    const look = page.getByRole('button', { name: 'Film look', exact: true });
    if (await look.getAttribute('aria-pressed') === 'false') await look.click();
  };
  const capture = async (label = '', whileSettling) => {
    await phase('capture-reset', () => page.evaluate(() => { window.uploads = []; window.captureErrors = []; }));
    await phase('capture-video-ready', () => page.waitForFunction(() => [...document.querySelectorAll('video[data-preview-video]')].every(video => Number(getComputedStyle(video.parentElement).opacity) === 0 || (!video.seeking && video.dataset.pausedFrame === String(video.currentTime)))));
    state.captureEvidence = { label, platform: process.platform, arch: process.arch, browser: state.browserVersion, ffmpegVersion: state.ffmpegVersion };
    // Observe serialization without delaying normal decode/upload timing. Only
    // the mutation negative controls hold decode while changing the preview.
    await phase('capture-observe', () => page.evaluate(() => window.gateCaptureOnce(false)));
    await phase('capture-click', () => page.getByRole('button', { name: 'Save frame', exact: true }).click());
    if (whileSettling) await phase('capture-settling', whileSettling);
    await phase('capture-upload-or-error', () => page.waitForFunction(() => window.uploads.length > 0 || window.captureErrors.length > 0));
    state.captureEvidence.frozen = await page.evaluate(() => window.captureFrozen);
    state.captureEvidence.serialized = await page.evaluate(() => window.captureSerialized);
    state.captureEvidence.afterUpload = await page.evaluate(() => window.previewMetadata());
    state.captureEvidence.scenes = await page.evaluate(() => window.fixtureScenes);
    state.captureEvidence.errors = await phase('capture-read-errors', () => page.evaluate(() => window.captureErrors));
    expect(state.captureEvidence.errors, label).toEqual([]);
    const saved = Buffer.from(await phase('capture-read-upload', () => page.evaluate(() => window.uploads.at(-1))));
    state.captureEvidence.saved = saved;
    const picture = page.getByLabel('Storyboard animatic', { exact: true }).locator(':scope > div').first();
    state.captureEvidence.beforeScreenshot = await page.evaluate(() => window.previewMetadata());
    state.captureEvidence.displayed = await phase('capture-screenshot', () => picture.screenshot({ style: '[data-toast-id]{visibility:hidden}' }));
    state.captureEvidence.afterScreenshot = await page.evaluate(() => window.previewMetadata());
    const displayed = state.captureEvidence.displayed;
    const a = await phase('capture-decode-saved', () => sharp(saved).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
    const b = await phase('capture-decode-displayed', () => sharp(displayed).ensureAlpha().raw().toBuffer({ resolveWithObject: true }));
    expect([a.info.width, a.info.height]).toEqual([b.info.width, b.info.height]);
    let difference = 0, opaque = 0;
    const tiles = Array.from({ length: 16 }, () => ({ difference: 0, channels: 0 }));
    for (let i = 0; i < a.data.length; i += 1) {
      const error = Math.abs(a.data[i] - b.data[i]);
      difference += error;
      const pixel = Math.floor(i / 4), x = pixel % a.info.width, y = Math.floor(pixel / a.info.width);
      const tile = tiles[Math.min(3, Math.floor(y * 4 / a.info.height)) * 4 + Math.min(3, Math.floor(x * 4 / a.info.width))];
      tile.difference += error; tile.channels += 1;
      if (i % 4 === 3 && a.data[i] === 255) opaque += 1;
    }
    state.captureEvidence.meanDifference = difference / a.data.length;
    state.captureEvidence.tileMeanDifferences = tiles.map(tile => tile.difference / tile.channels);
    if (label) {
      const { songFrame, filterSize, videos } = state.captureEvidence.frozen;
      const surfaces = videos.filter(video => Number(video.opacity) > 0)
        .map(video => `${video.source}@${video.time}:${video.canvasRevision}`).join(',');
      console.log(`🎞️ Synthetic capture ${label}: mean=${state.captureEvidence.meanDifference} songFrame=${songFrame} filter=${filterSize.join('x')} surfaces=${surfaces}`);
    }
    expect(state.captureEvidence.serialized).toEqual({ filter: state.captureEvidence.frozen.filter, filterFrame: state.captureEvidence.frozen.filterFrame, filterSize: state.captureEvidence.frozen.filterSize });
    const revision = ({ videos, ...rest }) => ({ ...rest, videos: videos.filter(video => Number(video.opacity) > 0) });
    expect(revision(state.captureEvidence.beforeScreenshot), 'Preview revision at freeze').toEqual(revision(state.captureEvidence.frozen));
    expect(revision(state.captureEvidence.afterScreenshot), 'Preview revision through screenshot').toEqual(revision(state.captureEvidence.frozen));
    expect(revision(state.captureEvidence.afterUpload), 'Preview revision after upload').toEqual(revision(state.captureEvidence.frozen));
    expect(state.captureEvidence.meanDifference, label).toBeLessThan(1);
    expect(opaque).toBe(a.info.width * a.info.height);
    return saved;
  };

  return { state, errors, colorReferences, colorYuvReferences, show, capture, enableFilmLook, phase: (...args) => phase(...args) };
}
