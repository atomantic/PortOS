/**
 * Image Gen — Local provider (Apple Silicon mflux / Windows diffusers).
 *
 * Spawns a Python child process to generate Flux images. HF model weights
 * stream into the user's standard HF cache (`~/.cache/huggingface/`) — PortOS
 * doesn't override HF_HOME. Generated images land in `data/images/<jobId>.png`
 * with a sidecar metadata JSON so the gallery and Remix flow can recover
 * prompt/seed/steps.
 *
 * Progress comes back via the imageGenEvents bus (Socket.IO bridge) and over
 * a per-job SSE stream so EventSource consumers (the Imagine page) get the
 * raw status text mflux prints to stderr.
 */

import { spawn } from 'child_process';
import { writeFile, readFile, readdir, stat, unlink, rm, mkdtemp } from 'fs/promises';
import { existsSync, watch as fsWatch } from 'fs';
import { join, dirname, resolve as resolvePath, sep as PATH_SEP, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { assertSafeFilename, ensureDir, listDirectoryByExtension, PATHS, safeJSONParse, resolveGalleryImage, resolveImageInputPath, tryReadFile } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, PYTHON_NOISE_RE } from '../../lib/sseUtils.js';
import { resolveFlux2Python, FLUX2_VENV_DEFAULT } from '../../lib/pythonSetup.js';
import { hfTokenEnv } from '../../lib/hfToken.js';
import { IMAGE_GEN_MODE } from './modes.js';

const IS_WIN = process.platform === 'win32';

import { getImageModels, isFlux2, isZImage, isErnie, isHiDream, isQwen } from '../../lib/mediaModels.js';
import { usesDiffusersRunner } from '../../lib/runners.js';

// Read the registry lazily — callers below hit getImageModels() at request
// time. A prior `IMAGE_MODELS = Object.fromEntries(getImageModels()...)`
// snapshot lived here but fired loadMediaModels() at import time, breaking
// any test that mocks PATHS.data to a non-writable path.
export const listImageModels = () => getImageModels();

// Per-job clients: jobId -> { clients, status, meta, broadcast }
const jobs = new Map();
let activeProcess = null;
// Snapshot of the currently-running job for /api/image-gen/active so the UI
// can rehydrate prompt + settings + progress + last-rendered frame after
// navigating away. Cleared on completion / error / cancel.
let activeJob = null;

export const getActiveJob = () => activeJob;

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

export const cancel = () => {
  if (!activeProcess) return false;
  const proc = activeProcess;
  proc.kill('SIGTERM');
  // KEEP activeProcess + activeJob set until proc.on('close') clears them.
  // Otherwise BUSY immediately allows a new generation while the SIGTERM'd
  // mflux child is still running, and we lose the handle for a follow-up
  // SIGKILL. Escalate after 8s if the child ignored SIGTERM.
  setTimeout(() => {
    // proc.killed is set the moment proc.kill() is called; it does NOT mean
    // the child has exited. Check exitCode (null until 'close' fires) so the
    // SIGKILL escalation actually triggers when mflux ignores SIGTERM.
    if (activeProcess === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log(`⚠️ image child didn't exit on SIGTERM — escalating to SIGKILL`);
      proc.kill('SIGKILL');
    }
  }, 8000);
  return true;
};

export const buildArgs = ({ pythonPath, model, prompt, negativePrompt, width, height, steps, guidance, seed, quantize, outputPath, loraPaths = [], loraScales = [], stepwiseDir, initImagePath, initImageStrength, referenceImagePaths = [], referenceImageStrengths = [] }) => {
  const modelId = model?.id;
  if (usesDiffusersRunner(model)) {
    const runnerLabel = isErnie(model) ? 'ERNIE' : isHiDream(model) ? 'HiDream' : isQwen(model) ? 'Qwen' : 'Z-Image';
    const errCode = isErnie(model)
      ? 'IMAGE_GEN_ERNIE_MISCONFIGURED'
      : isHiDream(model)
        ? 'IMAGE_GEN_HIDREAM_MISCONFIGURED'
        : isQwen(model)
          ? 'IMAGE_GEN_QWEN_MISCONFIGURED'
          : 'IMAGE_GEN_Z_IMAGE_MISCONFIGURED';
    if (!model.repo) {
      throw new ServerError(
        `${runnerLabel} model "${modelId}" is missing the 'repo' field in data/media-models.json`,
        { status: 500, code: errCode },
      );
    }
    // Z-Image / ERNIE / HiDream / Qwen all reuse the FLUX.2 venv (same
    // diffusers + torch stack, no extra setup). Same not-installed error code
    // so the UI's existing "run setup" CTA fires for any of these runners.
    const torchPython = resolveFlux2Python();
    if (!torchPython) {
      throw new ServerError(
        `Image-gen torch venv not found. Run \`INSTALL_FLUX2=1 bash scripts/setup-image-video.sh\` to bootstrap it (expected at ${FLUX2_VENV_DEFAULT}). FLUX.2, Z-Image, ERNIE, HiDream, and Qwen share this venv.`,
        { status: 400, code: 'IMAGE_GEN_FLUX2_NOT_INSTALLED' },
      );
    }
    const scriptPath = join(PATHS.root, 'scripts', 'z_image_turbo.py');
    const args = [
      scriptPath,
      '--model', modelId,
      '--repo', model.repo,
      '--prompt', prompt,
      '--height', String(height),
      '--width', String(width),
      '--steps', String(steps),
      '--guidance', String(guidance ?? 1.0),
      '--seed', String(seed),
      '--output', outputPath,
    ];
    if (negativePrompt) args.push('--negative-prompt', negativePrompt);
    if (initImagePath) args.push('--image-path', initImagePath);
    if (initImagePath && initImageStrength != null) args.push('--image-strength', String(initImageStrength));
    if (stepwiseDir) args.push('--stepwise-image-output-dir', stepwiseDir);
    if (loraPaths?.length) args.push('--lora-paths', ...loraPaths);
    if (loraScales?.length) args.push('--lora-scales', ...loraScales.map(String));
    if (model.pipelineClass) args.push('--pipeline-class', String(model.pipelineClass));
    if (model.usePromptEnhancer) args.push('--use-pe');
    // HiDream needs a 4th text encoder loaded separately (Llama-3.1-8B) —
    // the Diffusers HiDreamImagePipeline expects `text_encoder_4` /
    // `tokenizer_4` kwargs at from_pretrained() time. The runner script
    // branches on these flags; Z-Image / ERNIE / Qwen leave them unset.
    if (model.textEncoderRepo) args.push('--text-encoder-repo', String(model.textEncoderRepo));
    if (model.textEncoderClass) args.push('--text-encoder-class', String(model.textEncoderClass));
    if (model.tokenizerClass) args.push('--tokenizer-class', String(model.tokenizerClass));
    return { bin: torchPython, args };
  }
  if (isFlux2(model)) {
    if (!model.repo) {
      throw new ServerError(
        `FLUX.2 model "${modelId}" is missing the 'repo' field in data/media-models.json`,
        { status: 500, code: 'IMAGE_GEN_FLUX2_MISCONFIGURED' },
      );
    }
    const quantization = model.quantization || 'sdnq';
    if (quantization !== 'sdnq' && quantization !== 'int8' && quantization !== 'none') {
      throw new ServerError(
        `FLUX.2 model "${modelId}" has unsupported quantization "${quantization}" (supported: sdnq, int8, none)`,
        { status: 500, code: 'IMAGE_GEN_FLUX2_MISCONFIGURED' },
      );
    }
    if (quantization === 'sdnq' && !model.tokenizerRepo) {
      throw new ServerError(
        `FLUX.2 SDNQ model "${modelId}" requires 'tokenizerRepo' (the gated base repo for the tokenizer)`,
        { status: 500, code: 'IMAGE_GEN_FLUX2_MISCONFIGURED' },
      );
    }
    if (quantization === 'int8' && !model.basePipelineRepo) {
      throw new ServerError(
        `FLUX.2 Int8 model "${modelId}" requires 'basePipelineRepo' (the gated base repo for VAE/scheduler)`,
        { status: 500, code: 'IMAGE_GEN_FLUX2_MISCONFIGURED' },
      );
    }
    // quantization=none uses model.repo directly (gated base repo). No
    // sibling-repo flag required, but the repo must be the gated base.
    const flux2Python = resolveFlux2Python();
    if (!flux2Python) {
      throw new ServerError(
        `FLUX.2 venv not found. Run \`INSTALL_FLUX2=1 bash scripts/setup-image-video.sh\` to bootstrap it (expected at ${FLUX2_VENV_DEFAULT}).`,
        { status: 400, code: 'IMAGE_GEN_FLUX2_NOT_INSTALLED' },
      );
    }
    const scriptPath = join(PATHS.root, 'scripts', 'flux2_macos.py');
    // No --metadata flag: local.js's proc.on('close') already writes the
    // canonical sidecar at <jobId>.metadata.json after a successful exit.
    // Letting the runner write its own would duplicate work and the JS
    // sidecar would clobber any flux2-specific fields anyway.
    const args = [
      scriptPath,
      '--model', modelId,
      '--quantization', quantization,
      '--repo', model.repo,
      '--prompt', prompt,
      '--height', String(height),
      '--width', String(width),
      '--steps', String(steps),
      '--guidance', String(guidance ?? 0),
      '--seed', String(seed),
      '--output', outputPath,
    ];
    if (model.tokenizerRepo) args.push('--tokenizer-repo', model.tokenizerRepo);
    if (model.basePipelineRepo) args.push('--base-pipeline-repo', model.basePipelineRepo);
    if (negativePrompt) args.push('--negative-prompt', negativePrompt);
    if (initImagePath) args.push('--image-path', initImagePath);
    if (initImagePath && initImageStrength != null) args.push('--image-strength', String(initImageStrength));
    // Multi-reference editing for FLUX.2. When the path list is non-empty,
    // scripts/flux2_macos.py loads Flux2KleinKVPipeline (instead of the
    // single-image Flux2KleinPipeline) and passes the refs as image=[PIL...].
    // The route always emits parallel referenceImageStrengths (defaulting to
    // 1.0 per ref); the runner warns on non-default values today because the
    // KV pipeline doesn't yet expose per-reference attention weighting.
    if (referenceImagePaths?.length) {
      args.push('--reference-images', ...referenceImagePaths);
      if (referenceImageStrengths?.length) {
        args.push('--reference-strengths', ...referenceImageStrengths.map(String));
      }
    }
    if (stepwiseDir) args.push('--stepwise-image-output-dir', stepwiseDir);
    if (loraPaths?.length) args.push('--lora-paths', ...loraPaths);
    if (loraScales?.length) args.push('--lora-scales', ...loraScales.map(String));
    return { bin: flux2Python, args };
  }

  if (IS_WIN) {
    // imagine_win.py does not implement i2i — silently drop the init-image
    // args here so the request still produces a normal txt2img result rather
    // than failing argparse with "unrecognized arguments".
    const scriptPath = join(PATHS.root, 'scripts', 'imagine_win.py');
    return {
      bin: pythonPath,
      args: [scriptPath, '--model', modelId, '--prompt', prompt, '--height', String(height), '--width', String(width), '--steps', String(steps), '--seed', String(seed), '--quantize', String(quantize), '--output', outputPath, '--metadata',
        ...(guidance > 0 ? ['--guidance', String(guidance)] : []),
        ...(negativePrompt ? ['--negative-prompt', negativePrompt] : []),
        ...(loraPaths.length ? ['--lora-paths', ...loraPaths] : []),
        ...(loraScales.length ? ['--lora-scales', ...loraScales.map(String)] : []),
      ],
    };
  }
  const bin = join(dirname(pythonPath), 'mflux-generate');
  const args = ['--model', modelId, '--prompt', prompt, '--height', String(height), '--width', String(width), '--steps', String(steps), '--seed', String(seed), '--quantize', String(quantize), '--output', outputPath, '--metadata'];
  if (guidance > 0) args.push('--guidance', String(guidance));
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (loraPaths.length) args.push('--lora-paths', ...loraPaths);
  if (loraScales.length) args.push('--lora-scales', ...loraScales.map(String));
  if (initImagePath) args.push('--image-path', initImagePath);
  if (initImagePath && initImageStrength != null) args.push('--image-strength', String(initImageStrength));
  // mflux writes one PNG per step here as it diffuses; we watch the dir and
  // stream the latest frame back to the client as `currentImage` for the
  // live-preview area.
  if (stepwiseDir) args.push('--stepwise-image-output-dir', stepwiseDir);
  return { bin, args };
};

export async function generateImage({ pythonPath, prompt, negativePrompt = '', modelId = 'dev', width = 1024, height = 1024, steps, guidance, seed, quantize = '8', loraFilenames = [], loraPaths = [], loraScales = [], initImagePath = null, initImageStrength = null, referenceImagePaths = [], referenceImageStrengths = [], jobId: providedJobId = null, cleanC2PA = false, denoise = false }) {
  if (!prompt?.trim()) throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  // Single-flight is enforced by the mediaJobQueue worker upstream. Direct
  // callers that bypass the queue must not run two concurrent renders — the
  // activeProcess handle below would be clobbered and cancel() would orphan
  // the first child.
  // loadMediaModels memoizes — on-disk edits to data/media-models.json still
  // need a server restart to apply. Don't re-check model.broken here:
  // getImageModels() already filtered current-platform entries; an extra
  // check would also reject entries broken on the OTHER platform (e.g.
  // 'windows' on a macOS box).
  const model = getImageModels().find((m) => m.id === modelId);
  if (!model) throw new ServerError(`Unknown or unsupported model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });
  // Both flux2 and z-image runners resolve their own Python via the FLUX.2
  // venv — only the legacy mflux/imagine_win path needs the user-configured
  // Settings > Image Gen pythonPath.
  if (!isFlux2(model) && !usesDiffusersRunner(model) && !pythonPath) {
    throw new ServerError('Python path not configured — set it in Settings > Image Gen', { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' });
  }
  // FLUX.2 and Z-Image runners now load LoRAs via diffusers'
  // pipe.load_lora_weights — but only LoRAs trained against the matching
  // base model will produce sensible output. The LoRA picker UI uses the
  // sidecar's `runnerFamily` field to filter; we don't enforce here so a
  // user can deliberately experiment with off-family weights and see what
  // happens (the runner will surface a shape-mismatch error from diffusers).

  await ensureDir(PATHS.images);
  await ensureDir(PATHS.loras);

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  const actualSeed = seed != null && seed !== '' ? Number(seed) : Math.floor(Math.random() * 2147483647);
  const actualSteps = steps ? Number(steps) : model.steps;
  // Step-wise distilled models (Schnell / FLUX.2 Klein / Z-Image-Turbo) ignore
  // any guidance scale > 1.0 internally; passing a real value just produces a
  // "Guidance scale X is ignored for step-wise distilled models." warning on
  // every render. Clamp to ≤1.0 (rather than hard-pin to 1.0) so registry
  // entries that intentionally use 0.0 — e.g. Flux.1 Schnell, where the mflux
  // runner historically *omits* --guidance entirely on 0 — keep their existing
  // behavior. The clamp keeps FLUX.2 / Z-Image / ERNIE quiet while leaving
  // sub-1.0 values (including 0.0) untouched.
  const requestedGuidance = guidance != null && guidance !== '' ? Number(guidance) : model.guidance;
  const actualGuidance = model.cfgDisabled
    ? Math.min(1.0, Number.isFinite(requestedGuidance) ? requestedGuidance : 1.0)
    : requestedGuidance;
  // The new client-side surface sends `loraFilenames` (basenames only); the
  // server resolves them against PATHS.loras. `loraPaths` is kept as a
  // back-compat input for old gallery sidecars that stored absolute paths
  // pre-refactor — both go through the same resolve+prefix-check.
  const lorasRoot = resolvePath(PATHS.loras) + PATH_SEP;
  const candidates = [
    ...loraFilenames.map((f) => (typeof f === 'string' ? join(PATHS.loras, basename(f)) : null)),
    ...loraPaths,
  ];
  const validLoras = candidates.filter((p) => {
    if (!p || typeof p !== 'string') return false;
    const resolved = resolvePath(p);
    if (!resolved.startsWith(lorasRoot)) return false;
    return existsSync(resolved);
  });

  // Store loraFilenames (basenames) in the sidecar going forward — that's
  // what the new client API uses for remix. Keep `loraPaths` populated too
  // so older code paths reading the sidecar don't break.
  const validLoraFilenames = validLoras.map((p) => basename(p));
  // i2i: defense in depth — the route already validated a fresh request,
  // but an old sidecar replay can carry a stale absolute path outside the
  // approved image roots. resolveImageInputPath accepts gallery + image-refs
  // + visual templates — the latter so the universe-builder reference-sheet
  // renderer can use a shipped layout template as the init-image anchor.
  const validInitImagePath = (initImagePath && typeof initImagePath === 'string')
    ? resolveImageInputPath(initImagePath)
    : null;
  // Clamp 0..1 with a finite-fallback — Math.max/min preserve NaN, so a
  // corrupt sidecar value like Number('bad') would slip through and end up
  // serialized into metadata / the CLI flag. `null` here means "no strength
  // sent" (init-image), which the args builder already gates on; for refs
  // (below) we fall back to 1.0 (full influence).
  const clampStrength01 = (raw, fallback) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
  };
  const validInitImageStrength = validInitImagePath && initImageStrength != null
    ? clampStrength01(initImageStrength, null)
    : null;
  // Multi-reference: re-anchor each path through resolveImageInputPath so a
  // sidecar replay can't sneak a path outside the approved image roots into
  // the runner. Accepts gallery + image-refs + visual templates — the gallery
  // path lets a canon portrait (e.g. character.primaryImageRef) flow in as a
  // multi-ref input. Pair each path with its strength BEFORE filtering so a
  // rejected entry doesn't shift the strength array — otherwise the surviving
  // path would inherit the wrong slot's strength.
  const rawRefPaths = Array.isArray(referenceImagePaths) ? referenceImagePaths : [];
  const validReferences = rawRefPaths
    .map((p, i) => {
      const resolved = typeof p === 'string' ? resolveImageInputPath(p) : null;
      if (!resolved) return null;
      const rawStrength = referenceImageStrengths?.[i];
      const strength = rawStrength != null ? clampStrength01(rawStrength, 1.0) : 1.0;
      return { path: resolved, strength };
    })
    .filter(Boolean);
  const validReferenceImagePaths = validReferences.map((r) => r.path);
  const validReferenceImageStrengths = validReferences.map((r) => r.strength);
  // `referenceImageStrengthsRequested` (not `…Strengths`) because the KV
  // pipeline doesn't yet expose per-reference attention weighting — non-1.0
  // values come through the route but the runner only warns, so the sidecar
  // must not claim they were applied. Mirror with the Python sidecar's
  // `referenceStrengthsRequested` field. Rename to `…Strengths` when
  // diffusers exposes a real per-ref knob.
  const meta = { id: jobId, prompt, negativePrompt, modelId, seed: actualSeed, width: Number(width), height: Number(height), steps: actualSteps, guidance: actualGuidance, quantize, filename, loraFilenames: validLoraFilenames, loraPaths: validLoras, loraScales, initImageFilename: validInitImagePath ? basename(validInitImagePath) : null, initImageStrength: validInitImageStrength, referenceImageFilenames: validReferenceImagePaths.map((p) => basename(p)), referenceImageStrengthsRequested: validReferenceImageStrengths, createdAt: new Date().toISOString() };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  // Per-job stepwise output dir under the OS temp dir. mflux writes one PNG
  // per inference step here; we watch and stream the latest as `currentImage`.
  const stepwiseDir = await mkdtemp(join(tmpdir(), 'portos-stepwise-'));

  const { bin, args } = buildArgs({ pythonPath, model, prompt, negativePrompt, width: Number(width), height: Number(height), steps: actualSteps, guidance: actualGuidance, seed: actualSeed, quantize, outputPath, loraPaths: validLoras, loraScales, stepwiseDir, initImagePath: validInitImagePath, initImageStrength: validInitImageStrength, referenceImagePaths: validReferenceImagePaths, referenceImageStrengths: validReferenceImageStrengths });

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] local: ${modelId} ${width}x${height} steps=${actualSteps}`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: actualSteps });
  activeJob = { ...meta, generationId: jobId, totalSteps: actualSteps, step: 0, progress: 0, currentImage: null, mode: IMAGE_GEN_MODE.LOCAL };

  const proc = spawn(bin, args, { env: { ...process.env, ...(await hfTokenEnv()) }, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcess = proc;
  // Spawn ENOENT (missing/non-executable pythonPath) fires BOTH 'error' and
  // 'close' on Node — without this guard, a typo'd pythonPath emits two
  // 'failed' events to imageGenEvents and two SSE error frames to the
  // client. The mediaJobQueue's terminate() is idempotent on the first, but
  // the duplicate noise still confuses anything else listening. Track
  // whether we've finalized so the close handler can detect "already
  // handled" and skip the second emit.
  let finalized = false;
  proc.on('error', (err) => {
    if (finalized) return;
    finalized = true;
    job.status = 'error';
    const reason = `Failed to spawn ${bin}: ${err.message}`;
    console.log(`❌ Image generation spawn error [${jobId.slice(0, 8)}]: ${reason}`);
    broadcastSse(job, { type: 'error', error: reason });
    imageGenEvents.emit('failed', { generationId: jobId, error: reason });
    activeProcess = null;
    activeJob = null;
    rm(stepwiseDir, { recursive: true, force: true }).catch(() => {});
    closeJobAfterDelay(jobs, jobId);
  });

  // Watch the stepwise output dir for new PNGs. When a new file appears,
  // base64-encode the latest one and emit it as `currentImage`. fs.watch
  // fires multiple times per write — keep a single in-flight read and a
  // pending flag so we always get the *latest* frame without piling up reads.
  let watcher = null;
  let reading = false;
  let pendingFrame = false;
  const processLatestFrame = async () => {
    if (reading) { pendingFrame = true; return; }
    reading = true;
    try {
      // Sort by mtime, not filename. mflux names files like `step_1.png` …
      // `step_20.png` (no zero-padding), so alphabetical sort puts `step_2`
      // *after* `step_19` and we'd render an early-step latent (mostly noise)
      // instead of the latest. Also drop mflux's `seed_*_composite.png` —
      // it writes that grid right after every step, so its mtime always wins
      // the "latest" race and the user would see a growing thumbnail strip
      // instead of the live diffusion frame.
      const names = (await readdir(stepwiseDir)).filter((f) => f.endsWith('.png') && !f.includes('composite'));
      const stats = await Promise.all(names.map(async (n) => {
        const s = await stat(join(stepwiseDir, n)).catch(() => null);
        return s ? { n, mtimeMs: s.mtimeMs } : null;
      }));
      const latest = stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.n;
      if (latest) {
        const buf = await readFile(join(stepwiseDir, latest));
        const currentImage = buf.toString('base64');
        if (activeJob && activeJob.generationId === jobId) activeJob.currentImage = currentImage;
        imageGenEvents.emit('progress', { generationId: jobId, currentImage });
      }
    } catch (err) {
      // Partial PNG mid-write or stepwise dir gone after cancel — common,
      // don't spam, but surface the message so a stalled preview is debuggable.
      console.log(`⚠️ Frame read error [${jobId.slice(0, 8)}]: ${err?.message}`);
    }
    reading = false;
    if (pendingFrame) { pendingFrame = false; processLatestFrame(); }
  };
  try {
    watcher = fsWatch(stepwiseDir, (event) => {
      if (event === 'rename') processLatestFrame();
    });
  } catch { /* if watch fails, we still get final image — degrade gracefully */ }

  // Bounded tail of recent stderr — only the last ~64KB is kept, since the
  // failure path only uses the trailing 10 lines for context. Without this
  // bound a noisy backend (HF download progress, deprecation warnings)
  // would grow this buffer for the full duration of a long render.
  const STDERR_TAIL_BYTES = 64 * 1024;
  let stderrBuffer = '';
  // Returns true when the line drove a progress event (so the pm2-log echo
  // below skips it — progress bars are spammy and already visible in the UI).
  // Status / debug / error lines fall through to console.log so a stuck render
  // (model download, HF auth probe, weight load) shows up in pm2 logs instead
  // of vanishing into the SSE channel only the browser ever sees.
  // Phase tracking. Lifecycle events from the runner (STAGE:download-pipeline,
  // STAGE:inference, etc.) flip the phase so the UI can show "Downloading
  // model weights" instead of misleading "step 0/8" while HF pulls multi-GB
  // shards. Inference progress events also tag themselves with the current
  // phase so the client knows whether `step/total` reflects download chunks
  // (out of N safetensors files) or actual generation steps.
  let currentPhase = 'starting';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || PYTHON_NOISE_RE.test(trimmed)) return true;
    // Heartbeat — any non-noise line resets the queue's idle watchdog so
    // first-run multi-GB HF downloads don't trip the timeout when
    // tqdm is slow to update during connection-establishment.
    imageGenEvents.emit('activity', { generationId: jobId });

    if (trimmed.startsWith('STAGE:')) {
      const rest = trimmed.slice(6); // strip 'STAGE:'
      const colon = rest.indexOf(':');
      const stage = colon === -1 ? rest : rest.slice(0, colon);
      const detail = colon === -1 ? '' : rest.slice(colon + 1);
      currentPhase = stage;
      broadcastSse(job, { type: 'stage', stage, detail });
      return true;
    }

    const m = trimmed.match(/(\d+)%\|.*?(\d+)\/(\d+)/);
    if (m) {
      const pct = parseInt(m[1], 10) / 100;
      const step = parseInt(m[2], 10);
      const total = parseInt(m[3], 10);
      broadcastSse(job, { type: 'progress', progress: pct, message: trimmed, phase: currentPhase });
      // Only forward to imageGenEvents (which drives the UI step counter)
      // when we're actually in the inference phase — download tqdm bars
      // count safetensors files, not diffusion steps.
      if (currentPhase === 'inference') {
        imageGenEvents.emit('progress', { generationId: jobId, progress: pct, step, totalSteps: total });
        if (activeJob && activeJob.generationId === jobId) {
          activeJob.progress = pct; activeJob.step = step; activeJob.totalSteps = total;
        }
      }
      return true;
    }
    broadcastSse(job, { type: 'status', message: trimmed });
    return false;
  };

  const shortId = jobId.slice(0, 8);
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    if (stderrBuffer.length > STDERR_TAIL_BYTES) {
      stderrBuffer = stderrBuffer.slice(-STDERR_TAIL_BYTES);
    }
    for (const line of text.split(/[\n\r]+/)) {
      const trimmed = line.trim();
      if (!handleLine(line) && trimmed) console.log(`🐍 [${shortId}] ${trimmed}`);
    }
  });
  proc.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split(/[\n\r]+/)) {
      const trimmed = line.trim();
      if (!handleLine(line) && trimmed) console.log(`🐍-out [${shortId}] ${trimmed}`);
    }
  });

  proc.on('close', async (code, signal) => {
    // Guard against the spawn-ENOENT path where 'error' already finalized
    // the job. Node fires 'error' THEN 'close' (with code -2/null signal)
    // for a missing binary, and re-running the failure path here would
    // emit a second 'failed' event + second SSE error frame.
    if (finalized) return;
    finalized = true;
    activeProcess = null;
    activeJob = null;
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    rm(stepwiseDir, { recursive: true, force: true }).catch(() => {});
    if (code !== 0) {
      job.status = 'error';
      const reason = signal ? `Killed by signal ${signal}` : `Exit code ${code}`;
      // Extract a structured user-error if the runner emitted one
      // (USER_ERROR:gated_repo:black-forest-labs/FLUX.2-klein-9B), and find
      // the matching `❌ …` prose line that follows it. Fall back to the last
      // 10 stderr lines if no structured error was emitted (unknown crash).
      const lines = stderrBuffer.split('\n').map((l) => l.trim()).filter(Boolean);
      const structIdx = lines.findIndex((l) => l.startsWith('USER_ERROR:'));
      let userMessage = null;
      let userKind = null;
      let userRepo = null;
      if (structIdx >= 0) {
        // Split with limit=2 so a kind containing colons can't shred the repo.
        const [kind, ...rest] = lines[structIdx].slice('USER_ERROR:'.length).split(':');
        userKind = kind;
        userRepo = rest.join(':') || null;
        const proseIdx = lines.findIndex((l, i) => i > structIdx && l.startsWith('❌'));
        userMessage = proseIdx >= 0 ? lines[proseIdx].replace(/^❌\s*/, '') : null;
      }
      // Heuristic detection for non-USER_ERROR failures we can still
      // surface actionably. mflux's entry-point shim breaks when a partial
      // package upgrade leaves user-site at the right version number but
      // with stale file layout — Python imports the wrong `mflux/` first.
      // Easier to spot at the source than to teach the user to read pip diffs.
      if (!userMessage) {
        const mfluxBroken = lines.some((l) => /ModuleNotFoundError: No module named 'mflux\.models\.flux\.cli'/.test(l));
        if (mfluxBroken) {
          userKind = 'mflux_install_corrupted';
          userMessage = 'Your mflux install is corrupted (entry-point shim and package layout out of sync). Repair with: `pip uninstall -y mflux && pip install --user --force-reinstall --no-cache-dir --no-deps mflux`. If you use conda, run the same in your conda env\'s pip.';
        }
      }
      // Legacy mflux-generate is a pre-built binary, so it doesn't emit the
      // structured USER_ERROR markers the flux2/z-image Python runners use.
      // Match the raw huggingface_hub stack instead — `GatedRepoError` or the
      // "Cannot access gated repo for url …/<owner>/<name>/…" prose. Extract
      // the repo so the UI banner can link the user straight to the license
      // page (and we set kind=gated_repo so the client knows to surface the
      // token-entry form).
      if (!userMessage) {
        const gatedUrlMatch = lines
          .map((l) => l.match(/Cannot access gated repo for url https?:\/\/huggingface\.co\/([^/\s]+\/[^/\s]+)\//))
          .find(Boolean);
        const hasGatedError = lines.some((l) => /GatedRepoError|Access to model .* is restricted/.test(l));
        if (gatedUrlMatch || hasGatedError) {
          userKind = 'gated_repo';
          userRepo = gatedUrlMatch ? gatedUrlMatch[1] : null;
          const repoText = userRepo || 'the model';
          userMessage = `Access to ${repoText} is gated. Accept the license at https://huggingface.co/${userRepo || '<repo>'} and paste your HuggingFace token into Image Gen settings, then retry.`;
        }
      }
      const tail = lines.slice(-10).join('\n');
      const errorText = userMessage
        ? `${userMessage}\n\n(diagnostic) ${reason}`
        : `Generation failed: ${reason}\n${tail}`;
      console.log(`❌ Image generation failed [${jobId.slice(0, 8)}]: ${userMessage || reason}`);
      job.error = userMessage || reason;
      job.errorKind = userKind;
      job.errorRepo = userRepo;
      broadcastSse(job, { type: 'error', error: errorText, kind: userKind, repo: userRepo });
      // Propagate the friendly message (not the raw "Exit code 1") to the
      // job queue so its `failed` log line and future SSE replays carry it.
      imageGenEvents.emit('failed', { generationId: jobId, error: userMessage || reason });
    } else {
      job.status = 'complete';
      // Sidecar: persist a metadata record next to the PNG so the gallery
      // and Remix flow can recover prompt/seed/steps even if mflux's own
      // --metadata sidecar lives at a slightly different filename shape.
      const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
      await writeFile(sidecar, JSON.stringify(meta, null, 2)).catch(() => {});
      // Cleaners run BEFORE the SSE complete + completed events so subscribers
      // see the cleaned bytes. Local FLUX renders never carry C2PA chunks so
      // cleanC2PA is a no-op on local — denoise is the only mode that does
      // anything here.
      await autoCleanGeneratedImage({ cleanC2PA, denoise, pngPath: outputPath, sidecarPath: sidecar, mode: IMAGE_GEN_MODE.LOCAL });
      console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename}`);
      const result = { filename, seed: actualSeed, path: `/data/images/${filename}` };
      broadcastSse(job, { type: 'complete', result });
      // Include `seed` so /sdapi/v1/txt2img can surface the actual seed used
      // (mflux generates a random one if the client didn't pass one).
      imageGenEvents.emit('completed', { generationId: jobId, path: `/data/images/${filename}`, filename, seed: actualSeed });
    }
    closeJobAfterDelay(jobs, jobId);
  });

  return { jobId, filename, path: `/data/images/${filename}`, generationId: jobId, mode: IMAGE_GEN_MODE.LOCAL, model: modelId, seed: actualSeed };
}

// Validate a gallery filename: PNG-only, basename only, no path separators.
// Delegates to the shared `assertSafeFilename` helper in fileUtils.js.
// Substring `..` is allowed (e.g. `my..render.png` is fine) because the
// helper only rejects the exact-string traversal cases.
// `requiredMessage` preserves the original "Invalid filename" wording for
// the missing-input case so existing client error-message expectations
// (and the previously-shipped error-middleware contract) don't shift.
export function assertGalleryFilename(filename) {
  assertSafeFilename(filename, {
    extensions: ['.png'],
    subject: 'filename',
    requiredMessage: 'Invalid filename',
  });
}

// Returns `{ path, metadata }`. `path` is the resolved sidecar location, or
// the preferred Portos location on miss — callers writing back land at the
// canonical path automatically.
export async function readImageSidecar(filename) {
  const portosSidecar = join(PATHS.images, filename.replace('.png', '.metadata.json'));
  const altSidecar = join(PATHS.images, `${filename}.metadata.json`);
  for (const path of [portosSidecar, altSidecar]) {
    const raw = await tryReadFile(path);
    if (raw != null) return { path, metadata: safeJSONParse(raw, {}) };
  }
  return { path: portosSidecar, metadata: {} };
}

export async function listGallery() {
  if (!existsSync(PATHS.images)) return [];
  // requireRegularFile:false preserves the original gallery behavior — it
  // never checked isFile(), only dropped on stat failure. listLoras /
  // listMusicLibrary do filter directories; mirroring that here would be a
  // behavior change.
  const items = await listDirectoryByExtension(PATHS.images, {
    extensions: ['.png'],
    requireRegularFile: false,
    mapEntry: async (f, _fullPath, s) => {
      const { metadata } = await readImageSidecar(f);
      return {
        filename: f,
        path: `/data/images/${f}`,
        createdAt: metadata.createdAt || s.birthtime.toISOString(),
        ...metadata,
      };
    },
  });
  return items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function deleteImage(filename) {
  assertGalleryFilename(filename);
  await unlink(join(PATHS.images, filename)).catch(() => {});
  await unlink(join(PATHS.images, filename.replace('.png', '.metadata.json'))).catch(() => {});
  await unlink(join(PATHS.images, `${filename}.metadata.json`)).catch(() => {});
  console.log(`🗑️ Deleted image: ${filename}`);
  return { ok: true };
}

export async function setImageHidden(filename, hidden) {
  assertGalleryFilename(filename);
  const { path: sidecarPath, metadata } = await readImageSidecar(filename);
  metadata.hidden = !!hidden;
  await writeFile(sidecarPath, JSON.stringify(metadata, null, 2));
  return { ok: true, hidden: metadata.hidden };
}

// Returns just `{ filename, name }` — clients send `filename` back in the
// generate payload's `loraFilenames` and the server resolves it against
// PATHS.loras. Avoids leaking absolute server paths into the API surface.
//
// Distinct from `services/loras.js#listLoras` which returns the rich
// Civitai-aware shape (civitai, runnerFamily, triggerWords, etc.) for the
// `/api/loras` manager UI. The two used to share the name `listLoras`;
// rename here makes the shape distinction explicit so a future caller
// can't import the wrong one and silently lose `civitai`/`runnerFamily`.
export async function listLoraFilenames() {
  await ensureDir(PATHS.loras);
  const files = await readdir(PATHS.loras).catch(() => []);
  return files.filter((f) => f.endsWith('.safetensors')).map((f) => ({
    filename: f,
    name: f.replace(/^lora-/, '').replace(/\.safetensors$/, ''),
  }));
}
