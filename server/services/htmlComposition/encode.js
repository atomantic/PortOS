import { pcmToWavBuffer } from '../../lib/chiptuneRender.js';
import { spawn } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { availableParallelism, totalmem } from 'node:os';
import { rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { blurFrame } from './shutterBlur.js';
import { findFfmpeg, runFfmpegProcess, probeVideoDuration, H264_ENCODE_ARGS, AAC_ENCODE_ARGS, BT709_CONTAINER_ARGS, bt709TagFilter, planLoudnessMaster, reportMasteredLoudness } from '../../lib/ffmpeg.js';

// Size the viewport for this format, then let the composition reframe itself
// (#8960) before any seek captures it. A composition without a layout hook
// renders exactly as before.
async function frameFormat(page, { width, height, layout }) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  if (layout) {
    page.check();
    await page.evaluate(`globalThis.portosComposition.layout({ width: ${width}, height: ${height} })`);
  }
  page.check();
}

// A composition's seek(t) owns its frame: a rejection (a <video> that failed
// to seek, a missing asset) or a hung seek must fail the render loudly and say
// which frame, never capture whatever the page last painted.
async function seekComposition(page, t, frame) {
  try {
    await page.evaluate(`globalThis.portosComposition.seek(${t})`);
  } catch (error) {
    throw new Error(`Composition seek(${t}) failed${frame == null ? '' : ` at frame ${frame}`}: ${error.message}`);
  }
}

// PNG stays lossless; optimizeForSpeed only trades file size for encode time
// (about 3x faster on photographic 1080p frames).
const SCREENSHOT = Object.freeze({ format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false });

// Stream one frame at a time. The write callback supplies back-pressure and
// the terminal race releases a pending write on exit, disconnect or cancel.
// `offsetSec` seeks a window of a longer timeline: frame n is drawn at
// `offsetSec + n / fps` (a music-video excerpt stays on song time).
// `continuous` marks a window that continues an earlier one (a parallel
// segment): its first frame's auto-shutter comparison sees the real previous
// frame instead of treating the window start as the start of the song.
export async function encodeComposition(page, contract, outputPath, { musicPath, audio, signal, onProgress, offsetSec = 0, continuous = false, videoFilter = null, master = false, runFfmpeg = runFfmpegProcess, spawnProcess = spawn, locateFfmpeg = findFfmpeg, tagFilter = bt709TagFilter } = {}) {
  const ffmpeg = await locateFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found on PATH');
  const tag = await tagFilter();
  signal?.throwIfAborted();
  const { fps, durationSec, width, height, motionBlur } = contract;
  const numFrames = Math.round(durationSec * fps);
  // Music-video masters are cut once (`-ss` / `-t`) and muxed whole. Library
  // beds keep the launch-video loop and half-second tail fade.
  const exactAudio = audio?.path ? audio : null;
  if (exactAudio && musicPath) throw new Error('Music-video audio replaces library music');
  // Library and synthesized beds (never an exact music-video master) can be
  // mastered to the loudness target (#10249): measure the trimmed bed first,
  // then apply the linear gain inside the encode's own audio filter.
  const bedTrim = `atrim=duration=${durationSec},asetpts=PTS-STARTPTS`;
  const mastering = master && musicPath
    ? await planLoudnessMaster({ bin: ffmpeg, inputArgs: ['-stream_loop', '-1', '-i', musicPath], prefilter: bedTrim, durationSec, signal, run: runFfmpeg })
    : null;
  // Integer motionBlur (1-4) captures that many subframes per output frame and
  // lets ffmpeg's tmix filter blend them; 1 (default) captures/encodes exactly
  // as before, byte for byte. The object form (#9077) blends in Node instead
  // and pipes one raw RGB frame per output frame.
  const shutter = typeof motionBlur === 'object' ? motionBlur : null;
  const sub = shutter ? 1 : motionBlur ?? 1;
  const motionBlurFilter = sub > 1
    ? `tmix=frames=${sub},select='eq(mod(n\\,${sub})\\,${sub - 1})',setpts=N/${fps}/TB`
    : null;
  await frameFormat(page, contract);
  const input = shutter ? ['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${width}x${height}`] : ['-f', 'image2pipe', '-vcodec', 'png'];
  const args = ['-hide_banner', '-loglevel', 'error', ...input, '-framerate', String(fps * sub), '-i', 'pipe:0'];
  if (exactAudio) args.push('-ss', String(exactAudio.startSec ?? 0), '-t', String(durationSec), '-i', exactAudio.path);
  else if (musicPath) args.push('-stream_loop', '-1', '-i', musicPath);
  args.push('-map', '0:v', '-vf', [motionBlurFilter, videoFilter, 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709', tag].filter(Boolean).join(','), ...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS);
  if (exactAudio) args.push('-map', '1:a', ...AAC_ENCODE_ARGS);
  else if (musicPath) args.push('-map', '1:a', '-af', `${bedTrim}${mastering ? `,${mastering.filter}` : ''},afade=t=out:st=${durationSec - 0.5}:d=0.5`, ...AAC_ENCODE_ARGS);
  args.push('-frames:v', String(numFrames), '-t', String(durationSec), '-movflags', '+faststart', '-y', outputPath);
  const proc = spawnProcess(ffmpeg, args, safeChildProcessOptions({ stdio: ['pipe', 'ignore', 'pipe'] }));
  let stderr = '';
  let exited = false;
  let stopping = false;
  let stopReason = null;
  let exitDetail = '';
  let inputError = null;
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const finished = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.stdin.on('error', error => { inputError = error; reject(error); });
    proc.once('close', (code, exitSignal) => {
      exited = true;
      const origin = stopReason ? `; encoder ${stopReason}` : exitSignal ? '; external signal (no encoder stop requested)' : '';
      exitDetail = `ffmpeg exited with ${code ?? exitSignal ?? 'unknown status'}${origin}${stderr ? `: ${stderr}` : ''}`;
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code ?? exitSignal ?? 'unknown'}${origin}): ${stderr}`));
    });
  });
  // Attach a rejection handler before the first browser round trip.
  finished.catch(() => {});
  // One watcher for the whole job. A per-frame `.then` on `finished` piles up
  // handlers for a song-length capture (600s at 12fps is 7200 of them).
  let failEncoder;
  const encoderStopped = new Promise((_, reject) => { failEncoder = reject; });
  encoderStopped.catch(() => {});
  finished.then(
    () => failEncoder(new Error('ffmpeg exited before capture completed')),
    (error) => failEncoder(error),
  );
  const stop = (reason) => {
    if (!exited && !stopping) {
      stopping = true;
      stopReason = reason;
      killWithEscalation(proc, { label: 'HTML composition encode', stillRunning: () => !exited, delayMs: 1000 });
    }
  };
  const abort = () => stop('abort requested');
  signal?.addEventListener('abort', abort, { once: true });
  if (!Number.isFinite(offsetSec) || offsetSec < 0) throw new Error('offsetSec must be a non-negative number');
  const capture = async t => {
    page.check();
    // awaitPromise in evaluate is essential: each seek owns its paint.
    const at = offsetSec ? Math.round((offsetSec + t) * 1e6) / 1e6 : t;
    await seekComposition(page, at, Math.round(t * fps));
    page.check();
    const captureStarted = performance.now();
    const { data } = await page.send('Page.captureScreenshot', SCREENSHOT).catch(error => {
      throw new Error(`Composition capture failed at frame ${Math.round(t * fps)} (song ${at}s) after ${Math.round(performance.now() - captureStarted)}ms: ${error.message}`);
    });
    page.check();
    return Buffer.from(data, 'base64');
  };
  const write = bytes => Promise.race([
    new Promise((resolve, reject) => proc.stdin.write(bytes, error => error ? reject(error) : resolve())),
    encoderStopped,
  ]);
  const toRgb = png => sharp(png).removeAlpha().raw().toBuffer();
  // Output frames per sub-frame count: where a shutter render spent its time.
  const histogram = {};
  try {
    let previous = shutter?.samples === 'auto' && continuous && offsetSec > 0 && numFrames > 0 ? await capture(-1 / fps) : null;
    let centre = shutter?.samples === 'auto' && numFrames > 0 ? await capture(0) : null;
    for (let n = 0; n < numFrames; n++) {
      if (shutter) {
        let frame;
        if (shutter.samples === 'auto') {
          // Each frame's centre is captured one frame ahead. A frame whose
          // centre matches both neighbours' did not move this interval, so it
          // costs one capture, same as an unblurred render.
          const next = n + 1 < numFrames ? await capture((n + 1) / fps) : null;
          const still = (previous || next) && (!previous || previous.equals(centre)) && (!next || next.equals(centre));
          frame = still ? { rgb: await toRgb(centre), count: 1 }
            : await blurFrame(shutter, width, height, async offset => toRgb(await capture(Math.max(-offsetSec, (n + offset * shutter.shutter) / fps))), await toRgb(centre));
          previous = centre;
          centre = next;
        } else {
          frame = await blurFrame(shutter, width, height, async offset => toRgb(await capture(Math.max(-offsetSec, (n + offset * shutter.shutter) / fps))));
        }
        histogram[frame.count] = (histogram[frame.count] ?? 0) + 1;
        await write(frame.rgb);
      } else {
        for (let k = 0; k < sub; k++) await write(await capture(n / fps + k / (fps * sub)));
      }
      onProgress?.((n + 1) / numFrames, { frame: n + 1, frames: numFrames });
    }
    proc.stdin.end();
    await finished;
    page.check();
    const loudness = mastering ? await reportMasteredLoudness({ bin: ffmpeg, outputPath, before: mastering.before, signal, run: runFfmpeg }) : null;
    return { ...(shutter ? { sampleHistogram: histogram } : {}), ...(loudness ? { loudness } : {}) };
  } catch (error) {
    if (error.code === 'EPIPE' || inputError?.code === 'EPIPE') {
      // A closed pipe often arrives before the process's close event. Preserve
      // that event's signal and stderr instead of persisting just 'write EPIPE'.
      stop('input pipe closed');
      if (!exited) await new Promise(resolve => proc.once('close', resolve));
      throw new Error(`Render interrupted: encoder stopped accepting frames (EPIPE); ${exitDetail}. A server restart or encoder exit can interrupt a draft. Existing completed drafts are retained.`);
    }
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    stop('cleanup requested');
    // Wait for close, not just the first error, before deleting partial output.
    if (!exited) await new Promise(resolve => proc.once('close', resolve));
  }
}

// Capture is serial per page: seek, screenshot, pipe, one frame at a time, so a
// song-length render leaves most cores idle. A long render splits into frame
// ranges, each captured by its own browser into its own segment, then the
// segments join losslessly (stream copy). Seeks are deterministic by contract,
// so each frame is the same whichever browser draws it. Each browser holds a
// full-size page and its own encoder, so the count is capped by cores and RAM.
const SEGMENT_MIN_FRAMES = 240;
const SEGMENT_MAX_WORKERS = 4;
const SEGMENT_BYTES_PER_WORKER = 3 * 1024 ** 3;

export function compositionRenderWorkers({ cores = availableParallelism(), memoryBytes = totalmem() } = {}) {
  return Math.max(1, Math.min(SEGMENT_MAX_WORKERS, Math.floor(cores / 2), Math.floor(memoryBytes / SEGMENT_BYTES_PER_WORKER)));
}

/** Contiguous frame ranges `[{ start, frames }]`, each at least SEGMENT_MIN_FRAMES long. */
export function planSegments(numFrames, workers) {
  const count = Math.max(1, Math.min(workers, Math.floor(numFrames / SEGMENT_MIN_FRAMES)));
  const base = Math.floor(numFrames / count);
  const extra = numFrames % count;
  const segments = [];
  for (let i = 0, start = 0; i < count; i++) {
    const frames = base + (i < extra ? 1 : 0);
    segments.push({ start, frames });
    start += frames;
  }
  return segments;
}

// A video-only (silent) capture of `contract`, split across `workers` pages.
// `page` draws the first segment; `openPage(signal)` opens each further one
// and the segment closes it. `videoFilterAt(offsetSec)` builds a segment's
// filter on song time. One segment is exactly `encodeComposition`.
export async function encodeCompositionSegments(page, contract, outputPath, { openPage, workers = compositionRenderWorkers(), offsetSec = 0, videoFilterAt = () => null, signal, onProgress, encode = encodeComposition, runFfmpeg = runFfmpegProcess, locateFfmpeg = findFfmpeg } = {}) {
  const { fps, durationSec } = contract;
  const numFrames = Math.round(durationSec * fps);
  const segments = planSegments(numFrames, workers);
  if (segments.length === 1) {
    return encode(page, contract, outputPath, { signal, onProgress, offsetSec, videoFilter: videoFilterAt(offsetSec) });
  }
  const ffmpeg = await locateFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found on PATH');
  // One failed segment stops the rest instead of letting them run to the end.
  const controller = new AbortController();
  const relay = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', relay, { once: true });
  const parts = segments.map((_, i) => `${outputPath}.part${i}.mp4`);
  const listPath = `${outputPath}.parts.txt`;
  const done = segments.map(() => 0);
  const histogram = {};
  try {
    signal?.throwIfAborted();
    const results = await Promise.allSettled(segments.map(async ({ start, frames }, i) => {
      let segmentPage = i === 0 ? page : null;
      try {
        segmentPage ??= await openPage(controller.signal);
        const at = Math.round((offsetSec + start / fps) * 1e6) / 1e6;
        const result = await encode(segmentPage, { ...contract, durationSec: frames / fps }, parts[i], {
          signal: controller.signal, offsetSec: at, continuous: start > 0, videoFilter: videoFilterAt(at),
          onProgress: (_fraction, detail) => {
            done[i] = detail?.frame ?? 0;
            const frame = done.reduce((sum, value) => sum + value, 0);
            onProgress?.(frame / numFrames, { frame, frames: numFrames });
          },
        });
        for (const [count, total] of Object.entries(result?.sampleHistogram ?? {})) histogram[count] = (histogram[count] ?? 0) + total;
      } catch (error) {
        controller.abort(error);
        throw error;
      } finally {
        if (i > 0 && segmentPage) await segmentPage.close().catch(() => {});
      }
    }));
    signal?.throwIfAborted();
    // Report the segment that failed first, not the ones it stopped.
    const failed = results.find(result => result.status === 'rejected' && result.reason === controller.signal.reason)
      ?? results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    await writeFile(listPath, parts.map(part => `file '${part.replaceAll("'", "'\\''")}'`).join('\n'));
    const joined = await runFfmpeg({ bin: ffmpeg, signal, args: ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-c', 'copy', '-movflags', '+faststart', '-y', outputPath] });
    if (!joined.ok) throw new Error(`Joining render segments failed: ${joined.reason}`);
    return Object.keys(histogram).length ? { sampleHistogram: histogram } : {};
  } finally {
    signal?.removeEventListener('abort', relay);
    for (const path of [...parts, listPath]) await rm(path, { force: true }).catch(() => {});
  }
}

// A proof holds at most this many frames so one contact sheet stays readable.
const PROOF_MAX_FRAMES = 60;
const PROOF_COLUMNS = 6;

/** Sample times for a contact sheet: every `everySec`, widened to fit the frame cap. */
export function proofTimes(durationSec, everySec) {
  const step = Math.max(everySec, durationSec / PROOF_MAX_FRAMES);
  const times = [];
  for (let n = 0; n * step < durationSec - 1e-9 && times.length < PROOF_MAX_FRAMES; n++) {
    times.push(Math.round(n * step * 1000) / 1000);
  }
  return times;
}

// Seek each sample time and tile the frames into one PNG, six across; resolves
// with the column count used. Tiles are
// phone-sized (360px wide, 240px for vertical) so the sheet doubles as the
// readability check a reviewer runs before committing to a full render.
export async function encodeContactSheet(page, contract, outputPath, { times, signal } = {}) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found on PATH');
  signal?.throwIfAborted();
  const { width, height } = contract;
  const tileWidth = width < height ? 240 : 360;
  const columns = Math.min(PROOF_COLUMNS, times.length);
  const rows = Math.ceil(times.length / columns);
  await frameFormat(page, contract);
  const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'png', '-i', 'pipe:0',
    '-vf', `scale=${tileWidth}:-2,tile=${columns}x${rows}:padding=4:color=black`,
    '-frames:v', '1', '-y', outputPath], safeChildProcessOptions({ stdio: ['pipe', 'ignore', 'pipe'] }));
  let stderr = '';
  let exited = false;
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const finished = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.stdin.on('error', reject);
    proc.once('close', code => { exited = true; code === 0 ? resolve() : reject(new Error(`ffmpeg contact sheet failed (${code}): ${stderr}`)); });
  });
  finished.catch(() => {});
  try {
    for (const t of times) {
      page.check();
      await seekComposition(page, t);
      page.check();
      // Chrome downscales to tile size, so full-resolution PNGs never cross CDP.
      const { data } = await page.send('Page.captureScreenshot', { ...SCREENSHOT,
        clip: { x: 0, y: 0, width, height, scale: tileWidth / width } });
      signal?.throwIfAborted();
      await Promise.race([
        new Promise((resolve, reject) => proc.stdin.write(Buffer.from(data, 'base64'), error => error ? reject(error) : resolve())),
        finished.then(() => { throw new Error('ffmpeg exited before the contact sheet was complete'); }),
      ]);
    }
    proc.stdin.end();
    await finished;
    return { columns };
  } finally {
    if (!exited) {
      killWithEscalation(proc, { label: 'HTML composition proof', stillRunning: () => !exited, delayMs: 1000 });
      await new Promise(resolve => proc.once('close', resolve));
    }
  }
}

/**
 * Sample a REFERENCE video file (not a browser composition) every `everySec`
 * into the same phone-sized, six-across contact sheet as `encodeContactSheet`
 * (#8961), so a launch-video agent that cannot play video can still study one
 * as a single image. Reuses `proofTimes`'s uniform-step/frame-cap math so a
 * long reference degrades to a wider step rather than an unreadably tall sheet.
 * Throws when ffmpeg is missing or the file has no readable duration; the
 * caller treats a style reference as a hard input, not a best-effort extra.
 */
export async function encodeReferenceContactSheet(videoPath, outputPath, { everySec = 0.5 } = {}) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found on PATH');
  const durationSec = await probeVideoDuration(videoPath);
  if (!durationSec) throw new Error('Could not read the style reference video duration');
  const times = proofTimes(durationSec, everySec);
  const columns = Math.min(PROOF_COLUMNS, times.length);
  const rows = Math.ceil(times.length / columns);
  const step = times.length > 1 ? times[1] - times[0] : durationSec;
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vf',
      `fps=1/${step},scale=360:-2,tile=${columns}x${rows}:padding=4:color=black`,
      '-frames:v', '1', '-y', outputPath],
  });
  if (!result.ok) throw new Error(`Style reference contact sheet failed: ${result.reason}`);
  return { columns, rows, times };
}

// Same phone-sized, six-across contact sheet as `encodeContactSheet`, but
// sampling a REAL rendered video file at explicit `times` (seconds, relative
// to the file's own start) rather than a browser composition or a uniform
// step (#8986 — the excerpt render's cut/cue contact sheet from
// `excerptBoundaryTimes` in services/musicVideo/render.js). Each time is
// converted to an exact frame INDEX and selected with `eq(n,…)` — the same
// technique `extractEvaluationFrames` (lib/ffmpeg.js) uses for multi-frame
// selection — rather than a `between(t,…)` time window: at 30/60fps a time
// window can match several consecutive frames, overfilling the tile before
// later boundary times are ever reached.
export async function encodeFileContactSheetAtTimes(videoPath, outputPath, times, { width, height, fps, columns: requestedColumns } = {}) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found on PATH');
  if (!Array.isArray(times) || times.length === 0) throw new Error('encodeFileContactSheetAtTimes: no sample times');
  if (!(fps > 0)) throw new Error('encodeFileContactSheetAtTimes: fps is required');
  const tileWidth = width && height && width < height ? 240 : 360;
  const columns = Math.min(requestedColumns || PROOF_COLUMNS, times.length);
  const rows = Math.ceil(times.length / columns);
  // Two very close boundary times can round to the same frame index — the
  // dedup means the tile gets one fewer real frame than requested (a padded
  // cell), never a duplicate or an out-of-order one.
  const indices = [...new Set(times.map((t) => Math.max(0, Math.round(t * fps))))];
  const selectExpr = indices.map((i) => `eq(n,${i})`).join('+');
  const result = await runFfmpegProcess({
    bin: ffmpeg,
    args: ['-hide_banner', '-loglevel', 'error', '-i', videoPath, '-vf',
      `select='${selectExpr}',scale=${tileWidth}:-2,tile=${columns}x${rows}:padding=4:color=black`,
      '-vsync', 'vfr', '-frames:v', '1', '-y', outputPath],
  });
  if (!result.ok) throw new Error(`Excerpt contact sheet failed: ${result.reason}`);
  return { columns, rows };
}

// Source remains subject to the composition sandbox and launch privacy gate;
// only bounded PCM leaves the browser, never arbitrary paths or encoded files.
export async function synthesizeCompositionMusic(page, durationSec) {
  const sampleRate = 24000;
  const length = Math.round(sampleRate * durationSec);
  // browser.js evaluate -> send supplies a 30-second command deadline and
  // rejects all pending commands on the render signal abort; index.js closes
  // the disposable context in finally, including a never-settling score.
  const samples = await page.evaluate(`(async () => {
    const renderAudio = globalThis.portosComposition.renderAudio;
    if (typeof renderAudio !== 'function') throw new Error('portosComposition.renderAudio is required for synthesized music');
    const samples = await renderAudio({ sampleRate: ${sampleRate}, durationSec: ${durationSec} });
    if (!Array.isArray(samples) || samples.length !== ${length}) throw new Error('renderAudio must return exactly ${length} mono PCM samples');
    if (samples.some(value => !Number.isFinite(value) || value < -1 || value > 1)) throw new Error('renderAudio must return finite mono PCM samples in [-1, 1]');
    return samples;
  })()`);
  if (!Array.isArray(samples) || samples.length !== length || samples.some(value => !Number.isFinite(value) || value < -1 || value > 1)) {
    throw new Error('renderAudio must return finite mono PCM samples in [-1, 1]');
  }
  if (!samples.some(value => Math.abs(value) > 0.0001)) throw new Error('renderAudio returned a silent soundtrack');
  return pcmToWavBuffer(Float32Array.from(samples), { sampleRate });
}
