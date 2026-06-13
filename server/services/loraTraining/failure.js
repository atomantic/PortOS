/**
 * Trainer failure classification — pure. Maps a dead child's stderr tail +
 * exit code/signal (+ any USER_ERROR the line handler captured) to a
 * stable `{ code, message }` the run record and SSE error frame carry.
 */

import { extractGatedRepo } from '../../lib/hfErrors.js';

const OOM_RE = /MPS backend out of memory|CUDA out of memory|Insufficient Memory|Metal.*out of memory|std::bad_alloc/i;
const MODULE_NOT_FOUND_RE = /ModuleNotFoundError|No module named/i;
const HF_AUTH_RE = /GatedRepoError|401 Client Error|Repo.*is gated|Access to model .* is restricted|Cannot access gated repo/i;
// argparse rejecting the trainer's flags / model choice → the installed mflux
// predates FLUX.2 LoRA training (0.12.x wants `--train-config`, has no flux2
// base models). This is the failure that surfaced as a bare "exited with code 2".
// The wrapper deliberately does NOT emit a USER_ERROR for this (which would
// short-circuit below on the raw argparse text); the raw line rides the
// trainer's stderr tail-replay here so this is the single source of the
// actionable upgrade message. See train_mflux_lora.py FATAL_PATTERNS.
const CLI_MISMATCH_RE = /unrecognized arguments|invalid choice|the following arguments are required|mflux-train: error/i;

export function classifyTrainingFailure({ stderrTail = [], exitCode = null, signal = null, userError = null } = {}) {
  const tail = stderrTail.join('\n');
  if (userError?.message) {
    // Runners label gated-repo failures differently: the mflux wrapper sniffs
    // FATAL_PATTERNS and emits USER_ERROR:HF_AUTH:…, while the torch
    // _runner_common walks the exception chain and emits USER_ERROR:gated_repo:….
    // Normalize both to HF_AUTH so the UI's single gated branch (errorCode ===
    // 'HF_AUTH') and the repo deep-link fire regardless of runtime.
    const code = userError.kind === 'gated_repo' ? 'HF_AUTH' : (userError.kind || 'DATASET_ERROR');
    const result = { code, message: userError.message };
    // The trainer re-emits the raw gated-repo stderr line in the USER_ERROR
    // message, so the repo is usually already there; fall back to the tail.
    if (code === 'HF_AUTH') result.repo = extractGatedRepo(userError.message) || extractGatedRepo(tail);
    return result;
  }
  if (OOM_RE.test(tail)) {
    return {
      code: 'OOM',
      message: 'Training ran out of memory — lower the resolution (512), reduce rank, or switch to a smaller base model.',
    };
  }
  if (MODULE_NOT_FOUND_RE.test(tail)) {
    return {
      code: 'MODULE_NOT_FOUND',
      message: 'Python environment is missing training packages — re-run `bash scripts/setup-image-video.sh` to repair the venv.',
    };
  }
  if (HF_AUTH_RE.test(tail)) {
    const repo = extractGatedRepo(tail);
    return {
      code: 'HF_AUTH',
      message: repo
        ? `Hugging Face denied access to ${repo} — accept its license at huggingface.co, then retry.`
        : 'Hugging Face rejected the model download — set your HuggingFace token and accept the model license on huggingface.co.',
      repo,
    };
  }
  if (CLI_MISMATCH_RE.test(tail)) {
    return {
      code: 'CLI_MISMATCH',
      message: 'The mflux trainer rejected its arguments — your installed mflux is too old for FLUX.2 LoRA training. Upgrade with `pip install -U "mflux>=0.17"` (or re-run `bash scripts/setup-image-video.sh`).',
    };
  }
  if (signal === 'SIGKILL') {
    return {
      code: 'KILLED',
      message: 'Trainer was killed (likely the OS reclaiming memory) — lower resolution/rank or free up RAM.',
    };
  }
  const lastLines = stderrTail.slice(-5).join(' · ');
  return {
    code: 'TRAINING_FAILED',
    message: `Training exited with code ${exitCode ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}${lastLines ? ` — ${lastLines}` : ''}`.slice(0, 1000),
  };
}
