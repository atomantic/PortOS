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
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS, safeJSONParse } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { imageGenEvents } from '../imageGenEvents.js';

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// Model catalog. `broken: true` hides a model on a platform where it doesn't
// run (e.g. Flux 2 Klein needs CUDA, so we mark it broken on macOS).
export const IMAGE_MODELS = {
  dev:               { id: 'dev',               name: 'Flux 1 Dev',         steps: 20, guidance: 3.5 },
  schnell:           { id: 'schnell',           name: 'Flux 1 Schnell',     steps: 4,  guidance: 0   },
  'flux2-klein-4b':  { id: 'flux2-klein-4b',    name: 'Flux 2 Klein 4B',    steps: 8,  guidance: 3.5, broken: IS_MAC },
  'flux2-klein-9b':  { id: 'flux2-klein-9b',    name: 'Flux 2 Klein 9B',    steps: 8,  guidance: 3.5, broken: IS_MAC },
};

export const listImageModels = () =>
  Object.values(IMAGE_MODELS).filter((m) => !m.broken);

const NOISE_RE = /xformers|xFormers|triton|Triton|bitsandbytes|Please reinstall|Memory-efficient|Set XFORMERS|FutureWarning|UserWarning|DeprecationWarning|torch\.distributed|Unable to import.*torchao|Skipping import of cpp|NOTE: Redirects/i;

// Per-job clients: jobId -> { clients, status, meta, broadcast }
const jobs = new Map();
let activeProcess = null;
// Snapshot of the currently-running job for /api/image-gen/active so the UI
// can rehydrate prompt + settings + progress + last-rendered frame after
// navigating away. Cleared on completion / error / cancel.
let activeJob = null;

export const getActiveJob = () => activeJob;

const broadcastSse = (job, payload) => {
  const msg = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of job.clients) c.write(msg);
};

export const attachSseClient = (jobId, res) => {
  const job = jobs.get(jobId);
  if (!job) return false;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  job.clients.push(res);
  res.req.on('close', () => {
    job.clients = job.clients.filter((c) => c !== res);
  });
  return true;
};

export const cancel = () => {
  if (!activeProcess) return false;
  activeProcess.kill('SIGTERM');
  activeProcess = null;
  activeJob = null;
  return true;
};

const buildArgs = ({ pythonPath, modelId, prompt, negativePrompt, width, height, steps, guidance, seed, quantize, outputPath, loraPaths, loraScales, stepwiseDir }) => {
  if (IS_WIN) {
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
  // macOS: mflux-generate sits next to the python binary in the venv
  const bin = join(dirname(pythonPath), 'mflux-generate');
  const args = ['--model', modelId, '--prompt', prompt, '--height', String(height), '--width', String(width), '--steps', String(steps), '--seed', String(seed), '--quantize', String(quantize), '--output', outputPath, '--metadata'];
  if (guidance > 0) args.push('--guidance', String(guidance));
  if (negativePrompt) args.push('--negative-prompt', negativePrompt);
  if (loraPaths.length) args.push('--lora-paths', ...loraPaths);
  if (loraScales.length) args.push('--lora-scales', ...loraScales.map(String));
  // mflux writes one PNG per step here as it diffuses; we watch the dir and
  // stream the latest frame back to the client as `currentImage` for the
  // live-preview area.
  if (stepwiseDir) args.push('--stepwise-image-output-dir', stepwiseDir);
  return { bin, args };
};

export async function generateImage({ pythonPath, prompt, negativePrompt = '', modelId = 'dev', width = 1024, height = 1024, steps, guidance, seed, quantize = '8', loraPaths = [], loraScales = [] }) {
  if (!pythonPath) throw new ServerError('Python path not configured — set it in Settings > Image Gen', { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' });
  if (!prompt?.trim()) throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  const model = IMAGE_MODELS[modelId];
  if (!model || model.broken) throw new ServerError(`Unknown or unsupported model: ${modelId}`, { status: 400, code: 'VALIDATION_ERROR' });

  await ensureDir(PATHS.images);
  await ensureDir(PATHS.loras);

  const jobId = randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  const actualSeed = seed != null && seed !== '' ? Number(seed) : Math.floor(Math.random() * 2147483647);
  const actualSteps = steps ? Number(steps) : model.steps;
  const actualGuidance = guidance != null && guidance !== '' ? Number(guidance) : model.guidance;
  const validLoras = loraPaths.filter((p) => p && existsSync(p));

  const meta = { id: jobId, prompt, negativePrompt, modelId, seed: actualSeed, width: Number(width), height: Number(height), steps: actualSteps, guidance: actualGuidance, quantize, filename, loraPaths: validLoras, loraScales, createdAt: new Date().toISOString() };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  // Per-job stepwise output dir under the OS temp dir. mflux writes one PNG
  // per inference step here; we watch and stream the latest as `currentImage`.
  const stepwiseDir = await mkdtemp(join(tmpdir(), 'portos-stepwise-'));

  const { bin, args } = buildArgs({ pythonPath, modelId, prompt, negativePrompt, width: Number(width), height: Number(height), steps: actualSteps, guidance: actualGuidance, seed: actualSeed, quantize, outputPath, loraPaths: validLoras, loraScales, stepwiseDir });

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] local: ${modelId} ${width}x${height} steps=${actualSteps}`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: actualSteps });
  activeJob = { ...meta, generationId: jobId, totalSteps: actualSteps, step: 0, progress: 0, currentImage: null, mode: 'local' };

  const proc = spawn(bin, args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcess = proc;

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
    } catch { /* swallow — a partially-written file or tmp dir gone */ }
    reading = false;
    if (pendingFrame) { pendingFrame = false; processLatestFrame(); }
  };
  try {
    watcher = fsWatch(stepwiseDir, (event) => {
      if (event === 'rename') processLatestFrame();
    });
  } catch { /* if watch fails, we still get final image — degrade gracefully */ }

  let stderrBuffer = '';
  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed || NOISE_RE.test(trimmed)) return;
    // mflux progress: "100%|████| 8/8 [00:05<00:00,  1.43it/s]"
    const m = trimmed.match(/(\d+)%\|.*?(\d+)\/(\d+)/);
    if (m) {
      const pct = parseInt(m[1], 10) / 100;
      const step = parseInt(m[2], 10);
      const total = parseInt(m[3], 10);
      broadcastSse(job, { type: 'progress', progress: pct, message: trimmed });
      imageGenEvents.emit('progress', { generationId: jobId, progress: pct, step, totalSteps: total });
      if (activeJob && activeJob.generationId === jobId) {
        activeJob.progress = pct; activeJob.step = step; activeJob.totalSteps = total;
      }
    } else {
      broadcastSse(job, { type: 'status', message: trimmed });
    }
  };

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    for (const line of text.split(/[\n\r]+/)) handleLine(line);
  });
  proc.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split(/[\n\r]+/)) handleLine(line);
  });

  proc.on('close', async (code, signal) => {
    activeProcess = null;
    activeJob = null;
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    rm(stepwiseDir, { recursive: true, force: true }).catch(() => {});
    if (code !== 0) {
      job.status = 'error';
      const reason = signal ? `Killed by signal ${signal}` : `Exit code ${code}`;
      const tail = stderrBuffer.trim().split('\n').slice(-10).join('\n');
      console.log(`❌ Image generation failed [${jobId.slice(0, 8)}]: ${reason}`);
      broadcastSse(job, { type: 'error', error: `Generation failed: ${reason}\n${tail}` });
      imageGenEvents.emit('failed', { generationId: jobId, error: reason });
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
      imageGenEvents.emit('completed', { generationId: jobId, path: `/data/images/${filename}`, filename });
    }
    setTimeout(() => {
      for (const c of job.clients) c.end();
      jobs.delete(jobId);
    }, 5000);
  });

  return { jobId, filename, path: `/data/images/${filename}`, generationId: jobId, mode: 'local', model: modelId };
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
  return { ok: true };
}

export async function listLoras() {
  await ensureDir(PATHS.loras);
  const files = await readdir(PATHS.loras).catch(() => []);
  return files.filter((f) => f.endsWith('.safetensors')).map((f) => ({
    filename: f,
    name: f.replace(/^lora-/, '').replace(/\.safetensors$/, ''),
    path: join(PATHS.loras, f),
  }));
}
