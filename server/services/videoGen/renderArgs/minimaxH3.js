import { totalmem } from 'os';
import { ServerError } from '../../../lib/errorHandler.js';
import { miniMaxH3SpeedProfileDeclineReason } from '../../../lib/minimaxH3SpeedProfiles.js';
import { minimaxH3ControlError } from '../minimaxH3Controls.js';
import {
  MINIMAX_H3_HOST_RESERVE_GB,
  miniMaxH3MemoryDeclineReason,
  miniMaxH3MemoryProfiles,
  selectMiniMaxH3MemoryProfile,
} from '../../../lib/minimaxH3Memory.js';
import {
  MINIMAX_H3_VENV_PYTHON,
  MINIMAX_H3_HELPER_SCRIPT,
  MINIMAX_H3_REPO_DIR,
  MINIMAX_H3_ENCODER_SHIM_DIR,
  MINIMAX_H3_PROMPT_EMBEDDING_CACHE_DIR,
  MINIMAX_H3_EXPECTED_REVISION,
  MERE_RUN_BIN,
  MINIMAX_H3_REF2VA_HELPER_SCRIPT,
  MINIMAX_H3_CUDA_VENV_PYTHON,
  MINIMAX_H3_CUDA_HELPER_SCRIPT,
  MINIMAX_H3_CUDA_OFFLOAD_PROFILES,
  assertByovRuntimeInstalled,
} from '../runtimes.js';
import { assertRenderModeContract } from '../modeContract.js';

// Everything every H3 builder must clear before it starts assembling argv:
// the venv is installed, the mode/source combination is legal, H3's fixed
// controls were not overridden, and the entry carries its pin. The two lanes
// had carried byte-identical copies of all four — the same shape that put the
// control checks in `minimaxH3Controls.js` in the first place — so a field
// added to `assertRenderModeContract` can no longer be threaded into one H3
// runner and forgotten in the other. `repoLabel` is the only real difference:
// the MLX entry pins a *transformer* repo, the CUDA entry the model repo.
const assertMiniMaxH3Preflight = ({
  runtimeId, repoLabel, model, mode, sourceImagePath, lastImagePath, keyframes,
  extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths,
  negativePrompt, disableAudio, tiling, numFrames, fps,
}) => {
  assertByovRuntimeInstalled(runtimeId);
  assertRenderModeContract({
    model,
    mode,
    sourceImagePath,
    lastImagePath,
    keyframes,
    extendFromVideoPath,
    audioFilePath,
    audioStartSec,
    icReferencePaths,
  });
  const controlError = minimaxH3ControlError({ model, negativePrompt, disableAudio, tiling, numFrames, fps });
  if (controlError) throw controlError;
  if (typeof model.repo !== 'string' || typeof model.revision !== 'string') {
    throw new ServerError(
      `MiniMax H3 model "${model.id}" is missing its pinned ${repoLabel}.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  // Capacity, before anything is spawned (issue #5420). H3's components fit
  // nowhere unassisted, so a box below every declared placement profile is not
  // a slow render — it is a multi-hour load that OOMs at the far end, after the
  // job has already taken the queue. A 400 here names the shortfall while the
  // user is still looking at the form. `null` when the host was not measured,
  // which defers to the runner's own check rather than blocking.
  const memoryDecline = miniMaxH3MemoryDeclineReason({
    model,
    modelId: model.id,
    totalMemoryGb: totalmem() / 1024 ** 3,
  });
  if (memoryDecline) throw new ServerError(memoryDecline.message, { status: 400, code: memoryDecline.code });
};

// The capacity contract every H3 runner is handed: the host floor below which
// NO declared placement profile can run, and the reserve PortOS holds back for
// the OS. Sent as argv rather than left to each runner's own constants so the
// server-side gate above and the runner-side enforcement cannot state different
// numbers. The floor is the SMALLEST across the entry's profiles, not the one
// the host-side selection landed on: on the CUDA lane the runner picks the tier
// from VRAM (the only side that can see the device), so a floor taken from a
// richer tier would reject a box that can in fact run a leaner one.
const miniMaxH3HostMemoryArgs = (model) => {
  const floors = miniMaxH3MemoryProfiles(model)
    .map((profile) => Number(profile.minMemoryGb))
    .filter((floor) => Number.isFinite(floor) && floor > 0);
  if (floors.length === 0) return [];
  return [
    '--min-system-memory-gb', String(Math.min(...floors)),
    '--memory-headroom-gb', String(MINIMAX_H3_HOST_RESERVE_GB),
  ];
};

// Build args for PipeNetwork's pinned MiniMax H3 MLX port. The helper resolves
// only exact, already-cached HF revisions; every network download remains an
// explicit Video Gen UI action guarded by the model's terms acknowledgement.
export const buildMiniMaxH3Args = ({ historyContext, speedProfile, model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths, mode, tiling, disableAudio, outputPath, previewDir, loras, textEncoder }) => {
  assertMiniMaxH3Preflight({
    runtimeId: 'minimax_h3',
    repoLabel: 'transformer repo or revision',
    model, mode, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath,
    audioFilePath, audioStartSec, icReferencePaths,
    negativePrompt, disableAudio, tiling, numFrames, fps,
  });
  const checkpoint = Array.isArray(model.requiredWeights) ? model.requiredWeights[0] : null;
  const files = Array.isArray(checkpoint?.files) ? checkpoint.files : [];
  if (!checkpoint?.repo || !checkpoint?.revision || files.length === 0) {
    throw new ServerError(
      `MiniMax H3 model "${model.id}" is missing its pinned upstream checkpoint files.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  const args = [
    MINIMAX_H3_HELPER_SCRIPT,
    '--runtime-dir', MINIMAX_H3_REPO_DIR,
    '--runtime-revision', MINIMAX_H3_EXPECTED_REVISION,
    '--model-repo', model.repo,
    '--model-revision', model.revision,
    '--checkpoint-repo', checkpoint.repo,
    '--checkpoint-revision', checkpoint.revision,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--steps', String(steps),
    '--seed', String(seed),
    '--output', outputPath,
    ...miniMaxH3HostMemoryArgs(model),
    // Reusable prompt embeddings (#5443). The runner keys entries on the prompt
    // plus the content digest of each conditioning image, so a re-render of the
    // same request skips the Qwen3-VL conditioning pass while a different image
    // under the same prompt still gets its own. Always passed: an unwritable or
    // corrupt cache degrades to a plain recompute inside the runner.
    '--prompt-embedding-cache-dir', MINIMAX_H3_PROMPT_EMBEDDING_CACHE_DIR,
  ];
  // The MLX lane's placement is unified-memory only, so the server picks the
  // profile and the runner enforces its limit against the machine's own RAM.
  // (The CUDA lane is the opposite: the tier is VRAM-driven, so it stays the
  // runner's call and rides on --offload-profile instead.)
  const mlxProfile = selectMiniMaxH3MemoryProfile({ model, totalMemoryGb: totalmem() / 1024 ** 3 }).profile;
  if (mlxProfile) args.push('--memory-profile', mlxProfile.id);
  if (previewDir) args.push('--preview-dir', previewDir);
  for (const file of files) args.push('--checkpoint-file', file);
  // Anchor order is packed order: the helper stretches the FIRST keyframe onto
  // the canvas as the geometry anchor, so a first-frame image must lead.
  if (historyContext) args.push('--source-video', historyContext.sourceVideoPath,
    '--history-end-frame', String(historyContext.endFrame), '--history-frames', String(historyContext.frames));
  if (sourceImagePath) args.push('--image', sourceImagePath, '--anchor', 'first');
  if (lastImagePath) args.push('--image', lastImagePath, '--anchor', 'last');
  // Runtime (never fused) application — each --lora needs its own --lora-scale,
  // in the same order, mirroring the --image/--anchor pairing above. buildArgs
  // has already rejected LoRAs unless the probe proved this checkout plus the
  // PortOS adapter can apply them to the quantized DiT (see runtimes.js
  // `loraProbeArgs`).
  if (speedProfile) {
    const reason = miniMaxH3SpeedProfileDeclineReason({ model, profileId: speedProfile.id, mode,
      width, height, steps, keyframes, lastImagePath, extendFromVideoPath, audioFilePath });
    if (reason) throw new ServerError(reason.message, { status: 400, code: reason.code });
    if (!speedProfile.adapterPath) {
      throw new ServerError('LightX2V adapter was not resolved from the pinned cache.', { status: 400, code: 'MINIMAX_H3_SPEED_WEIGHTS_NOT_CACHED' });
    }
    args.push('--speed-profile', speedProfile.id, '--speed-adapter', speedProfile.adapterPath);
  }
  for (const l of loras ?? []) args.push('--lora', l.path, '--lora-scale', String(l.strength));
  // Substituted prompt conditioner (lib/videoTextEncoders.js). Absent for the
  // stock choice, so the argv of an unswapped render is byte-identical to what
  // it was before this feature existed. `textEncoder.paths` were already
  // resolved against the HF cache by generateVideo — the helper never downloads.
  // One --text-encoder-file per shard; the shim links them all into the same
  // `text_encoder/`, which the loader globs.
  if (textEncoder) {
    args.push('--text-encoder-id', textEncoder.id);
    for (const path of textEncoder.paths) args.push('--text-encoder-file', path);
    args.push('--text-encoder-shim-root', MINIMAX_H3_ENCODER_SHIM_DIR);
    for (const [from, to] of Object.entries(textEncoder.keyPrefixMap || {})) {
      args.push('--text-encoder-key-prefix', `${from}=${to}`);
    }
    // Only for a conditioner published without the final norm — H3 reads the
    // hidden state before it, but the pinned loader builds the full module tree
    // and refuses to load with any parameter missing.
    if (textEncoder.finalNormKey) args.push('--text-encoder-final-norm-key', textEncoder.finalNormKey);
  }
  return { bin: MINIMAX_H3_VENV_PYTHON, args };
};

// Build args for MiniMax H3 on CUDA — diffusers' MiniMaxH3ModularPipeline in a
// pip venv, which is the only H3 path an NVIDIA box has (the MLX port above is
// Apple-Silicon-only). Same cache-only contract: the helper resolves exactly
// the pinned revisions already on disk and never reaches the network, so every
// download stays an explicit, terms-gated Video Gen action.
//
// Unlike the MLX lane this is ONE repo — diffusers' modular layout keeps the
// transformer, conditioner, both VAEs and the schedulers in the model's own
// `repo`, so the file list rides on `repoFiles` and there is no separate
// upstream-checkpoint dependency to resolve.
export const buildMiniMaxH3CudaArgs = ({ historyContext, model, prompt, negativePrompt, width, height, numFrames, fps, steps, seed, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath, audioFilePath, audioStartSec, icReferencePaths, mode, tiling, disableAudio, outputPath, loras, speedProfile }) => {
  assertMiniMaxH3Preflight({
    runtimeId: 'minimax_h3_cuda',
    repoLabel: 'repo or revision',
    model, mode, sourceImagePath, lastImagePath, keyframes, extendFromVideoPath,
    audioFilePath, audioStartSec, icReferencePaths,
    negativePrompt, disableAudio, tiling, numFrames, fps,
  });
  const files = Array.isArray(model.repoFiles) ? model.repoFiles.filter((file) => typeof file === 'string' && file) : [];
  if (files.length === 0) {
    // Fail here rather than let the helper fall back to a repo-wide resolve:
    // `MiniMaxAI/MiniMax-H3` is ~498 GB and holds three layouts, so "load
    // whatever is cached" is not a recoverable default for this model.
    throw new ServerError(
      `MiniMax H3 model "${model.id}" is missing its pinned diffusers component file list.`,
      { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
    );
  }
  const args = [
    MINIMAX_H3_CUDA_HELPER_SCRIPT,
    '--model-repo', model.repo,
    '--model-revision', model.revision,
    '--prompt', prompt,
    '--width', String(width),
    '--height', String(height),
    '--num-frames', String(numFrames),
    '--fps', String(fps),
    '--steps', String(steps),
    '--seed', String(seed),
    '--output', outputPath,
    ...miniMaxH3HostMemoryArgs(model),
  ];
  for (const file of files) args.push('--repo-file', file);
  if (speedProfile) {
    const reason = miniMaxH3SpeedProfileDeclineReason({ model, profileId: speedProfile.id, mode,
      width, height, steps, keyframes, lastImagePath, extendFromVideoPath, audioFilePath });
    if (reason) throw new ServerError(reason.message, { status: 400, code: reason.code });
    if (!speedProfile.adapterPath) {
      throw new ServerError('LightX2V adapter was not resolved from the pinned cache.', { status: 400, code: 'MINIMAX_H3_SPEED_WEIGHTS_NOT_CACHED' });
    }
    args.push('--speed-profile', speedProfile.id, '--speed-adapter', speedProfile.adapterPath);
  }
  for (const lora of loras || []) args.push('--lora', lora.path, '--lora-scale', String(lora.strength));
  // A user-pinned offload recipe from data/media-models.json. Omitted, the
  // helper sizes one from the card's own VRAM — the right default, since the
  // registry entry is shared across every install that syncs it and can't know
  // what GPU is on the other end. Validated here rather than left to the
  // helper's `choices=`: argparse would reject a typo as an opaque non-zero
  // child exit, well after the render was queued.
  if (model.offloadProfile !== undefined && model.offloadProfile !== null && model.offloadProfile !== '') {
    if (!MINIMAX_H3_CUDA_OFFLOAD_PROFILES.includes(model.offloadProfile)) {
      throw new ServerError(
        `MiniMax H3 model "${model.id}" declares an unknown offloadProfile "${model.offloadProfile}"; `
        + `expected one of ${MINIMAX_H3_CUDA_OFFLOAD_PROFILES.join(', ')}.`,
        { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
      );
    }
    args.push('--offload-profile', model.offloadProfile);
  }
  // Anchor order is packed order, same as the MLX lane: diffusers takes the
  // first keyframe as `image` (which sets the canvas) and the last as
  // `last_image`, so a first-frame image must lead.
  if (historyContext) args.push('--source-video', historyContext.sourceVideoPath,
    '--history-end-frame', String(historyContext.endFrame), '--history-frames', String(historyContext.frames));
  if (sourceImagePath) args.push('--image', sourceImagePath, '--anchor', 'first');
  if (lastImagePath) args.push('--image', lastImagePath, '--anchor', 'last');
  return { bin: MINIMAX_H3_CUDA_VENV_PYTHON, args };
};

export const buildMiniMaxH3Ref2vaArgs = ({
  model, ref2vaModelPath, prompt, negativePrompt, width, height, numFrames, fps,
  steps, seed, sourceImagePath, audioFilePath, audioStartSec, mode, tiling,
  disableAudio, outputPath, ffmpegPath, ffprobePath,
}) => {
  assertMiniMaxH3Preflight({
    runtimeId: 'minimax_h3_ref2va',
    repoLabel: 'repo or revision',
    model,
    mode,
    sourceImagePath,
    audioFilePath,
    audioStartSec,
    negativePrompt,
    disableAudio,
    tiling,
    numFrames,
    fps,
  });
  if (!ref2vaModelPath) {
    throw new ServerError(
      `${model.name} is not fully cached. Download or repair it in Video Gen before rendering.`,
      { status: 400, code: 'MINIMAX_H3_REF2VA_MODEL_NOT_CACHED' },
    );
  }
  if (!ffmpegPath || !ffprobePath) {
    throw new ServerError(
      'ffmpeg and ffprobe are required for arbitrary-length MiniMax H3 Ref2VA rendering.',
      { status: 400, code: 'MINIMAX_H3_REF2VA_FFMPEG_REQUIRED' },
    );
  }
  const args = [
    MINIMAX_H3_REF2VA_HELPER_SCRIPT,
    '--runtime-bin', MERE_RUN_BIN,
    '--model-root', ref2vaModelPath,
    '--prompt', prompt,
    '--image', sourceImagePath,
    '--audio', audioFilePath,
    '--width', String(width),
    '--height', String(height),
    '--fps', String(fps),
    '--seed', String(seed),
    '--steps', String(steps),
    '--ffmpeg', ffmpegPath,
    '--ffprobe', ffprobePath,
    '--output', outputPath,
  ];
  if (audioStartSec != null) args.push('--audio-start', String(audioStartSec));
  return { bin: process.execPath, args };
};
