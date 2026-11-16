/**
 * What MTPLX has in its own model cache, and which entry PortOS may serve.
 *
 * `mtplx serve` hard-codes a default checkpoint and exits 1 before binding a port if that repo was
 * never pulled, even when another usable one is cached, so PortOS names a cached repo via
 * `mtplx models --json` (no weights pulled). A start never downloads weights; the pull stays the
 * user's decision (`services/localRuntimeSetup.js` `pull-start`).
 *
 * **Not safe on an un-warmed status poll.** The Homebrew `mtplx` wrapper bootstraps a Python venv
 * (hundreds of MB) on first run and after `brew upgrade`, outrunning the timeout below. Poll callers
 * must gate on `describeMtplxRuntime().ready` (`lib/mtplxRuntime.js`).
 */

import { bufferedSpawn, spawnFailureDetail } from './bufferedSpawn.js';
import { safeJSONParse } from './fileUtils.js';
import { findCommandOnPath } from './processEnv.js';
import { resolveMtplxBinary } from './mtplxRuntime.js';

/** A cache listing walks the model directories to size them; be generous. */
const CACHE_QUERY_TIMEOUT_MS = 30_000;

/**
 * The models in MTPLX's cache. `models: null` (unreadable) is NOT `[]` (read, empty): the caller
 * starts on MTPLX's own default in the first case and refuses in the second.
 * @param {{command?: string}} [options]
 * @returns {Promise<{models: object[]|null, error: string|null}>}
 */
export async function listMtplxCachedModels({ command = 'mtplx' } = {}) {
  const binary = command === 'mtplx' ? resolveMtplxBinary() : findCommandOnPath(command);
  if (!binary) return { models: null, error: `\`${command}\` is not on PortOS's PATH` };

  const result = await bufferedSpawn(binary, ['models', '--json'], { timeoutMs: CACHE_QUERY_TIMEOUT_MS, shell: false });
  if (result.timedOut) return { models: null, error: `\`${command} models\` timed out` };
  if (!result.success) {
    // A spawn failure (EACCES, dangling symlink) reports on `error`, not the streams; keep that reason.
    return { models: null, error: spawnFailureDetail(result, `\`${command} models\` exited with code ${result.code}`) };
  }

  // Parse from the first brace so a banner line ahead of the JSON doesn't read as "nothing cached".
  const text = String(result.stdout || '');
  const start = text.indexOf('{');
  const parsed = start === -1 ? null : safeJSONParse(text.slice(start), null, { allowArray: false });
  if (!Array.isArray(parsed?.models)) {
    return { models: null, error: `\`${command} models --json\` did not return a model list` };
  }
  return { models: parsed.models, error: null };
}

/**
 * Cache rows MTPLX calls complete (`validation.ok` is false after an interrupted pull); one rule for
 * what a server may START on and what is OFFERED. `[]` for non-array input.
 * @param {object[]|null|undefined} models - rows from `listMtplxCachedModels`
 * @returns {object[]}
 */
export function servableMtplxCachedModels(models) {
  if (!Array.isArray(models)) return [];
  return models.filter((row) => typeof row?.repo_id === 'string' && row.repo_id !== '' && row?.validation?.ok !== false);
}

/**
 * Repo id for `mtplx serve --model`, or null; a complete entry with `mtplx_runtime.json` wins.
 * @param {object[]|null|undefined} models - rows from `listMtplxCachedModels`
 * @returns {string|null}
 */
export function pickMtplxCachedModel(models) {
  const usable = servableMtplxCachedModels(models);
  const verified = usable.find((row) => row.has_runtime_contract === true);
  return (verified || usable[0])?.repo_id ?? null;
}

/**
 * One value for the readiness checklist and setup button. `unknown` (unreadable) is not `empty`, and
 * `partial` (interrupted pull) needs its own message.
 * @param {{models: object[]|null, error: string|null}} [cache] - a `listMtplxCachedModels` result
 * @returns {{state: 'unknown'|'empty'|'partial'|'ready', model: string|null, count: number, error: string|null}}
 */
export function describeMtplxCache({ models, error } = {}) {
  if (!Array.isArray(models)) return { state: 'unknown', model: null, count: 0, error: error || null };
  const model = pickMtplxCachedModel(models);
  if (model) return { state: 'ready', model, count: models.length, error: null };
  return { state: models.length === 0 ? 'empty' : 'partial', model: null, count: models.length, error: null };
}
