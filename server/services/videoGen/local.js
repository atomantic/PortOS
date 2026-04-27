/**
 * Video Gen — Local provider (mlx_video on macOS, diffusers on Windows).
 *
 * Spawns a Python child to render an LTX video. Output lives in `data/videos/`
 * with thumbnails in `data/video-thumbnails/`. History is appended to
 * `data/video-history.json` so the Media History page can grid-view them.
 *
 * Image-to-video accepts either an in-PortOS image filename (from data/images)
 * or an upload — both get resized via ffmpeg to match target resolution before
 * the model sees them.
 */

import { execFile, spawn } from 'child_process';
import { existsSync } from 'fs';
import { unlink, writeFile } from 'fs/promises';
import { join, basename, resolve as resolvePath, sep as PATH_SEP } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { ensureDir, PATHS, readJSONFile, atomicWrite } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { videoGenEvents } from './events.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, PYTHON_NOISE_RE } from '../../lib/sseUtils.js';

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === 'win32';

// Platform-specific catalog. macOS = MLX/mlx_video, Windows = diffusers.
const MODELS_MACOS = {
  ltx2_unified:       { name: 'LTX-2 Unified (~42 GB)',           repo: 'notapalindrome/ltx2-mlx-av',     steps: 30, guidance: 3.0 },
  ltx23_unified:      { name: 'LTX-2.3 Unified Beta (~48 GB)',    repo: 'notapalindrome/ltx23-mlx-av',    steps: 25, guidance: 3.0 },
  ltx23_distilled_q4: { name: 'LTX-2.3 Distilled Q4 (~22 GB)',    repo: 'notapalindrome/ltx23-mlx-av-q4', steps: 25, guidance: 3.0 },
};
const MODELS_WINDOWS = {
  ltx_video: { name: 'LTX-Video 0.9.5 — T2V + I2V (~9.5 GB, auto-downloads)', steps: 25, guidance: 3.0 },
};
export const VIDEO_MODELS = IS_WIN ? MODELS_WINDOWS : MODELS_MACOS;

export const listVideoModels = () =>
  Object.entries(VIDEO_MODELS).map(([id, m]) => ({ id, ...m }));

export const defaultVideoModelId = () => IS_WIN ? 'ltx_video' : 'ltx2_unified';

const HISTORY_FILE = join(PATHS.data, 'video-history.json');

// Validate that a sidecar/history-supplied filename is a safe basename under
// the expected directory — guards against tampered history entries with
// path-traversal segments (`../etc/passwd`) leaking into ffmpeg or unlink.
const safeUnder = (root, name) => {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const rootResolved = resolvePath(root) + PATH_SEP;
  const fullPath = resolvePath(join(root, name));
  return fullPath.startsWith(rootResolved) ? fullPath : null;
};

const jobs = new Map();
let activeProcess = null;

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

export const cancel = () => {
  if (!activeProcess) return false;
  const proc = activeProcess;
  proc.kill('SIGTERM');
  // KEEP activeProcess set until proc.on('close') clears it. Without this,
  // the BUSY guard immediately allows a new generation while the SIGTERM'd
  // child is still running (mlx_video can ignore SIGTERM mid-tensor-op),
  // and we'd lose the handle for a follow-up SIGKILL. Escalate after 8s.
  setTimeout(() => {
    // proc.killed is set the moment proc.kill() is called; it does NOT mean
    // the child has exited. Check exitCode (null until 'close' fires) so the
    // SIGKILL escalation actually triggers when mlx_video ignores SIGTERM.
    if (activeProcess === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log(`⚠️ video child didn't exit on SIGTERM — escalating to SIGKILL`);
      proc.kill('SIGKILL');
    }
  }, 8000);
  return true;
};

// ffmpeg discovery is async (which/where takes ~10ms+) and the result is
// stable for the process lifetime — cache the first hit so subsequent video
// generations don't re-shell-out and don't block the event loop.
let cachedFfmpegPath;
const findFfmpeg = async () => {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;
  const candidates = IS_WIN
    ? ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']
    : ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'];
  for (const p of candidates) {
    if (existsSync(p)) { cachedFfmpegPath = p; return p; }
  }
  const cmd = IS_WIN ? 'where' : 'which';
  const { stdout } = await execFileAsync(cmd, ['ffmpeg'], { timeout: 5000 }).catch(() => ({ stdout: '' }));
  cachedFfmpegPath = stdout.trim().split(/\r?\n/)[0] || null;
  return cachedFfmpegPath;
};

const generateThumbnail = async (videoPath, jobId) => {
  await ensureDir(PATHS.videoThumbnails);
  const thumbFilename = `${jobId}.jpg`;
  const thumbPath = join(PATHS.videoThumbnails, thumbFilename);
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) return null;
  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, ['-i', videoPath, '-vframes', '1', '-q:v', '5', '-y', thumbPath], { stdio: 'ignore' });
    proc.on('close', (code) => resolve(code === 0 ? thumbFilename : null));
    // Without this, a stale ffmpeg path or permission error emits 'error'
    // (never 'close') and the Promise never settles — the entire video gen
    // close handler that awaits this would hang forever.
    proc.on('error', (err) => {
      console.log(`⚠️ ffmpeg thumbnail failed to spawn: ${err.message}`);
      resolve(null);
    });
  });
};

export const loadHistory = () => readJSONFile(HISTORY_FILE, []);
export const saveHistory = (h) => atomicWrite(HISTORY_FILE, h);

const buildArgs = ({ pythonPath, modelId, model, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, tiling, disableAudio, sourceImagePath, outputPath }) => {
  if (IS_WIN) {
    const scriptPath = join(PATHS.root, 'scripts', 'generate_win.py');
    const args = [scriptPath, '--model', modelId, '--prompt', prompt, '--height', String(height), '--width', String(width), '--num-frames', String(numFrames), '--fps', String(fps), '--steps', String(steps), '--guidance', String(guidance), '--seed', String(seed), '--output', outputPath];
    if (negativePrompt) args.push('--negative-prompt', negativePrompt);
    if (sourceImagePath) args.push('--image', sourceImagePath);
    return { bin: pythonPath, args };
  }
  const args = [
    '-m', 'mlx_video.generate_av',
    '--prompt', prompt,
    '--height', String(height),
    '--width', String(width),
    '--num-frames', String(numFrames),
    '--seed', String(seed),
    '--fps', String(fps),
    '--steps', String(steps),
    '--cfg-scale', String(guidance),
    '--output-path', outputPath,
    '--model-repo', model.repo,
    '--text-encoder-repo', 'mlx-community/gemma-3-12b-it-4bit',
    '--tiling', tiling,
  ];
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (disableAudio) args.push('--no-audio');
  if (sourceImagePath) args.push('--image', sourceImagePath);
  return { bin: pythonPath, args };
};

export async function generateVideo({ pythonPath, prompt, negativePrompt = '', modelId = defaultVideoModelId(), width = 768, height = 512, numFrames = 121, fps = 24, steps, guidanceScale, seed, tiling = 'auto', disableAudio = false, sourceImagePath = null, uploadedTempPath = null }) {
  if (!pythonPath) throw new ServerError('Python path not configured — set it in Settings > Image Gen', { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' });
  if (!prompt?.trim()) throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  // Enforce the single-activeProcess invariant — without this a double-submit
  // would orphan the first child (cancel() only kills the one in activeProcess).
  if (activeProcess) throw new ServerError('A video generation is already in progress — cancel it before starting another', { status: 409, code: 'VIDEO_GEN_BUSY' });

  const model = VIDEO_MODELS[modelId];
  if (!model) throw new ServerError(`Unknown video model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });

  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.videoThumbnails);

  const jobId = randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const w = Math.floor(Number(width) / 64) * 64;
  const h = Math.floor(Number(height) / 64) * 64;
  const actualSeed = seed != null && seed !== '' ? Number(seed) : Math.floor(Math.random() * 2147483647);
  const actualSteps = steps ? Number(steps) : model.steps;
  const actualGuidance = guidanceScale != null && guidanceScale !== '' ? Number(guidanceScale) : model.guidance;
  const parsedNumFrames = Number(numFrames);
  const parsedFps = Number(fps);

  // Resize source image to match the model resolution. mlx_video requires
  // exact dimensions (it doesn't auto-pad), and pixie-forge learned the
  // hard way that letting the model upscale a portrait reference makes
  // garbled output.
  let resolvedSourceImage = sourceImagePath;
  let resizedTempPath = null;
  if (resolvedSourceImage) {
    const ffmpeg = await findFfmpeg();
    if (ffmpeg) {
      const resizedPath = join(tmpdir(), `resized-${jobId}.png`);
      const resizeResult = await execFileAsync(ffmpeg, [
        '-i', resolvedSourceImage,
        '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
        '-update', '1', '-frames:v', '1',
        '-y', resizedPath,
      ], { timeout: 10000 }).catch((err) => ({ error: err }));
      if (resizeResult.error) {
        console.log(`⚠️ Failed to resize source image, using original: ${resizeResult.error.message}`);
      } else {
        resolvedSourceImage = resizedPath;
        resizedTempPath = resizedPath;
      }
    }
  }

  const meta = { id: jobId, prompt, negativePrompt, modelId, seed: actualSeed, width: w, height: h, numFrames: parsedNumFrames, fps: parsedFps, filename, createdAt: new Date().toISOString() };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  const { bin, args } = buildArgs({ pythonPath, modelId, model, prompt, negativePrompt, width: w, height: h, numFrames: parsedNumFrames, fps: parsedFps, steps: actualSteps, guidance: actualGuidance, seed: actualSeed, tiling, disableAudio, sourceImagePath: resolvedSourceImage, outputPath });

  console.log(`🎬 Generating video [${jobId.slice(0, 8)}]: ${modelId} ${w}x${h} frames=${parsedNumFrames} steps=${actualSteps}`);
  videoGenEvents.emit('started', { generationId: jobId, totalSteps: actualSteps, ...meta });

  // Clear PYTHONPATH so the child uses the venv's own site-packages instead
  // of the parent shell's PYTHONPATH. Setting to `undefined` in a spread does
  // NOT unset the var — Node coerces it to the literal string "undefined" —
  // so build the env explicitly and `delete`.
  const childEnv = { ...process.env };
  delete childEnv.PYTHONPATH;
  const proc = spawn(bin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcess = proc;
  // Without an 'error' handler, a missing/non-executable pythonPath would
  // crash the server with an unhandled error event.
  proc.on('error', (err) => {
    job.status = 'error';
    const reason = `Failed to spawn ${bin}: ${err.message}`;
    console.log(`❌ Video generation spawn error [${jobId.slice(0, 8)}]: ${reason}`);
    broadcastSse(job, { type: 'error', error: reason });
    videoGenEvents.emit('failed', { generationId: jobId, error: reason });
    activeProcess = null;
    if (resizedTempPath) unlink(resizedTempPath).catch(() => {});
    closeJobAfterDelay(jobs, jobId);
  });

  let outputBuf = '';

  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line || PYTHON_NOISE_RE.test(line)) return;
    if (line.startsWith('STATUS:')) {
      broadcastSse(job, { type: 'status', message: line.slice(7) });
    } else if (line.startsWith('STAGE:')) {
      const parts = line.split(':');
      const step = parseInt(parts[3], 10) || 0;
      const total = parseInt(parts[4], 10) || 1;
      broadcastSse(job, { type: 'progress', progress: step / total, message: parts.slice(5).join(':') });
      videoGenEvents.emit('progress', { generationId: jobId, progress: step / total, step, totalSteps: total });
    } else if (line.startsWith('DOWNLOAD:')) {
      broadcastSse(job, { type: 'status', message: `Downloading model... ${line.slice(9)}` });
    } else {
      const m = line.match(/(\d+)%\|/);
      if (m) {
        const pct = parseInt(m[1], 10) / 100;
        broadcastSse(job, { type: 'progress', progress: pct, message: line });
        videoGenEvents.emit('progress', { generationId: jobId, progress: pct });
      }
    }
  };

  proc.stdout.on('data', (chunk) => {
    outputBuf += chunk.toString();
    const lines = outputBuf.split('\n');
    outputBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      // mlx_video emits a single JSON line on stdout when finished —
      // capture it for the metadata sidecar.
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.video_path) job.resultJson = parsed;
      } catch { /* not JSON */ }
    }
  });

  proc.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split(/[\n\r]+/)) handleLine(line);
  });

  proc.on('close', async (code, signal) => {
    activeProcess = null;
    // Cleanup the resized temp image if we made one. Track via a flag rather
    // than a path-prefix check — tmpdir() can return a symlinked path
    // (macOS /var → /private/var) so startsWith() can silently miss.
    if (resizedTempPath) await unlink(resizedTempPath).catch(() => {});
    // Cleanup the original multipart upload temp file too — without this,
    // every i2v request leaves a file in os.tmpdir() forever.
    if (uploadedTempPath) await unlink(uploadedTempPath).catch(() => {});

    if (code !== 0) {
      job.status = 'error';
      const reason = signal === 'SIGKILL'
        ? 'Process killed (likely out of memory — try a smaller model or resolution)'
        : signal ? `Killed by signal ${signal}` : `Exit code ${code}`;
      console.log(`❌ Video generation failed [${jobId.slice(0, 8)}]: ${reason}`);
      broadcastSse(job, { type: 'error', error: `Generation failed: ${reason}` });
      videoGenEvents.emit('failed', { generationId: jobId, error: reason });
    } else {
      job.status = 'complete';
      const thumbnail = await generateThumbnail(outputPath, jobId);
      const history = await loadHistory();
      history.unshift({ ...meta, thumbnail });
      await saveHistory(history);
      console.log(`✅ Video generated [${jobId.slice(0, 8)}]: ${filename}`);
      broadcastSse(job, { type: 'complete', result: { filename, seed: actualSeed, thumbnail, path: `/data/videos/${filename}` } });
      videoGenEvents.emit('completed', { generationId: jobId, filename, path: `/data/videos/${filename}`, thumbnail });
    }
    closeJobAfterDelay(jobs, jobId);
  });

  return { jobId, generationId: jobId, filename, mode: 'local', model: modelId };
}

// Extract the last frame of a video as a PNG into data/images/ — used to
// chain a clip into Imagine for "continue from last frame" remixing.
export async function extractLastFrame(historyId) {
  const history = await loadHistory();
  const item = history.find((h) => h.id === historyId);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  // Validate against tampered history entries — without this, a `../...`
  // filename could make ffmpeg read arbitrary files outside data/videos.
  const videoPath = safeUnder(PATHS.videos, item.filename);
  if (!videoPath) throw new ServerError('Invalid video filename', { status: 400, code: 'VALIDATION_ERROR' });
  if (!existsSync(videoPath)) throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });

  await ensureDir(PATHS.images);
  const frameFilename = `lastframe-${item.id}.png`;
  const framePath = join(PATHS.images, frameFilename);

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, ['-sseof', '-0.1', '-i', videoPath, '-vframes', '1', '-q:v', '2', '-y', framePath], { stdio: 'ignore' });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new ServerError('Failed to extract last frame', { status: 500, code: 'FFMPEG_FAILED' }));
      console.log(`🎞️ Extracted last frame: ${frameFilename}`);
      resolve({ filename: frameFilename, path: `/data/images/${frameFilename}` });
    });
    proc.on('error', (err) => {
      reject(new ServerError(`ffmpeg failed to spawn: ${err.message}`, { status: 500, code: 'FFMPEG_FAILED' }));
    });
  });
}

// Concat selected videos (preserving order) into a single MP4. Uses ffmpeg's
// concat demuxer which is stream-copy, so it's fast and lossless — but the
// inputs must share codec/resolution. The Media History page already only
// lets users stitch from a single model so this holds in practice.
export async function stitchVideos(videoIds) {
  if (!Array.isArray(videoIds) || videoIds.length < 2) {
    throw new ServerError('Need at least 2 videos to stitch', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });

  const history = await loadHistory();
  const videos = videoIds.map((id) => history.find((h) => h.id === id)).filter(Boolean);
  if (videos.length < 2) throw new ServerError('Some videos not found', { status: 400, code: 'VALIDATION_ERROR' });

  // Validate every history-supplied filename through safeUnder before
  // letting it reach ffmpeg's concat manifest. Tampered history entries
  // could otherwise smuggle `..` segments into ffmpeg input.
  const videoPaths = videos.map((v) => safeUnder(PATHS.videos, v.filename));
  if (videoPaths.some((p) => !p)) {
    throw new ServerError('One or more video filenames failed validation', { status: 400, code: 'VALIDATION_ERROR' });
  }
  for (const p of videoPaths) {
    if (!existsSync(p)) throw new ServerError(`Missing: ${basename(p)}`, { status: 404, code: 'NOT_FOUND' });
  }

  const jobId = randomUUID();
  const listFile = join(tmpdir(), `concat-${jobId}.txt`);
  // ffmpeg concat-demuxer escape: per its docs, single quotes in filenames
  // must be replaced with `'\''`. Inside quoted strings ffmpeg also treats
  // backslash as an escape character — on Windows where paths are
  // `C:\foo\bar.mp4`, that corrupts the path. Normalize to forward slashes
  // (which ffmpeg accepts on Windows just fine) before quoting.
  const escapeForConcat = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  await writeFile(listFile, videoPaths.map((p) => `file '${escapeForConcat(p)}'`).join('\n'));

  const outFilename = `stitched-${jobId}.mp4`;
  const outPath = join(PATHS.videos, outFilename);

  // Use a try/finally so the concat list temp file is cleaned up even when
  // ffmpeg rejects — otherwise it leaks one file per failed stitch.
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', outPath], { stdio: 'ignore' });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new ServerError('Stitch failed', { status: 500, code: 'FFMPEG_FAILED' })));
      proc.on('error', (err) => reject(new ServerError(`ffmpeg failed to spawn: ${err.message}`, { status: 500, code: 'FFMPEG_FAILED' })));
    });
  } finally {
    await unlink(listFile).catch(() => {});
  }

  const thumb = await generateThumbnail(outPath, jobId);
  const stitchedMeta = {
    id: jobId,
    prompt: `Stitched: ${videos.map((v) => v.prompt).join(' + ')}`,
    modelId: videos[0].modelId,
    seed: 0,
    width: videos[0].width,
    height: videos[0].height,
    numFrames: videos.reduce((sum, v) => sum + (v.numFrames || 0), 0),
    fps: videos[0].fps,
    filename: outFilename,
    thumbnail: thumb,
    createdAt: new Date().toISOString(),
    stitchedFrom: videoIds,
  };
  const h = await loadHistory();
  h.unshift(stitchedMeta);
  await saveHistory(h);
  console.log(`🎬 Stitched ${videos.length} videos: ${outFilename}`);
  return stitchedMeta;
}

export async function deleteHistoryItem(id) {
  const history = await loadHistory();
  const item = history.find((h) => h.id === id);
  if (!item) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  // Same path-traversal guard as extractLastFrame — unlink only if the
  // filename resolves to inside the expected dir.
  const videoFile = safeUnder(PATHS.videos, item.filename);
  if (videoFile) await unlink(videoFile).catch(() => {});
  if (item.thumbnail) {
    const thumbFile = safeUnder(PATHS.videoThumbnails, item.thumbnail);
    if (thumbFile) await unlink(thumbFile).catch(() => {});
  }
  await saveHistory(history.filter((h) => h.id !== id));
  return { ok: true };
}
