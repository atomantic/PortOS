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
