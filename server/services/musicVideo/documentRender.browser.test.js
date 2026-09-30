/**
 * The shipped layered template with real Chrome and ffmpeg: an excerpt of a
 * composition-document project seeks the selected take's <video> on SONG time
 * (streamed to the page by byte range), renders frame-for-frame identically
 * every time, and carries the master song. Skips without Chrome or ffmpeg.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let endpoint;
vi.mock('../browserService.js', () => ({ cdpRequest: (path) => fetch(`${endpoint}${path}`) }));
vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-document-browser-'),
}));

const { PATHS } = await import('../../lib/paths.js');
const { findFfmpeg } = await import('../../lib/ffmpeg.js');
const { encodeDocumentComposition, prepareDocumentRender } = await import('./documentRender.js');
const { importDocumentTemplate } = await import('./compositionDocument.js');
const projects = await import('./projects.js');
const { _cleanupTestBrowser } = await import('../htmlComposition/testBrowserCleanup.js');

afterAll(() => cleanupTempDataRoots());

const chrome = [process.env.CHROME_PATH, chromium.executablePath(),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].find((path) => path && existsSync(path));
const ffmpeg = await findFfmpeg();

describe.skipIf(!chrome || !ffmpeg)('layered template with real Chrome and ffmpeg', () => {
  let proc;
  let browser;
  beforeAll(async () => {
    const profile = join(PATHS.data, 'chrome-test-profile');
    proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const ws = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Test Chrome did not start')), 20000);
      proc.once('error', reject);
      proc.stderr.on('data', (bytes) => {
        const match = bytes.toString().match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    endpoint = new URL(ws).origin.replace('ws:', 'http:');
    browser = await chromium.connectOverCDP(endpoint);
  }, 30000);
  afterAll(() => _cleanupTestBrowser({ browser, proc, cleanup: () => {} }));

  it('draws the selected take at SONG time in an excerpt, identically on every render, with the master muxed', async () => {
    // A 3s clip: red, then green, then blue — each second a solid colour.
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    const clip = join(PATHS.videos, 'rgb.webm');
    execFileSync(ffmpeg, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=lime:s=640x360:r=24:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=24:d=1',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libvpx', '-b:v', '1M', '-g', '24', clip]);
    const master = join(PATHS.music, 'master.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', master]);
    const created = await projects.createProject({ name: 'Excerpt' });
    await projects.mutateProjectRecord(created.id, (current) => ({ project: {
      ...current,
      audioAnalysis: { durationSec: 6, beats: [], downbeats: [], sections: [] },
      scenes: [{ sceneId: 'rgb', order: 0, startSec: 0, endSec: 3, videoHistoryId: 'vh-rgb' }],
    } }));
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-rgb', filename: 'rgb.webm', numFrames: 72, fps: 24, width: 640, height: 360 }]));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    const plan = await prepareDocumentRender(project);

    const render = async (name) => {
      const outputPath = join(PATHS.videos, name);
      const result = await encodeDocumentComposition({ project, plan, jobId: `job-${name.replace(/\W/g, '')}`, audioPath: master, outputPath, windowStart: 1.02, windowEnd: 1.75 });
      return { result, outputPath };
    };
    const first = await render('first.mp4');
    // Snapped down to the frame grid: song 1.0s → 1.75s is 18 frames.
    expect(first.result).toMatchObject({ startSec: 1, durationSec: 0.75, width: 1920, height: 1080, fps: 24 });
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', first.outputPath, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
    const frameBytes = 64 * 36 * 3;
    expect(pixels.length / frameBytes).toBe(18);
    for (let n = 0; n < 18; n++) {
      const at = n * frameBytes + (18 * 64 + 32) * 3; // centre pixel
      const [r, g, b] = pixels.subarray(at, at + 3);
      // Song second 1 is the clip's green second — not the red of clip time 0.
      expect(g, `frame ${n}`).toBeGreaterThan(r + 60);
      expect(g, `frame ${n}`).toBeGreaterThan(b + 60);
    }
    const streams = execFileSync(ffmpeg.replace(/ffmpeg$/, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', first.outputPath]).toString();
    expect(streams.split('\n').filter(Boolean).sort()).toEqual(['audio', 'video']);

    const second = await render('second.mp4');
    const hashes = (path) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:v', '-f', 'framemd5', '-']).toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
    expect(hashes(second.outputPath)).toEqual(hashes(first.outputPath));
    // The staged job folder is gone once the render ends.
    expect(existsSync(join(PATHS.data, 'music-video-song-renders', 'job-firstmp4'))).toBe(false);
    await rm(first.outputPath, { force: true });
    await rm(second.outputPath, { force: true });
  }, 120000);
});
