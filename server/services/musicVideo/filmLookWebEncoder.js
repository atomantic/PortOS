import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// This is specific to the finishing page, not a replacement for the shared
// composition encoder. The browser submits only the already-admitted GPU
// canvas; its Annex B stream is accepted only if every output timestamp is in
// submission order. Otherwise the caller restarts the whole pass with PNG.
export async function encodeFilmLookWeb(page, { width, height, fps, durationSec }, outputPath, {
  signal, offsetSec = 0, onProgress, captureReference = null, frameTimes = null,
} = {}) {
  const { BT709_CONTAINER_ARGS, findFfmpeg, probeVideoCodecSignature, probeVideoGeometry, runFfmpegProcess } = await import('../../lib/ffmpeg.js');
  const frames = Math.round(durationSec * fps);
  const rawPath = `${outputPath}.web.h264`;
  const timing = { frames: 0, seekMs: 0, drawMs: 0, captureMs: 0, encodeMs: 0, gpuFrames: 0, svgFrames: 0 };
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg unavailable');
  let file;
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('globalThis.__portosFilmLookFinish.startEncoder()');
    file = await open(rawPath, 'w');
    const write = async (data) => {
      signal?.throwIfAborted();
      const started = performance.now();
      await file.writeFile(Buffer.from(data, 'base64'));
      timing.encodeMs += performance.now() - started;
    };
    for (let n = 0; n < frames; n++) {
      signal?.throwIfAborted();
      page.check();
      let started = performance.now();
      const drawn = await page.evaluate(`globalThis.portosComposition.seek(${frameTimes?.[n] ?? offsetSec + n / fps})`);
      const elapsed = performance.now() - started;
      if (drawn?.path !== 'gpu') throw new Error('WebCodecs requires the admitted GPU path');
      const draw = Number.isFinite(drawn.drawMs) ? Math.max(0, Math.min(elapsed, drawn.drawMs)) : 0;
      timing.drawMs += draw;
      timing.seekMs += elapsed - draw;
      if (captureReference) await captureReference(page, n);
      started = performance.now();
      const data = await page.evaluate('globalThis.__portosFilmLookFinish.frameEncoder.frame()');
      timing.captureMs += performance.now() - started;
      await write(data);
      timing.frames++;
      timing.gpuFrames++;
      onProgress?.((n + 1) / frames, { frame: n + 1, frames });
    }
    const flushStarted = performance.now();
    const tail = await page.evaluate('globalThis.__portosFilmLookFinish.frameEncoder.finish()');
    timing.captureMs += performance.now() - flushStarted;
    await write(tail);
    await file.close(); file = null;
    signal?.throwIfAborted();
    // Every chunk was checked against its submitted timestamp, so packet order
    // is presentation order. Generate segment-local timestamps explicitly; raw
    // Annex B otherwise has no timestamps for the MP4 muxer to preserve.
    const setts = `setts=pts=N/(${fps}*TB):dts=N/(${fps}*TB):duration=1/(${fps}*TB)`;
    const muxStarted = performance.now();
    const mux = await runFfmpegProcess({ bin: ffmpeg, signal, args: ['-hide_banner', '-loglevel', 'error', '-r', String(fps), '-i', rawPath,
      '-map', '0:v:0', '-c:v', 'copy', '-bsf:v', `h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1,${setts}`,
      ...BT709_CONTAINER_ARGS, '-frames:v', String(frames), '-movflags', '+faststart', '-y', outputPath] });
    timing.encodeMs += performance.now() - muxStarted;
    if (!mux.ok) throw new Error(`WebCodecs mux failed: ${mux.reason}`);
    const [geometry, signature] = await Promise.all([probeVideoGeometry(outputPath), probeVideoCodecSignature(outputPath)]);
    const tags = String(signature || '').split('|');
    if (!geometry || geometry.width !== width || geometry.height !== height || geometry.numFrames !== frames
      || Math.abs(geometry.fps - fps) > 0.001 || Math.abs(geometry.durationSec - frames / fps) > 1 / fps
      || !['codec_name=h264', 'profile=High', 'pix_fmt=yuv420p', 'color_range=tv', 'color_space=bt709',
        'color_transfer=bt709', 'color_primaries=bt709', 'field_order=progressive'].every(tag => tags.includes(tag))) {
      throw new Error('WebCodecs mux produced an incompatible stream');
    }
    signal?.throwIfAborted();
    return { timing };
  } finally {
    await file?.close().catch(() => {});
    await rm(rawPath, { force: true }).catch(() => {});
  }
}

const SCREENSHOT = { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false };

// Compare a short sequence, not just its keyframe: quantization and inter-frame
// prediction can lose grain even when a single encoded frame looks identical.
export async function admitFilmLookWeb(page, contract, directory, { signal, offsetSec = 0 } = {}) {
  const { BT709_CONTAINER_ARGS, findFfmpeg, H264_ENCODE_ARGS, runFfmpegProcess } = await import('../../lib/ffmpeg.js');
  const totalFrames = Math.round(contract.durationSec * contract.fps);
  // A short render cannot amortize the check's screenshots and reference encode.
  if (totalFrames < 240) return false;
  const frames = 24;
  const dir = join(directory, 'web-check');
  const sample = { ...contract, durationSec: frames / contract.fps };
  const candidate = join(dir, 'candidate.mp4');
  const reference = join(dir, 'reference.mp4');
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return false;
  try {
    await mkdir(dir, { recursive: true });
    const frameTimes = Array.from({ length: frames }, (_, i) => offsetSec + Math.round(i * (totalFrames - 1) / (frames - 1)) / contract.fps);
    await encodeFilmLookWeb(page, sample, candidate, { signal, offsetSec, frameTimes, captureReference: async (target, n) => {
      const { data } = await target.send('Page.captureScreenshot', SCREENSHOT);
      await writeFile(join(dir, `frame-${String(n).padStart(3, '0')}.png`), Buffer.from(data, 'base64'));
    } });
    const input = join(dir, 'frame-%03d.png');
    const referenceRun = await runFfmpegProcess({ bin: ffmpeg, signal, args: ['-hide_banner', '-loglevel', 'error', '-framerate', String(contract.fps), '-i', input,
      '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      ...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS, '-y', reference] });
    if (!referenceRun.ok) return false;
    const stats = [];
    for (const video of [candidate, reference]) {
      let log = '';
      const run = await runFfmpegProcess({ bin: ffmpeg, signal, onStdout: chunk => { log = (log + chunk.toString()).slice(-65536); }, args: ['-hide_banner', '-loglevel', 'error', '-framerate', String(contract.fps), '-i', input, '-i', video,
        '-lavfi', `[0:v]scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p[a];[a][1:v]psnr=stats_file=-`, '-f', 'null', '-'] });
      if (!run.ok) return false;
      const lines = log.trim().split('\n');
      stats.push(lines.map(line => { const value = /psnr_avg:([\d.]+|inf)/.exec(line)?.[1]; return value === 'inf' ? Infinity : Number(value); }));
    }
    return stats.every(values => values.length === frames && values.every(value => !Number.isNaN(value)))
      && Array.from({ length: 10 }, (_, i) => Math.round(i * (frames - 1) / 9)).every(i => stats[0][i] >= stats[1][i] - 0.5);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
