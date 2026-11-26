import { describe, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { browserSuiteCanRun } from '../../lib/browserSuiteGate.js';
import { mockNoPeers } from '../../lib/mockPathsDataRoot.js';
import {
  browser, buildDocumentPreview, cleanupTempDataRoots, encodeDocumentComposition, ffmpeg, importDocumentTemplate, it, mockCaptureBrowserService, near,
  PATHS, prepareDocumentRender, prerequisites, projects, refuseCompositionVideoPublication, useDocumentRenderBrowserFixture,
} from './documentRender.browser.test.fixture.js';

// The planner prunes sealed mocks declared by the suite itself.
vi.mock('./projects.js', async () => import('./projectsFile.js'));
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../mediaCollectionRules.js', () => ({ fileCompositionVideos: refuseCompositionVideoPublication }));
vi.mock('../browserService.js', () => mockCaptureBrowserService());

const canRun = browserSuiteCanRun('documentRenderAudioTimeline browser suite', prerequisites, { onUnavailable: cleanupTempDataRoots });

describe.skipIf(!canRun)('layered template with real Chrome and ffmpeg', () => {
  useDocumentRenderBrowserFixture();

  // Catches a grade applied by whole-scene time: the outgoing picture under a wipe would
  // take the incoming scene's look from the cut until the wipe has covered it (#14835).
  it('keeps each picture of a wipe on its own scene grade in a full export and an excerpt', async () => {
    await mkdir(PATHS.images, { recursive: true });
    const names = ['grade-wipe-red.png', 'grade-wipe-blue.png', 'grade-wipe-green.png'];
    const colors = ['#d02020', '#2040d0', '#20c020'];
    await Promise.all(names.map(async (name, i) => writeFile(join(PATHS.images, name),
      await sharp({ create: { width: 64, height: 36, channels: 3, background: colors[i] } }).png().toBuffer())));
    const created = await projects.createProject({ name: 'Synthetic graded wipes' });
    const still = (sceneId, startSec, image, extra = {}) => ({ sceneId, startSec, endSec: startSec + 1, visualLayer: 'still', stillMove: 'hold', referenceImageId: image, ...extra });
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 3, sections: [] },
      scenes: [
        still('a', 0, names[0], { wipeOut: { style: 'iris', lengthSec: 0.5 } }),
        still('b', 1, names[1], { wipeOut: { style: 'push-left', lengthSec: 0.5 } }),
        still('c', 2, names[2]),
      ],
      composition: { ...current.composition, grade: { preset: 'neutral', grain: 0, sections: [{ sceneId: 'a', preset: 'monochrome' }, { sceneId: 'c', preset: 'monochrome' }] } },
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const audio = join(PATHS.music, 'graded-wipes.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', audio]);
    const encode = async (name, windowStart, windowEnd) => {
      const outputPath = join(PATHS.videos, name);
      // Grade isolation does not depend on resolution, and 1080p software rendering
      // took this test past its deadline on CI runners (#14845).
      const plan = { ...(await prepareDocumentRender(project)), frame: { width: 1280, height: 720 } };
      await encodeDocumentComposition({ project, plan, jobId: name.replace('.mp4', ''), audioPath: audio, outputPath, windowStart, windowEnd });
      const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      return (frame, x, y = 18) => [...raw.subarray((frame * 64 * 36 + y * 64 + x) * 3, (frame * 64 * 36 + y * 64 + x) * 3 + 3)];
    };
    const chroma = ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b);
    const full = await encode('graded-wipes-full.mp4', 0, 3);
    const excerpt = await encode('graded-wipes-excerpt.mp4', 28 / 24, 32 / 24);
    // Monochrome into neutral: the iris opens blue over a held picture that stays gray.
    for (const frame of [24, 28, 31]) {
      expect(chroma(full(frame, 2))).toBeLessThan(24);
      expect(full(frame, 32)[2]).toBeGreaterThan(full(frame, 32)[0] + 60);
    }
    for (let n = 0; n < 4; n++) {
      expect(chroma(excerpt(n, 2))).toBeLessThan(24);
      expect(excerpt(n, 32)[2]).toBeGreaterThan(excerpt(n, 32)[0] + 60);
    }
    // Neutral into monochrome: the outgoing picture keeps its color, the one pushing in is gray.
    expect(full(52, 4)[2]).toBeGreaterThan(full(52, 4)[1] + 60);
    expect(chroma(full(52, 60))).toBeLessThan(24);
    // Past the wipes, each shot's own grade over the whole frame.
    expect(chroma(full(23, 32))).toBeLessThan(24);
    expect(full(40, 2)[2]).toBeGreaterThan(full(40, 2)[0] + 60);
    expect(chroma(full(64, 32))).toBeLessThan(24);
  }, 120000);

  it('renders an end flash and a timed light leak identically in preview, full export and a mid-effect excerpt', async () => {
    await mkdir(PATHS.images, { recursive: true });
    const names = ['effect-start.png', 'effect-end.png'];
    const colors = ['#d02020', '#2040d0'];
    const images = await Promise.all(colors.map(background => sharp({ create: { width: 64, height: 36, channels: 3, background } }).png().toBuffer()));
    await Promise.all(names.map((name, i) => writeFile(join(PATHS.images, name), images[i])));
    const created = await projects.createProject({ name: 'Synthetic selected effects' });
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 2, sections: [{ id: 'hook', label: 'Hook', startSec: 0, endSec: 2 }] },
      scenes: [{ sceneId: 'effect', startSec: 0.26, endSec: 2, visualLayer: 'still', stillMove: 'hold',
        referenceImageId: names[0], endImageId: names[1], imageEffect: 'end-flash', imageEffectSec: 0.5,
        glitches: [{ atSec: 0.9, style: 'light-leak', lengthSec: 0.25, color: '#00ff00', edge: 'right', strength: 0.8 }] }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const audio = join(PATHS.music, 'selected-effects.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', audio]);
    const encode = async (name, windowStart, windowEnd) => {
      const outputPath = join(PATHS.videos, name);
      await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: name.replace('.mp4', ''),
        audioPath: audio, outputPath, windowStart, windowEnd });
      return execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    };
    const full = await encode('selected-effects-full.mp4', 0, 2);
    const excerpt = await encode('selected-effects-excerpt.mp4', 29 / 24, 37 / 24);
    const pixel = (raw, frame, x) => {
      const index = (frame * 64 * 36 + 18 * 64 + x) * 3;
      return [...raw.subarray(index, index + 3)];
    };
    const preview = await buildDocumentPreview(project);
    const assets = preview.assets.filter(asset => asset.url.startsWith('/data/images/')).map(asset => ({
      key: asset.key, encoded: images[names.indexOf(decodeURIComponent(asset.url.split('/').at(-1)))].toString('base64'),
    }));
    const page = await browser.newPage();
    try {
      await page.setContent(preview.html);
      await page.evaluate(assets => {
        addEventListener('message', ({ data }) => {
          if (data?.type !== 'portos-mv:request') return;
          const asset = assets.find(item => item.key === data.key);
          if (!asset) return;
          const blob = new Blob([Uint8Array.from(atob(asset.encoded), c => c.charCodeAt(0))], { type: 'image/png' });
          window.postMessage({ type: 'portos-mv:asset', key: asset.key, blob }, '*');
        });
        window.postMessage({ type: 'portos-mv:manifest', keys: assets.map(asset => asset.key) }, '*');
      }, assets);
      await page.waitForFunction(() => globalThis.portosComposition);
      const live = (frame, x) => page.evaluate(async ({ frame, x }) => {
        await globalThis.portosComposition.seek(frame / 24);
        const canvas = document.getElementById('stage');
        return [...canvas.getContext('2d').getImageData(Math.round(canvas.width * x / 64), canvas.height / 2, 1, 1).data].slice(0, 3);
      }, { frame, x });
      for (const frame of [8, 17, 18, 24, 29, 30, 33, 36]) {
        for (const x of [8, 32, 56]) {
          const shown = await live(frame, x);
          near(pixel(full, frame, x), shown, 24);
          if (frame >= 29 && frame < 37) near(pixel(excerpt, frame - 29, x), shown, 24);
        }
      }
      const before = await live(8, 32), flash = await live(18, 32), after = await live(24, 32);
      expect(before[0]).toBeGreaterThan(before[2] + 80);
      expect(Math.min(...flash)).toBeGreaterThan(240);
      expect(after[2]).toBeGreaterThan(after[0] + 80);
      const leak = await live(30, 56), clean = await live(36, 56);
      expect(leak[1]).toBeGreaterThan(clean[1] + 10);
    } finally { await page.close(); }
  }, 90000);

  it('keeps event frames identical across shuffled seeks, an excerpt and a full render, and freezes silence', async () => {
    const created = await projects.createProject({ name: 'Synthetic event proof' });
    const base = { durationSec: 0.2, narrativeFunction: 'Mark the story turn', mediumRationale: 'Exact code graphics' };
    await projects.mutateProjectRecord(created.id, (current) => ({ project: { ...current,
      audioAnalysis: { durationSec: 2, beats: [0, 0.5, 1, 1.5], downbeats: [0], sections: [{ id: 'song', label: 'Hook', startSec: 0, endSec: 2 }],
        features: { envelopes: { fps: 2, rms: [1, 1, 1, 1], low: [1, 1, 1, 1], mid: [0, 0, 0, 0], high: [0, 0, 0, 0] }, onsets: { low: [0.51], mid: [], high: [] } } },
      lyricCues: [{ id: 'line', text: 'UP', startSec: 0.8, words: [{ w: 'UP', startSec: 0.8 }] }],
      composition: { mode: 'document', reactiveSections: [{ sectionId: 'song', gain: 1, maxGain: 0.2 }], narrativeEvents: [
        { ...base, id: 'hit', name: 'Impact', kind: 'impact', text: 'TURN', anchor: { kind: 'onset', band: 'low', index: 0 } },
        { ...base, id: 'count', name: 'Count', kind: 'counter-change', fromValue: 0, toValue: 9, anchor: { kind: 'word', cueId: 'line', wordIndex: 0 } },
        { ...base, id: 'quiet', name: 'Quiet', kind: 'silence', durationSec: 0.4, anchor: { kind: 'time', atSec: 1 } },
        { ...base, id: 'quiet-more', name: 'Keep quiet', kind: 'silence', durationSec: 0.2, anchor: { kind: 'time', atSec: 1.25 } },
        { ...base, id: 'motif', name: 'Kite', kind: 'motif-transformation', before: 'Fold', after: 'Flight', anchor: { kind: 'time', atSec: 1.5 } },
        { ...base, id: 'reveal', name: 'Reveal', kind: 'reveal', anchor: { kind: 'time', atSec: 1.8 } },
      ] },
      scenes: [{ sceneId: 'card', startSec: 0, endSec: 2, visualLayer: 'card', cardText: '' }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    const preview = await buildDocumentPreview(project);
    const page = await browser.newPage();
    await page.setContent(preview.html);
    await page.evaluate(() => window.postMessage({ type: 'portos-mv:manifest', keys: [] }, '*'));
    const at = (frame) => page.evaluate(async (frame) => {
      await window.portosComposition.seek(frame / 24);
      return { pixels: document.getElementById('stage').toDataURL(), state: window.PORTOS_MV_EVENT_STATE(window.PORTOS_MV.song, frame / 24, 24) };
    }, frame);
    const hit = await at(13);
    expect(hit.state.activeEvents[0].id).toBe('hit');
    expect((await at(12)).state.activeEvents).toEqual([]);
    expect(hit.pixels).not.toBe((await at(12)).pixels);
    expect((await at(20)).state.activeEvents[0].id).toBe('count');
    expect((await at(36)).state.activeEvents[0].id).toBe('motif');
    expect((await at(44)).state.activeEvents[0].id).toBe('reveal');
    const held = await at(24);
    expect(held.state).toMatchObject({ hold: true, reactiveGain: 0, frame: 24 });
    expect((await at(30)).pixels).toBe(held.pixels);
    expect((await at(34)).pixels).toBe(held.pixels); // overlapping holds share one frozen frame
    expect((await at(13)).pixels).toBe(hit.pixels);
    expect(hit.state.reactiveGain).toBe(0.2);
    await page.close();

    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const master = join(PATHS.music, 'event-master.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', master]);
    const plan = { ...(await prepareDocumentRender(project)), frame: { width: 1280, height: 720 } };
    const full = join(PATHS.videos, 'event-full.mp4');
    const excerpt = join(PATHS.videos, 'event-excerpt.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'event-full', audioPath: master, outputPath: full });
    await encodeDocumentComposition({ project, plan, jobId: 'event-excerpt', audioPath: master, outputPath: excerpt, windowStart: 13 / 24, windowEnd: 18 / 24 });
    const pixels = (path) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 });
    const fullPixels = pixels(full); const excerptPixels = pixels(excerpt); const frameBytes = 64 * 36 * 3;
    expect(excerptPixels.length).toBe(frameBytes * 5);
    for (let frame = 0; frame < 5; frame++) {
      const expected = fullPixels.subarray((frame + 13) * frameBytes, (frame + 14) * frameBytes);
      const actual = excerptPixels.subarray(frame * frameBytes, (frame + 1) * frameBytes);
      const difference = actual.reduce((sum, value, i) => sum + Math.abs(value - expected[i]), 0) / frameBytes;
      expect(difference, `event frame ${frame + 13}`).toBeLessThan(5); // lossy encoder tolerance
    }
  }, 120000);

  // Uniquely catches correct timing metadata paired with an unretimed staged file.
  [
    { timing: { speedFps: 24, offsetFrames: 12 }, samples: [[0, 1], [5, 1], [6, 2]] },
    { timing: { speedFps: 24, offsetFrames: -6 }, samples: [[0, 0], [11, 0], [12, 1], [17, 1], [18, 2]] },
    { timing: { offsetFrames: -6 }, samples: [[0, 0], [17, 0], [18, 1], [29, 1], [30, 2]] },
  ].forEach(({ timing, samples }) => it(`renders shot speed and offset ${JSON.stringify(timing)} into the document pixels`, async () => {
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    const clip = join(PATHS.videos, 'timed-rgb.webm');
    execFileSync(ffmpeg, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24:d=0.5',
      '-f', 'lavfi', '-i', 'color=c=lime:s=64x36:r=24:d=0.5',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=24:d=0.5',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libvpx', clip]);
    const master = join(PATHS.music, 'timed-master.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.5', master]);
    const created = await projects.createProject({ name: 'Synthetic shot timing' });
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-timed', filename: 'timed-rgb.webm', numFrames: 36, fps: 24, width: 64, height: 36 }]));
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 1.5, sections: [] },
      scenes: [{ sceneId: 'timed', startSec: 0, endSec: 1.5, videoHistoryId: 'vh-timed', ...timing }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    const outputPath = join(PATHS.videos, 'timed-output.mp4');
    await encodeDocumentComposition({ project, plan: await prepareDocumentRender(project), jobId: 'timed-pixels', audioPath: master, outputPath });
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    for (const [frame, channel] of samples) {
      const at = (frame * 64 * 36 + 18 * 64 + 32) * 3;
      const rgb = [...pixels.subarray(at, at + 3)];
      expect(rgb).toHaveLength(3);
      expect(rgb[channel], `frame ${frame}`).toBeGreaterThan(180);
      rgb.forEach((value, i) => { if (i !== channel) expect(value, `frame ${frame}`).toBeLessThan(60); });
    }
  }, 120000));

  it('mixes the retimed clip over the dipped song in a final and in a mid-shot excerpt', async () => {
    await mkdir(PATHS.videos, { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    const clip = join(PATHS.videos, 'clip-sound.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x36:r=24:d=1.5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=0.5',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.5', '-filter_complex', '[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]',
      '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-c:a', 'aac', clip]);
    const master = join(PATHS.music, 'clip-sound-master.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.5', master]);
    const created = await projects.createProject({ name: 'Document clip sound' });
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-sound', filename: 'clip-sound.mp4', numFrames: 36, fps: 24, width: 64, height: 36 }]));
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 1.5, sections: [] },
      scenes: [{ sceneId: 'spoken', startSec: 0.5, endSec: 1, videoHistoryId: 'vh-sound',
        offsetFrames: 12, speedFps: 24, clipSound: { volume: 0.8, musicLevel: 0.55 } }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    const plan = await prepareDocumentRender(project);
    const render = async (jobId, windowStart, windowEnd) => {
      const outputPath = join(PATHS.videos, `${jobId}.mp4`);
      const result = await encodeDocumentComposition({ project, plan, jobId, audioPath: master, outputPath, windowStart, windowEnd });
      const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', outputPath, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-']);
      return (songSec, hz) => {
        const first = Math.round((songSec - result.startSec) * 48000);
        const count = 2400;
        let sine = 0, cosine = 0;
        for (let i = 0; i < count; i++) {
          const phase = (2 * Math.PI * hz * i) / 48000;
          const sample = pcm.readFloatLE((first + i) * 4);
          sine += sample * Math.sin(phase);
          cosine += sample * Math.cos(phase);
        }
        return 2 * Math.hypot(sine, cosine) / count;
      };
    };
    const final = await render('clip-sound-final');
    const excerpt = await render('clip-sound-excerpt', 0.625, 1.25);
    const songLevel = final(0.25, 220);
    expect(songLevel).toBeGreaterThan(0.08);
    expect(final(0.25, 660)).toBeLessThan(0.005);
    for (const measure of [final, excerpt]) {
      expect(measure(0.67, 660)).toBeGreaterThan(0.05);
      expect(measure(0.67, 440)).toBeLessThan(0.005); // first half-second was skipped
      expect(measure(0.86, 880)).toBeGreaterThan(0.05); // second tone arrives at 2x speed
      expect(measure(0.86, 660)).toBeLessThan(0.005);
      expect(measure(0.67, 220) / songLevel).toBeCloseTo(0.55, 1);
      expect(measure(1.12, 220) / songLevel).toBeCloseTo(1, 1);
      expect(measure(1.12, 880)).toBeLessThan(0.005);
    }
  }, 120000);

  // Uniquely catches the live preview bridging raw bytes without the shot's speed/offset (same samples as the render above).
  [
    { timing: { speedFps: 24, offsetFrames: 12 }, samples: [[0, 1], [5, 1], [6, 2]] },
    { timing: { speedFps: 24, offsetFrames: -6 }, samples: [[0, 0], [11, 0], [12, 1], [17, 1], [18, 2]] },
    { timing: { offsetFrames: -6 }, samples: [[0, 0], [17, 0], [18, 1], [29, 1], [30, 2]] },
  ].forEach(({ timing, samples }) => it(`plays shot speed and offset ${JSON.stringify(timing)} in the live preview`, async () => {
    await mkdir(PATHS.videos, { recursive: true });
    const clip = join(PATHS.videos, 'live-timed-rgb.webm');
    execFileSync(ffmpeg, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=64x36:r=24:d=0.5',
      '-f', 'lavfi', '-i', 'color=c=lime:s=64x36:r=24:d=0.5',
      '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=24:d=0.5',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libvpx', clip]);
    const created = await projects.createProject({ name: 'Synthetic live shot timing' });
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-live', filename: 'live-timed-rgb.webm', numFrames: 36, fps: 24, width: 64, height: 36 }]));
    await projects.mutateProjectRecord(created.id, current => ({ project: { ...current,
      audioAnalysis: { durationSec: 1.5, sections: [] },
      scenes: [{ sceneId: 'timed', startSec: 0, endSec: 1.5, videoHistoryId: 'vh-live', ...timing }],
    } }));
    await importDocumentTemplate(created.id);
    const preview = await buildDocumentPreview(await projects.getProject(created.id));
    const page = await browser.newPage();
    await page.setContent(preview.html);
    const bytes = (await readFile(clip)).toString('base64');
    await page.evaluate(async (base64) => {
      const blob = new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: 'video/webm' });
      addEventListener('message', ({ data }) => { if (data?.type === 'portos-mv:request') postMessage({ type: 'portos-mv:asset', key: data.key, blob }, '*'); });
      postMessage({ type: 'portos-mv:manifest', keys: ['media/scene-timed.webm'] }, '*');
      await window.PORTOS_MV_ASSETS;
    }, bytes);
    for (const [frame, channel] of samples) {
      const rgb = await page.evaluate(async (frame) => {
        await window.portosComposition.seek(frame / 24);
        const stage = document.getElementById('stage');
        const probe = document.createElement('canvas'); probe.width = stage.width; probe.height = stage.height;
        const ctx = probe.getContext('2d'); ctx.drawImage(stage, 0, 0);
        return [...ctx.getImageData(stage.width >> 1, stage.height >> 1, 1, 1).data.slice(0, 3)];
      }, frame);
      expect(rgb[channel], `frame ${frame}`).toBeGreaterThan(180);
      rgb.forEach((value, i) => { if (i !== channel) expect(value, `frame ${frame}`).toBeLessThan(60); });
    }
    await page.close();
  }, 120000));

  it('draws the selected take at SONG time in an excerpt, identically on every render, with the master muxed', async () => {
    const { cdpRequest } = await import('../browserService.js');
    const managedCalls = cdpRequest.mock.calls.length;
    const unrelatedPage = await browser.newPage();
    await unrelatedPage.setContent('<title>Unrelated browser session</title>');
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
    await writeFile(join(PATHS.data, 'video-history.json'), JSON.stringify([{ id: 'vh-rgb', filename: 'rgb.webm', numFrames: 72, fps: 24, width: 640, height: 360 }]));
    await projects.mutateProjectRecord(created.id, (current) => ({ project: {
      ...current,
      audioAnalysis: { durationSec: 6, beats: [], downbeats: [], sections: [] },
      scenes: [{ sceneId: 'rgb', order: 0, startSec: 0, endSec: 3, videoHistoryId: 'vh-rgb' }],
    } }));
    await importDocumentTemplate(created.id);
    const project = await projects.getProject(created.id);
    const plan = await prepareDocumentRender(project);

    const render = async (name) => {
      const outputPath = join(PATHS.videos, name);
      const result = await encodeDocumentComposition({ project, plan, jobId: `job-${name.replace(/\W/g, '')}`, audioPath: master, outputPath, windowStart: 1.02, windowEnd: 1.75, collectFootageVisibility: true });
      return { result, outputPath };
    };
    const first = await render('first.mp4');
    // A virtual-origin clip must remain canvas-readable inside the opaque
    // browser sandbox; tainted pixels formerly collapsed every sample to null.
    expect(first.result.footageVisibility).toHaveLength(3);
    expect(first.result.footageVisibility.every(sample => sample.status === 'measured')).toBe(true);
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
    expect(cdpRequest.mock.calls.length).toBe(managedCalls);
    expect(await unrelatedPage.title()).toBe('Unrelated browser session');
    await unrelatedPage.close();
    const hashes = (path) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, '-map', '0:v', '-f', 'framemd5', '-']).toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
    expect(hashes(second.outputPath)).toEqual(hashes(first.outputPath));
    // The staged job folder is gone once the render ends.
    expect(existsSync(join(PATHS.data, 'music-video-song-renders', 'job-firstmp4'))).toBe(false);
    await rm(first.outputPath, { force: true });
    await rm(second.outputPath, { force: true });
  }, 120000);

  ['ramps', 'generated-shots'].forEach(fixture => it(`[fidelity] matches bounded grades across real composed/document ${fixture} and song-time excerpts`, async () => {
    const { buildMusicVideoFfmpegArgs } = await import('./renderFfmpegArgs.js');
    // Synthetic ramps and a committed, explicitly commissioned generated-shot
    // fixture. Tests access no install data, providers, or network images.
    const width = 1280;
    const height = 720;
    const fps = 12;
    const bytes = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const v = Math.round(255 * x / (width - 1));
      const band = Math.floor(y / 180);
      const rgb = band === 0 ? [v, v, v] : band === 1 ? [v, 72, 104] : band === 2 ? [104, v, 72] : [72, 104, v];
      bytes.set(rgb, (y * width + x) * 3);
    }
    const directory = 'music-video/mv-grade/composition/doc-grade';
    const dir = join(PATHS.data, directory);
    await mkdir(dir, { recursive: true });
    await mkdir(PATHS.music, { recursive: true });
    await mkdir(PATHS.videos, { recursive: true });
    const reference = join(dir, 'reference.png');
    if (fixture === 'generated-shots') {
      await sharp(await readFile(new URL('./__fixtures__/grade-reference.webp', import.meta.url)))
        .resize(width, height).png().toFile(reference);
    } else {
      await sharp(bytes, { raw: { width, height, channels: 3 } }).png().toFile(reference);
    }
    await writeFile(join(dir, 'index.html'), `<!doctype html><style>html,body{margin:0}img{width:${width}px;height:${height}px;display:block}</style>
      <img id="reference" src="reference.png"><script>window.portosComposition={durationSec:1,fps:${fps},width:${width},height:${height},seek:async()=>{await document.getElementById('reference').decode()}};</script>`);
    const master = join(PATHS.music, 'grade.wav');
    // A 1s timeline (12 frames) keeps every behavior under test: three scenes
    // with distinct grades and a mid-song excerpt that crosses a scene cut.
    // Real Chrome capture costs ~250ms per 720p frame, so frame count is the
    // knob that keeps this far from the per-test limit on a loaded host (#10132).
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', master]);
    const source = join(PATHS.videos, 'grade-source.mkv');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-loop', '1', '-i', reference, '-t', '1', '-r', String(fps), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p', source]);
    const scenes = [{ sceneId: 'a', startSec: 0, endSec: 0.5 }, { sceneId: 'b', startSec: 0.5, endSec: 0.75 }, { sceneId: 'c', startSec: 0.75, endSec: 1 }];
    const grade = { preset: 'teal-night', grain: 0.03, sections: [{ sceneId: 'b', preset: 'golden-hour' }, { sceneId: 'c', preset: 'monochrome' }] };
    const project = { id: 'mv-grade', name: 'Synthetic grade reference', scenes,
      audioAnalysis: { durationSec: 1, sections: [] }, composition: { mode: 'document', grade, document: { directory } } };
    const plan = await prepareDocumentRender(project);
    const document = join(PATHS.videos, 'grade-document.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'grade-document', audioPath: master, outputPath: document });
    const clips = scenes.map((scene) => ({ sceneId: scene.sceneId, videoPath: source, inSec: 0, outSec: scene.endSec - scene.startSec, width, height, fps }));
    const composed = join(PATHS.videos, 'grade-composed.mp4');
    const composedArgs = buildMusicVideoFfmpegArgs(clips, master, composed, { grade, frameGrid: true }).args;
    execFileSync(ffmpeg, ['-v', 'error', ...composedArgs], { stdio: 'pipe' });
    const decode = (path, filters = []) => execFileSync(ffmpeg, ['-v', 'error', '-i', path, ...filters, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
    const frameSize = width * height * 3;
    const documentRgb = decode(document);
    const composedRgb = decode(composed);
    expect(documentRgb.length).toBe(frameSize * fps);
    expect(composedRgb.length).toBe(documentRgb.length);
    const mae = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
    // Browser RGB and video YUV420 differ by conversion/subsampling and H.264
    // quantization; palette parity is bounded rather than falsely byte-exact.
    expect(mae(documentRgb, composedRgb)).toBeLessThan(5);
    const excerpt = join(PATHS.videos, 'grade-excerpt.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'grade-excerpt', audioPath: master, outputPath: excerpt, windowStart: 0.25, windowEnd: 0.75 });
    const excerptRgb = decode(excerpt);
    // Independently encoded H.264 portrait textures have more prediction error
    // than ramps. Retain the ramp's bound and use 3/255 for the new fixture;
    // the repeated excerpt below must still be decoded byte-identical.
    const excerptTolerance = fixture === 'ramps' ? 2 : 3;
    const excerptError = mae(excerptRgb, documentRgb.subarray(3 * frameSize, 9 * frameSize));
    expect(excerptError).toBeLessThan(excerptTolerance);
    const repeat = join(PATHS.videos, 'grade-repeat.mp4');
    await encodeDocumentComposition({ project, plan, jobId: 'grade-repeat', audioPath: master, outputPath: repeat, windowStart: 0.25, windowEnd: 0.75 });
    expect(decode(repeat).equals(excerptRgb)).toBe(true);
    const composedExcerpt = join(PATHS.videos, 'grade-composed-excerpt.mp4');
    execFileSync(ffmpeg, ['-v', 'error', ...buildMusicVideoFfmpegArgs(clips, master, composedExcerpt, {
      grade, frameGrid: true, excerpt: { startSec: 0.25, endSec: 0.75 },
    }).args], { stdio: 'pipe' });
    const composedExcerptError = mae(decode(composedExcerpt), composedRgb.subarray(3 * frameSize, 9 * frameSize));
    expect(composedExcerptError).toBeLessThan(excerptTolerance);
    let neutralExcerptError = null;
    if (fixture === 'generated-shots') {
      const neutralProject = { ...project, composition: { ...project.composition, grade: null } };
      const neutralFull = join(PATHS.videos, 'neutral-full.mp4');
      const neutralExcerpt = join(PATHS.videos, 'neutral-excerpt.mp4');
      await encodeDocumentComposition({ project: neutralProject, plan, jobId: 'neutral-full', audioPath: master, outputPath: neutralFull });
      await encodeDocumentComposition({ project: neutralProject, plan, jobId: 'neutral-excerpt', audioPath: master, outputPath: neutralExcerpt, windowStart: 0.25, windowEnd: 0.75 });
      neutralExcerptError = mae(decode(neutralExcerpt), decode(neutralFull).subarray(3 * frameSize, 9 * frameSize));
      expect(neutralExcerptError).toBeLessThan(3);
      // A codec baseline independently bounds the additional grading error,
      // rather than letting a textured fixture excuse arbitrary divergence.
      expect(excerptError).toBeLessThan(neutralExcerptError + 1);
    }
    const pixel = (rgb, frame, x, y) => [...rgb.subarray(frame * frameSize + (y * width + x) * 3, frame * frameSize + (y * width + x) * 3 + 3)];
    if (fixture === 'ramps') {
      const cool = pixel(documentRgb, 3, 640, 90);
      const warm = pixel(documentRgb, 6, 640, 90);
      const monochrome = pixel(documentRgb, 9, 640, 270);
      expect(Math.max(...monochrome) - Math.min(...monochrome)).toBeLessThan(4);
      expect(cool[2]).toBeGreaterThan(cool[0] + 15);
      expect(warm[0]).toBeGreaterThan(warm[2] + 15);
      expect(Math.max(...pixel(documentRgb, 3, 0, 90))).toBeLessThan(5);
      expect(Math.min(...pixel(documentRgb, 3, width - 1, 90))).toBeGreaterThan(248);
    }
    // Optional local proof export: only synthetic fixtures, never live records.
    if (process.env.PORTOS_GRADE_PROOF_DIR) {
      const proof = join(process.env.PORTOS_GRADE_PROOF_DIR, fixture);
      await mkdir(proof, { recursive: true });
      await copyFile(reference, join(proof, 'reference.png'));
      for (const [label, path] of [['document', document], ['composed', composed], ['excerpt', excerpt]]) {
        execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', path, '-vf', "select='eq(n,3)+eq(n,6)+eq(n,9)',scale=480:270,tile=3x1", '-frames:v', '1', join(proof, `${label}.png`)]);
      }
      await writeFile(join(proof, 'metrics.json'), JSON.stringify({ paletteMeanAbsoluteError: mae(documentRgb, composedRgb), excerptMeanAbsoluteError: excerptError, composedExcerptMeanAbsoluteError: composedExcerptError, neutralExcerptMeanAbsoluteError: neutralExcerptError, repeatIdentical: true }, null, 2));
    }
  }, 120000));
});
