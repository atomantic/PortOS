import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { findFfmpeg, probeVideoDuration, probeVideoStreamInfo } from '../../lib/ffmpeg.js';
import { PATHS } from '../../lib/fileUtils.js';
import { loadHistory } from '../videoGen/history.js';
import { videoGenEvents } from '../videoGen/events.js';
import { renderComposition, cancel } from './index.js';
import { installMotionKit } from './motionKit.js';
import { _cleanupTestBrowser } from './testBrowserCleanup.js';

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

async function composition(html = fixture(), directory = `compositions/${randomUUID()}`) {
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

  afterAll(() => _cleanupTestBrowser({ browser, proc, cleanup: cleanupTempDataRoots }));

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

  it('renders motionBlur:1 byte-identical to the default, and motionBlur:4 blends subframes into a smoothed leading edge', async () => {
    const baseline = await renderComposition(await composition());
    const explicit = await renderComposition(await composition(fixture('', 'motionBlur:1')));
    expect(await readFile(join(PATHS.videos, explicit.filename))).toEqual(await readFile(join(PATHS.videos, baseline.filename)));

    const blurred = await renderComposition(await composition(fixture('', 'motionBlur:4')));
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', join(PATHS.videos, blurred.filename), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 40 * 1024 * 1024 });
    const frameBytes = 1280 * 720 * 3;
    expect(pixels.length / frameBytes).toBe(12); // frame count still durationSec * fps, unaffected by motionBlur
    // Frame six spans t=0.5..0.5625s across 4 subframes. The block's trailing
    // edge (px 345) is only inside the block on the later subframes, so the
    // blended average lands strictly between pure red and pure white.
    const at = x => pixels.subarray(6 * frameBytes + (110 * 1280 + x) * 3, 6 * frameBytes + (110 * 1280 + x) * 3 + 3);
    const blended = at(345);
    expect(blended[1]).toBeGreaterThan(30);
    expect(blended[1]).toBeLessThan(220);
  }, 60000);

  // A 20px square crossing the 1280px frame in three frames (#9077).
  const whip = motionBlur => `<!doctype html><html><head><style>body { margin: 0; background: white; } #block { position:absolute; top:100px; width:20px; height:20px; background:rgb(255,0,0); }</style>
</head><body><div id="block"></div><script>
globalThis.portosComposition = { durationSec:1, fps:12, width:1280, height:720, motionBlur:${motionBlur},
  seek(t) { document.getElementById('block').style.left = Math.round(t * 5120) + 'px'; } };
</script></body></html>`;
  const frameRow = (filename, frame) => {
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', join(PATHS.videos, filename), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 40 * 1024 * 1024 });
    const frameBytes = 1280 * 720 * 3;
    return x => pixels[frame * frameBytes + (110 * 1280 + x) * 3 + 1]; // green: 255 on white, low on red
  };

  it('streaks a whip continuously with an auto shutter where integer motionBlur leaves separated copies', async () => {
    // Frame one (t=1/12) centres the square at x≈427. Integer 4 samples
    // t..t+3/48 → copies at 427/533/640/747 with white gaps between them.
    const stepped = await renderComposition(await composition(whip(4)));
    const steppedGreen = frameRow(stepped.filename, 1);
    const steppedProfile = Array.from({ length: 300 }, (_, i) => steppedGreen(445 + i));
    expect(Math.max(...steppedProfile)).toBeGreaterThan(252);
    expect(Math.min(...steppedProfile)).toBeLessThan(200);
    // A full shutter centred on the frame spans x≈213..640: an unbroken streak.
    const streaked = await renderComposition(await composition(whip("{ shutter: 1, samples: 'auto' }")));
    const streakGreen = frameRow(streaked.filename, 1);
    const profile = Array.from({ length: 380 }, (_, i) => streakGreen(240 + i));
    // Each pixel sees the square for ~1/20 of the shutter, so the streak is
    // faint but even: no white gap and no brighter copy anywhere along it.
    expect(Math.max(...profile)).toBeLessThan(252);
    expect(Math.max(...profile) - Math.min(...profile)).toBeLessThanOrEqual(4);
    expect(Object.keys(streaked.sampleHistogram).map(Number).some(count => count >= 9)).toBe(true);
  }, 120000);

  it('stops a still composition at one capture per frame with an auto shutter', async () => {
    const html = fixture('', "motionBlur:{ samples: 'auto' }").replace("(40 + t * 480) + 'px'", "'40px'");
    const result = await renderComposition(await composition(html));
    expect(result.sampleHistogram).toEqual({ 1: 12 });
  }, 60000);

  it('renders a gated launch composition and uses its declared poster beat', async () => {
    const html = `<!doctype html><html><body><script>
      globalThis.portosComposition = { durationSec:15, fps:12, width:1280, height:720,
        async seek(t) { document.body.style.background = t >= 10 ? 'rgb(255,0,0)' : 'rgb(0,0,255)'; }
      };</script></body></html>`;
    const runId = randomUUID();
    const input = await composition(html, `launch-videos/example/${runId}/composition`);
    await writeFile(join(PATHS.data, input.directory, 'plan.md'), 'A fictional product demonstration.');
    await writeFile(join(PATHS.data, input.directory, 'caption.txt'), 'Make a clear plan.');
    await writeFile(join(PATHS.data, input.directory, 'storyboard.json'), JSON.stringify({
      posterSec: 11, scenes: [{ durationSec: 15, lines: [] }],
    }));
    const result = await renderComposition({ ...input, launchVideo: { targetDurationSec: 15, appId: 'example', runId, sourceVideoId: 'parent-take' } });
    const runRoot = join(PATHS.data, 'launch-videos', 'example', runId);
    expect(await readdir(runRoot)).toEqual(expect.arrayContaining(['composition', 'plan.md', 'storyboard.json', 'caption.txt', 'video.mp4', 'poster.jpg']));
    expect(await readFile(join(runRoot, 'video.mp4'))).toEqual(await readFile(join(PATHS.videos, result.filename)));
    expect(await loadHistory()).toContainEqual(expect.objectContaining({ id: input.jobId, appId: 'example', launchVideo: { appId: 'example', runId, sourceVideoId: 'parent-take', musicTrack: null, synthesizeMusic: false, caption: 'Make a clear plan.', posterSec: 11 } }));
    const pixel = execFileSync(ffmpeg, ['-v', 'error', '-i', join(PATHS.videoThumbnails, result.thumbnail),
      '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(pixel[0]).toBeGreaterThan(220);
    expect(pixel[2]).toBeLessThan(30);
    // Exclusive delivery cannot replace an earlier successful run on retry.
    const retryId = randomUUID();
    await expect(renderComposition({ ...input, jobId: retryId, launchVideo: { targetDurationSec: 15, appId: 'example', runId } })).rejects.toThrow(/EEXIST/);
    expect(await readFile(join(runRoot, 'video.mp4'))).toEqual(await readFile(join(PATHS.videos, result.filename)));
    expect((await readdir(PATHS.videos)).some(name => name.includes(retryId))).toBe(false);
    expect(await loadHistory()).not.toContainEqual(expect.objectContaining({ id: retryId }));
    // One capture (180 frames) plus a refused, capture-free retry: about a
    // third of the three-format test's budget below, which renders three
    // 180-frame targets from one timeline.
  }, 40000);

  it('renders one launch timeline in three declared formats, each reframed by layout, as one take', async () => {
    // layout() recolors the frame per orientation, so each poster proves the
    // hook ran at that format's size before its seeks were captured.
    const html = `<!doctype html><html><body style="margin:0"><script>
      let fill = 'rgb(0,0,0)';
      globalThis.portosComposition = { durationSec:15, fps:12, width:1920, height:1080,
        formats: ['1920x1080', '1080x1920', '1080x1080'],
        async layout({ width, height }) {
          if (innerWidth !== width || innerHeight !== height) throw new Error('layout ran before the viewport resized');
          fill = width === height ? 'rgb(0,0,255)' : width < height ? 'rgb(0,255,0)' : 'rgb(255,0,0)';
        },
        async seek(t) { document.body.style.background = fill; },
      };</script></body></html>`;
    const runId = randomUUID();
    const input = await composition(html, `launch-videos/example/${runId}/composition`);
    await writeFile(join(PATHS.data, input.directory, 'plan.md'), 'A fictional product demonstration.');
    await writeFile(join(PATHS.data, input.directory, 'caption.txt'), 'Make a clear plan.');
    await writeFile(join(PATHS.data, input.directory, 'storyboard.json'), JSON.stringify({ posterSec: 5, scenes: [{ durationSec: 15, lines: [] }] }));
    const launchVideo = { targetDurationSec: 15, appId: 'example', runId };
    const runRoot = join(PATHS.data, 'launch-videos', 'example', runId);

    // A proof checks one framing at a time: vertical gets phone-width 240px tiles.
    const proof = await renderComposition({ ...input, launchVideo, proof: { everySec: 5, format: 'vertical' } });
    expect(proof.proof).toMatchObject({ format: 'vertical', width: 1080, height: 1920, columns: 3, times: [0, 5, 10] });
    expect((await readFile(join(PATHS.data, proof.proof.file))).readUInt32BE(16)).toBe(3 * 240 + 2 * 4);

    // Requested out of order; rendered and delivered in the canonical order.
    const jobId = randomUUID();
    const result = await renderComposition({ ...input, jobId, launchVideo, formats: ['square', 'landscape', 'vertical'] });
    const expected = [['landscape', 1920, 1080, [255, 0, 0]], ['vertical', 1080, 1920, [0, 255, 0]], ['square', 1080, 1080, [0, 0, 255]]];
    expect(result.videos.map(video => video.format)).toEqual(expected.map(([format]) => format));
    expect(result).toMatchObject({ generationId: jobId, id: `${jobId}-landscape`, appId: 'example', filename: `composition-${jobId}-landscape.mp4` });
    const history = await loadHistory();
    for (const [format, width, height, rgb] of expected) {
      const video = result.videos.find(item => item.format === format);
      expect(video).toMatchObject({ id: `${jobId}-${format}`, filename: `composition-${jobId}-${format}.mp4`, thumbnail: `${jobId}-${format}.jpg` });
      // Same timeline: every format carries all 180 frames of the 15s storyboard.
      expect(await probeVideoStreamInfo(join(PATHS.videos, video.filename))).toMatchObject({ width, height, frameCount: 180 });
      expect(await readFile(join(runRoot, `video-${format}.mp4`))).toEqual(await readFile(join(PATHS.videos, video.filename)));
      const pixel = execFileSync(ffmpeg, ['-v', 'error', '-i', join(runRoot, `poster-${format}.jpg`), '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      rgb.forEach((value, channel) => expect(Math.abs(pixel[channel] - value)).toBeLessThan(40));
      expect(history).toContainEqual(expect.objectContaining({ id: video.id, width, height, durationSec: 15, numFrames: 180,
        launchVideo: expect.objectContaining({ appId: 'example', runId, caption: 'Make a clear plan.' }) }));
    }
    // The storyboard, plan and caption are delivered once for the whole run.
    expect((await readdir(runRoot)).sort()).toEqual(['caption.txt', 'composition', 'plan.md', 'poster-landscape.jpg', 'poster-square.jpg',
      'poster-vertical.jpg', 'proofs', 'storyboard.json', 'video-landscape.mp4', 'video-square.mp4', 'video-vertical.mp4']);
    expect(history.filter(item => item.launchVideo?.runId === runId)).toHaveLength(3);
  }, 120000);

  it('refuses a format the composition did not declare, before writing any output', async () => {
    const input = await composition();
    await expect(renderComposition({ ...input, formats: ['landscape', 'vertical'] })).rejects.toThrow('portosComposition.formats must include 1920x1080 to render landscape');
    await expect(renderComposition({ ...input, jobId: randomUUID(), proof: { format: 'square' } })).rejects.toThrow('1080x1080');
    expect((await readdir(PATHS.videos).catch(() => [])).some(name => name.includes(input.jobId))).toBe(false);
    expect(await loadHistory()).not.toContainEqual(expect.objectContaining({ id: expect.stringContaining(input.jobId) }));
  });

  it('proofs a motion-kit launch composition as a contact sheet, then renders its synthesized cues', async () => {
    const html = `<!doctype html><html><body><script src="portos-motion.js"></script><script>
      const { spring, beats, renderCues } = globalThis.PortosMotion;
      const grid = beats(120);
      globalThis.portosComposition = { durationSec:15, fps:12, width:1280, height:720,
        async seek(t) { document.body.style.background = \`rgb(\${Math.round(255 * spring(t - 10))},0,0)\`; },
        async renderAudio({ sampleRate, durationSec }) {
          return renderCues({ sampleRate, durationSec, cues: grid.list(durationSec).map(t => ({ t, type: 'click' })) });
        },
      };</script></body></html>`;
    const runId = randomUUID();
    const input = await composition(html, `launch-videos/example/${runId}/composition`);
    await installMotionKit(join(PATHS.data, input.directory));
    await writeFile(join(PATHS.data, input.directory, 'plan.md'), 'A fictional product demonstration.');
    await writeFile(join(PATHS.data, input.directory, 'caption.txt'), 'Make a clear plan.');
    await writeFile(join(PATHS.data, input.directory, 'storyboard.json'), JSON.stringify({ posterSec: 11, scenes: [{ durationSec: 15, lines: [] }] }));
    const launchVideo = { targetDurationSec: 15, appId: 'example', runId };
    const runRoot = join(PATHS.data, 'launch-videos', 'example', runId);
    await expect(renderComposition({ ...input, launchVideo, synthesizeMusic: true, proof: { everySec: 1 } })).rejects
      .toMatchObject({ context: { details: [expect.objectContaining({ message: expect.stringContaining('A proof is silent') })] } });
    const proof = await renderComposition({ ...input, launchVideo, proof: { everySec: 1 } });
    expect(proof.proof).toMatchObject({ file: `launch-videos/example/${runId}/proofs/contact-${input.jobId}.png`, url: `/data/launch-videos/example/${runId}/proofs/contact-${input.jobId}.png`, columns: 6, width: 1280, height: 720 });
    expect(proof.proof.times).toEqual(Array.from({ length: 15 }, (_, n) => n));
    const png = await readFile(join(PATHS.data, proof.proof.file));
    // IHDR: six phone-width (360px) tiles with 4px gutters, three rows of ~16:9 tiles.
    expect(png.readUInt32BE(16)).toBe(6 * 360 + 5 * 4);
    expect((png.readUInt32BE(20) - 2 * 4) / 3).toBeCloseTo(360 * 9 / 16, -1);
    // A proof is a review pass: nothing is delivered or registered.
    expect(await readdir(runRoot)).toEqual(expect.arrayContaining(['composition', 'proofs']));
    expect(await readdir(runRoot)).not.toContain('video.mp4');
    expect(await loadHistory()).not.toContainEqual(expect.objectContaining({ id: input.jobId }));
    const result = await renderComposition({ ...input, jobId: randomUUID(), launchVideo, synthesizeMusic: true });
    const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', join(PATHS.videos, result.filename), '-vn', '-f', 'f32le', '-ac', '1', '-ar', '24000', '-'], { maxBuffer: 8 * 1024 * 1024 });
    const peak = (from, to) => Math.max(...Array.from({ length: (to - from) * 24 }, (_, n) => Math.abs(pcm.readFloatLE((from * 24 + n) * 4))));
    // Clicks land on the 120 BPM grid (every 500ms) and decay well before the next beat.
    expect(peak(0, 20)).toBeGreaterThan(0.1);
    expect(peak(200, 450)).toBeLessThan(0.02);
    expect(peak(500, 520)).toBeGreaterThan(0.1);
  }, 90000);

  it('refuses a remote request by its full URL and removes partial artifacts', async () => {
    const url = 'https://example.com/forbidden.png';
    const input = await composition(fixture(`new Image().src = '${url}';`));
    await expect(renderComposition(input)).rejects.toThrow(url);
    expect((await readdir(PATHS.videos)).some(name => name.includes(input.jobId))).toBe(false);
    expect(await loadHistory()).not.toContainEqual(expect.objectContaining({ id: input.jobId }));
  });

  it('muxes agent-composed PCM without a music engine and refuses missing or invalid scores', async () => {
    const input = await composition(fixture('', `renderAudio: async ({ sampleRate, durationSec }) =>
      Array.from({ length: Math.round(sampleRate * durationSec) }, (_, n) => 0.2 * Math.sin(2 * Math.PI * 440 * n / sampleRate)),`));
    const result = await renderComposition({ ...input, synthesizeMusic: true });
    const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', join(PATHS.videos, result.filename), '-vn', '-f', 'f32le', '-ac', '1', '-ar', '24000', '-']);
    expect(pcm.length).toBeGreaterThanOrEqual(24000 * 4);
    expect(Array.from({ length: 1000 }, (_, n) => Math.abs(pcm.readFloatLE(n * 4))).some(value => value > 0.05)).toBe(true);
    await expect(renderComposition({ ...await composition(), synthesizeMusic: true })).rejects.toThrow('renderAudio is required');
    await expect(renderComposition({ ...await composition(fixture('', 'renderAudio: async () => Array(24000).fill(2),')), synthesizeMusic: true })).rejects.toThrow('finite mono PCM');
  }, 30000);

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
    ['motionBlur', 'motionBlur:0'], ['motionBlur', 'motionBlur:5'], ['motionBlur', 'motionBlur:2.5'],
    ['motionBlur', 'motionBlur:{shutter:2}'], ['motionBlur', 'motionBlur:{samples:200}'], ['motionBlur', "motionBlur:{samples:'auto',frames:4}"],
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

  const pcmOf = (path, extra = []) => execFileSync(ffmpeg, ['-v', 'error', ...extra, '-i', path, '-vn', '-f', 'f32le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const rms = (pcm, startSec, endSec) => {
    const from = Math.floor(startSec * 48000);
    const to = Math.min(pcm.length / 4, Math.floor(endSec * 48000));
    let sum = 0;
    for (let n = from; n < to; n++) sum += pcm.readFloatLE(n * 4) ** 2;
    return Math.sqrt(sum / Math.max(1, to - from));
  };

  it('reads song.json inside the sandbox and treats a missing feature block as null', async () => {
    const html = `<!doctype html><html><body style="margin:0"><script>
      globalThis.portosComposition = { durationSec: 1, fps: 12, width: 1280, height: 720,
        async seek() {
          const song = await (await fetch('song.json')).json();
          const ok = song.features === null && !Array.isArray(song.features) && song.beats[0] === 0 && song.words[0].w === 'go';
          document.body.style.background = ok ? 'rgb(0,255,0)' : 'rgb(255,0,0)';
        } };
    </script></body></html>`;
    const input = await composition(html);
    await mkdir(PATHS.music, { recursive: true });
    const master = join(PATHS.music, 'song-null-features.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-y', master]);
    const result = await renderComposition({
      ...input, owner: 'music-video', audio: { path: master, startSec: 0 }, maxDurationSec: 180,
      song: { beats: [0], downbeats: [0], sections: [], features: [], words: [{ w: 'go', startSec: 0, endSec: 0.4, conf: 'matched' }] },
    });
    const pixel = execFileSync(ffmpeg, ['-v', 'error', '-i', join(PATHS.videos, result.filename), '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(pixel[1]).toBeGreaterThan(200);
    expect(pixel[0]).toBeLessThan(40);
    expect(existsSync(join(PATHS.data, input.directory, 'song.json'))).toBe(false);
  }, 30000);

  it('renders a 180s song without looping or fading the master', async () => {
    const html = `<!doctype html><html><body style="margin:0"><script>
      globalThis.portosComposition = { durationSec: 180, fps: 12, width: 1280, height: 720, async seek() {} };
    </script></body></html>`;
    const input = await composition(html);
    await mkdir(PATHS.music, { recursive: true });
    const master = join(PATHS.music, 'song-180.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=180', '-y', master]);
    const frames = [];
    const onProgress = (event) => { if (event.generationId === input.jobId) frames.push(event); };
    videoGenEvents.on('progress', onProgress);
    let result;
    try { result = await renderComposition({ ...input, owner: 'music-video', audio: { path: master, startSec: 0 }, maxDurationSec: 180, song: { beats: [], features: null, words: null } }); }
    finally { videoGenEvents.off('progress', onProgress); }
    const output = join(PATHS.videos, result.filename);
    expect(await probeVideoStreamInfo(output)).toMatchObject({ frameCount: 180 * 12 });
    expect(Math.abs(await probeVideoDuration(output) - 180)).toBeLessThanOrEqual(1 / 12);
    const audio = pcmOf(output);
    expect(Math.abs(audio.length / 4 / 48000 - 180)).toBeLessThanOrEqual(1 / 12);
    expect(rms(audio, 179.85, 179.98)).toBeGreaterThan(rms(audio, 20, 20.5) * 0.5);
    expect(frames.some((event) => event.step > 0 && event.totalSteps === 2160 && event.etaMs > 0 && /Rendering frame \d+\/2160/.test(event.message))).toBe(true);
  }, 300000);

  it('muxes a 60–75s excerpt aligned to that range of the master', async () => {
    const html = `<!doctype html><html><body style="margin:0"><script>
      globalThis.portosComposition = { durationSec: 15, fps: 12, width: 1280, height: 720, async seek() {} };
    </script></body></html>`;
    const input = await composition(html);
    await mkdir(PATHS.music, { recursive: true });
    const master = join(PATHS.music, 'song-excerpt.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=60', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=15', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=105', '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-y', master]);
    const result = await renderComposition({
      ...input, owner: 'music-video', audio: { path: master, startSec: 60 }, maxDurationSec: 180, song: { features: null },
    });
    const output = pcmOf(join(PATHS.videos, result.filename));
    const reference = pcmOf(master, ['-ss', '60', '-t', '15']);
    const opening = pcmOf(master, ['-ss', '0', '-t', '15']);
    const frameSamples = Math.round(48000 / 12);
    const samples = (buf) => buf.length / 4;
    const scoreAgainst = (other, lag) => {
      let sum = 0;
      let count = 0;
      const nOut = samples(output);
      const nOther = samples(other);
      for (let n = 0; n < nOut; n += 8) {
        const m = n + lag;
        if (m < 0 || m >= nOther) continue;
        sum += output.readFloatLE(n * 4) * other.readFloatLE(m * 4);
        count += 1;
      }
      return count ? sum / count : 0;
    };
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = -frameSamples; lag <= frameSamples; lag += 40) {
      const value = scoreAgainst(reference, lag);
      if (value > best) { best = value; bestLag = lag; }
    }
    expect(Math.abs(bestLag)).toBeLessThanOrEqual(frameSamples);
    expect(best).toBeGreaterThan(Math.abs(scoreAgainst(opening, 0)) * 4);
    expect(await probeVideoStreamInfo(join(PATHS.videos, result.filename))).toMatchObject({ frameCount: 15 * 12 });
  }, 60000);
});
