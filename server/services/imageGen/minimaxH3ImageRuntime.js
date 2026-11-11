/**
 * MiniMax H3-Image on Apple Silicon. Upstream only publishes a CUDA (SGLang)
 * pipeline, so PortOS renders it through its own MLX adapter
 * (`scripts/generate_minimax_h3_image.py`) on the same pinned PipeNetwork H3
 * MLX checkout and venv that H3 video installs. That shared runtime is
 * installed and repaired from the Video Gen runtime installer; the image entry
 * only names it.
 *
 * Weights are pinned file lists (`repoFiles` + `requiredWeights`) because both
 * repos are aggregates: the image repo also carries a diffusers layout, and the
 * H3 video repo carries the whole video stack. The text encoder is the H3 video
 * repo's conditioner, whose blobs are identical to the image release's own.
 */

import { join } from 'node:path';
import { release } from 'node:os';
import { PATHS } from '../../lib/fileUtils.js';
import { isAppleSilicon } from '../../lib/platform.js';
import { ServerError } from '../../lib/errorHandler.js';
import { verifyCachedRepoFiles } from '../../lib/hfCache.js';
import { imageModelDownloadTargets } from '../../lib/mediaModels.js';
import { IMAGE_RUNTIME_REMEDY } from '../../lib/imageRuntimeRemedies.js';

// videoGen/runtimes.js is heavy and resolves paths at load, so it is imported
// only on the paths that need it, never by the modules that merely list models.
const videoRuntimes = () => import('../videoGen/runtimes.js');

/** The shared H3 MLX runtime's interpreter, checkout and pinned revision. */
export async function loadMinimaxH3Runtime() {
  const { MINIMAX_H3_VENV_PYTHON, MINIMAX_H3_REPO_DIR, MINIMAX_H3_EXPECTED_REVISION } = await videoRuntimes();
  return { python: MINIMAX_H3_VENV_PYTHON, repoDir: MINIMAX_H3_REPO_DIR, revision: MINIMAX_H3_EXPECTED_REVISION };
}

export const MINIMAX_H3_IMAGE_SCRIPT = () => join(PATHS.root, 'scripts', 'generate_minimax_h3_image.py');
export const MINIMAX_H3_IMAGE_MAX_REFERENCES = 16;
export const MINIMAX_H3_IMAGE_STEPS = 6;
// The adapter renders on a 32px-aligned same-aspect canvas (enlarged below
// 2048x2048) and resizes back, so any size inside the image route's own pixel
// cap works; only the release's 1:3 to 3:1 aspect range is a real limit.
export const MINIMAX_H3_IMAGE_MAX_ASPECT = 3;

const hostProblem = ({ platform = process.platform, osRelease = release(), appleSilicon } = {}) => {
  if (platform !== 'darwin' || !(appleSilicon ?? isAppleSilicon())) return 'MiniMax H3-Image (MLX) requires an Apple Silicon Mac.';
  if (Number(osRelease.split('.')[0]) < 23) return 'MiniMax H3-Image (MLX) requires macOS 14 or later.';
  return null;
};

export async function minimaxH3ImageWeightsCached(model) {
  const targets = imageModelDownloadTargets(model) || [];
  if (!targets.length) return false;
  const verifies = await Promise.all(targets.map(t => verifyCachedRepoFiles(t.repo, t.only, { revision: t.revision })));
  return verifies.every(v => v.status === 'ok');
}

export async function diagnoseMinimaxH3ImageRuntime(host) {
  const problem = hostProblem(host);
  if (problem) return { readiness: 'unavailable', reason: problem, remedy: { kind: IMAGE_RUNTIME_REMEDY.CHOOSE_MODEL, label: 'Choose a compatible model' } };
  const { isByovRuntimeReady } = await videoRuntimes();
  if (await isByovRuntimeReady('minimax_h3').catch(() => false)) return { readiness: 'ready' };
  return {
    readiness: 'unavailable',
    reason: 'The MiniMax H3 MLX runtime (shared with H3 video) is missing or needs repair.',
    remedy: { kind: IMAGE_RUNTIME_REMEDY.INSTALL_MINIMAX_H3, label: 'Install / repair MiniMax H3 runtime' },
  };
}

export function assertMinimaxH3ImageInputs({ negativePrompt, width, height, steps = null, hasInitImage = false, referenceCount = 0, loraCount = 0, referenceImageStrengths = [] }) {
  const reject = message => { throw new ServerError(message, { status: 400, code: 'MINIMAX_H3_IMAGE_INPUT_UNSUPPORTED' }); };
  if (negativePrompt) reject('MiniMax H3-Image is CFG-distilled and has no negative prompt. Describe the desired scene in the prompt.');
  if (hasInitImage) reject('MiniMax H3-Image edits use reference images. Move the init image into a reference slot; image strength is unavailable.');
  if (loraCount) reject('MiniMax H3-Image does not support LoRAs. Remove them before rendering.');
  if (referenceCount > MINIMAX_H3_IMAGE_MAX_REFERENCES) reject(`MiniMax H3-Image accepts at most ${MINIMAX_H3_IMAGE_MAX_REFERENCES} reference images.`);
  if (referenceImageStrengths.some(value => Number(value) !== 1)) reject('MiniMax H3-Image reference strength is fixed. Remove per-reference strength overrides.');
  const w = Number(width);
  const h = Number(height);
  if (![w, h].every(n => Number.isInteger(n) && n > 0)) reject('MiniMax H3-Image needs a whole-pixel width and height.');
  if (Math.max(w, h) > MINIMAX_H3_IMAGE_MAX_ASPECT * Math.min(w, h)) reject('MiniMax H3-Image supports aspect ratios from 1:3 to 3:1.');
  if (steps != null && Number(steps) !== MINIMAX_H3_IMAGE_STEPS) reject(`MiniMax H3-Image is distilled for exactly ${MINIMAX_H3_IMAGE_STEPS} steps.`);
}

export function minimaxH3ImageRenderArgs(inputs) {
  const { model, prompt, negativePrompt, width, height, steps, seed, outputPath, initImagePath,
    referenceImagePaths = [], referenceImageStrengths = [], loraPaths = [], minimaxRuntime } = inputs;
  assertMinimaxH3ImageInputs({ negativePrompt, width, height, steps, hasInitImage: Boolean(initImagePath),
    referenceCount: referenceImagePaths.length, loraCount: loraPaths.length, referenceImageStrengths });
  const [main, encoder] = imageModelDownloadTargets(model) || [];
  if (!main?.revision || !encoder?.revision || !encoder.only.length || !minimaxRuntime?.python) {
    throw new ServerError('MiniMax H3-Image is missing its pinned weight manifest or runtime.', { status: 500, code: 'MINIMAX_H3_IMAGE_MISCONFIGURED' });
  }
  const args = [MINIMAX_H3_IMAGE_SCRIPT(),
    '--runtime-dir', minimaxRuntime.repoDir, '--runtime-revision', minimaxRuntime.revision,
    '--model-repo', main.repo, '--model-revision', main.revision,
    '--text-encoder-repo', encoder.repo, '--text-encoder-revision', encoder.revision,
    ...encoder.only.flatMap(file => ['--text-encoder-file', file]),
    '--prompt', prompt, '--width', String(width), '--height', String(height),
    '--steps', String(steps ?? MINIMAX_H3_IMAGE_STEPS), '--seed', String(seed), '--output', outputPath,
    ...referenceImagePaths.flatMap(path => ['--reference-image', path])];
  return { bin: minimaxRuntime.python, args, providerInputs: { initImagePath: null, referenceImagePaths } };
}

// Cache-only runner: never hand it an HF credential it must not use.
export function minimaxH3ImageEnv(env = process.env) {
  return { ...env, HF_TOKEN: undefined, HUGGING_FACE_HUB_TOKEN: undefined, HF_HUB_OFFLINE: '1', PYTHONPATH: undefined, PYTHONHOME: undefined, PYTHONNOUSERSITE: '1' };
}
