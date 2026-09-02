/**
 * The `.env` half of provisioning the vLLM Qwen3.8-27B compose project.
 *
 * `vllmQwenProject.js` answers "is this project prepared?" by reading directory
 * entries. This module answers the next question — "what must its `.env` say
 * before `docker compose build` is worth running?" — and nothing else: it
 * generates the container's API key, decides which variables this host needs,
 * and merges them into whatever `.env` is already there.
 *
 * **Every value here is load-bearing, and each one fails somewhere other than
 * its cause** (`docs/research/2026-08-21-qwen38-rtx3090-vllm.md` is the record
 * of finding each by hitting it):
 *
 *   - `EXTRA_ARGS` — vLLM rejects the agent's very first turn without a tool-call
 *     parser, and with the WRONG parser it starts, answers, and silently never
 *     emits a tool call — Qwen3.8 writes XML where the plausible-looking choice
 *     expects JSON. The spelling comes from `qwenAgentParsers.js`, which owns it
 *     for every runtime and explains why; this module must not re-type it.
 *   - `VLLM_WSL2_ENABLE_PIN_MEMORY=1` — vLLM disables pinned host memory on WSL,
 *     its GPU model runner needs UVA buffers that require it, and compose's
 *     `unless-stopped` turns the resulting `RuntimeError: UVA is not available`
 *     into a quiet crash-loop rather than one visible failure.
 *   - `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:False` — expandable segments
 *     need CUDA VMM APIs WSL2 only partly implements, so weight loading dies
 *     inside `gptq_marlin_repack` with what reads as an out-of-memory error and
 *     is not one.
 *
 * **Merging is additive, never destructive.** An operator who already tuned
 * `GPU_UTIL`, `DFLASH_TOKENS`, or their own `VLLM_API_KEY` keeps every one of
 * them; only keys the file does not already mention are appended. That is the
 * same shape `scripts/setup-data.js` uses for seeded JSON, and it is why the
 * generated key is a *fallback*: `mergeEnvFileContents` reports the values that
 * ended up in effect, so the caller propagates the key the container will
 * actually use rather than the one it happened to generate.
 */

import { randomBytes } from 'crypto';

import { vllmExtraArgs } from './qwenAgentParsers.js';
import { escapeRegExp } from './textUtils.js';

/** Bytes of entropy in a generated key — matches the doc's `openssl rand -hex 24`. */
const API_KEY_BYTES = 24;

/** The variable the container reads its bearer token from. */
export const VLLM_API_KEY_VAR = 'VLLM_API_KEY';

/**
 * A fresh bearer token for the container. Hex rather than base64 so it survives
 * an unquoted `.env` line, a compose interpolation, and an `Authorization`
 * header without any escaping.
 */
export const generateVllmApiKey = () => randomBytes(API_KEY_BYTES).toString('hex');

/**
 * Whether this PortOS is driving a WSL2-hosted engine, and therefore needs the
 * two mandatory WSL2 variables above.
 *
 * The feature doc's shell snippet tests `/proc/version` for `microsoft`, which
 * is correct for an operator typing inside the distro. It is NOT sufficient
 * here: PortOS commonly runs as a native Win32 process driving Docker Desktop,
 * whose engine is a WSL2 VM — there is no `/proc/version` to match, and omitting
 * the two variables on that host produces exactly the silent crash-loop they
 * exist to prevent. So win32 counts too, and the file read is what covers a
 * PortOS running inside the distro itself.
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
    // The parser spelling is NOT re-typed here. `qwenAgentParsers.js` (#4778)
    // owns it precisely because two runtimes need two different spellings for
    // the same model family, and copying the wrong one fails silently.
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
 * Which keys a `.env` already mentions.
 *
 * Deliberately keyed on *mention*, not on truthiness: a commented-out key is
 * treated as absent (it is not in effect), while a key set to the empty string
 * is treated as present, because an operator who wrote `EXTRA_ARGS=` meant it.
 * Collapsing those two into one state is the footgun this module exists to
 * avoid — its whole contract is that it never overrules a decision already in
 * the file.
 *
 * @param {string} contents
 * @returns {Map<string, string>} key → value, with surrounding quotes stripped
 */
export function parseEnvContents(contents) {
  const found = new Map();
  for (const line of String(contents || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // First mention wins, matching how a shell sourcing the file top-to-bottom
    // would NOT — but compose reads the last one. Either way the value is the
    // operator's, and this module only needs to know it must not add the key.
    if (!found.has(key)) found.set(key, value);
  }
  return found;
}

/**
 * Add lines to the end of a `.env`, or return it unchanged when there are none.
 *
 * The separator is the whole point: a file not ending in a newline would splice
 * the first new key onto the operator's last line and silently corrupt both.
 * Shared by the two writers below so that guard is written once.
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

/**
 * Set ONE key, replacing the line that already declares it.
 *
 * The complement of `mergeEnvFileContents`: that one is additive by contract and
 * never overrules the operator, which is exactly wrong for a value PortOS owns
 * and re-derives (`vllmQwenProject.js`'s recorded project directory). Everything
 * else in the file is left byte for byte.
 *
 * The replacement is a FUNCTION, not a string. A value carrying one of
 * String.replace's special $-patterns would otherwise be expanded into the
 * surrounding text instead of written literally — `scripts/lib/envFile.js`
 * learned that on a password, and this is the same fix kept next to the parser
 * it belongs with.
 *
 * @param {string} contents
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function upsertEnvLine(contents, key, value) {
  const text = String(contents || '');
  const pattern = new RegExp(`^${escapeRegExp(key)}=.*$`, 'm');
  return pattern.test(text)
    ? text.replace(pattern, () => `${key}=${value}`)
    : appendEnvLines(text, [`${key}=${value}`]);
}

/**
 * Append the missing defaults to an existing `.env`, changing nothing else.
 *
 * @param {string} existing - current file contents (`''` when there is no file)
 * @param {Array<[string, string]>} defaults - from `vllmEnvDefaults`
 * @returns {{contents: string, added: string[], kept: string[], effective: Record<string, string>}}
 *   `added`/`kept` are key NAMES only, so a caller can log them; `effective` is
 *   what the container will read, and holds the secret.
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
 * The `.wslconfig` ceiling `prepare` needs.
 *
 * The requantization step holds a whole 2.5 GB shard plus several float32 copies
 * of a 248k-row `lm_head`, and WSL2 defaults its VM to half the host's RAM. Below
 * this the step is SIGKILLed and reports only `Killed` / exit 137 — a symptom
 * that names nothing about WSL. PortOS never raises the ceiling itself: that
 * means editing `%UserProfile%\.wslconfig` and running `wsl --shutdown`, which
 * takes the whole VM down including a PostgreSQL container this install may be
 * using.
 */
export const WSL2_PREPARE_MIN_BYTES = 24 * 1024 * 1024 * 1024;

/** The block to paste, named in the warning so the fix is copy-pasteable. */
export const WSL2_PREPARE_CONFIG_HINT =
  'Give the WSL2 VM ~24 GB in %UserProfile%\\.wslconfig ([wsl2] memory=24GB, swap=16GB) and run `wsl --shutdown` for it to take effect — stop your containers first, that takes the whole VM down.';
