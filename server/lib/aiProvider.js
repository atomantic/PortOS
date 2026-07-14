/**
 * Shared AI provider utilities for LLM calls.
 * Used by insightsService, identity, goalCheckIn, taste-questionnaire, etc.
 */

import { getAllProviders } from '../services/providers.js';
import { startAIOp } from '../services/aiStatusEvents.js';
import { ensureProviderReady as ensureOllamaProviderReady, isOllamaProvider } from '../services/ollamaManager.js';
// localModelHealing is lazy-imported at its (rare, error-recovery) call site
// below — a static import here pulls its notifications/providers deps (which
// eagerly import fileUtils `PATHS`) into every aiProvider consumer's module
// graph, breaking suites that partial-mock fileUtils without PATHS.
import { readResponseJson } from './readResponseJson.js';
import { evaluateSecretEndpoint } from './aiToolkit/internal/endpointGuard.js';

const isAPI = (p) => p && p.type === 'api' && p.enabled !== false;

// LM Studio auto-recovery timeouts. Listing downloaded models is a quick local
// HTTP call; loading a model into VRAM can take a while on a cold start.
const LM_STUDIO_LIST_TIMEOUT_MS = 5000;
const LM_STUDIO_LOAD_TIMEOUT_MS = 120000;
// Default chat-completion timeout when a provider doesn't set its own. Generous
// because local models on modest hardware can be slow to first token.
const DEFAULT_PROVIDER_TIMEOUT_MS = 300000;

/**
 * Resolve an API-type provider for features that can only run against an API
 * endpoint (CLI providers don't support the simple chat-completions call path).
 *
 * Resolution order:
 *   1. The requested provider (if API-type)
 *   2. The user's active provider (if API-type)
 *   3. The first enabled API provider configured
 *
 * Returns null when no API provider is configured — callers should surface a
 * "configure an API provider" hint rather than re-throwing.
 */
export async function resolveAPIProvider(requestedProviderId) {
  // One read of providers.json — getAllProviders returns both the active id
  // and the full list, so we don't need separate getProviderById/getActiveProvider
  // round-trips for each step of the fallback chain.
  const all = await getAllProviders().catch(() => null);
  const providers = Array.isArray(all?.providers)
    ? all.providers
    : Object.values(all?.providers || {});

  if (requestedProviderId) {
    const requested = providers.find(p => p.id === requestedProviderId);
    if (isAPI(requested)) return requested;
  }
  if (all?.activeProvider) {
    const active = providers.find(p => p.id === all.activeProvider);
    if (isAPI(active)) return active;
  }
  return providers.find(isAPI) || null;
}

// LM Studio's chat-completions endpoint returns this when no model is in
// memory. The error is identical regardless of which model name the request
// asked for, so retrying with a different name is pointless — we have to
// actually load a model first via /api/v1/models/load.
const LM_STUDIO_NO_MODEL_RE = /no models loaded/i;

const lmStudioBaseFromEndpoint = (endpoint) =>
  (endpoint || '').replace(/\/v1\/?$/, '').replace(/\/+$/, '');

/**
 * When LM Studio reports "No models loaded", list its downloaded LLMs and
 * load the user's preferred one (provider.defaultModel → first id in
 * provider.models that's downloaded → first downloaded LLM). Returns the
 * id of a model that's now loaded, or null if we couldn't auto-load anything.
 *
 * Pattern mirrors `ensureLLMModelLoaded` in services/memoryClassifier.js but
 * is provider-config-driven so any caller of callProviderAISimple gets the
 * same auto-recovery on first-use cold starts.
 */
async function ensureLMStudioModelLoaded(provider, statusOp) {
  const baseUrl = lmStudioBaseFromEndpoint(provider.endpoint);
  if (!baseUrl) return null;

  const listCtl = new AbortController();
  const listTimer = setTimeout(() => listCtl.abort(), LM_STUDIO_LIST_TIMEOUT_MS);
  const listResp = await fetch(`${baseUrl}/api/v0/models`, {
    method: 'GET',
    signal: listCtl.signal
  }).catch(() => null).finally(() => clearTimeout(listTimer));

  if (!listResp?.ok) return null;
  const payload = await listResp.json().catch(() => null);
  const llms = (payload?.data || []).filter(m => m.type === 'llm');
  if (llms.length === 0) {
    console.warn('⚠️ LM Studio has no downloaded LLMs — auto-load impossible');
    return null;
  }

  const findInList = (name) => name && llms.find(m => m.id === name || m.id.includes(name));
  const preferences = [provider.defaultModel, ...(provider.models || [])].filter(Boolean);

  // If something is already loaded, prefer the configured default if it's in
  // memory, otherwise just use whatever LM Studio has loaded.
  const alreadyLoaded = llms.filter(m => m.state === 'loaded');
  if (alreadyLoaded.length > 0) {
    const match = preferences.map(findInList).find(Boolean) || alreadyLoaded[0];
    return alreadyLoaded.find(m => m.id === match.id)?.id || alreadyLoaded[0].id;
  }

  const target = preferences.map(findInList).find(Boolean) || llms[0];
  console.log(`📦 LM Studio reported no models loaded — auto-loading: ${target.id}`);
  statusOp?.update('model:loading', `Loading ${target.id} into LM Studio…`, { model: target.id });

  const loadStart = Date.now();
  const loadCtl = new AbortController();
  const loadTimer = setTimeout(() => loadCtl.abort(), LM_STUDIO_LOAD_TIMEOUT_MS);
  const loadResp = await fetch(`${baseUrl}/api/v1/models/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: target.id }),
    signal: loadCtl.signal
  }).catch(err => ({ ok: false, _err: err.message })).finally(() => clearTimeout(loadTimer));

  if (!loadResp.ok) {
    const errText = loadResp._err || await loadResp.text?.().catch(() => 'unknown error') || 'unknown error';
    console.error(`❌ Failed to auto-load LM Studio model ${target.id}: ${errText}`);
    statusOp?.update('error', `Failed to load ${target.id}: ${errText}`, { model: target.id });
    return null;
  }

  const loadMs = Date.now() - loadStart;
  console.log(`✅ LM Studio model loaded: ${target.id} (${loadMs}ms)`);
  statusOp?.update('model:loaded', `${target.id} loaded (${(loadMs / 1000).toFixed(1)}s)`, { model: target.id });
  return target.id;
}

async function postChatCompletion(provider, model, prompt, { temperature, max_tokens, timeout }) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) {
    // Never send the API key to an arbitrary/metadata host (SSRF / key
    // exfiltration). Keyless local-LLM calls skip this guard entirely.
    const guard = evaluateSecretEndpoint(provider.endpoint, {
      allowCustomEndpoint: provider.allowCustomEndpoint === true,
    });
    if (!guard.allowed) {
      return { error: `Provider endpoint blocked: ${guard.reason}` };
    }
    headers['Authorization'] = `Bearer ${provider.apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature, max_tokens })
    });
  } catch (err) {
    clearTimeout(timer);
    return { error: `Provider request failed: ${err.message}` };
  }
  clearTimeout(timer);

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    return { error: `Provider returned ${response.status}: ${errorText}`, status: response.status, body: errorText };
  }

  const data = await readResponseJson(response);
  // A valid completion always carries `choices`; its absence means the 200 body
  // wasn't the expected JSON (e.g. a proxy HTML page). Surface that as an error
  // rather than masquerading a malformed body as an empty-but-successful reply.
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return { error: 'Provider returned a malformed (non-JSON or unexpected) response body' };
  }
  // OpenAI-compatible bodies report token counts under `usage`; surface the completion
  // token count so the AI Core landmark can size its activity beam by output volume
  // (tokens/sec). Absent on some providers — callers treat a missing count as "unknown".
  const completionTokens = Number(data.usage?.completion_tokens);
  return {
    text: content,
    tokens: Number.isFinite(completionTokens) ? completionTokens : undefined,
  };
}

/**
 * Call an API-based AI provider with a simple prompt.
 * Returns { text } on success, { error } on failure.
 *
 * On an LM Studio "No models loaded" 400, this auto-loads a model from the
 * provider's configured models list and retries once. The retry uses the
 * actually-loaded model id rather than re-sending the original `model`,
 * since LM Studio's model resolver is name-fuzzy and always returns the
 * loaded one in chat-completion responses anyway.
 *
 * Pass `op` + `opLabel` to surface live status toasts in the UI via the
 * `ai:status` Socket.IO channel. The op slug groups all phase events under
 * one toast id so "loading model → calling → done" updates the same toast.
 *
 * Pass `appId` and/or `workspacePath` when the call originates on behalf of a
 * managed app or CoS-agent workspace — the CyberCity AI Core aims its activity
 * beam at that building (falling back to a generic radial beam when neither is
 * supplied). Output token counts from the provider are reported on completion
 * so the beam's thickness can track tokens/sec.
 */
export async function callProviderAISimple(provider, model, prompt, options = {}) {
  const { temperature = 0.3, max_tokens = 1000, op, opLabel, appId, workspacePath } = options;
  if (provider.type !== 'api') {
    return { error: 'This operation requires an API-based provider' };
  }
  const opts = { temperature, max_tokens, timeout: provider.timeout || DEFAULT_PROVIDER_TIMEOUT_MS };

  // Always emit status events (server logs + UI toasts) for AI calls. Callers
  // can pass `op` to give the toast a meaningful label; otherwise it's labeled
  // generically by provider+model so the user still sees model loads etc.
  const effectiveOp = op || `ai-call:${provider.id}`;
  const effectiveLabel = opLabel || `Calling ${provider.name || provider.id}…`;
  const statusOp = startAIOp({
    op: effectiveOp,
    label: effectiveLabel,
    providerId: provider.id,
    providerName: provider.name,
    model,
    appId,
    workspacePath,
    silent: !op
  });

  const doneLabel = effectiveLabel.replace(/…$/, '');
  const startMs = Date.now();
  const elapsedSec = () => ((Date.now() - startMs) / 1000).toFixed(1);
  // Token-throughput extras for the completion event — `tokensPerSec` powers the AI Core
  // beam thickness. Omitted entirely when the provider didn't report token usage so the
  // client can distinguish "unknown" from a real zero. This is a coarse end-to-end rate
  // (elapsed since the op started, so on the model-load / LM-Studio-retry paths it folds in
  // load + retry time and reads slightly low) — adequate for a relative beam-width cue.
  const throughput = (tokens) => {
    if (!Number.isFinite(tokens)) return {};
    const secs = Math.max((Date.now() - startMs) / 1000, 0.001);
    return { tokens, tokensPerSec: Math.round(tokens / secs) };
  };

  if (isOllamaProvider(provider)) {
    statusOp.update('provider:starting', 'Starting Ollama if needed…', { providerId: provider.id });
    const ready = await ensureOllamaProviderReady(provider).catch((err) => ({ success: false, error: err.message }));
    if (!ready.success) {
      const error = `Ollama is not running and PortOS could not start it: ${ready.error || 'unknown error'}`;
      statusOp.error(error);
      return { error };
    }
  }

  const first = await postChatCompletion(provider, model, prompt, opts);
  if (!first.error) {
    statusOp.complete(`${doneLabel} done (${elapsedSec()}s)`, throughput(first.tokens));
    return { text: first.text };
  }

  // Recover by retrying the call against `retryModel` (already loaded/healed),
  // reporting completion or error under that model id. Shared by both local
  // recovery paths below, which differ only in how they pick `retryModel`.
  const retryWith = async (retryModel) => {
    const retry = await postChatCompletion(provider, retryModel, prompt, opts);
    if (!retry.error) {
      statusOp.complete(`${doneLabel} done (${elapsedSec()}s)`, { model: retryModel, ...throughput(retry.tokens) });
      return { text: retry.text };
    }
    statusOp.error(retry.error, { model: retryModel });
    return { error: retry.error };
  };

  if (first.status === 400 && LM_STUDIO_NO_MODEL_RE.test(first.body || '')) {
    const loaded = await ensureLMStudioModelLoaded(provider, statusOp);
    if (loaded) {
      statusOp.update('start', `Calling ${provider.name || provider.id} (${loaded})…`, { model: loaded });
      return retryWith(loaded);
    }
  }

  // The configured model isn't installed on the local backend (e.g. a stale or
  // mis-typed provider default). Auto-pick a real installed model, repoint the
  // provider, tell the user, and retry once — instead of surfacing a dead-end
  // "model not found". Only fires for Ollama / LM Studio providers; healing is
  // a no-op (returns null) for remote/CLI providers, leaving the error as-is.
  const { healMissingLocalModel, isModelNotFoundError } = await import('../services/localModelHealing.js');
  if (isModelNotFoundError(first.body || first.error)) {
    const healed = await healMissingLocalModel({ provider, requestedModel: model }).catch(() => null);
    if (healed) {
      statusOp.update('model:corrected', `"${model}" isn't installed — retrying with ${healed.model}…`, { model: healed.model });
      return retryWith(healed.model);
    }
  }

  statusOp.error(first.error);
  return { error: first.error };
}

/**
 * Strip markdown code fences from LLM output before JSON.parse.
 *
 * Trims surrounding whitespace BEFORE the fence regex so common LLM shapes
 * with trailing newlines/spaces around the closing fence (e.g. "```json\n{}\n```\n")
 * still get the closing ``` stripped — the regex anchors on end-of-string.
 */
export function stripCodeFences(raw) {
  return raw.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
}

/**
 * Parse JSON from LLM output, stripping code fences first.
 * Throws a descriptive error on parse failure.
 */
export function parseLLMJSON(raw) {
  const cleaned = stripCodeFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Invalid JSON from AI: ${e.message}`);
  }
}
