/** Actual review controls + router/file store + Chrome/ffmpeg proof. No provider or live data. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots, sweepStrayTempRoots } from '../lib/mockPathsDataRoot.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { browserSuiteCanRun } from '../lib/browserSuiteGate.js';

vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('mv-review-browser-') }));
vi.mock('../services/instanceIdentity.js', () => ({ ensureInstanceId: async () => 'synthetic-instance' }));
vi.mock('../services/settings.js', () => ({ getSettings: async () => ({}) }));
vi.mock('../services/auth.js', () => ({ isAuthEnabled: async () => true, verifyPassword: async p => p === 'synthetic-password', verifyRequestSessionIdentity: async () => ({ kind: 'session', sessionId: 'synthetic-browser', label: null }) }));
let endpoint;
vi.mock('../services/browserService.js', () => ({ loadConfig: async () => ({ chromePath: chrome }), cdpRequest: path => fetch(`${endpoint}${path}`) }));
const { findFfmpeg } = await import('../lib/ffmpeg.js');
const { _testChromeCaptureArgs, _waitForTestChrome, _cleanupTestBrowser } = await import('../services/htmlComposition/testBrowserCleanup.js');
const chrome = [process.env.CHROME_PATH, chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(p => p && existsSync(p));
const ffmpeg = await findFfmpeg();
// Server-only CI intentionally does not install the client workspace. This
// cross-workspace visual test runs when all three local QA prerequisites exist.
const client = resolve(import.meta.dirname, '../../client');
const requireClient = createRequire(join(client, 'package.json'));
let clientBundler;
try {
  clientBundler = ['vite', '@vitejs/plugin-react', '@tailwindcss/postcss'].map(name => requireClient.resolve(name));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

// Dependency discovery can read the mocked PATHS through ffmpeg imports.
// Vitest does not run afterAll when the whole suite is skipped.
const canRun = browserSuiteCanRun('musicVideo browser suite', { Chrome: chrome, ffmpeg, 'client workspace dependencies': clientBundler }, { onUnavailable: cleanupTempDataRoots });

let browser, proc, server;
afterAll(async () => {
  await _cleanupTestBrowser({ browser, proc, cleanup: () => {} });
  if (server) await new Promise(resolve => server.close(resolve));
  cleanupTempDataRoots();
  // A just-killed Chrome helper can recreate the data root after removal; CI's Linux run left one (#10312).
  await sweepStrayTempRoots('mv-review-browser-');
});

describe.skipIf(!canRun)('production review in a real browser (Chrome, ffmpeg and client dependencies required)', () => {
  it('reviews, requests targeted revisions, renders and watches real animated evidence before approval', async () => {
    const { PATHS } = await import('../lib/paths.js');
    const { default: router } = await import('./musicVideo.js');
    const store = await import('../services/musicVideo/projects.js');
    const { saveGeneratedDevArtifact } = await import('../services/musicVideo/devArtifactService.js');
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=10', join(PATHS.music, 'synthetic-master.wav')]);
    const p = await store.createProject({ name: 'Example paper doorway', uploadedAudioFilename: 'synthetic-master.wav', composition: { mode: 'code' } });
    await store.setProjectAnalysis(p.id, { durationSec: 10, bpm: 120, beats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], downbeats: [0, 4, 8], sections: [{ id: 'chorus', label: 'Chorus', startSec: 0, endSec: 10 }] });
    await store.updateProject(p.id, { lyricCues: [{ id: 'line', text: 'Open the doorway', startSec: 1, endSec: 7, words: [{ conf: 'matched', w: 'Open', startSec: 1, endSec: 3 }, { conf: 'matched', w: 'the', startSec: 3, endSec: 4 }, { conf: 'matched', w: 'doorway', startSec: 4, endSec: 7 }] }] });
    const scene = await store.addProjectScene(p.id, { label: 'Chorus', startSec: 0, endSec: 10, prompt: 'A paper doorway opens onto a copper sky.' });
    const { buildCodeTimeline } = await import('../services/musicVideo/codeTimeline.js');
    const sectionId = buildCodeTimeline(await store.getProject(p.id)).sections[0].id;
    await store.updateProject(p.id, { composition: { mode: 'code', codeVideo: { sections: [{ id: sectionId, source: `function render(ctx, env) {
      const w=env.width,h=env.height,t=env.t||0;
      ctx.fillStyle='#151e35';ctx.fillRect(0,0,w,h);
      for(let i=0;i<9;i++){ctx.fillStyle=i%2?'#25314b':'#1d2940';ctx.fillRect(i*w/9,0,w/11,h);}
      const x=w*.34,y=h*.12,dw=w*.32,dh=h*.72;
      ctx.fillStyle='#d59655';ctx.fillRect(x,y,dw,dh);
      ctx.fillStyle='#f1dbb0';ctx.fillRect(x+12,y+12,dw-24,dh-24);
      ctx.fillStyle='#28354b';ctx.fillRect(x+12,y+12,(dw-24)*(1-Math.min(1,t/8)),dh-24);
      ctx.strokeStyle='#b68e60';ctx.lineWidth=4;ctx.strokeRect(x-8,y-8,dw+16,dh+16);
      ctx.fillStyle='#0b1425';ctx.beginPath();ctx.ellipse(w*.52,h*.88,w*.24,h*.05,0,0,Math.PI*2);ctx.fill();
      const fx=w*(.21+.035*t);ctx.fillStyle='#ddc49e';ctx.beginPath();ctx.arc(fx,h*.48,h*.028,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='#a46742';ctx.fillRect(fx-h*.025,h*.51,h*.05,h*.12);
      ctx.strokeStyle='#ddc49e';ctx.lineWidth=h*.012;ctx.beginPath();ctx.moveTo(fx,h*.53);ctx.lineTo(fx+h*.07,h*.48+Math.sin(t)*h*.015);ctx.stroke();
      ctx.strokeStyle='#1a2234';ctx.lineWidth=h*.015;ctx.beginPath();ctx.moveTo(fx-h*.016,h*.63);ctx.lineTo(fx-h*.025,h*.75);ctx.moveTo(fx+h*.016,h*.63);ctx.lineTo(fx+h*.025,h*.75);ctx.stroke();
      ctx.fillStyle='#f1dbb0';ctx.font='600 '+Math.round(h*.025)+'px sans-serif';ctx.fillText('CHORUS / THE THRESHOLD',w*.05,h*.08);
    }` }] } } });
    const { artifact } = await saveGeneratedDevArtifact(p.id, { kind: 'cast-sets', title: 'Static concept reference — paper doorway', html: '<html><body><h1>Static concept reference</h1><svg viewBox="0 0 600 300"><rect width="600" height="300" fill="#151e35"/><rect x="200" y="30" width="160" height="220" fill="#d59655"/></svg></body></html>' });
    const draft = { cast: 'Small paper operator in a copper vest.', environments: 'Indigo archive, layered door and warm sky.', visualLanguage: 'Cream paper, copper light, readable negative space.', motionLanguage: 'Operator reaches toward door; doorway opens through chorus.', guideArtifactId: artifact.id, lyricsMode: 'vocal', timingStatus: 'verified', timingNotes: 'Synthetic fixture word timings verified.', storyboard: [{ sceneId: scene.sceneId, lyricCueIds: ['line'], action: 'Open the door', staging: 'Operator left, door center', camera: 'Hold wide with layered depth', transition: 'Hold open doorway' }] };
    const { saveProductionDraft } = await import('../services/musicVideo/productionReviewService.js');
    await saveProductionDraft(p.id, draft);

    const ui = join(PATHS.data, 'review-ui'); await mkdir(ui, { recursive: true });
    const entry = `import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';import Panel from './src/components/musicVideo/ProductionReviewPanel.jsx';import useReview from './src/hooks/useMusicVideoProductionReview.js';const STEPS=[['art','Look step'],['storyboard','Storyboard step'],['proof','Make step']];function App(){const[p,setP]=useState(null);const[stage,setStage]=useState('art');const planning=useState(null);useEffect(()=>{fetch('/api/music-video/${p.id}/production-review').then(r=>r.json()).then(r=>setP(r.project))},[]);const review=useReview({project:p,replaceProject:setP});return p?<main style={{maxWidth:1100,margin:'auto',padding:24}}><h1>Music video production review</h1><nav>{STEPS.map(([id,name])=><button key={id} type="button" aria-pressed={stage===id} onClick={()=>setStage(id)}>{name}</button>)}</nav><Panel key={stage} project={p} review={review} stage={stage} planning={planning} onOpenArtifact={id=>window.open('/api/music-video/${p.id}/dev-artifacts/'+id+'/file')}/></main>:null}createRoot(document.getElementById('root')).render(<App/>);`;
    const { build } = await import(clientBundler[0]);
    const { default: react } = await import(clientBundler[1]);
    const { default: tailwind } = await import(clientBundler[2]);
    const { symlink } = await import('node:fs/promises');
    await symlink(join(client, 'node_modules'), join(ui, 'node_modules'), 'dir');
    await writeFile(join(ui, 'entry.jsx'), `import ${JSON.stringify(join(client, 'src/index.css'))};\n` + entry.replaceAll("'./src/", `'${client}/src/`));
    await writeFile(join(ui, 'index.html'), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await build({ configFile: false, root: ui, plugins: [react()], css: { postcss: { plugins: [tailwind({ base: client })] } }, build: { outDir: join(ui, 'dist'), emptyOutDir: true }, logLevel: 'warn' });
    const app = express(); app.use(express.json()); app.use('/api/music-video', router); app.use('/data/videos', express.static(PATHS.videos)); app.use('/fonts', express.static(join(client, 'public/fonts'))); app.use(express.static(join(ui, 'dist'))); app.use(errorMiddleware);
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    proc = spawn(chrome, _testChromeCaptureArgs(join(PATHS.data, 'test-chrome')), { stdio: ['ignore', 'ignore', 'pipe'] });
    endpoint = new URL(await _waitForTestChrome(proc)).origin.replace('ws:', 'http:');
    browser = await chromium.connectOverCDP(endpoint);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    expect(await page.locator('input[type=password]').count()).toBe(0);
    await page.getByRole('button', { name: 'Approve art direction', exact: true }).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === 'Approve art direction')?.disabled);
    if (process.env.MUSIC_VIDEO_REVIEW_EVIDENCE_DIR) {
      await mkdir(process.env.MUSIC_VIDEO_REVIEW_EVIDENCE_DIR, { recursive: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: join(process.env.MUSIC_VIDEO_REVIEW_EVIDENCE_DIR, 'art-context-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 1000 });
    }
    await page.getByRole('button', { name: 'Approve art direction', exact: true }).click();
    // Each step's panel records feedback against its own approval.
    await page.getByRole('button', { name: 'Storyboard step', exact: true }).click();
    await page.getByText('Review feedback and revision history', { exact: true }).click();
    await page.getByLabel('Feedback target').fill('shot: chorus / operator');
    await page.getByLabel('Requested change').fill('Move the operator behind the threshold at the exit.');
    await page.getByRole('button', { name: 'Save revision feedback' }).click();
    await page.getByText('Move the operator behind the threshold at the exit.', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Approve lyric-timed storyboard' }).isDisabled()).toBe(true);
    await page.getByLabel('How it was resolved (optional)').fill('Reviewed the updated staging in the storyboard.');
    await page.getByRole('button', { name: 'Mark resolved' }).click();
    await page.getByText('Resolution: Reviewed the updated staging in the storyboard.', { exact: true }).waitFor();
    const beforeBoard = await page.evaluate(async id => (await fetch('/api/music-video/' + id + '/production-review')).json(), p.id);
    expect(beforeBoard.readiness.storyboard.problems).toEqual([]);
    await page.getByRole('button', { name: 'Approve lyric-timed storyboard' }).click();
    await page.getByRole('heading', { name: 'Lyric-timed storyboard approved', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Make step', exact: true }).click();
    await page.getByRole('button', { name: 'Render animated proof' }).click();
    await page.locator('video').waitFor({ timeout: 120000 });
    await page.locator('video').evaluate(async video => { await video.play(); await new Promise(r => setTimeout(r, 400)); video.pause(); });
    expect(await page.locator('video').evaluate(v => v.videoWidth)).toBeGreaterThan(0);
    expect(await page.getByRole('checkbox', { name: /I watched this revision/ }).count()).toBe(0);
    await page.getByRole('button', { name: 'Approve proof — watched with sound' }).click();
    await page.getByRole('heading', { name: 'Animated proof approved', exact: true }).waitFor();
    const result = await store.getProject(p.id);
    expect(Object.keys(result.productionReview.approvals).sort()).toEqual(['art', 'proof', 'storyboard']);
    expect(result.productionReview.feedback[0].resolvedAt).toBeTruthy();
    expect(result.productionReview.approvals.proof.proofReview).toMatchObject({ watchedWithAudio: true, excerptId: result.productionReview.proof.excerptId });
    // Approved straight after playback: no notes were typed or required.
    expect(result.productionReview.approvals.proof.proofReview.timecodedNotes).toBeUndefined();
    expect(errors).toEqual([]);
    const proofFile = join(PATHS.videos, result.excerpts.find(e => e.id === result.productionReview.proof.excerptId).filename);
    const frame = at => execFileSync(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', proofFile, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const middle = frame(5);
    expect([...middle].filter((_, i) => i % 3 === 0 && middle[i] > middle[i + 2] + 40).length).toBeGreaterThan(150); // warm doorway occupies the stage, not the host's fallback dot
    expect(frame(2).equals(frame(7))).toBe(false); // actual authored motion changes the scene
    if (process.env.MUSIC_VIDEO_REVIEW_EVIDENCE_DIR) {
      await mkdir(process.env.MUSIC_VIDEO_REVIEW_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.MUSIC_VIDEO_REVIEW_EVIDENCE_DIR, 'review-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(process.env.MUSIC_VIDEO_REVIEW_EVIDENCE_DIR, 'review-mobile.png'), fullPage: true });
      const excerpt = result.excerpts.find(e => e.id === result.productionReview.proof.excerptId);
      await copyFile(join(PATHS.videos, excerpt.filename), join(process.env.MUSIC_VIDEO_REVIEW_EVIDENCE_DIR, 'synthetic-chorus-proof.mp4'));
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', '5', '-i', join(PATHS.videos, excerpt.filename), '-frames:v', '1', join(process.env.MUSIC_VIDEO_REVIEW_EVIDENCE_DIR, 'proof-frame.png')]);
    }
  }, 180000);
});
