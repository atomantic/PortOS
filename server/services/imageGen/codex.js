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
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';

// 5 minutes — built-in `image_gen` typically returns in 30–90s, but xhigh
// reasoning + a queued model can run longer. Bigger than the SD-API timeout
// because we have no progress signal to short-circuit early on.
const CODEX_TIMEOUT_MS = 5 * 60 * 1000;

const DEFAULT_BIN = 'codex';

const codexImagesDir = (sessionId) =>
  join(homedir(), '.codex', 'generated_images', sessionId);

// Per-job clients: jobId -> { clients, status, lastPayload, ... }. Same
// shape as imageGen/local.js so attachSseClient/broadcastSse just work.
const jobs = new Map();
let activeProcess = null;
let activeJob = null;

export const getActiveJob = () => activeJob;

export const attachSseClient = (jobId, res) => attachSse(jobs, jobId, res);

export const cancel = () => {
  if (!activeProcess) return false;
  const proc = activeProcess;
  proc.kill('SIGTERM');
  setTimeout(() => {
    if (activeProcess === proc && proc.exitCode === null && proc.signalCode === null) {
      console.log(`⚠️ codex child didn't exit on SIGTERM — escalating to SIGKILL`);
      proc.kill('SIGKILL');
    }
  }, 5000);
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
    proc.on('error', (err) => resolve({ connected: false, mode: 'codex', reason: `Codex CLI not found (${err.message})` }));
    proc.on('close', (code) => {
      if (code !== 0) return resolve({ connected: false, mode: 'codex', reason: `codex --version exited ${code}` });
      const versionMatch = out.match(/codex-cli\s+([\d.]+)/i) || out.match(/(\d+\.\d+\.\d+)/);
      resolve({ connected: true, mode: 'codex', model: versionMatch ? `codex-cli ${versionMatch[1]}` : 'codex-cli' });
    });
  });
}

const SESSION_ID_RE = /^session id:\s*([0-9a-f-]{36})/im;

export async function generateImage({ codexPath, model, prompt, width, height, negativePrompt }) {
  if (!prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }
  if (activeProcess) {
    throw new ServerError('A Codex generation is already in progress — cancel it before starting another', { status: 409, code: 'IMAGE_GEN_BUSY' });
  }

  await ensureDir(PATHS.images);

  const jobId = randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);

  // Width/height/negative aren't first-class args for Codex's built-in
  // image_gen tool — pass them as natural-language hints inside the prompt.
  // Codex's imagegen skill is prompt-driven; the model decides resolution.
  const sizeHint = (width && height) ? ` (${width}x${height})` : '';
  const avoidHint = negativePrompt?.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  const fullPrompt = `$imagegen ${prompt.trim()}${sizeHint}${avoidHint}`;

  const bin = codexPath || DEFAULT_BIN;
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    ...(model ? ['-m', String(model)] : []),
    fullPrompt,
  ];

  const meta = {
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: 'codex', model: model || null,
    createdAt: new Date().toISOString(),
  };
  const job = { ...meta, clients: [], status: 'running' };
  jobs.set(jobId, job);

  console.log(`🎨 Generating image [${jobId.slice(0, 8)}] codex: ${prompt.slice(0, 60)}…`);
  imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1 });
  activeJob = { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0, currentImage: null };
  broadcastSse(job, { type: 'status', message: 'Spawning codex…' });

  // generateImage returns a job descriptor synchronously; the actual codex
  // child runs out-of-band so the HTTP response can ship while the client
  // attaches to the per-job SSE stream (mirrors local.js).
  runCodex(job, jobId, bin, args, outputPath, filename, meta).catch((err) => {
    console.log(`❌ codex run failed [${jobId.slice(0, 8)}]: ${err?.message}`);
  });

  return {
    jobId, filename, path: `/data/images/${filename}`, generationId: jobId,
    mode: 'codex', model: model || null,
  };
}

async function runCodex(job, jobId, bin, args, outputPath, filename, meta) {
  const proc = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcess = proc;

  let sessionId = null;
  let stderrTail = '';
  const STDERR_TAIL_BYTES = 32 * 1024;
  let timeoutTimer = setTimeout(() => {
    if (activeProcess === proc) {
      console.log(`⏱️ codex timed out after ${CODEX_TIMEOUT_MS}ms [${jobId.slice(0, 8)}]`);
      proc.kill('SIGTERM');
      setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL'); }, 5000);
    }
  }, CODEX_TIMEOUT_MS);

  const captureSession = (text) => {
    if (sessionId) return;
    const m = text.match(SESSION_ID_RE);
    if (m) {
      sessionId = m[1];
      broadcastSse(job, { type: 'status', message: `Codex session ${sessionId.slice(0, 8)}…` });
    }
  };

  proc.on('error', (err) => {
    clearTimeout(timeoutTimer);
    finalizeError(job, jobId, `Failed to spawn ${bin}: ${err.message}`);
  });

  proc.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    captureSession(text);
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
    activeProcess = null;
    if (code !== 0) {
      const reason = signal ? `Killed by signal ${signal}` : `Exit code ${code}`;
      const tail = stderrTail.trim().split('\n').slice(-6).join('\n');
      return finalizeError(job, jobId, `Codex generation failed: ${reason}\n${tail}`);
    }
    if (!sessionId) {
      return finalizeError(job, jobId, 'Codex returned no session id — output format may have changed');
    }
    // Codex writes the PNG asynchronously while it's wrapping up the turn.
    // Empirically the file is on disk by the time `codex exec` exits, but
    // poll for a few seconds in case there's a flush lag on slow disks.
    const harvested = await harvestLatestImage(sessionId, 5000);
    if (!harvested) {
      return finalizeError(
        job, jobId,
        'Codex returned no image — your Codex account may not allow image_gen, or the model declined. Check Settings → Image Gen → Enable Codex Imagegen.',
      );
    }
    await copyFile(harvested, outputPath);
    // Sidecar metadata so the gallery can recover prompt/seed/etc.
    const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
    await writeFile(sidecar, JSON.stringify(meta, null, 2)).catch(() => {});
    job.status = 'complete';
    activeJob = null;
    console.log(`✅ Image generated [${jobId.slice(0, 8)}]: ${filename} (codex)`);
    const result = { filename, path: `/data/images/${filename}` };
    broadcastSse(job, { type: 'complete', result });
    imageGenEvents.emit('completed', { generationId: jobId, path: `/data/images/${filename}`, filename });
    closeJobAfterDelay(jobs, jobId);
  });
}

const finalizeError = (job, jobId, reason) => {
  job.status = 'error';
  activeJob = null;
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
