import { pcmToWavBuffer } from '../../lib/chiptuneRender.js';
import { spawn } from '../../lib/childProcess.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { findFfmpeg, H264_ENCODE_ARGS, AAC_ENCODE_ARGS, BT709_CONTAINER_ARGS, bt709TagFilter } from '../../lib/ffmpeg.js';

// Stream one frame at a time. The write callback supplies back-pressure and
// the terminal race releases a pending write on exit, disconnect or cancel.
export async function encodeComposition(page, contract, outputPath, { musicPath, signal, onProgress } = {}) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found on PATH');
  const tag = await bt709TagFilter();
  signal?.throwIfAborted();
  const { fps, durationSec, width, height } = contract;
  const numFrames = Math.round(durationSec * fps);
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const args = ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'png', '-i', 'pipe:0'];
  if (musicPath) args.push('-stream_loop', '-1', '-i', musicPath);
  args.push('-map', '0:v', '-vf', ['scale=in_range=pc:out_range=tv:out_color_matrix=bt709', tag].filter(Boolean).join(','), ...H264_ENCODE_ARGS, ...BT709_CONTAINER_ARGS);
  if (musicPath) args.push('-map', '1:a', '-af', `atrim=duration=${durationSec},asetpts=PTS-STARTPTS,afade=t=out:st=${durationSec - 0.5}:d=0.5`, ...AAC_ENCODE_ARGS);
  args.push('-frames:v', String(numFrames), '-t', String(durationSec), '-movflags', '+faststart', '-y', outputPath);
  const proc = spawn(ffmpeg, args, safeChildProcessOptions({ stdio: ['pipe', 'ignore', 'pipe'] }));
  let stderr = '';
  let exited = false;
  let stopping = false;
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const finished = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.stdin.on('error', reject);
    proc.once('close', code => { exited = true; code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr}`)); });
  });
  // Attach a rejection handler before the first browser round trip.
  finished.catch(() => {});
  const stop = () => {
    if (!exited && !stopping) {
      stopping = true;
      killWithEscalation(proc, { label: 'HTML composition encode', stillRunning: () => !exited, delayMs: 1000 });
    }
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for (let n = 0; n < numFrames; n++) {
      page.check();
      // awaitPromise in evaluate is essential: each seek owns its paint.
      await page.evaluate(`globalThis.portosComposition.seek(${n / fps})`);
      page.check();
      const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      page.check();
      await Promise.race([
        new Promise((resolve, reject) => proc.stdin.write(Buffer.from(data, 'base64'), error => error ? reject(error) : resolve())),
        finished.then(() => { throw new Error('ffmpeg exited before capture completed'); }),
      ]);
      onProgress?.((n + 1) / numFrames);
    }
    proc.stdin.end();
    await finished;
    page.check();
  } finally {
    signal?.removeEventListener('abort', stop);
    stop();
    // Wait for close, not just the first error, before deleting partial output.
    if (!exited) await new Promise(resolve => proc.once('close', resolve));
  }
}

// A proof holds at most this many frames so one contact sheet stays readable.
export const PROOF_MAX_FRAMES = 60;
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

// Seek each sample time and tile the frames into one PNG, six across. Tiles are
// phone-sized (360px wide, 240px for vertical) so the sheet doubles as the
// readability check a reviewer runs before committing to a full render.
export async function encodeContactSheet(page, contract, outputPath, { times, signal } = {}) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found on PATH');
  signal?.throwIfAborted();
  const { width, height } = contract;
  const tileWidth = width < height ? 240 : 360;
  const rows = Math.ceil(times.length / PROOF_COLUMNS);
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const frames = [];
  for (const t of times) {
    page.check();
    await page.evaluate(`globalThis.portosComposition.seek(${t})`);
    page.check();
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    frames.push(Buffer.from(data, 'base64'));
    signal?.throwIfAborted();
  }
  const proc = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-vcodec', 'png', '-i', 'pipe:0',
    '-vf', `scale=${tileWidth}:-2,tile=${Math.min(PROOF_COLUMNS, times.length)}x${rows}:padding=4:color=black`,
    '-frames:v', '1', '-y', outputPath], safeChildProcessOptions({ stdio: ['pipe', 'ignore', 'pipe'] }));
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  const finished = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.once('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg contact sheet failed (${code}): ${stderr}`)));
  });
  // A closed pipe surfaces as the close code above.
  proc.stdin.on('error', () => {});
  proc.stdin.end(Buffer.concat(frames));
  await finished;
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
