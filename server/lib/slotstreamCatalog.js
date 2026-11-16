/**
 * Which checkpoints Slotstream is offered, and which files of one are fetched.
 *
 * `slotstreamModels.js` answers "what is on disk and how much memory will a
 * start want". This module answers the question before it: which mixture-of-
 * experts checkpoints are worth streaming from SSD at all, and — once one is
 * picked — which files of that Hugging Face repo actually belong in the cache.
 *
 * Pure on purpose: no network, no filesystem. `services/slotstreamModelManager.js`
 * does the fetching and the disk writing, so the selection rules stay testable
 * against a plain sibling list.
 */

import { HF_REPO_ID_RE } from './huggingfaceLora.js';

/**
 * Curated streaming candidates.
 *
 * The technique only pays off on a mixture-of-experts checkpoint: the bytes are
 * dominated by routed experts, of which a handful are active per token, so a
 * fixed cache slot pool can serve a model many times larger than RAM. A dense
 * checkpoint of the same size would stream every byte of every layer for every
 * token and crawl — which is why this is a curated list rather than an open
 * Hugging Face search. `approxBytes` is a display hint only; the real size is
 * read from the Hub at preview time, so a repo that grows cannot make PortOS
 * under-reserve disk.
 */
export const SLOTSTREAM_CATALOG = Object.freeze([
  Object.freeze({
    id: 'qwen3-235b-a22b-4bit',
    repo: 'mlx-community/Qwen3-235B-A22B-Instruct-2507-4bit',
    label: 'Qwen3 235B-A22B Instruct (4-bit)',
    params: '235B total / 22B active',
    approxBytes: 132 * 1024 ** 3,
    note: 'The headline case: a 235B-class model on a machine with a fraction of that in RAM.',
  }),
  Object.freeze({
    id: 'gpt-oss-120b-mxfp4',
    repo: 'mlx-community/gpt-oss-120b-MXFP4-Q8',
    label: 'GPT-OSS 120B (MXFP4)',
    params: '120B total / 5B active',
    approxBytes: 64 * 1024 ** 3,
    note: 'Roughly half the disk of the 235B and a smaller resident trunk — the gentler first checkpoint.',
  }),
  Object.freeze({
    id: 'qwen3-30b-a3b-4bit',
    repo: 'mlx-community/Qwen3-30B-A3B-4bit',
    label: 'Qwen3 30B-A3B (4-bit)',
    params: '30B total / 3B active',
    approxBytes: 17 * 1024 ** 3,
    note: 'Small enough to verify the whole install end to end before committing to a 100 GB+ pull.',
  }),
]);

/** `owner/name`, the only shape a download is given — see `HF_REPO_ID_RE`. */
export const isSlotstreamRepoId = (value) => typeof value === 'string' && HF_REPO_ID_RE.test(value);

/** The catalog row for a catalog id or a repo id, or null for anything else. */
export function slotstreamCatalogEntry(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) return null;
  return SLOTSTREAM_CATALOG.find((row) => row.id === key || row.repo === key) || null;
}

/**
 * The Hugging Face repo a request names — a catalog id resolves to its repo,
 * and any other value must already be a repo id. Returns null when neither.
 */
export function resolveSlotstreamRepo(value) {
  const entry = slotstreamCatalogEntry(value);
  if (entry) return entry.repo;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return isSlotstreamRepoId(trimmed) ? trimmed : null;
}

/**
 * The cache subdirectory one repo occupies.
 *
 * A checkpoint's directory NAME is the id `listSlotstreamCachedModels` reports
 * and the value a start hands `--model`, so it must be ONE path segment:
 * `owner/name` written literally would nest two levels deep and make the cache
 * walk report the owner as the checkpoint. The repo id carries exactly one `/`
 * (the id rule permits no others), so flattening that single separator is
 * lossless and the same repo always maps to the same directory.
 */
export const slotstreamModelDirName = (repo) => String(repo).replace('/', '__');

// Formats a Slotstream/MLX-style checkpoint directory is made of. `.safetensors`
// is the weights; the rest is config and tokenizer, all small.
const KEEP_FILE_RE = /\.(safetensors|json|txt|model|jinja|tiktoken)$/i;

// Repos routinely mirror the SAME weights in formats this runtime never loads
// (PyTorch `.bin`/`.pth`, GGUF, ONNX) or ship an `original/` copy of them.
// Fetching those can double or triple a 100 GB+ pull for nothing, so they are
// dropped even though they'd pass the extension check on name alone.
const SKIP_PATH_RE = /(^|\/)(original|onnx|openvino|coreml)\//i;

/**
 * The repo-relative files a checkpoint download should fetch, in a stable order.
 *
 * Rejects any name that is not a plain relative path: an absolute path or a
 * `..` segment coming back from the Hub must not be able to steer a write out
 * of the checkpoint directory.
 *
 * @param {Array<string|{rfilename?: string}>} siblings
 * @returns {string[]}
 */
export function selectSlotstreamRepoFiles(siblings) {
  const names = (Array.isArray(siblings) ? siblings : [])
    .map((row) => (typeof row === 'string' ? row : row?.rfilename))
    .filter((name) => typeof name === 'string' && name);

  // De-duplicated: a repeated sibling would otherwise be counted twice toward
  // the size the user approves and fetched twice.
  return [...new Set(
    names
      // Split on BOTH separators: a `..\` segment is not a traversal on the
      // supported platform, but the guard should not be the thing that depends
      // on which platform this runs on.
      .filter((name) => !/^[/\\]/.test(name) && !name.split(/[/\\]/).includes('..'))
      .filter((name) => KEEP_FILE_RE.test(name) && !SKIP_PATH_RE.test(name)),
  )].sort();
}
