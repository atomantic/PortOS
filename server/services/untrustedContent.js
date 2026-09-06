import { readSettingsStrict } from './settings.js';
import { withAbortTimeout } from '../lib/abortTimeout.js';
import { readBodyCapped } from '../lib/safeUrlFetch.js';
import { safeJSONParse } from '../lib/fileUtils.js';
import { evaluateSecretEndpoint } from '../lib/aiToolkit/endpointGuard.js';
import { getAllProviders } from './providers.js';
import { modelAbuseContentFingerprint } from '../lib/modelAbuseGuard.js';
import { formatUntrustedContent, isUntrustedContentProvider, resolveUntrustedContentPolicy, UNTRUSTED_CONTENT_INSTRUCTIONS } from '../lib/untrustedContent.js';

const failure = (code, message) => ({ ok: false, safe: false, code, message });

/** Complete input crosses the classifier before any conversational model sees it. */
export async function screenUntrustedContent({ content, source, policy: override = {} } = {}) {
  const state = await readSettingsStrict();
  if (state.corrupt) return failure('untrusted-content-settings-unreadable', 'The untrusted-content settings could not be read. Repair Settings before retrying.');
  const policy = resolveUntrustedContentPolicy(state.settings.untrustedContent, source, override);
  if (!policy) return failure('untrusted-content-policy-invalid', 'The source or untrusted-content policy is invalid. Check Models > LLMs > Abuse Guard.');
  if (typeof content !== 'string' || !content.trim()) return failure('untrusted-content-empty', 'There is no external content to analyze.');
  if (content.length > policy.maxInputChars) return failure('untrusted-content-too-large', 'The complete content exceeds the configured limit; no partial analysis was accepted.');
  const { runModelAbuseScan } = await import('./modelAbuseGuard.js');
  const screening = await runModelAbuseScan({ content, classifierMode: policy.classifierMode, minBenignScore: policy.minBenignScore });
  if (!screening.ok || screening.safe !== true) return { ...failure(screening.code || 'untrusted-content-screening-failed', 'External content was blocked or screening was unavailable. Check Models > LLMs > Abuse Guard.'), screening };
  return { ok: true, safe: true, policy, screening, fingerprint: modelAbuseContentFingerprint(source, {}, content) };
}

/**
 * Screen, reason without tools, then validate. The result is a proposal only:
 * each caller owns authorization, freshness and deterministic side effects.
 */
export async function runUntrustedContentAnalysis({ provider, model, content, prompt, source, responseSchema, policy } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || (!responseSchema?.safeParse && typeof responseSchema !== 'function')) return failure('untrusted-content-contract-required', 'A trusted task and response contract are required.');
  const screened = await screenUntrustedContent({ content, source, policy });
  if (!screened.ok) return screened;
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
  const contextWindow = Math.min(Number(selected.contextWindow) || Number(selected.numCtx) || 4096,
    Number(selected.numCtx) || (local ? 4096 : Number(selected.contextWindow) || 4096));
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
  let value = safeJSONParse(result.text, null, { logError: false });
  if (value === null) return failure('untrusted-content-response-invalid', 'The model did not return the required JSON contract.');
  if (responseSchema.safeParse) {
    const validated = responseSchema.safeParse(value);
    if (!validated.success) return failure('untrusted-content-response-invalid', 'The model did not return the required JSON contract.');
    value = validated.data;
  } else if (responseSchema(value) !== true) return failure('untrusted-content-response-invalid', 'The model did not return the required JSON contract.');
  return { ok: true, value, model: effectiveModel, providerId: selected.id, fingerprint: screened.fingerprint, screening: screened.screening };
}
