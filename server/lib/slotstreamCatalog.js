/**
 * Which checkpoints Slotstream is offered, and which files of one are fetched.
 *
 * this answers which mixture-of-experts checkpoints are worth streaming from SSD, and which files of the picked Hugging Face repo belong in the cache). Pure: no network or filesystem; `services/slotstreamModelManager.js` does the fetching and writing, so the selection rules test against a plain sibling list.
 */

import { HF_REPO_ID_RE } from './huggingfaceLora.js';

/**
 * Curated streaming candidates. Streaming pays off only on a mixture-of-experts checkpoint (bytes dominated by routed experts, a handful active per token, so a fixed cache slot pool serves a model many times larger than RAM); a dense checkpoint would stream every byte of every layer per token and crawl,
 * hence a curated list, not an open HF search. `approxBytes` is a display hint only (the real size is read from the Hub at preview time, so a repo that grows can't make PortOS under-reserve disk).
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

/** The cache subdirectory one repo occupies. The directory NAME is the id `listSlotstreamCachedModels` reports and a start hands `--model`, so it must be ONE path segment (a literal `owner/name` would nest and make the cache walk report the owner as the checkpoint); the repo id carries exactly one `/`, so flattening it is lossless and stable. */
export const slotstreamModelDirName = (repo) => String(repo).replace('/', '__');

// Formats a Slotstream/MLX-style checkpoint directory is made of: `.safetensors` weights plus small config and tokenizer files.
const KEEP_FILE_RE = /\.(safetensors|json|txt|model|jinja|tiktoken)$/i;

// Repos mirror the SAME weights in formats this runtime never loads (PyTorch `.bin`/`.pth`, GGUF, ONNX) or ship an `original/` copy; fetching those can double or triple a 100 GB+ pull, so they're dropped even if the extension passes.
const SKIP_PATH_RE = /(^|\/)(original|onnx|openvino|coreml)\//i;

/**
 * The repo-relative files a checkpoint download should fetch, in a stable order. Rejects any name that isn't a plain relative path (an absolute path or `..` segment from the Hub must not steer a write out of the checkpoint directory).
 *
 * @param {Array<string|{rfilename?: string}>} siblings
 * @returns {string[]}
 */
export function selectSlotstreamRepoFiles(siblings) {
  const names = (Array.isArray(siblings) ? siblings : [])
    .map((row) => (typeof row === 'string' ? row : row?.rfilename))
    .filter((name) => typeof name === 'string' && name);

  // De-duplicated: a repeated sibling would count twice toward the size the user approves and be fetched twice.
  return [...new Set(
    names
      // Split on BOTH separators: a `..\` segment isn't a traversal on the supported platform, but the guard shouldn't depend on the platform it runs on.
      .filter((name) => !/^[/\\]/.test(name) && !name.split(/[/\\]/).includes('..'))
      .filter((name) => KEEP_FILE_RE.test(name) && !SKIP_PATH_RE.test(name)),
  )].sort();
}
