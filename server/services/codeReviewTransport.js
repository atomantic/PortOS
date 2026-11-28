// Resolve reviewer capabilities and execute review prompts over local HTTP, provider API, or CLI transports.

import { EXECUTION_OPTIONS_ERROR, codexSpeedProbeFailureMessage, codexSpeedProbeStage } from '../lib/executionOptions.js'
import { takeCodeReviewCallBudget, isReviewContextCapacityFailure, reviewContextCapacityFailure } from '../lib/codeReviewBatches.js'
import { withAbortTimeout, awaitWithAbort } from '../lib/abortTimeout.js'
import { effortLevelsForProvider } from '../lib/provider/providerModels.js'
import { DEFAULT_TIMEOUT as PROVIDER_DEFAULT_TIMEOUT_MS } from '../lib/aiToolkit/constants.js'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { readResponseJson } from '../lib/readResponseJson.js'
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js'
import { normalizeOpenAiBaseUrl } from '../lib/localProviderRuntime.js'
import { LOCAL_LLM_REVIEWERS, isProviderReviewer, normalizeReviewerEffort } from '../lib/reviewerConfig.js'
import { CODE_REVIEWERS_PAGE_BREADCRUMB } from '../lib/navManifest.js'
import { reviewerCommandPermissionFailureCode, normalizeReviewFinishReason, reviewFailureDiagnostics } from '../lib/reviewerHealth.js'
import { listProviders, getProviderById } from './provider/providers.js'
import { safeJSONLParse } from '../lib/jsonIo.js'
import { PUBLIC_REVIEW_GATE_EXECUTION_PROFILE } from '../lib/agent/agentExecutionProfiles.js'
import { PATHS } from '../lib/paths.js'
import { getAIToolkitInstance } from '../lib/aiToolkitState.js'

// LM Studio (`:1234`), Ollama (`:11434`) and MTPLX (`:8000/v1`) all ship
// OpenAI-compatible `/v1/chat/completions`. Resolve through each manager's live
// endpoint accessor so a runtime `updateConfig({ baseUrl })` from the local-LLM
// tab — or an MTPLX daemon relaunched on another port — takes effect here too;
// otherwise the catalog UI and the reviewer would silently desync when a user
// relocates their install.
//
// Every entry is awaited at the call site. Keep all manager imports lazy:
// defaults-only callers (agent prompting, task generation and cleanup) must not
// load model download/install or daemon-management dependencies. Each manager
// remains the owner of its live endpoint; only a selected backend loads it.
const BACKEND_BASE_URLS = {
  lmstudio: async () => (await import('./lmStudioManager.js')).getBaseUrl(),
  ollama: async () => (await import('./ollamaManager.js')).getBaseUrl(),
  mtplx: async () => (await import('./mtplxServerManager.js')).getMtplxServerEndpoint(),
}

export function isLocalLlmReviewer(backend) {
  return LOCAL_LLM_REVIEWERS.includes(backend)
}

const KIBIBYTE = 1024
export const LOCAL_CODE_REVIEW_TIMEOUT_FLOOR_MS = 120_000
export const LOCAL_CODE_REVIEW_TIMEOUT_CEILING_MS = 300_000
export const LOCAL_CODE_REVIEW_TIMEOUT_PER_KIB_MS = 2_000

/**
 * Derive the default wall-clock budget for a code-review diff.
 *
 * The first KiB keeps today's 120-second cold-load floor. Each additional
 * (partial) KiB adds two seconds for prefill and generation, up to the
 * five-minute ceiling shared by the CLI provider runner. A positive explicit
 * `timeoutMs` passed to `runLocalCodeReview` is an operator override and is
 * intentionally not capped by this derived default.
 */
export function getLocalCodeReviewTimeoutMs(diff) {
  const diffBytes = typeof diff === 'string' ? Buffer.byteLength(diff, 'utf8') : 0
  const additionalKib = Math.max(0, Math.ceil(diffBytes / KIBIBYTE) - 1)
  return Math.min(
    LOCAL_CODE_REVIEW_TIMEOUT_CEILING_MS,
    LOCAL_CODE_REVIEW_TIMEOUT_FLOOR_MS + additionalKib * LOCAL_CODE_REVIEW_TIMEOUT_PER_KIB_MS,
  )
}

// Remote API reasoning models spend their latency thinking, not prefilling, so
// the local diff-size formula starves them. A provider record's own `timeout`
// wins (bounded); otherwise API calls use this wall-clock default and CLI
// reviews use the longer inactivity default below. Output renews a CLI deadline.
export const REMOTE_CODE_REVIEW_TIMEOUT_DEFAULT_MS = 600_000
export const REMOTE_CODE_REVIEW_TIMEOUT_CEILING_MS = 1_800_000
export const CLI_CODE_REVIEW_INACTIVITY_DEFAULT_MS = 1_800_000

// 300000 is the generic run default that the toolkit's create path, the
// provider form's pre-fill and the shipped samples all write, so on a stored
// record it means "never tuned", not a chosen review cap — and no record can
// tell the two apart after the fact. Honoring it cut grok-cli claim reviews
// of ordinary ~23 KiB diffs off at 300 s (#14499); every other value still wins.
export const getRemoteCodeReviewTimeoutMs = (provider, transport = 'api') => (
  Number.isFinite(provider?.timeout) && provider.timeout > 0 && provider.timeout !== PROVIDER_DEFAULT_TIMEOUT_MS
    ? Math.min(REMOTE_CODE_REVIEW_TIMEOUT_CEILING_MS, provider.timeout)
    : transport === 'cli' ? CLI_CODE_REVIEW_INACTIVITY_DEFAULT_MS : REMOTE_CODE_REVIEW_TIMEOUT_DEFAULT_MS
)

const diffSizeLabel = (diffSizeBytes) => {
  const bytes = Math.max(0, Number(diffSizeBytes) || 0)
  return `${Math.max(1, Math.ceil(bytes / KIBIBYTE))} KiB (${bytes} bytes)`
}

export const isTimeoutFailure = (error) => /no output activity for\s+\d+\s*ms|inactive for\s+\d+\s*ms|timed out after\s+\d+\s*ms|did not finish within\s+\d+(?:ms|s)|operation was aborted|request was aborted|abort(?:ed|ing)?/i.test(String(error || ''))

export function localCodeReviewTimeoutError({ backend, timeoutMs, diffSizeBytes, phase, inactivityTimeoutMs = null }) {
  const description = phase === 'no-output' ? 'reviewer process emitted no output'
    : phase === 'output-open' ? 'reviewer process emitted output but did not exit'
    : phase === 'exit-drain' ? 'reviewer process exited but output pipes did not close'
    : phase === 'no-response'
    ? 'backend never answered'
    : phase === 'response-body'
      ? 'backend was reachable but did not finish'
      : 'reviewer process did not finish'
  const deadline = inactivityTimeoutMs ? `no output activity for ${inactivityTimeoutMs}ms` : `timed out after ${timeoutMs}ms`
  return `${backend} ${description} — ${deadline} for a ${diffSizeLabel(diffSizeBytes)} diff.`
}

/**
 * Both halves of the provider code-review answer from one provider read.
 *
 * `unsupported`: which `provider:<id>` reviewers this machine cannot invoke a
 * code review on, e.g. `{ 'provider:opencode-zen-cli': 'REVIEWER_UNSUPPORTED' }`.
 * Warn-only (#3606): the reviewer list is federation-wide config, so it never
 * filters or rejects a reviewer. Only refusing providers appear; a capable one
 * is absent rather than `false`. Deliberately NOT memoized, because a stale
 * answer would contradict a Settings change the user just made.
 *
 * `capable`: the `provider:<id>` tokens that CAN review here — what
 * `withoutResolvedUnsupportedFaults` clears stale faults by.
 */
export async function getProviderReviewCapability() {
  const providers = await listProviders().catch(() => [])
  const resolved = await Promise.all(providers.map(async (provider) => [
    `provider:${provider.id}`,
    // The picker configures CODE reviewers, so ask the code-review question.
    await resolveProviderReviewTransport(provider, { allowUnconfined: true }),
  ]))
  return {
    // A switched-off provider is already reported as `disabled` by the picker's
    // own provider-record check, so re-reporting it here would badge it twice
    // with two different words for one fact.
    unsupported: Object.fromEntries(resolved
      .filter(([, { transport, code }]) => !transport && code !== 'REVIEWER_UNAVAILABLE')
      .map(([token, { code }]) => [token, code])),
    capable: new Set(resolved.filter(([, { transport }]) => transport).map(([token]) => token)),
  }
}

// Ollama translates the OpenAI-compatible `reasoning_effort` field into its
// own `thinking` parameter, and a model that never implements thinking 400s
// on the whole request rather than ignoring the field. Ollama's `/api/show`
// DOES answer that per model, so `modelRejectsThinking` resolves it BEFORE
// the request and simply omits the field — the 400-retry further down stays
// as the fail-safe for a backend with no such probe (LM Studio, MTPLX) or a
// probe that could not answer. Resolving ahead matters because every reviewer
// invocation from a claim/PR run is its own short-lived `node` process: a
// purely reactive downgrade re-uploads the entire diff on every single call,
// since the in-process cache below never survives to the next one.
//
// This map remembers which `backend:model` pairs are known thinking-less —
// for the life of the process — so a multi-round review loop inside ONE
// process pays neither the probe nor the retry twice.
const thinkingUnsupportedModels = new Map()
const thinkingCacheKey = (backend, model) => `${backend}:${model}`
export function __resetThinkingUnsupportedCache() { thinkingUnsupportedModels.clear() }

/**
 * Does this `backend:model` reject `reasoning_effort`?
 *
 * `true` only when we KNOW it does — a cached prior downgrade, or an
 * authoritative capability list that omits `thinking`. Ollama reports `null`
 * when the per-model probe failed and `[]` when the daemon answered without
 * reporting any capabilities; both mean *unknown*, not *unsupported*, so they
 * fall through to the request (and its 400-retry) rather than silently
 * dropping a level the model does in fact accept.
 */
async function modelRejectsThinking(backend, model, reviewBudget = null) {
  const cacheKey = thinkingCacheKey(backend, model)
  if (thinkingUnsupportedModels.get(cacheKey) === true) return true
  if (backend !== 'ollama') return false
  const capabilities = await import('./ollamaManager.js')
    .then(({ getModelCapabilities }) => {
      if (!reviewBudget) return getModelCapabilities(model)
      const remainingMs = reviewBudget.deadline - Date.now()
      if (remainingMs <= 0) return null
      return withAbortTimeout(remainingMs, signal => awaitWithAbort(getModelCapabilities(model, { signal, timeout: remainingMs }), signal))
    })
    .catch(() => null)
  if (!Array.isArray(capabilities) || capabilities.length === 0) return false
  if (capabilities.includes('thinking')) return false
  thinkingUnsupportedModels.set(cacheKey, true)
  return true
}

async function sendChatCompletion(baseUrl, { model, messages, timeoutMs }, effortForRequest) {
  const body = {
    model,
    messages,
    temperature: 0.2,
    stream: false,
    ...(effortForRequest ? { reasoning_effort: effortForRequest } : {}),
  }
  const response = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, timeoutMs).catch((err) => ({ ok: false, _fetchError: err.message }))
  if (response._fetchError !== undefined) {
    return { ok: false, error: `request failed: ${response._fetchError}` }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { ok: false, status: response.status, text }
  }
  return { ok: true, response }
}

const SERVED_MODEL_PROBE_TIMEOUT_MS = 5_000

/**
 * The model a local reviewer runs with when the user pinned none: ask the
 * backend what it is actually serving, and use it when the answer is
 * unambiguous.
 *
 * A single-model daemon (MTPLX, llama.cpp, vLLM — and LM Studio with one model
 * loaded) makes "which model?" a question with exactly one answer, so failing
 * the whole review pass over an unset `<backend>Model` scalar blocks a review
 * loop on a config field that carries no information. An MTPLX reviewer hit
 * exactly that: the daemon was up and serving, and the pass returned no verdict
 * because nothing had typed the model id into settings.
 *
 * Ambiguity is NOT resolved by guessing. Ollama lists every installed model, so
 * a normal install answers with many — picking one would silently review with a
 * model the user never chose (a small embedding or chat model reads a diff very
 * differently from a coder model). Several models, none, or an unreadable
 * listing all fall through to the "pin one" error.
 *
 * @returns {Promise<{model: string|null, reason: string|null}>}
 */
async function resolveServedModel(backend, baseUrl, timeoutMs = SERVED_MODEL_PROBE_TIMEOUT_MS) {
  // Back to the `/v1` root the probe wants, through the shared normalizer rather
  // than a re-typed suffix — the caller collapsed it to the host root for the
  // chat-completions path.
  const probe = await probeOpenAiModels(normalizeOpenAiBaseUrl(baseUrl), { timeoutMs })
    .catch((err) => ({ reachable: false, models: null, error: err.message }))
  if (!probe.reachable) return { model: null, reason: `${backend} is not reachable (${probe.error || 'no response'})` }
  if (!Array.isArray(probe.models)) return { model: null, reason: `${backend} did not report which models it is serving` }
  if (probe.models.length === 0) return { model: null, reason: `${backend} is serving no models` }
  if (probe.models.length > 1) return { model: null, reason: `${backend} is serving ${probe.models.length} models, so there is no unambiguous default` }
  return { model: probe.models[0], reason: null }
}

/**
 * Resolve the selected provider's review transport. A CLI reviewer runs under
 * the strongest mode its vendor enforces (`codeReviewTier`, #6338):
 *
 * - `no-tool`    — the no-tool public-review recipe (claude, grok, …).
 * - `read-only`  — an enforced mode that may read but never write (codex's
 *                   read-only sandbox).
 * - `unconfined` — no enforced mode (Antigravity, and any other harness): the
 *                   vendor's ordinary headless argv, run in a throwaway scratch
 *                   directory with the diff inlined in the prompt and the
 *                   no-tool environment allowlist (no forge or cloud
 *                   credentials), with a review-only prompt that prohibits edits.
 *
 * Code reviews, including claim reviews, admit the scratch-directory fallback:
 * vendor isolation is preferred when available, not required to review code.
 * Public-comment screening leaves `allowUnconfined` off and still requires an
 * enforced mode. A scratch cwd limits checkout exposure; it is not an OS sandbox.
 */
export async function resolveProviderReviewTransport(provider, { allowUnconfined = false } = {}) {
  if (!provider || provider.enabled === false) {
    return { transport: null, code: 'REVIEWER_UNAVAILABLE', error: 'Reviewer provider is missing or disabled.' }
  }
  const { isCodexTextTransportEnabled } = await import('../lib/codexTurn.js')
  if (provider.type === 'api' || isCodexTextTransportEnabled(provider)) return { transport: 'api' }
  if (!provider.command) return { transport: null, code: 'REVIEWER_UNSUPPORTED', error: 'Reviewer provider has no command configured.' }
  const { codeReviewTier } = await import('../lib/provider/providerVendors.js')
  const tier = codeReviewTier(provider) || (allowUnconfined ? 'unconfined' : null)
  if (tier) return { transport: 'cli', tier }
  return {
    transport: null,
    code: 'REVIEWER_UNSUPPORTED',
    error: 'This provider has no enforced no-tool or read-only mode for this review. Use its API mode or a local model.',
  }
}

function resolveReviewWorkspace({ transport, isolateFromCheckout = false, cwd }) {
  if (transport.transport !== 'cli') return { cwd: 'none', repositoryAccess: false }
  if (isolateFromCheckout || transport.tier === 'unconfined' || !cwd) {
    return { cwd: 'scratch', repositoryAccess: false }
  }
  // `no-tool` (grok, claude `--tools ''`) cannot open the checkout. Inviting
  // it to inspect source makes it narrate a prose review, which the verdict
  // parser correctly rejects as invalid_json (#14523). Only a read-only tier
  // can look at surrounding code.
  return { cwd: 'checkout', repositoryAccess: transport.tier === 'read-only' }
}

function reviewMessages({ messages, userMessage, systemPromptFor }, workspace) {
  return systemPromptFor
    ? [{ role: 'system', content: systemPromptFor(workspace.repositoryAccess) }, userMessage]
    : messages
}

export async function loadReviewProvider(backend) {
  const providerId = backend.slice('provider:'.length)
  // The auth-independent claim bridge has no server bootstrap. Use the same
  // provider-store reader for toolkit-less callers without starting a server.
  if (getAIToolkitInstance()) return getProviderById(providerId)
  const { createProviderService } = await import('../lib/aiToolkit/providers.js')
  return createProviderService({ dataDir: PATHS.data }).getProviderById(providerId)
}

// A rejected reviewer call never reaches the verdict parser. An execution-options
// refusal keeps its own message; any other rejection is replaced with `message`
// so vendor/setup detail (paths, credentials) cannot leak into the review.
function reviewerCallRejection(error, message, reviewBudget) {
  if (error.code === EXECUTION_OPTIONS_ERROR) {
    return { error: codexSpeedProbeFailureMessage(error.probeFailure, error.probeStage) ?? error.message, code: error.code,
      ...reviewProbeFields(error) }
  }
  return { error: message, code: reviewBudget && Date.now() >= reviewBudget.deadline ? 'REVIEW_BUDGET_EXHAUSTED' : 'REVIEW_BATCH_FAILED' }
}

export function reviewProbeFields({ code, probeFailure, probeStage: stage }) {
  if (code !== EXECUTION_OPTIONS_ERROR || !codexSpeedProbeFailureMessage(probeFailure)) return {}
  const probeStage = codexSpeedProbeStage(probeFailure, stage)
  return { probeFailure, ...(probeStage ? { probeStage } : {}) }
}

const REVIEW_FAILURE_DETAIL_FIELDS = ['diagnostics', 'stderr', 'text', 'status', 'statusCode', 'stallPhase', 'name', 'code']

function pickReviewFailureDetail(result, fields = REVIEW_FAILURE_DETAIL_FIELDS) {
  const detail = {}
  for (const field of fields) if (result[field]) detail[field] = field === 'diagnostics' ? reviewFailureDiagnostics(result[field]) : result[field]
  return detail
}

// Each transport step resolves to `{ outcome }` (a final answer for the caller)
// or `{ result, budgetMs }` (a raw reply plus the budget the call actually had).
async function runApiReviewCall({ provider, model, prompt, budgetMs, reviewBudget }) {
  if (!model) return { outcome: { ok: false, code: 'NO_MODEL', error: 'Select a model for the reviewer provider.' } }
  const { callProviderAISimple } = await import('./aiProvider.js')
  const callMs = takeCodeReviewCallBudget(reviewBudget, budgetMs)
  if (callMs === null) return { outcome: { ok: false, code: 'REVIEW_BUDGET_EXHAUSTED', error: 'The configured review budget is exhausted.' } }
  const result = await withAbortTimeout(callMs, signal => awaitWithAbort(callProviderAISimple({ ...provider, apiKey: provider.apiKey, timeout: callMs, fallbackProvider: null }, model,
    prompt, { source: 'code-review', max_tokens: 8192, allowModelRecovery: false, signal, deadlineMs: reviewBudget?.deadline }), signal))
    .catch(error => reviewerCallRejection(error, 'Reviewer preparation or execution failed within its shared budget.', reviewBudget))
  return { result, budgetMs: callMs }
}

async function runCliReviewCall({ provider, model, prompt, transport, workspace, reviewCwd, budgetMs, reviewBudget, reserveCodexProbeRetry }) {
  if (!transport.transport) return { outcome: { ok: false, code: transport.code, error: transport.error } }
  const preparationStartedAt = Date.now()
  const { runCliProviderPrompt } = await import('../lib/cliProviderRun.js')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  // Every CLI review keeps the no-tool environment allowlist. A no-tool or
  // read-only tier runs the vendor's enforced reviewer argv; the `unconfined`
  // tier runs its ordinary argv (see `resolveProviderReviewTransport`), so it
  // never gets the caller's checkout: it runs in a scratch directory with the
  // diff inlined. Otherwise `isolateFromCheckout` controls cwd isolation — public content
  // stays off the real checkout, while an ordinary review may still read it.
  const safetyProfile = PUBLIC_REVIEW_GATE_EXECUTION_PROFILE
  const isolatedCwd = workspace.cwd === 'scratch' ? await mkdtemp(join(tmpdir(), 'portos-review-')) : null
  const cwd = isolatedCwd || reviewCwd
  const result = await Promise.resolve().then(async () => {
    const { resolveBootstrapEnv } = await import('../lib/credentialBootstrap.js')
    const preparationMs = reviewBudget ? reviewBudget.deadline - Date.now() : budgetMs
    if (preparationMs <= 0) return { error: 'The configured review budget is exhausted.', code: 'REVIEW_BUDGET_EXHAUSTED' }
    const bootstrapEnv = await withAbortTimeout(preparationMs, signal => awaitWithAbort(resolveBootstrapEnv(provider, { safetyProfile, signal, timeoutMs: preparationMs }), signal))
    const remainingMs = takeCodeReviewCallBudget(reviewBudget, budgetMs)
    if (remainingMs === null) return { error: 'The configured review budget is exhausted.', code: 'REVIEW_BUDGET_EXHAUSTED' }
    const inactivityTimeoutMs = reviewBudget?.budgetMs ?? budgetMs
    const onActivity = () => { if (reviewBudget) reviewBudget.deadline = Date.now() + inactivityTimeoutMs }
    onActivity()
    const preparationElapsedMs = Date.now() - preparationStartedAt
    const reply = await runCliProviderPrompt({ provider, model, prompt, cwd, timeoutMs: remainingMs, bootstrapEnv, exactPins: true,
      safetyProfile, codeReview: true, inactivityTimeoutMs, onActivity, ...(reserveCodexProbeRetry ? { reserveCodexProbeRetry } : {}) })
    return { ...reply, ...(reply.diagnostics?.cli ? { diagnostics: reviewFailureDiagnostics({ cli: { ...reply.diagnostics.cli, preparationMs: preparationElapsedMs } }) } : {}) }
  }).catch(error => reviewerCallRejection(error, 'Reviewer credential setup or execution failed.', reviewBudget))
  const teardownStartedAt = Date.now()
  if (isolatedCwd) await rm(isolatedCwd, { recursive: true, force: true })
  if (result.diagnostics?.cli) result.diagnostics = reviewFailureDiagnostics({ cli: { ...result.diagnostics.cli, teardownMs: Date.now() - teardownStartedAt } })
  const refusal = headlessCommandPermissionRefusal(result)
  if (refusal) return { outcome: refusal }
  // A capacity refusal outranks the partial-reply answer; the caller classifies it.
  if (isReviewContextCapacityFailure(result)) return { result, budgetMs }
  if (result.partial) return { outcome: partialCliReplyFailure(result) }
  return { result: await settleStreamJsonReply(result), budgetMs }
}

// A failed headless command request is a configuration fault, not a verdict.
// Replace vendor prose with a bounded remedy before health or bridge output.
function headlessCommandPermissionRefusal(result) {
  if (isTimeoutFailure(result.error)) return null
  if (!result.error && !result.partial && result.text?.trim()) return null
  // The CLI runner truncates error to a stderr prefix; the full stderr can
  // carry the explicit refusal after that prefix. A timeout stays transient.
  const code = reviewerCommandPermissionFailureCode(result.error) || reviewerCommandPermissionFailureCode(result.stderr)
  if (!code) return null
  return {
    ok: false,
    code,
    error: 'The headless reviewer required command permission. Use a compatible non-interactive review transport or supported tool-free vendor configuration.',
  }
}

function partialCliReplyFailure(result) {
  const errorMsg = result.stderr?.trim() || result.text?.trim() || 'Reviewer exited before completing its response.'
  return { ok: false, error: errorMsg, ...pickReviewFailureDetail(result, ['diagnostics', 'stderr', 'text']) }
}

// A stream-json reply succeeds only through its last `result` event; any error
// event fails the reply unless that result event exists and succeeded.
async function settleStreamJsonReply(result) {
  if (result.error || result.streamFormat !== 'stream-json') return result
  const events = safeJSONLParse(result.text)
  const errorEvent = events.findLast(event => event.type === 'error' || event.is_error)
  const final = events.findLast(event => event.type === 'result')
  if (errorEvent && (!final || final.is_error)) {
    return { ...result, error: errorEvent.error || errorEvent.message || 'Reviewer returned an error event.', stderr: result.stderr, text: result.text }
  }
  // A final event carrying `is_error` is itself the matched error event above.
  return typeof final?.result !== 'string'
    ? { ...result, error: 'Reviewer returned no successful final result.', stderr: result.stderr, text: result.text }
    : { ...result, text: final.result }
}

function reviewReplyFailure(result, timeoutMs) {
  const probe = reviewProbeFields(result)
  const probeMessage = codexSpeedProbeFailureMessage(probe.probeFailure, probe.probeStage)
  return { ok: false, timeoutMs, error: probeMessage || result.error || result.stderr || result.text || 'Reviewer returned no content.',
    ...probe, ...pickReviewFailureDetail(result) }
}

// Resolve the exact record the user selected. Never fall back to the active
// provider, another account, or a replacement model for a pinned reviewer.
async function runConfiguredProviderCompletion({ backend, model: pinnedModel, messages, userMessage, systemPromptFor, effort, timeoutMs, timeoutExplicit = true, cwd: reviewCwd, isolateFromCheckout = false, allowUnconfined = false, providerSnapshot = null, reviewBudget = null, reserveCodexProbeRetry = false }) {
  let provider = providerSnapshot || await loadReviewProvider(backend)
  const transport = await resolveProviderReviewTransport(provider, { allowUnconfined })
  // A missing/disabled record is refused here, but an unsupported HARNESS is
  // refused in the CLI step instead — a pinned effort the provider's model
  // cannot do is the more specific complaint, and it was already the answer this
  // path gave before the resolver was extracted.
  if (transport.code === 'REVIEWER_UNAVAILABLE') return { ok: false, code: transport.code, error: transport.error }
  const model = pinnedModel || provider.defaultModel
  if (effort && !effortLevelsForProvider(provider, model)?.includes(effort)) {
    return { ok: false, error: 'The selected reviewer model does not support this reasoning effort.' }
  }
  if (effort) provider = { ...provider, apiKey: provider.apiKey, effort }
  const workspace = resolveReviewWorkspace({ transport, isolateFromCheckout, cwd: reviewCwd })
  const prompt = reviewMessages({ messages, userMessage, systemPromptFor }, workspace).map(message => message.content).join('\n\n')
  // API and CLI reviewers front remote reasoning models; the diff-size formula only suits local backends.
  const isRemoteTransport = transport.transport === 'api' || transport.transport === 'cli'
  const budgetMs = !timeoutExplicit && isRemoteTransport ? getRemoteCodeReviewTimeoutMs(provider, transport.transport) : timeoutMs
  const call = { provider, model, prompt, budgetMs, reviewBudget }
  const run = transport.transport === 'api'
    ? await runApiReviewCall(call)
    : await runCliReviewCall({ ...call, transport, workspace, reviewCwd, reserveCodexProbeRetry })
  if (run.outcome) return run.outcome
  const { result } = run
  if (isReviewContextCapacityFailure(result)) return { ...reviewContextCapacityFailure(), backend, model, effort }
  if (result.error || !result.text?.trim()) return reviewReplyFailure(result, run.budgetMs)
  return { ok: true, backend, model, ...(result.diagnostics ? { diagnostics: reviewFailureDiagnostics(result.diagnostics) } : {}), ...(result.executionOptions ? { executionOptions: result.executionOptions } : {}), effort: effort || provider.effort || null, content: result.text.trim(), finishReason: normalizeReviewFinishReason(result.finishReason), responseLengthChars: result.text.length }
}

export async function runReviewerCompletion({ backend, model: pinnedModel, messages, userMessage, systemPromptFor, effort, timeoutMs, timeoutExplicit = true, baseUrl: requestedBaseUrl = null, cwd, isolateFromCheckout = false, allowUnconfined = false, diffSizeBytes = null, providerSnapshot = null, reviewBudget = null, reserveCodexProbeRetry = false }) {
  if (isProviderReviewer(backend)) {
    const result = await runConfiguredProviderCompletion({ backend, model: pinnedModel, messages, userMessage, systemPromptFor, effort, timeoutMs, timeoutExplicit, cwd, isolateFromCheckout, allowUnconfined, providerSnapshot, reviewBudget, reserveCodexProbeRetry })
    if (result.ok || !Number.isFinite(diffSizeBytes) || !isTimeoutFailure(result.error)) return result
    return {
      ...result,
      error: localCodeReviewTimeoutError({ backend, timeoutMs: reviewBudget?.budgetMs ?? result.timeoutMs ?? timeoutMs, diffSizeBytes, phase: result.diagnostics?.cli?.phase || result.stallPhase || 'reviewer-process', inactivityTimeoutMs: result.diagnostics?.cli?.inactivityTimeoutMs }),
    }
  }
  if (!isLocalLlmReviewer(backend)) {
    return { ok: false, error: `Unsupported reviewer backend: ${backend}` }
  }
  const workspace = resolveReviewWorkspace({ transport: { transport: 'api' }, isolateFromCheckout, cwd })
  messages = reviewMessages({ messages, userMessage, systemPromptFor }, workspace)
  // Local runtime records are normalized to the OpenAI `/v1` root, while the
  // legacy backend managers return the host root. Keep both forms compatible
  // with the one endpoint suffix below.
  const baseUrl = String(requestedBaseUrl || await BACKEND_BASE_URLS[backend]())
    .replace(/\/+$/, '')
    .replace(/\/v\d+$/i, '')

  // An unpinned model is recoverable when the backend serves exactly one — see
  // `resolveServedModel`. Resolved BEFORE the effort probe below, which is keyed
  // by `backend:model`.
  let model = pinnedModel
  if (!model || typeof model !== 'string') {
    const probeTimeoutMs = reviewBudget ? Math.min(SERVED_MODEL_PROBE_TIMEOUT_MS, reviewBudget.deadline - Date.now()) : SERVED_MODEL_PROBE_TIMEOUT_MS
    if (probeTimeoutMs <= 0) return { ok: false, code: 'REVIEW_BUDGET_EXHAUSTED', error: 'The configured review budget is exhausted.' }
    const served = await resolveServedModel(backend, baseUrl, probeTimeoutMs)
    if (!served.model) {
      // `code` so a caller can tell a config gap from a reviewer that ran and
      // failed (a 4xx vs the 502 bucket) without matching on the message text.
      return { ok: false, code: 'NO_MODEL', error: `No model configured for ${backend} reviewer and ${served.reason} — set one on the ${CODE_REVIEWERS_PAGE_BREADCRUMB} page.` }
    }
    model = served.model
    console.log(`🔍 No ${backend} reviewer model configured — using the only model it serves: ${model}`)
  }

  // Probe only when there is actually a level to drop — an unpinned effort
  // sends no field either way, so a capability round-trip would buy nothing.
  const requestedEffort = normalizeReviewerEffort(effort, backend) || null
  let effortUnsupported = requestedEffort ? await modelRejectsThinking(backend, model, reviewBudget) : false
  let resolvedEffort = effortUnsupported ? null : requestedEffort

  let remainingMs = takeCodeReviewCallBudget(reviewBudget, timeoutMs)
  if (remainingMs === null) return { ok: false, backend, model, code: 'REVIEW_BUDGET_EXHAUSTED', error: 'The configured review budget is exhausted.' }
  let attempt = await sendChatCompletion(baseUrl, { model, messages, timeoutMs: remainingMs }, resolvedEffort)

  if (!attempt.ok && attempt.status === 400 && resolvedEffort && /does not support thinking/i.test(attempt.text || '')) {
    console.log(`⏭️ ${backend} model ${model} ignores reasoning_effort — retried without it`)
    thinkingUnsupportedModels.set(thinkingCacheKey(backend, model), true)
    resolvedEffort = null
    effortUnsupported = true
    remainingMs = takeCodeReviewCallBudget(reviewBudget, timeoutMs)
    if (remainingMs === null) return { ok: false, backend, model, code: 'REVIEW_BUDGET_EXHAUSTED', error: 'The configured review budget is exhausted.' }
    attempt = await sendChatCompletion(baseUrl, { model, messages, timeoutMs: remainingMs }, null)
  }

  if (!attempt.ok) {
    if (attempt.error) {
      return {
        ok: false,
        backend,
        model,
        error: Number.isFinite(diffSizeBytes) && isTimeoutFailure(attempt.error)
          ? localCodeReviewTimeoutError({ backend, timeoutMs: reviewBudget?.budgetMs ?? timeoutMs, diffSizeBytes, phase: 'no-response' })
          : `${backend} ${attempt.error}`,
      }
    }
    return { ok: false, backend, model, error: `${backend} API error ${attempt.status}: ${(attempt.text || '').slice(0, 300)}` }
  }

  let data
  try {
    data = await readResponseJson(attempt.response, { fallback: (raw) => ({ _nonJson: raw }) })
  } catch (err) {
    return {
      ok: false,
      backend,
      model,
      error: Number.isFinite(diffSizeBytes) && isTimeoutFailure(err)
        ? localCodeReviewTimeoutError({ backend, timeoutMs: reviewBudget?.budgetMs ?? timeoutMs, diffSizeBytes, phase: 'response-body' })
        : `${backend} response failed: ${err.message}`,
    }
  }
  if (data?._nonJson !== undefined) {
    return { ok: false, backend, model, error: `${backend} returned a non-JSON response: ${data._nonJson.slice(0, 300)}` }
  }
  const content = data?.choices?.[0]?.message?.content
  if (!content || typeof content !== 'string') {
    return { ok: false, backend, model, error: `${backend} returned no content.` }
  }
  return {
    ok: true,
    backend,
    model,
    effort: resolvedEffort,
    ...(effortUnsupported ? { effortUnsupported: true } : {}),
    content: content.trim(),
    finishReason: normalizeReviewFinishReason(data?.choices?.[0]?.finish_reason),
    responseLengthChars: content.length,
  }
}
