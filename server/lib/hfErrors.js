// Parse huggingface_hub gated-access errors: `isGatedRepoError(text)` classifies a failure as gated
// (403/restricted), `extractGatedRepo(text)` → `owner/name` (or null) for the UI's license deep-link.
//
// Shared by the image runner, MIDI transcription and the LoRA trainer. Pure.

// Gated message shapes: "Access to [model] <repo> is restricted", "Cannot access gated repo for url
// https://huggingface.co/<repo>/…", or any huggingface.co/<owner>/<repo> URL (backticks tolerated).
// Only called on already-gated failures, so matching an HF URL is the gated repo by construction.
export const GATED_REPO_RE = /(?:Access to (?:model )?|huggingface\.co\/)`?([\w.-]+\/[\w.-]+)/i;

export function extractGatedRepo(text = '') {
  const match = String(text).match(GATED_REPO_RE);
  return match ? match[1].replace(/\.git$/, '') : null;
}

// A *gated-access* failure (403 on a restricted repo). Deliberately narrow (no bare "403 Client Error",
// which fires on unrelated auth failures) so `extractGatedRepo` only runs on gated errors; the LoRA
// trainer keeps its own HF_AUTH_RE to also match bare 401.
export const GATED_ERROR_RE = /GatedRepoError|Access to (?:model )?[\w.@/-]+ is restricted|Cannot access gated repo|Repo.*is gated/i;

export function isGatedRepoError(text = '') {
  return GATED_ERROR_RE.test(String(text));
}
