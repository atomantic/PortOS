/**
 * Image Gen — Antigravity (`agy`) CLI provider.
 *
 * Agy is an opt-in cloud CLI backend. Each request runs in a throwaway scratch
 * directory and directs the built-in `generate_image` tool to one PortOS-owned
 * staging path. Only signature-verified image bytes are moved into the gallery.
 *
 * `generate_image` takes input images through its `ImagePaths` parameter — up
 * to 3, usable to "edit, combine, or use as references" — so an init image and
 * the reference slots both reach it. Unlike codex/grok, `Prompt` is a REQUIRED
 * tool parameter, so an image-only agy render is rejected up front.
 */

import { spawn } from '../../lib/childProcess.js';
import { mkdir, open, stat } from 'fs/promises';
import { randomUUID } from 'crypto';
import { isAbsolute, join, resolve as pathResolve, sep } from 'path';
import { tmpdir } from 'os';
import sharp from 'sharp';
import {
  ensureAntigravityPrintArgs,
  isAntigravityModelId,
  parseAntigravityModelList,
  prepareAntigravityPrompt,
} from '../../lib/antigravity.js';
import { bufferedSpawn, killProcessTree, prepareCliSpawn } from '../../lib/bufferedSpawn.js';
import { atomicWrite, copyFileGuarded, detectImageFormat, ensureDir, PATHS, rmGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { renderTimingFields } from '../../lib/renderTiming.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { buildNoImageReason } from './noImageReason.js';
import { rejectDegenerateFrame } from './frameGuard.js';
import { checkFabrication, noFabricationClause } from './fabricationGuard.js';
import {
  AGY_IMAGEGEN_IMAGE_MODEL, IMAGE_GEN_MODE, IMAGE_TOOL_NAMES, describeFidelity,
  nearestAgyAspectRatio, visualReferenceRole,
} from './modes.js';
import { resolveInputImages } from './inputImages.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';

const AGY_TIMEOUT_MS = (() => {
  const n = Number(process.env.AGY_IMAGEGEN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000;
})();
const DEFAULT_BIN = 'agy';
const DEFAULT_HARVEST_TIMEOUT_MS = 5000;
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
      // Shared with the provider-catalog refresh so the two never disagree
      // about what a `models` row looks like — see parseAntigravityModelList.
      const models = parseAntigravityModelList(stdout);
      finish(models.length ? { models, error: null } : { models: [], error: 'agy models returned no model ids' });
    });
  });
}

const AGY_TOOL = IMAGE_TOOL_NAMES[IMAGE_GEN_MODE.AGY];

const AGY_NO_IMAGE_HINT =
  'Agy returned no image — the selected model may not expose generate_image, or the model declined. Check Settings → Image Gen → Agy CLI.';

export const noImageReason = (stdoutTail = '') => buildNoImageReason(stdoutTail, {
  hint: AGY_NO_IMAGE_HINT,
  describe: (said) => `Agy did not produce an image at the directed path. Agy said: "${said}"`,
});

/**
 * Directs agy's `generate_image` at whatever input images the render carries.
 *
 * `ImagePaths` is a real tool parameter — "Optional absolute paths to the images
 * to use in generation. You can pass in images here if you would like to edit,
 * combine, or use as references… you cannot pass in more than 3 images" (schema
 * probed 2026-08-09). The 3-image ceiling is enforced upstream by
 * resolveInputImages, which also fixes the order and splits out the init image
 * — so this takes that resolver's `{ paths, initPath, referencePaths }` shape
 * directly rather than re-deriving "init leads" a second time.
 *
 * Naming the paths on their own line keeps them out of the tool's `Prompt`, for
 * the same reason the AspectRatio directive is separated: anything that lands
 * inside `Prompt` becomes part of what gets drawn.
 */
const agyImagePathsDirective = ({ paths, initPath, referencePaths, initImageStrength }) => {
  if (!paths.length) return '';
  const refCount = referencePaths.length;
  const role = initPath
    ? `The first is the source image to edit — ${describeFidelity(initImageStrength)}.${refCount ? ` The rest are ${visualReferenceRole(refCount)}.` : ''}`
    : `Use ${refCount === 1 ? 'it' : 'them'} as ${visualReferenceRole(refCount)}.`;
  return `\nPass these absolute paths to the tool's ImagePaths parameter, in this order: ${paths.join(', ')}\n${role}`;
};

export function buildAgyPrompt({
  prompt, negativePrompt, width, height, stagingPath,
  inputImages = { paths: [], initPath: null, referencePaths: [] }, initImageStrength,
}) {
  const avoid = negativePrompt?.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  // `AspectRatio` is a real generate_image parameter and it defaults to '1:1'.
  // Naming the pixel dimensions alone is not enough — the agent has to be told
  // which ratio to pass, or every render comes back square regardless of the
  // requested size. Directed on its own line so it reads as an instruction to
  // the agent rather than as image content: anything that lands inside the
  // tool's `Prompt` becomes part of what gets drawn.
  //
  // The exact pixel dimensions are deliberately NOT stated. AspectRatio is the
  // only size knob generate_image exposes (#3231), so a "target dimensions"
  // line is an instruction the tool cannot satisfy — which invites the agent to
  // reach for code that can. It also leaks into the artwork: the render that
  // exposed this failure mode captioned itself "DIMENSIONS: 832 x 1216 (2:3)".
  const ratio = nearestAgyAspectRatio(width, height);
  const aspect = ratio ? `\nPass AspectRatio "${ratio}" to the tool.` : '';
  const images = agyImagePathsDirective({ ...inputImages, initImageStrength });
  return `Use your built-in ${AGY_TOOL} tool to generate exactly one image.
Image prompt: ${prompt.trim()}${avoid}${aspect}${images}
Save the generated image as a PNG file at exactly this path: ${stagingPath}
${noFabricationClause(AGY_TOOL)}
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
  initImageStrength,
  referenceImagePaths = [],
  visualConditioning = null,
  jobId: providedJobId = null,
  cleanC2PA = false,
  denoise = false,
}) {
  // The ingestion instant `renderTimingFields` measures from — the queue calls
  // generateImage the moment it picks this job up. See lib/renderTiming.js.
  const renderStartedAtMs = Date.now();
  // Re-anchors every path to the approved image roots and caps at agy's
  // 3-image ImagePaths ceiling — see inputImages.js.
  const inputImages = resolveInputImages({
    mode: IMAGE_GEN_MODE.AGY, initImagePath, referenceImagePaths,
  });
  // Unlike codex/grok, agy always needs a prompt even with input images:
  // `Prompt` is in generate_image's `required` list, which the provider spec
  // records as `promptRequiredWithInputImage`.
  if (cloudPromptRequired(IMAGE_GEN_MODE.AGY, inputImages.paths.length > 0) && !prompt.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (model && !isAntigravityModelId(model)) {
    throw new ServerError('Invalid Agy model id', { status: 400, code: 'VALIDATION_ERROR' });
  }

  await ensureDir(PATHS.images);
  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  const scratchDir = join(tmpdir(), `portos-agy-${jobId}`);
  const stagingPath = join(scratchDir, 'output.png');
  await mkdir(scratchDir, { recursive: true });

  const fullPrompt = buildAgyPrompt({
    prompt, negativePrompt, width, height, stagingPath, inputImages, initImageStrength,
  });
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
    // The agent/session model above drives the CLI; the image itself always
    // renders on Antigravity's fixed server-side backend — record it so
    // provenance names the model that actually produced the pixels (#3231).
    imageModel: AGY_IMAGEGEN_IMAGE_MODEL,
    ...(visualConditioning ? { visualConditioning } : {}),
    createdAt: new Date().toISOString(),
  };
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
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
  const removeScratch = () => rmGuarded(scratchDir, { recursive: true, force: true }).catch(() => {});
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
      // A PNG landed — but the harvest gate only proves it is image bytes, not
      // that generate_image made them. Reject a file the agent drew itself.
      // The narration tail rides along like every other failure path here: it
      // carries WHY the tool was skipped (the 429 that triggers a fabricated
      // stand-in is only ever stated there), which the quota card then reads.
      const fabricated = await checkFabrication(scratchDir, AGY_TOOL);
      if (fabricated) {
        removeScratch();
        return finalizeError(job, jobId, proc, `${fabricated} ${noImageReason(stdoutTail)}`);
      }
      if (harvested.format === 'png') {
        await copyFileGuarded(stagingPath, outputPath);
        await unlinkGuarded(stagingPath).catch(() => {});
      } else {
        const pngBytes = await sharp(stagingPath).png().toBuffer();
        await atomicWrite(outputPath, pngBytes);
      }
      removeScratch();
      // Degenerate-frame gate (#4173) — before the sidecar, so a decodable but
      // contentless canvas never becomes a gallery record.
      const emptyFrame = await rejectDegenerateFrame(outputPath);
      if (emptyFrame) {
        return finalizeError(job, jobId, proc, emptyFrame);
      }
      const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
      // `job.renderStartedAtMs` is the queue-ingestion instant generateImage
      // captured, so the spread measures the render itself — not the time the
      // job spent queued behind other renders.
      await atomicWrite(sidecar, { ...meta, ...renderTimingFields(job.renderStartedAtMs) }).catch(() => {});
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
      imageGenEvents.emit('completed', { mode: IMAGE_GEN_MODE.AGY, generationId: jobId, path: result.path, filename });
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
  imageGenEvents.emit('failed', { mode: IMAGE_GEN_MODE.AGY, generationId: jobId, error: reason });
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
