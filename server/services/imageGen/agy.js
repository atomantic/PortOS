/**
 * Image Gen — Antigravity (`agy`) CLI provider.
 *
 * Agy is an opt-in, text-to-image-only cloud CLI backend. Each request runs
 * in a throwaway scratch directory and directs the built-in `generate_image`
 * tool to one PortOS-owned staging path. Only signature-verified image bytes
 * are moved into the gallery.
 */

import { spawn } from 'child_process';
import { copyFile, mkdir, open, rename, rm, stat, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { isAbsolute, join, resolve as pathResolve, sep } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import {
  ensureAntigravityPrintArgs,
  prepareAntigravityPrompt,
} from '../../lib/antigravity.js';
import { bufferedSpawn, killProcessTree, prepareCliSpawn } from '../../lib/bufferedSpawn.js';
import { atomicWrite, detectImageFormat, ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { buildNoImageReason } from './noImageReason.js';
import { IMAGE_GEN_MODE } from './modes.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';

const AGY_TIMEOUT_MS = (() => {
  const n = Number(process.env.AGY_IMAGEGEN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000;
})();
const DEFAULT_BIN = 'agy';
const DEFAULT_HARVEST_TIMEOUT_MS = 5000;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
let harvestTimeoutMs = DEFAULT_HARVEST_TIMEOUT_MS;

const jobs = new Map();
const activeProcs = new Map();
const activeJobs = new Map();

export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

const terminate = (jobId, proc) => {
  if (process.platform === 'win32') {
    killProcessTree(proc);
    return;
  }
  killWithEscalation(proc, {
    label: 'agy child',
    delayMs: 5000,
    stillRunning: () => activeProcs.get(jobId) === proc,
  });
};

export const cancel = (jobId) => {
  if (!jobId) throw new Error('agy.cancel requires a jobId — use agy.cancelAll() to terminate every in-flight render');
  const proc = activeProcs.get(jobId);
  if (!proc) return false;
  terminate(jobId, proc);
  return true;
};

export const cancelAll = () => {
  const entries = [...activeProcs.entries()];
  if (!entries.length) return false;
  for (const [jobId, proc] of entries) terminate(jobId, proc);
  return true;
};

export async function checkConnection({ agyPath } = {}) {
  const bin = agyPath || DEFAULT_BIN;
  const prepared = prepareCliSpawn(bin, ['--version']);
  const result = await bufferedSpawn(prepared.command, prepared.args, { timeoutMs: 15_000, shell: false });
  if (result.error) {
    return { connected: false, mode: IMAGE_GEN_MODE.AGY, reason: `Agy CLI not found (${result.error})` };
  }
  if (result.timedOut) {
    return { connected: false, mode: IMAGE_GEN_MODE.AGY, reason: 'agy --version timed out' };
  }
  if (result.code !== 0) {
    return { connected: false, mode: IMAGE_GEN_MODE.AGY, reason: `agy --version exited ${result.code}` };
  }
  const versionMatch = `${result.stdout}${result.stderr}`.match(/(\d+\.\d+\.\d+)/);
  return { connected: true, mode: IMAGE_GEN_MODE.AGY, model: versionMatch ? `agy ${versionMatch[1]}` : 'agy' };
}

// `agy models` waits for stdin EOF before printing its catalog, so this probe
// intentionally owns the child instead of using bufferedSpawn.
export function listModels({ agyPath } = {}) {
  const bin = agyPath || DEFAULT_BIN;
  const { command, args } = prepareCliSpawn(bin, ['models']);
  return new Promise((resolve) => {
    const proc = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killProcessTree(proc);
      finish({ models: [], error: 'agy models timed out' });
    }, 15_000);
    proc.stdin.on('error', () => {});
    proc.stdin.end();
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => finish({ models: [], error: `Failed to run ${bin}: ${err.message}` }));
    proc.on('close', (code) => {
      if (code !== 0) {
        finish({ models: [], error: stderr.trim() || `agy models exited ${code}` });
        return;
      }
      const models = [...new Set(stdout.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => MODEL_ID_RE.test(line)))];
      finish(models.length ? { models, error: null } : { models: [], error: 'agy models returned no model ids' });
    });
  });
}

const AGY_NO_IMAGE_HINT =
  'Agy returned no image — the selected model may not expose generate_image, or the model declined. Check Settings → Image Gen → Agy CLI.';

export const noImageReason = (stdoutTail = '') => buildNoImageReason(stdoutTail, {
  hint: AGY_NO_IMAGE_HINT,
  describe: (said) => `Agy did not produce an image at the directed path. Agy said: "${said}"`,
});

export function buildAgyPrompt({ prompt, negativePrompt, width, height, stagingPath }) {
  const avoid = negativePrompt?.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  const dimensions = Number(width) > 0 && Number(height) > 0
    ? `\nTarget dimensions/aspect: ${Number(width)}×${Number(height)} pixels.`
    : '';
  return `Use your built-in generate_image tool to generate exactly one image.
Image prompt: ${prompt.trim()}${avoid}${dimensions}
Save the generated image as a PNG file at exactly this path: ${stagingPath}
Do not create any other files, do not modify any code or workspace content, and do not run unrelated tools. When the file is written, you are done.`;
}

export async function generateImage({
  agyPath,
  model,
  prompt = '',
  width,
  height,
  negativePrompt,
  initImagePath,
  referenceImagePaths,
  jobId: providedJobId = null,
  cleanC2PA = false,
  denoise = false,
}) {
  if (initImagePath || referenceImagePaths?.length) {
    throw new ServerError('Agy Imagegen supports text-to-image only', {
      status: 400,
      code: 'AGY_IMAGE_EDIT_UNSUPPORTED',
    });
  }
  if (!prompt.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (model && !MODEL_ID_RE.test(model)) {
    throw new ServerError('Invalid Agy model id', { status: 400, code: 'VALIDATION_ERROR' });
  }

  await ensureDir(PATHS.images);
  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  const scratchDir = join(tmpdir(), `portos-agy-${jobId}`);
  const stagingPath = join(scratchDir, 'output.png');
  await mkdir(scratchDir, { recursive: true });

  const fullPrompt = buildAgyPrompt({ prompt, negativePrompt, width, height, stagingPath });
  const baseArgs = ensureAntigravityPrintArgs([], { model });
  const { args } = prepareAntigravityPrompt(baseArgs, fullPrompt);
  const bin = agyPath || DEFAULT_BIN;
  const meta = {
    id: jobId,
    prompt: prompt.trim(),
    negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
    filename,
    mode: IMAGE_GEN_MODE.AGY,
    model: model || null,
    createdAt: new Date().toISOString(),
  };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);
  activeJobs.set(jobId, {
    ...meta,
    generationId: jobId,
    totalSteps: 1,
    step: 0,
    progress: 0,
    currentImage: null,
  });
  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] agy: ${prompt.slice(0, 60)}…`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1 });
  broadcastSse(job, { type: 'status', message: 'Spawning agy…' });

  runAgy(job, jobId, bin, args, {
    scratchDir,
    stagingPath,
    outputPath,
    filename,
    meta,
    cleanC2PA,
    denoise,
  }).catch((err) => {
    console.log(`❌ agy run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId,
    filename,
    path: `/data/images/${filename}`,
    generationId: jobId,
    mode: IMAGE_GEN_MODE.AGY,
    model: model || null,
    status: 'running',
  };
}

async function runAgy(job, jobId, bin, args, {
  scratchDir,
  stagingPath,
  outputPath,
  filename,
  meta,
  cleanC2PA,
  denoise,
}) {
  const resolvedBin = (!isAbsolute(bin) && (bin.includes('/') || bin.includes(sep))) ? pathResolve(bin) : bin;
  const { command, args: spawnArgs } = prepareCliSpawn(resolvedBin, args);
  // Pin PWD to the spawn cwd — see withSpawnCwdEnv (#3193). agy reads
  // process.cwd(), so this is defensive rather than a live fix; it keeps every
  // scratch-dir spawn telling the child one consistent story about where it is.
  const proc = spawn(command, spawnArgs, { cwd: scratchDir, env: withSpawnCwdEnv(process.env, scratchDir), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcs.set(jobId, proc);
  const removeScratch = () => rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  let stdoutTail = '';
  let stderrTail = '';
  const timeoutTimer = setTimeout(() => {
    if (activeProcs.get(jobId) === proc) {
      console.log(`⏱️ agy timed out after ${AGY_TIMEOUT_MS}ms [${jobId.slice(0, 8)}]`);
      terminate(jobId, proc);
    }
  }, AGY_TIMEOUT_MS);

  proc.stdout.on('data', (chunk) => {
    stdoutTail = `${stdoutTail}${chunk}`.slice(-8192);
    broadcastSse(job, { type: 'status', message: 'Running…' });
  });
  proc.stderr.on('data', (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-32768);
  });
  proc.on('error', (err) => {
    clearTimeout(timeoutTimer);
    removeScratch();
    finalizeError(job, jobId, proc, `Failed to spawn ${bin}: ${err.message}`);
  });
  proc.on('close', async (code, signal) => {
    clearTimeout(timeoutTimer);
    try {
      if (code !== 0) {
        removeScratch();
        const reason = signal ? `Killed by signal ${signal}` : `Exit code ${code}`;
        return finalizeError(job, jobId, proc, `Agy generation failed: ${reason}\n${stderrTail.trim().split('\n').slice(-6).join('\n')}`);
      }
      const harvested = await harvestStagedImage(stagingPath, harvestTimeoutMs);
      if (!harvested.found) {
        removeScratch();
        const prefix = harvested.invalid ? 'Agy wrote a non-image file at the directed path. ' : '';
        return finalizeError(job, jobId, proc, `${prefix}${noImageReason(stdoutTail)}`);
      }
      if (harvested.format === 'png') {
        await rename(stagingPath, outputPath).catch(async () => {
          await copyFile(stagingPath, outputPath);
          await unlink(stagingPath).catch(() => {});
        });
      } else {
        await sharp(stagingPath).png().toFile(outputPath);
      }
      removeScratch();
      const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
      await atomicWrite(sidecar, meta).catch(() => {});
      await autoCleanGeneratedImage({
        cleanC2PA,
        denoise,
        pngPath: outputPath,
        sidecarPath: sidecar,
        mode: IMAGE_GEN_MODE.AGY,
      });
      job.status = 'complete';
      if (activeProcs.get(jobId) === proc) activeProcs.delete(jobId);
      activeJobs.delete(jobId);
      console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename} (agy)`);
      const result = { filename, path: `/data/images/${filename}` };
      broadcastSse(job, { type: 'complete', result });
      imageGenEvents.emit('completed', { generationId: jobId, path: result.path, filename });
      closeJobAfterDelay(jobs, jobId);
    } catch (err) {
      removeScratch();
      finalizeError(job, jobId, proc, `Agy post-exit handler failed: ${err?.message || err}`);
    }
  });
}

const finalizeError = (job, jobId, proc, reason) => {
  if (job.status === 'error' || job.status === 'complete') return;
  if (proc == null || activeProcs.get(jobId) === proc) activeProcs.delete(jobId);
  job.status = 'error';
  activeJobs.delete(jobId);
  console.log(`❌ agy image generation failed [${jobId.slice(0, 8)}]: ${reason.split('\n')[0]}`);
  broadcastSse(job, { type: 'error', error: reason });
  imageGenEvents.emit('failed', { generationId: jobId, error: reason });
  closeJobAfterDelay(jobs, jobId);
};

async function harvestStagedImage(stagingPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawInvalid = false;
  while (Date.now() < deadline) {
    const fileStat = await stat(stagingPath).catch(() => null);
    if (fileStat?.size > 0) {
      const head = Buffer.alloc(16);
      const handle = await open(stagingPath, 'r').catch(() => null);
      if (handle) {
        const { bytesRead } = await handle.read(head, 0, 16, 0).catch(() => ({ bytesRead: 0 }));
        await handle.close().catch(() => {});
        const detected = detectImageFormat(head.subarray(0, bytesRead));
        if (detected) return { found: true, invalid: false, format: detected.format };
        sawInvalid = true;
      }
    }
    const remainingMs = Math.max(1, deadline - Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remainingMs)));
  }
  return { found: false, invalid: sawInvalid };
}

export const _internals = {
  harvestStagedImage,
  buildAgyPrompt,
  setHarvestTimeoutForTests: (timeoutMs = DEFAULT_HARVEST_TIMEOUT_MS) => {
    harvestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_HARVEST_TIMEOUT_MS;
  },
};
