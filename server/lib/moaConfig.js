/**
 * Mixture of Agents (MoA) pure core: the `moa:` virtual provider record, member eligibility, privacy scrub and cache-safe advisor/aggregator prompts.
 *
 * An MoA preset runs 1–5 reference models ("advisors") in parallel, tool-free,
 * then hands their answers to one aggregator model, the acting and billed run.
 * Pickers and resolvers address a preset as provider id `moa:<presetId>`; the
 * record `moaProviderRecord` builds carries `type: 'moa'`, which only
 * `promptRunner.runPromptThroughProvider` and `askService` dispatch (to
 * `services/moaRunner.js`). Every other run path refuses the unknown type, so
 * a preset can never reach a CLI/TUI spawn.
 *
 * Prompt transparency (AGENTS.md "Never modify a model's input out of the
 * user's sight"): both additions are fixed, labeled text appended AFTER the
 * caller's prompt, the editor shows them verbatim (`MOA_ADVISOR_INSTRUCTION`,
 * `MOA_AGGREGATOR_INSTRUCTION` ride the list route), and each run record
 * stores the exact text sent.
 *
 * Cache safety: the caller's prompt is the byte-identical PREFIX of both the
 * advisor and the aggregator prompt, and the advisory block is the TAIL, so a
 * provider's prompt cache keyed on the stable prefix still hits. Every MoA
 * request is ONE user message (`chatCompletionExchange` sends the prompt as a
 * single `user` turn), so no strict user/assistant-alternating template
 * (llama.cpp, vLLM) can ever see two adjacent user messages and no merge or
 * retry is needed.
 */

import { scrubSecretTokens } from './secretText.js';
import { redactPii } from './piiRedactionPatterns.js';

export const MOA_PROVIDER_TYPE = 'moa';
export const MOA_ID_PREFIX = 'moa:';

/**
 * `off` — advisor text is shown and injected as written.
 * `display` — what MoA returns for display (`result.moa.advisors[].text`) is scrubbed; the aggregator still receives the raw text.
 * `full` — also scrubbed before injection, so the aggregator never sees a scrubbed secret either.
 */
export const MOA_PRIVACY_FILTERS = Object.freeze(['off', 'display', 'full']);

export const MOA_ADVISOR_INSTRUCTION = [
  '[Mixture of Agents — advisor instruction]',
  'You are one of several independent advisors. Another model will write the final answer.',
  'Give your own concise perspective on the request above: the key facts, the approach you would take and any pitfalls.',
  'Do not call tools. Keep it brief.',
].join('\n');

export const MOA_AGGREGATOR_INSTRUCTION = [
  '[Mixture of Agents — aggregator instruction]',
  'The advisory block above holds independent perspectives from other models on the request that precedes it.',
  'They may be incomplete or wrong. Weigh them, then write your own final answer in exactly the form the request asks for.',
  'Do not mention the advisors.',
].join('\n');

export const isMoaProviderId = (id) => typeof id === 'string' && id.startsWith(MOA_ID_PREFIX);
export const moaProviderId = (presetId) => `${MOA_ID_PREFIX}${presetId}`;
export const presetIdFromMoaProviderId = (id) => (isMoaProviderId(id) ? id.slice(MOA_ID_PREFIX.length) : null);
export const isMoaProvider = (provider) => provider?.type === MOA_PROVIDER_TYPE;

/**
 * The virtual provider record a resolver returns for `moa:<id>`. `defaultModel`
 * names the aggregator's model so a caller that reads it reports the acting
 * model; MoA itself ignores a caller's model, because the preset pins every member.
 */
export function moaProviderRecord(preset) {
  return {
    id: moaProviderId(preset.id),
    name: `MoA: ${preset.name}`,
    type: MOA_PROVIDER_TYPE,
    enabled: true,
    defaultModel: preset.aggregator.model ?? null,
    models: preset.aggregator.model ? [preset.aggregator.model] : [],
    moaPresetId: preset.id,
  };
}

/**
 * Why `provider` cannot fill an MoA member slot, or null when it can. Checked
 * at save time and again at run time: the provider may be disabled, deleted or
 * retyped after the preset was saved. Only API providers qualify, which is what
 * makes every advisor tool-free and every member abortable by one signal.
 *
 * @param {{ providerId: string, model?: string }} member
 * @param {object|null} provider the live record for `member.providerId`
 * @returns {string|null}
 */
export function moaMemberRefusal(member, provider) {
  if (isMoaProviderId(member?.providerId) || isMoaProvider(provider)) return 'cannot be another MoA preset';
  if (!provider) return `provider "${member?.providerId}" was not found`;
  if (provider.enabled === false) return `provider "${provider.id}" is disabled`;
  if (provider.type !== 'api') return `provider "${provider.id}" is not an API provider`;
  if (!(member.model || provider.defaultModel)) return `provider "${provider.id}" has no default model; choose one`;
  return null;
}

/** Secrets first (their shapes can contain an `@` or digits the PII table would half-match), then delimited PII. */
export function scrubAdvisorText(text) {
  if (typeof text !== 'string' || !text) return text;
  return redactPii(scrubSecretTokens(text));
}

/** The advisor request: the caller's prompt, unchanged, as the prefix. */
export function buildAdvisorPrompt(prompt) {
  return `${prompt}\n\n---\n\n${MOA_ADVISOR_INSTRUCTION}`;
}

/**
 * The aggregator request. With no advisor answer the prompt goes through
 * exactly as the caller wrote it: MoA then costs nothing extra and the
 * aggregator answers as if it were selected directly.
 *
 * @param {string} prompt the caller's prompt, the stable prefix
 * @param {Array<{ label: string, ok: boolean, text?: string }>} advisors in preset order
 * @param {{ privacyFilter?: string }} [options]
 */
export function assembleAggregatorPrompt(prompt, advisors, { privacyFilter = 'off' } = {}) {
  const answered = advisors.filter((advisor) => advisor.ok && typeof advisor.text === 'string' && advisor.text.trim());
  if (answered.length === 0) return prompt;
  const sections = answered.map((advisor, index) => {
    const text = privacyFilter === 'full' ? scrubAdvisorText(advisor.text) : advisor.text;
    return `### Advisor ${index + 1} (${advisor.label})\n${text.trim()}`;
  });
  return [
    prompt,
    '---',
    `<moa-advisory responded="${answered.length}" of="${advisors.length}">`,
    sections.join('\n\n'),
    '</moa-advisory>',
    MOA_AGGREGATOR_INSTRUCTION,
  ].join('\n\n');
}
