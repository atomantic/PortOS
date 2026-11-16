/**
 * What a local one-model-per-process runtime has on disk but is not serving: the
 * `cachedModelIds` hook `lib/aiToolkit` calls on each model refresh (wired in
 * `services/bootstrap.js`). Only MTPLX and Slotstream qualify (one checkpoint per
 * process, PortOS-readable cache in the served id namespace). Readers import lazily.
 */

import { isLocalInstanceEndpoint, localRuntimeKind } from '../lib/localProviderRuntime.js';

// Probes defer runtime imports to stay out of the boot closure (server/AGENTS.md "Import scoping").
const CACHED_MODEL_PROBES = {
  mtplx: mtplxCachedModelIds,
  slotstream: async (provider) => (await import('./slotstreamServerManager.js')).slotstreamCachedModelIds(provider),
};

/**
 * The cached-but-unserved model ids for `provider`, or `null` (no cached catalog
 * to add, or unreadable; `[]` means read and empty, a distinction that must not
 * collapse). Local-endpoint test first: a tailnet peer's checkpoints are on that machine.
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
 * Only complete entries are listed (an interrupted pull cannot load). `null` means
 * not MTPLX or unreadable cache, never `[]`. Gated on `describeMtplxRuntime().ready`:
 * on a cold Homebrew wrapper, invoking `mtplx` is a multi-hundred-MB download.
 * @param {{type?: string, endpoint?: string, mtplxBacked?: boolean}|null} provider
 * @returns {Promise<string[]|null>}
 */
export async function mtplxCachedModelIds(provider) {
  // The `mtplxBacked` marker federates: a peer-pointed provider must not get this host's cache.
  if (!isLocalInstanceEndpoint(provider?.endpoint)) return null;
  // Not `:8000`: that port is generic (#6466).
  if (localRuntimeKind(provider) !== 'mtplx') return null;
  const { resolveMtplxBinary, describeMtplxRuntime } = await import('../lib/mtplxRuntime.js');
  const binaryPath = resolveMtplxBinary();
  if (!binaryPath) return null;
  if (!(await describeMtplxRuntime(binaryPath)).ready) return null;
  const { listMtplxCachedModels, servableMtplxCachedModels } = await import('../lib/mtplxModels.js');
  const { models } = await listMtplxCachedModels();
  if (!Array.isArray(models)) return null;
  return servableMtplxCachedModels(models).map((row) => row.repo_id);
}
