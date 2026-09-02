/**
 * MTPLX model catalog — search, download, and remove MTP checkpoints from the UI.
 *
 * `mtplxServerManager.js` owns the *process* (install / start / stop / logs).
 * This module owns the *weights*, which used to be the one part of MTPLX PortOS
 * refused to touch: an empty cache produced a card that told the user to go run
 * `mtplx pull` in a terminal and come back. That is a dead end inside the app —
 * PortOS manages the runtime everywhere else, so it manages the models too.
 *
 * Every operation is a fixed `mtplx` subcommand with `shell: false`; the only
 * request-supplied values that ever reach an argv slot are a repo id (shape-
 * checked before it is passed) and a search string, each as its own element, so
 * no input can become a shell word.
 *
 *   - `searchMtplxCatalog`  → `mtplx forge discover --json` (Hugging Face search)
 *   - `pullMtplxModel`      → `mtplx pull <repo> --progress-json` (NDJSON progress)
 *   - `removeMtplxModel`    → `mtplx remove <repo> --json`
 *
 * A download still is NOT something any other action does silently: it moves
 * tens of gigabytes and only ever runs from a button the user pressed that says
 * so. What changed is that the button now exists.
 */

import { bufferedSpawn, spawnFailureDetail } from '../lib/bufferedSpawn.js';
import { ServerError } from '../lib/errorHandler.js';
import { assessDownloadPreflight, assertDownloadFits } from '../lib/downloadPreflight.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { getHfCacheRoot } from '../lib/hfCache.js';
import { listMtplxCachedModels } from '../lib/mtplxModels.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { fetchRepoPublishedDates } from './huggingFaceCatalog.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';

/** A Hugging Face search is one API call — short, and worth failing fast. */
const SEARCH_TIMEOUT_MS = 30_000;
/** Removing a directory tree is local I/O, but a large pack takes a moment. */
const REMOVE_TIMEOUT_MS = 60_000;
/**
 * A model pull moves tens of gigabytes. Sized for a slow domestic line rather
 * than a fast one — a bound that kills a download at 90% is worse than no bound
 * at all. Mirrors `services/localRuntimeSetup.js`'s own weights budget.
 */
const PULL_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * `owner/name`, the only shape `mtplx pull` and `mtplx remove` are given.
 *
 * Both accept a bare URL too, but PortOS deliberately does not: the search
 * results it renders carry repo ids, and refusing everything else keeps a
 * hand-typed value from becoming a path or a flag (a leading `-` would be read
 * as an option by argparse). Each segment must START alphanumeric, so `owner/..`
 * cannot reach the cache walk either.
 *
 * Deliberately identical to `localLlmMtplxPullSchema`'s regex in
 * `lib/mediaValidation.js`: the route validates and this re-validates, and a
 * looser guard here would be a hole for any caller that isn't that route.
 */
const REPO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const isMtplxRepoId = (value) => typeof value === 'string' && REPO_ID_RE.test(value);

// MTPLX's own Python venv pulls checkpoints via huggingface_hub (see
// docs/features/mtplx.md), landing them in the standard HF hub cache — NOT
// necessarily the boot disk. getHfCacheRoot() honors the same
// HF_HUB_CACHE/HF_HOME overrides ollamaManager/lmStudioManager already do,
// so a "weights on an external SSD" setup gets checked against the volume
// the pull actually lands on.
const mtplxCachePath = () => getHfCacheRoot();

// No reliable byte count exists for what an MTPLX pull actually transfers.
// `usedStorage` (an `expand[]` field fetchHuggingfaceModel can request)
// looks like a fix, but it's the WHOLE repo's total across EVERY format
// variant hosted there — pytorch + tf + jax + tflite + onnx + safetensors,
// etc. — not just what MTPLX downloads, and a multi-format repo can
// over-report by 2-3x. Refusing a valid pull over files it WON'T fetch is
// worse than the status quo, so expectedBytes stays 0 (never refuse when
// the size is unknown) rather than trading an under-protective gap for an
// over-refusing one.
const UNKNOWN_MTPLX_BYTES = 0;

export async function previewMtplxPull({ model = null } = {}) {
  const repo = model ? requireRepoId(model) : null;
  const preflight = await assessDownloadPreflight({
    destPath: mtplxCachePath(),
    expectedBytes: UNKNOWN_MTPLX_BYTES,
  });
  return { kind: 'mtplx', ...preflight, destPath: repo || 'MTPLX cache', alreadyDownloaded: false };
}

/** Resolve `mtplx`, or say why the operation cannot run at all. */
function requireBinary() {
  const binary = findCommandOnPath('mtplx');
  if (!binary) {
    throw new ServerError(
      'The `mtplx` binary was not found on PATH. Install MTPLX from the Local Runtime Servers card first.',
      { status: 400, code: 'MTPLX_NOT_INSTALLED' }
    );
  }
  return binary;
}

function requireRepoId(model) {
  if (!isMtplxRepoId(model)) {
    throw new ServerError(
      `"${model}" is not a Hugging Face repo id. Expected owner/name — pick a model from the search results.`,
      { status: 400, code: 'MTPLX_INVALID_REPO_ID' }
    );
  }
  return model;
}

/**
 * Search Hugging Face for MTPLX-branded MTP checkpoints.
 *
 * `mtplx forge discover` is upstream's own index of models carrying the MTPLX
 * runtime contract, which is exactly the set `mtplx serve` can run — a raw Hub
 * search would mostly return checkpoints that download for an hour and then
 * fail their file check.
 *
 * @param {{query?: string, limit?: number, offset?: number}} [options]
 * @returns {Promise<{models: object[], error: string|null}>}
 */
export async function searchMtplxCatalog({ query = '', limit = 24, offset = 0 } = {}) {
  const binary = requireBinary();
  const args = ['forge', 'discover', '--json', '--limit', String(limit), '--offset', String(offset)];
  // An empty query means "MTPLX's own default listing" — passing `--query ''`
  // would search for the empty string instead of falling through to it.
  if (query.trim()) args.push('--query', query.trim());

  const result = await bufferedSpawn(binary, args, { timeoutMs: SEARCH_TIMEOUT_MS, shell: false });
  if (result.timedOut) return { models: [], error: '`mtplx forge discover` timed out' };
  if (!result.success) {
    return { models: [], error: spawnFailureDetail(result, `\`mtplx forge discover\` exited with code ${result.code}`) };
  }

  // Parse from the first bracket: upstream writes the array alone today, but a
  // banner line ahead of it must not read as "nothing was found".
  const text = String(result.stdout || '');
  const start = text.indexOf('[');
  const parsed = start === -1 ? null : safeJSONParse(text.slice(start), null, { allowArray: true });
  if (!Array.isArray(parsed)) return { models: [], error: '`mtplx forge discover --json` did not return a model list' };

  const models = parsed
    .filter((row) => typeof row?.repo === 'string' && row.repo)
    .map((row) => ({
      repo: row.repo,
      name: row.branded_name || row.repo.split('/').pop(),
      owner: row.owner || row.repo.split('/')[0],
      downloads: Number.isFinite(row.downloads) ? row.downloads : null,
      license: row.license || null,
    }));

  // `mtplx forge discover` reports downloads and license but no dates, and how
  // OLD a checkpoint is decides whether it is worth a multi-gigabyte pull. Ask
  // the Hub itself for the publish date — cached per repo, so a repeated search
  // is free — and leave `publishedAt: null` when the Hub has no answer rather
  // than failing a search that is otherwise complete.
  const published = await fetchRepoPublishedDates(models.map((m) => m.repo));
  for (const model of models) model.publishedAt = published[model.repo] || null;

  return { models, error: null };
}

/**
 * One NDJSON line from `mtplx pull --progress-json`, normalised to the frame
 * shape the client renders.
 *
 * Upstream emits `resolving` / `start` / `resume` / `progress` / `verifying` /
 * `complete` / `result` / `failed` / `cancelled`. Only the byte counters and a
 * message are load-bearing here; anything unrecognised still surfaces as a log
 * line rather than being dropped, because a download that goes quiet for an
 * hour is indistinguishable from one that hung.
 */
export function parseMtplxPullFrame(line, model) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const parsed = trimmed.startsWith('{') ? safeJSONParse(trimmed, null, { allowArray: false }) : null;
  if (!parsed) return { event: 'progress', model, message: trimmed };

  const received = Number(parsed.size_bytes);
  const total = Number(parsed.total_bytes);
  return {
    event: parsed.event === 'failed' ? 'error' : parsed.event || 'progress',
    model: parsed.repo_id || model,
    received: Number.isFinite(received) ? received : null,
    total: Number.isFinite(total) && total > 0 ? total : null,
    message: parsed.message || parsed.detail || null,
  };
}

/**
 * Download one MTP checkpoint into MTPLX's cache.
 *
 * `model` omitted means MTPLX's own verified default — the same checkpoint the
 * provider-readiness checklist's "Download the default model & start MTPLX"
 * fetches, so the two surfaces cannot pull different weights.
 *
 * Never throws for a failed download: this runs behind a request that has
 * already streamed progress, so the outcome is a value (`{ success, error }`)
 * the route reports rather than a rejection mid-stream.
 *
 * There is deliberately no cancellation hook: a pull is a server-side download
 * the user is told keeps running when they navigate away, so nothing here is
 * tied to the lifetime of the request that started it.
 *
 * @param {{model?: string|null, onProgress?: (frame: object) => void}} [options]
 */
export async function pullMtplxModel({ model = null, onProgress = () => {} } = {}) {
  const binary = requireBinary();
  const repo = model ? requireRepoId(model) : null;
  const label = repo || 'MTPLX\'s default verified checkpoint';
  assertDownloadFits(await assessDownloadPreflight({
    destPath: mtplxCachePath(),
    expectedBytes: UNKNOWN_MTPLX_BYTES,
  }));

  onProgress({ event: 'start', model: repo, message: `Downloading ${label}. This is a multi-gigabyte download and can take a while.` });
  console.log(`⬇️  MTPLX pull started for ${label}`);

  const args = ['pull', ...(repo ? [repo] : []), '--progress-json'];
  const result = await runStreamingCommand(
    binary,
    args,
    (line) => {
      const frame = parseMtplxPullFrame(line, repo);
      // `complete`/`result` are upstream's own terminal frames — the caller's
      // own completion frame below is the one the client acts on, so don't let
      // an early one tear the progress bar down before the process exits.
      if (frame && frame.event !== 'complete' && frame.event !== 'result') onProgress(frame);
    },
    { timeoutMs: PULL_TIMEOUT_MS }
  );

  if (!result.success) {
    console.error(`❌ MTPLX pull failed for ${label}: ${result.error}`);
    onProgress({ event: 'error', model: repo, message: result.error });
    return { success: false, model: repo, error: result.error };
  }

  // Report what actually landed rather than what was asked for: an interrupted
  // pull can exit 0 with an incomplete pack, and the cache listing is the only
  // honest answer to "can this be served now".
  const cache = await listMtplxCachedModels();
  const cached = (cache.models || []).map((m) => m?.repo_id).filter(Boolean);
  console.log(`✅ MTPLX pull complete for ${label} (${cached.length} checkpoint(s) cached)`);
  onProgress({ event: 'complete', model: repo, message: `${label} downloaded` });
  return { success: true, model: repo, cachedModels: cached };
}

/**
 * Delete one checkpoint from MTPLX's cache.
 *
 * `mtplx remove` owns the deletion rather than PortOS unlinking a directory it
 * inferred: the cache layout (safe-name directories, sidecars, a shared blob
 * store) is upstream's, and a path PortOS assembled itself would be a data-loss
 * bug the first time that layout changed.
 */
export async function removeMtplxModel(model) {
  const binary = requireBinary();
  const repo = requireRepoId(model);

  const result = await bufferedSpawn(binary, ['remove', repo, '--json'], { timeoutMs: REMOVE_TIMEOUT_MS, shell: false });
  if (result.timedOut) throw new ServerError(`\`mtplx remove ${repo}\` timed out`, { status: 504 });

  // `mtplx remove --json` writes its payload to stdout even when it exits 1
  // (nothing to remove), so parse before deciding this failed — the JSON says
  // WHY, and the exit code alone would surface as a bare `}`.
  const text = String(result.stdout || '');
  const start = text.indexOf('{');
  const parsed = start === -1 ? null : safeJSONParse(text.slice(start), null, { allowArray: false });

  if (!result.success) {
    if (parsed?.removed === false) {
      throw new ServerError(`${repo} is not in MTPLX's cache — nothing to remove.`, { status: 404, code: 'MTPLX_MODEL_NOT_CACHED' });
    }
    throw new ServerError(
      `Failed to remove ${repo}: ${spawnFailureDetail(result, `mtplx exited with code ${result.code}`)}`,
      { status: 500 }
    );
  }

  console.log(`🗑️  MTPLX checkpoint removed: ${repo}`);
  return {
    success: true,
    model: repo,
    removed: parsed?.removed !== false,
    bytesFreed: Number.isFinite(Number(parsed?.size_bytes_removed)) ? Number(parsed.size_bytes_removed) : null,
  };
}
