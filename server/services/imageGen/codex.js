import { createMediaJobPreparation } from '../../lib/mediaJobPreparation.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';
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
 * `~/.codex/generated_images/<session-id>/*.png` (`ig_*.png` historically;
 * newer builds use `exec-*.png`). Other Codex builds can keep the image bytes
 * only in the session JSONL's `image_generation_end` event, so we parse the
 * banner and harvest both locations after the child exits.
 *
 * The user must explicitly enable this provider in Settings → Image Gen
 * because not every Codex account has access to the `image_gen` tool. When
 * disabled the dispatcher rejects up front; this module assumes it's enabled
 * by the time generateImage() is called.
 *
 * Each child runs in an owned temporary workspace. Only the Codex generated
 * image directory and image-generation session events are harvested; scratch
 * drawings are never accepted. Missing tool events do not prove an account
 * lacks image generation, so diagnostics distinguish observation from capability.
 */

import { spawn } from '../../lib/childProcess.js';
import { bufferedSpawn, prepareCliSpawn, killProcessTree } from '../../lib/bufferedSpawn.js';
import { readFile, readdir, stat, mkdtemp } from 'fs/promises';
import { existsSync } from 'fs';
import { basename, join, isAbsolute, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { codexHomeDir } from '../../lib/codexUserConfig.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { noFabricationClause } from './fabricationGuard.js';
import { randomUUID } from 'crypto';
import { atomicWrite, copyFileGuarded, ensureDir, PATHS, sleep, unlinkGuarded, rmGuarded } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { autoCleanGeneratedImage } from '../../lib/imageClean.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay, createJobFailureFinalizer, dispatchTerminalEvent } from '../../lib/sseUtils.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { renderTimingFields } from '../../lib/renderTiming.js';
import { buildCodexStartupArgs, buildEffortArgs, resolveCliEffort } from '../../lib/providerModels.js';
import {
  IMAGE_GEN_MODE, CODEX_IMAGEGEN_DEFAULT_MODEL, CODEX_IMAGEGEN_DEFAULT_EFFORT,
  describeFidelity, visualReferenceRole,
} from './modes.js';
import { buildNoImageReason } from './noImageReason.js';
import { rejectDegenerateFrame } from './frameGuard.js';
import { conformImageAspect } from './aspectConform.js';
import { aspectRatioPhrase } from '../../lib/aspectRatio.js';
import { resolveInputImages } from './inputImages.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { agentInstructionsAddition, carriedPromptAdditions, sentPromptRecord } from '../../lib/modelInput.js';

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
const DEFAULT_HARVEST_TIMEOUT_MS = 5000;
let harvestTimeoutMs = DEFAULT_HARVEST_TIMEOUT_MS;

const codexImagesDir = (sessionId) =>
  join(codexHomeDir(), 'generated_images', sessionId);
const codexSessionsDir = () => join(codexHomeDir(), 'sessions');

// Cache evidence only changes PortOS's default, never an explicit selection.
async function resolveCodexDriverModel(model, modelIsShippedDefault) {
  const explicit = typeof model === 'string' && model.trim();
  if (explicit && !modelIsShippedDefault) return explicit;
  const preferred = CODEX_IMAGEGEN_DEFAULT_MODEL;
  let listed;
  try {
    const path = join(codexHomeDir(), 'models_cache.json');
    if ((await stat(path)).size > 2 * 1024 * 1024) return preferred;
    const cache = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(cache.models)) return preferred;
    listed = new Set(cache.models.filter(item => item?.visibility === 'list' && typeof item.slug === 'string').map(item => item.slug));
  } catch { /* Missing or unreadable cache provides no model availability evidence. */ }
  if (!listed?.size || listed.has(preferred)) return preferred;
  const fallback = ['gpt-5.6-luna', 'gpt-5.6-terra'].find(id => listed.has(id));
  if (fallback) {
    console.log(`🔀 Codex image default ${preferred} is not listed in the local model cache; using ${fallback}`);
    return fallback;
  }
  throw new ServerError('The local Codex model cache lists no supported low-cost image-generation driver default. Select an available model explicitly in Settings → Image Gen.', { status: 400 });
}

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
  if (process.platform === 'win32') {
    // The cmd.exe wrapper owns a Codex descendant: terminate the whole tree.
    killProcessTree(proc);
    return;
  }
  killWithEscalation(proc, { label: 'codex child', delayMs: 5000, stillRunning: () => activeProcs.get(id) === proc });
};

// Cancel one specific codex render. jobId is required — with parallel codex
// renders an "anonymous cancel" is genuinely destructive (would nuke every
// in-flight render), so callers have to be explicit. Use `cancelAll()` for
// the legacy "stop everything" path that the imageGen.cancel() dispatcher
// wires up.
const preparations = createMediaJobPreparation();

export const cancel = (jobId) => {
  if (!jobId) {
    throw new Error("codex.cancel requires a jobId — use codex.cancelAll() to terminate every in-flight render");
  }
  const pending = preparations.cancel(jobId);
  if (pending) return pending;
  const proc = activeProcs.get(jobId);
  if (!proc) return false;
  sigtermWithEscalation(jobId, proc);
  return true;
};

// Bulk terminate every in-flight codex render. Only used by the imageGen
// dispatcher's "cancel everything" route — the per-job mediaJobQueue path
// always passes a specific jobId to `cancel()`.
export const cancelAll = () => {
  const ids = [...preparations.ids(), ...activeProcs.keys()];
  if (ids.length === 0) return false;
  for (const id of ids) cancel(id);
  return true;
};

export async function checkConnection({ codexPath } = {}) {
  // Cheap probe: spawn `codex --version`. Avoids actually invoking image_gen
  // (which would consume the user's Codex quota); the settings UI just wants
  // "yes the binary exists and is reachable".
  const bin = codexPath || DEFAULT_BIN;
  const prepared = prepareCliSpawn(bin, ['--version']);
  const result = await bufferedSpawn(prepared.command, prepared.args, { timeoutMs: 15_000, shell: false });
  if (result.error) {
    return { connected: false, mode: IMAGE_GEN_MODE.CODEX, reason: `Codex CLI not found (${result.error.message})` };
  }
  if (result.timedOut) {
    return { connected: false, mode: IMAGE_GEN_MODE.CODEX, reason: 'codex --version timed out' };
  }
  if (result.code !== 0) {
    return { connected: false, mode: IMAGE_GEN_MODE.CODEX, reason: `codex --version exited ${result.code}` };
  }
  const out = `${result.stdout}${result.stderr}`;
  const versionMatch = out.match(/codex-cli\s+([\d.]+)/i) || out.match(/(\d+\.\d+\.\d+)/);
  return { connected: true, mode: IMAGE_GEN_MODE.CODEX, model: versionMatch ? `codex-cli ${versionMatch[1]}` : 'codex-cli' };
}

const SESSION_ID_RE = /^session id:\s*([0-9a-f-]{36})/im;


/**
 * The `$imagegen` directive describing however many images are attached.
 *
 * Codex's `image_gen` tool takes `referenced_image_paths` — an ARRAY of
 * references (probed 2026-08-09) — so an init image and the reference slots are
 * the same kind of thing to the tool; only the wording differs. The init image
 * leads and gets the fidelity phrase (`initImageStrength` mapped via
 * describeFidelity — codex CLI exposes no numeric denoise knob); the rest are
 * named as additional visual references so the model doesn't try to edit all of
 * them at once.
 */
export function buildCodexAttachmentPrefix({ initPath, referenceCount, initImageStrength }) {
  if (initPath) {
    // Single attachment keeps the wording it has always shipped with; naming a
    // position only makes sense once there is more than one to disambiguate.
    const subject = referenceCount > 0 ? 'the FIRST attached image' : 'the attached reference image';
    const refs = referenceCount > 0
      ? ` Use the other ${referenceCount === 1 ? 'attached image' : `${referenceCount} attached images`} as ${visualReferenceRole(referenceCount)}.`
      : '';
    return `Edit ${subject} — ${describeFidelity(initImageStrength)}.${refs} Render target:\n`;
  }
  if (referenceCount > 0) {
    const subject = referenceCount === 1 ? 'the attached image' : `all ${referenceCount} attached images`;
    return `Generate a new image conditioned on ${subject} — use ${referenceCount === 1 ? 'it' : 'them'} as ${visualReferenceRole(referenceCount)}. Render target:\n`;
  }
  return '';
}

/**
 * The exact message `codex exec` receives and the record of what PortOS added
 * to the user's prompt (#11317). Shared by the render and the compose preview.
 */
export function codexSentPrompt({ prompt = '', negativePrompt, width, height, inputImages, initImageStrength, promptAdditions = [] }) {
  // Width/height/negative aren't first-class args for Codex's built-in
  // image_gen tool — pass them as natural-language hints inside the prompt.
  // Codex's imagegen skill is prompt-driven; the model decides resolution.
  // gpt-image-2 supports up to 4K output; the "(high quality)" suffix
  // pushes it off its 1024 default toward whatever native size best fits
  // the requested aspect ratio.
  // The ratio is named as well as the pixels: a bare "(1672x941)" left the
  // model free to return a square close-up, so the frame is also conformed
  // after harvest (aspectConform.js) — the hint just makes that crop rarer.
  const ratioPhrase = (width && height) ? aspectRatioPhrase(Number(width), Number(height)) : '';
  const sizeHint = (width && height) ? ` (${ratioPhrase ? `${ratioPhrase} frame, ` : ''}${width}x${height})` : '';
  const qualityHint = (width >= 1536 || height >= 1536) ? ' (high quality)' : '';
  const avoidHint = negativePrompt?.trim() ? `\nAvoid: ${negativePrompt.trim()}` : '';
  const editPrefix = buildCodexAttachmentPrefix({
    initPath: inputImages.initPath,
    referenceCount: inputImages.referencePaths.length,
    initImageStrength,
  });
  const buildWith = (text) => `$imagegen ${editPrefix}${text.trim()}${sizeHint}${qualityHint}${avoidHint}`;
  const fullPrompt = buildWith(prompt) + '\n' + noFabricationClause('image_gen');
  return {
    fullPrompt,
    record: sentPromptRecord({ sentPrompt: fullPrompt, carried: carriedPromptAdditions({ promptAdditions }),
      added: [agentInstructionsAddition('Codex image tool instructions', text => buildWith(text) + '\n' + noFabricationClause('image_gen'))] }),
  };
}

// Input images are attached via codex CLI's `-i <FILE>` flag (variadic, so all
// of them ride one flag) and the prompt is reshaped so the `$imagegen` skill
// feeds the attachments to `image_gen` as references.
export const generateImage = (params) => preparations.run(params, generateImagePrepared);

async function generateImagePrepared({
  promptAdditions = [],
  codexPath, model, modelIsShippedDefault = false, effort, prompt = '', width, height, negativePrompt,
  initImagePath, initImageStrength, referenceImagePaths = [],
  visualConditioning = null,
  jobId: providedJobId = null,
  cleanC2PA = false,
  denoise = false,
}) {
  // The ingestion instant `renderTimingFields` measures from — the queue calls
  // generateImage the moment it picks this job up. See lib/renderTiming.js.
  const renderStartedAtMs = Date.now();
  await ensureDir(PATHS.images);

  // Ship the cheap gpt-6-luna / low-effort path by default (see modes.js).
  // A caller-supplied model/effort (an explicit Settings → Image Gen override,
  // threaded through the dispatcher) wins; `null`/`''`/absent falls back to the
  // shipped default so a bare install never runs Codex's heaviest tier.
  const effectiveModel = await resolveCodexDriverModel(model, modelIsShippedDefault);
  // Validate the effort against the known codex levels before use: an
  // unrecognized non-empty value (a hand-edited settings.json / the unvalidated
  // settings PUT) would otherwise pass through, buildEffortArgs would emit no
  // override for it, and the child would silently inherit Codex's own configured
  // effort instead of the promised cheap `low` default. Fall back to the default
  // so the low-effort guarantee holds even for garbage input.
  // `resolveCliEffort` (rather than a bare `CODEX_EFFORT_LEVELS.includes`) so a
  // legacy `ultra` value resolves to Codex's strongest supported level instead
  // of collapsing to the cheap default and silently rendering at a fraction of
  // the requested effort. `effectiveModel` is threaded through because Codex's
  // ladder is MODEL-gated in both directions: it decides whether `ultra` is a
  // real level here, and whether `minimal` is — a gpt-6 model rejects `minimal`
  // outright (HTTP 400), so an unclamped legacy value would fail the render.
  const requestedEffort = (typeof effort === 'string' && effort.trim()) ? effort.trim() : CODEX_IMAGEGEN_DEFAULT_EFFORT;
  const effectiveEffort = resolveCliEffort(requestedEffort, { command: 'codex' }, effectiveModel)
    || CODEX_IMAGEGEN_DEFAULT_EFFORT;

  // Re-anchors every path to the approved image roots and caps the list at what
  // codex's image_gen accepts — see inputImages.js.
  const inputImages = resolveInputImages({
    mode: IMAGE_GEN_MODE.CODEX, initImagePath, referenceImagePaths,
  });

  // An empty prompt is fine when an image is attached (the attachment is the
  // instruction); a pure text-to-image codex render still needs a prompt. The
  // per-provider rule lives on the provider spec — see cloudPromptRequired.
  if (cloudPromptRequired(IMAGE_GEN_MODE.CODEX, inputImages.paths.length > 0) && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  const outputPath = join(PATHS.images, filename);

  const { fullPrompt, record: sentRecord } = codexSentPrompt({
    prompt, negativePrompt, width, height, inputImages, initImageStrength, promptAdditions,
  });

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
    ...buildEffortArgs(effectiveEffort, { command: 'codex' }, [], effectiveModel),
    // `-i` is variadic, so every input image rides one flag.
    ...(inputImages.paths.length ? ['-i', ...inputImages.paths] : []),
    '-m', effectiveModel,
    ...(inputImages.paths.length ? ['--'] : []),
    fullPrompt,
  ];

  const meta = {
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: IMAGE_GEN_MODE.CODEX, model: effectiveModel,
    inputProvenance: 'provider-inputs',
    initImageFilename: inputImages.initPath ? basename(inputImages.initPath) : null,
    referenceImageFilenames: inputImages.referencePaths.map(path => basename(path)),
    ...(visualConditioning ? { visualConditioning } : {}),
    ...sentRecord,
    createdAt: new Date().toISOString(),
  };
  // Per-render scratch cwd for the child (#11734). Rooted at the OS temp dir —
  // the same pattern every other ephemeral PortOS workspace uses, including the
  // sibling Codex text turn in `services/codexAppServer.js`. Deliberately NOT a
  // `PATHS` entry: `PATHS` names durable, documented directories under the
  // install root that backup and federation reason about, and this one is
  // created per render and removed when the job settles. An earlier revision
  // read `PATHS.tmp`, which has never existed on the object — `ensureDir`
  // received `undefined` and every Codex render died here before spawning.
  const scratchDir = await mkdtemp(join(tmpdir(), 'portos-codex-image-'));
  const job = { ...meta, clients: [], status: 'running', renderStartedAtMs };
  try {
    jobs.set(jobId, job);

    console.log(`🎨 Generating image [${jobId.slice(0, 8)}] codex: ${prompt.slice(0, 60)}…`);
    imageGenEvents.emit('started', { generationId: jobId, totalSteps: 1 });
    activeJobs.set(jobId, { ...meta, generationId: jobId, totalSteps: 1, step: 0, progress: 0, currentImage: null });
    broadcastSse(job, { type: 'status', message: 'Spawning codex…' });
  } catch (err) {
    jobs.delete(jobId);
    activeJobs.delete(jobId);
    await removeScratchDirectory(scratchDir);
    throw err;
  }

  // generateImage returns a job descriptor synchronously; the actual codex
  // child runs out-of-band so the HTTP response can ship while the client
  // attaches to the per-job SSE stream (mirrors local.js). runCodex settles
  // every launch failure through the job's own failure finalizer.
  runCodex(job, jobId, bin, args, outputPath, filename, meta, { cleanC2PA, denoise, scratchDir });

  return {
    jobId, filename, path: `/data/images/${filename}`, generationId: jobId,
    mode: IMAGE_GEN_MODE.CODEX, model: effectiveModel,
    // Async callers gate UI state on `status`; without 'running' they flip
    // to 'done' before the PNG lands. SSE / socket 'completed' fires later.
    status: 'running',
  };
}

// Preserve the model's reported reason without inferring account capability
// from a missing output file or a narrated success claim.
const CODEX_NO_IMAGE_HINT =
  'Codex returned no generated image. Check the Codex session and Settings → Image Gen.';
export const noImageReason = (stdoutTail = '') => buildNoImageReason(stdoutTail, {
  hint: CODEX_NO_IMAGE_HINT,
  // Codex's own structural labels, on top of the shared dashed-rule /
  // bare-token-count filter.
  dropLine: (l) => /^(codex|user)$/i.test(l) || /^tokens used\b/i.test(l),
  describe: (said) => (
    /\b(generated|created|here(?:'|’)s|i(?:'|’)ve (?:made|generated))\b/i.test(said)
      ? `Codex reported success but no generated image file was found. Codex said: "${said}"`
      : `Codex did not produce an image. Codex said: "${said}"`
  ),
});

function removeScratchDirectory(scratchDir) {
  return maintenance.continueSettlement(
    () => rmGuarded(scratchDir, { recursive: true, force: true }),
  ).catch(err => {
    maintenance.markCurrentUnsettled();
    console.error(`❌ Codex scratch cleanup failed: ${err.message}`);
  });
}

// Launch is synchronous so every failure has one owner: a refusal before a
// child exists (Node rejects an invalid argv/bin synchronously) settles the job
// here, and a setup failure after spawn terminates the child and leaves the
// close handler to settle once it has physically exited.
function runCodex(job, jobId, bin, args, outputPath, filename, meta, { cleanC2PA = false, denoise = false, scratchDir } = {}) {
  const removeScratch = () => removeScratchDirectory(scratchDir);
  if (preparations.take(jobId)) {
    void removeScratch();
    return finalizeJobFailure.canceled(job, jobId);
  }
  let proc;
  try {
    const resolvedBin = !isAbsolute(bin) && (bin.includes('/') || bin.includes(sep)) ? resolve(bin) : bin;
    const prepared = prepareCliSpawn(resolvedBin, args);
    const env = process.env.CODEX_HOME ? { ...process.env, CODEX_HOME: resolve(process.env.CODEX_HOME) } : process.env;
    proc = spawn(prepared.command, prepared.args, { cwd: scratchDir, env: withSpawnCwdEnv(env, scratchDir), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    void removeScratch();
    return finalizeJobFailure(job, jobId, null, `Failed to spawn ${bin}: ${err?.message || err}`);
  }
  activeProcs.set(jobId, proc);

  let sessionId = null;
  let stderrTail = '';
  const STDERR_TAIL_BYTES = 32 * 1024;
  // Codex narrates its turn (incl. "I can't create that…" content declines and
  // any tool-failure notes) on STDOUT. Keep a rolling tail so a no-image finish
  // can surface the model's actual words instead of a generic "no image" guess.
  let stdoutTail = '';
  const STDOUT_TAIL_BYTES = 8 * 1024;
  let timeoutTimer = null;
  let setupError = null;

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

  let processError;
  proc.on('error', (err) => {
    processError = err;
    // A failed kill/send on a live child is not physical exit.
    if (proc.pid) return;
    clearTimeout(timeoutTimer);
    void removeScratch();
    finalizeJobFailure(job, jobId, proc, `Failed to spawn ${bin}: ${err.message}`);
  });

  proc.on('close', async (code, signal) => {
    await withBackupAssetPublication(async () => {
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
        if (setupError) {
          return finalizeJobFailure(job, jobId, proc, `Codex launch setup failed: ${setupError?.message || setupError}`);
        }
        if (code !== 0 || processError) {
          const reason = processError?.message || (signal ? `Killed by signal ${signal}` : `Exit code ${code}`);
          const tail = stderrTail.trim().split('\n').slice(-6).join('\n');
          return finalizeJobFailure(job, jobId, proc, `Codex generation failed: ${reason}\n${tail}`);
        }
        if (!sessionId) {
          return finalizeJobFailure(job, jobId, proc, 'Codex returned no session id — output format may have changed');
        }
        // Codex writes the PNG asynchronously while it's wrapping up the turn.
        // Empirically the file is on disk by the time `codex exec` exits, but
        // poll for a few seconds in case there's a flush lag on slow disks.
        const harvested = await harvestGeneratedImage(sessionId, harvestTimeoutMs);
        if (!harvested) {
          return finalizeJobFailure(job, jobId, proc, await noImageSessionReason(sessionId, stdoutTail));
        }
        if (harvested.path) {
          await copyFileGuarded(harvested.path, outputPath);
        } else {
          await atomicWrite(outputPath, harvested.buffer);
        }
        // Degenerate-frame gate (#4173) — before the sidecar, so a decodable but
        // contentless canvas never becomes a gallery record.
        const emptyFrame = await rejectDegenerateFrame(outputPath);
        if (emptyFrame) {
          return finalizeJobFailure(job, jobId, proc, emptyFrame);
        }
        // Codex picks its own output size; crop an off-aspect frame to the
        // requested ratio before anything downstream inherits its shape.
        const aspectConformed = await conformImageAspect(outputPath, meta.width, meta.height);
        if (aspectConformed) console.log(`✂️ Conformed codex frame [${jobId.slice(0, 8)}] ${aspectConformed.from} → ${aspectConformed.to}`);
        // Sidecar metadata so the gallery can recover prompt/seed/etc. The
        // codex sessionId is the closest analogue to a seed for gpt-image-2
        // (which doesn't expose one) — uniquely identifies the run and is
        // useful for traceability even though it doesn't reproduce the output.
        const sidecar = join(PATHS.images, `${jobId}.metadata.json`);
        // `job.renderStartedAtMs` is the queue-ingestion instant generateImage
        // captured, so the spread measures the render itself — not the time the
        // job spent queued behind other renders.
        await atomicWrite(sidecar, { ...meta, codexSessionId: sessionId, ...(aspectConformed ? { aspectConformed } : {}), ...renderTimingFields(job.renderStartedAtMs) });
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
        dispatchTerminalEvent(
          jobId,
          () => broadcastSse(job, { type: 'complete', result }),
          () => imageGenEvents.emit('completed', { mode: IMAGE_GEN_MODE.CODEX, generationId: jobId, path: `/data/images/${filename}`, filename }),
        );
        closeJobAfterDelay(jobs, jobId);
      } catch (err) {
        await Promise.all([outputPath, join(PATHS.images, `${jobId}.metadata.json`)].map(path => unlinkGuarded(path).catch(() => {})));
        // force: true — 'complete' is already stamped above; see
        // createJobFailureFinalizer's doc comment in sseUtils.js.
        finalizeJobFailure(job, jobId, proc, `Codex post-exit handler failed: ${err?.message || err}`, { force: true });
      }
    }).catch(err => {
      // Admission can reject before the publication callback is entered.
      // EventEmitter does not await this listener, so settle the job here too.
      clearTimeout(timeoutTimer);
      finalizeJobFailure(job, jobId, proc, `Codex publication admission failed: ${err?.message || err}`);
    }).finally(removeScratch);
  });

  // Post-spawn setup. The error/close owners above are already installed, so a
  // throw here must not settle the job under a live child: record it,
  // terminate the child, and let close settle once it has physically exited.
  try {
    timeoutTimer = setTimeout(() => {
      if (activeProcs.get(jobId) === proc) {
        console.log(`⏱️ codex timed out after ${CODEX_TIMEOUT_MS}ms [${jobId.slice(0, 8)}]`);
        sigtermWithEscalation(jobId, proc);
      }
    }, CODEX_TIMEOUT_MS);

    proc.stdout.on('data', (chunk) => {
      // Codex prints the `session id:` banner on stderr only — don't feed
      // stdout into bannerBuf. A stdout chunk arriving between two stderr
      // chunks of the banner can split the session-id line with unrelated
      // text and break the regex match.
      // We DO retain stdout here (the model's turn narration) so a no-image
      // finish can report why — a content decline, or a "generated" claim with
      // no file.
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
  } catch (err) {
    setupError = err;
    clearTimeout(timeoutTimer);
    sigtermWithEscalation(jobId, proc);
  }
}

const finalizeJobFailure = createJobFailureFinalizer({
  jobs,
  activeJobs,
  activeSlots: activeProcs,
  label: 'codex image generation',
  events: imageGenEvents,
  failedPayload: (jobId, reason) => ({ mode: IMAGE_GEN_MODE.CODEX, generationId: jobId, error: reason }),
});

// Returns the absolute path to the newest PNG in the session dir. Codex has
// used both `ig_*.png` and `exec-*.png`; the per-session directory is already
// the ownership boundary, so a filename-prefix allowlist only turns valid tool
// output into a false failure when the CLI changes its internal naming again.
async function latestGeneratedImageFile(sessionId) {
  const dir = codexImagesDir(sessionId);
  if (!existsSync(dir)) return null;
  const names = await readdir(dir).catch(() => []);
  const pngs = names.filter((name) => name.toLowerCase().endsWith('.png'));
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
    const remainingMs = Math.max(1, deadline - Date.now());
    await sleep(Math.min(250, remainingMs));
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

async function noImageSessionReason(sessionId, stdoutTail) {
  const path = await findSessionLogFile(sessionId);
  if (!path) return noImageReason(stdoutTail);
  const text = await readFile(path, 'utf8').catch(() => '');
  let imageToolObserved = false;
  let shellObserved = false;
  for (const line of text.split('\n')) {
    try {
      const payload = JSON.parse(line)?.payload;
      const name = payload?.name || '';
      if (['image_gen', 'image_gen.text2im', 'image_gen.imagegen'].includes(name) || ['image_generation_call', 'image_generation_end'].includes(payload?.type)) imageToolObserved = true;
      if (['function_call', 'custom_tool_call'].includes(payload?.type) && /^(exec|exec_command|shell|shell_command)$/.test(name)) shellObserved = true;
    } catch { /* Incomplete transcript lines do not establish tool usage. */ }
  }
  if (imageToolObserved) return noImageReason(stdoutTail);
  return `No image_gen call was observed in the Codex session${shellObserved ? '; shell activity was recorded' : ''}. No generated image was found. This does not establish whether the tool is available to this account. Check Settings → Image Gen and the Codex session. ${noImageReason(stdoutTail)}`;
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
    // image_generation_end.result (base64), without materializing a PNG in
    // ~/.codex/generated_images/<session-id>/. Decode that fallback so
    // a real generation does not get reported as "success but no file".
    const sessionImage = await harvestSessionLogImage(sessionId);
    if (sessionImage) return { buffer: sessionImage.buffer, sessionLogPath: sessionImage.path };

    await sleep(250);
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
  setHarvestTimeoutForTests: (timeoutMs = DEFAULT_HARVEST_TIMEOUT_MS) => {
    harvestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_HARVEST_TIMEOUT_MS;
  },
};
