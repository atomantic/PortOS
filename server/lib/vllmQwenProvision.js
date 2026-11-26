/**
 * The `.env` half of provisioning the vLLM Qwen3.8-27B compose project: what its `.env` must say before `docker compose build` is worth running (`vllmQwenProject.js` answers "is it prepared?").
 *
 * It generates the container's API key, decides which variables this host needs, and merges them into any existing `.env`. Every value is load-bearing and fails somewhere other than its cause: - `EXTRA_ARGS`: vLLM rejects the first agent turn without a tool-call parser, and the WRONG parser silently never emits a tool call (Qwen3.8 writes XML where the plausible choice expects JSON); the spelling is owned by `qwenAgentParsers.js`; never re-type it here. - `VLLM_WSL2_ENABLE_PIN_MEMORY=1`: vLLM disables pinned host memory on WSL but its GPU runner needs it for UVA buffers, and compose's `unless-stopped` turns `RuntimeError: UVA is not available` into a quiet crash-loop. - `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:False`: expandable segments need CUDA VMM APIs WSL2 only partly implements, so weight loading dies in `gptq_marlin_repack` with an out-of-memory-looking error. **Merging is additive, never destructive** (the shape `scripts/setup-data.js` uses for seeded JSON): an operator's tuned `GPU_UTIL`, `DFLASH_TOKENS` or `VLLM_API_KEY` is kept and only unmentioned keys are appended, so the generated key is a *fallback* and `mergeEnvFileContents` reports the values in effect, letting the caller propagate the key the container actually uses.
 */

import { randomBytes } from 'crypto';

import { vllmExtraArgs } from './qwenAgentParsers.js';
import { parseEnvContents, } from './portosEnv.js';

/** Bytes of entropy in a generated key (the doc's `openssl rand -hex 24`). */
const API_KEY_BYTES = 24;

/** The variable the container reads its bearer token from. */
export const VLLM_API_KEY_VAR = 'VLLM_API_KEY';

/** A fresh bearer token: hex, not base64, so it survives an unquoted `.env` line, compose interpolation and an `Authorization` header unescaped. */
export const generateVllmApiKey = () => randomBytes(API_KEY_BYTES).toString('hex');

/**
 * Whether this PortOS drives a WSL2-hosted engine and so needs the two mandatory WSL2 variables. The feature doc's `/proc/version` `microsoft` test fits an operator inside the distro but not PortOS as a native Win32 process driving
 * Docker Desktop's WSL2 VM (no `/proc/version`), where omitting them gives the silent crash-loop; so win32 counts too, and the file read covers PortOS inside the distro.
 *
 * @param {{platform?: string, procVersion?: string|null}} [host]
 * @returns {boolean}
 */
export function isWsl2Engine({ platform = process.platform, procVersion = null } = {}) {
  if (platform === 'win32') return true;
  return /microsoft/i.test(String(procVersion || ''));
}

/**
 * Every key the provisioning step wants present, in write order.
 *
 * @param {{apiKey: string, wsl2?: boolean}} options
 * @returns {Array<[string, string]>}
 */
export function vllmEnvDefaults({ apiKey, wsl2 = false }) {
  return [
    [VLLM_API_KEY_VAR, apiKey],
    ['SPEC', 'dflash2'],
    ['PREFIX_CACHE', '1'],
    // The parser spelling is NOT re-typed here: `qwenAgentParsers.js` (#4778) owns it because two runtimes need different spellings for one model family and copying the wrong one fails silently.
    ['EXTRA_ARGS', vllmExtraArgs()],
    ...(wsl2
      ? [
        ['VLLM_WSL2_ENABLE_PIN_MEMORY', '1'],
        ['PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:False'],
      ]
      : []),
  ];
}

/**
 * Add lines to the end of a `.env`, or return it unchanged when there are none. The separator matters: a file not ending in a newline would splice the first new key onto the operator's last line.
 *
 * @param {string} base
 * @param {string[]} lines
 * @returns {string}
 */
function appendEnvLines(base, lines) {
  const text = String(base || '');
  if (lines.length === 0) return text;
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  return `${text}${separator}${lines.join('\n')}\n`;
}

// Re-exported from `portosEnv.js` so existing deep imports keep working; new code should import from there.

/**
 * Append the missing defaults to an existing `.env`, changing nothing else.
 *
 * @param {string} existing - current file contents (`''` when there is no file)
 * @param {Array<[string, string]>} defaults - from `vllmEnvDefaults`
 * @returns {{contents: string, added: string[], kept: string[], effective: Record<string, string>}}
 *   `added`/`kept` are key NAMES only (loggable); `effective` is what the container will read and holds the secret.
 */
export function mergeEnvFileContents(existing, defaults) {
  const current = parseEnvContents(existing);
  const added = [];
  const kept = [];
  const effective = {};
  const lines = [];

  for (const [key, value] of defaults) {
    if (current.has(key)) {
      kept.push(key);
      effective[key] = current.get(key);
      continue;
    }
    added.push(key);
    effective[key] = value;
    lines.push(`${key}=${value}`);
  }

  return { contents: appendEnvLines(existing, lines), added, kept, effective };
}

/**
 * The `.wslconfig` ceiling `prepare` needs: requantization holds a whole 2.5 GB shard plus several float32 copies of a 248k-row `lm_head`, and WSL2 defaults its VM to half the host RAM; below this the step is SIGKILLed with only `Killed` / exit 137.
 * PortOS never raises it itself (that edits `%UserProfile%\\.wslconfig` and needs `wsl --shutdown`, taking down the whole VM including a PostgreSQL container).
 */
export const WSL2_PREPARE_MIN_BYTES = 24 * 1024 * 1024 * 1024;

/** The block to paste, named in the warning so the fix is copy-pasteable. */
export const WSL2_PREPARE_CONFIG_HINT =
  'Give the WSL2 VM ~24 GB in %UserProfile%\\.wslconfig ([wsl2] memory=24GB, swap=16GB) and run `wsl --shutdown` for it to take effect — stop your containers first, that takes the whole VM down.';
