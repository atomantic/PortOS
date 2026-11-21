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
 * only in the session JSONL, so we parse the banner and harvest both locations
 * after the child exits. A session can hold several images; codexSessionImages.js
 * decides which one is the job's.
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

import { access, readFile, readdir, stat, mkdtemp } from 'fs/promises';
import { constants as fsConstants, existsSync } from 'fs';
import { basename, join, resolve } from 'path';
import { tmpdir } from 'os';
import { codexHomeDir } from '../../lib/codexUserConfig.js';
import { withoutServerSecretsEnv } from '../../lib/processEnv.js';

// Codex's own ambient credentials; everything else server-held is withheld.
const CODEX_AUTH_ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE'];
import { noFabricationClause } from './fabricationGuard.js';
import { IMAGE_GEN_ITEM_KIND, parseSessionImageRecords, selectJobImage } from './codexSessionImages.js';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS, sleep } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { imageGenEvents } from '../imageGenEvents.js';
import { broadcastSse } from '../../lib/sseUtils.js';
import { codexDriverReportedTokens, recordCodexRender } from '../imageRenderUsage.js';
import { buildCodexStartupArgs, buildEffortArgs, resolveCliEffort } from '../../lib/provider/providerModels.js';
import {
  IMAGE_GEN_MODE, CODEX_IMAGEGEN_DEFAULT_MODEL, CODEX_IMAGEGEN_DEFAULT_EFFORT,
  describeFidelity, visualReferenceRole,
} from './modes.js';
import { buildNoImageReason } from './noImageReason.js';
import { conformImageAspect } from './aspectConform.js';
import { aspectRatioPhrase } from '../../lib/aspectRatio.js';
import { resolveInputImages } from './inputImages.js';
import { CLI_IMAGE_INPUT_PROVENANCE } from '../../lib/imageInputProvenance.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { agentInstructionsAddition, carriedPromptAdditions, sentPromptRecord } from '../../lib/modelInput.js';
import { stripAnsi } from '../../lib/ansiStrip.js';
import { checkCliVersionConnection, createCliImageJobRunner } from './cliJobRunner.js';

const MAX_MISSING_REF_RETRIES = 1;
const MISSING_REF_TARGET_RE = /\b(reference(?:\s+(?:image|file|path))?|referenced_image_paths?|attached\s+(?:image|file|reference)|input\s+(?:image|file)|image\s+path|file\s+path)\b/i;
const MISSING_REF_PROBLEM_RE = /\b(?:could\s+not|couldn['’]?t|cannot|can\s+not|can['’]?t|unable\s+to|failed\s+to)\s+(?:be\s+)?(?:find|found|locate|located|read|access|open)\b|\b(?:not\s+(?:be\s+)?found|missing|does\s+not\s+exist|doesn['’]t\s+exist|no\s+such\s+file|unreadable|inaccessible|enoent)\b/i;

function isMissingReferenceReply(stdoutTail = '') {
  const clean = stripAnsi(String(stdoutTail));
  if (!clean.trim()) return false;
  return (MISSING_REF_TARGET_RE.test(clean) && MISSING_REF_PROBLEM_RE.test(clean))
    || /\bno\s+such\s+file\b|\benoent\b/i.test(clean);
}

async function assertReadableInputImages(paths) {
  for (const filePath of paths) {
    try {
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error('Not a file');
      await access(filePath, fsConstants.R_OK);
    } catch {
      throw new ServerError(`Codex reference image is missing or unreadable: ${basename(filePath)}`, {
        status: 400,
        code: 'IMAGE_INPUT_UNAVAILABLE',
      });
    }
  }
}

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

const referenceEventFields = ({ initImageFilename, referenceImageFilenames }) => ({
  initImageFilename, referenceImageFilenames,
});

const runner = createCliImageJobRunner({
  mode: IMAGE_GEN_MODE.CODEX, provider: 'Codex', defaultBin: DEFAULT_BIN, timeoutMs: CODEX_TIMEOUT_MS,
  failedPayloadExtras: (job) => job && referenceEventFields(job),
});

export const { getActiveJob, getActiveJobs, attachSseClient, cancel, cancelAll } = runner;

// A version probe establishes CLI availability without spending image quota.
export async function checkConnection({ codexPath } = {}) {
  return checkCliVersionConnection({
    bin: codexPath || DEFAULT_BIN, mode: IMAGE_GEN_MODE.CODEX, label: 'Codex', modelPrefix: 'codex-cli',
    versionRegex: /codex-cli\s+([\d.]+)/i,
    env: withoutServerSecretsEnv(process.env, { keep: CODEX_AUTH_ENV_KEYS }),
  });
}

const SESSION_ID_RE = /^session id:\s*([0-9a-f-]{36})/im;

const SINGLE_IMAGE_CALL = 'Call image_gen exactly once. Do not call it again after it returns an image: no summary, progress or completion image, and no extra variation.';

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
  const avoidHint = negativePrompt?.trim() ? `\nAvoid: ${negativePrompt}` : '';
  const editPrefix = buildCodexAttachmentPrefix({
    initPath: inputImages.initPath,
    referenceCount: inputImages.referencePaths.length,
    initImageStrength,
  });
  // CLI attachments reach the Codex conversation, but image_gen does not
  // automatically receive them just because its prompt describes them.
  const inputCount = inputImages.paths.length;
  const toolInputs = inputCount
    ? `When calling image_gen, pass the ${inputCount} attached image${inputCount === 1 ? '' : 's'} as image inputs, in attachment order, using their local paths in referenced_image_paths. Describing the images in the prompt alone does not include them.\n`
    : '';
  const buildWith = (text) => `$imagegen ${toolInputs}${editPrefix}${text}${sizeHint}${qualityHint}${avoidHint}`;
  const withInstructions = (text) => `${buildWith(text)}\n${noFabricationClause('image_gen')}\n${SINGLE_IMAGE_CALL}`;
  const fullPrompt = withInstructions(prompt);
  return {
    fullPrompt,
    record: sentPromptRecord({ sentPrompt: fullPrompt, carried: carriedPromptAdditions({ promptAdditions }),
      added: [agentInstructionsAddition('Codex image tool instructions', withInstructions)] }),
  };
}

// Input images are attached via codex CLI's `-i <FILE>` flag (variadic, so all
// of them ride one flag) and the prompt is reshaped so the `$imagegen` skill
// feeds the attachments to `image_gen` as references.
export const generateImage = (params) => runner.preparations.run(params, generateImagePrepared);

async function generateImagePrepared({
  promptAdditions = [],
  codexPath, model, modelIsShippedDefault = false, effort, prompt = '', width, height, negativePrompt,
  initImagePath, initImageStrength, referenceImagePaths = [],
  visualConditioning = null,
  jobId: providedJobId = null, reviewedReferenceSnapshot = null,
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

  const { fullPrompt, record: sentRecord } = codexSentPrompt({
    prompt, negativePrompt, width, height, inputImages, initImageStrength, promptAdditions,
  });

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
    id: jobId, prompt, negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: IMAGE_GEN_MODE.CODEX, model: effectiveModel,
    // The CLI's attachments are visible to its driver; whether that driver
    // forwards them to image_gen is not exposed as a structured receipt.
    inputProvenance: CLI_IMAGE_INPUT_PROVENANCE[IMAGE_GEN_MODE.CODEX],
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
  try {
    await assertSnapshotForAdapter(reviewedReferenceSnapshot, jobId, inputImages.initPath, inputImages.referencePaths);
    await assertReadableInputImages(inputImages.paths);
  } catch (error) {
    await runner.removeScratchDirectory(scratchDir);
    throw error;
  }
  const job = await runner.registerJob({ meta, renderStartedAtMs, scratchDir, referenceEventFields: referenceEventFields(meta) });
  runner.run(job, {
    bin: codexPath || undefined, args, scratchDir, meta, cleanC2PA, denoise,
    prepareAttempt: () => prepareCodexAttempt(job, inputImages.paths),
    conformAspect: conformImageAspect,
    recordUsage: recordCodexRender,
    referenceEventFields: referenceEventFields(meta),
  });

  return {
    jobId, filename, path: `/data/images/${filename}`, generationId: jobId,
    mode: IMAGE_GEN_MODE.CODEX, model: effectiveModel,
    initImageFilename: meta.initImageFilename,
    referenceImageFilenames: meta.referenceImageFilenames,
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

function prepareCodexAttempt(job, inputPaths) {
  const baseEnv = withoutServerSecretsEnv(process.env, { keep: CODEX_AUTH_ENV_KEYS });
  const env = process.env.CODEX_HOME ? { ...baseEnv, CODEX_HOME: resolve(process.env.CODEX_HOME) } : baseEnv;
  let sessionId;
  let banner = '';
  return {
    env,
    onStderr: function captureSession(text) {
      if (sessionId) return;
      // Match before slicing. A long prompt echo in the same chunk can push
      // the complete banner out of the rolling window.
      banner += text;
      const match = banner.match(SESSION_ID_RE);
      if (match) {
        sessionId = match[1];
        banner = '';
        broadcastSse(job, { type: 'status', message: `Codex session ${sessionId.slice(0, 8)}…` });
      } else {
        banner = banner.slice(-4096);
      }
    },
    async discover({ attempt, stdoutTail, stderrTail }) {
      if (!sessionId) return { error: 'Codex returned no session id — output format may have changed' };
      const harvested = await harvestGeneratedImage(sessionId, job.prompt, harvestTimeoutMs);
      if (!harvested) {
        if (attempt < MAX_MISSING_REF_RETRIES && inputPaths.length > 0 && !job.canceled && isMissingReferenceReply(stdoutTail)) {
          try {
            await assertReadableInputImages(inputPaths);
          } catch (err) {
            return { error: err.message };
          }
          if (!job.canceled) {
            console.log(`🔄 Retrying codex image generation [${job.id}] after missing-reference reply while references are readable`);
            broadcastSse(job, { type: 'status', message: 'Retrying codex after missing-reference reply…' });
            imageGenEvents.emit('activity', { generationId: job.id });
          }
          // The runner rechecks cancellation at the next spawn handoff.
          return { retry: true };
        }
        return { error: await noImageSessionReason(sessionId, stdoutTail) };
      }
      if (harvested.unmatchedImages) {
        return { error: `Codex made ${harvested.unmatchedImages} images in this session and none could be matched to this job's prompt, so nothing was saved. Run the job again.` };
      }
      if (harvested.ignoredImages) {
        console.log(`⏭️ Codex session made ${harvested.ignoredImages + 1} images; saved the one matching the job's prompt [${job.id.slice(0, 8)}]`);
      }
      return {
        path: harvested.fileName ? join(codexImagesDir(sessionId), harvested.fileName) : undefined,
        buffer: harvested.buffer,
        format: 'png',
        // The Codex session identifies the image_gen run. It does not act
        // as a seed, since the tool exposes no reproducible one.
        sidecarFields: { codexSessionId: sessionId, driverReportedTokens: codexDriverReportedTokens(stderrTail) },
      };
    },
  };
}

// Codex has used both `ig_*.png` and `exec-*.png`; the per-session directory is
// already the ownership boundary, so a filename-prefix allowlist only turns valid
// tool output into a false failure when the CLI changes its internal naming again.
async function generatedImageNames(sessionId) {
  const names = await readdir(codexImagesDir(sessionId)).catch(() => []);
  return names.filter((name) => name.toLowerCase().endsWith('.png'));
}

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
      // Current builds call the tool from inside an `exec` script.
      if (['image_gen', 'image_gen.text2im', 'image_gen.imagegen'].includes(name)
        || ['image_generation_call', 'image_generation_end'].includes(payload?.type)
        || payload?.item?.kind === IMAGE_GEN_ITEM_KIND
        || (typeof payload?.input === 'string' && payload.input.includes('tools.image_gen'))) imageToolObserved = true;
      if (['function_call', 'custom_tool_call'].includes(payload?.type) && /^(exec|exec_command|shell|shell_command)$/.test(name)) shellObserved = true;
    } catch { /* Incomplete transcript lines do not establish tool usage. */ }
  }
  if (imageToolObserved) return noImageReason(stdoutTail);
  return `No image_gen call was observed in the Codex session${shellObserved ? '; shell activity was recorded' : ''}. No generated image was found. This does not establish whether the tool is available to this account. Check Settings → Image Gen and the Codex session. ${noImageReason(stdoutTail)}`;
}

async function sessionImageRecords(sessionId) {
  const logPath = await findSessionLogFile(sessionId);
  if (!logPath) return [];
  return parseSessionImageRecords(await readFile(logPath, 'utf8').catch(() => ''));
}

async function harvestGeneratedImage(sessionId, jobPrompt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let selection = null;
  while (Date.now() < deadline) {
    selection = selectJobImage({
      fileNames: await generatedImageNames(sessionId),
      records: await sessionImageRecords(sessionId),
      jobPrompt,
    });
    // An unmatched session keeps polling: its log entries may still be flushing.
    if (selection && !selection.unmatchedImages) return selection;
    await sleep(250);
  }
  return selection;
}

// Tiny helper for unit tests — overrides the homedir lookup so tests can
// point at a tmpdir-rooted ~/.codex without touching the real one. Not used
// in production. The function below intentionally keeps state inside this
// module because the test path is an explicit ergonomic carve-out.
export const _internals = {
  codexImagesDir,
  codexSessionsDir,
  SESSION_ID_RE,
  setHarvestTimeoutForTests: (timeoutMs = DEFAULT_HARVEST_TIMEOUT_MS) => {
    harvestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_HARVEST_TIMEOUT_MS;
  },
};
