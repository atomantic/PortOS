/**
 * Image Gen — Antigravity (`agy`) CLI provider.
 *
 * Agy is an opt-in cloud CLI backend. Each request runs in a throwaway scratch
 * directory and directs the built-in `image-generator` subagent (agy >= 1.2.16)
 * or direct `generate_image` tool (older agy builds) to one PortOS-owned staging
 * path. Only signature-verified image bytes are moved into the gallery.
 *
 * `generate_image` (and the `image-generator` subagent wrapping it) takes input
 * images through `ImagePaths` — up to 3, usable to "edit, combine, or use as
 * references" — so an init image and the reference slots both reach it. Unlike
 * codex/grok, `Prompt` is a REQUIRED tool parameter, so an image-only agy render
 * is rejected up front.
 */

import { spawn } from '../../lib/childProcess.js';
import { mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import {
  ANTIGRAVITY_CLI_ID,
  ensureAntigravityPrintArgs,
  isAntigravityModelId,
  parseAntigravityModelList,
  prepareAntigravityPrompt,
} from '../../lib/antigravity.js';
import {
  antigravityCatalogListsModel,
  pickAntigravityRelayModel,
  splitAntigravityModel,
} from '../../lib/provider/providerModels.js';
import { killProcessTree, prepareCliSpawn } from '../../lib/bufferedSpawn.js';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { buildNoImageReason } from './noImageReason.js';
import { noFabricationClause } from './fabricationGuard.js';
import {
  AGY_IMAGEGEN_IMAGE_MODEL, IMAGE_GEN_MODE, IMAGE_TOOL_NAMES, describeFidelity,
  nearestAgyAspectRatio, visualReferenceRole,
} from './modes.js';
import { cliPromptImageNames, resolveInputImages, stageCliPromptImages } from './inputImages.js';
import { CLI_IMAGE_INPUT_PROVENANCE } from '../../lib/imageInputProvenance.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { agentInstructionsAddition, carriedPromptAdditions, sentPromptRecord } from '../../lib/modelInput.js';
import { checkCliVersionConnection, createCliImageJobRunner, harvestStagedImage } from './cliJobRunner.js';

const AGY_TIMEOUT_MS = (() => {
  const n = Number(process.env.AGY_IMAGEGEN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000;
})();
const OUTPUT_NAME = 'output.png';
const DEFAULT_BIN = 'agy';
const DEFAULT_HARVEST_TIMEOUT_MS = 5000;
let harvestTimeoutMs = DEFAULT_HARVEST_TIMEOUT_MS;

const runner = createCliImageJobRunner({
  mode: IMAGE_GEN_MODE.AGY, provider: 'Agy', logName: 'agy', defaultBin: DEFAULT_BIN, timeoutMs: AGY_TIMEOUT_MS,
});

export const { getActiveJob, getActiveJobs, attachSseClient, cancel, cancelAll } = runner;

// A version probe establishes CLI availability without spending image quota.
export async function checkConnection({ agyPath } = {}) {
  return checkCliVersionConnection({
    bin: agyPath || DEFAULT_BIN, mode: IMAGE_GEN_MODE.AGY, label: 'Agy', modelPrefix: 'agy',
  });
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
// Since agy 1.2.16, image generation moved from a top-level `generate_image`
// tool to the built-in `image-generator` subagent invoked via `invoke_subagent`.
// Older installs still expose `generate_image` directly, so the prompt accepts
// either while keeping `noFabricationClause` strict against code-drawn stand-ins.
const AGY_SUBAGENT = 'image-generator';

const AGY_NO_IMAGE_HINT =
  'Agy returned no image — the selected model may not expose image-generator or generate_image, or the model declined. Check Media Gen Settings → Agy CLI.';

export const noImageReason = (stdoutTail = '') => buildNoImageReason(stdoutTail, {
  hint: AGY_NO_IMAGE_HINT,
  describe: (said) => `Agy did not produce an image at the directed path. Agy said: "${said}"`,
});

/**
 * Directs agy's `image-generator` subagent (or legacy `generate_image` tool) at
 * whatever input images the render carries.
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
  return `\nUse these files from the working directory as input images (ImagePaths), in this order: ${paths.join(', ')}\nResolve those files locally against the working directory and pass their absolute paths to ${AGY_SUBAGENT} (or to ${AGY_TOOL}'s ImagePaths parameter).\n${role}`;
};

export function buildAgyPrompt({
  prompt, negativePrompt, width, height,
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
  const aspect = ratio ? `\nPass AspectRatio "${ratio}" to ${AGY_SUBAGENT} (or ${AGY_TOOL}).` : '';
  const images = agyImagePathsDirective({ ...cliPromptImageNames(inputImages), initImageStrength });
  // `image-generator` saves into the conversation's artifacts directory (often
  // as JPEG) and replies with the saved path, so the parent agent must copy the
  // returned file as-is to `OUTPUT_NAME`; cliJobRunner sniffs magic bytes and
  // converts non-PNG files to PNG via sharp.
  return `Use your built-in ${AGY_SUBAGENT} subagent (via invoke_subagent with TypeName "${AGY_SUBAGENT}") — or your built-in ${AGY_TOOL} tool if available directly — to generate exactly one image.
Image prompt: ${prompt.trim()}${avoid}${aspect}${images}
Save the generated image at exactly this path in the working directory: ${OUTPUT_NAME} (when using ${AGY_SUBAGENT}, wait for it to reply with the saved image path and copy that file as-is to ${OUTPUT_NAME} without converting or re-encoding it).
${noFabricationClause(AGY_TOOL, { subagent: AGY_SUBAGENT })}
Do not create any other files, do not modify any code or workspace content, and do not run unrelated tools. When ${OUTPUT_NAME} is written, you are done.`;
}

/**
 * The agy session model + catalog this render should drive.
 *
 * Two things want the catalog, and only a model carrying a baked effort tier
 * can need either — so an id with no tier (and a render with no pin at all)
 * skips the read. The shipped default does carry one, so a default-config
 * render always pays it; that is one cached provider-record read against a
 * multi-second CLI spawn.
 *
 *  - agy validates the (model, effort) PAIR and rejects a tier the base does
 *    not offer ("gemini-3.1-pro has no 'medium' effort"), so
 *    `ensureAntigravityPrintArgs` has to see `models` to clamp the ladder down
 *    to the tiers that base really has. Without it every suffixed id resolves
 *    against the full low/medium/high ladder and can emit an unsupported pair.
 *    Image gen was the last agy spawn site not passing the catalog through.
 *  - a SHIPPED default the vendor has retired is ours to re-point — see
 *    `AGY_IMAGEGEN_DEFAULT_MODEL` for the incident. `shippedDefault` is the
 *    provenance flag `cloudProviderConfig` sets, NOT a comparison against the
 *    constant: a user who types today's shipped id into Settings still owns
 *    that pin, and substituting it would hide agy's own "unknown model" error
 *    behind a silently different render. The re-point lands on the job's
 *    sidecar and returned record, which is what regen and provenance read.
 *
 * The catalog comes from the install's provider record (cache-fronted by the
 * provider service), NOT from an `agy models` spawn: the render path must not
 * pay a second child process, and a probe failure would stall it behind a
 * timeout. The deferred import keeps `services/provider/providers.js` and the toolkit
 * subtree behind it out of every image-gen suite closure (server suite import
 * budget, `lib/importScoping.test.js`); `.catch` covers the uninitialized
 * toolkit, and no catalog means "leave the caller's model alone".
 */
async function resolveAgyDriverModel(model, shippedDefault) {
  if (!model || !splitAntigravityModel(model).effort) return { model: model || null, models: null };
  const models = await import('../provider/providers.js')
    .then(({ getProviderById }) => getProviderById(ANTIGRAVITY_CLI_ID))
    .then((provider) => provider?.models)
    .catch(() => null);
  if (shippedDefault && !antigravityCatalogListsModel(model, models)) {
    const replacement = pickAntigravityRelayModel(models);
    if (replacement) {
      console.log(`🔀 agy default model ${model} is no longer listed — driving with ${replacement}`);
      return { model: replacement, models };
    }
  }
  return { model, models };
}

/**
 * The exact message agy receives and the record of what PortOS added to the
 * user's prompt (#11317). Shared by the render and the compose preview.
 */
export function agySentPrompt({ prompt = '', negativePrompt, width, height, inputImages, initImageStrength, promptAdditions = [] }) {
  const buildWith = (text) => buildAgyPrompt({
    prompt: text, negativePrompt, width, height, inputImages, initImageStrength,
  });
  const fullPrompt = buildWith(prompt);
  return {
    fullPrompt,
    record: sentPromptRecord({ sentPrompt: fullPrompt, carried: carriedPromptAdditions({ promptAdditions }),
      added: [agentInstructionsAddition('Antigravity image tool instructions', buildWith)] }),
  };
}

export const generateImage = (params) => runner.preparations.run(params, generateImagePrepared);

async function generateImagePrepared({
  promptAdditions = [],
  agyPath,
  model,
  modelIsShippedDefault = false,
  prompt = '',
  width,
  height,
  negativePrompt,
  initImagePath,
  initImageStrength,
  referenceImagePaths = [],
  visualConditioning = null,
  jobId: providedJobId = null, reviewedReferenceSnapshot = null,
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
  const scratchDir = join(tmpdir(), `portos-agy-${jobId}`);
  const stagingPath = join(scratchDir, OUTPUT_NAME);

  // `driverModel` is what agy actually runs on — a retired shipped default is
  // re-pointed here, so every record below reports the model that rendered
  // rather than the one the caller asked for. See resolveAgyDriverModel.
  const { model: driverModel, models } = await resolveAgyDriverModel(model, modelIsShippedDefault);
  const baseArgs = ensureAntigravityPrintArgs([], { model: driverModel, models });
  // Before registration, clean up here if reference validation or staging fails.
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  try {
    const reviewedReferenceBytes = await assertSnapshotForAdapter(reviewedReferenceSnapshot, jobId, inputImages.initPath, inputImages.referencePaths);
    await stageCliPromptImages({ paths: inputImages.paths, scratchDir, reviewedReferenceBytes });
  } catch (error) {
    await runner.removeScratchDirectory(scratchDir);
    throw error;
  }
  const { fullPrompt, record: sentRecord } = agySentPrompt({
    prompt, negativePrompt, width, height, inputImages, initImageStrength, promptAdditions,
  });
  const { args } = prepareAntigravityPrompt(baseArgs, fullPrompt);
  const meta = {
    id: jobId,
    prompt: prompt.trim(),
    negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
    filename,
    mode: IMAGE_GEN_MODE.AGY,
    model: driverModel,
    // The agent/session model above drives the CLI; the image itself always
    // renders on Antigravity's fixed server-side backend — record it so
    // provenance names the model that actually produced the pixels (#3231).
    imageModel: AGY_IMAGEGEN_IMAGE_MODEL,
    inputProvenance: CLI_IMAGE_INPUT_PROVENANCE[IMAGE_GEN_MODE.AGY],
    initImageFilename: inputImages.initPath ? basename(inputImages.initPath) : null,
    referenceImageFilenames: inputImages.referencePaths.map(path => basename(path)),
    ...(visualConditioning ? { visualConditioning } : {}),
    ...sentRecord,
    createdAt: new Date().toISOString(),
  };
  const job = await runner.registerJob({ meta, renderStartedAtMs, scratchDir });
  runner.run(job, {
    bin: agyPath || undefined, args, scratchDir, meta, cleanC2PA, denoise,
    prepareAttempt: () => ({
      discover: ({ stdoutTail }) => runner.discoverStagedImage({
        stagingPath, harvestTimeoutMs, scratchDir, toolName: AGY_TOOL, noImageReason, stdoutTail,
      }),
    }),
    async recordUsage(renderMeta) {
      const { recordAgyImageUsage } = await import('../agyMediaUsage.js');
      await recordAgyImageUsage({
        jobId,
        createdAt: renderMeta.createdAt,
        inputImages: (inputImages.initPath ? 1 : 0) + inputImages.referencePaths.length,
        model: renderMeta.imageModel || AGY_IMAGEGEN_IMAGE_MODEL,
      });
    },
  });

  return {
    jobId,
    filename,
    path: `/data/images/${filename}`,
    generationId: jobId,
    mode: IMAGE_GEN_MODE.AGY,
    model: driverModel,
    status: 'running',
  };
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
