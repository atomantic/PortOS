/**
 * Compatibility shim for PortOS services that import from providers.js
 * Re-exports toolkit provider service functions
 */

import { setAIToolkitInstance, requireToolkit } from '../lib/aiToolkitState.js';
import { applyModelAccessList } from '../lib/aiToolkit/internal/modelAccess.js';

// `server/index.js` imports `setAIToolkit` from here; the singleton lives in
// `lib/aiToolkitState.js` so providers / runner / promptService share one instance.
export const setAIToolkit = setAIToolkitInstance;

// Pure classification helper, not a toolkit-instance method: re-exported directly so
// callers can classify a provider shape without an initialized toolkit.
export {
  isOllamaBackedProvider,
} from '../lib/aiToolkit/providers.js';

export async function getAllProviders() {
  return requireToolkit().services.providers.getAllProviders();
}

/**
 * Just the provider records, as an array. `getAllProviders()` resolves an ENVELOPE
 * (`{ activeProvider, providers }`), not a list; callers testing it with
 * `Array.isArray` silently got `[]` (tests that mocked a bare array stayed green).
 * `[]` on a failed read is deliberate: no provider is reachable.
 */
export async function listProviders() {
  const data = await getAllProviders().catch(() => null);
  return Array.isArray(data?.providers) ? data.providers : [];
}

/**
 * The provider records with each one's `models` narrowed to what this install is
 * ENTITLED to run (`lib/aiToolkit/internal/modelAccess.js`, `docs/MODEL_ACCESS.md`).
 *
 * SELECTING versus EXECUTING: a caller OFFERING a choice (picker, task-model
 * allowlist, model menus, comparison inventory) must use this one. A caller
 * EXECUTING, ACCOUNTING or WRITING (runner, quota burn, usage reconciliation, harness
 * catalog refresh) must use {@link listProviders}: the policy is about what a human
 * may pick next, and narrowing a write path would persist a truncated catalog that no
 * refresh restores until the policy is cleared. Two methods rather than a flag so the
 * wrong choice is visible at the call site. Each scoped record carries the untouched
 * list as `modelCatalog`.
 */
export async function getSelectableProviders() {
  const data = await getAllProviders();
  return { ...data, providers: applyModelAccessList(data.providers) };
}

/** The list form of {@link getSelectableProviders} (same envelope trap as {@link listProviders}). */
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

/** Probe a provider's model list without persisting it (pair with `updateProvider(id, { models })`). */
export async function fetchProviderModels(id) {
  return requireToolkit().services.providers.fetchProviderModels(id);
}

/**
 * Refresh a set of providers with ONE providers.json write: the toolkit groups them
 * by shared Ollama daemon + probe shape, probes one lead per group, applies all in a
 * single save, and returns one result per group.
 */
export async function refreshProviderModelsBatch(ids) {
  return requireToolkit().services.providers.refreshProviderModelsBatch(ids);
}
