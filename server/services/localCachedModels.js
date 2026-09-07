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
 * Each runtime's manager is imported lazily and only for a provider whose
 * runtime it owns, so an install with neither daemon never loads either
 * subtree — and nothing here runs outside an explicit refresh request.
 */

import { isLocalInstanceEndpoint, localRuntimeKind } from '../lib/localProviderRuntime.js';

/**
 * Runtime key → the manager function that answers for it. Values are loaders
 * rather than functions so the module graph stays out of the boot closure every
 * server suite pays for (see `server/AGENTS.md` → Import scoping).
 */
const CACHED_MODEL_PROBES = {
  mtplx: () => import('./mtplxServerManager.js').then((m) => m.mtplxCachedModelIds),
  slotstream: () => import('./slotstreamServerManager.js').then((m) => m.slotstreamCachedModelIds),
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
 * keeps the ~one refresh per non-local provider from loading either manager.
 *
 * `provider.id` backs up `localRuntimeKind` because the shipped `mtplx` record
 * is a plain OpenAI-compatible endpoint carrying no vendor marker for
 * `localRuntimeKind` to read. Each probe re-checks identity itself, so a key
 * match is routing, not a verdict.
 *
 * @param {{id?: string, type?: string, endpoint?: string}|null|undefined} provider
 * @returns {Promise<string[]|null>}
 */
export async function localCachedModelIds(provider) {
  if (!isLocalInstanceEndpoint(provider?.endpoint)) return null;
  const load = CACHED_MODEL_PROBES[localRuntimeKind(provider) || provider?.id];
  if (!load) return null;
  const probe = await load();
  return probe(provider);
}
