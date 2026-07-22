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
 * and usually writes the final PNG to
 * `~/.codex/generated_images/<session-id>/ig_*.png`. Newer Codex builds can
 * keep the image bytes only in the session JSONL's `image_generation_end`
 * event, so we parse the banner and harvest both locations after the child
 * exits.
 *
 * The user must explicitly enable this provider in Settings → Image Gen
 * because not every Codex account has access to the `image_gen` tool. When
 * disabled the dispatcher rejects up front; this module assumes it's enabled
 * by the time generateImage() is called.
 */

import { spawn } from 'child_process';
import { copyFile, readFile, readdir, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { atomicWrite, ensureDir, PATHS, resolveImageInputPath } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { buildCodexStartupArgs, buildEffortArgs, CODEX_EFFORT_LEVELS } from '../../lib/providerModels.js';
import { IMAGE_GEN_MODE, CODEX_IMAGEGEN_DEFAULT_MODEL, CODEX_IMAGEGEN_DEFAULT_EFFORT, describeFidelity } from './modes.js';
import { buildNoImageReason } from './noImageReason.js';

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
const codexSessionsDir = () => join(homedir(), '.codex', 'sessions');

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

const sigtermWithEscalation = (id, proc) =>
  killWithEscalation(proc, { label: 'codex child', delayMs: 5000, stillRunning: () => activeProcs.get(id) === proc });

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


// When `initImagePath` is set we attach the file via codex CLI's `-i <FILE>`
// flag and reshape the prompt so the `$imagegen` skill feeds the attachment
// to `image_gen` as an input image (gpt-image-2's image-edit mode).
// `initImageStrength` is mapped to a fidelity phrase via describeFidelity —
// codex CLI exposes no numeric denoise knob.
export async function generateImage({
  codexPath, model, effort, prompt = '', width, height, negativePrompt,
  initImagePath, initImageStrength,
  jobId: providedJobId = null,
  cleanC2PA = false,
  denoise = false,
}) {
  await ensureDir(PATHS.images);

  // Ship the cheap gpt-5.6-luna / low-effort path by default (see modes.js).
  // A caller-supplied model/effort (an explicit Settings → Image Gen override,
  // threaded through the dispatcher) wins; `null`/`''`/absent falls back to the
  // shipped default so a bare install never runs Codex's heaviest tier.
  const effectiveModel = (typeof model === 'string' && model.trim()) ? model.trim() : CODEX_IMAGEGEN_DEFAULT_MODEL;
  // Validate the effort against the known codex levels before use: an
  // unrecognized non-empty value (a hand-edited settings.json / the unvalidated
  // settings PUT) would otherwise pass through, buildEffortArgs would emit no
  // override for it, and the child would silently inherit Codex's own configured
  // effort instead of the promised cheap `low` default. Fall back to the default
  // so the low-effort guarantee holds even for garbage input.
  const requestedEffort = (typeof effort === 'string' && effort.trim()) ? effort.trim() : CODEX_IMAGEGEN_DEFAULT_EFFORT;
  const effectiveEffort = CODEX_EFFORT_LEVELS.includes(requestedEffort) ? requestedEffort : CODEX_IMAGEGEN_DEFAULT_EFFORT;

  // Defense-in-depth: HTTP routes already resolve basenames to absolute paths,
  // but re-anchor here so any future caller can't attach an arbitrary local
  // file via the codex CLI's `-i` flag. Mirrors imageGen/local.js — accepts
  // the gallery, the image-refs upload dir (where init uploads are staged), and
  // shipped visual templates.
  const validInitImagePath = (initImagePath && typeof initImagePath === 'string')
    ? resolveImageInputPath(initImagePath)
    : null;

  // An empty prompt is fine when editing an init image (the attached image is
  // the instruction); a pure text-to-image codex render still needs a prompt.
  if (!validInitImagePath && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

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
  // `codex exec` treats `-i, --image <FILE>...` as VARIADIC, so it greedily
  // swallows every following positional — including the prompt — when no other
  // flag interrupts it. That left codex with no positional prompt; it then read
  // stdin (ignored here) and died with "No prompt provided". A `--` terminator
  // after the options bounds the variadic so the prompt lands as the positional.
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox', 'workspace-write',
    // Disable codex's startup update check (see buildCodexStartupArgs) so an
    // image-gen call never spends startup time on the update-check round-trip
    // or an unattended `brew upgrade`. Placed before the variadic `-i` so it
    // can't be swallowed as an image path.
    ...buildCodexStartupArgs(),
    // Reasoning-effort override (`-c model_reasoning_effort=<level>`), defaulting
    // to `low` — also before the variadic `-i`. A user who baked an effort pin
    // into their config is respected via hasEffortFlag inside buildEffortArgs.
    ...buildEffortArgs(effectiveEffort, { command: 'codex' }),
    ...(validInitImagePath ? ['-i', validInitImagePath] : []),
    '-m', effectiveModel,
    ...(validInitImagePath ? ['--'] : []),
    fullPrompt,
  ];

  const meta = {
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: IMAGE_GEN_MODE.CODEX, model: effectiveModel,
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
    mode: IMAGE_GEN_MODE.CODEX, model: effectiveModel,
    // Async callers gate UI state on `status`; without 'running' they flip
    // to 'done' before the PNG lands. SSE / socket 'completed' fires later.
    status: 'running',
  };
}

// Codex exited 0 with a session id but wrote no PNG. Turn its stdout narration
// into the most useful error we can — surfacing the model's own words (#imagegen
// declines, content refusals, "generated" claims with no file) instead of a
// fixed guess. The legacy account/enablement hint is kept as a fallback when
// codex said nothing usable. The line walk itself lives in the shared
// `buildNoImageReason` so the codex and grok narrations cannot drift.
const CODEX_NO_IMAGE_HINT =
  'Codex returned no image — your Codex account may not allow image_gen, or the model declined. Check Settings → Image Gen → Enable Codex Imagegen.';
export const noImageReason = (stdoutTail = '') => buildNoImageReason(stdoutTail, {
  hint: CODEX_NO_IMAGE_HINT,
  // Codex's own structural labels, on top of the shared dashed-rule /
  // bare-token-count filter.
  dropLine: (l) => /^(codex|user)$/i.test(l) || /^tokens used\b/i.test(l),
  describe: (said) => (
    // Codex claims success but no file landed → the image tool wasn't actually
    // run (image-gen unavailable / rate-limited on the account), even though the
    // turn narrated a generation. Call that out specifically.
    /\b(generated|created|here(?:'|’)s|i(?:'|’)ve (?:made|generated))\b/i.test(said)
      ? `Codex reported success but wrote no image file — the built-in image tool likely didn't run (image generation may be unavailable or rate-limited on your account, even though the feature is enabled). Codex said: "${said}"`
      : `Codex did not produce an image. Codex said: "${said}"`
  ),
});

async function runCodex(job, jobId, bin, args, outputPath, filename, meta, { cleanC2PA = false, denoise = false } = {}) {
  const proc = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  activeProcs.set(jobId, proc);

  let sessionId = null;
  let stderrTail = '';
  const STDERR_TAIL_BYTES = 32 * 1024;
  // Codex narrates its turn (incl. "I can't create that…" content declines and
  // any tool-failure notes) on STDOUT. Keep a rolling tail so a no-image finish
  // can surface the model's actual words instead of a generic "no image" guess.
  let stdoutTail = '';
  const STDOUT_TAIL_BYTES = 8 * 1024;
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

  proc.stdout.on('data', (chunk) => {
    // Codex prints the `session id:` banner on stderr only — don't feed
    // stdout into bannerBuf. A stdout chunk arriving between two stderr
    // chunks of the banner can split the session-id line with unrelated
    // text and break the regex match.
    // We DO retain stdout here (the model's turn narration) so a no-image
    // finish can report why — a content decline, or a "generated" claim with
    // no file (tool unavailable / image-gen rate-limited on the account).
    stdoutTail += chunk.toString();
    if (stdoutTail.length > STDOUT_TAIL_BYTES) stdoutTail = stdoutTail.slice(-STDOUT_TAIL_BYTES);
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
      const harvested = await harvestGeneratedImage(sessionId, 5000);
      if (!harvested) {
        return finalizeError(job, jobId, proc, noImageReason(stdoutTail));
      }
      if (harvested.path) {
        await copyFile(harvested.path, outputPath);
      } else {
        await writeFile(outputPath, harvested.buffer);
      }
      // Sidecar metadata so the gallery can recover prompt/seed/etc. The
      // codex sessionId is the closest analogue to a seed for gpt-image-2
      // (which doesn't expose one) — uniquely identifies the run and is
      // useful for traceability even though it doesn't reproduce the output.
      const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
      await atomicWrite(sidecar, { ...meta, codexSessionId: sessionId }).catch(() => {});
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
async function latestGeneratedImageFile(sessionId) {
  const dir = codexImagesDir(sessionId);
  if (!existsSync(dir)) return null;
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
  return null;
}

async function harvestLatestImage(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await latestGeneratedImageFile(sessionId);
    if (latest) return latest;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const isPngBuffer = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
};

async function findSessionLogFile(sessionId) {
  const root = codexSessionsDir();
  if (!existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(sessionId)) {
        return full;
      }
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return null;
}

async function harvestSessionLogImage(sessionId) {
  const logPath = await findSessionLogFile(sessionId);
  if (!logPath) return null;
  const text = await readFile(logPath, 'utf8').catch(() => '');
  let latest = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const payload = record?.payload;
      if (payload?.type !== 'image_generation_end' || typeof payload.result !== 'string') continue;
      const raw = payload.result.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
      const buffer = Buffer.from(raw, 'base64');
      if (isPngBuffer(buffer)) latest = { buffer, path: logPath, callId: payload.call_id || null };
    } catch {
      // Session JSONL can contain arbitrarily large model payloads; ignore
      // malformed/truncated lines and keep scanning for a valid image event.
    }
  }
  return latest;
}

async function harvestGeneratedImage(sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const path = await latestGeneratedImageFile(sessionId);
    if (path) return { path };

    // Newer Codex builds may persist image bytes only in the session JSONL as
    // image_generation_end.result (base64), without materializing
    // ~/.codex/generated_images/<session-id>/ig_*.png. Decode that fallback so
    // a real generation does not get reported as "success but no file".
    const sessionImage = await harvestSessionLogImage(sessionId);
    if (sessionImage) return { buffer: sessionImage.buffer, sessionLogPath: sessionImage.path };

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
  codexSessionsDir,
  SESSION_ID_RE,
  harvestLatestImage,
  harvestSessionLogImage,
  harvestGeneratedImage,
};
