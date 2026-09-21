import { CONTRIBUTION_SECURITY_ASSESSMENT, contributionSecurityAssessmentSchema } from '../lib/contributionSecurityPolicy.js';
import { readSettingsStrict } from './settings.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { readBodyCapped } from '../lib/safeUrlFetch.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { evaluateSecretEndpoint } from '../lib/aiToolkit/endpointGuard.js';
import { getAllProviders } from './providers.js';
import { modelAbuseContentFingerprint } from '../lib/modelAbuseGuard.js';
import { formatUntrustedContent, isUntrustedContentProvider, resolveUntrustedContentPolicy, UNTRUSTED_CONTENT_INSTRUCTIONS } from '../lib/untrustedContent.js';
// Deep imports on purpose (#7473): both leaves are cheap (`ollamaContext.js`
// is zero-dependency, `providerStatus.js` reaches only the `num_ctx` clamp it
// already shares), unlike `services/stageRunner.js#effectiveContextWindow`,
// which would drag this request-path module across the ~44-module prompt
// budgeter closure that `server/lib/importScoping.test.js` has little
// headroom for.
import { withOllamaRuntimeContextWindow } from '../lib/ollamaContext.js';
import { knownContextWindow } from '../lib/aiToolkit/providerStatus.js';

const failure = (code, message) => ({ ok: false, safe: false, code, message });

/** One validation path for both the chat model's JSON and a jev-built value. */
function validateAgainstContract(responseSchema, value) {
  if (responseSchema.safeParse) {
    const validated = responseSchema.safeParse(value);
    return validated.success ? { ok: true, value: validated.data } : { ok: false };
  }
  return responseSchema(value) === true ? { ok: true, value } : { ok: false };
}

/**
 * Score every decision in a jev plan and report one collective outcome.
 *
 * Collective on purpose: `evaluateMessages` asks for an action AND a priority
 * over the same premise, and the chat model's priority was conditioned on its
 * own action. Mixing a jev action with an LLM priority would produce a pair
 * neither model proposed, so one abstention retires the whole item.
 */
async function runJevPlan(plan, config) {
  const { runJevDecision } = await import('./jevRouter.js');
  const results = [];
  for (const decision of plan.decisions) {
    const result = await runJevDecision({
      decisionId: decision.id,
      premise: decision.premise,
      policyMinMargin: config.jevMinMargin,
    });
    results.push({ id: decision.id, result });
    // Stop at the first non-answer: the remaining forward passes cannot rescue
    // the item, and each one is a 4B model inference.
    if (result.ok !== true || result.abstained) break;
  }
  const answered = results.length === plan.decisions.length && results.every(entry => entry.result.value !== undefined);
  return {
    results,
    answered,
    choices: answered ? Object.fromEntries(results.map(entry => [entry.id, entry.result.value])) : null,
  };
}

/** Counter rows for a jev plan run, optionally compared against the LLM's answer. */
function jevObservations(plan, outcome, llmValue) {
  // A plan whose enum values ARE the caller's contract needs no projection.
  const comparable = llmValue === undefined ? null : (plan.fromValue ? plan.fromValue(llmValue) : llmValue);
  return outcome.results.map(entry => ({
    decisionId: entry.id,
    kind: entry.result.kind,
    ...(comparable && entry.result.value !== undefined
      ? { agreed: entry.result.value === comparable[entry.id] }
      : {}),
  }));
}

/** Complete input crosses the classifier before any conversational model sees it. */
export async function screenUntrustedContent({ content, source, policy: override = {}, provider, model } = {}) {
  const state = await readSettingsStrict();
  if (state.corrupt) return failure('untrusted-content-settings-unreadable', 'The untrusted-content settings could not be read. Repair Settings before retrying.');
  const policy = resolveUntrustedContentPolicy(state.settings.untrustedContent, source, override);
  if (!policy) return failure('untrusted-content-policy-invalid', 'The source or untrusted-content policy is invalid. Check Models > LLMs > Abuse Guard.');
  if (typeof content !== 'string' || !content.trim()) return failure('untrusted-content-empty', 'There is no external content to analyze.');
  if (content.length > policy.maxInputChars) return failure('untrusted-content-too-large', 'The complete content exceeds the configured limit; no partial analysis was accepted.');
  const { runModelAbuseScan } = await import('./modelAbuseGuard.js');
  const screening = await runModelAbuseScan({ content, source, classifierMode: policy.classifierMode, minBenignScore: policy.minBenignScore });
  // A completed scan that flags content (deterministic findings, or a
  // classifier verdict of malicious/low-confidence) means the guard is
  // working correctly — that is a distinct outcome from the guard failing to
  // run at all, and telling the operator to "check the abuse guard" for a
  // legitimate block sends them to a status panel that will just say ready.
  if (!screening.ok) return { ...failure(screening.code || 'untrusted-content-screening-failed', 'Model-abuse screening could not run. Check Models > LLMs > Abuse Guard.'), screening };
  if (screening.safe !== true) return { ...failure(screening.code || 'untrusted-content-blocked', 'The model-abuse guard flagged this content and blocked it. This is expected screening behavior, not a guard setup problem.'), screening };
  const screened = { ok: true, safe: true, policy, screening, fingerprint: modelAbuseContentFingerprint(source, {}, content) };
  if (source !== 'github-issue' && source !== 'github-pr') return screened;
  // An injection classifier cannot establish whether a benign feature request
  // violates the host's trust model. This separate mandatory verdict uses the
  // same bounded, tool-free transport, never a scorer or CLI fallback.
  const assessment = policy.jevMode === 'only'
    ? failure('security-model-assessment-required', 'A security-model assessment is required; this source forbids text-provider calls.')
    : await analyzeScreenedContent({ provider, model, content, source, screened,
      prompt: CONTRIBUTION_SECURITY_ASSESSMENT, responseSchema: contributionSecurityAssessmentSchema });
  if (!assessment.ok) {
    // Some callers consume .screening directly. Never leave the earlier benign
    // abuse verdict attached to a failed security-model assessment.
    return { ...assessment, screening: { ok: false, safe: false, code: assessment.code } };
  }
  if (assessment.value.verdict === 'uncertain') {
    const held = failure('security-model-uncertain', 'Security-model compatibility could not be established; automation was withheld.');
    return { ...held, screening: { ...held, layers: { ...screening.layers, securityModel: 'uncertain' } } };
  }
  const compatible = assessment.value.verdict === 'compatible';
  const verdict = { ...screening, safe: compatible,
    code: compatible ? screening.code : 'security-model-withheld',
    layers: { ...screening.layers, securityModel: assessment.value.verdict },
    findings: compatible ? screening.findings : [{ severity: 'blocking', category: 'security-model', location: 'external-content',
      reason: 'The contribution violates the host-control security model or its compatibility could not be established. Automation was withheld.' }],
  };
  // Model-authored assessment prose never becomes instructions or a work order.
  return { ...screened, ok: compatible, safe: compatible, screening: verdict,
    ...(compatible ? {} : { code: verdict.code, message: verdict.findings[0].reason }) };
}

// A premise may be given as a thunk. The default install never opts in, so the
// callers would otherwise re-serialize every message body in the batch on every
// run just to build a request the gate discards on its first check.
const premiseOf = (item) => (typeof item.premise === 'function' ? item.premise() : item.premise);

const itemPlan = (item) => ({
  decisions: item.decisionIds.map((id) => ({ id, premise: premiseOf(item) })),
});

const batchRows = (items) => (Array.isArray(items)
  ? items.filter((item) => item?.key !== undefined && item.premise && item.decisionIds?.length)
  : []);

/** The resolved policy for a batch, plus whether jev may answer for it. */
async function jevBatchContext(source) {
  const { isJevFeatureEnabled, resolveJevMode } = await import('./jevRouter.js');
  // The feature toggle first, deliberately: it ships OFF, so the common answer
  // costs one cached lookup instead of a settings read and a policy resolution
  // this function would then throw away.
  if (!await isJevFeatureEnabled()) return { mode: 'disabled', config: null };
  const state = await readSettingsStrict();
  const config = state.corrupt ? null : resolveUntrustedContentPolicy(state.settings.untrustedContent, source);
  if (!config) return { mode: 'disabled', config: null };
  return { mode: await resolveJevMode(config), config };
}

/**
 * Fold a finished batch into the agreement counters.
 *
 * Always AFTER the completion returns, so in `shadow` mode it changes nothing
 * about the answer and in `prefer` mode it scores the items that fell through.
 * `actualByKey` maps an item key to `{ [decisionId]: value }` — the chat model's
 * own answer. An item the chat model never answered is counted but not compared.
 */
async function measureBatch({ rows, config, outcomes, actualByKey }) {
  const { recordJevObservations } = await import('./jevRouter.js');
  const observations = [];
  for (const item of rows) {
    const plan = itemPlan(item);
    // In shadow mode the gate scored nothing, so this is where the scorer
    // actually runs. Otherwise the gate's own outcomes are reused, and no
    // second forward pass is paid for.
    const outcome = outcomes.get(item.key) || await runJevPlan(plan, config);
    observations.push(...jevObservations(plan, outcome, actualByKey?.[item.key]));
  }
  return recordJevObservations(observations);
}

const undecided = (rows, measure = async () => null) => ({
  decided: new Map(), pending: rows, skipped: [], measure,
});

/**
 * Resolve as many items of a BATCH as the local scorer can, before any provider
 * is selected.
 *
 * `evaluateMessages` and the issue watcher send N records in one completion;
 * jev scores one premise at a time. That difference is the feature: an item the
 * scorer settles never enters the batch, and a batch that empties completely
 * makes zero provider calls. It also removes the failure mode where one
 * malformed row invalidates every other row's verdict.
 *
 * Screening comes first here exactly as it does in the analysis path — the
 * scorer never sees content phase 1 has not cleared. That costs the batch one
 * extra guard scan when jev is enabled, which is the honest price of not
 * carrying a "the caller promises it screened" flag across a trust boundary.
 *
 * Returns the whole partition, so **no caller ever sees `jevMode`**:
 *
 * - `decided` — key → `{ [decisionId]: value }` for the items jev settled.
 *
 * `accept(choices)` lets a caller refuse a verdict it cannot act on alone — the
 * issue watcher takes a local `none` but sends a local `reply` to the chat model,
 * because writing the reply body is generative work an entailment head cannot
 * do. A refused item is treated as unsettled, so it follows the same
 * pending-or-skipped rule as an abstention instead of needing the caller to
 * re-derive it (and to learn what `only` means).
 * - `pending` — the items the chat model still has to answer.
 * - `skipped` — under `only`, the items the scorer could not separate. They are
 *   neither decided nor pending: that operator chose a hard zero-quota posture,
 *   and "cannot tell" must never become a verdict. Keeping the rule HERE is why
 *   the string `'only'` appears in no service that calls this.
 * - `measure(actualByKey)` — fold the batch into the agreement counters once the
 *   chat model has answered. Closes over the outcomes the gate already computed,
 *   so measurement costs no second policy resolution.
 */
export async function jevBatchGate({ content, source, items, accept } = {}) {
  const rows = batchRows(items);
  if (!rows.length) return undecided(rows);
  const { mode, config } = await jevBatchContext(source);
  if (mode === 'disabled') return undecided(rows);
  const outcomes = new Map();
  const measure = (actualByKey) => measureBatch({ rows, config, outcomes, actualByKey });
  // `shadow` scores nothing up front: the chat model answers exactly as it did
  // before jev existed, and `measure` runs the scorer afterwards to compare.
  if (mode === 'shadow') return undecided(rows, measure);
  // A screening failure needs no special handling: the analysis call the caller
  // makes next screens the same content and reports the same code, so bailing
  // out to the chat path keeps error reporting in exactly one place.
  const screened = await screenUntrustedContent({ content, source });
  if (!screened.ok) return undecided(rows, measure);
  const decided = new Map();
  for (const item of rows) {
    const outcome = await runJevPlan(itemPlan(item), config);
    outcomes.set(item.key, outcome);
    if (outcome.answered && (!accept || accept(outcome.choices))) decided.set(item.key, outcome.choices);
  }
  const unsettled = rows.filter((item) => !decided.has(item.key));
  return {
    decided,
    pending: mode === 'only' ? [] : unsettled,
    skipped: mode === 'only' ? unsettled : [],
    measure,
  };
}

/**
 * Screen, reason without tools, then validate. The result is a proposal only:
 * each caller owns authorization, freshness and deterministic side effects.
 */
export async function runUntrustedContentAnalysis({ provider, model, content, prompt, source, responseSchema, policy, jev } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || (!responseSchema?.safeParse && typeof responseSchema !== 'function')) return failure('untrusted-content-contract-required', 'A trusted task and response contract are required.');
  const screened = await screenUntrustedContent({ content, source, policy, provider, model });
  if (!screened.ok) return screened;
  const config = screened.policy;
  // All required admission checks passed, so this is the one
  // point where the local scorer may answer instead. A caller that supplies no
  // plan — or an install with the feature off — takes exactly the path it took
  // before jev existed, down to the provider selection below.
  const plan = Array.isArray(jev?.decisions) && jev.decisions.length ? jev : null;
  const jevRouter = plan ? await import('./jevRouter.js') : null;
  // `screened.policy` is already resolved, so this costs no second settings read.
  const jevMode = jevRouter ? await jevRouter.resolveJevMode(config) : 'disabled';
  let jevOutcome = null;
  if (jevMode === 'prefer' || jevMode === 'only') {
    jevOutcome = await runJevPlan(plan, config);
    if (jevOutcome.answered) {
      const candidate = validateAgainstContract(responseSchema, plan.toValue(jevOutcome.choices));
      // A jev answer that does not satisfy the caller's own contract is a bug in
      // the plan, not a verdict — fall through to the chat model rather than
      // returning a shape the caller's validator just rejected.
      if (candidate.ok) {
        await jevRouter.recordJevObservations(jevObservations(plan, jevOutcome));
        return { ok: true, value: candidate.value, via: 'jev', fingerprint: screened.fingerprint, screening: screened.screening };
      }
    }
    if (jevMode === 'only') {
      await jevRouter.recordJevObservations(jevObservations(plan, jevOutcome));
      // Never coerced into the permissive enum member. `only` means the operator
      // chose a hard zero-quota posture, and "the scorer could not tell" has to
      // surface as a skip with a reason, not as a silent approval.
      return failure('untrusted-content-jev-abstained', 'The local scorer could not separate the options and this source is configured to skip rather than call a provider.');
    }
  }
  const analysis = await analyzeScreenedContent({ provider, model, content, prompt, source, responseSchema, screened });
  if (!analysis.ok) return analysis;
  const value = analysis.value;
  // Measurement, never behavior. In `shadow` mode this is the only time jev
  // runs at all; in `prefer` mode it is the plan that already abstained, now
  // scored against the answer the chat model gave — either way the value
  // returned below is the chat model's, byte for byte.
  if (plan && (jevMode === 'shadow' || jevOutcome)) {
    const measured = jevOutcome || await runJevPlan(plan, config);
    await jevRouter.recordJevObservations(jevObservations(plan, measured, value));
  }
  return analysis;
}

// Private transport entry: only callers above can supply a completed screen.
async function analyzeScreenedContent({ provider, model, content, prompt, source, responseSchema, screened }) {
  const config = screened.policy;
  const providers = provider ? [provider] : (await getAllProviders()).providers || [];
  const selected = provider || (config.providerId
    ? providers.find(item => item.id === config.providerId)
    : providers.find(item => isUntrustedContentProvider(item, source)));
  if (!isUntrustedContentProvider(selected, source)) return failure('untrusted-content-provider-unavailable', 'Configure an enabled text API provider in Models > LLMs > Abuse Guard. Private messages require a local API endpoint. CLI agents and provider fallback are disabled for external content.');
  const effectiveModel = model || (provider && provider.id !== config.providerId ? null : config.model) || selected.defaultModel;
  if (!effectiveModel) return failure('untrusted-content-model-required', 'Select an installed text model in Models > LLMs > Abuse Guard.');
  const taskPrompt = `${UNTRUSTED_CONTENT_INSTRUCTIONS}\n\nTRUSTED TASK:\n${prompt}`;
  const evidence = formatUntrustedContent(content);
  const local = isUntrustedContentProvider(selected, 'messages');
  // The runtime projection folds in the ambient `OLLAMA_CONTEXT_LENGTH`
  // ceiling before the shared ladder resolves anything, so an Ollama daemon
  // configured through the env var alone (numCtx unset) still budgets at
  // what it actually serves rather than an unenforced catalog window (#7472).
  // `knownContextWindow` then resolves through the one shared `num_ctx`
  // clamp (`aiToolkit/internal/ollamaBacked.js#clampToRuntimeContextWindow`)
  // instead of this guard's own Math.min pair, so it picks up the provider's
  // own `/models` catalog window and only clamps on `numCtx` for an
  // Ollama-backed provider — every other OpenAI-compatible local endpoint
  // (LM Studio, vLLM, …) ignores `num_ctx` entirely and must not be shrunk
  // by it.
  const runtimeProvider = withOllamaRuntimeContextWindow(selected);
  const claimedWindow = knownContextWindow(runtimeProvider, effectiveModel) ?? 4096;
  // A local endpoint with no explicit `numCtx` keeps this guard's own harder
  // floor rather than trusting a declared/catalog window an unconfigured
  // local endpoint has no confirmed way to honor — this is a security guard
  // that must stay conservative, not a budgeting nicety. Preserved verbatim
  // from the pre-#7473 behavior; it only ever LOWERS the shared ladder's
  // answer, so it never re-opens the catalog-window blind spot #7472 closed.
  const contextWindow = local && !(Number(runtimeProvider.numCtx) > 0) ? Math.min(claimedWindow, 4096) : claimedWindow;
  const maxTokens = Math.min(8192, config.maxOutputChars, Math.floor(contextWindow / 4));
  // UTF-8 bytes are a conservative upper bound for byte-fallback text tokens.
  // Never clip evidence to make an undersized context appear successful.
  if (Buffer.byteLength(taskPrompt + evidence, 'utf8') + maxTokens + 128 > contextWindow) return failure('untrusted-content-context-too-small', 'The complete evidence does not fit this provider context. Increase its context size or analyze a smaller complete batch.');
  const endpointPolicy = selected.apiKey ? evaluateSecretEndpoint(selected.endpoint, { allowCustomEndpoint: selected.allowCustomEndpoint === true }) : { allowed: true };
  if (!endpointPolicy.allowed) return failure('untrusted-content-endpoint-blocked', 'The configured API endpoint cannot receive this provider credential.');
  const { ensureProviderReadyForExecution } = await import('./providerExecutionReadiness.js');
  const ready = await ensureProviderReadyForExecution(selected).catch(() => null);
  if (!ready?.success) return failure('untrusted-content-provider-unavailable', 'The selected text API provider is unavailable. Check Models > LLMs > Abuse Guard.');
  // This transport deliberately has no runner failure hooks, run archives,
  // model healing, agent escalation, fallback, redirect, or tool execution.
  // Otherwise attacker-controlled diagnostics could become an autofixer task.
  const result = await withAbortTimeout(Math.min(Math.max(Number(selected.timeout) || 300_000, 1000), 300_000), async signal => {
    const response = await fetch(`${selected.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', ...(selected.apiKey ? { Authorization: `Bearer ${selected.apiKey}` } : {}) },
      body: JSON.stringify({
        model: effectiveModel,
        messages: [{ role: 'system', content: taskPrompt }, { role: 'user', content: evidence }],
        stream: false, max_tokens: maxTokens,
        ...(Number(selected.numCtx) > 0 ? { num_ctx: Number(selected.numCtx) } : {}),
      }),
    });
    if (!response.ok || response.redirected) return null;
    const buffer = await readBodyCapped(response, config.maxOutputChars * 8 + 4096);
    const parsed = buffer ? safeJSONParse(buffer.toString('utf8')) : null;
    if (!Array.isArray(parsed?.choices) || parsed.choices.length !== 1) return null;
    const choice = parsed.choices[0];
    if (choice.finish_reason !== 'stop' || choice.message?.tool_calls?.length || choice.message?.function_call) return null;
    return { text: choice.message?.content };
  }).catch(() => null);
  if (!result) return failure('untrusted-content-reasoner-failed', 'The selected text provider failed or returned an incomplete response; no fallback or action was attempted.');
  if (typeof result.text !== 'string' || result.text.length > config.maxOutputChars) return failure('untrusted-content-output-too-large', 'The model response exceeded the configured limit.');
  const parsedValue = safeJSONParse(result.text, null, { logError: false });
  if (parsedValue === null) return failure('untrusted-content-response-invalid', 'The model did not return the required JSON contract.');
  const validated = validateAgainstContract(responseSchema, parsedValue);
  if (!validated.ok) return failure('untrusted-content-response-invalid', 'The model did not return the required JSON contract.');
  const value = validated.value;
  return { ok: true, value, model: effectiveModel, providerId: selected.id, fingerprint: screened.fingerprint, screening: screened.screening };
}
