/**
 * What a local one-model-per-process runtime has on disk but is not serving.
 *
 * This is the `cachedModelIds` hook `lib/aiToolkit` calls on every model refresh
 * (wired in `services/bootstrap.js`). The toolkit stays self-contained — it
 * cannot read a cache directory or spawn a listing — so the answer is injected
 * from here.
 *
 * ## Why the hook exists
 *
 * MTPLX and Slotstream each load ONE checkpoint per process and report only that
 * one through their OpenAI-compatible `/v1/models`. A refresh probes that
 * endpoint, so it answered with the same lone id no matter how many checkpoints
 * the machine held: a checkpoint the user had just downloaded never appeared in
 * the provider's model list. Worse for Slotstream, whose shipped record lists
 * three ids — the refresh PRUNED the other two, `defaultModel` included.
 *
 * The cache is the honest catalog of what this machine can serve, and
 * `services/providerReadiness.js`'s `catalogCheck` already grades
 * `servesOneModel` runtimes leniently for exactly this reason (one servable id
 * is all such a provider needs), while its pinned-model check still flags a
 * provider aimed at a checkpoint the daemon has not loaded.
 *
 * ## Why only these two runtimes
 *
 * `servesOneModel` is not the qualifying property — having a PortOS-readable
 * cache in the SAME id namespace as the served id is. llama.cpp's served id is
 * an `--alias` label over a GGUF path, so its cached files are not candidate
 * model ids at all (the readiness checklist's serve-model button exists for
 * that mismatch instead); vLLM and SGLang bake the served id into an
 * operator-owned compose project with no PortOS-side cache to list.
 *
 * ## Never a boot cost
 *
 * Runtime readers are imported lazily and only for a matching provider. MTPLX
 * discovery owns no process state and reads its cache without importing the
 * daemon manager or registering its idle policy. Slotstream retains its manager
 * adapter: that public probe also recognizes the managed process's live port.
 * Nothing here runs outside an explicit refresh request.
 */

import { isLocalInstanceEndpoint, localRuntimeKind } from '../lib/localProviderRuntime.js';

/**
 * Runtime key → the cache probe that answers for it. Each probe defers its
 * runtime dependencies so they stay out of the boot closure every server suite
 * pays for (see `server/AGENTS.md` → Import scoping).
 */
const CACHED_MODEL_PROBES = {
  mtplx: mtplxCachedModelIds,
  slotstream: async (provider) => (await import('./slotstreamServerManager.js')).slotstreamCachedModelIds(provider),
};

/**
 * The cached-but-unserved model ids for `provider`, or `null`.
 *
 * `null` means "no cached catalog to add" — a provider of another runtime, or a
 * cache that could not be READ. It is deliberately distinct from `[]` ("read,
 * and genuinely empty"): the toolkit leaves the endpoint probe's own answer
 * untouched for `null` and for `[]` alike, but the distinction is the same one
 * `listMtplxCachedModels` draws and must not collapse here.
 *
 * The local-endpoint test comes first and costs nothing: a daemon on a tailnet
 * peer is someone else's process, and its checkpoints are on that machine — so
 * a provider aimed there must never be answered with THIS host's cache. It also
 * keeps the ~one refresh per non-local provider from loading either runtime subtree.
 *
 * `localRuntimeKind` resolves the shipped `mtplx` record by id (#6466) same as
 * it resolves a marker-backed wrapper, so one lookup routes both. Each probe
 * re-checks identity itself regardless, so a key match here is routing, not a
 * verdict.
 *
 * @param {{id?: string, type?: string, endpoint?: string}|null|undefined} provider
 * @returns {Promise<string[]|null>}
 */
export async function localCachedModelIds(provider) {
  if (!isLocalInstanceEndpoint(provider?.endpoint)) return null;
  const probe = CACHED_MODEL_PROBES[localRuntimeKind(provider)];
  return probe ? probe(provider) : null;
}

/**
 * The checkpoints THIS machine can serve, for an MTPLX provider's model refresh.
 *
 * `mtplx serve` loads one checkpoint and reports only that one through
 * `/v1/models`, under the slug its launch line minted — so the refresh a user
 * clicks after pulling a second checkpoint returned the same lone id it
 * returned before, and the new weights never appeared in the provider's model
 * list. The cache is the real catalog of what is servable here, so it is merged
 * in (`aiToolkit`'s `cachedModelIds` hook).
 *
 * Only entries MTPLX itself calls complete are listed (`servableMtplxCachedModels`
 * — the same rule a start is picked with): an interrupted pull leaves a directory
 * that lists but cannot load, and offering it as a selectable model just moves
 * the failure into an agent run.
 *
 * `null` for anything that is not an MTPLX provider AND for a cache that could
 * not be read (no binary, a cold Homebrew wrapper, a failed listing) —
 * deliberately not `[]`, which the caller must be free to read as "read, and
 * genuinely empty". Both answers leave the endpoint probe's result untouched.
 *
 * Gated on `describeMtplxRuntime().ready` for the reason `lib/mtplxModels.js`
 * spells out: on a host whose Homebrew wrapper has not bootstrapped its venv,
 * invoking `mtplx` IS a several-hundred-megabyte download. A refresh click is
 * explicit, but it is not consent to that — and it would time out anyway.
 *
 * @param {{type?: string, endpoint?: string, mtplxBacked?: boolean}|null} provider
 * @returns {Promise<string[]|null>}
 */
export async function mtplxCachedModelIds(provider) {
  // LOCAL first, and on its own line: the `mtplxBacked` marker rides the record
  // across a user's federated machines, so a provider pointed at a peer's MTPLX
  // carries every signal below while its checkpoints are on the OTHER machine.
  // Answering there would offer this host's cache as that provider's catalog.
  if (!isLocalInstanceEndpoint(provider?.endpoint)) return null;
  // `localRuntimeKind` now reads both signals the shipped records carry: the
  // `mtplxBacked` marker on the OpenCode CLI/TUI wrappers, and the bare `id` on
  // the API record — a plain OpenAI-compatible endpoint with no marker of its
  // own (#6466). A bare `:8000` is deliberately NOT a third signal here: that
  // port is generic, and this must not offer MTPLX's checkpoints as the
  // catalog of someone else's local API.
  if (localRuntimeKind(provider) !== 'mtplx') return null;
  const { findCommandOnPath } = await import('../lib/processEnv.js');
  const binaryPath = findCommandOnPath('mtplx');
  if (!binaryPath) return null;
  const { describeMtplxRuntime } = await import('../lib/mtplxRuntime.js');
  if (!(await describeMtplxRuntime(binaryPath)).ready) return null;
  const { listMtplxCachedModels, servableMtplxCachedModels } = await import('../lib/mtplxModels.js');
  const { models } = await listMtplxCachedModels();
  if (!Array.isArray(models)) return null;
  return servableMtplxCachedModels(models).map((row) => row.repo_id);
}
