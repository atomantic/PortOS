/** Actual review controls + router/file store + Chrome/ffmpeg proof. No provider or live data. */
import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { richSceneSource } from '../services/musicVideo/__richSceneFixture.js';
const author = vi.hoisted(() => ({ sectionId: null, prompt: '' }));
vi.mock('../services/promptRunner.js', () => ({
  assertProvider: () => {},
  resolveProviderAndModel: async () => ({ provider: { id: 'stub-provider', type: 'api', enabled: true }, selectedModel: 'fixture-model' }),
  runPromptThroughProvider: async ({ prompt }) => { author.prompt = prompt; return { text: JSON.stringify({ sections: [{ id: author.sectionId, source: richSceneSource }] }) }; },
}));
import { existsSync } from 'node:fs';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { browserSuiteCanRun } from '../lib/browserSuiteGate.js';

vi.mock('../lib/paths.js', async original => makePathsProxy(await original(), { dataRoot: () => lazyTempDataRoot('mv-rich-ui-browser-') }));
vi.mock('../services/instanceIdentity.js', () => ({ ensureInstanceId: async () => 'synthetic-instance' }));
vi.mock('../services/settings.js', () => ({ getSettings: async () => ({}) }));
vi.mock('../services/auth.js', () => ({ isAuthEnabled: async () => true, verifyRequestSessionIdentity: async () => ({ kind: 'session', sessionId: 'synthetic-browser', label: null }) }));
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

// Read-only dependency discovery can still initialize mocked path fixtures.
// Vitest skips cleanup hooks when no browser test can run.
const canRun = browserSuiteCanRun('musicVideo browser suite', { Chrome: chrome, ffmpeg, 'client workspace dependencies': clientBundler }, { onUnavailable: cleanupTempDataRoots });

let browser, proc, server;
afterAll(async () => {
  await _cleanupTestBrowser({ browser, proc, cleanup: () => {} });
  if (server) await new Promise(resolve => server.close(resolve));
  cleanupTempDataRoots();
});

describe.skipIf(!canRun)('rich document authoring in a real browser (Chrome, ffmpeg and client dependencies required)', () => {
  it('authors and accepts a Three.js world through the real UI and renders its reviewed proof', async () => {
    // Skipped suites do not run cleanup hooks: load data-owning services only here.
    const { PATHS } = await import('../lib/paths.js');
    const { default: router } = await import('./musicVideo.js');
    const store = await import('../services/musicVideo/projects.js');
    const { saveGeneratedDevArtifact } = await import('../services/musicVideo/devArtifactService.js');
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=10', join(PATHS.music, 'synthetic-master.wav')]);
    const p = await store.createProject({ name: 'Example paper doorway', uploadedAudioFilename: 'synthetic-master.wav', mediaMode: 'code-only', composition: { mode: 'document' } });
    await store.setProjectAnalysis(p.id, { durationSec: 10, bpm: 120, beats: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], downbeats: [0, 4, 8], sections: [{ id: 'chorus', label: 'Chorus', startSec: 0, endSec: 10 }] });
    await store.updateProject(p.id, { lyricCues: [{ id: 'line', text: 'Open the doorway', startSec: 1, endSec: 7, words: [{ conf: 'matched', w: 'Open', startSec: 1, endSec: 3 }, { conf: 'matched', w: 'the', startSec: 3, endSec: 4 }, { conf: 'matched', w: 'doorway', startSec: 4, endSec: 7 }] }] });
    const scene = await store.addProjectScene(p.id, { label: 'Chorus', startSec: 0, endSec: 10, prompt: 'A paper doorway opens onto a copper sky.' });
    const { buildCodeTimeline } = await import('../services/musicVideo/codeTimeline.js');
    const sectionId = buildCodeTimeline(await store.getProject(p.id)).sections[0].id;
    author.sectionId = sectionId;
    const { artifact } = await saveGeneratedDevArtifact(p.id, { kind: 'cast-sets', title: 'Static concept reference — paper doorway', html: '<html><body><h1>Static concept reference</h1><svg viewBox="0 0 600 300"><rect width="600" height="300" fill="#151e35"/><rect x="200" y="30" width="160" height="220" fill="#d59655"/></svg></body></html>' });
    const draft = { cast: 'Small paper operator in a copper vest.', environments: 'Indigo archive, layered door and warm sky.', visualLanguage: 'Cream paper, copper light, readable negative space.', motionLanguage: 'Operator reaches toward door; doorway opens through chorus.', guideArtifactId: artifact.id, lyricsMode: 'vocal', timingStatus: 'verified', timingNotes: 'Synthetic fixture word timings verified.', storyboard: [{ sceneId: scene.sceneId, lyricCueIds: ['line'], action: 'Open the door', staging: 'Operator left, door center', camera: 'Hold wide with layered depth', transition: 'Hold open doorway' }] };
    const { saveProductionDraft } = await import('../services/musicVideo/productionReviewService.js');
    await saveProductionDraft(p.id, draft);

    const ui = join(PATHS.data, 'review-ui'); await mkdir(ui, { recursive: true });
    const entry = `import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';import Panel from './src/components/musicVideo/ProductionReviewPanel.jsx';import DocumentPanel from './src/components/musicVideo/DocumentCompositionPanel.jsx';import useReview from './src/hooks/useMusicVideoProductionReview.js';const STEPS=[['art','Look step'],['storyboard','Storyboard step'],['proof','Make step']];function App(){const[p,setP]=useState(null);const[stage,setStage]=useState('art');const planning=useState(null);useEffect(()=>{fetch('/api/music-video/${p.id}/production-review').then(r=>r.json()).then(r=>setP(r.project))},[]);const review=useReview({project:p,replaceProject:setP});return p?<main style={{maxWidth:1100,margin:'auto',padding:24}}><h1>Music video production review</h1><DocumentPanel project={p} onProject={setP} onSave={async patch=>{const r=await fetch('/api/music-video/${p.id}',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});setP(await r.json())}}/><nav>{STEPS.map(([id,name])=><button key={id} type="button" aria-pressed={stage===id} onClick={()=>setStage(id)}>{name}</button>)}</nav><Panel key={stage} project={p} review={review} stage={stage} planning={planning} onOpenArtifact={id=>window.open('/api/music-video/${p.id}/dev-artifacts/'+id+'/file')}/></main>:null}createRoot(document.getElementById('root')).render(<App/>);`;
    const { build } = await import(clientBundler[0]);
    const { default: react } = await import(clientBundler[1]);
    const { default: tailwind } = await import(clientBundler[2]);
    const { symlink } = await import('node:fs/promises');
    await symlink(join(client, 'node_modules'), join(ui, 'node_modules'), 'dir');
    await writeFile(join(ui, 'entry.jsx'), `import ${JSON.stringify(join(client, 'src/index.css'))};\n` + entry.replaceAll("'./src/", `'${client}/src/`));
    await writeFile(join(ui, 'index.html'), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.jsx"></script></body></html>');
    await build({ configFile: false, root: ui, plugins: [react()], css: { postcss: { plugins: [tailwind({ base: client })] } }, build: { outDir: join(ui, 'dist'), emptyOutDir: true }, logLevel: 'warn' });
    const app = express(); app.use(express.json()); app.get('/api/providers', (req,res)=>res.json({activeProvider:'stub-provider',providers:[{id:'stub-provider',name:'Synthetic author',type:'api',enabled:true,models:['fixture-model'],defaultModel:'fixture-model',toolFreeOneShot:true}]})); app.use('/api/music-video', router); app.use('/data/videos', express.static(PATHS.videos)); app.use('/fonts', express.static(join(client, 'public/fonts'))); app.use(express.static(join(ui, 'dist'))); app.use(errorMiddleware);
    server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    proc = spawn(chrome, _testChromeCaptureArgs(join(PATHS.data, 'test-chrome')), { stdio: ['ignore', 'ignore', 'pipe'] });
    endpoint = new URL(await _waitForTestChrome(proc)).origin.replace('ws:', 'http:');
    browser = await chromium.connectOverCDP(endpoint);
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    // The harness mounts no Toaster, so a failed UI request is otherwise invisible: record every
    // API exchange (method, path, status, error code) and name the last ones when a wait times out.
    const trace = [];
    const inFlight = new Map();
    const apiLabel = request => `${request.method()} ${new URL(request.url()).pathname.replace(p.id, ':id')}`;
    page.on('request', request => { if (request.url().includes('/api/music-video/')) inFlight.set(request, Date.now()); });
    for (const event of ['requestfinished', 'requestfailed']) page.on(event, request => inFlight.delete(request));
    const loopDelay = monitorEventLoopDelay(); loopDelay.enable();
    page.on('response', async response => {
      const { pathname } = new URL(response.url());
      if (!pathname.startsWith('/api/music-video/')) return;
      const body = await response.json().catch(() => null);
      // Bounded, synthetic shape only: which pointers the response carried, never document contents.
      const shape = pathname.includes('/composition/document/') && body ? ` candidate=${body.candidate?.directory ?? body.project?.composition?.documentDraft?.directory ?? null} source=${body.source?.directory ?? body.document?.directory ?? null} stale=${body.stale ?? '-'}` : '';
      const failure = response.ok() ? '' : ` ${body?.code || ''} ${String(body?.error || body?.message || '').slice(0, 120)}`;
      trace.push(`${response.request().method()} ${pathname.replace(p.id, ':id')} -> ${response.status()}${failure}${shape}`);
    });
    const traced = async (label, wait) => {
      try { return await wait(); } catch (error) {
        const status = await page.evaluate(() => [...document.querySelectorAll('[role=status],[role=alert]')].map(el => el.textContent.trim().slice(0, 120)).filter(Boolean)).catch(() => []);
        // A starved renderer (same-origin preview iframes share its main thread) and a blocked server
        // loop look identical from a locator timeout; probe both.
        const renderer = await Promise.race([page.evaluate(() => 'responsive'), new Promise(r => setTimeout(r, 3000, 'main thread unresponsive for 3s'))]).catch(e => e.message);
        const ui = await page.evaluate(() => {
          const named = text => [...document.querySelectorAll('button')].filter(el => el.textContent.trim() === text);
          return { acceptButtons: named('Accept reviewed version').map(el => ({ disabled: el.disabled, shown: el.getClientRects().length > 0 })), generateLabel: document.querySelector('[aria-label="Composition document"] button.bg-port-accent')?.textContent.trim() ?? null, candidatePreview: document.body.textContent.includes('Candidate preview'), iframes: document.querySelectorAll('iframe').length };
        }, null, { timeout: 3000 }).catch(e => e.message);
        const loopMaxMs = Math.round(loopDelay.max / 1e6);
        throw new Error(`${label}: ${error.message}\nstill pending: ${JSON.stringify([...inFlight].map(([request, since]) => `${apiLabel(request)} (${Date.now() - since}ms)`))}\nrecent requests:\n  ${trace.slice(-12).join('\n  ')}\nui: ${JSON.stringify(ui)}\nrenderer: ${renderer}; server event-loop max delay ${loopMaxMs}ms\npage errors: ${JSON.stringify(errors)}\nvisible status: ${JSON.stringify(status)}`, { cause: error });
      }
    };
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    expect(await page.getByLabel('Design and composition media').count()).toBe(0); // media mode is chosen in Setup only
    await page.getByText('Document source', { exact: true }).click();
    await page.getByLabel('Authoring renderer').selectOption('three');
    expect((await store.getProject(p.id)).mediaMode).toBe('code-only');
    const choreography = 'Energy target: driving chorus with an expansive exit.\n0:00–0:04 / opening downbeats: operator steps toward the door and raises the key; camera pushes in; title lands on the first vocal.\n0:04–0:10 / chorus accent: key turns, door swings outward, operator crosses the threshold; camera arcs around the prop; type clears before the exit.\nRepeat chorus: widen the doorway and increase the operator travel while retaining the copper motif.';
    await page.getByText('Edit art direction and visual guide', { exact: true }).click();
    await page.getByLabel('Timed choreography and energy plan', { exact: true }).fill(choreography);
    const [savedPlan] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/production-review') && response.request().method() === 'PUT'),
      page.getByRole('button', { name: 'Save planning edits' }).click(),
    ]);
    expect(savedPlan.status()).toBe(200);
    expect((await store.getProject(p.id)).productionReview.draft.motionLanguage).toBe(choreography);
    expect(await page.locator('input[type=password]').count()).toBe(0);
    // Each approval is awaited: the next step is gated on it server-side, and a click that races its
    // own approval request fails silently (this harness mounts no Toaster to show the rejection).
    const approve = async (name, options = {}) => {
      const [approved] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/production-review/approve') && response.request().method() === 'POST'),
        page.getByRole('button', { name, ...options }).click(),
      ]);
      expect(approved.status()).toBe(200);
    };
    await approve('Approve art direction', { exact: true });
    const [planned] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/production-review/prepare') && response.request().method() === 'POST'),
      page.getByRole('button', { name: 'Draft art direction and shots' }).click(),
    ]);
    expect(planned.status()).toBe(200);
    expect((await store.getProject(p.id)).treatment.shotDirections[0].medium).toBe('procedural');
    author.sectionId = buildCodeTimeline(await store.getProject(p.id)).sections[0].id;
    // Each step's panel records feedback against its own approval.
    await page.getByRole('button', { name: 'Storyboard step', exact: true }).click();
    await page.getByText('Review feedback and revision history', { exact: true }).click();
    await page.getByLabel('Feedback target').fill('shot: chorus / operator');
    await page.getByLabel('Requested change').fill('Move the operator behind the threshold at the exit.');
    await page.getByRole('button', { name: 'Save revision feedback' }).click();
    await page.getByText('Move the operator behind the threshold at the exit.', { exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Approve lyric-timed storyboard' }).isDisabled()).toBe(true);
    await page.getByLabel('Resolution for shot: chorus / operator').fill('Reviewed the updated staging in the storyboard.');
    await page.getByRole('button', { name: 'Resolve feedback after review' }).click();
    await page.getByText('Resolution: Reviewed the updated staging in the storyboard.', { exact: true }).waitFor();
    const beforeBoard = await page.evaluate(async id => (await fetch('/api/music-video/' + id + '/production-review')).json(), p.id);
    expect(beforeBoard.readiness.storyboard.problems).toEqual([]);
    await approve('Approve lyric-timed storyboard');
    await page.getByRole('button', { name: 'Make step', exact: true }).click();
    // Generation response, then the candidate the panel fetches in response to the updated project.
    // Observing both names the failing hop, and they also assert the candidate pointer is the one just staged.
    // A load-sensitive timeout here (#9806) was seen once with the server event loop stalled ~12s while
    // both responses were healthy; root cause beyond that stall was not established.
    const apiResponse = (method, suffix) => page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname.endsWith(suffix));
    const [generated, candidate] = await traced('generation did not return a candidate', () => Promise.all([
      apiResponse('POST', '/composition/document/generate'),
      apiResponse('GET', '/composition/document/candidate'),
      page.getByRole('button', { name: 'Generate authored 3D composition' }).click(),
    ]));
    expect(generated.status()).toBe(201);
    const staged = (await generated.json()).document.directory;
    expect(candidate.status()).toBe(200);
    expect(await candidate.json()).toMatchObject({ candidate: { directory: staged }, source: { directory: staged }, stale: false, providerId: 'stub-provider' });
    await traced('the candidate response did not render a reviewable candidate', () => page.getByRole('button', { name: 'Accept reviewed version' }).waitFor());
    expect(author.prompt).toContain(JSON.stringify(choreography));
    // The generate response replaces the project, which refetches the candidate and the review readiness.
    // Clicking Accept while those are still in flight was seen to send no accept request under load, so
    // the click waits for the page's music-video requests to settle and the button to be enabled.
    await traced('the page did not settle after generation', async () => {
      const settleBy = Date.now() + 30000;
      while (inFlight.size && Date.now() < settleBy) await new Promise(r => setTimeout(r, 100));
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === 'Accept reviewed version' && !b.disabled));
    });
    const [accepted] = await Promise.all([
      apiResponse('POST', '/composition/document/accept'),
      page.getByRole('button', { name: 'Accept reviewed version' }).click(),
    ]);
    expect(accepted.status()).toBe(200);
    expect((await accepted.json()).document).toMatchObject({ directory: staged, source: { kind: 'generated' } });
    await traced('accepting the candidate did not select the generated document', () => page.waitForFunction(() => document.body.textContent.includes('generated ·')));
    expect((await store.getProject(p.id)).composition.document.source.kind).toBe('generated');
    await page.getByRole('button', { name: 'Render animated proof' }).click();
    await page.locator('video').waitFor({ timeout: 120000 });
    await page.locator('video').evaluate(async video => { await video.play(); await new Promise(r => setTimeout(r, 400)); video.pause(); });
    expect(await page.locator('video').evaluate(v => v.videoWidth)).toBeGreaterThan(0);
    expect(await page.locator('[aria-label="Saved choreography for proof comparison"]').textContent()).toContain(choreography);
    expect(await page.getByRole('button', { name: 'Approve proof — watched with sound' }).isDisabled()).toBe(true);
    await page.getByLabel('Playback energy compared with the saved plan').fill('The synthetic fixture demonstrates a driving chorus: the modeled subject changes pose and travels while the camera moves through the scene.');
    await page.getByLabel('Timecoded playback notes').fill('0:02 — subject enters the frame; 0:07 — pose and camera position differ and readable type remains clear. This is a synthetic workflow test, not artistic approval of a production video.');
    expect(await page.getByRole('checkbox', { name: /I watched this revision/ }).count()).toBe(0);
    await page.getByRole('button', { name: 'Approve proof — watched with sound' }).click();
    await page.getByRole('heading', { name: 'Animated proof approved', exact: true }).waitFor();
    const result = await store.getProject(p.id);
    expect(Object.keys(result.productionReview.approvals).sort()).toEqual(['art', 'proof', 'storyboard']);
    expect(result.productionReview.feedback[0].resolvedAt).toBeTruthy();
    expect(result.productionReview.approvals.proof.proofReview).toMatchObject({ watchedWithAudio: true, excerptId: result.productionReview.proof.excerptId, timecodedNotes: expect.stringContaining('0:02') });
    expect(errors).toEqual([]);
    const proofFile = join(PATHS.videos, result.excerpts.find(e => e.id === result.productionReview.proof.excerptId).filename);
    const frame = at => execFileSync(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', proofFile, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const middle = frame(5);
    expect([...middle].filter((_, i) => i % 3 === 0 && middle[i] > middle[i + 2] + 40).length).toBeGreaterThan(15); // authored warm character occupies the stage
    expect(frame(2).equals(frame(7))).toBe(false); // actual authored motion changes the scene
    if (process.env.MUSIC_VIDEO_RICH_UI_EVIDENCE_DIR) {
      await mkdir(process.env.MUSIC_VIDEO_RICH_UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.MUSIC_VIDEO_RICH_UI_EVIDENCE_DIR, 'review-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(process.env.MUSIC_VIDEO_RICH_UI_EVIDENCE_DIR, 'review-mobile.png'), fullPage: true });
      const excerpt = result.excerpts.find(e => e.id === result.productionReview.proof.excerptId);
      await copyFile(join(PATHS.videos, excerpt.filename), join(process.env.MUSIC_VIDEO_RICH_UI_EVIDENCE_DIR, 'synthetic-chorus-proof.mp4'));
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', '5', '-i', join(PATHS.videos, excerpt.filename), '-frames:v', '1', join(process.env.MUSIC_VIDEO_RICH_UI_EVIDENCE_DIR, 'proof-frame.png')]);
    }
  }, 180000);
});
