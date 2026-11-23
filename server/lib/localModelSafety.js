/**
 * `localModelSafety`, `ESTABLISHED_MODEL_PUBLISHERS`, `REVIEWED_SECURITY_MODELS` — reduced-safeguard
 * warnings and dated publisher/build provenance.
 *
 * Never a malware-free certification.
 */

/** Publisher provenance is a curation signal, never a malware-free certificate. */
export const ESTABLISHED_MODEL_PUBLISHERS = new Set([
  'ace-step', 'bartowski', 'cohereforai', 'cvssp', 'facebook', 'ggml-org',
  'fdtn-ai', 'google', 'ibm-granite', 'liquidai', 'lmstudio-community', 'meta-llama',
  'microsoft', 'mistralai', 'mlx-community', 'mradermacher', 'nomic-ai',
  'nvidia', 'nousresearch', 'openai', 'openbmb', 'qwen', 'stabilityai', 'thinkingmachines', 'unsloth',
]);

// OrcaRouter and AtomicChat are reviewed for these exact builds, not
// blanket-approved for everything those accounts may publish in the future. See the research note.
export const REVIEWED_SECURITY_MODELS = Object.freeze({
  'orcarouter/Qwen3.8-27B-Uncensored-MLX': {
    revision: '14963e70f886455cf93090ac95bdbf4c8730cbe1',
    checkedAt: '2026-09-06', likes: 1308, downloads: 141300, followers: 1860,
    baseModel: 'Qwen/Qwen3.8-27B',
  },
  'orcarouter/Qwen3.8-27B-Uncensored-GGUF': {
    revision: 'a855f377abf5cbda99a278414466743f427e97c8',
    checkedAt: '2026-09-06', likes: 748, downloads: 287720, followers: 1860,
    baseModel: 'Qwen/Qwen3.8-27B',
  },
  'AtomicChat/Inkling-2-Mini-Uncensored-GGUF': {
    revision: '40886ab636cabb4decf4998224f790b462ab048e',
    checkedAt: '2026-11-22', likes: 421, downloads: 129693, followers: 1596,
    baseModel: 'thinkingmachines/Inkling-2-Mini',
  },
});

export function localModelSafety(repository, tags = []) {
  const repo = String(repository || '').replace(/^(?:https:\/\/huggingface\.co\/|hf\.co\/)/, '').split(/[@:]/)[0];
  const publisher = repo.includes('/') ? repo.split('/')[0].toLowerCase() : null;
  const reducedSafeguards = /uncensored|abliterat|obliterat|heretic/i.test(`${repo} ${tags.join(' ')}`);
  const review = REVIEWED_SECURITY_MODELS[repo] || null;
  return {
    reducedSafeguards,
    publisherReview: review ? 'reviewed-build' : ESTABLISHED_MODEL_PUBLISHERS.has(publisher) ? 'established-publisher' : 'unreviewed',
    provenance: review ? { ...review, repository: repo } : null,
    warning: reducedSafeguards
      ? 'Uncensored / abliterated: safeguards have been reduced. Run carefully in a sandbox without secrets or publishing tools; independently verify findings and remediation.'
      : null,
  };
}
