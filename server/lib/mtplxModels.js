/**
 * What MTPLX has in its own model cache, and which entry PortOS may serve.
 *
 * `services/localCachedModels.js` owns provider-refresh discovery and gates it on runtime readiness
 * without loading the process manager. `listMtplxCachedModels({command?})` → `{models, error}` from
 * `mtplx models --json` (walks local directories — pulls no weights, loads no model, but see
 * `mtplxRuntime.js`: on an un-warmed Homebrew wrapper the spawn ITSELF is a several-hundred-megabyte
 * runtime download, so poll callers must gate on `describeMtplxRuntime().ready` first)
 * `servableMtplxCachedModels(models)` → the rows MTPLX itself calls complete, and
 * `pickMtplxCachedModel(models)` → the one repo id to hand `mtplx serve --model`. `models: null` means
 * the cache could not be READ (no binary, command failed, unparseable) and is deliberately distinct
 * from `[]` (read, and empty), because `services/localRuntimeSetup.js` starts MTPLX on its own default
 * in the first case and refuses with the `mtplx pull` command in the second. Exists because `mtplx
 * serve` defaults `--model` to one hard-coded checkpoint and exits 1 before binding when that repo is
 * not cached — even on a host holding a different MTP model that serves fine. Picks only entries MTPLX
 * itself calls complete (`validation.ok !== false`, so a half-finished pull is not served), preferring
 * one with a recorded `mtplx_runtime.json` exactness contract. `describeMtplxCache(cache)` → `{state:
 * 'unknown'|'empty'|'partial'|'ready', model, count, error}` folds both into the one value
 * `services/providerReadiness.js` puts on the checklist and `describeRuntimeSetup` picks a button from
 * — so an empty cache is named up front instead of only inside the failure of a Start that could never
 * work.
 *
 * `mtplx serve` takes NO model from its config — the CLI hard-codes its default
 * checkpoint (`Youssofal/Qwen3.8-27B-…`) as the `--model` default. On a machine
 * where that exact repo was never pulled the server prints
 *
 *   error: model is not available locally
 *   detail: … is not cached. Run: mtplx pull …
 *
 * and exits 1 before it binds a port — including when the user HAS pulled a
 * different MTP checkpoint that would have served fine. That is what turned the
 * readiness checklist's "Start MTPLX" button into "MTPLX did not start: mtplx
 * exited early (code 1)".
 *
 * So PortOS asks first. `mtplx models --json` walks local directories — it
 * pulls no weights and loads no model — and naming a cached repo on the command
 * line is the difference between a server that comes up and one that cannot. A
 * start still never downloads weights: a multi-gigabyte pull stays the user's
 * decision, made on a button that says so (`services/localRuntimeSetup.js`'s
 * `pull-start` action), exactly as `docs/features/mtplx.md` promises.
 *
 * **It is NOT free, and it is NOT safe on an un-warmed status poll.** The
 * `mtplx` Homebrew puts on PATH is a wrapper that bootstraps a version-keyed
 * Python venv — several hundred megabytes over the network — on its first
 * invocation, and `brew upgrade` re-arms it. So on such a host THIS spawn is
 * that download: it outruns the timeout below, gets killed, and the next caller
 * starts it over. Callers on a poll must gate on `lib/mtplxRuntime.js`'s
 * `describeMtplxRuntime().ready` first — `services/mtplxServerManager.js` and
 * `services/localRuntimeSetup.js` both do.
 */

import { bufferedSpawn, spawnFailureDetail } from './bufferedSpawn.js';
import { safeJSONParse } from './fileUtils.js';
import { findCommandOnPath } from './processEnv.js';
import { resolveMtplxBinary } from './mtplxRuntime.js';

/** A cache listing walks the model directories to size them; be generous. */
const CACHE_QUERY_TIMEOUT_MS = 30_000;

/**
 * The models in MTPLX's local cache.
 *
 * `models: null` means PortOS could not read the cache at all (no binary, the
 * command failed, unparseable output) — deliberately NOT the same value as
 * `models: []`, which means the cache was read and is empty. The caller starts
 * MTPLX with its own default in the first case and refuses in the second; a
 * shared falsy value would make an unreadable cache look like an empty one and
 * block a start that would have worked.
 *
 * @param {{command?: string}} [options]
 * @returns {Promise<{models: object[]|null, error: string|null}>}
 */
export async function listMtplxCachedModels({ command = 'mtplx' } = {}) {
  const binary = command === 'mtplx' ? resolveMtplxBinary() : findCommandOnPath(command);
  if (!binary) return { models: null, error: `\`${command}\` is not on PortOS's PATH` };

  const result = await bufferedSpawn(binary, ['models', '--json'], { timeoutMs: CACHE_QUERY_TIMEOUT_MS, shell: false });
  if (result.timedOut) return { models: null, error: `\`${command} models\` timed out` };
  if (!result.success) {
    // A spawn failure (EACCES, ENOENT on a dangling symlink) reports nothing on
    // either stream — its reason lives on `error`, and dropping it would leave
    // the user with a bare exit code for a fixable permissions problem.
    return { models: null, error: spawnFailureDetail(result, `\`${command} models\` exited with code ${result.code}`) };
  }

  // Parse from the first brace: MTPLX writes the JSON alone today, but a banner
  // line ahead of it must not read as "nothing is cached".
  const text = String(result.stdout || '');
  const start = text.indexOf('{');
  const parsed = start === -1 ? null : safeJSONParse(text.slice(start), null, { allowArray: false });
  if (!Array.isArray(parsed?.models)) {
    return { models: null, error: `\`${command} models --json\` did not return a model list` };
  }
  return { models: parsed.models, error: null };
}

/**
 * The cache rows MTPLX itself calls complete, in listing order.
 *
 * `validation.ok` is false for a directory missing required files or an MTP
 * sidecar, which is what an interrupted `mtplx pull` leaves behind. That rule
 * decides both what PortOS may START a server on and what it may OFFER as a
 * selectable model, so it lives here once rather than being spelled at each —
 * the shape it reads is upstream's `models --json`, and a second copy would go
 * stale the first time that payload grows a new incompleteness marker.
 *
 * `[]` for a non-array input: callers that must distinguish "could not read the
 * cache" check `listMtplxCachedModels`' own `models: null` before calling.
 *
 * @param {object[]|null|undefined} models - rows from `listMtplxCachedModels`
 * @returns {object[]}
 */
export function servableMtplxCachedModels(models) {
  if (!Array.isArray(models)) return [];
  return models.filter((row) => typeof row?.repo_id === 'string' && row.repo_id !== '' && row?.validation?.ok !== false);
}

/**
 * The cached repo id PortOS should hand `mtplx serve --model`, or null when the
 * cache holds nothing servable.
 *
 * Only entries MTPLX itself calls complete are eligible (see
 * `servableMtplxCachedModels`) — starting the server on a partial pack trades an
 * honest "nothing is cached" for a load failure minutes later. Among complete
 * entries, one carrying `mtplx_runtime.json` wins: that is the recorded
 * exactness contract, and the runtime warns on stats from artifacts without it.
 *
 * @param {object[]|null|undefined} models - rows from `listMtplxCachedModels`
 * @returns {string|null}
 */
export function pickMtplxCachedModel(models) {
  const usable = servableMtplxCachedModels(models);
  const verified = usable.find((row) => row.has_runtime_contract === true);
  return (verified || usable[0])?.repo_id ?? null;
}

/**
 * The one value the readiness checklist and the setup button both key on:
 * can MTPLX serve anything right now, and if not, why not.
 *
 * The checklist used to answer "MTPLX installed ✓ / server not responding ✗ —
 * use Start MTPLX, PortOS does this for you", and Start then failed with "no
 * model weights are cached". Both statements were true and the pair was a
 * catch-22: the blocking fact (an empty cache) was only discoverable by
 * clicking the button that could not work. Reading it up front is what lets the
 * checklist say what is missing and offer the download instead of the start.
 *
 * States are deliberately four, not two — `unknown` (the cache could not be
 * read) must not read as `empty` (read, and nothing is there), for the same
 * reason `listMtplxCachedModels` distinguishes `null` from `[]`; and `partial`
 * (an interrupted `mtplx pull`) needs a different sentence than a cache nobody
 * has ever pulled into.
 *
 * @param {{models: object[]|null, error: string|null}} [cache] - a
 *   `listMtplxCachedModels` result
 * @returns {{state: 'unknown'|'empty'|'partial'|'ready', model: string|null, count: number, error: string|null}}
 */
export function describeMtplxCache({ models, error } = {}) {
  if (!Array.isArray(models)) return { state: 'unknown', model: null, count: 0, error: error || null };
  const model = pickMtplxCachedModel(models);
  if (model) return { state: 'ready', model, count: models.length, error: null };
  return { state: models.length === 0 ? 'empty' : 'partial', model: null, count: models.length, error: null };
}
