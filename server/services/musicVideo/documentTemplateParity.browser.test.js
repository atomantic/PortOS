import { readLayeredEngine } from './layeredEngineSource.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { startOwnedBrowserFixture } from '../../test/browserFixture.js';
import { createOwnedFixtureSetup } from '../../test/ownedFixtureSetup.js';
import { installTemplateParityDiagnostics } from '../../test/templateParityDiagnostics.js';
import { createTestPhaseDiagnostics } from '../../../lib/testPhaseDiagnostics.js';
import { buildRecordedViteFixture, createRecordedStaticServer } from '../../../scripts/lib/browserServedFiles.js';
import { browserSuiteCanRun, resolveTestChrome, resolveClientBundler } from '../../lib/browserSuiteGate.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { narrativeFrameState } from '../../lib/musicVideo/musicVideoNarrativeEvents.js';
import { buildDocumentData, documentRenderClock, documentRenderInitScripts, documentAspect, DOCUMENT_FRAME_SIZES } from './documentRender.js';
import { buildLyricPlaythroughPreview } from './lyricPlaythrough.js';

// Bundled StoryboardAnimatic.jsx, DocumentTemplateCanvas.jsx, documentTemplateDrawing.js,
// DocumentTemplateLayers.jsx and documentTemplates/layered/engine.js
// are the fixture's CI dependency edges (the generated entrypoint has no static import).
const root = resolve(import.meta.dirname, '../../..');
const client = join(root, 'client');
const templates = join(import.meta.dirname, 'documentTemplates');
const bundlers = resolveClientBundler(root), chrome = resolveTestChrome(), ffmpeg = await findFfmpeg();
const canRun = browserSuiteCanRun('native template pixel parity', { Chrome: chrome, ffmpeg, 'client dependencies': bundlers });
const still = { sceneId: 'still', order: 0, label: 'Example still', startSec: 0, endSec: 4, visualLayer: 'still', referenceImageId: 'grid.png', stillMove: 'hold' };
const base = (scene = still, extra = {}) => ({ id: 'native-parity-fixture', name: 'Example song', scenes: [scene],
  audioAnalysis: { durationSec: 4, beats: [0.5, 1, 2, 3], downbeats: [1, 3], sections: [{ startSec: 0, endSec: 4, label: 'Verse' }] },
  composition: { mode: 'document', document: { directory: 'fixture' } }, ...extra });
const clipHistory = Object.fromEntries(['clip', 'uniform'].map(id => [
  id, { id, filename: `${id}.webm`, fps: 24, width: 240, height: 240, numFrames: 96 },
]));
let dir, server, fixture, engineFixture, native, engine, current, engineData;
let comparison = 0;
const errors = [];
const setup = createOwnedFixtureSetup({ cleanup: async () => {
  const results = await Promise.allSettled([fixture?.close(), engineFixture?.close(), server && new Promise((done, reject) => server.close(error => error ? reject(error) : done()))]);
  results.push(...await Promise.allSettled([dir && rm(dir, { recursive: true, force: true })]));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Native parity fixture cleanup failed');
} });
afterAll(() => setup.close());

const dataFor = (project, media = new Map()) => buildDocumentData(project, { media, frame: DOCUMENT_FRAME_SIZES[documentAspect(project)], clock: documentRenderClock(4, 24), songDurationSec: 4 });

// Supply the macOS fixture's data in the native page. Chrome still decodes
// every image and media file and renders the generated lyric HTML.
function installNativeFixtureInputs({ clips, assets }) {
  const history = new Map(clips.map(entry => [`/api/video-gen/history/${entry.id}`, entry]));
  const urls = new Map(assets.map(({ path, type, bytes }) => [
    path, URL.createObjectURL(new Blob([Uint8Array.from(atob(bytes), char => char.charCodeAt(0))], { type })),
  ]));
  const fetch = window.fetch;
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin === location.origin) {
      const response = history.get(url.pathname) ?? window.parityLyricResponses?.get(url.pathname);
      if (response) return Promise.resolve(Response.json(response));
    }
    return fetch(input, init);
  };

  // React sets the attribute, while the canvas painter assigns Image.src.
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttribute.call(this, name, name === 'src' ? urls.get(value) ?? value : value);
  };
  for (const prototype of [HTMLImageElement.prototype, HTMLMediaElement.prototype]) {
    const src = Object.getOwnPropertyDescriptor(prototype, 'src');
    Object.defineProperty(prototype, 'src', {
      ...src, set(value) { src.set.call(this, urls.get(value) ?? value); },
    });
  }
}

async function assertParity({ actual, expected, metadata }) {
  // The launcher deliberately removes DIAGNOSTICS_DIR from worker envs. Its
  // per-run report path keeps these artifacts in the attempt the uploader owns.
  const destination = process.env.PORTOS_CI_DIAGNOSTICS_PATH ? dirname(process.env.PORTOS_CI_DIAGNOSTICS_PATH) : process.env.PORTOS_CI_DIAGNOSTICS_DIR;
  const a = await sharp(actual).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(expected).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0, changed = 0;
  const sameSize = JSON.stringify(a.info) === JSON.stringify(b.info);
  if (sameSize) for (let i = 0; i < a.data.length; i++) { const delta = Math.abs(a.data[i] - b.data[i]); sum += delta; if (delta > 12) changed++; }
  const diff = sameSize ? { mean: sum / a.data.length, changed: changed / a.data.length } : { dimensions: { native: a.info, engine: b.info } };
  if ((!sameSize || diff.mean >= 0.3 || diff.changed >= 0.004) && destination) {
    const parent = join(destination, 'template-parity');
    await mkdir(parent, { recursive: true });
    const output = await mkdtemp(join(parent, 'case-'));
    await writeFile(join(output, 'native.png'), actual);
    await writeFile(join(output, 'engine.png'), expected);
    await writeFile(join(output, 'parity.json'), JSON.stringify({ ...metadata, diff }, null, 2));
  }
  expect(a.info).toEqual(b.info);
  expect(diff.mean, `mean RGB error at ${metadata.t}s`).toBeLessThan(0.3);
  expect(diff.changed, `RGB samples differing by >12 at ${metadata.t}s`).toBeLessThan(0.004);
}

describe.skipIf(!canRun)('native composition versus the shipped layered engine', () => {
  beforeAll(() => setup.run(async phase => {
    await phase('workspace', async () => {
      dir = await mkdtemp(join(tmpdir(), 'portos-template-parity-'));
      await symlink(join(client, 'node_modules'), join(dir, 'node_modules'), 'dir');
      await writeFile(join(dir, 'entry.jsx'), `import React,{useState}from'react';import{createRoot}from'react-dom/client';import Animatic from ${JSON.stringify(join(client, 'src/components/musicVideo/StoryboardAnimatic.jsx'))};import ${JSON.stringify(join(client, 'src/index.css'))};
window.lyricFrames=[];window.addEventListener('message',event=>{if(event.data?.type==='portos-mv:seeked')window.lyricFrames.push(event.data.t)});
function App(){const[value,setValue]=useState(null);window.show=(project,data,t)=>{window.lyricFrames=[];setValue({project,data,seek:{t,n:(window.seq=(window.seq||0)+1)}})};window.update=(project,data,t)=>{window.lyricFrames=[];setValue(previous=>({...previous,project:JSON.stringify(previous.project)===JSON.stringify(project)?previous.project:project,data:JSON.stringify(previous.data)===JSON.stringify(data)?previous.data:data,seek:{t,n:(window.seekSeq=(window.seekSeq||1000)+1)}}))};return <main style={{width:640}}>{value&&<Animatic key={window.seq} project={value.project} nativeData={value.data} variant='document' audioUrl='/song.wav' seekRequest={value.seek}/>}</main>};createRoot(document.getElementById('root')).render(<App/>);`);
      await writeFile(join(dir, 'index.html'), '<html><head><style>figure{border:0!important;border-radius:0!important}</style></head><body style="margin:0"><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
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
    await phase('media', async timeout => {
      const svg = '<svg width="960" height="540" xmlns="http://www.w3.org/2000/svg"><rect width="960" height="540" fill="#174280"/><path d="M0 0H180V540H0zM400 0H600V540H400zM820 0H960V540H820z" fill="#e96531"/><circle cx="650" cy="130" r="95" fill="#eaeaea"/><path d="M0 400H960V480H0z" fill="#32d96c"/></svg>';
      await sharp(Buffer.from(svg)).png().toFile(join(dir, 'grid.png'));
      await sharp({ create: { width: 200, height: 400, channels: 3, background: '#f215cd' } }).png().toFile(join(dir, 'end.png'));
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-loop', '1', '-i', join(dir, 'grid.png'), '-vf', 'crop=540:540,scale=240:240,format=yuv420p', '-t', '4', '-r', '24', '-c:v', 'libvpx', '-threads', '1', join(dir, 'clip.webm')], { timeout, killSignal: 'SIGKILL' });
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=cyan:s=240x240:r=24:d=4', '-c:v', 'libvpx', '-threads', '1', join(dir, 'uniform.webm')], { timeout, killSignal: 'SIGKILL' });
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4', join(dir, 'song.wav')], { timeout, killSignal: 'SIGKILL' });
    });
    await phase('server', async () => {
      const app = express();
      const staticFiles = createRecordedStaticServer(express);
      const layeredEngine = await readLayeredEngine();
      app.get('/engine/engine.js', (_req, res) => res.type('js').send(layeredEngine));
      app.get('/engine/portos-mv.js', (_req, res) => res.type('js').send(`window.PORTOS_MV=${JSON.stringify(engineData)};window.PORTOS_MV_EVENT_STATE=${narrativeFrameState.toString()};${documentRenderInitScripts(current).join('\n')}`));
      app.get('/engine/media/:file', (req, res) => {
        const scene = engineData.scenes.find(s => s.media?.src === `media/${req.params.file}`);
        const selected = current.scenes.find(s => s.sceneId === scene?.sceneId);
        const name = req.params.file.endsWith('.webm') ? selected?.videoHistoryId === 'uniform' ? 'uniform.webm' : 'clip.webm' : req.params.file.includes('-end.') ? 'end.png' : selected?.referenceImageId || 'grid.png';
        res.sendFile(join(dir, name));
      });
      app.use('/engine', staticFiles.serve(join(templates, 'layered')), staticFiles.serve(join(templates, 'shared')), staticFiles.serve(join(root, 'server/lib/musicVideo')));
      app.get('/api/video-gen/history/:id', (req, res) => res.json({ ...clipHistory[req.params.id === 'uniform' ? 'uniform' : 'clip'], id: req.params.id }));
      app.get('/api/music-video/:id/lyrics/overlay/preview', async (_req, res, next) => { await buildLyricPlaythroughPreview(current, { overlay: true }).then(value => res.json(value)).catch(next); });
      app.get('/data/images/:file', (req, res) => res.sendFile(join(dir, req.params.file)));
      app.get('/data/videos/:file', (req, res) => res.sendFile(join(dir, req.params.file === 'uniform.webm' ? 'uniform.webm' : 'clip.webm')));
      app.get('/song.wav', (_req, res) => res.sendFile(join(dir, 'song.wav')));
      app.use(staticFiles.serve(join(dir, 'dist')));
      server = await staticFiles.start(app);
    });
    await phase('browser', async () => {
      const options = { chromium, launchOptions: { executablePath: chrome, headless: true, args: ['--force-color-profile=srgb'] } };
      fixture = await startOwnedBrowserFixture(options);
      // A mounted native preview can stall the next layered navigation when
      // macOS Chrome for Testing runs both pages in the same browser process.
      if (process.platform === 'darwin') engineFixture = await startOwnedBrowserFixture(options);
      native = await fixture.browser.newPage({ viewport: { width: 640, height: 700 } });
      engine = await (engineFixture ?? fixture).browser.newPage({ viewport: { width: 640, height: 360 } });
      for (const page of [native, engine]) {
        await page.addInitScript(installTemplateParityDiagnostics);
        page.on('pageerror', error => errors.push(error.message));
      }
      if (process.platform === 'darwin') {
        const clips = Object.values(clipHistory);
        const files = [
          ...clips.map(({ filename }) => ({ filename, path: `/data/videos/${filename}`, type: 'video/webm' })),
          ...['grid.png', 'end.png'].map(filename => ({ filename, path: `/data/images/${filename}`, type: 'image/png' })),
          { filename: 'song.wav', path: '/song.wav', type: 'audio/wav' },
        ];
        const assets = await Promise.all(files.map(async ({ filename, path, type }) => ({
          path, type, bytes: (await readFile(join(dir, filename))).toString('base64'),
        })));
        await native.addInitScript(installNativeFixtureInputs, { clips, assets });
      }
      await native.goto(`http://127.0.0.1:${server.address().port}`);
      await native.waitForFunction(() => typeof window.show === 'function');
    });
  }), 30000);

  let track;
  beforeEach(({ onTestFailed, signal }) => {
    const observe = createTestPhaseDiagnostics(onTestFailed);
    track = (label, operation) => {
      signal.throwIfAborted();
      return observe(label, operation);
    };
  });

  async function compare(project, t, { name = 'comparison', words = false, reuse = false, clockJump = false, lyricsOff = false, beforeCapture } = {}) {
    const observe = track;
    const phase = (label, operation) => observe(`${name}-${label}`, operation);
    // Media elements store microseconds; use a frame's centre so rounding a
    // fractional 24fps boundary cannot move the native clock back one frame.
    t = (Math.floor(t * 24 + 1e-6) + 0.5) / 24;
    current = project;
    const media = new Map(project.scenes.filter(s => s.visualLayer !== 'card').map(s => [s.sceneId, { kind: s.videoHistoryId ? 'video' : 'image', ext: s.videoHistoryId ? 'webm' : 'png', fps: 24, ...(s.endImageId ? { end: { kind: 'image', ext: 'png' } } : {}) }]));
    engineData = dataFor(lyricsOff ? { ...project, lyricOverlayEnabled: false } : project, media);
    await phase('engine-viewport', () => engine.setViewportSize({ width: 640, height: Math.round(640 * engineData.render.height / engineData.render.width) }));
    await phase('engine-navigation', () => engine.goto(`http://127.0.0.1:${server.address().port}/engine/index.html`));
    await phase('engine-composition-ready', () => engine.waitForFunction(() => !!window.portosComposition));
    await phase('engine-seek', () => engine.evaluate(t => window.portosComposition.seek(t), t));
    if (clockJump) await phase('native-clock-jump', () => native.evaluate(() => {
      // Advance the playing clock without a seek event: this case owns a dropped
      // playback frame, while the neighboring seek tests own scrub invalidation.
      const audio = document.querySelector('audio'); let clock = audio.currentTime;
      Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => clock, set: value => { clock = value; } });
    }));
    const lyrics = process.platform === 'darwin' && words
      ? await phase('prepare-lyrics', () => buildLyricPlaythroughPreview(project, { overlay: true }))
      : null;
    await phase('native-seek', () => native.evaluate(({ project, data, t, reuse, lyrics }) => {
      window.parityLyricResponses = new Map(lyrics ? [[`/api/music-video/${encodeURIComponent(project.id)}/lyrics/overlay/preview`, lyrics]] : []);
      (reuse ? window.update : window.show)(project, data, t);
    }, { project, data: dataFor(project), t, reuse, lyrics }));
    await phase('native-song-frame', () => native.waitForFunction(frame => document.querySelector('[data-testid="document-template-canvas"]')?.dataset.songFrame === String(frame), Math.floor(t * 24 + 1e-6)));
    await phase('native-fonts-ready', () => native.evaluate(() => document.fonts.ready));
    const currentScene = project.scenes.filter(s => s.startSec <= t && t < s.endSec).at(-1);
    if (currentScene?.visualLayer === 'footage' && currentScene.videoHistoryId) {
      await phase('native-video-ready', () => native.waitForFunction(() => document.querySelector('video[data-ready="true"]')?.readyState >= 2));
    }
    if (words) await phase('native-lyrics-ready', async () => {
      await native.waitForSelector('[data-testid="animatic-lyrics"]');
      if (lyricsOff) {
        await native.getByRole('button', { name: 'Lyrics', exact: true }).click();
        await native.frameLocator('[data-testid="animatic-lyrics"]').locator('#stage').waitFor({ state: 'hidden' });
      }
      // Use the public seek bridge's response to know its exact lyric frame landed.
      await native.waitForFunction(t => window.lyricFrames.includes(t), Math.floor(t * 24 + 1e-6) / 24);
    });
    // A late image/video/font load repaints the native surface on its own event.
    await phase('native-images-ready', () => native.waitForFunction(() => [...document.querySelectorAll('figure img')].every(img => img.complete && img.naturalWidth)));
    if (beforeCapture) await phase('before-capture', beforeCapture);
    const nativeBefore = await phase('native-state-before', () => native.evaluate(() => window.templateParityState()));
    const actual = await phase('native-capture', () => native.locator('figure > div').first().screenshot());
    const nativeAfter = await phase('native-state-after', () => native.evaluate(() => window.templateParityState()));
    const engineBefore = await phase('engine-state-before', () => engine.evaluate(() => window.templateParityState()));
    const expected = await phase('engine-capture', () => engine.locator('#stage').screenshot());
    const engineAfter = await phase('engine-state-after', () => engine.evaluate(() => window.templateParityState()));
    const capture = { actual, expected, metadata: { case: ++comparison, test: expect.getState().currentTestName, t,
      diffContext: { reuse, clockJump, words, lyricsOff },
      scenes: project.scenes.map(({ sceneId, startSec, endSec, visualLayer, videoHistoryId }) => ({ sceneId, startSec, endSec, visualLayer, videoHistoryId })),
      environment: { platform: process.platform, arch: process.arch, osRelease: release(), node: process.version,
        browser: fixture.browser.version(), engine: 'Blink', headless: true },
      native: { before: nativeBefore, after: nativeAfter }, engine: { before: engineBefore, after: engineAfter } } };
    await phase('assert-pixels', () => assertParity(capture));
    expect(errors).toEqual([]);
    return capture;
  }

  // Each case catches a named omission of the native player, through its rendered surface.
  it('matches the constant vignette and grain', async () => { await compare(base(), 0.75); });
  it('matches hold, push, pan, a planned rotating beat snap and cover-fitted footage breathing', async () => {
    for (const move of ['hold', 'push', 'pan']) await compare(base({ ...still, stillMove: move }), 1.25, { name: move });
    await compare(base({ ...still, camera: { move: 'dutch-roll', speed: 'fast', onBeat: true } }), 1.25, { name: 'beat-snap' });
    await compare(base({ ...still, visualLayer: 'footage', videoHistoryId: 'clip' }), 1.25, { name: 'footage-breathing' });
  });
  it('repaints paused footage when presentation follows the seeked paint', async () => {
    // Pin the observed ordering without sleeps: seeked/readyState can precede
    // the drawable frame. Release the real compositor callbacks only after the
    // native canvas has painted that unavailable frame, with no new media event.
    await native.evaluate(() => {
      const drawImage = CanvasRenderingContext2D.prototype.drawImage;
      const requestFrame = HTMLVideoElement.prototype.requestVideoFrameCallback;
      const held = new Map();
      window.latePresentation = { released: true, draws: 0, frames: 0 };
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
        return requestFrame.call(this, (now, metadata) => {
          if (window.latePresentation.released) callback(now, metadata);
          else { held.set(callback, () => callback(now, metadata)); window.latePresentation.frames++; }
        });
      };
      CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
        if (source instanceof HTMLVideoElement && !window.latePresentation.released) {
          if (this.canvas.dataset.testid === 'document-template-canvas') window.latePresentation.draws++;
          return;
        }
        return drawImage.call(this, source, ...args);
      };
      window.releasePresentation = () => {
        window.latePresentation.released = true;
        for (const callback of held.values()) callback();
        held.clear();
      };
      window.restorePresentation = () => {
        window.releasePresentation();
        CanvasRenderingContext2D.prototype.drawImage = drawImage;
        HTMLVideoElement.prototype.requestVideoFrameCallback = requestFrame;
      };
    });
    try {
      const value = base({ ...still, visualLayer: 'footage', videoHistoryId: 'clip' });
      await compare(value, 1.25);
      await native.evaluate(() => { window.latePresentation.released = false; });
      await compare(value, 2.25, {
        reuse: true,
        beforeCapture: async () => {
          await native.waitForFunction(() => window.latePresentation.draws > 0 && window.latePresentation.frames > 0
            && document.querySelector('video')?.dataset.pausedFrame === String(document.querySelector('video')?.currentTime));
          await native.evaluate(() => window.releasePresentation());
        },
      });
    } finally { await native.evaluate(() => window.restorePresentation()); }
  });
  it('matches the beat punch and the high-energy downbeat glitch under the finish', async () => {
    const value = base(); value.audioAnalysis.sections[0].label = 'Chorus';
    value.audioAnalysis.features = { envelopes: { fps: 24, rms: Array(96).fill(1) } };
    await compare(value, 1); await compare(value, 1 + 2 / 24);
  });
  it('honors video and shot template-effect controls, including zero and inherited overrides', async () => {
    const value = base(); value.audioAnalysis.sections[0].label = 'Chorus';
    value.audioAnalysis.features = { envelopes: { fps: 24, rms: Array(96).fill(1) } };
    value.templateEffects = { beatReaction: 0, stillMotion: 0, footagePush: 0, grain: 0, vignette: 0 };
    await compare(value, 1);
    value.scenes[0].templateEffects = { beatReaction: 0.6, stillMotion: 0.4, grain: 0.14, vignette: 0.2 };
    await compare(value, 1 + 2 / 24);
    value.scenes[0] = { ...still, visualLayer: 'footage', videoHistoryId: 'clip' };
    await compare(value, 1.25);
    value.scenes[0].templateEffects = { footagePush: 0.4, beatReaction: 0.6 };
    await compare(value, 1.25);
  });
  it('matches the card painter including its intro and exit fades', async () => {
    const value = base({ ...still, visualLayer: 'card', cardText: 'Example card', cardColor: '#243b71' });
    for (const t of [1 / 24, 1.25, 3 + 23 / 24]) await compare(value, t);
  });
  // Pins both painters at downbeats so native-only or engine-only control regressions fail.
  it.each(['Verse', 'Chorus'])('matches card beat-reaction inheritance in %s', async label => {
    const value = base({ ...still, visualLayer: 'card', cardText: 'Example card', cardColor: '#243b71' });
    value.audioAnalysis.sections[0].label = label;
    value.audioAnalysis.features = { envelopes: { fps: 24, rms: Array(96).fill(1) } };
    value.templateEffects = { beatReaction: 0 };
    await compare(value, 1);
    value.scenes[0].templateEffects = { beatReaction: 1 };
    await compare(value, 1);
    value.templateEffects.beatReaction = 1;
    value.scenes[0].templateEffects.beatReaction = 0;
    await compare(value, 3);
  });
  it('matches HUD marks, title lines, REC, meter, ticker and timecode', async () => {
    const value = base(); value.composition.overlay = { enabled: true, titleLines: ['EXAMPLE', 'Native parity'], meter: { label: 'LEVEL', keyframes: [[0, 10], [4, 90]] }, ticker: ['Example ticker'], timecodeStartSec: 3600 };
    await compare(value, 1.25); await compare(value, 3.25);
  });
  it('waits for image effects while the page is interactive and the module is pending', async () => {
    current = base({ ...still, imageEffect: 'flash-develop', imageEffectSec: 1 });
    engineData = dataFor(current);
    const imageEffects = '**/engine/musicVideoImageEffects.js';
    const release = Promise.withResolvers();
    const holdModule = async route => {
      await release.promise;
      await route.continue();
    };
    await engine.route(imageEffects, holdModule);
    try {
      await engine.goto(`http://127.0.0.1:${server.address().port}/engine/index.html`, { waitUntil: 'commit' });
      await engine.waitForFunction(() => document.readyState === 'interactive' && window.PORTOS_LYRIC_TYPE && window.portosComposition);
      const beforeModule = await engine.evaluate(async () => {
        await document.fonts.ready;
        window.imageEffectSeek = window.portosComposition.seek(0.1).then(() => 'rendered', error => error.message);
        return Promise.race([
          window.imageEffectSeek,
          new Promise(resolve => requestAnimationFrame(() => resolve('waiting'))),
        ]);
      });
      expect(beforeModule).toBe('waiting');
      release.resolve();
      expect(await engine.evaluate(() => window.imageEffectSeek)).toBe('rendered');
    } finally {
      release.resolve();
      await engine.unrouteAll({ behavior: 'wait' });
    }
  });

  it('preserves image-effect and selected-glitch drawing order', async () => {
    await compare(base({ ...still, imageEffect: 'flash-develop', imageEffectSec: 1 }), 2 / 24);
    await compare(base({ ...still, imageEffect: 'end-fade', imageEffectSec: 1, endImageId: 'end.png' }), 3.5);
    await compare(base({ ...still, glitches: [{ atSec: 1, style: 'color-split', lengthSec: 0.25 }] }), 1.125);
  });
  it('wipes the outgoing scene before applying the incoming frame finish', async () => {
    const value = base({ ...still, endSec: 2, wipeOut: { style: 'push-left', lengthSec: 0.5 } });
    value.scenes.push({ ...still, sceneId: 'second', order: 1, startSec: 2, endSec: 4, referenceImageId: 'end.png' });
    expect(dataFor(value).scenes[1].wipe).toMatchObject({ style: 'push-left', cutFrame: 48 });
    await compare(value, 2.125);
  });
  it('invalidates a held wipe picture when seeking between different cuts', async () => {
    const value = base({ ...still, endSec: 1.5, wipeOut: { style: 'push-left', lengthSec: 0.5 } });
    value.scenes.push({ ...still, sceneId: 'second', order: 1, startSec: 1.5, endSec: 3, referenceImageId: 'end.png', wipeOut: { style: 'push-left', lengthSec: 0.5 } },
      { ...still, sceneId: 'third', order: 2, startSec: 3, endSec: 4 });
    await compare(value, 35 / 24);
    await compare(value, 3.125, { reuse: true });
    await compare(value, 1.625, { reuse: true });
  });
  it('rebuilds a same-cut wipe hold when seeking from an early outgoing frame', async () => {
    const value = base({ ...still, stillMove: 'push', endSec: 2, wipeOut: { style: 'push-left', lengthSec: 0.5 } });
    value.scenes.push({ ...still, sceneId: 'second', order: 1, startSec: 2, endSec: 4, referenceImageId: 'end.png' });
    await compare(value, 0.5);
    await compare(value, 2.125, { reuse: true });
  });
  it('retains outgoing footage when playback skips the last frame before a wipe', async () => {
    const value = base({ ...still, visualLayer: 'footage', videoHistoryId: 'uniform', endSec: 2, wipeOut: { style: 'push-left', lengthSec: 0.5 } });
    value.scenes.push({ ...still, sceneId: 'second', order: 1, startSec: 2, endSec: 4, referenceImageId: 'end.png' });
    await compare(value, 0.5);
    await compare(value, 2.125, { reuse: true, clockJump: true });
  });
  it('uses the render aspect for square and portrait camera moves and HUD', async () => {
    for (const aspectRatio of ['1:1', '9:16']) {
      const value = base({ ...still, camera: { move: 'dutch-roll', speed: 'fast' } }, { treatment: { brief: { aspectRatio } } });
      value.composition.overlay = { enabled: true, titleLines: ['EXAMPLE'] };
      await compare(value, 1.25);
    }
  });
  it('keeps the title pixels while the local Lyrics toggle hides sung words', async () => {
    const value = base(still, { titleCard: { enabled: true, title: 'EXAMPLE TITLE', startSec: 0, endSec: 4 } });
    value.lyricCues = [{ text: 'Example sung words', startSec: 0.25, endSec: 3.5 }];
    await compare(value, 1.25, { words: true, lyricsOff: true });
  });
  it('matches hook priority over sung lyrics, subtitle replacement, and hooks without sung lyrics', async () => {
    const value = base(); value.composition.textCues = [{ text: 'EXAMPLE HOOK', startSec: 1, endSec: 2, emphasis: 'hero', placement: 'center' }];
    value.composition.style = { color: '#e1ffc2' };
    value.lyricCues = [{ text: 'Example sung words', startSec: 0.25, endSec: 3.5, words: [{ text: 'Example', startSec: 0.25, endSec: 0.75 }, { text: 'sung', startSec: 0.75, endSec: 2 }, { text: 'words', startSec: 2, endSec: 3.5 }] }];
    await compare(value, 1.25, { words: true }); await compare(value, 2.75, { words: true });
    value.composition.textCues.push({ text: 'Example subtitle', startSec: 2.5, endSec: 3.8, emphasis: 'normal' });
    await compare(value, 2.75, { words: true });
    value.lyricCues = []; await compare(value, 1.25, { words: true });
    value.treatment = { brief: { aspectRatio: '9:16' } };
    await compare(value, 1.25, { words: true, reuse: true });
  });
  it('retains each failed pixel comparison with detached media and capture-time state', async () => {
    const capture = await compare(base({ ...still, visualLayer: 'footage', videoHistoryId: 'clip' }), 1.25);
    const destination = join(dir, 'diagnostics-proof');
    // Exercise the real assertion-failure writer without depending on the
    // intermittent renderer failure: invert only this captured expected image.
    const expected = await sharp(capture.expected).negate().png().toBuffer();
    vi.stubEnv('PORTOS_CI_DIAGNOSTICS_PATH', join(destination, 'run.json'));
    vi.stubEnv('PORTOS_CI_DIAGNOSTICS_DIR', undefined);
    try {
      for (let i = 0; i < 2; i++) await expect(assertParity({ ...capture, expected })).rejects.toThrow('mean RGB error');
    } finally { vi.unstubAllEnvs(); }
    const { readdir } = await import('node:fs/promises');
    const cases = await readdir(join(destination, 'template-parity'));
    expect(cases).toHaveLength(2);
    for (const name of cases) {
      const output = join(destination, 'template-parity', name);
      expect(await readFile(join(output, 'native.png'))).toEqual(capture.actual);
      expect(await readFile(join(output, 'engine.png'))).toEqual(expected);
      const evidence = JSON.parse(await readFile(join(output, 'parity.json'), 'utf8'));
      expect(evidence.environment.browser).toBe(fixture.browser.version());
      expect(evidence.diff.mean).toBeGreaterThan(0.3);
      expect(evidence.native.before.clock.currentTime).toBeCloseTo(capture.metadata.t);
      expect(evidence.native.after.videos.some(video => video.connected && video.readyState >= 2 && video.events.some(event => event.type === 'seeked'))).toBe(true);
      expect(evidence.engine.after.videos.some(video => !video.connected && video.readyState >= 2 && video.events.some(event => event.type === 'seeked'))).toBe(true);
      for (const surface of ['native', 'engine']) {
        expect(evidence[surface].before.canvases.some(canvas => canvas.sources.some(source => source.tag === 'VIDEO'))).toBe(true);
        expect(evidence[surface].after.at).toBeGreaterThanOrEqual(evidence[surface].before.at);
        expect(evidence[surface].after.videos[0]).toHaveProperty('presented');
      }
    }
  });
});
