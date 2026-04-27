/**
 * Shared AI provider utilities for LLM calls.
 * Used by insightsService, identity, goalCheckIn, taste-questionnaire, etc.
 */

import { getAllProviders } from '../services/providers.js';

const isAPI = (p) => p && p.type === 'api' && p.enabled !== false;

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
async function ensureLMStudioModelLoaded(provider) {
  const baseUrl = lmStudioBaseFromEndpoint(provider.endpoint);
  if (!baseUrl) return null;

  const listCtl = new AbortController();
  const listTimer = setTimeout(() => listCtl.abort(), 5000);
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

  const loadCtl = new AbortController();
  const loadTimer = setTimeout(() => loadCtl.abort(), 120000);
  const loadResp = await fetch(`${baseUrl}/api/v1/models/load`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: target.id }),
    signal: loadCtl.signal
  }).catch(err => ({ ok: false, _err: err.message })).finally(() => clearTimeout(loadTimer));

  if (!loadResp.ok) {
    const errText = loadResp._err || await loadResp.text?.().catch(() => 'unknown error') || 'unknown error';
    console.error(`❌ Failed to auto-load LM Studio model ${target.id}: ${errText}`);
    return null;
  }

  console.log(`✅ LM Studio model loaded: ${target.id}`);
  return target.id;
}

async function postChatCompletion(provider, model, prompt, { temperature, max_tokens, timeout }) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

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

  const data = await response.json();
  return { text: data.choices?.[0]?.message?.content || '' };
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
 */
export async function callProviderAISimple(provider, model, prompt, { temperature = 0.3, max_tokens = 1000 } = {}) {
  if (provider.type !== 'api') {
    return { error: 'This operation requires an API-based provider' };
  }
  const opts = { temperature, max_tokens, timeout: provider.timeout || 300000 };

  const first = await postChatCompletion(provider, model, prompt, opts);
  if (!first.error) return { text: first.text };

  if (first.status === 400 && LM_STUDIO_NO_MODEL_RE.test(first.body || '')) {
    const loaded = await ensureLMStudioModelLoaded(provider);
    if (loaded) {
      const retry = await postChatCompletion(provider, loaded, prompt, opts);
      if (!retry.error) return { text: retry.text };
      return { error: retry.error };
    }
  }
  return { error: first.error };
}

/**
 * Strip markdown code fences from LLM output before JSON.parse.
 */
export function stripCodeFences(raw) {
  return raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
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
