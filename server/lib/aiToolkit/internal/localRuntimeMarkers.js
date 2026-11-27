/**
 * Local-runtime marker registry: the one ordered table of persisted `*Backed` booleans
 * (`ollamaBacked`, `lmstudioBacked`, ...) and the two questions asked of them, "is this provider
 * fronting any local runtime?" and "which one?".
 *
 * Pure leaf with no imports. It lives in `aiToolkit/internal/` because the toolkit may not import
 * out of itself while host and client code already import its leaves. The field names are the
 * persisted record format (federated to peers, read by older installs), so they never change here;
 * adding a runtime is one row. Order is behavior: `markedLocalRuntime` returns the FIRST marker set,
 * so a malformed record carrying two markers keeps the answer the old if-chain gave.
 */

/** Runtime id to the persisted boolean on a provider record, in resolution order. */
export const LOCAL_RUNTIME_MARKERS = Object.freeze({
  ollama: 'ollamaBacked',
  lmstudio: 'lmstudioBacked',
  mtplx: 'mtplxBacked',
  llama: 'llamaBacked',
  vllm: 'vllmBacked',
  sglang: 'sglangBacked',
  splash: 'splashBacked',
  mkserve: 'mkserveBacked',
});

/** The marker field names, in registry order. */
export const LOCAL_RUNTIME_MARKER_KEYS = Object.freeze(Object.values(LOCAL_RUNTIME_MARKERS));

/**
 * The id of the first local runtime `provider` is marked for, or `null`. Reads the marker booleans
 * only: id/endpoint-based inference (`isOllamaBackedProvider`, loopback endpoints) stays with callers.
 * @param {object|null|undefined} provider
 * @returns {'ollama'|'lmstudio'|'mtplx'|'llama'|'vllm'|'sglang'|'splash'|'mkserve'|null}
 */
export function markedLocalRuntime(provider) {
  for (const [id, key] of Object.entries(LOCAL_RUNTIME_MARKERS)) {
    if (provider?.[key] === true) return id;
  }
  return null;
}

/** Whether `provider` carries any local-runtime marker. */
export const hasLocalRuntimeMarker = (provider) => markedLocalRuntime(provider) !== null;
