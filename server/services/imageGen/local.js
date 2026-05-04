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
import { ensureDir, PATHS, safeJSONParse } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, PYTHON_NOISE_RE } from '../../lib/sseUtils.js';
import { resolveFlux2Python, FLUX2_VENV_DEFAULT } from '../../lib/pythonSetup.js';
import { hfTokenEnv } from '../../lib/hfToken.js';

const IS_WIN = process.platform === 'win32';

import { getImageModels, isFlux2 } from '../../lib/mediaModels.js';

export const IMAGE_MODELS = Object.fromEntries(getImageModels().map((m) => [m.id, m]));

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

export const buildArgs = ({ pythonPath, model, prompt, negativePrompt, width, height, steps, guidance, seed, quantize, outputPath, loraPaths, loraScales, stepwiseDir, initImagePath, initImageStrength }) => {
  const modelId = model?.id;
  if (isFlux2(model)) {
    if (!model.repo) {
      throw new ServerError(
        `FLUX.2 model "${modelId}" is missing the 'repo' field in data/media-models.json`,
        { status: 500, code: 'IMAGE_GEN_FLUX2_MISCONFIGURED' },
      );
    }
    const quantization = model.quantization || 'sdnq';
    if (quantization !== 'sdnq' && quantization !== 'int8') {
      throw new ServerError(
        `FLUX.2 model "${modelId}" has unsupported quantization "${quantization}" (supported: sdnq, int8)`,
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
    if (stepwiseDir) args.push('--stepwise-image-output-dir', stepwiseDir);
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

export async function generateImage({ pythonPath, prompt, negativePrompt = '', modelId = 'dev', width = 1024, height = 1024, steps, guidance, seed, quantize = '8', loraFilenames = [], loraPaths = [], loraScales = [], initImagePath = null, initImageStrength = null, jobId: providedJobId = null }) {
  if (!prompt?.trim()) throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  // Single-flight is enforced by the mediaJobQueue worker upstream. Direct
  // callers that bypass the queue must not run two concurrent renders — the
  // activeProcess handle below would be clobbered and cancel() would orphan
  // the first child.
  // Use the registry cache view (which applies the per-platform `broken`
  // filter via getImageModels) rather than the module-load IMAGE_MODELS
  // snapshot. Note: loadMediaModels memoizes on first read — on-disk edits
  // to data/media-models.json still need a server restart to apply.
  // Don't re-check model.broken here: getImageModels() already filtered
  // current-platform entries; an extra truthiness check would also reject
  // entries broken on the OTHER platform (e.g. 'windows' on a macOS box).
  const model = getImageModels().find((m) => m.id === modelId);
  if (!model) throw new ServerError(`Unknown or unsupported model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });
  if (!isFlux2(model) && !pythonPath) {
    throw new ServerError('Python path not configured — set it in Settings > Image Gen', { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' });
  }
  // FLUX.2 runner doesn't apply LoRAs yet — reject up-front so the user
  // doesn't end up with a metadata sidecar that records LoRAs the renderer
  // silently dropped.
  if (isFlux2(model) && (loraFilenames.length > 0 || loraPaths.length > 0)) {
    throw new ServerError(
      'LoRAs are not supported for FLUX.2 models yet — clear the LoRA selection or pick a Flux 1 model.',
      { status: 400, code: 'IMAGE_GEN_FLUX2_LORA_UNSUPPORTED' },
    );
  }

  await ensureDir(PATHS.images);
  await ensureDir(PATHS.loras);

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  const actualSeed = seed != null && seed !== '' ? Number(seed) : Math.floor(Math.random() * 2147483647);
  const actualSteps = steps ? Number(steps) : model.steps;
  const actualGuidance = guidance != null && guidance !== '' ? Number(guidance) : model.guidance;
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
  // i2i: validate the init image path stays under PATHS.images so a malicious
  // payload (or a stale absolute path from an old sidecar) can't make mflux
  // read arbitrary files. If the caller passes a basename, the route layer
  // already resolved it to PATHS.images/<basename>; this is a defense-in-depth
  // check here too.
  let validInitImagePath = null;
  if (initImagePath && typeof initImagePath === 'string') {
    const imagesRoot = resolvePath(PATHS.images) + PATH_SEP;
    const resolved = resolvePath(initImagePath);
    if (resolved.startsWith(imagesRoot) && existsSync(resolved)) validInitImagePath = resolved;
  }
  const validInitImageStrength = validInitImagePath && initImageStrength != null
    ? Math.max(0, Math.min(1, Number(initImageStrength)))
    : null;
  const meta = { id: jobId, prompt, negativePrompt, modelId, seed: actualSeed, width: Number(width), height: Number(height), steps: actualSteps, guidance: actualGuidance, quantize, filename, loraFilenames: validLoraFilenames, loraPaths: validLoras, loraScales, initImageFilename: validInitImagePath ? basename(validInitImagePath) : null, initImageStrength: validInitImageStrength, createdAt: new Date().toISOString() };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  // Per-job stepwise output dir under the OS temp dir. mflux writes one PNG
  // per inference step here; we watch and stream the latest as `currentImage`.
  const stepwiseDir = await mkdtemp(join(tmpdir(), 'portos-stepwise-'));

  const { bin, args } = buildArgs({ pythonPath, model, prompt, negativePrompt, width: Number(width), height: Number(height), steps: actualSteps, guidance: actualGuidance, seed: actualSeed, quantize, outputPath, loraPaths: validLoras, loraScales, stepwiseDir, initImagePath: validInitImagePath, initImageStrength: validInitImageStrength });

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] local: ${modelId} ${width}x${height} steps=${actualSteps}`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: actualSteps });
  activeJob = { ...meta, generationId: jobId, totalSteps: actualSteps, step: 0, progress: 0, currentImage: null, mode: 'local' };

  const proc = spawn(bin, args, { env: { ...process.env, ...(await hfTokenEnv()) }, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcess = proc;
  // Without an 'error' handler, a missing/non-executable pythonPath would
  // crash the server with an unhandled error event.
  proc.on('error', (err) => {
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
      // instead of the latest.
      const names = (await readdir(stepwiseDir)).filter((f) => f.endsWith('.png'));
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
      console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename}`);
      const result = { filename, seed: actualSeed, path: `/data/images/${filename}` };
      broadcastSse(job, { type: 'complete', result });
      // Include `seed` so /sdapi/v1/txt2img can surface the actual seed used
      // (mflux generates a random one if the client didn't pass one).
      imageGenEvents.emit('completed', { generationId: jobId, path: `/data/images/${filename}`, filename, seed: actualSeed });
    }
    closeJobAfterDelay(jobs, jobId);
  });

  return { jobId, filename, path: `/data/images/${filename}`, generationId: jobId, mode: 'local', model: modelId, seed: actualSeed };
}

export async function listGallery() {
  if (!existsSync(PATHS.images)) return [];
  const files = await readdir(PATHS.images);
  const pngs = files.filter((f) => f.endsWith('.png'));
  const items = await Promise.all(pngs.map(async (f) => {
    const fullPath = join(PATHS.images, f);
    const s = await stat(fullPath).catch(() => null);
    if (!s) return null;
    // Try our sidecar first, fall back to mflux's own .metadata.json shape.
    const portosSidecar = join(PATHS.images, f.replace('.png', '.metadata.json'));
    const altSidecar = join(PATHS.images, `${f}.metadata.json`);
    const path = existsSync(portosSidecar) ? portosSidecar : (existsSync(altSidecar) ? altSidecar : null);
    let metadata = {};
    if (path) {
      const raw = await readFile(path, 'utf-8').catch(() => null);
      if (raw) metadata = safeJSONParse(raw, {});
    }
    return {
      filename: f,
      path: `/data/images/${f}`,
      createdAt: metadata.createdAt || s.birthtime.toISOString(),
      ...metadata,
    };
  }));
  return items.filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function deleteImage(filename) {
  if (!filename.endsWith('.png') || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new ServerError('Invalid filename', { status: 400, code: 'VALIDATION_ERROR' });
  }
  await unlink(join(PATHS.images, filename)).catch(() => {});
  await unlink(join(PATHS.images, filename.replace('.png', '.metadata.json'))).catch(() => {});
  await unlink(join(PATHS.images, `${filename}.metadata.json`)).catch(() => {});
  console.log(`🗑️ Deleted image: ${filename}`);
  return { ok: true };
}

export async function setImageHidden(filename, hidden) {
  if (!filename.endsWith('.png') || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
    throw new ServerError('Invalid filename', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const portosSidecar = join(PATHS.images, filename.replace('.png', '.metadata.json'));
  const altSidecar = join(PATHS.images, `${filename}.metadata.json`);
  const sidecarPath = existsSync(portosSidecar) ? portosSidecar : (existsSync(altSidecar) ? altSidecar : portosSidecar);
  const raw = await readFile(sidecarPath, 'utf-8').catch(() => null);
  const meta = raw ? safeJSONParse(raw, {}) : {};
  meta.hidden = !!hidden;
  await writeFile(sidecarPath, JSON.stringify(meta, null, 2));
  return { ok: true, hidden: meta.hidden };
}

// Returns just `{ filename, name }` — clients send `filename` back in the
// generate payload's `loraFilenames` and the server resolves it against
// PATHS.loras. Avoids leaking absolute server paths into the API surface.
export async function listLoras() {
  await ensureDir(PATHS.loras);
  const files = await readdir(PATHS.loras).catch(() => []);
  return files.filter((f) => f.endsWith('.safetensors')).map((f) => ({
    filename: f,
    name: f.replace(/^lora-/, '').replace(/\.safetensors$/, ''),
  }));
}
