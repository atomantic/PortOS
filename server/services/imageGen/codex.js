/**
 * Image Gen — Codex CLI provider.
 *
 * Routes image generation through the user's locally-installed `codex` CLI
 * (https://github.com/openai/codex). Codex's bundled `imagegen` skill runs
 * the built-in `image_gen` tool when the prompt starts with `$imagegen` and
 * uses the user's logged-in Codex session — no OPENAI_API_KEY required.
 *
 * Wire format: `codex exec --skip-git-repo-check --sandbox workspace-write
 * '$imagegen <prompt>'`. Codex prints a `session id: <uuid>` banner on stderr
 * and writes the final PNG to `~/.codex/generated_images/<session-id>/ig_*.png`
 * — there's no machine-readable path on stdout, so we parse the banner and
 * harvest the dir after the child exits.
 *
 * The user must explicitly enable this provider in Settings → Image Gen
 * because not every Codex account has access to the `image_gen` tool. When
 * disabled the dispatcher rejects up front; this module assumes it's enabled
 * by the time generateImage() is called.
 */

import { spawn } from 'child_process';
import { copyFile, readdir, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS, resolveGalleryImage } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { IMAGE_GEN_MODE } from './modes.js';

// 20 minutes — built-in `image_gen` typically returns in 30–90s, but with the
// parallel codex lane several renders share OpenAI throughput and a single
// generation can easily push past 5 minutes (xhigh reasoning, queued model,
// or an over-subscribed batch). Env-overridable for power users who want a
// tighter cap. Bigger than the SD-API timeout because there's no progress
// signal to short-circuit early on. Keep this in rough sync with
// WATCHDOG_CODEX_MS in mediaJobQueue/index.js so the queue's watchdog and
// the child's wall-clock cap fire on a similar budget.
const CODEX_TIMEOUT_MS = (() => {
  const n = Number(process.env.CODEX_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000;
})();

const DEFAULT_BIN = 'codex';

const codexImagesDir = (sessionId) =>
  join(homedir(), '.codex', 'generated_images', sessionId);

// Per-job state — keyed by jobId so multiple codex renders can run in
// parallel under the mediaJobQueue's configurable lane limit. Same client
// shape as imageGen/local.js so attachSseClient/broadcastSse just work.
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

const sigtermWithEscalation = (id, proc) => {
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (activeProcs.get(id) === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log(`⚠️ codex child didn't exit on SIGTERM — escalating to SIGKILL`);
      proc.kill('SIGKILL');
    }
  }, 5000);
};

// Cancel one specific codex render. jobId is required — with parallel codex
// renders an "anonymous cancel" is genuinely destructive (would nuke every
// in-flight render), so callers have to be explicit. Use `cancelAll()` for
// the legacy "stop everything" path that the imageGen.cancel() dispatcher
// wires up.
export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error("codex.cancel requires a jobId — use codex.cancelAll() to terminate every in-flight render");
  }
  const proc = activeProcs.get(jobId);
  if (!proc) return false;
  sigtermWithEscalation(jobId, proc);
  return true;
};

// Bulk terminate every in-flight codex render. Only used by the imageGen
// dispatcher's "cancel everything" route — the per-job mediaJobQueue path
// always passes a specific jobId to `cancel()`.
export const cancelAll = () => {
  const entries = [...activeProcs.entries()];
  if (entries.length === 0) return false;
  for (const [id, proc] of entries) sigtermWithEscalation(id, proc);
  return true;
};

export async function checkConnection({ codexPath } = {}) {
  // Cheap probe: spawn `codex --version`. Avoids actually invoking image_gen
  // (which would consume the user's Codex quota); the settings UI just wants
  // "yes the binary exists and is reachable".
  const bin = codexPath || DEFAULT_BIN;
  const proc = spawn(bin, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (c) => { out += c.toString(); });
  proc.stderr.on('data', (c) => { out += c.toString(); });
  return new Promise((resolve) => {
    proc.on('error', (err) => resolve({ connected: false, mode: IMAGE_GEN_MODE.CODEX, reason: `Codex CLI not found (${err.message})` }));
    proc.on('close', (code) => {
      if (code !== 0) return resolve({ connected: false, mode: IMAGE_GEN_MODE.CODEX, reason: `codex --version exited ${code}` });
      const versionMatch = out.match(/codex-cli\s+([\d.]+)/i) || out.match(/(\d+\.\d+\.\d+)/);
      resolve({ connected: true, mode: IMAGE_GEN_MODE.CODEX, model: versionMatch ? `codex-cli ${versionMatch[1]}` : 'codex-cli' });
    });
  });
}

const SESSION_ID_RE = /^session id:\s*([0-9a-f-]{36})/im;

// Codex CLI exposes no numeric i2i denoise knob, so map the local-runner-style
// strength (0..1, lower = more faithful to the source) onto a phrase the model
// reliably honors inside `$imagegen`. Mirrors PROOF_AS_BASE_DEFAULT_STRENGTH
// (0.25) defaulting toward composition-preserving edits.
const describeFidelity = (strength) => {
  const n = Number.isFinite(strength) ? Math.max(0, Math.min(1, Number(strength))) : 0.25;
  if (n <= 0.2) return 'preserve composition, characters, and layout exactly — only refine detail and resolution';
  if (n <= 0.4) return 'preserve composition and characters while adding rendered detail at higher fidelity';
  if (n <= 0.7) return 'use the attached image as a strong reference while refining art and detail';
  return 'use the attached image as a loose reference; you may reinterpret freely';
};

// When `initImagePath` is set we attach the file via codex CLI's `-i <FILE>`
// flag and reshape the prompt so the `$imagegen` skill feeds the attachment
// to `image_gen` as an input image (gpt-image-2's image-edit mode).
// `initImageStrength` is mapped to a fidelity phrase via describeFidelity —
// codex CLI exposes no numeric denoise knob.
export async function generateImage({
  codexPath, model, prompt, width, height, negativePrompt,
  initImagePath, initImageStrength,
  jobId: providedJobId = null,
  cleanC2PA = false,
  denoise = false,
}) {
  if (!prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  await ensureDir(PATHS.images);

  // Defense-in-depth: HTTP routes already resolve basenames to absolute paths,
  // but re-anchor here so any future caller can't attach an arbitrary local
  // file via the codex CLI's `-i` flag. Mirrors imageGen/local.js.
  const validInitImagePath = (initImagePath && typeof initImagePath === 'string')
    ? resolveGalleryImage(initImagePath)
    : null;

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);

  // Width/height/negative aren't first-class args for Codex's built-in
  // image_gen tool — pass them as natural-language hints inside the prompt.
  // Codex's imagegen skill is prompt-driven; the model decides resolution.
  // gpt-image-2 supports up to 4K output; the "(high quality)" suffix
  // pushes it off its 1024 default toward whatever native size best fits
  // the requested aspect ratio.
  const sizeHint = (width && height) ? ` (${width}x${height})` : '';
  const qualityHint = (width >= 1536 || height >= 1536) ? ' (high quality)' : '';
  const avoidHint = negativePrompt?.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  const editPrefix = validInitImagePath
    ? `Edit the attached reference image — ${describeFidelity(initImageStrength)}. Render target:\n`
    : '';
  const fullPrompt = `$imagegen ${editPrefix}${prompt.trim()}${sizeHint}${qualityHint}${avoidHint}`;

  const bin = codexPath || DEFAULT_BIN;
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    ...(validInitImagePath ? ['-i', validInitImagePath] : []),
    ...(model ? ['-m', String(model)] : []),
    fullPrompt,
  ];

  const meta = {
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: IMAGE_GEN_MODE.CODEX, model: model || 'codex',
    createdAt: new Date().toISOString(),
  };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] codex: ${prompt.slice(0, 60)}…`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1 });
  activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0, currentImage: null });
  broadcastSse(job, { type: 'status', message: 'Spawning codex…' });

  // generateImage returns a job descriptor synchronously; the actual codex
  // child runs out-of-band so the HTTP response can ship while the client
  // attaches to the per-job SSE stream (mirrors local.js).
  runCodex(job, jobId, bin, args, outputPath, filename, meta, { cleanC2PA, denoise }).catch((err) => {
    console.log(`❌ codex run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId, filename, path: `/data/images/${filename}`, generationId: jobId,
    mode: IMAGE_GEN_MODE.CODEX, model: model || null,
    // Async callers gate UI state on `status`; without 'running' they flip
    // to 'done' before the PNG lands. SSE / socket 'completed' fires later.
    status: 'running',
  };
}

async function runCodex(job, jobId, bin, args, outputPath, filename, meta, { cleanC2PA = false, denoise = false } = {}) {
  const proc = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcs.set(jobId, proc);

  let sessionId = null;
  let stderrTail = '';
  const STDERR_TAIL_BYTES = 32 * 1024;
  let timeoutTimer = setTimeout(() => {
    if (activeProcs.get(jobId) === proc) {
      console.log(`⏱️ codex timed out after ${CODEX_TIMEOUT_MS}ms [${jobId.slice(0, 8)}]`);
      proc.kill('SIGTERM');
      setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 5000);
    }
  }, CODEX_TIMEOUT_MS);

  // Banner is roughly 12 lines / ~500 bytes — keep a small rolling
  // buffer so a session-id line that gets split across chunk boundaries
  // (Node streams can land each pipe write as its own 'data' event)
  // still matches. Trim aggressively after a match to keep this tiny.
  //
  // Why: match BEFORE slicing. With long pipeline prompts (multi-KB
  // comic-script payloads), codex emits the banner + the echoed prompt
  // in a single stderr chunk that can exceed BANNER_BUF_MAX. If we
  // sliced first, the `session id:` line at the FRONT would get chopped
  // off before we ever ran the regex, producing the
  // "Codex returned no session id" false negative.
  let bannerBuf = '';
  const BANNER_BUF_MAX = 4 * 1024;
  const captureSession = (text) => {
    if (sessionId) return;
    bannerBuf += text;
    const m = bannerBuf.match(SESSION_ID_RE);
    if (m) {
      sessionId = m[1];
      bannerBuf = '';
      broadcastSse(job, { type: 'status', message: `Codex session ${sessionId.slice(0, 8)}…` });
      return;
    }
    if (bannerBuf.length > BANNER_BUF_MAX) bannerBuf = bannerBuf.slice(-BANNER_BUF_MAX);
  };

  proc.on('error', (err) => {
    clearTimeout(timeoutTimer);
    finalizeError(job, jobId, proc, `Failed to spawn ${bin}: ${err.message}`);
  });

  proc.stdout.on('data', () => {
    // Codex prints the `session id:` banner on stderr only — don't feed
    // stdout into bannerBuf. A stdout chunk arriving between two stderr
    // chunks of the banner can split the session-id line with unrelated
    // text and break the regex match.
    broadcastSse(job, { type: 'status', message: 'Running…' });
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    captureSession(text);
    stderrTail += text;
    if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
  });

  proc.on('close', async (code, signal) => {
    clearTimeout(timeoutTimer);
    // Don't clear activeProcess yet — the post-exit handler still does
    // async work (harvest + copyFile + sidecar). Clearing the
    // module-scoped guard up front would let a new generation start
    // while we're still finalizing this one, then the in-flight
    // finalizer could clobber the new job's activeJob snapshot.
    // EventEmitter doesn't await async listeners — without this try/catch,
    // a throw from harvestLatestImage / copyFile would surface as an
    // unhandled rejection (process-killing on Node ≥15) and the job would
    // be stuck in 'running' forever with no SSE error to the client.
    try {
      if (code !== 0) {
        const reason = signal ? `Killed by signal ${signal}` : `Exit code ${code}`;
        const tail = stderrTail.trim().split('\n').slice(-6).join('\n');
        return finalizeError(job, jobId, proc, `Codex generation failed: ${reason}\n${tail}`);
      }
      if (!sessionId) {
        return finalizeError(job, jobId, proc, 'Codex returned no session id — output format may have changed');
      }
      // Codex writes the PNG asynchronously while it's wrapping up the turn.
      // Empirically the file is on disk by the time `codex exec` exits, but
      // poll for a few seconds in case there's a flush lag on slow disks.
      const harvested = await harvestLatestImage(sessionId, 5000);
      if (!harvested) {
        return finalizeError(
          job, jobId, proc,
          'Codex returned no image — your Codex account may not allow image_gen, or the model declined. Check Settings → Image Gen → Enable Codex Imagegen.',
        );
      }
      await copyFile(harvested, outputPath);
      // Sidecar metadata so the gallery can recover prompt/seed/etc. The
      // codex sessionId is the closest analogue to a seed for gpt-image-2
      // (which doesn't expose one) — uniquely identifies the run and is
      // useful for traceability even though it doesn't reproduce the output.
      const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
      await writeFile(sidecar, JSON.stringify({ ...meta, codexSessionId: sessionId }, null, 2)).catch(() => {});
      // Cleaners run BEFORE the SSE complete + completed events so subscribers
      // see the cleaned bytes. codex output is the highest-value target for
      // C2PA stripping because gpt-image is the one provider that embeds
      // provenance metadata.
      await autoCleanGeneratedImage({ cleanC2PA, denoise, pngPath: outputPath, sidecarPath: sidecar, mode: IMAGE_GEN_MODE.CODEX });
      job.status = 'complete';
      if (activeProcs.get(jobId) === proc) activeProcs.delete(jobId);
      activeJobs.delete(jobId);
      console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename} (codex)`);
      const result = { filename, path: `/data/images/${filename}` };
      broadcastSse(job, { type: 'complete', result });
      imageGenEvents.emit('completed', { generationId: jobId, path: `/data/images/${filename}`, filename });
      closeJobAfterDelay(jobs, jobId);
    } catch (err) {
      finalizeError(job, jobId, proc, `Codex post-exit handler failed: ${err?.message || err}`);
    }
  });
}

// `proc` is the child this finalize belongs to — pass it through so we
// only clear module-scoped state when it still belongs to *this* job.
// A late finalize from a cancelled or stale run must not wipe a newer
// job that has already become active.
const finalizeError = (job, jobId, proc, reason) => {
  // Idempotent — spawn failures fire 'error' AND a follow-up 'close', so
  // both paths reach finalizeError. Without this guard, listeners would
  // see duplicate 'failed' events.
  if (job.status === 'error' || job.status === 'complete') return;
  if (proc == null || activeProcs.get(jobId) === proc) activeProcs.delete(jobId);
  job.status = 'error';
  activeJobs.delete(jobId);
  console.log(`❌ codex image generation failed [${jobId.slice(0, 8)}]: ${reason.split('\n')[0]}`);
  broadcastSse(job, { type: 'error', error: reason });
  imageGenEvents.emit('failed', { generationId: jobId, error: reason });
  closeJobAfterDelay(jobs, jobId);
};

// Returns the absolute path to the newest ig_*.png in the session dir, or
// null if none appears within `timeoutMs`. Polls every 250ms — the file
// usually lands in <1s but the rare slow case is fine.
async function harvestLatestImage(sessionId, timeoutMs) {
  const dir = codexImagesDir(sessionId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(dir)) {
      const names = await readdir(dir).catch(() => []);
      const pngs = names.filter((f) => f.startsWith('ig_') && f.endsWith('.png'));
      if (pngs.length) {
        const stats = await Promise.all(pngs.map(async (n) => {
          const s = await stat(join(dir, n)).catch(() => null);
          return s ? { n, mtimeMs: s.mtimeMs } : null;
        }));
        const latest = stats.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
        if (latest) return join(dir, latest.n);
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// Tiny helper for unit tests — overrides the homedir lookup so tests can
// point at a tmpdir-rooted ~/.codex without touching the real one. Not used
// in production. The function below intentionally keeps state inside this
// module because the test path is an explicit ergonomic carve-out.
export const _internals = {
  codexImagesDir,
  SESSION_ID_RE,
  harvestLatestImage,
};
