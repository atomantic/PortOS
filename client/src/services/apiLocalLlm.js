/**
 * API client for local LLM backends (Ollama, LM Studio): status, catalog, model install and delete,
 * Prompt Guard classifier and entailment scorer lifecycles.
 *
 * Local LLM backends (Ollama / LM Studio): status (incl. installed models), catalog, model
 * install/delete, the managed Prompt Guard model-abuse classifier lifecycle, the jev entailment scorer
 * lifecycle (status / install / cancel / score / unload / integration policies) plus its
 * project-specific trained heads (list / train / adopt / discard, where adoption is gated server-side
 * on beating both the stock zero-shot and the majority-class baseline), backend install
 * (Homebrew/script), switch/migrate, playground test/compare, and measured per-model assessments (run
 * + persisted results + intent ranking + the server-side "measure everything" sweep). Also the
 * PM2-managed runtime servers (llama.cpp, MTPLX, Slotstream) and their checkpoint catalogs —
 * `searchMtplxModels` / `pullMtplxModel` / `removeMtplxModel` and `downloadSlotstreamModel` /
 * `cancelSlotstreamModelDownload`, so weights are managed in-app rather than from a terminal.
 */

import { request, API_BASE, throwApiError } from './apiCore.js';

// Local LLM backends (Ollama / LM Studio) — status, model management, migrate.
// Installed models per backend come back inside getLocalLlmStatus().
export const getLocalLlmStatus = (options) => request('/local-llm/status', options);

// Models served by each bare-endpoint runtime (llama.cpp, MTPLX, Splash, ...); lists only, never generates.
export const getLocalRuntimeModels = (options) => request('/local-llm/runtime-models', options);

// Vision-capable installed models across both backends, each tagged with the
// provider id that serves it. Powers the LoRA caption-model picker.
export const getVisionModels = (options) => request('/local-llm/vision-models', options);

// Tool-use (function-calling) capable installed models across both backends,
// each tagged with the provider id that serves it. Authoritative where the
// backend reports capabilities (Ollama `/api/show`); agent pickers union it with
// the client-side id regex via `useToolUseModelIds`.
export const getToolUseModels = (options) => request('/local-llm/tool-use-models', options);
export const getContextPlans = (options) => request('/local-llm/context-plans', options);

// `variants: true` opts into per-quant RAM-aware enrichment (probes Hugging Face
// per HF-backed entry) — the recommended-models picker wants it. Callers that only
// need catalog metadata (e.g. the playground decorating installed models) omit it
// to keep the response fast and fully local.
export const getLocalLlmCatalog = (backend, q = '', { variants = false, silent } = {}) =>
  request(`/local-llm/catalog?backend=${encodeURIComponent(backend)}${q ? `&q=${encodeURIComponent(q)}` : ''}${variants ? '&variants=1' : ''}`, { silent });

export const getModelAbuseGuardStatus = (options) =>
  request('/local-llm/security-guard/status', options);

export const scanModelAbuseContent = (content, options) =>
  request('/local-llm/security-guard/scan', { method: 'POST', body: JSON.stringify({ content }), ...options });

export const installModelAbuseGuard = (options) =>
  request('/local-llm/security-guard/install', {
    method: 'POST',
    body: '{}',
    ...options,
  });

export const cancelModelAbuseGuardInstall = (options) =>
  request('/local-llm/security-guard/install/cancel', {
    method: 'POST',
    body: '{}',
    ...options,
  });

// The jev entailment scorer's own lifecycle, separate from the chat catalog
// and from Prompt Guard's.
export const getJevStatus = (options) => request('/local-llm/jev/status', options);

// Per-decision agreement and abstention counters. Counts only, so this is safe
// to poll from a settings panel.
export const getJevDecisionStats = (options) => request('/local-llm/jev/decisions', options);

export const installJev = (options) =>
  request('/local-llm/jev/install', { method: 'POST', body: '{}', ...options });

export const cancelJevInstall = (options) =>
  request('/local-llm/jev/install/cancel', { method: 'POST', body: '{}', ...options });

// Starts the sidecar on first use, so this is only ever called from an explicit
// operator action.
export const scoreJev = (body, options) =>
  request('/local-llm/jev/score', { method: 'POST', body: JSON.stringify(body), ...options });

export const unloadJev = (options) =>
  request('/local-llm/jev/unload', { method: 'POST', body: '{}', ...options });

// Project-specific trained heads. Metrics and adoption state only — never a
// corpus row, a premise, or a path.
export const getJevHeads = (options) => request('/local-llm/jev/heads', options);

// Builds a corpus from this install's own forge history and fits a head on the
// frozen encoder. Minutes on a cold embedding cache, so callers give it a long
// leash and an explicit in-progress state.
export const trainJevHead = (body = {}, options) =>
  request('/local-llm/jev/heads/train', { method: 'POST', body: JSON.stringify(body), ...options });

// Refused server-side unless the head beats BOTH the stock zero-shot and the
// majority-class baseline — a disabled button is a suggestion, not the gate.
export const adoptJevHead = (decisionId, options) =>
  request('/local-llm/jev/heads/adopt', { method: 'POST', body: JSON.stringify({ decisionId }), ...options });

export const discardJevHead = (decisionId, { adopted = false } = {}, options) =>
  request('/local-llm/jev/heads/discard', { method: 'POST', body: JSON.stringify({ decisionId, adopted }), ...options });

export const getLocalLlmHuggingFaceSearch = (backend, q = '', category = 'all', limit = 12, options) =>
  request(`/local-llm/huggingface-search?backend=${encodeURIComponent(backend)}&category=${encodeURIComponent(category)}&limit=${encodeURIComponent(limit)}${q ? `&q=${encodeURIComponent(q)}` : ''}`, options);

// `options` lets callers opt into `{ silent: true }` so structured failure codes
// (e.g. OLLAMA_OUTDATED → offer to upgrade in place) can be handled by the UI
// without the default error toast firing first and stacking with the prompt.
export const installLocalLlmModel = (backend, modelId, options = {}) => {
  const { force, ...rest } = options;
  return request('/local-llm/install', {
    method: 'POST',
    body: JSON.stringify({ backend, modelId, ...(force ? { force: true } : {}) }),
    ...rest,
  });
};

// Stops a download `installLocalLlmModel` started; that request then resolves `{ canceled: true }`.
export const cancelLocalLlmInstall = (backend, modelId, options = {}) =>
  request('/local-llm/install/cancel', { method: 'POST', body: JSON.stringify({ backend, modelId }), ...options });

export const deleteLocalLlmModel = (backend, modelId, options = {}) =>
  request('/local-llm/delete', { method: 'POST', body: JSON.stringify({ backend, modelId }), ...options });

export const installLocalLlmBackend = (backend) =>
  request('/local-llm/install-backend', { method: 'POST', body: JSON.stringify({ backend }) });

// Upgrade an already-installed backend in place (Homebrew on macOS, official
// Ollama script on Linux). The pull-model path uses this on the OLLAMA_OUTDATED
// recovery flow so a stale binary doesn't keep the user from installing new models.
export const upgradeLocalLlmBackend = (backend, options = {}) =>
  request('/local-llm/upgrade-backend', { method: 'POST', body: JSON.stringify({ backend }), ...options });

export const controlOllamaService = (action) =>
  request('/local-llm/ollama-service', { method: 'POST', body: JSON.stringify({ action }) });

// Start/stop LM Studio's local server through its own `lms` CLI. No
// enable/disable counterpart — launch-at-login belongs to the LM Studio app.
export const controlLmStudioService = (action) =>
  request('/local-llm/lmstudio-service', { method: 'POST', body: JSON.stringify({ action }) });

// Start payloads differ by runtime: llama-server requires a chosen GGUF,
// MTPLX and Slotstream default to their verified cache, and the bundles own
// their prepared weights. Bundle mutations report completion via progress events.
function runtimeRequests(path, { startBody, upgrade = false } = {}) {
  const post = (action, options) => request(`${path}/${action}`, { ...options, method: 'POST' });
  return {
    status: (options) => request(`${path}/status`, options),
    install: (options) => post('install', options),
    start: startBody
      ? (config) => post('start', { body: JSON.stringify(startBody(config)) })
      : (options) => post('start', options),
    stop: (options) => post('stop', options),
    ...(upgrade && { upgrade: (options) => post('upgrade', options) }),
  };
}

const defaultLaunch = (config = {}) => config;
const managedRuntimeRequests = {
  llama: runtimeRequests('/local-llm/llama-server', { startBody: (config) => config, upgrade: true }),
  mtplx: runtimeRequests('/local-llm/mtplx', { startBody: defaultLaunch }),
  slotstream: runtimeRequests('/local-llm/slotstream', { startBody: defaultLaunch }),
  splash: runtimeRequests('/local-llm/splash', { upgrade: true }),
  mkserve: runtimeRequests('/local-llm/mkserve', { upgrade: true }),
};

export const getManagedInklingRuntimeStatus = (runtime, options) =>
  managedRuntimeRequests[runtime].status(options);

export const saveSplashContextWindow = (contextWindow, options) =>
  request('/local-llm/splash/context', { ...options, method: 'PUT', body: JSON.stringify({ contextWindow }) });

export const controlManagedInklingRuntime = (runtime, action, options) =>
  managedRuntimeRequests[runtime][action](options);

export const getMtplxServerStatus = managedRuntimeRequests.mtplx.status;
export const startMtplxServer = managedRuntimeRequests.mtplx.start;
export const stopMtplxServer = () => managedRuntimeRequests.mtplx.stop();
export const installMtplx = () => managedRuntimeRequests.mtplx.install();

export const getSlotstreamServerStatus = managedRuntimeRequests.slotstream.status;
export const startSlotstreamServer = managedRuntimeRequests.slotstream.start;
export const stopSlotstreamServer = () => managedRuntimeRequests.slotstream.stop();
export const installSlotstream = () => managedRuntimeRequests.slotstream.install();

// Fetch one checkpoint into Slotstream's cache. `model` is a catalog id from
// the status payload, or a Hugging Face `owner/name`. Byte progress arrives on
// the `slotstream:download` socket event, not in this response — the transfer
// outlives the request.
export const downloadSlotstreamModel = (model) =>
  request('/local-llm/slotstream/models/download', { method: 'POST', body: JSON.stringify({ model }) });

// Stop the named checkpoint's download. The bytes already moved are kept, so a
// later download resumes rather than restarting.
export const cancelSlotstreamModelDownload = (model, options) =>
  request('/local-llm/slotstream/models/download/cancel', {
    method: 'POST',
    body: JSON.stringify({ model }),
    ...options,
  });

// MTPLX model catalog — search, download, and remove MTP checkpoints in-app.
// `mtplx forge discover` is upstream's index of MTPLX-branded models, which is
// exactly the set `mtplx serve` can run; an empty query returns its default list.
export const searchMtplxModels = (params = {}, options) => {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  ).toString();
  return request(`/local-llm/mtplx/models/search${query ? `?${query}` : ''}`, options);
};

// Omitting `model` fetches MTPLX's own verified default checkpoint. Byte
// progress arrives on the `mtplx:download` socket event, not in this response —
// a multi-GB transfer resolves only when the weights are on disk.
export const pullMtplxModel = (model = null) =>
  request('/local-llm/mtplx/models/pull', { method: 'POST', body: JSON.stringify(model ? { model } : {}) });

export const removeMtplxModel = (model) =>
  request('/local-llm/mtplx/models/remove', { method: 'POST', body: JSON.stringify({ model }) });

// `pm2 save` — snapshot the running PM2 process list into the dump a boot-time
// `pm2 resurrect` replays, so the local runtime servers come back after a
// reboot. The privileged `pm2 startup` half stays a one-time operator command.
export const saveRuntimeStartupList = () =>
  request('/local-llm/save-startup', { method: 'POST' });

// llama-server (DFlash 2 / Speculative Decoding) process controls
export const getLlamaServerStatus = managedRuntimeRequests.llama.status;

// Optional version/package-manager metadata for the Local LLMs runtime card.
// Kept separate from lifecycle status because the provider version probe and the
// `brew info` / `winget list` query can be slow on a cold machine.
export const getLlamaServerUpdateStatus = (options) =>
  request('/local-llm/llama-server/update-status', options);

export const startLlamaServer = managedRuntimeRequests.llama.start;
export const stopLlamaServer = () => managedRuntimeRequests.llama.stop();
export const installLlamaServer = () => managedRuntimeRequests.llama.install();

// Upgrade a package-manager-installed binary. The server restarts a managed
// llama-server using its existing launch configuration.
export const upgradeLlamaServer = () => managedRuntimeRequests.llama.upgrade();

// Size/destination/free-disk numbers for the confirm step, before any
// transfer starts. `body.kind` picks which download this previews
// ('spec-decode' | 'mtplx' | 'install') — see localLlmDownloadPreflightSchema.
export const previewLocalLlmDownload = (body, options) =>
  request('/local-llm/download-preflight', {
    method: 'POST',
    body: JSON.stringify(body),
    ...options,
  });

// Fetch one speculative-decoding preset's GGUF (role: 'model' | 'draftModel')
// from Hugging Face into the path the launcher passes llama.cpp. Byte progress
// arrives on the `llamaServer:download` socket event, not in this response —
// a multi-GB transfer resolves only when the file is on disk.
export const downloadSpecDecodeModel = (presetId, role, options) =>
  request('/local-llm/llama-server/download-model', {
    method: 'POST',
    body: JSON.stringify({ presetId, role }),
    ...options,
  });

export const cancelSpecDecodeModelDownload = (presetId, role, options) =>
  request('/local-llm/llama-server/download-model/cancel', {
    method: 'POST',
    body: JSON.stringify({ presetId, role }),
    ...options,
  });

// Delete an already-downloaded preset GGUF to reclaim disk space for a method
// the user no longer wants — the unload/cleanup counterpart to the download
// above. Refused server-side while llama-server is running that exact file.
export const removeSpecDecodeModel = (presetId, role, options) =>
  request('/local-llm/llama-server/download-model/remove', {
    method: 'POST',
    body: JSON.stringify({ presetId, role }),
    ...options,
  });

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
// owns the toast when a status read fails.
export const getLoadedLlmModels = ({ fresh = false, ...options } = {}) =>
  request(`/local-llm/loaded${fresh ? '?fresh=1' : ''}`, options);

// Force a local backend to evict a model immediately.
export const unloadOllamaModel = (modelId, options) =>
  request('/local-llm/unload', {
    method: 'POST',
    body: JSON.stringify({ backend: 'ollama', modelId }),
    ...options,
  });

export const unloadLmStudioModel = (modelId, options) =>
  request('/lmstudio/unload', {
    method: 'POST',
    body: JSON.stringify({ modelId }),
    ...options,
  });

export const compareLocalLlmModels = (payload, options) =>
  request('/local-llm/compare', { method: 'POST', body: JSON.stringify(payload), ...options });

// Streaming playground test. POSTs the prompt payload and reads the NDJSON
// response body so `onToken(delta, kind)` fires per chunk for live rendering —
// kind is 'content' or 'reasoning' so the caller can render a reasoning model's
// chain-of-thought on its own channel. Resolves with the terminal result object
// (including `error`/`text` for a timed-out partial). The caller passes
// `signal` to cancel — aborting rejects the read with AbortError, which the
// caller should swallow when `signal.aborted` (intentional cancel). Can't use
// the EventSource-based useSseProgress hook here: that's GET-only and this
// request carries a prompt body.
export async function streamLocalLlmTest(payload, { signal, onToken } = {}) {
  const response = await fetch(`${API_BASE}/local-llm/test/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok || !response.body?.getReader) {
    // Honor session expiry the same way request() does — a streaming run that
    // 401s should bounce to /login, not just toast and strand the user here.
    await throwApiError(response);
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

// === Measured local-model assessments ========================================
// The catalog fit badge is a size estimate; these run the model and record what
// it actually did. GET is disk-only and safe to call on mount; the run endpoint
// calls a provider and must only fire from a deliberate user action (root
// AGENTS.md, "AI Provider Usage Policy").

// Persisted assessments + the intent-ranked recommendation + which installed
// models have no evidence yet. Zero LLM calls, so it's safe to load with the tab.
export const getLocalLlmAssessments = (intent = 'balanced', options) =>
  request(`/local-llm/assessments?intent=${encodeURIComponent(intent)}`, options);

// Measure ONE model. Minutes-long by nature (one bounded generation per context
// size), so callers pass a `signal` to abort when the user navigates away.
export const runLocalLlmAssessment = (payload, options) =>
  request('/local-llm/assessments/run', { method: 'POST', body: JSON.stringify(payload), ...options });

// Run one disposable OpenCode agent task through a local TUI provider preset.
// This measures tool-loop completion separately from direct decoder throughput.
export const runOpenCodeAgentBenchmark = (payload, options) =>
  request('/local-llm/assessments/agent-benchmark', { method: 'POST', body: JSON.stringify(payload), ...options });

// === The overnight sweep =====================================================
// Measure every model the scope covers, in one server-side queue. Unlike
// `runLocalLlmAssessment` this returns as soon as the queue is built — the run
// itself keeps going with the tab closed, which is the whole point of starting
// one at the end of the day. Same consent rule: it only fires from a click that
// was shown the model and generation count first.

// Queue status: what is running, what has finished, what it measured. Module
// state on the server, so it is safe to poll and a reload picks a sweep back up.
export const getLocalLlmAssessmentSweep = (options) =>
  request('/local-llm/assessments/sweep', options);

// `scope` is 'unmeasured' | 'stale' | 'all'. 409s when a sweep is already
// running or the scope covers nothing.
//
// For a TUNING sweep the payload is `{ backend, modelId, tunings: true }` —
// one model across the knob grid its runtime declares. `tunings` is the ASK,
// never the grid: the server derives which knob sets that means, and
// `report.runtimes[].tuningGrid` is that same list shipped for the consent gate
// to count. 409s when the runtime has no knob PortOS can sweep.
export const startLocalLlmAssessmentSweep = (payload, options) =>
  request('/local-llm/assessments/sweep', { method: 'POST', body: JSON.stringify(payload), ...options });

// Side-by-side benchmark of the picked models (`[{ backend, modelId }]`, 2–8), on the same
// server-side queue as the sweep. Only the list travels: the profile (prompt size, runs, output
// budget) is fixed server-side and shipped as `report.benchmarkProfile` for the consent gate.
// 409s when the queue is busy or a pick is not installed.
export const startLocalLlmAssessmentBenchmark = (payload, options) =>
  request('/local-llm/assessments/benchmark', { method: 'POST', body: JSON.stringify(payload), ...options });

// Stop the queue and the model in flight. Everything already measured stays.
export const cancelLocalLlmAssessmentSweep = (options) =>
  request('/local-llm/assessments/sweep/cancel', { method: 'POST', ...options });

// Drop a stale measurement — after a RAM upgrade or a backend update the
// recorded evidence describes a machine that no longer exists.
//
// `tuningKey` picks WHICH measurement of the model to drop: a model can hold
// several, one per launch tuning. `''` is the backend-defaults record.
export const deleteLocalLlmAssessment = (backend, modelId, tuningKey = '', options) =>
  request('/local-llm/assessments/delete', { method: 'POST', body: JSON.stringify({ backend, modelId, tuningKey }), ...options });

// === Capability tests ========================================================
// The assessments above answer "how fast is this model here". These answer the
// question speed cannot: can it do what its badges claim? Same consent rule —
// GET is disk-only and safe on mount; the run endpoint calls a model and must
// only fire from a click that was shown the runtime, model and tests first.
//
// There is deliberately no sweep and no schedule endpoint. A capability run is a
// manual act.

// What each installed model claims, which tests apply to it, and what each one
// proved last time. Zero LLM calls.
export const getModelCapabilityTests = (options) =>
  request('/local-llm/capability-tests', options);

// Run ONE test against ONE model. Minutes-long for the sandbox repair (it drives
// a real agent loop), so callers pass a `signal` to abort on navigate-away, and
// watch `localLlm:progress` frames with `scope: 'capability-test'` for the live
// transcript.
export const runModelCapabilityTest = (payload, options) =>
  request('/local-llm/capability-tests/run', { method: 'POST', body: JSON.stringify(payload), ...options });

// ONE stored result in full — the model's output and, for the sandbox test, the
// agent transcript. The report ships summaries only (those two fields are the
// bulk of a record), so the drawer fills in the rest when it opens a pairing.
export const getModelCapabilityTestResult = (backend, modelId, testId, options) =>
  request(`/local-llm/capability-tests/result?backend=${encodeURIComponent(backend)}&modelId=${encodeURIComponent(modelId)}&testId=${encodeURIComponent(testId)}`, options);

// Drop one recorded result — after re-pulling a model at a different quant, the
// stored verdict describes weights that are no longer installed.
export const deleteModelCapabilityTest = (backend, modelId, testId, options) =>
  request('/local-llm/capability-tests/delete', { method: 'POST', body: JSON.stringify({ backend, modelId, testId }), ...options });

// Grok-box / CPU-only free Persistent Mind checklist (Ollama + Qwen2.5 7B).
export const getLocalPersistentMindSetup = (options) =>
  request('/local-llm/persistent-mind-setup', options);

export const applyLocalPersistentMindSetup = (body = {}, options = {}) =>
  request('/local-llm/persistent-mind-setup/apply', {
    method: 'POST',
    body: JSON.stringify(body),
    ...options,
  });

export const getJevPolicy = (options) => request('/local-llm/jev/policy', options);
export const updateJevPolicy = (body, options) => request('/local-llm/jev/policy', { method: 'PUT', body: JSON.stringify(body), ...options });

export const getLayaStatus = (options) => request('/local-llm/laya-mlx/status', options);
export const installLaya = (options) => request('/local-llm/laya-mlx/install', { method: 'POST', body: '{}', ...options });
export const scoreLaya = (body, options) => request('/local-llm/laya-mlx/score', { method: 'POST', body: JSON.stringify(body), ...options });
