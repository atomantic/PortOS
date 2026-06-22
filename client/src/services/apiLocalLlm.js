import { request, API_BASE, maybeRedirectToLogin } from './apiCore.js';

// Local LLM backends (Ollama / LM Studio) — status, model management, migrate.
// Installed models per backend come back inside getLocalLlmStatus().
export const getLocalLlmStatus = (options) => request('/local-llm/status', options);

// Vision-capable installed models across both backends, each tagged with the
// provider id that serves it. Powers the LoRA caption-model picker.
export const getVisionModels = (options) => request('/local-llm/vision-models', options);

// `variants: true` opts into per-quant RAM-aware enrichment (probes Hugging Face
// per HF-backed entry) — the recommended-models picker wants it. Callers that only
// need catalog metadata (e.g. the playground decorating installed models) omit it
// to keep the response fast and fully local.
export const getLocalLlmCatalog = (backend, q = '', { variants = false } = {}) =>
  request(`/local-llm/catalog?backend=${encodeURIComponent(backend)}${q ? `&q=${encodeURIComponent(q)}` : ''}${variants ? '&variants=1' : ''}`);

export const getLocalLlmHuggingFaceSearch = (backend, q = '', category = 'all', limit = 12) =>
  request(`/local-llm/huggingface-search?backend=${encodeURIComponent(backend)}&category=${encodeURIComponent(category)}&limit=${encodeURIComponent(limit)}${q ? `&q=${encodeURIComponent(q)}` : ''}`);

// `options` lets callers opt into `{ silent: true }` so structured failure codes
// (e.g. OLLAMA_OUTDATED → offer to upgrade in place) can be handled by the UI
// without the default error toast firing first and stacking with the prompt.
export const installLocalLlmModel = (backend, modelId, options) =>
  request('/local-llm/install', { method: 'POST', body: JSON.stringify({ backend, modelId }), ...options });

export const deleteLocalLlmModel = (backend, modelId) =>
  request('/local-llm/delete', { method: 'POST', body: JSON.stringify({ backend, modelId }) });

export const installLocalLlmBackend = (backend) =>
  request('/local-llm/install-backend', { method: 'POST', body: JSON.stringify({ backend }) });

// Upgrade an already-installed backend in place (Homebrew on macOS, official
// Ollama script on Linux). The pull-model path uses this on the OLLAMA_OUTDATED
// recovery flow so a stale binary doesn't keep the user from installing new models.
export const upgradeLocalLlmBackend = (backend) =>
  request('/local-llm/upgrade-backend', { method: 'POST', body: JSON.stringify({ backend }) });

export const controlOllamaService = (action) =>
  request('/local-llm/ollama-service', { method: 'POST', body: JSON.stringify({ action }) });

// Set the default backend (which one PortOS routes local runs to) — does not move models.
export const switchLocalLlmBackend = (to) =>
  request('/local-llm/switch', { method: 'POST', body: JSON.stringify({ to }) });

// Move the OTHER backend's models onto `to`. mode: 'link' shares GGUF weights on
// disk (default, zero extra space, falls back to copy across filesystems);
// 'copy' makes an independent duplicate. Never changes the default backend.
export const migrateLocalLlmBackend = (to, mode = 'link') =>
  request('/local-llm/migrate', { method: 'POST', body: JSON.stringify({ to, mode }) });

// Memory-management — models currently resident in VRAM/unified memory.
// Used by the Memory Management panel to show what's eating space before
// kicking off a big diffusion render. `options` lets the panel pass
// `{ silent: true }` so its own catch handler / useAsyncAction wrapper
// owns the toast — without it apiCore double-toasts on every 5s poll.
export const getLoadedLlmModels = (options) =>
  request('/local-llm/loaded', options);

// Force Ollama to evict a model immediately. LM Studio has its own
// /api/lmstudio/unload endpoint (see apiCore default export usage in
// LocalLlmTab) — we don't proxy it through this module.
export const unloadOllamaModel = (modelId, options) =>
  request('/local-llm/unload', {
    method: 'POST',
    body: JSON.stringify({ backend: 'ollama', modelId }),
    ...options,
  });

export const testLocalLlmModel = (payload, options) =>
  request('/local-llm/test', { method: 'POST', body: JSON.stringify(payload), ...options });

export const compareLocalLlmModels = (payload, options) =>
  request('/local-llm/compare', { method: 'POST', body: JSON.stringify(payload), ...options });

// Streaming variant of testLocalLlmModel. POSTs the same payload but reads the
// NDJSON response body so `onToken(delta, kind)` fires per chunk for live
// rendering — kind is 'content' or 'reasoning' so the caller can render a
// reasoning model's chain-of-thought on its own channel. Resolves with the
// terminal result object (same shape as
// testLocalLlmModel, including `error`/`text` for a timed-out partial). The
// caller passes `signal` to cancel — aborting rejects the read with AbortError,
// which the caller should swallow when `signal.aborted` (intentional cancel).
// Can't use the EventSource-based useSseProgress hook here: that's GET-only and
// this request carries a prompt body.
export async function streamLocalLlmTest(payload, { signal, onToken } = {}) {
  const response = await fetch(`${API_BASE}/local-llm/test/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok || !response.body?.getReader) {
    const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    // Honor session expiry the same way request() does — a streaming run that
    // 401s should bounce to /login, not just toast and strand the user here.
    maybeRedirectToLogin(response, err);
    throw new Error(err.error || `HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;

  const consume = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try { frame = JSON.parse(trimmed); } catch { return; }
    if (frame.type === 'token') onToken?.(frame.delta || '', frame.kind || 'content');
    else if (frame.type === 'result') result = frame.result;
  };

  // Always release the reader on every exit — a clean finish, a thrown
  // AbortError on cancel, or a mid-stream throw — so a non-abort error doesn't
  // leave the stream dangling (mirrors apiAsk.js / apiOpenClaw.js).
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consume(line);
    }
    if (buffer.trim()) consume(buffer);
  } finally {
    await reader.cancel().catch(() => {});
  }
  // A clean EOF that never delivered a `result` frame (server killed mid-stream,
  // truncated body, proxy cut the connection — all surface as read() done:true,
  // NOT an AbortError) would otherwise resolve null and be silently swallowed by
  // the caller's `if (!result) return`. Throw so the caller's .catch toasts it;
  // an intentional cancel sets signal.aborted and the caller suppresses that.
  if (!result && !signal?.aborted) throw new Error('Stream ended before a result was received');
  return result;
}
