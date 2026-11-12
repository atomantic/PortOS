/**
 * The film look finishing pass over a footage render, with the composition
 * browser, the shared encoder and ffmpeg stubbed at their boundaries: what the
 * pass stages and asks of them, that the render is replaced in place only
 * once the pass succeeds, and that nothing is left behind either way.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), {
  dataRoot: () => lazyTempDataRoot('portos-mv-film-look-finish-'),
}));
const { seen } = vi.hoisted(() => ({ seen: { webAdmitted: false, webFail: null, webAbort: null, webCheck: null, geometryFrames: 48, opened: [], contract: null, options: null, progress: [], ffmpeg: [], encodeFail: null, labelFail: false, signature: null, page: null } }));
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: async () => 'ffmpeg',
  // 48 frames at 24 fps: the container reports a hair more than the frames hold.
  probeVideoGeometry: async () => ({ width: 1280, height: 720, fps: 24, numFrames: seen.geometryFrames, durationSec: seen.geometryFrames / 24 + 0.04 }),
  probeVideoCodecSignature: async () => seen.signature,
  runFfmpegProcess: async ({ args }) => {
    const { writeFile: write } = await import('node:fs/promises');
    seen.ffmpeg.push(args);
    // The staging step relabels the render's stream; the mux writes the finished file.
    const staging = args.includes('-bsf:v');
    if (staging && seen.labelFail) return { ok: false, reason: 'this stream takes no label' };
    await write(args.at(-1), staging ? 'labelled-render' : 'finished-video');
    return { ok: true };
  },
}));
// The browser mock records the staged page the pass opens and how it opens it.
vi.mock('../htmlComposition/browser.js', () => ({
  openComposition: async (directory, options) => {
    const { readFile: read } = await import('node:fs/promises');
    const { join: joinPath } = await import('node:path');
    const { PATHS: paths } = await import('../../lib/paths.js');
    const dir = joinPath(paths.data, directory);
    seen.opened.push({
      directory, options,
      index: await read(joinPath(dir, 'index.html'), 'utf8'),
      app: await read(joinPath(dir, 'app.js'), 'utf8'),
      source: await read(joinPath(dir, 'media', 'source.mp4'), 'utf8'),
    });
    return seen.page?.() || { evaluate: async () => 'probably', check() {}, async close() {}, async send() { return {}; } };
  },
}));
vi.mock('./filmLookWebEncoder.js', () => ({
  admitFilmLookWeb: async (_page, _contract, _directory, options) => { seen.webCheck = options; return seen.webAdmitted; },
  encodeFilmLookWeb: async () => {},
}));
vi.mock('../htmlComposition/encode.js', () => ({
  encodeComposition: vi.fn(),
  encodeCompositionSegments: async (_page, contract, outputPath, options) => {
    const { writeFile: write } = await import('node:fs/promises');
    seen.contract = contract;
    seen.options = options;
    if (seen.webFail && options.encode.name === 'encodeFilmLookWeb') { seen.webAbort?.abort(); throw seen.webFail; }
    if (seen.encodeFail) throw seen.encodeFail;
    // A worker browser, opened while the page is staged.
    if (seen.page) await options.openPage();
    options.onProgress?.(0.5);
    await write(outputPath, 'silent-video');
    return { workers: 1, timing: { frames: 48, seekMs: 480, drawMs: 0, captureMs: 960, encodeMs: 96, gpuFrames: 0, svgFrames: 48 } };
  },
}));

const { PATHS } = await import('../../lib/paths.js');
const { FILM_LOOK_FINISH_SCRATCH_DIR, applyFilmLookFinish, filmLookFinishNeeded } = await import('./filmLookFinish.js');

const look = { preset: 'super8', grain: 0.5, halation: 0.4 };
let path;
beforeEach(async () => {
  seen.opened.length = 0;
  seen.ffmpeg.length = 0;
  seen.progress.length = 0;
  seen.contract = null;
  seen.options = null;
  seen.encodeFail = null;
  seen.webAdmitted = false; seen.webFail = null; seen.webAbort = null; seen.webCheck = null; seen.geometryFrames = 48;
  seen.labelFail = false;
  // What every PortOS encoder writes.
  seen.signature = 'codec_name=h264|color_primaries=bt709|color_range=tv|color_space=bt709|color_transfer=bt709|pix_fmt=yuv420p';
  seen.page = null;
  await mkdir(PATHS.videos, { recursive: true });
  path = join(PATHS.videos, 'music-video-example.mp4');
  await writeFile(path, 'composed-render');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => cleanupTempDataRoots());

// A page whose GPU path draws `gpuPng` in `gpuMs` and whose SVG filter draws
// `svgPng` in `svgMs`, on a fake clock the seek advances. Records each switch.
function drawingPage({ svgPng, gpuPng, svgMs, gpuMs, switches }) {
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  return () => {
    let gpu = false;
    return {
      check() {}, async close() {},
      async send(method) { return method === 'Page.captureScreenshot' ? { data: (gpu ? gpuPng : svgPng).toString('base64') } : {}; },
      async evaluate(expression) {
        if (expression.includes('canPlayType')) return 'probably';
        if (expression.includes('gpuInfo()')) return { available: true };
        const on = /useGpu\((true|false)\)/.exec(expression);
        if (on) { gpu = on[1] === 'true'; switches.push(gpu); return { on: gpu, renderer: 'Test GPU' }; }
        if (expression.includes('seek(')) clock += gpu ? gpuMs : svgMs;
        return undefined;
      },
    };
  };
}
const solidPng = async (r) => (await import('sharp')).default({ create: { width: 8, height: 8, channels: 3, background: { r, g: 90, b: 40 } } }).png().toBuffer();

describe('film look finishing pass', () => {
  it('leaves a render without a look alone, without a browser', async () => {
    expect(filmLookFinishNeeded({ filmLook: null })).toBe(false);
    expect(filmLookFinishNeeded({ filmLook: { preset: 'none' } })).toBe(false);
    expect(filmLookFinishNeeded({ filmLook: look })).toBe(true);
    expect(await applyFilmLookFinish({ project: { filmLook: null }, path, jobId: 'job-plain' })).toBe(false);
    expect(seen.opened).toEqual([]);
    expect(await readFile(path, 'utf8')).toBe('composed-render');
  });

  it('plays the finished cut through the look on song time, copies its audio back and replaces it in place', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-look', offsetSec: 3, onProgress: (f) => seen.progress.push(f) });
    expect(result).toBe(true);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('workers 1; GPU/SVG frames 0/48; ms/frame seek 10.0, GPU draw submission 0.0, capture (includes SVG draw/GPU wait) 20.0, encode write/drain 2.0'));
    log.mockRestore();
    // The staged page: the render itself (its stream copied and labelled sRGB, never re-encoded), full frame, seeking on song time.
    expect(seen.opened).toHaveLength(1);
    const [opened] = seen.opened;
    expect(opened.directory).toBe(`${FILM_LOOK_FINISH_SCRATCH_DIR}/job-look`);
    expect(opened.options).toMatchObject({ streamMedia: true, ownedBrowser: true });
    expect(opened.options.initScripts).toHaveLength(1);
    expect(opened.options.initScripts[0]).toContain('__portosFilmLook');
    expect(opened.options.initScripts[0]).toContain('"grain":0.5');
    expect(opened.source).toBe('labelled-render');
    const [staged, mux] = seen.ffmpeg;
    expect(staged.slice(staged.indexOf('-i'))).toEqual(['-i', path, '-map', '0:v:0', '-c', 'copy', '-an',
      '-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=13:matrix_coefficients=1', '-movflags', '+faststart', '-y', join(PATHS.data, FILM_LOOK_FINISH_SCRATCH_DIR, 'job-look', 'media', 'source.mp4')]);
    expect(opened.index).toContain('<video id="source" src="media/source.mp4"');
    expect(opened.app).toContain('OFFSET = 3');
    expect(opened.app).toContain('FPS = 24');
    expect(opened.app).toContain('globalThis.portosComposition =');
    // The contract is the render's own geometry on whole frames; the window starts at the excerpt's song time.
    expect(seen.contract).toEqual({ width: 1280, height: 720, fps: 24, durationSec: 2 });
    expect(seen.options).toMatchObject({ offsetSec: 3 });
    expect(seen.progress).toEqual([0.475, 1]);
    // Pixels from the pass, audio copied from the render, then swapped in.
    expect(seen.ffmpeg).toHaveLength(2);
    expect(mux.slice(mux.indexOf('-i'))).toEqual(['-i', `${path}.look.silent.mp4`, '-i', path, '-map', '0:v:0', '-map', '1:a?', '-c', 'copy', '-movflags', '+faststart', '-y', `${path}.look.mp4`]);
    expect(await readFile(path, 'utf8')).toBe('finished-video');
    expect(existsSync(join(PATHS.data, FILM_LOOK_FINISH_SCRATCH_DIR, 'job-look'))).toBe(false);
    expect(existsSync(`${path}.look.silent.mp4`)).toBe(false);
    expect(existsSync(`${path}.look.mp4`)).toBe(false);
  });

  it('keeps the render as it was when the capture fails, and cleans up', async () => {
    seen.encodeFail = new Error('browser died');
    await expect(applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-fail' })).rejects.toThrow('browser died');
    expect(await readFile(path, 'utf8')).toBe('composed-render');
    // Staged, never muxed.
    expect(seen.ffmpeg.map((args) => args.includes('-bsf:v'))).toEqual([true]);
    expect(existsSync(join(PATHS.data, FILM_LOOK_FINISH_SCRATCH_DIR, 'job-fail'))).toBe(false);
  });

  it('plays a stream that is not tagged BT.709 H.264 as it is, and a render the label fails on likewise', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // An untagged clip: the label would name a matrix its decoder may not be using.
    seen.signature = 'codec_name=h264|color_space=unknown|color_transfer=unknown|pix_fmt=yuv420p';
    expect(await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-untagged' })).toBe(true);
    expect(seen.opened[0].source).toBe('composed-render');
    expect(seen.ffmpeg.some((args) => args.includes('-bsf:v'))).toBe(false);
    expect(warned).not.toHaveBeenCalled();

    await writeFile(path, 'composed-render');
    seen.signature = 'codec_name=h264|color_primaries=bt709|color_space=bt709|color_transfer=bt709';
    seen.labelFail = true;
    expect(await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-unlabelled' })).toBe(true);
    expect(seen.opened[1].source).toBe('composed-render');
    expect(warned).toHaveBeenCalledWith(expect.stringContaining('could not be labelled sRGB'));
    expect(await readFile(path, 'utf8')).toBe('finished-video');
  });

  it('preserves non-BT.709 primaries even with BT.709 matrix and transfer tags', async () => {
    seen.signature = 'codec_name=h264|color_primaries=bt2020|color_space=bt709|color_transfer=bt709';
    await expect(applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-other-primaries' })).resolves.toBe(true);
    expect(seen.opened[0].source).toBe('composed-render');
    expect(seen.ffmpeg.some(args => args.includes('-bsf:v'))).toBe(false);
  });

  it('uses WebCodecs only after GPU and encoded quality admission', async () => {
    const png = await solidPng(120);
    seen.page = drawingPage({ svgPng: png, gpuPng: png, svgMs: 100, gpuMs: 10, switches: [] });
    seen.geometryFrames = 240;
    seen.webAdmitted = true;
    await expect(applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'web-admitted', onProgress: f => seen.progress.push(f) })).resolves.toBe(true);
    expect(seen.options.encode).toBe((await import('./filmLookWebEncoder.js')).encodeFilmLookWeb);
    expect(seen.progress).toEqual([0.475, 1]);
    expect(await readFile(path, 'utf8')).toBe('finished-video');
  });

  it('restarts the entire pass with PNG when an admitted WebCodecs worker fails', async () => {
    const png = await solidPng(120);
    const switches = [];
    seen.page = drawingPage({ svgPng: png, gpuPng: png, svgMs: 100, gpuMs: 10, switches });
    seen.geometryFrames = 240;
    seen.webAdmitted = true;
    seen.webFail = new Error('reordered frames');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'web-fallback' })).resolves.toBe(true);
    expect(seen.options.encode).toBe((await import('../htmlComposition/encode.js')).encodeComposition);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('restarting with PNG'));
    expect(await readFile(path, 'utf8')).toBe('finished-video');
  });

  it('keeps the source and does not restart after cancellation during WebCodecs', async () => {
    const png = await solidPng(120);
    seen.page = drawingPage({ svgPng: png, gpuPng: png, svgMs: 100, gpuMs: 10, switches: [] });
    seen.geometryFrames = 240;
    seen.webAdmitted = true;
    seen.webAbort = new AbortController();
    seen.webFail = new Error('aborted');
    await expect(applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'web-cancel', signal: seen.webAbort.signal })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('composed-render');
    expect(seen.options.encode.name).toBe('encodeFilmLookWeb');
    expect(seen.ffmpeg).toHaveLength(1);
  });

  // Uniquely catches a steady card left out of the picture and then never drawn (no runtime in one of
  // the pass's browsers), drawn under the look, running on over an ending joined after the song, or
  // admitted to WebCodecs without one of the frames it shows in being compared.
  it('draws a title card it is handed over the look in every browser of the pass, and has its frames checked for WebCodecs', async () => {
    const png = await solidPng(120);
    seen.page = drawingPage({ svgPng: png, gpuPng: png, svgMs: 100, gpuMs: 10, switches: [] });
    seen.geometryFrames = 240;
    seen.webAdmitted = true;
    const titleCard = { title: 'Example Song', artist: 'Example Artist', style: 'outline', startSec: 4, endSec: 8, outro: true, outroStartSec: 11, outroEndSec: 30 };
    expect(await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-card', offsetSec: 3, titleCard, titleCardUntilSec: 12 })).toBe(true);
    // The check page, the page reopened after the WebCodecs check and a worker browser.
    expect(seen.opened).toHaveLength(3);
    for (const opened of seen.opened) {
      expect(opened.options.initScripts).toHaveLength(2);
      expect(opened.options.initScripts[0]).toContain('__portosFilmLook');
      const runtime = opened.options.initScripts[1];
      expect(runtime).toContain('__portosTitleCard');
      // Over the look whatever the card says of itself, and gone where the song ends.
      expect(runtime).toContain('"title":"Example Song"');
      expect(runtime).toContain('"steady":true');
      expect(runtime).toContain('const UNTIL = 12;');
    }
    // Ten seconds from song second 3: the middle of the opening window, and of what is left of the end window before second 12.
    expect(seen.webCheck).toMatchObject({ offsetSec: 3, checkTimes: [6, 11.5] });

    // A card that draws nothing costs the pass nothing.
    seen.opened.length = 0;
    await writeFile(path, 'composed-render');
    expect(await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-no-card', titleCard: { ...titleCard, enabled: false } })).toBe(true);
    expect(seen.opened.map((opened) => opened.options.initScripts.length)).toEqual([1, 1, 1]);
    expect(seen.webCheck.checkTimes).toEqual([]);
  });

  // Uniquely catches a WebCodecs frame that misses the card (read from the GPU canvas alone while the
  // card shows over it), and a frame without the card no longer read straight from that canvas.
  it('flattens the title card onto a WebCodecs frame only while the card shows', async () => {
    await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'web-card', useGpu: false });
    const sources = [];
    const drawn = [];
    class Encoder {
      static async isConfigSupported(config) { return { supported: true, config }; }
      constructor(callbacks) { this.callbacks = callbacks; this.encodeQueueSize = 0; }
      configure() {}
      encode(frame) { this.callbacks.output({ timestamp: frame.timestamp, type: 'key', byteLength: 1, copyTo(bytes) { bytes[0] = 1; } }); }
    }
    class Frame { constructor(source, options) { sources.push(source.name); this.timestamp = options.timestamp; } close() {} }
    class Reader { readAsDataURL(blob) { void blob.arrayBuffer().then(bytes => { this.result = `data:;base64,${Buffer.from(bytes).toString('base64')}`; this.onload(); }); } }
    const film = { name: 'film', style: {} };
    const flat = { name: 'flat', getContext: (_kind, options) => ({ drawImage: (source, ...box) => drawn.push([source.name, options.alpha, ...box]) }) };
    const card = { layer: null };
    const context = { document: { getElementById: id => id === 'source' ? { readyState: 2 } : film, createElement: () => flat },
      __portosFilmLookGpu: { create: () => ({ renderer: 'test', dispose() {} }) }, __portosTitleCard: card,
      VideoEncoder: Encoder, VideoFrame: Frame, FileReader: Reader, Blob, performance, setTimeout, clearTimeout };
    runInNewContext(seen.opened[0].app, context);
    context.__portosFilmLookFinish.useGpu(true);
    await context.__portosFilmLookFinish.startEncoder();
    const { frameEncoder } = context.__portosFilmLookFinish;
    await frameEncoder.frame();
    card.layer = { name: 'card' };
    await frameEncoder.frame();
    card.layer = null;
    await frameEncoder.frame();
    expect(sources).toEqual(['film', 'flat', 'film']);
    // The film's picture first, on an opaque canvas, then the card over it, both at the render's frame.
    expect(drawn).toEqual([['film', false, 0, 0, 1280, 720], ['card', false, 0, 0, 1280, 720]]);
    expect(flat).toMatchObject({ width: 1280, height: 720 });
  });

  it('rejects reordered or missing WebCodecs chunks before muxing', async () => {
    await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'web-order', useGpu: false });
    const script = seen.opened[0].app;
    const setup = (mode) => {
      let index = 0;
      class Encoder {
        static async isConfigSupported(config) { return { supported: true, config }; }
        constructor(callbacks) { this.callbacks = callbacks; this.encodeQueueSize = 0; }
        configure() {}
        encode(frame) {
          if (mode === 'drop' && index++ === 1) return;
          const timestamp = mode === 'reorder' ? frame.timestamp + 1 : frame.timestamp;
          this.callbacks.output({ timestamp, type: 'key', byteLength: mode === 'oversize' ? 20_000_000 : 1, copyTo(bytes) { bytes[0] = 1; } });
        }
        async flush() {}
        close() {}
      }
      class Frame { constructor(_canvas, options) { this.timestamp = options.timestamp; } close() {} }
      class Reader { readAsDataURL(blob) { void blob.arrayBuffer().then(bytes => { this.result = `data:;base64,${Buffer.from(bytes).toString('base64')}`; this.onload(); }); } }
      const video = { readyState: 2 };
      const canvas = { style: {} };
      const context = { document: { getElementById: id => id === 'source' ? video : canvas },
        __portosFilmLookGpu: { create: () => ({ renderer: 'test', dispose() {} }) },
        VideoEncoder: Encoder, VideoFrame: Frame, FileReader: Reader, Blob, performance, setTimeout, clearTimeout };
      runInNewContext(script, context);
      context.__portosFilmLookFinish.useGpu(true);
      return context.__portosFilmLookFinish;
    };
    const reordered = setup('reorder');
    await reordered.startEncoder();
    await expect(reordered.frameEncoder.frame()).rejects.toThrow('reordered frames');
    const oversized = setup('oversize');
    await oversized.startEncoder();
    await expect(oversized.frameEncoder.frame()).rejects.toThrow('exceeded frame budget');
    const missing = setup('drop');
    await missing.startEncoder();
    await missing.frameEncoder.frame();
    await missing.frameEncoder.frame();
    await expect(missing.frameEncoder.finish()).rejects.toThrow('lost frames');
  });

  it('draws the look on the GPU only when its check frame matches the SVG filter and is faster', async () => {
    const svgPng = await solidPng(120);
    // Same picture, cheaper on the GPU: every browser of the pass switches to it.
    const switches = [];
    seen.page = drawingPage({ svgPng, gpuPng: svgPng, svgMs: 100, gpuMs: 10, switches });
    expect(await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-gpu' })).toBe(true);
    expect(switches).toEqual([true, true]);

    // A different picture keeps the SVG filter, on the check page and every worker.
    await writeFile(path, 'composed-render');
    const mismatched = [];
    seen.page = drawingPage({ svgPng, gpuPng: await solidPng(200), svgMs: 100, gpuMs: 10, switches: mismatched });
    expect(await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-mismatch' })).toBe(true);
    expect(mismatched).toEqual([true, false]);

    // The same picture drawn slower (a software rasterizer) keeps it too.
    await writeFile(path, 'composed-render');
    const slower = [];
    seen.page = drawingPage({ svgPng, gpuPng: svgPng, svgMs: 100, gpuMs: 300, switches: slower });
    expect(await applyFilmLookFinish({ project: { filmLook: look }, path, jobId: 'job-slow' })).toBe(true);
    expect(slower).toEqual([true, false]);
  });
});
