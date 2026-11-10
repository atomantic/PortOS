import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import express from 'express';
import sharp from 'sharp';
import { chromium } from 'playwright-core';
import { startOwnedBrowserFixture } from '../../test/browserFixture.js';
import { createOwnedFixtureSetup } from '../../test/ownedFixtureSetup.js';
import { browserSuiteCanRun, resolveTestChrome, resolveClientBundler } from '../../lib/browserSuiteGate.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { narrativeFrameState } from '../../lib/musicVideoNarrativeEvents.js';
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
let dir, server, fixture, native, engine, current, engineData;
const errors = [];
const setup = createOwnedFixtureSetup({ cleanup: async () => {
  const results = await Promise.allSettled([fixture?.close(), server && new Promise((done, reject) => server.close(error => error ? reject(error) : done()))]);
  results.push(...await Promise.allSettled([dir && rm(dir, { recursive: true, force: true })]));
  const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, 'Native parity fixture cleanup failed');
} });
afterAll(() => setup.close());

const dataFor = (project, media = new Map()) => buildDocumentData(project, { media, frame: DOCUMENT_FRAME_SIZES[documentAspect(project)], clock: documentRenderClock(4, 24), songDurationSec: 4 });

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
      const { build } = await import(bundlers[0]); const { default: react } = await import(bundlers[1]); const { default: tailwind } = await import(bundlers[2]);
      await build({ configFile: false, root: dir, publicDir: join(client, 'public'), plugins: [react()], css: { postcss: { plugins: [tailwind({ base: client })] } }, build: { outDir: join(dir, 'dist'), emptyOutDir: true }, logLevel: 'warn' });
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
      app.get('/engine/portos-mv.js', (_req, res) => res.type('js').send(`window.PORTOS_MV=${JSON.stringify(engineData)};window.PORTOS_MV_EVENT_STATE=${narrativeFrameState.toString()};${documentRenderInitScripts(current).join('\n')}`));
      app.get('/engine/media/:file', (req, res) => {
        const scene = engineData.scenes.find(s => s.media?.src === `media/${req.params.file}`);
        const selected = current.scenes.find(s => s.sceneId === scene?.sceneId);
        const name = req.params.file.endsWith('.webm') ? selected?.videoHistoryId === 'uniform' ? 'uniform.webm' : 'clip.webm' : req.params.file.includes('-end.') ? 'end.png' : selected?.referenceImageId || 'grid.png';
        res.sendFile(join(dir, name));
      });
      app.use('/engine', express.static(join(templates, 'layered')), express.static(join(templates, 'shared')), express.static(join(root, 'server/lib')));
      app.get('/api/video-gen/history/:id', (req, res) => res.json({ id: req.params.id, filename: req.params.id === 'uniform' ? 'uniform.webm' : 'clip.webm', fps: 24, width: 240, height: 240, numFrames: 96 }));
      app.get('/api/music-video/:id/lyrics/overlay/preview', async (_req, res, next) => { await buildLyricPlaythroughPreview(current, { overlay: true }).then(value => res.json(value)).catch(next); });
      app.get('/data/images/:file', (req, res) => res.sendFile(join(dir, req.params.file)));
      app.get('/data/videos/:file', (req, res) => res.sendFile(join(dir, req.params.file === 'uniform.webm' ? 'uniform.webm' : 'clip.webm')));
      app.get('/song.wav', (_req, res) => res.sendFile(join(dir, 'song.wav')));
      app.use(express.static(join(dir, 'dist')));
      await new Promise((done, reject) => { server = app.listen(0, '127.0.0.1', done); server.once('error', reject); });
    });
    await phase('browser', async () => {
      fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true, args: ['--force-color-profile=srgb'] } });
      native = await fixture.browser.newPage({ viewport: { width: 640, height: 700 } });
      engine = await fixture.browser.newPage({ viewport: { width: 640, height: 360 } });
      for (const page of [native, engine]) page.on('pageerror', error => errors.push(error.message));
      await native.goto(`http://127.0.0.1:${server.address().port}`);
      await native.waitForFunction(() => typeof window.show === 'function');
    });
  }), 30000);

  async function compare(project, t, { words = false, reuse = false, clockJump = false } = {}) {
    // Media elements store microseconds; use a frame's centre so rounding a
    // fractional 24fps boundary cannot move the native clock back one frame.
    t = (Math.floor(t * 24 + 1e-6) + 0.5) / 24;
    current = project;
    const media = new Map(project.scenes.filter(s => s.visualLayer !== 'card').map(s => [s.sceneId, { kind: s.videoHistoryId ? 'video' : 'image', ext: s.videoHistoryId ? 'webm' : 'png', fps: 24, ...(s.endImageId ? { end: { kind: 'image', ext: 'png' } } : {}) }]));
    engineData = dataFor(project, media);
    await engine.setViewportSize({ width: 640, height: Math.round(640 * engineData.render.height / engineData.render.width) });
    await engine.goto(`http://127.0.0.1:${server.address().port}/engine/index.html`);
    await engine.waitForFunction(() => !!window.portosComposition);
    await engine.evaluate(t => window.portosComposition.seek(t), t);
    if (clockJump) await native.evaluate(() => {
      // Advance the playing clock without a seek event: this case owns a dropped
      // playback frame, while the neighboring seek tests own scrub invalidation.
      const audio = document.querySelector('audio'); let clock = audio.currentTime;
      Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => clock, set: value => { clock = value; } });
    });
    await native.evaluate(({ project, data, t, reuse }) => (reuse ? window.update : window.show)(project, data, t), { project, data: dataFor(project), t, reuse });
    await native.waitForFunction(frame => document.querySelector('[data-testid="document-template-canvas"]')?.dataset.songFrame === String(frame), Math.floor(t * 24 + 1e-6));
    await native.evaluate(() => document.fonts.ready);
    const currentScene = project.scenes.filter(s => s.startSec <= t && t < s.endSec).at(-1);
    if (currentScene?.visualLayer === 'footage' && currentScene.videoHistoryId) await native.waitForFunction(() => document.querySelector('video[data-ready="true"]')?.readyState >= 2);
    if (words) {
      await native.waitForSelector('[data-testid="animatic-lyrics"]');
      // Use the public seek bridge's response to know its exact lyric frame landed.
      await native.waitForFunction(t => window.lyricFrames.includes(t), Math.floor(t * 24 + 1e-6) / 24);
    }
    // A late image/video/font load repaints the native surface on its own event.
    await native.waitForFunction(() => [...document.querySelectorAll('figure img')].every(img => img.complete && img.naturalWidth));
    const actual = await native.locator('figure > div').first().screenshot();
    const expected = await engine.locator('#stage').screenshot();
    const a = await sharp(actual).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const b = await sharp(expected).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(a.info).toEqual(b.info);
    let sum = 0, changed = 0;
    for (let i = 0; i < a.data.length; i++) { const delta = Math.abs(a.data[i] - b.data[i]); sum += delta; if (delta > 12) changed++; }
    const diff = { mean: sum / a.data.length, changed: changed / a.data.length };
    if (diff.mean >= 0.3 || diff.changed >= 0.004) {
      const destination = process.env.PORTOS_CI_DIAGNOSTICS_DIR;
      if (destination) {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, 'native.png'), actual); await writeFile(join(destination, 'engine.png'), expected);
        await writeFile(join(destination, 'parity.json'), JSON.stringify({ t, diff, native: await native.evaluate(() => ({ clock: document.querySelector('audio').currentTime, frame: document.querySelector('[data-testid="document-template-canvas"]').dataset.songFrame, font: document.fonts.check('900 40px "MV Stencil"') })) }));
      }
    }
    expect(diff.mean, `mean RGB error at ${t}s`).toBeLessThan(0.3);
    expect(diff.changed, `RGB samples differing by >12 at ${t}s`).toBeLessThan(0.004);
    expect(errors).toEqual([]);
  }

  // Each case catches a named omission of the native player, through its rendered surface.
  it('matches the constant vignette and grain', async () => { await compare(base(), 0.75); });
  it('matches hold, push, pan, a planned rotating beat snap and cover-fitted footage breathing', async () => {
    for (const move of ['hold', 'push', 'pan']) await compare(base({ ...still, stillMove: move }), 1.25);
    await compare(base({ ...still, camera: { move: 'dutch-roll', speed: 'fast', onBeat: true } }), 1.25);
    await compare(base({ ...still, visualLayer: 'footage', videoHistoryId: 'clip' }), 1.25);
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
});
