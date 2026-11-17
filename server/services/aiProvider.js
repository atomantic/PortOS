import { EXECUTION_OPTIONS_ERROR, resolveExecutionOptions, executionOptionsError } from '../lib/executionOptions.js';
import { awaitWithAbort } from '../lib/abortTimeout.js';
/**
 * Shared AI provider utilities for LLM calls.
 * Used by insightsService, identity, goalCheckIn, taste-questionnaire, etc.
 */

import { getAllProviders } from './providers.js';
import { startAIOp } from './aiStatusEvents.js';
// localModelHealing is lazy-imported at its (rare, error-recovery) call site
// below — a static import here pulls its notifications/providers deps (which
// eagerly import fileUtils `PATHS`) into every aiProvider consumer's module
// graph, breaking suites that partial-mock fileUtils without PATHS.
// The PURE half of the Codex subscription transport only. The process half
// (services/codexAppServer.js) is lazy-imported at its call site below, so a
// consumer of this module never pulls a child-process graph it will not use —
// and suites that partial-mock this file's deps keep working.
import { classifyCodexTransportError, isCodexTextTransportEnabled } from '../lib/codexTurn.js';
import { resolveBenchWaitMs, resolveProviderBench } from '../lib/providerCooldown.js';
import { ERROR_CATEGORIES, isRunCanceledError } from '../lib/aiToolkit/errorDetection.js';
import { isCreativeRunSource, withCreativeLatitude } from '../lib/creativeLatitude.js';
import { randomUUID } from 'node:crypto';
import { beginDirectProviderCall } from '../lib/providerCallActivity.js';
import { getAIToolkitInstance } from '../lib/aiToolkitState.js';

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
  return providers.find((provider) => !(provider.executionSourceProviderId || provider.executionSelectionRoot) && isAPI(provider)) || null;
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
  let payload;
  try {
    const listResp = await fetch(`${baseUrl}/api/v0/models`, {
      method: 'GET',
      signal: listCtl.signal
    });
    if (!listResp.ok) return null;
    payload = await listResp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(listTimer);
  }
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
  try {
    const loadResp = await fetch(`${baseUrl}/api/v1/models/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: target.id }),
      signal: loadCtl.signal
    });
    if (!loadResp.ok) {
      const errText = await loadResp.text().catch(() => 'unknown error');
      throw new Error(errText || 'unknown error');
    }
  } catch (err) {
    console.error(`❌ Failed to auto-load LM Studio model ${target.id}: ${err.message}`);
    statusOp?.update('error', `Failed to load ${target.id}: ${err.message}`, { model: target.id });
    return null;
  } finally {
    clearTimeout(loadTimer);
  }

  const loadMs = Date.now() - loadStart;
  console.log(`✅ LM Studio model loaded: ${target.id} (${loadMs}ms)`);
  statusOp?.update('model:loaded', `${target.id} loaded (${(loadMs / 1000).toFixed(1)}s)`, { model: target.id });
  return target.id;
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
  if (Object.keys(provider.executionOptions || {}).length && ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'].some((key) => provider.envVars?.[key])) {
    throw executionOptionsError('This provider has a separate authentication environment; use its native Codex route for speed options.');
  }
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
      executionOptions: provider.executionOptions,
      timeoutMs: timeout,
      responseSchema,
      signal,
    }).catch((err) => ({ error: err }));

    if (!turn.error) {
      if (turn.effortClamped) statusOp.update('model:corrected', turn.clampReason, { model: turn.model });
      statusOp.complete(`${doneLabel} done (${elapsedSec()}s)`, throughput(turn.usage?.outputTokens));
      return { result: {
        text: turn.text,
        usage: turn.usage,
        model: turn.model,
        effort: turn.effort,
        ...(turn.executionOptions ? { executionOptions: { ...turn.executionOptions, ...resolveExecutionOptions(
          { source: 'provider', options: provider.executionSelectionDefaults ?? provider.executionOptions },
          { source: 'selection', options: provider.executionSelectionOptions },
        ) } } : {}),
        effortClamped: turn.effortClamped,
        clampReason: turn.clampReason,
      } };
    }

    if (turn.error.code === EXECUTION_OPTIONS_ERROR) throw turn.error;
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
  // `temperature` / `max_tokens` — all of which a bare completion request
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
 * Returns { text, usage? } on success, { error } on failure. HTTP providers
 * surface reported prompt/completion counts when present; callers may estimate
 * only the missing side rather than treating it as a measured zero.
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
 * Pass `source`, the run-record tag for this call site (`'goal-check-in'`,
 * `'taste-summary'`). It labels the run on the Runs page and is the key the
 * IP-latitude clause is classified by (lib/creativeLatitude.js): a creative
 * source is stamped, once, on whichever transport serves the call.
 *
 * An API provider's call is a tracked run: it goes through
 * `promptRunner.runPromptThroughProvider` as a bounded completion, so it has a
 * run record, one usage session, and its reported token counts in the usage
 * ledger. Two legs are not runs: the ChatGPT subscription (its transcript
 * reconciler owns that bill) and a process with no AI toolkit (the local-review
 * bridge script has no run store), which sends the same request untracked.
 *
 * Pass `appId` and/or `workspacePath` when the call originates on behalf of a
 * managed app or CoS-agent workspace — the OpenWorld AI Core aims its activity
 * beam at that building (falling back to a generic radial beam when neither is
 * supplied). Output token counts from the provider are reported on completion
 * so the beam's thickness can track tokens/sec.
 */
export async function callProviderAISimple(provider, model, prompt, options = {}) {
  const { maintenance } = await import('../lib/maintenanceAdmission.js');
  return maintenance.run('api-run', randomUUID(), () => callProviderAISimpleImpl(provider, model, prompt, options), { continuation: true });
}

/**
 * Count `work` as a live direct provider call for as long as it runs. Only the
 * stretches no run record covers are counted this way (the subscription turn,
 * the readiness warm-up, an untracked request); a tracked run is counted by the
 * run registry, and counting it here too would show one request as two.
 */
async function asDirectProviderCall(work) {
  const end = beginDirectProviderCall();
  try { return await work(); } finally { end(); }
}

/**
 * Send a bounded completion as a tracked run and fold the runner's
 * resolve/reject back into the exchange's own `{ text | error }` reply.
 */
async function runTrackedCompletion({ provider, model, prompt, source, temperature, maxTokens, timeout, signal, recover }) {
  const { runPromptThroughProvider } = await import('./promptRunner.js');
  return runPromptThroughProvider({
    provider, prompt, source, model, timeout, signal,
    completion: { temperature, maxTokens, recover },
  }).catch(async (err) => {
    // The provider answered with a failure: the runner already recorded it.
    if (err?.completionFailure) return err.completionFailure;
    const { isMaintenanceHold } = await import('../lib/maintenanceAdmission.js');
    if (isMaintenanceHold(err) || err?.code === EXECUTION_OPTIONS_ERROR) throw err;
    // Aborted in the gap after this module's own checks: no request went out.
    if (isRunCanceledError(err)) return { error: 'Provider request deadline expired.' };
    // Anything else is the run store or the runner refusing before dispatch.
    return { error: err?.message || String(err) };
  });
}

/** The same request with no run store to record into (no AI toolkit in this process). */
async function runUntrackedCompletion(request) {
  const { runChatCompletion } = await import('./chatCompletionExchange.js');
  const result = await runChatCompletion(request);
  if (result.reportedUsage) {
    // Ledger failure must not fail the completion.
    void import('./usage.js').then(({ recordRunUsage }) => recordRunUsage({
      providerId: request.provider.id,
      model: result.model,
      messages: 1,
      ...result.reportedUsage,
    })).catch((err) => console.error(`❌ Failed to record chat usage: ${err.message}`));
  }
  return result;
}

// The run-record tag for a caller that named none. Operational, so an unnamed
// call is never stamped with the IP-latitude clause by accident.
const DEFAULT_RUN_SOURCE = 'provider-text';

async function callProviderAISimpleImpl(provider, model, prompt, options) {
  const {
    temperature = 0.3, max_tokens = 1000, op, opLabel, appId, workspacePath, background,
    source = DEFAULT_RUN_SOURCE,
    // A JSON Schema the answer must match. Only the Codex subscription transport
    // can enforce it (the app-server constrains the final message); the HTTP path
    // ignores it, exactly as it has always ignored unknown options.
    responseSchema = null,
    // Aborting stops the active Codex turn, or the in-flight HTTP request,
    // instead of leaving it to burn quota for an answer nobody is waiting for.
    signal = null,
    deadlineMs = null,
    // Internal: the status op an outer attempt already opened. `startAIOp` mints
    // a fresh id per call and the client tracks ops BY ID, so a fallback leg that
    // opened its own would leave the outer one's loading toast spinning forever
    // — nothing ever terminates it. Reusing the handle keeps the whole handoff
    // one op: "falling back to X…" → "done".
    __statusOp = null,
  } = options;
  if (signal?.aborted || (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs)) return { error: 'Provider request deadline expired.' };
  if (Object.keys(provider.executionOptions || {}).length && !isSubscriptionText(provider)) {
    throw executionOptionsError('Execution speed is unsupported on this API route.');
  }
  if (provider.type !== 'api' && !isSubscriptionText(provider)) {
    return { error: 'This operation requires an API-based provider' };
  }
  // The stamp for the two legs the shared runner never sees (the subscription
  // and a toolkit-less process). A tracked run is handed the bare prompt and
  // stamped by the runner, from the same `source`.
  const stamped = () => (isCreativeRunSource(source) ? withCreativeLatitude(prompt) : prompt);
  let timeout = provider.timeout || DEFAULT_PROVIDER_TIMEOUT_MS;

  // Always emit status events (server logs + UI toasts) for AI calls. Callers
  // can pass `op` to give the toast a meaningful label; otherwise it's labeled
  // generically by provider+model so the user still sees model loads etc.
  const effectiveOp = op || `ai-call:${provider.id}`;
  const effectiveLabel = opLabel || `Calling ${provider.name || provider.id}…`;
  const statusOp = __statusOp ?? startAIOp({
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
    const attempt = await asDirectProviderCall(() => callCodexSubscription(provider, model, stamped(), {
      statusOp, doneLabel, elapsedSec, throughput, timeout, responseSchema, signal,
    }));
    if (attempt.result) return attempt.result;
    // The subscription could not serve this call and the user named an explicit
    // fallback. Re-enter with the ORIGINAL prompt and options so the fallback
    // gets the same treatment any direct call would — including the creative
    // stamp, which follows `source` rather than being carried on the prompt. The
    // shared `op` groups both attempts under one toast.
    return callProviderAISimple(attempt.fallback, attempt.fallbackModel, prompt, {
      ...options, __statusOp: statusOp,
    });
  }

  // The idle reaper may stop a managed local runtime (Ollama, MTPLX,
  // Slotstream) to release memory/checkpoint. This is the lazy half of that
  // bargain — the only place a simple call refreshes the idle clock, so a
  // run that takes an hour still counts as use throughout, and the next call
  // doesn't get a bare connection refusal.
  // Provider selection and parsing need none of the managed daemon graph.
  const { ensureManagedRuntimeReady } = await import('./providerExecutionReadiness.js');
  const ready = await asDirectProviderCall(() => awaitWithAbort(ensureManagedRuntimeReady(provider, {
    onStarting: (label) => statusOp.update('provider:starting', `Starting ${label} if needed…`, { providerId: provider.id }),
  }), signal)).catch(() => ({ success: false, error: 'Provider readiness cancelled.' }));
  if (!ready.success) {
    statusOp.error(ready.error);
    return { error: ready.error };
  }

  if (signal?.aborted || (Number.isFinite(deadlineMs) && Date.now() >= deadlineMs)) {
    statusOp.error('Provider request deadline expired.');
    return { error: 'Provider request deadline expired.' };
  }
  if (Number.isFinite(deadlineMs)) timeout = Math.min(timeout, deadlineMs - Date.now());

  // The repair step for a failed first attempt. It runs INSIDE the run, so a
  // recovered call is still one run record and one usage session.
  const recover = options.allowModelRecovery === false ? null : async (first) => {
    // LM Studio answers 400 "No models loaded" whatever model was named, so
    // load one and retry with the id that is actually in memory.
    if (first.status === 400 && LM_STUDIO_NO_MODEL_RE.test(first.body || '')) {
      const loaded = await ensureLMStudioModelLoaded(provider, statusOp);
      if (loaded) {
        statusOp.update('start', `Calling ${provider.name || provider.id} (${loaded})…`, { model: loaded });
        return loaded;
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
        return healed.model;
      }
    }
    return null;
  };

  const request = { provider, model, temperature, maxTokens: max_tokens, timeout, signal, recover };
  const final = getAIToolkitInstance()
    ? await runTrackedCompletion({ ...request, prompt, source })
    : await asDirectProviderCall(() => runUntrackedCompletion({ ...request, prompt: stamped() }));

  // A recovered call reports under the model that answered.
  const answeredBy = final.retried ? { model: final.model } : null;
  if (!final.error) {
    statusOp.complete(`${doneLabel} done (${elapsedSec()}s)`, { ...answeredBy, ...throughput(final.tokens) });
    return { text: final.text, finishReason: final.finishReason, ...(final.usage ? { usage: final.usage } : {}) };
  }
  if (answeredBy) statusOp.error(final.error, answeredBy);
  else statusOp.error(final.error);
  return { error: final.error, ...(Number.isInteger(final.status) ? { status: final.status } : {}), ...(final.stallPhase ? { stallPhase: final.stallPhase } : {}) };
}

// Extracted to lib/llmText.js in #4901 — unfencing a string needs no provider,
// and lib modules must be able to do it without importing this one. Re-exported
// here so the callers that have always imported them from aiProvider keep working.
export { stripCodeFences, parseLLMJSON } from '../lib/llmText.js';
