/**
 * Image Gen — xAI Grok Build CLI provider.
 *
 * Routes image generation through the user's locally-installed `grok` CLI
 * (Grok Build). Grok ships built-in media tools — `image_gen` (text → image)
 * and `image_edit` (source image + instruction → image) — guided by its
 * bundled `imagine` skill, and runs them against the user's logged-in Grok
 * session. No XAI_API_KEY required.
 *
 * Wire format: `grok --output-format plain --permission-mode bypassPermissions
 * --prompt-file /dev/stdin` (built by `ensureGrokHeadlessArgs` in
 * server/lib/grok.js; the /dev/stdin sentinel is rewritten to a temp file on
 * Windows by `prepareGrokPromptFile`). Unlike Codex — which writes to a fixed
 * `~/.codex/generated_images/<session-id>/` dir PortOS has to banner-scrape —
 * grok is a general coding agent that can be *told where to write the file*:
 * the prompt directs it to save the generated PNG to a staging path PortOS
 * chose, and the post-exit handler just reads that file back.
 *
 * The user must explicitly enable this provider in Settings → Image Gen
 * (mirrors the Codex gate — it spends the user's Grok quota). When disabled
 * the dispatcher rejects up front; this module assumes it's enabled by the
 * time generateImage() is called.
 *
 * Containment: grok is a general coding agent and headless runs bypass its
 * approval prompts, so a prompt-injected render could try to reach beyond
 * image generation. Grok exposes no image-tool-only permission mode, so the
 * child is confined the ways we can: it runs with cwd set to a throwaway
 * per-job scratch directory (relative-path tool ops and default file writes
 * land there, and the whole dir is removed on every terminal path), and the
 * staged output is signature-sniffed before it is accepted into the gallery.
 */

import { spawn } from 'child_process';
import { copyFile, mkdir, open, rename, rm, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { atomicWrite, detectImageFormat, ensureDir, PATHS, resolveImageInputPath } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { stripAnsi } from '../../lib/ansiStrip.js';
import { bufferedSpawn, prepareCliSpawn } from '../../lib/bufferedSpawn.js';
import { ensureGrokHeadlessArgs, prepareGrokPromptFile } from '../../lib/grok.js';
import { IMAGE_GEN_MODE, describeFidelity } from './modes.js';

// 20 minutes — grok's image_gen typically returns in well under a minute, but
// the agent turn wrapping it (skill load, tool call, file write) has no
// progress signal to short-circuit on, and a queued/over-subscribed session
// can stall. Env-overridable for power users who want a tighter cap. Keep in
// rough sync with the mediaJobQueue cloud-lane watchdog (WATCHDOG_CODEX_MS)
// so the queue's watchdog and the child's wall-clock cap fire on a similar
// budget.
const GROK_TIMEOUT_MS = (() => {
  const n = Number(process.env.GROK_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000;
})();

const DEFAULT_BIN = 'grok';

// Aspect ratios grok's image_gen/image_edit tools accept. Width/height from
// PortOS callers are mapped to the closest of these; a configured default
// (`imageGen.grok.aspectRatio`) applies when the caller sent no dimensions.
export const GROK_ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);
const RATIO_VALUES = GROK_ASPECT_RATIOS.map((ratio) => {
  const [rw, rh] = ratio.split(':').map(Number);
  return { ratio, value: rw / rh };
});

// Map a width/height pair to the closest supported grok aspect ratio, or null
// when dimensions are absent/invalid (the tool then uses its own default).
export function deriveAspectRatio(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const target = w / h;
  let best = null;
  let bestDelta = Infinity;
  for (const { ratio, value } of RATIO_VALUES) {
    const delta = Math.abs(value - target);
    if (delta < bestDelta) {
      best = ratio;
      bestDelta = delta;
    }
  }
  return best;
}

// Per-job state — keyed by jobId so multiple grok renders can run in parallel
// under the mediaJobQueue's cloud lane. Same client shape as imageGen/codex.js
// so attachSseClient/broadcastSse just work.
const jobs = new Map();
const activeProcs = new Map();
const activeJobs = new Map();

// Returns the most-recently-started job — used by status surfaces and the
// settings test-render; not safe for cancel routing under parallel use.
export const getActiveJob = () => {
  const entries = [...activeJobs.values()];
  return entries.length ? entries[entries.length - 1] : null;
};

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

const sigtermWithEscalation = (id, proc) =>
  killWithEscalation(proc, { label: 'grok child', delayMs: 5000, stillRunning: () => activeProcs.get(id) === proc });

// Cancel one specific grok render. jobId is required — with parallel renders
// an "anonymous cancel" would nuke every in-flight render. Use `cancelAll()`
// for the dispatcher's "stop everything" path.
export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error("grok.cancel requires a jobId — use grok.cancelAll() to terminate every in-flight render");
  }
  const proc = activeProcs.get(jobId);
  if (!proc) return false;
  sigtermWithEscalation(jobId, proc);
  return true;
};

// Bulk terminate every in-flight grok render. Only used by the imageGen
// dispatcher's "cancel everything" route.
export const cancelAll = () => {
  const entries = [...activeProcs.entries()];
  if (entries.length === 0) return false;
  for (const [id, proc] of entries) sigtermWithEscalation(id, proc);
  return true;
};

export async function checkConnection({ grokPath } = {}) {
  // Cheap probe: `grok --version` via the shared bufferedSpawn (never
  // rejects; timeout-kills a hung binary so the settings "Test Connection"
  // can't pend forever). Avoids actually invoking image_gen, which would
  // spend the user's Grok quota.
  const bin = grokPath || DEFAULT_BIN;
  const result = await bufferedSpawn(bin, ['--version'], { timeoutMs: 15_000 });
  if (result.error) {
    return { connected: false, mode: IMAGE_GEN_MODE.GROK, reason: `Grok CLI not found (${result.error})` };
  }
  if (result.timedOut) {
    return { connected: false, mode: IMAGE_GEN_MODE.GROK, reason: 'grok --version timed out' };
  }
  if (result.code !== 0) {
    return { connected: false, mode: IMAGE_GEN_MODE.GROK, reason: `grok --version exited ${result.code}` };
  }
  const versionMatch = `${result.stdout}${result.stderr}`.match(/(\d+\.\d+\.\d+)/);
  return { connected: true, mode: IMAGE_GEN_MODE.GROK, model: versionMatch ? `grok-cli ${versionMatch[1]}` : 'grok-cli' };
}

// Grok narrates its turn on stdout. Turn the tail into the most useful error
// we can when the directed output file never landed — surfacing the model's
// own words (content declines, tool-failure notes) instead of a fixed guess.
const GROK_NO_IMAGE_HINT =
  'Grok returned no image — the image_gen tool may be unavailable on your Grok plan, or the model declined. Check Settings → Image Gen → Enable Grok Imagegen.';
export function noImageReason(stdoutTail = '') {
  const clean = stripAnsi(String(stdoutTail)).trim();
  const lines = clean.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^-{2,}$/.test(l) && !/^[\d,]+$/.test(l));
  const said = lines.slice(-4).join(' ').slice(-600);
  if (!said) return GROK_NO_IMAGE_HINT;
  return `Grok did not produce an image at the directed path. Grok said: "${said}"`;
}

// Build the single-turn agent prompt that triggers image_gen (or image_edit
// for i2i) and directs the output to a PortOS-chosen path. Grok is a general
// coding agent, so the prompt is explicit about the tool, the save path, and
// staying out of everything else.
export function buildGrokPrompt({ prompt, negativePrompt, aspectRatio, stagingPath, initImagePath, initImageStrength }) {
  const avoid = negativePrompt?.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  const ratio = aspectRatio ? `\nUse aspect_ratio "${aspectRatio}".` : '';
  const task = initImagePath
    ? `Use your built-in image_edit tool to transform the source image at ${initImagePath} — ${describeFidelity(initImageStrength)}.\nEdit instruction: ${prompt.trim()}${avoid}`
    : `Use your built-in image_gen tool to generate exactly one image.\nImage prompt: ${prompt.trim()}${avoid}`;
  return `${task}${ratio}\nSave the generated image as a PNG file at exactly this path: ${stagingPath}\nDo not create any other files, do not modify any code, and do not run any other tools beyond what is needed to generate the image and write it to that path. When the file is written, you are done.`;
}

// `initImageStrength` maps to a fidelity phrase (grok's image_edit has no
// numeric denoise knob, same constraint as codex).
export async function generateImage({
  grokPath, aspectRatio, prompt = '', width, height, negativePrompt,
  initImagePath, initImageStrength,
  jobId: providedJobId = null,
  cleanC2PA = false,
  denoise = false,
}) {
  await ensureDir(PATHS.images);

  // Defense-in-depth: re-anchor the init image to the allowed input roots so
  // no caller can point grok's image_edit at an arbitrary local file. Mirrors
  // imageGen/codex.js.
  const validInitImagePath = (initImagePath && typeof initImagePath === 'string')
    ? resolveImageInputPath(initImagePath)
    : null;

  // An empty prompt is fine when editing an init image; a pure text-to-image
  // grok render still needs one.
  if (!validInitImagePath && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);
  // Grok writes into a per-job tmp scratch dir, not straight into the
  // gallery — a failed/partial run must never leave junk where the gallery
  // scanner or a concurrent client can see it, and the dir doubles as the
  // child's cwd (see the containment note in the module header). Every
  // terminal path removes the whole dir.
  const scratchDir = join(tmpdir(), `portos-grok-${jobId}`);
  const stagingPath = join(scratchDir, 'output.png');
  await mkdir(scratchDir, { recursive: true });

  // Caller dimensions win (mapped to the closest supported ratio); the saved
  // per-provider default applies when no dimensions were sent; otherwise the
  // tool's own default. Validate the saved value against the known ratios so
  // a hand-edited settings.json can't inject arbitrary prompt text.
  const derived = deriveAspectRatio(width, height);
  const configured = GROK_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : null;
  const effectiveRatio = derived || configured;

  const fullPrompt = buildGrokPrompt({
    prompt, negativePrompt, aspectRatio: effectiveRatio, stagingPath,
    initImagePath: validInitImagePath, initImageStrength,
  });

  const bin = grokPath || DEFAULT_BIN;
  // No model arg — grok's image tools run on xAI's fixed image backend and
  // the agent model is whatever the local `grok` install defaults to (see
  // server/lib/grok.js: PortOS does not pick a grok model).
  const baseArgs = ensureGrokHeadlessArgs([], null);
  const { args, useStdin, cleanup: cleanupPromptFile } = prepareGrokPromptFile(baseArgs, fullPrompt);

  const meta = {
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: IMAGE_GEN_MODE.GROK,
    ...(effectiveRatio ? { aspectRatio: effectiveRatio } : {}),
    createdAt: new Date().toISOString(),
  };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] grok: ${prompt.slice(0, 60)}…`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1 });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0, currentImage: null });
  broadcastSse(job, { type: 'status', message: 'Spawning grok…' });

  // generateImage returns a job descriptor synchronously; the actual grok
  // child runs out-of-band so the HTTP response can ship while the client
  // attaches to the per-job SSE stream (mirrors codex.js/local.js).
  runGrok(job, jobId, bin, args, {
    useStdin, fullPrompt, cleanupPromptFile, scratchDir, stagingPath, outputPath, filename, meta, cleanC2PA, denoise,
  }).catch((err) => {
    console.log(`❌ grok run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId, filename, path: `/data/images/${filename}`, generationId: jobId,
    mode: IMAGE_GEN_MODE.GROK,
    // Async callers gate UI state on `status`; without 'running' they flip
    // to 'done' before the PNG lands. SSE / socket 'completed' fires later.
    status: 'running',
  };
}

async function runGrok(job, jobId, bin, args, {
  useStdin, fullPrompt, cleanupPromptFile, scratchDir, stagingPath, outputPath, filename, meta, cleanC2PA = false, denoise = false,
}) {
  // prepareCliSpawn resolves the Windows .cmd shim of an npm-installed grok
  // and wraps it for a safe shell:false spawn — a no-op on POSIX.
  const { command: spawnBin, args: spawnArgs } = prepareCliSpawn(bin, args);
  const proc = spawn(spawnBin, spawnArgs, { cwd: scratchDir, shell: false, stdio: [useStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  activeProcs.set(jobId, proc);
  const removeScratch = () => rm(scratchDir, { recursive: true, force: true }).catch(() => {});

  if (useStdin) {
    // POSIX: grok reads the prompt via --prompt-file /dev/stdin. EPIPE fires
    // when the child dies before consuming stdin — the close handler reports
    // the real failure, so just swallow the write error.
    proc.stdin.on('error', () => {});
    proc.stdin.write(fullPrompt);
    proc.stdin.end();
  }

  let stdoutTail = '';
  const STDOUT_TAIL_BYTES = 8 * 1024;
  let stderrTail = '';
  const STDERR_TAIL_BYTES = 32 * 1024;
  const timeoutTimer = setTimeout(() => {
    if (activeProcs.get(jobId) === proc) {
      console.log(`⏱️ grok timed out after ${GROK_TIMEOUT_MS}ms [${jobId.slice(0, 8)}]`);
      sigtermWithEscalation(jobId, proc);
    }
  }, GROK_TIMEOUT_MS);

  proc.on('error', (err) => {
    clearTimeout(timeoutTimer);
    cleanupPromptFile();
    removeScratch();
    finalizeError(job, jobId, proc, `Failed to spawn ${bin}: ${err.message}`);
  });

  proc.stdout.on('data', (chunk) => {
    stdoutTail += chunk.toString();
    if (stdoutTail.length > STDOUT_TAIL_BYTES) stdoutTail = stdoutTail.slice(-STDOUT_TAIL_BYTES);
    broadcastSse(job, { type: 'status', message: 'Running…' });
  });

  proc.stderr.on('data', (chunk) => {
    stderrTail += chunk.toString();
    if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
  });

  proc.on('close', async (code, signal) => {
    clearTimeout(timeoutTimer);
    cleanupPromptFile();
    // EventEmitter doesn't await async listeners — without this try/catch,
    // a throw from the harvest/copy would surface as an unhandled rejection
    // and the job would be stuck in 'running' forever with no SSE error.
    try {
      if (code !== 0) {
        const reason = signal ? `Killed by signal ${signal}` : `Exit code ${code}`;
        const tail = stderrTail.trim().split('\n').slice(-6).join('\n');
        removeScratch();
        return finalizeError(job, jobId, proc, `Grok generation failed: ${reason}\n${tail}`);
      }
      // Grok writes the file during the turn; empirically it's on disk by
      // exit, but poll a few seconds in case of flush lag on slow disks. The
      // harvest signature-sniffs the bytes so a text error, truncated file,
      // or non-image payload is never accepted into the gallery as a PNG.
      const harvested = await harvestStagedImage(stagingPath, 5000);
      if (!harvested.found) {
        removeScratch();
        const prefix = harvested.invalid ? 'Grok wrote a non-image file at the directed path. ' : '';
        return finalizeError(job, jobId, proc, `${prefix}${noImageReason(stdoutTail)}`);
      }
      // Move, not copy — the staging file is PortOS-owned and disposable, so
      // rename is a metadata-only op when tmpdir and the gallery share a
      // filesystem. copyFile+unlink is the cross-device (EXDEV) fallback.
      await rename(stagingPath, outputPath).catch(async () => {
        await copyFile(stagingPath, outputPath);
        await unlink(stagingPath).catch(() => {});
      });
      removeScratch();
      // Sidecar metadata so the gallery can recover prompt/ratio/etc.
      const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
      await atomicWrite(sidecar, meta).catch(() => {});
      // Cleaners run BEFORE the SSE complete + completed events so
      // subscribers see the cleaned bytes.
      await autoCleanGeneratedImage({ cleanC2PA, denoise, pngPath: outputPath, sidecarPath: sidecar, mode: IMAGE_GEN_MODE.GROK });
      job.status = 'complete';
      if (activeProcs.get(jobId) === proc) activeProcs.delete(jobId);
      activeJobs.delete(jobId);
      console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename} (grok)`);
      const result = { filename, path: `/data/images/${filename}` };
      broadcastSse(job, { type: 'complete', result });
      imageGenEvents.emit('completed', { generationId: jobId, path: `/data/images/${filename}`, filename });
      closeJobAfterDelay(jobs, jobId);
    } catch (err) {
      removeScratch();
      finalizeError(job, jobId, proc, `Grok post-exit handler failed: ${err?.message || err}`);
    }
  });
}

// `proc` is the child this finalize belongs to — only clear module-scoped
// state when it still belongs to *this* job (a late finalize from a stale run
// must not wipe a newer active job).
const finalizeError = (job, jobId, proc, reason) => {
  // Idempotent — spawn failures fire 'error' AND a follow-up 'close'.
  if (job.status === 'error' || job.status === 'complete') return;
  if (proc == null || activeProcs.get(jobId) === proc) activeProcs.delete(jobId);
  job.status = 'error';
  activeJobs.delete(jobId);
  console.log(`❌ grok image generation failed [${jobId.slice(0, 8)}]: ${reason.split('\n')[0]}`);
  broadcastSse(job, { type: 'error', error: reason });
  imageGenEvents.emit('failed', { generationId: jobId, error: reason });
  closeJobAfterDelay(jobs, jobId);
};

// Poll for the directed output file until it exists non-empty AND carries a
// real image signature (PNG/JPEG/WebP/GIF via the shared detectImageFormat
// sniffer), or timeoutMs elapses. Returns { found, invalid } — `invalid`
// means a non-empty file appeared whose bytes never matched an image
// signature (grok wrote a text error or other junk), which the caller
// surfaces distinctly from "no file at all".
async function harvestStagedImage(stagingPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawInvalid = false;
  while (Date.now() < deadline) {
    const s = await stat(stagingPath).catch(() => null);
    if (s && s.size > 0) {
      const head = Buffer.alloc(16);
      const fh = await open(stagingPath, 'r').catch(() => null);
      if (fh) {
        const { bytesRead } = await fh.read(head, 0, 16, 0).catch(() => ({ bytesRead: 0 }));
        await fh.close().catch(() => {});
        if (detectImageFormat(head.subarray(0, bytesRead))) return { found: true, invalid: false };
        // Header may still be flushing — keep polling; only report invalid
        // if it never resolves into a real signature before the deadline.
        sawInvalid = true;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { found: false, invalid: sawInvalid };
}

// Test-only handles (mirrors codex.js's carve-out).
export const _internals = {
  harvestStagedImage,
  deriveAspectRatio,
  buildGrokPrompt,
};
