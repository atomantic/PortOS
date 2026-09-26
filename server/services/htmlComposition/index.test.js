import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/fileUtils.js';
import { loadHistory } from '../videoGen/history.js';
import { videoGenEvents } from '../videoGen/events.js';
import { renderComposition, cancel } from './index.js';

let endpoint;
vi.mock('../browserService.js', () => ({ cdpRequest: path => fetch(`${endpoint}${path}`) }));
vi.mock('../../lib/fileUtils.js', async importOriginal => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-html-composition-'),
}));

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));
const ffmpeg = await findFfmpeg();
let proc;
let browser;
let browserSession;

// The delayed paint is intentional test input: a screenshot before the seek
// promise settles MUST see the previous position, even on a fast machine.
const fixture = (extra = '', contract = '') => `<!doctype html><html><head>
<link rel="icon" href="/pixel.svg"><style>body { margin: 0; background: white; } #block { position:absolute; top:100px; width:40px; height:40px; background:rgb(255,0,0); }</style>
</head><body><div id="block"></div><script>
globalThis.portosComposition = { durationSec:1, fps:12, width:1280, height:720,
  async seek(t) { await new Promise(resolve => setTimeout(resolve, 150)); document.getElementById('block').style.left = (40 + t * 480) + 'px'; }, ${contract} };
${extra}</script></body></html>`;

async function composition(html = fixture()) {
  const directory = `compositions/${randomUUID()}`;
  await mkdir(join(PATHS.data, directory), { recursive: true });
  await writeFile(join(PATHS.data, directory, 'index.html'), html);
  await writeFile(join(PATHS.data, directory, 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  return { directory, jobId: randomUUID() };
}

describe.skipIf(!chrome || !ffmpeg)('HTML composition with real Chrome and ffmpeg', () => {
  beforeAll(async () => {
    const profile = join(PATHS.data, 'chrome-test-profile');
    proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const ws = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test Chrome did not start')), 20000);
      proc.once('error', reject);
      proc.stderr.on('data', bytes => {
        const match = bytes.toString().match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    endpoint = new URL(ws).origin.replace('ws:', 'http:');
    browser = await chromium.connectOverCDP(endpoint);
    browserSession = await browser.newBrowserCDPSession();
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    if (proc && proc.exitCode === null) { const exited = once(proc, 'close'); proc.kill(); await exited; }
    cleanupTempDataRoots();
  });

  it('awaits every seek, encodes exactly 12 frames, keeps the target hidden and registers a thumbnail', async () => {
    const input = await composition();
    const before = await browserSession.send('Target.getTargets');
    const observed = [];
    const onProgress = event => {
      if (event.generationId !== input.jobId) return;
      observed.push(browserSession.send('Target.getTargets'));
    };
    videoGenEvents.on('progress', onProgress);
    let result;
    try { result = await renderComposition(input); } finally { videoGenEvents.off('progress', onProgress); }
    const output = join(PATHS.videos, result.filename);
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', output, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 40 * 1024 * 1024 });
    const frameBytes = 1280 * 720 * 3;
    expect(pixels.length / frameBytes).toBe(12);
    // Frame six is t=.5: block left=280, not the preceding seek's 240.
    const redAt = x => pixels.subarray(6 * frameBytes + (110 * 1280 + x) * 3, 6 * frameBytes + (110 * 1280 + x) * 3 + 3);
    expect(redAt(290)[0]).toBeGreaterThan(220);
    expect(redAt(290)[1]).toBeLessThan(30);
    expect(redAt(250)[1]).toBeGreaterThan(220);
    // Chrome creates its own browser_ui/component-extension targets in the
    // default context asynchronously. Pin OUR context plus visible pages,
    // rather than requiring the browser's unrelated internal targets to freeze.
    const extraTargets = (await Promise.all(observed)).flatMap(snapshot => snapshot.targetInfos).filter(info => info.url === 'https://composition.invalid/index.html');
    expect(extraTargets.length).toBeGreaterThan(0);
    expect(extraTargets.every(info => info.type === 'other')).toBe(true); // hidden CDP target type
    const renderContexts = new Set(extraTargets.map(info => info.browserContextId));
    expect(before.targetInfos.every(info => !renderContexts.has(info.browserContextId))).toBe(true);
    const after = await browserSession.send('Target.getTargets');
    expect(after.targetInfos.some(info => renderContexts.has(info.browserContextId))).toBe(false);
    expect(after.targetInfos.filter(info => info.type === 'page').map(info => info.targetId).sort()).toEqual(before.targetInfos.filter(info => info.type === 'page').map(info => info.targetId).sort());
    expect(await loadHistory()).toContainEqual(expect.objectContaining({ id: input.jobId, numFrames: 12, thumbnail: result.thumbnail, modelId: 'html-composition' }));
    expect((await readFile(join(PATHS.videoThumbnails, result.thumbnail))).length).toBeGreaterThan(0);
  }, 30000);

  it('renders a gated launch composition and uses its declared poster beat', async () => {
    const html = `<!doctype html><html><body><script>
      globalThis.portosComposition = { durationSec:15, fps:12, width:1280, height:720,
        async seek(t) { document.body.style.background = t >= 10 ? 'rgb(255,0,0)' : 'rgb(0,0,255)'; }
      };</script></body></html>`;
    const input = await composition(html);
    await writeFile(join(PATHS.data, input.directory, 'plan.md'), 'A fictional product demonstration.');
    await writeFile(join(PATHS.data, input.directory, 'caption.txt'), 'Make a clear plan.');
    await writeFile(join(PATHS.data, input.directory, 'storyboard.json'), JSON.stringify({
      posterSec: 11, scenes: [{ durationSec: 15, lines: [] }],
    }));
    const result = await renderComposition({ ...input, launchVideo: { targetDurationSec: 15 } });
    const pixel = execFileSync(ffmpeg, ['-v', 'error', '-i', join(PATHS.videoThumbnails, result.thumbnail),
      '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(pixel[0]).toBeGreaterThan(220);
    expect(pixel[2]).toBeLessThan(30);
  }, 60000);

  it('refuses a remote request by its full URL and removes partial artifacts', async () => {
    const url = 'https://example.com/forbidden.png';
    const input = await composition(fixture(`new Image().src = '${url}';`));
    await expect(renderComposition(input)).rejects.toThrow(url);
    expect((await readdir(PATHS.videos)).some(name => name.includes(input.jobId))).toBe(false);
    expect(await loadHistory()).not.toContainEqual(expect.objectContaining({ id: input.jobId }));
  });

  it('loops and trims library music to the video with a half-second tail fade', async () => {
    await mkdir(PATHS.music, { recursive: true });
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.3', '-y', join(PATHS.music, 'example.wav')]);
    const result = await renderComposition({ ...await composition(), musicTrack: 'example.wav' });
    const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', join(PATHS.videos, result.filename), '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-']);
    expect(pcm.length / 4 / 48000).toBeGreaterThanOrEqual(1);
    expect(pcm.length / 4 / 48000).toBeLessThan(1.05); // AAC packet padding
    const rms = (start, end) => {
      let sum = 0;
      for (let n = start; n < end; n++) sum += pcm.readFloatLE(n * 4) ** 2;
      return Math.sqrt(sum / (end - start));
    };
    expect(rms(45000, 47500)).toBeLessThan(rms(5000, 10000) * 0.2);
  }, 30000);

  it.each([
    ["new WebSocket('wss://example.com/socket')", 'wss://example.com/socket'],
    ['new RTCPeerConnection()', 'RTCPeerConnection'],
    ["try { new Worker('/worker.js'); } catch {}", '/worker.js'],
  ])('refuses non-HTTP escape paths: %s', async (script, error) => {
    await expect(renderComposition(await composition(fixture(script)))).rejects.toThrow(error);
  });

  it.each([
    ['durationSec', 'durationSec:0'], ['fps', 'fps:12.5'], ['width', 'width:123'],
    ['durationSec', 'durationSec:1.01'], ['seek', 'seek:null'],
  ])('names the invalid %s before capture', async (field, contract) => {
    const input = await composition(fixture('', contract));
    await expect(renderComposition(input)).rejects.toThrow(field);
  });

  it('cancels during capture and deletes partial video without publishing history', async () => {
    const input = await composition();
    const onProgress = event => { if (event.generationId === input.jobId) expect(cancel(input.jobId)).toBe(true); };
    videoGenEvents.on('progress', onProgress);
    try { await expect(renderComposition(input)).rejects.toThrow(/cancel/i); }
    finally { videoGenEvents.off('progress', onProgress); }
    expect((await readdir(PATHS.videos)).some(name => name.includes(input.jobId))).toBe(false);
    expect(await loadHistory()).not.toContainEqual(expect.objectContaining({ id: input.jobId }));
  });

  it('rejects symlinked assets and directory traversal before opening a target', async () => {
    const input = await composition();
    await symlink(join(PATHS.data, 'video-history.json'), join(PATHS.data, input.directory, 'outside.json'));
    await expect(renderComposition(input)).rejects.toThrow(/symlink/);
    await expect(renderComposition({ ...input, directory: '../outside' })).rejects.toThrow(/Validation/);
  });

  it('settles and removes partial output after the browser target disappears', async () => {
    const input = await composition();
    let closed;
    const onProgress = event => {
      if (event.generationId !== input.jobId || closed) return;
      closed = browserSession.send('Target.getTargets').then(({ targetInfos }) => {
        const target = targetInfos.find(info => info.type === 'other');
        return browserSession.send('Target.closeTarget', { targetId: target.targetId });
      });
    };
    videoGenEvents.on('progress', onProgress);
    try { await expect(renderComposition(input)).rejects.toThrow(/closed|target|session|context/i); }
    finally { videoGenEvents.off('progress', onProgress); await closed; }
    expect((await readdir(PATHS.videos)).some(name => name.includes(input.jobId))).toBe(false);
  });
});
