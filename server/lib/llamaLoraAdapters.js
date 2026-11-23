/**
 * The LoRA adapters a running llama-server has loaded (`GET /lora-adapters`) and the per-request `lora` field that turns one on or off for a single generation.
 *
 * PortOS launches an adapter at scale 0 (`--lora-scaled <path>:0`), but a request that names no `lora` runs on whatever global scale the server holds, and a server started outside PortOS may hold 1.0. A caller comparing base vs adapter therefore always sends every loaded adapter's scale explicitly, which is what `loraRequestField` builds.
 */

const LIST_TIMEOUT_MS = 3000;

/** `http://host:port/v1` → `http://host:port`: the adapter routes sit beside `/v1`, not under it. */
const serverRoot = (endpoint) => String(endpoint || '').replace(/\/+$/, '').replace(/\/v\d+$/, '');

/** File name without directory or `.gguf`, the label a picker shows for an adapter. */
export const loraAdapterName = (path) => String(path || '').split(/[\\/]/).pop().replace(/\.gguf$/i, '') || 'adapter';

/**
 * The adapters loaded on the server at `endpoint`, as `[{ id, name, path }]`. An empty list for a server with none, a build without the route, or one that is not answering: an adapter choice is offered only when the server confirms it.
 */
export async function listLoraAdapters(endpoint, { fetchImpl = fetch, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  if (!endpoint) return [];
  const res = await fetchImpl(`${serverRoot(endpoint)}/lora-adapters`, { signal: AbortSignal.timeout(timeoutMs) }).catch(() => null);
  if (!res?.ok) return [];
  const body = await res.json().catch(() => null);
  if (!Array.isArray(body)) return [];
  return body
    .filter((a) => Number.isInteger(a?.id) && a.id >= 0)
    .map((a) => ({ id: a.id, name: loraAdapterName(a.path), path: typeof a.path === 'string' ? a.path : null }));
}

/** The chat-completions `lora` field: `scale` for the chosen adapter, 0 for every other loaded one. `adapterId` null means base (all at 0). */
export const loraRequestField = (adapters, adapterId, scale) => adapters.map((a) => ({
  id: a.id,
  scale: a.id === adapterId ? scale : 0,
}));
