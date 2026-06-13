// Shared parsing of huggingface_hub gated-access error text. Both the image
// runner (server/services/imageGen/local.js) and the LoRA trainer
// (server/services/loraTraining/failure.js) hit gated-repo failures and want
// to deep-link the user to the model's license page — so the `owner/name`
// extraction lives here once instead of being re-regexed per subsystem.
//
// Pure, no side effects.

// Matches the gated-access message shapes every runner emits:
//   "Access to model <repo> is restricted …"   (mflux wrapper / hub GatedRepoError prose)
//   "Access to <repo> is restricted. Visit …"   (torch _runner_common, no "model")
//   "Cannot access gated repo for url https://huggingface.co/<repo>/…"
//   any "…huggingface.co/<owner>/<repo>…" URL  (the torch message's "Visit <url>")
// `model` is optional; the bare `huggingface.co/` branch catches the URL forms.
// The optional backtick tolerates markdown-wrapped repo ids; the trailing
// `.git` strip normalizes clone-style refs. extractGatedRepo is only called
// once a failure is already classified as gated, so matching a HF URL here is
// the gated repo by construction (no false-positive risk on benign output).
export const GATED_REPO_RE = /(?:Access to (?:model )?|huggingface\.co\/)`?([\w.-]+\/[\w.-]+)/i;

export function extractGatedRepo(text = '') {
  const match = String(text).match(GATED_REPO_RE);
  return match ? match[1].replace(/\.git$/, '') : null;
}
