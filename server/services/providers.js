/**
 * Compatibility shim for PortOS services that import from providers.js
 * Re-exports toolkit provider service functions
 */

import { setAIToolkitInstance, requireToolkit } from '../lib/aiToolkitState.js';
import { applyModelAccessList } from '../lib/aiToolkit/internal/modelAccess.js';

// `server/index.js` imports `setAIToolkit` from here — keep the named export
// stable while the underlying singleton lives in `lib/aiToolkitState.js` so
// providers / runner / promptService all observe the same instance.
export const setAIToolkit = setAIToolkitInstance;

// Pure classification helpers, not toolkit-instance methods — direct
// re-exports (no requireToolkit() indirection needed) so callers can classify
// a provider shape without an initialized toolkit instance.
// `canRefreshModels` is the model-refresh capability predicate the providers
// routes decorate their payloads with; it is derived on read and never stored.
// `ollamaRefreshGroupKey` buckets providers whose refresh hits the same Ollama
// daemon with the same probe, so a fan-out can fetch once per daemon instead of
// once per provider. `refreshProviderModelsBatch` below already applies it —
// this export is for a caller that needs to reason about the grouping without
// running a refresh.
export {
  isOllamaBackedProvider,
  canRefreshModels,
  ollamaRefreshGroupKey,
} from '../lib/aiToolkit/providers.js';

export async function getAllProviders() {
  return requireToolkit().services.providers.getAllProviders();
}

/**
 * Just the provider records, as an array.
 *
 * `getAllProviders()` resolves `{ activeProvider, providers: [...] }` — an
 * ENVELOPE, not a list. Callers that forgot kept writing
 * `Array.isArray(providers) ? providers : []`, which is never true and so
 * silently yields an empty list: the capability suite reported "no OpenCode TUI
 * provider is configured" for every runtime, and `runtimeApiKey` never found a
 * key for an authenticated vLLM. Both were green in tests that mocked the call
 * as a bare array.
 *
 * A caller that only wants the records should use this and never see the
 * envelope. `[]` on a failed read is deliberate: no provider is reachable, which
 * is what an empty list means here.
 */
export async function listProviders() {
  const data = await getAllProviders().catch(() => null);
  return Array.isArray(data?.providers) ? data.providers : [];
}

/**
 * The provider records with each one's `models` narrowed to what this install is
 * ENTITLED to run — see `lib/aiToolkit/internal/modelAccess.js` and
 * `docs/MODEL_ACCESS.md`.
 *
 * The distinction this names, once, is SELECTING versus EXECUTING:
 *
 * - A caller OFFERING a choice — a picker payload, a task-model allowlist, the
 *   connection graph's model menus, the comparison chart's inventory — must use
 *   this one, or it offers models the account cannot run.
 * - A caller EXECUTING, ACCOUNTING or WRITING — the runner, quota burn, usage
 *   reconciliation, a harness catalog refresh — must use {@link listProviders},
 *   because the entitlement policy is about what a human may pick next, not
 *   about what already ran or what the upstream actually advertises. Narrowing
 *   there would also let a write path persist a truncated catalog over the real
 *   one, which no refresh would restore until the policy was cleared.
 *
 * Two methods rather than a flag on one, because the answer is a property of the
 * CALLER's purpose and picking the wrong one has to be visible at the call site.
 * Each scoped record carries the untouched list as `modelCatalog`, so a caller
 * that needs both has both.
 */
export async function getSelectableProviders() {
  const data = await getAllProviders();
  return { ...data, providers: applyModelAccessList(data.providers) };
}

/**
 * The list form of {@link getSelectableProviders}, mirroring
 * {@link listProviders} against {@link getAllProviders} — same envelope trap,
 * same answer.
 */
export async function listSelectableProviders() {
  return applyModelAccessList(await listProviders());
}

export async function getProviderById(id) {
  return requireToolkit().services.providers.getProviderById(id);
}

export async function getActiveProvider() {
  return requireToolkit().services.providers.getActiveProvider();
}

export async function setActiveProvider(id) {
  return requireToolkit().services.providers.setActiveProvider(id);
}

export async function createProvider(data) {
  return requireToolkit().services.providers.createProvider(data);
}

export async function updateProvider(id, data) {
  return requireToolkit().services.providers.updateProvider(id, data);
}

export async function deleteProvider(id) {
  return requireToolkit().services.providers.deleteProvider(id);
}

export async function testProvider(id) {
  return requireToolkit().services.providers.testProvider(id);
}

export async function refreshProviderModels(id) {
  return requireToolkit().services.providers.refreshProviderModels(id);
}

/**
 * Probe a provider's model list without persisting it. Pair with
 * `updateProvider(id, { models })` to apply one probe's result to several
 * providers that share an upstream.
 */
export async function fetchProviderModels(id) {
  return requireToolkit().services.providers.fetchProviderModels(id);
}

/**
 * Refresh a whole set of providers with ONE providers.json write: the toolkit
 * groups them by shared Ollama daemon + probe shape, probes one lead per group,
 * then applies every result in a single save. Returns one result per group so
 * the caller logs group-level context instead of one line per member.
 */
export async function refreshProviderModelsBatch(ids) {
  return requireToolkit().services.providers.refreshProviderModelsBatch(ids);
}
