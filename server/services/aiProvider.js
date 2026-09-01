/**
 * Shared AI provider utilities for LLM calls.
 * Used by insightsService, identity, goalCheckIn, taste-questionnaire, etc.
 */

import { getAllProviders } from './providers.js';
import { startAIOp } from './aiStatusEvents.js';
import { ensureProviderReady as ensureOllamaProviderReady, isOllamaProvider } from './ollamaManager.js';
import { ensureMtplxProviderReady, isMtplxProvider } from './mtplxServerManager.js';
// localModelHealing is lazy-imported at its (rare, error-recovery) call site
// below — a static import here pulls its notifications/providers deps (which
// eagerly import fileUtils `PATHS`) into every aiProvider consumer's module
// graph, breaking suites that partial-mock fileUtils without PATHS.
import { readResponseJson } from '../lib/readResponseJson.js';
// The PURE half of the Codex subscription transport only. The process half
// (services/codexAppServer.js) is lazy-imported at its call site below, so a
// consumer of this module never pulls a child-process graph it will not use —
// and suites that partial-mock this file's deps keep working.
import { classifyCodexTransportError, isCodexTextTransportEnabled } from '../lib/codexTurn.js';
import { resolveBenchWaitMs, resolveProviderBench } from '../lib/providerCooldown.js';
import { ERROR_CATEGORIES } from '../lib/aiToolkit/errorDetection.js';
import { evaluateSecretEndpoint } from '../lib/aiToolkit/internal/endpointGuard.js';
import { withCreativeLatitude } from '../lib/creativeLatitude.js';

const isAPI = (p) => p && p.type === 'api' && p.enabled !== false;
/**
 * A CLI/TUI record the user has explicitly pointed at a non-HTTP text
 * transport — today only the Codex ChatGPT subscription. It can serve the same
 * bounded prompts an API provider can, without an API key.
 */
const isSubscriptionText = (p) => isCodexTextTransportEnabled(p);
/** Anything this module can run a prompt through. */
const isTextCapable = (p) => isAPI(p) || isSubscriptionText(p);

// LM Studio auto-recovery timeouts. Listing downloaded models is a quick local
// HTTP call; loading a model into VRAM can take a while on a cold start.
const LM_STUDIO_LIST_TIMEOUT_MS = 5000;
const LM_STUDIO_LOAD_TIMEOUT_MS = 120000;
// Default chat-completion timeout when a provider doesn't set its own. Generous
// because local models on modest hardware can be slow to first token.
const DEFAULT_PROVIDER_TIMEOUT_MS = 300000;

/**
 * The shared body of the two resolvers below. `accept` decides which records
 * count for steps 1 and 2.
 *
 * Step 3 is deliberately NOT parameterized — it is always `isAPI`. It is a
 * blind sweep of whatever happens to be configured, and letting it land on a
 * subscription would silently move a background feature's billing from an API
 * key the user already pays for onto their ChatGPT plan. Switching billing
 * source is a decision, not a fallback.
 */
async function resolveProviderFor(requestedProviderId, accept) {
  // One read of providers.json — getAllProviders returns both the active id
  // and the full list, so we don't need separate getProviderById/getActiveProvider
  // round-trips for each step of the fallback chain.
  const all = await getAllProviders().catch(() => null);
  const providers = Array.isArray(all?.providers)
    ? all.providers
    : Object.values(all?.providers || {});

  if (requestedProviderId) {
    const requested = providers.find(p => p.id === requestedProviderId);
    if (accept(requested)) return requested;
  }
  if (all?.activeProvider) {
    const active = providers.find(p => p.id === all.activeProvider);
    if (accept(active)) return active;
  }
  return providers.find(isAPI) || null;
}

/**
 * Resolve an API-type provider for features that can only run against an API
 * endpoint (CLI providers don't support the simple chat-completions call path).
 *
 * Resolution order:
 *   1. The requested provider (if API-type)
 *   2. The user's active provider (if API-type)
 *   3. The first enabled API provider configured
 *
 * **This must stay API-ONLY.** Most of its callers hand the result to
 * `promptRunner.runPromptThroughProvider`, which dispatches on `provider.type`
 * and would run a returned `codex` record through `executeCliRun` — the
 * file-writing coding harness, in the PortOS checkout, with the network and the
 * user's MCP servers. Widening this function to accept the subscription text
 * transport therefore does NOT give those callers a bounded text call; it gives
 * them a coding agent pointed at the repo. New callers that want the transport
 * ask for it by name via {@link resolveTextProvider}, which is only safe
 * because they feed `callProviderAISimple`.
 *
 * Returns null when no API provider is configured — callers should surface a
 * "configure an API provider" hint rather than re-throwing.
 */
export async function resolveAPIProvider(requestedProviderId) {
  return resolveProviderFor(requestedProviderId, isAPI);
}

/**
 * Resolve a provider for a bounded text call made through
 * {@link callProviderAISimple} — the one path that knows how to run the
 * subscription transport safely.
 *
 * Same order as {@link resolveAPIProvider}, except that steps 1 and 2 also
 * accept the Codex ChatGPT subscription, because both name a provider the user
 * chose. **Only call this when the result goes to `callProviderAISimple`** — a
 * `type: 'cli'` record reaching the prompt runner is a coding agent, not a
 * text call.
 */
export async function resolveTextProvider(requestedProviderId) {
  return resolveProviderFor(requestedProviderId, isTextCapable);
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
  // An empty/whitespace-only completion is unusable output, not a successful call —
  // same class as the malformed body above. Classifying it here keeps the `ai:status`
  // stream honest (a call that produced nothing must not report "done") and gives
  // callers a single "the provider failed" signal to test: `result.error`.
  if (!content.trim()) {
    return { error: 'Provider returned an empty completion' };
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
 * Resolve the ONE provider the user explicitly nominated as this provider's
 * fallback, when it can serve text on its own credentials.
 *
 * Only `fallbackProvider` counts — never a sweep of whatever else is
 * configured. A subscription going quiet must not silently start spending an
 * API key the user never pointed at this work.
 */
async function resolveExplicitFallback(provider) {
  const fallbackId = typeof provider.fallbackProvider === 'string' ? provider.fallbackProvider.trim() : '';
  if (!fallbackId) return null;
  const all = await getAllProviders().catch(() => null);
  const providers = Array.isArray(all?.providers) ? all.providers : Object.values(all?.providers || {});
  const fallback = providers.find(p => p.id === fallbackId);
  // A subscription-backed fallback would just re-enter the same benched
  // transport, so only an API record is a real escape hatch here.
  if (!isAPI(fallback)) return null;
  return fallback;
}

/**
 * Run a bounded text prompt through the user's ChatGPT subscription.
 *
 * Returns the same `{ text }` / `{ error }` shape the HTTP path does, so no
 * caller has to know which transport served it.
 *
 * Failure handling has three steps, in this order:
 *
 *   1. Classify the failure with the same category vocabulary every other
 *      provider path uses.
 *   2. Bench the TRANSPORT — not the `codex` provider record. An exhausted
 *      subscription window must not take the CLI coding harness offline as a
 *      side effect; that is a separate capability of the same record. The
 *      duration comes from the shared cooldown policy, preferring the reset
 *      time Codex itself reported.
 *   3. Retry once on the provider's EXPLICIT fallback, if it named one.
 *
 * `temperature` / `max_tokens` have no app-server equivalent and are dropped
 * rather than approximated: the turn is governed by the model and its reasoning
 * effort, and inventing a mapping would make two providers disagree about what
 * the same options mean.
 */
async function callCodexSubscription(provider, model, prompt, {
  statusOp, doneLabel, elapsedSec, throughput, timeout, responseSchema, signal,
}) {
  const {
    benchCodexTextTransport,
    getCodexTextTransportBench,
    peekCodexAccountReadiness,
    runCodexTextTurn,
  } = await import('./codexAppServer.js');

  // An active bench short-circuits the wire: the transport already knows it
  // cannot serve this window, so there is no point paying for the round trip.
  const benched = getCodexTextTransportBench();
  // Why the subscription can't serve this call. Set either by that bench or by
  // the turn that just failed — it is the message the user sees when there is
  // no fallback, so it must be the real one, never a generic stand-in.
  let reason = benched?.message ?? 'The ChatGPT subscription is temporarily unavailable.';

  if (!benched) {
    statusOp.update('provider:starting', 'Running through the ChatGPT subscription…', { providerId: provider.id });
    const turn = await runCodexTextTurn({
      prompt,
      model: model || provider.defaultModel || null,
      effort: provider.effort || null,
      timeoutMs: timeout,
      responseSchema,
      signal,
    }).catch((err) => ({ error: err }));

    if (!turn.error) {
      if (turn.effortClamped) statusOp.update('model:corrected', turn.clampReason, { model: turn.model });
      statusOp.complete(`${doneLabel} done (${elapsedSec()}s)`, throughput(turn.usage?.outputTokens));
      return { result: { text: turn.text, usage: turn.usage } };
    }

    reason = turn.error.message;
    const category = classifyCodexTransportError(turn.error);
    // A caller who pressed Stop is not a provider fault. Benching would take the
    // subscription off the board for work the user never abandoned, and burning
    // the fallback would pay for an answer nobody is waiting for.
    if (category === ERROR_CATEGORIES.CANCELED) {
      statusOp.error(reason, { providerId: provider.id });
      return { result: { error: reason, canceled: true } };
    }
    const bench = resolveProviderBench({ category, message: reason });
    if (bench) {
      benchCodexTextTransport({
        waitMs: resolveBenchWaitMs(bench, { resetsAt: reportedResetsAt(peekCodexAccountReadiness()) }),
        category,
        message: reason,
      });
    }
  }

  const fallback = await resolveExplicitFallback(provider);
  if (!fallback) {
    statusOp.error(reason, { providerId: provider.id });
    return { result: { error: reason } };
  }

  const fallbackModel = provider.fallbackModel || fallback.defaultModel || null;
  statusOp.update('start', `Falling back to ${fallback.name || fallback.id}…`, {
    providerId: fallback.id, model: fallbackModel,
  });
  // Handed BACK rather than posted here: re-entering `callProviderAISimple` is
  // what gives the fallback the local-backend warm-ups (Ollama / MTPLX), the LM
  // Studio no-models-loaded auto-load-and-retry, and the caller's own
  // `temperature` / `max_tokens` — all of which a direct `postChatCompletion`
  // silently drops, making the fallback least reliable exactly when it is
  // needed. The recursion terminates: an explicit fallback must be API-type.
  return { fallback, fallbackModel };
}

/**
 * The reset time Codex last reported for the spent window, or `null`.
 *
 * Read from the CACHED readiness only — a failing call is the wrong moment to
 * spawn an account probe, and a stale-or-absent answer just falls back to the
 * category's own cooldown.
 */
const reportedResetsAt = (readiness) => {
  const windows = [readiness?.rateLimits?.primary, readiness?.rateLimits?.secondary];
  const spent = windows.find((w) => typeof w?.usedPercent === 'number' && w.usedPercent >= 100 && w.resetsAt);
  return spent?.resetsAt ?? null;
};

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
 * Pass `creative: true` when the prompt asks for creative work (prose, style,
 * render prompts) so it carries the IP-latitude clause — this helper bypasses
 * both of the usual chokepoints (see lib/creativeLatitude.js).
 *
 * Pass `appId` and/or `workspacePath` when the call originates on behalf of a
 * managed app or CoS-agent workspace — the OpenWorld AI Core aims its activity
 * beam at that building (falling back to a generic radial beam when neither is
 * supplied). Output token counts from the provider are reported on completion
 * so the beam's thickness can track tokens/sec.
 */
export async function callProviderAISimple(provider, model, prompt, options = {}) {
  const {
    temperature = 0.3, max_tokens = 1000, op, opLabel, appId, workspacePath, background, creative,
    // A JSON Schema the answer must match. Only the Codex subscription transport
    // can enforce it (the app-server constrains the final message); the HTTP path
    // ignores it, exactly as it has always ignored unknown options.
    responseSchema = null,
    // Aborting stops the active Codex turn instead of leaving it to burn
    // subscription quota for an answer nobody is waiting for. The HTTP path
    // manages its own AbortController from `timeout`.
    signal = null,
  } = options;
  if (provider.type !== 'api' && !isSubscriptionText(provider)) {
    return { error: 'This operation requires an API-based provider' };
  }
  // This helper is a THIRD LLM transport — it posts to /chat/completions itself
  // rather than going through promptService.buildPrompt or the shared runner, so
  // neither of the IP-latitude chokepoints can see it (lib/creativeLatitude.js).
  // There is no stage name or run `source` here to classify by, so a creative
  // caller declares itself with `creative: true` and the stamp happens here.
  const body = creative ? withCreativeLatitude(prompt) : prompt;
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
    silent: !op,
    // `background` marks an UNATTENDED fan-out job (e.g. the scheduled multi-goal
    // check-in) so the client coalesces its per-provider error toasts. It is the
    // caller's explicit provenance signal — NOT inferred from `!op`, because
    // user-triggered actions (generateGoalPhases/decomposeGoal/checkInGoal) are
    // also op-less/silent and must keep toasting individually.
    background: !!background
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

  // The subscription transport speaks JSON-RPC over a child process, not HTTP,
  // so it takes over here — before the local-backend warm-ups, which are all
  // `/chat/completions` concerns.
  if (isSubscriptionText(provider)) {
    const attempt = await callCodexSubscription(provider, model, body, {
      statusOp, doneLabel, elapsedSec, throughput, timeout: opts.timeout, responseSchema, signal,
    });
    if (attempt.result) return attempt.result;
    // The subscription could not serve this call and the user named an explicit
    // fallback. Re-enter with the ORIGINAL prompt and options so the fallback
    // gets the same treatment any direct call would — including the creative
    // stamp, which is applied per-transport rather than carried on `body`. The
    // shared `op` groups both attempts under one toast.
    return callProviderAISimple(attempt.fallback, attempt.fallbackModel, prompt, options);
  }

  if (isOllamaProvider(provider)) {
    statusOp.update('provider:starting', 'Starting Ollama if needed…', { providerId: provider.id });
    const ready = await ensureOllamaProviderReady(provider).catch((err) => ({ success: false, error: err.message }));
    if (!ready.success) {
      const error = `Ollama is not running and PortOS could not start it: ${ready.error || 'unknown error'}`;
      statusOp.error(error);
      return { error };
    }
  }

  // The idle reaper may have stopped MTPLX to release its checkpoint. This is
  // the lazy half of that bargain — and the only place the idle clock is
  // refreshed, so a run that takes an hour still counts as use throughout.
  if (isMtplxProvider(provider)) {
    statusOp.update('provider:starting', 'Starting MTPLX if needed…', { providerId: provider.id });
    const ready = await ensureMtplxProviderReady(provider).catch((err) => ({ success: false, error: err.message }));
    if (!ready.success) {
      const error = `MTPLX is not running and PortOS could not start it: ${ready.error || 'unknown error'}`;
      statusOp.error(error);
      return { error };
    }
  }

  const first = await postChatCompletion(provider, model, body, opts);
  if (!first.error) {
    statusOp.complete(`${doneLabel} done (${elapsedSec()}s)`, throughput(first.tokens));
    return { text: first.text };
  }

  // Recover by retrying the call against `retryModel` (already loaded/healed),
  // reporting completion or error under that model id. Shared by both local
  // recovery paths below, which differ only in how they pick `retryModel`.
  const retryWith = async (retryModel) => {
    const retry = await postChatCompletion(provider, retryModel, body, opts);
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

// Extracted to lib/llmText.js in #4901 — unfencing a string needs no provider,
// and lib modules must be able to do it without importing this one. Re-exported
// here so the callers that have always imported them from aiProvider keep working.
export { stripCodeFences, parseLLMJSON } from '../lib/llmText.js';
