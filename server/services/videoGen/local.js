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
import { existsSync, statSync } from 'fs';
import { unlink, writeFile, copyFile } from 'fs/promises';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { ensureDir, PATHS, readJSONFile, atomicWrite, UUID_RE } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { videoGenEvents } from './events.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, PYTHON_NOISE_RE } from '../../lib/sseUtils.js';
import { getVideoModels, getDefaultVideoModelId, getTextEncoderRepo } from '../../lib/mediaModels.js';
import { findFfmpeg, safeUnder, generateThumbnail, optimizeForStreaming, upscaleVideo2x } from '../../lib/ffmpeg.js';

const execFileAsync = promisify(execFile);

const IS_WIN = process.platform === 'win32';

// Catalog comes from data/media-models.json (see server/lib/mediaModels.js).
// Cached as a plain object at boot for O(1) lookup by id, matching the prior shape.
export const VIDEO_MODELS = Object.fromEntries(getVideoModels().map((m) => [m.id, m]));

export const listVideoModels = () => getVideoModels();

export const defaultVideoModelId = () => getDefaultVideoModelId();

const HISTORY_FILE = join(PATHS.data, 'video-history.json');

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

export const loadHistory = () => readJSONFile(HISTORY_FILE, []);
export const saveHistory = (h) => atomicWrite(HISTORY_FILE, h);

const buildArgs = ({ pythonPath, modelId, model, prompt, negativePrompt, width, height, numFrames, fps, steps, guidance, seed, tiling, disableAudio, sourceImagePath, lastImagePath, mode, imageStrength, textEncoderRepo, outputPath }) => {
  if (IS_WIN) {
    const scriptPath = join(PATHS.root, 'scripts', 'generate_win.py');
    const args = [scriptPath, '--model', modelId, '--prompt', prompt, '--height', String(height), '--width', String(width), '--num-frames', String(numFrames), '--fps', String(fps), '--steps', String(steps), '--guidance', String(guidance), '--seed', String(seed), '--output', outputPath];
    if (negativePrompt) args.push('--negative-prompt', negativePrompt);
    if (sourceImagePath) args.push('--image', sourceImagePath);
    if (lastImagePath) args.push('--last-image', lastImagePath);
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
    '--text-encoder-repo', textEncoderRepo,
    '--tiling', tiling,
  ];
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (disableAudio) args.push('--no-audio');

  // Pick a single conditioning image and frame index. mlx_video.generate_av
  // accepts only one --image so true FFLF (both keyframes) isn't supported;
  // when only a last image was supplied for FFLF, we condition the LAST
  // latent frame instead. --image-frame-idx is a LATENT index — LTX
  // compression is `1 + (videoFrames - 1) / 8`, so passing a raw video
  // frame count silently fails the conditioning shape check.
  let condImage = sourceImagePath;
  let condFrameIdx = null;
  if (mode === 'fflf' && lastImagePath && !sourceImagePath) {
    condImage = lastImagePath;
    condFrameIdx = Math.max(0, Math.floor((Number(numFrames) - 1) / 8));
  } else if (mode === 'fflf' && lastImagePath && sourceImagePath) {
    console.log(`⚠️ FFLF requested but mlx_video CLI only supports single-frame conditioning — last image ignored`);
  }
  if (condImage) {
    args.push('--image', condImage);
    if (condFrameIdx != null) args.push('--image-frame-idx', String(condFrameIdx));
    // --image-strength uses mask = 1.0 - strength: 1.0 preserves the source
    // latent, 0.0 fully denoises (= T2V). mlx_video's help text describes
    // this inverted. Omit when no caller value so mlx_video's default (1.0)
    // applies.
    if (imageStrength != null) args.push('--image-strength', String(imageStrength));
  }
  return { bin: pythonPath, args };
};

export async function generateVideo({ pythonPath, prompt, negativePrompt = '', modelId = defaultVideoModelId(), width = 768, height = 512, numFrames = 121, fps = 24, steps, guidanceScale, seed, tiling = 'auto', disableAudio = false, sourceImagePath = null, uploadedTempPath = null, lastImagePath = null, mode = null, imageStrength = null, jobId: providedJobId = null }) {
  if (!pythonPath) throw new ServerError('Python path not configured — set it in Settings > Image Gen', { status: 400, code: 'VIDEO_GEN_NOT_CONFIGURED' });
  if (!prompt?.trim()) throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  // Single-flight is now enforced by the mediaJobQueue worker upstream — only
  // one job is dequeued at a time, so we don't need a BUSY guard here. Direct
  // callers (legacy / tests) bypass the queue and would clobber activeProcess
  // on concurrent calls; that's an explicit "don't do that" contract.

  const model = VIDEO_MODELS[modelId];
  if (!model) throw new ServerError(`Unknown video model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });
  // macOS/mlx_video requires a HuggingFace repo id — Windows doesn't (the
  // diffusers wrapper hardcodes Lightricks/LTX-Video). A user-edited registry
  // entry missing `repo` would otherwise pass `undefined` into spawn args.
  if (!IS_WIN && (typeof model.repo !== 'string' || model.repo.length === 0)) {
    throw new ServerError(`Video model "${modelId}" is missing the required \`repo\` field in data/media-models.json`, { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' });
  }

  await ensureDir(PATHS.videos);
  await ensureDir(PATHS.videoThumbnails);

  // jobId may be supplied by the queue so SSE clients (which attached against
  // the queue's id) reach the same generation events.
  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.mp4`;
  const outputPath = join(PATHS.videos, filename);
  const w = Math.floor(Number(width) / 64) * 64;
  const h = Math.floor(Number(height) / 64) * 64;
  const actualSeed = seed != null && seed !== '' ? Number(seed) : Math.floor(Math.random() * 2147483647);
  const actualSteps = steps ? Number(steps) : model.steps;
  const actualGuidance = guidanceScale != null && guidanceScale !== '' ? Number(guidanceScale) : model.guidance;
  // Caller may pass null/'' to use mlx_video's default (1.0 = preserve source).
  const actualImageStrength = imageStrength != null && imageStrength !== '' ? Number(imageStrength) : null;
  const actualTextEncoderRepo = getTextEncoderRepo();
  const parsedNumFrames = Number(numFrames);
  const parsedFps = Number(fps);

  // Resize source image to match the model resolution. mlx_video requires
  // exact dimensions (it doesn't auto-pad), and pixie-forge learned the
  // hard way that letting the model upscale a portrait reference makes
  // garbled output.
  //
  // Skip the last-image resize when buildArgs / the Python child won't
  // actually consume it:
  //  - On macOS/mlx_video the FFLF fallback only triggers in `fflf` mode
  //    AND when no source image is also provided (single conditioning frame
  //    only). Anything else is a no-op, so resizing is wasted ffmpeg work.
  //  - On Windows we forward --last-image to generate_win.py so it can log
  //    status, but the diffusers pipeline only reads --image — the script
  //    never opens the last-frame file, so no resize is needed there either.
  const lastImageWillBeUsed = !!lastImagePath && !IS_WIN && mode === 'fflf' && !sourceImagePath;
  const ffmpeg = (sourceImagePath || lastImageWillBeUsed) ? await findFfmpeg() : null;
  const resizeImage = async (srcPath, tag) => {
    if (!srcPath || !ffmpeg) return { resolved: srcPath, tempPath: null };
    const resizedPath = join(tmpdir(), `resized-${tag}-${jobId}.png`);
    const resizeResult = await execFileAsync(ffmpeg, [
      '-i', srcPath,
      '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
      '-update', '1', '-frames:v', '1',
      '-y', resizedPath,
    ], { timeout: 10000 }).catch((err) => ({ error: err }));
    if (resizeResult.error) {
      console.log(`⚠️ Failed to resize ${tag} image, using original: ${resizeResult.error.message}`);
      return { resolved: srcPath, tempPath: null };
    }
    return { resolved: resizedPath, tempPath: resizedPath };
  };
  const { resolved: resolvedSourceImage, tempPath: resizedSrcTempPath } = await resizeImage(sourceImagePath, 'src');
  const { resolved: resolvedLastImage, tempPath: resizedLastTempPath } = lastImageWillBeUsed
    ? await resizeImage(lastImagePath, 'last')
    : { resolved: lastImagePath, tempPath: null };

  const meta = { id: jobId, prompt, negativePrompt, modelId, seed: actualSeed, width: w, height: h, numFrames: parsedNumFrames, fps: parsedFps, filename, createdAt: new Date().toISOString(), mode: mode || (sourceImagePath ? 'image' : 'text') };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  const { bin, args } = buildArgs({ pythonPath, modelId, model, prompt, negativePrompt, width: w, height: h, numFrames: parsedNumFrames, fps: parsedFps, steps: actualSteps, guidance: actualGuidance, seed: actualSeed, tiling, disableAudio, sourceImagePath: resolvedSourceImage, lastImagePath: resolvedLastImage, mode, imageStrength: actualImageStrength, textEncoderRepo: actualTextEncoderRepo, outputPath });

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
  // Hold a sleep-prevention lock for the lifetime of the python child, so a
  // 90s+ render doesn't get aborted by display/system sleep on a laptop. -w
  // makes caffeinate self-exit when our pid does, so no manual cleanup is
  // needed and a server crash mid-render still releases the assertion.
  // macOS-only — `caffeinate` is a darwin binary; gating on `!IS_WIN` would
  // also fire on Linux and emit a pointless ENOENT every render.
  if (process.platform === 'darwin' && proc.pid) {
    spawn('caffeinate', ['-i', '-w', String(proc.pid)], { stdio: 'ignore', detached: false }).on('error', () => {});
  }
  // Without an 'error' handler, a missing/non-executable pythonPath would
  // crash the server with an unhandled error event.
  proc.on('error', (err) => {
    job.status = 'error';
    const reason = `Failed to spawn ${bin}: ${err.message}`;
    console.log(`❌ Video generation spawn error [${jobId.slice(0, 8)}]: ${reason}`);
    broadcastSse(job, { type: 'error', error: reason });
    videoGenEvents.emit('failed', { generationId: jobId, error: reason });
    activeProcess = null;
    // Spawn failed, so proc.on('close') will never fire — clean up every
    // temp file we own here, including the multipart upload, otherwise
    // ENOENT/permission errors leak files in os.tmpdir().
    if (resizedSrcTempPath) unlink(resizedSrcTempPath).catch(() => {});
    if (resizedLastTempPath) unlink(resizedLastTempPath).catch(() => {});
    if (uploadedTempPath) unlink(uploadedTempPath).catch(() => {});
    closeJobAfterDelay(jobs, jobId);
  });

  let outputBuf = '';

  // Returns true when the line was a known progress/status message (already
  // broadcast over SSE) or python-noise — caller should suppress logging.
  // Returns false for unhandled lines that are worth raw-logging.
  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line) return true;
    if (PYTHON_NOISE_RE.test(line)) return true;
    if (line.startsWith('STATUS:')) {
      broadcastSse(job, { type: 'status', message: line.slice(7) });
      return true;
    }
    if (line.startsWith('STAGE:')) {
      const parts = line.split(':');
      const step = parseInt(parts[3], 10) || 0;
      const total = parseInt(parts[4], 10) || 1;
      broadcastSse(job, { type: 'progress', progress: step / total, message: parts.slice(5).join(':') });
      videoGenEvents.emit('progress', { generationId: jobId, progress: step / total, step, totalSteps: total });
      return true;
    }
    if (line.startsWith('DOWNLOAD:')) {
      broadcastSse(job, { type: 'status', message: `Downloading model... ${line.slice(9)}` });
      return true;
    }
    const m = line.match(/(\d+)%\|/);
    if (m) {
      const pct = parseInt(m[1], 10) / 100;
      broadcastSse(job, { type: 'progress', progress: pct, message: line });
      videoGenEvents.emit('progress', { generationId: jobId, progress: pct });
      return true;
    }
    return false;
  };

  proc.stdout.on('data', (chunk) => {
    outputBuf += chunk.toString();
    const lines = outputBuf.split('\n');
    outputBuf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      // mlx_video emits one JSON line on stdout when finished — capture it
      // for the result metadata; otherwise raw-log so we can debug failures.
      try {
        const parsed = JSON.parse(line);
        if (parsed.video_path) job.resultJson = parsed;
        continue;
      } catch { /* not JSON */ }
      console.log(`🐍-out [${jobId.slice(0, 8)}] ${line}`);
    }
  });

  proc.stderr.on('data', (chunk) => {
    for (const raw of chunk.toString().split(/[\n\r]+/)) {
      if (!handleLine(raw)) console.log(`🐍 [${jobId.slice(0, 8)}] ${raw.trim()}`);
    }
  });

  proc.on('close', async (code, signal) => {
    activeProcess = null;
    // Cleanup the resized temp images if we made them. Track via flags rather
    // than a path-prefix check — tmpdir() can return a symlinked path
    // (macOS /var → /private/var) so startsWith() can silently miss.
    if (resizedSrcTempPath) await unlink(resizedSrcTempPath).catch(() => {});
    if (resizedLastTempPath) await unlink(resizedLastTempPath).catch(() => {});
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
      await optimizeForStreaming(outputPath);
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
  // Same path-traversal concern as `item.filename` above — `item.id` could
  // contain path separators or `..` if history.json was tampered with.
  // generateVideo writes ids via randomUUID() (matches /^[a-f0-9-]{36}$/),
  // so reject anything else outright.
  if (!/^[a-f0-9-]{36}$/i.test(item.id)) {
    throw new ServerError('Invalid history id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const frameFilename = `lastframe-${item.id}.png`;
  const framePath = join(PATHS.images, frameFilename);
  // Cache hit: ffmpeg-extracted frames are deterministic for a given video,
  // so a file already on disk is reusable. UI clicks "Continue" repeatedly
  // (palette → continue, gallery → continue, etc.) and re-extracting on
  // every click was wasting 1–2s per click + spawning ffmpeg children.
  // Validate non-zero size — a prior ffmpeg crash could leave a 0-byte
  // placeholder, which would otherwise be served as a broken image forever.
  // Treat ANY stat failure (EACCES, EIO, etc.) as a cache miss rather than
  // letting it abort the request.
  const safeStatSize = (path) => {
    try {
      const s = statSync(path, { throwIfNoEntry: false });
      return s ? s.size : null;
    } catch {
      return null;
    }
  };
  const cachedSize = safeStatSize(framePath);
  if (cachedSize != null && cachedSize > 0) {
    return { filename: frameFilename, path: `/data/images/${frameFilename}` };
  }
  if (cachedSize === 0) await unlink(framePath).catch(() => {});

  return new Promise((resolve, reject) => {
    // -sseof -1.0 seeks 1s before end. The previous -0.1 was too tight on
    // videos with audio (B-frames + AV mux push the last keyframe earlier
    // than 100 ms from EOF), and ffmpeg silently returned 0 frames while
    // sometimes still exiting 0 — leaving a phantom-success log + missing
    // file. The output file gets a -update 1 flag so ffmpeg overwrites
    // any partial file from a prior failed run instead of erroring.
    const proc = spawn(ffmpeg, ['-sseof', '-1.0', '-i', videoPath, '-update', '1', '-vframes', '1', '-q:v', '2', '-y', framePath], { stdio: 'ignore' });
    proc.on('close', async (code) => {
      // safeStatSize swallows throws so the async handler can't leak an
      // unhandled rejection on transient stat errors — null is treated as
      // "extraction failed".
      const writtenSize = safeStatSize(framePath);
      if (code !== 0 || writtenSize == null || writtenSize === 0) {
        // A 0-byte file is a partial extraction, not a cache-worthy result —
        // delete it so the next call retries instead of returning a broken
        // image from the cache hit above.
        if (writtenSize === 0) await unlink(framePath).catch(() => {});
        return reject(new ServerError('Failed to extract last frame', { status: 500, code: 'FFMPEG_FAILED' }));
      }
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

// 2× Lanczos upscale of an existing history item. Writes the upscaled clip
// to a new file (never overwrites the original) and inserts a new history
// entry pointing at it, so the user gets both versions side-by-side in the
// gallery. Doubles width and height; aspect-ratio is preserved exactly.
//
// Returns the new history entry on success; throws ServerError on any
// missing-input / ffmpeg / file-system failure so the route can map it to
// a clean HTTP status.
export async function upscaleHistoryItem(historyId) {
  // Validate the input arg first — failing here surfaces a clean 400 even if
  // the history file happens to contain a record with a malformed id, and
  // it short-circuits the loadHistory I/O for obviously-bogus requests.
  // Use the shared strict UUID regex (the prior /^[a-f0-9-]{36}$/i pattern
  // accepted non-UUID 36-char strings like all-hyphens).
  if (typeof historyId !== 'string' || !UUID_RE.test(historyId)) {
    throw new ServerError('Invalid history id', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const history = await loadHistory();
  const item = history.find((h) => h.id === historyId);
  if (!item) throw new ServerError('Video not found', { status: 404, code: 'NOT_FOUND' });
  if (item.upscaledFrom) {
    throw new ServerError('Cannot upscale an already-upscaled video', { status: 400, code: 'ALREADY_UPSCALED' });
  }
  const sourcePath = safeUnder(PATHS.videos, item.filename);
  if (!sourcePath) throw new ServerError('Invalid video filename', { status: 400, code: 'VALIDATION_ERROR' });
  if (!existsSync(sourcePath)) throw new ServerError('Video file not found on disk', { status: 404, code: 'NOT_FOUND' });

  const newId = randomUUID();
  const newFilename = `${newId}.mp4`;
  const newPath = join(PATHS.videos, newFilename);
  // Copy first, then upscale-in-place — keeps the upscaler's atomic-rename
  // contract intact and means a mid-process kill leaves the source clip
  // untouched.
  await copyFile(sourcePath, newPath);
  console.log(`🔍 Upscaling video [${historyId.slice(0, 8)} → ${newId.slice(0, 8)}]: 2×`);
  const result = await upscaleVideo2x(newPath);
  if (!result.ok) {
    await unlink(newPath).catch(() => {});
    throw new ServerError(`Upscale failed: ${result.reason}`, { status: 500, code: 'FFMPEG_FAILED' });
  }
  const thumbnail = await generateThumbnail(newPath, newId);
  // Build the new history entry from the original, but bump dimensions and
  // tag with `upscaledFrom: <id>` + a reusable suffix on the prompt so the
  // gallery row reads as "<original prompt> (2×)".
  const newEntry = {
    ...item,
    id: newId,
    filename: newFilename,
    width: (Number(item.width) || 0) * 2,
    height: (Number(item.height) || 0) * 2,
    thumbnail,
    createdAt: new Date().toISOString(),
    upscaledFrom: item.id,
    prompt: item.prompt ? `${item.prompt} (2×)` : '(upscaled 2×)',
    // Drop hidden so the upscaled version surfaces in the visible gallery
    // even when the source clip was hidden.
    hidden: false,
  };
  const refreshedHistory = await loadHistory();
  refreshedHistory.unshift(newEntry);
  await saveHistory(refreshedHistory);
  console.log(`✅ Upscaled [${newId.slice(0, 8)}]: ${newFilename} (${newEntry.width}×${newEntry.height})`);
  return newEntry;
}

export async function setHistoryItemHidden(id, hidden) {
  const history = await loadHistory();
  const item = history.find((h) => h.id === id);
  if (!item) throw new ServerError('Not found', { status: 404, code: 'NOT_FOUND' });
  item.hidden = !!hidden;
  await saveHistory(history);
  return { ok: true, hidden: item.hidden };
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
  console.log(`🗑️ Deleted video: ${item.filename}`);
  return { ok: true };
}
