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
 * Authority: grok is a general coding agent and headless runs bypass its
 * approval prompts. Grok exposes no image-tool-only permission mode, so HTTP
 * generation requires operator authority before dispatch. The throwaway cwd
 * organizes output; it does not restrict host tools or absolute-path access.
 * Scratch cleanup, signature checks and fabrication checks constrain accepted
 * gallery output, not what the agent can do before returning it.
 */

import { mkdir } from 'fs/promises';
import { basename, join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ensureDir, PATHS } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { buildNoImageReason } from './noImageReason.js';
import { noFabricationClause } from './fabricationGuard.js';
import { ensureGrokHeadlessArgs, prepareGrokPromptFile } from '../../lib/grok.js';
import {
  IMAGE_GEN_MODE, describeFidelity, grokImageTool, nearestAspectRatio, visualReferenceRole,
} from './modes.js';
import { GROK_ASPECT_RATIOS } from '../../lib/imageGenCapabilities.js';
import { cliPromptImageNames, resolveInputImages, stageCliPromptImages } from './inputImages.js';
import { CLI_IMAGE_INPUT_PROVENANCE } from '../../lib/imageInputProvenance.js';
import { assertSnapshotForAdapter } from './reviewedReference.js';
import { cloudPromptRequired } from './cloudProviderConfig.js';
import { agentInstructionsAddition, carriedPromptAdditions, sentPromptRecord } from '../../lib/modelInput.js';
import { checkCliVersionConnection, createCliImageJobRunner, harvestStagedImage } from './cliJobRunner.js';

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

const OUTPUT_NAME = 'output.png';
const DEFAULT_BIN = 'grok';
const DEFAULT_HARVEST_TIMEOUT_MS = 5000;
let harvestTimeoutMs = DEFAULT_HARVEST_TIMEOUT_MS;

// The tool's aspect-ratio alphabet lives in the dependency-free
// `lib/imageGenCapabilities.js` leaf (Settings offers it as the default-ratio
// picker, and this module is unreachable from the browser bundle). Re-exported
// so `videoGen/grok.js` and the render paths keep importing it from here.
export { GROK_ASPECT_RATIOS };

// Map a width/height pair to the closest supported grok aspect ratio, or null
// when dimensions are absent/invalid (the tool then uses its own default).
// The mapping itself is shared with agy — see nearestAspectRatio in modes.js.
export const deriveAspectRatio = (width, height) => nearestAspectRatio(width, height, GROK_ASPECT_RATIOS);

const runner = createCliImageJobRunner({
  mode: IMAGE_GEN_MODE.GROK, provider: 'Grok', logName: 'grok', defaultBin: DEFAULT_BIN, timeoutMs: GROK_TIMEOUT_MS,
});

export const { getActiveJob, getActiveJobs, attachSseClient, cancel, cancelAll } = runner;

// A version probe establishes CLI availability without spending image quota.
export async function checkConnection({ grokPath } = {}) {
  return checkCliVersionConnection({
    bin: grokPath || DEFAULT_BIN, mode: IMAGE_GEN_MODE.GROK, label: 'Grok', modelPrefix: 'grok-cli',
  });
}

// Grok narrates its turn on stdout. Turn the tail into the most useful error
// we can when the directed output file never landed — surfacing the model's
// own words (content declines, tool-failure notes) instead of a fixed guess.
const GROK_NO_IMAGE_HINT =
  'Grok returned no image — the image_gen tool may be unavailable on your Grok plan, or the model declined. Check Settings → Image Gen → Enable Grok Imagegen.';
export const noImageReason = (stdoutTail = '') => buildNoImageReason(stdoutTail, {
  hint: GROK_NO_IMAGE_HINT,
  describe: (said) => `Grok did not produce an image at the directed path. Grok said: "${said}"`,
});

// Build the single-turn agent prompt that triggers image_gen (or image_edit
// whenever the render carries any input image) and directs the output to a
// PortOS-chosen path. Grok is a general coding agent, so the prompt is explicit
// about the tool, the save path, and staying out of everything else.
//
// grok's `image_gen` has NO image parameter at all, so reference images route
// to `image_edit` too — its `image` parameter is an ARRAY of references (probed
// 2026-08-09: "Reference image(s) to condition the edit on"), which is exactly
// how PortOS's reference slots are fed. The init image, when present, leads the
// array and is the one the fidelity phrase describes.
export function buildGrokPrompt({
  prompt, negativePrompt, aspectRatio,
  inputImages, initImageStrength,
}) {
  const { initPath: initImagePath, referencePaths: referenceImagePaths } = cliPromptImageNames(inputImages);
  const refCount = referenceImagePaths.length;
  const refList = referenceImagePaths.join(', ');
  const refNoun = refCount === 1 ? 'this reference image' : `these ${refCount} reference images`;
  const inOrder = refCount > 1 ? ', in this order,' : '';
  const toolName = grokImageTool(Boolean(initImagePath || refCount));

  // One clause per line, assembled in the order grok reads them: what to call,
  // what to pass it, then what to draw.
  const lines = [];
  if (initImagePath) {
    lines.push(`Use your built-in image_edit tool to transform the source image at ${initImagePath} — ${describeFidelity(initImageStrength)}. Pass that source image FIRST in the tool's \`image\` array.`);
    if (refCount) {
      lines.push(`Also pass ${refNoun} to the tool's \`image\` array after it${inOrder} as ${visualReferenceRole(refCount)}: ${refList}`);
    }
  } else if (refCount) {
    lines.push(`Use your built-in image_edit tool to generate exactly one image conditioned on ${refNoun}.`);
    lines.push(`Pass ${refCount === 1 ? 'it' : 'them'} to the tool's \`image\` array${inOrder} as ${visualReferenceRole(refCount)}: ${refList}`);
  } else {
    lines.push('Use your built-in image_gen tool to generate exactly one image.');
  }
  // An edit reads as an instruction ON the source image; everything else is a
  // description OF the image to make.
  lines.push(`${initImagePath ? 'Edit instruction' : 'Image prompt'}: ${prompt.trim()}`);
  if (negativePrompt?.trim()) lines.push(`Avoid: ${negativePrompt.trim()}`);
  if (aspectRatio) lines.push(`Use aspect_ratio "${aspectRatio}".`);
  lines.push(`Save the generated image as a PNG file at exactly this path in the working directory: ${OUTPUT_NAME}`);
  lines.push(noFabricationClause(toolName));
  lines.push('Do not create any other files, do not modify any code, and do not run any other tools beyond what is needed to generate the image and write it to that path. When the file is written, you are done.');
  return lines.join('\n');
}

/**
 * The exact message grok receives and the record of what PortOS added to the
 * user's prompt (#11317). Shared by the render and the compose preview.
 */
export function grokSentPrompt({ prompt = '', negativePrompt, width, height, aspectRatio, inputImages, initImageStrength, promptAdditions = [] }) {
  // Caller dimensions win (mapped to the closest supported ratio); the saved
  // per-provider default applies when no dimensions were sent; otherwise the
  // tool's own default. Validate the saved value against the known ratios so
  // a hand-edited settings.json can't inject arbitrary prompt text.
  const derived = deriveAspectRatio(width, height);
  const configured = GROK_ASPECT_RATIOS.includes(aspectRatio) ? aspectRatio : null;
  const effectiveRatio = derived || configured;

  const buildWith = (text) => buildGrokPrompt({
    prompt: text, negativePrompt, aspectRatio: effectiveRatio, inputImages, initImageStrength,
  });
  const fullPrompt = buildWith(prompt);
  return {
    fullPrompt,
    effectiveRatio,
    record: sentPromptRecord({ sentPrompt: fullPrompt, carried: carriedPromptAdditions({ promptAdditions }),
      added: [agentInstructionsAddition('Grok image tool instructions', buildWith)] }),
  };
}

// `initImageStrength` maps to a fidelity phrase (grok's image_edit has no
// numeric denoise knob, same constraint as codex).
export const generateImage = (params) => runner.preparations.run(params, generateImagePrepared);

async function generateImagePrepared({
  promptAdditions = [],
  grokPath, aspectRatio, prompt = '', width, height, negativePrompt,
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

  // Re-anchors every path to the allowed input roots (so no caller can point
  // grok's image_edit at an arbitrary local file) and caps the list — see
  // inputImages.js.
  const inputImages = resolveInputImages({
    mode: IMAGE_GEN_MODE.GROK, initImagePath, referenceImagePaths,
  });

  // An empty prompt is fine when an input image is present; a pure
  // text-to-image grok render still needs one. The per-provider rule lives on
  // the provider spec — see cloudPromptRequired.
  if (cloudPromptRequired(IMAGE_GEN_MODE.GROK, inputImages.paths.length > 0) && !prompt?.trim()) {
    throw new ServerError('Prompt is required', { status: 400, code: 'VALIDATION_ERROR' });
  }

  const jobId = providedJobId || randomUUID();
  const filename = `${jobId}.png`;
  // Grok writes into a per-job tmp scratch dir, not straight into the
  // gallery — a failed/partial run must never leave junk where the gallery
  // scanner or a concurrent client can see it, and the dir doubles as the
  // child's cwd (see the containment note in the module header). Every
  // terminal path removes the whole dir.
  const scratchDir = join(tmpdir(), `portos-grok-${jobId}`);
  const stagingPath = join(scratchDir, OUTPUT_NAME);

  // Before registration, clean up here if reference validation or staging fails.
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  try {
    const reviewedReferenceBytes = await assertSnapshotForAdapter(reviewedReferenceSnapshot, jobId, inputImages.initPath, inputImages.referencePaths);
    await stageCliPromptImages({ paths: inputImages.paths, scratchDir, reviewedReferenceBytes });
  } catch (error) {
    await runner.removeScratchDirectory(scratchDir);
    throw error;
  }

  const { fullPrompt, effectiveRatio, record: sentRecord } = grokSentPrompt({
    prompt, negativePrompt, width, height, aspectRatio, inputImages, initImageStrength, promptAdditions,
  });

  // No model arg — grok's image tools run on xAI's fixed image backend and
  // the agent model is whatever the local `grok` install defaults to (see
  // server/lib/grok.js: PortOS does not pick a grok model).
  const baseArgs = ensureGrokHeadlessArgs([], null);

  const meta = {
    id: jobId, prompt: prompt.trim(), negativePrompt: negativePrompt || '',
    width: width ? Number(width) : null, height: height ? Number(height) : null,
    filename, mode: IMAGE_GEN_MODE.GROK,
    inputProvenance: CLI_IMAGE_INPUT_PROVENANCE[IMAGE_GEN_MODE.GROK],
    initImageFilename: inputImages.initPath ? basename(inputImages.initPath) : null,
    referenceImageFilenames: inputImages.referencePaths.map(path => basename(path)),
    ...(visualConditioning ? { visualConditioning } : {}),
    ...sentRecord,
    ...(effectiveRatio ? { aspectRatio: effectiveRatio } : {}),
    createdAt: new Date().toISOString(),
  };
  const job = await runner.registerJob({ meta, renderStartedAtMs, scratchDir });
  runner.run(job, {
    bin: grokPath || undefined, scratchDir, meta, cleanC2PA, denoise,
    prepareAttempt: () => {
      const { args, cleanup, useStdin } = prepareGrokPromptFile(baseArgs, fullPrompt);
      return {
        args,
        cleanup: () => cleanup({ throwOnError: true }),
        stdin: useStdin ? fullPrompt : undefined,
        discover: ({ stdoutTail }) => runner.discoverStagedImage({
          stagingPath, harvestTimeoutMs, scratchDir, toolName: grokImageTool(inputImages.paths.length > 0),
          noImageReason, stdoutTail,
        }),
      };
    },
    async recordUsage(renderMeta) {
      const { recordGrokImageUsage } = await import('../grokMediaUsage.js');
      await recordGrokImageUsage({
        jobId, createdAt: renderMeta.createdAt,
        inputImages: (inputImages.initPath ? 1 : 0) + inputImages.referencePaths.length,
      });
    },
  });

  return {
    jobId, filename, path: `/data/images/${filename}`, generationId: jobId,
    mode: IMAGE_GEN_MODE.GROK,
    // Async callers gate UI state on `status`; without 'running' they flip
    // to 'done' before the PNG lands. SSE / socket 'completed' fires later.
    status: 'running',
  };
}

export const _internals = {
  harvestStagedImage,
  deriveAspectRatio,
  buildGrokPrompt,
  setHarvestTimeoutForTests: (timeoutMs = DEFAULT_HARVEST_TIMEOUT_MS) => {
    harvestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_HARVEST_TIMEOUT_MS;
  },
};
