/**
 * Trainer failure classification — pure. Maps a dead child's stderr tail +
 * exit code/signal (+ any USER_ERROR the line handler captured) to a
 * stable `{ code, message }` the run record and SSE error frame carry.
 */

const OOM_RE = /MPS backend out of memory|CUDA out of memory|Insufficient Memory|Metal.*out of memory|std::bad_alloc/i;
const MODULE_NOT_FOUND_RE = /ModuleNotFoundError|No module named/i;
const HF_AUTH_RE = /GatedRepoError|401 Client Error|Repo.*is gated|Access to model .* is restricted/i;
// argparse rejecting the trainer's flags / model choice → the installed mflux
// predates FLUX.2 LoRA training (0.12.x wants `--train-config`, has no flux2
// base models). This is the failure that surfaced as a bare "exited with code 2".
const CLI_MISMATCH_RE = /unrecognized arguments|invalid choice|the following arguments are required|mflux-train: error/i;

export function classifyTrainingFailure({ stderrTail = [], exitCode = null, signal = null, userError = null } = {}) {
  if (userError?.message) {
    return { code: userError.kind || 'DATASET_ERROR', message: userError.message };
  }
  const tail = stderrTail.join('\n');
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
    return {
      code: 'HF_AUTH',
      message: 'Hugging Face rejected the model download — set HUGGINGFACE_API_KEY and accept the model license on huggingface.co.',
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
