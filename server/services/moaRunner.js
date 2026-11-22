/**
 * Mixture of Agents execution: run a preset's reference models in parallel as
 * tool-free bounded completions, then its aggregator on the cache-safe
 * assembled prompt.
 *
 * Reached only from `promptRunner.runPromptThroughProvider` when the provider
 * is a `type: 'moa'` virtual record (`lib/moaConfig.js`). Each member call goes
 * back through that same entry point (`runPrompt`), so every advisor and the
 * aggregator is an ordinary tracked run: its own run record holding the exact
 * prompt sent, its own usage session and measured usage, and a working Stop.
 *
 * - Advisors are always bounded API completions (`completion`), the one run
 *   shape with no tools and a caller AbortSignal. They all share one
 *   controller, so the caller's abort, or a Stop on ANY advisor's run, cancels
 *   every in-flight advisor and skips the aggregator: stopping one member is
 *   stopping the MoA run.
 * - An advisor that fails or times out is recorded and dropped; only an
 *   aggregator failure fails the run. With no advisor answer the aggregator
 *   gets the caller's prompt unchanged.
 * - The aggregator runs in the caller's shape: a bounded completion (same
 *   signal) for a `completion` caller, else the streamed path with every caller
 *   option, pinned (`allowFallback: false`) because the preset names the
 *   acting, billed model.
 * - A disabled preset skips the advisors and runs the aggregator directly.
 *
 * After the runs settle, each record is tagged in its metadata (`moa`): advisors
 * with `role: 'reference'` and `parentRunId` (the aggregator's run), the
 * aggregator with `role: 'aggregator'` and its references, so Run History and
 * the usage ledger attribute the cost of every call to the preset.
 */

import { ServerError } from '../lib/errorHandler.js';
import { anyAbortSignal } from '../lib/requestAbort.js';
import {
  assembleAggregatorPrompt,
  buildAdvisorPrompt,
  moaMemberRefusal,
  presetIdFromMoaProviderId,
  scrubAdvisorText,
} from '../lib/moaConfig.js';
import { getMoaPreset } from './moaPresets.js';
import { getProviderById } from './provider/providers.js';
import { patchRunMetadata } from './runner.js';

const canceledError = (message) => Object.assign(new Error(message), { code: 'RUN_CANCELED', canceled: true });
const isCanceled = (err) => err?.code === 'RUN_CANCELED' || err?.canceled === true;
const memberLabel = (provider, providerId, model) => `${provider?.name || providerId}${model ? ` / ${model}` : ''}`;

async function resolveMember(member) {
  const provider = await getProviderById(member.providerId).catch(() => null);
  const model = member.model || provider?.defaultModel || null;
  return { provider, model, refusal: moaMemberRefusal(member, provider), label: memberLabel(provider, member.providerId, model) };
}

async function runReferences({ preset, prompt, source, timeout, cwd, controller, stopped, runPrompt, onRunCreated, onRunSettled }) {
  const advisorPrompt = buildAdvisorPrompt(prompt);
  const settled = await Promise.allSettled(preset.referenceModels.map(async (member, index) => {
    const { provider, model, refusal, label } = await resolveMember(member);
    const base = { index, providerId: member.providerId, model, label };
    if (refusal) return { ...base, ok: false, runId: null, error: refusal };
    try {
      const reply = await runPrompt({
        provider, prompt: advisorPrompt, source, model, timeout, signal: stopped, cwd,
        completion: { maxTokens: preset.advisorMaxTokens, ...(member.temperature !== undefined ? { temperature: member.temperature } : {}) },
        onRunCreated, onRunSettled,
      });
      return { ...base, ok: true, runId: reply.runId, text: reply.text };
    } catch (err) {
      // Our own abort reaches the others as a cancel too; only the first, external
      // one (a Stop on this run's record) decides that the whole MoA run stops.
      if (isCanceled(err) && !stopped.aborted) controller.abort();
      return { ...base, ok: false, runId: err?.runId ?? null, error: err?.message || String(err), ...(isCanceled(err) ? { canceled: true } : {}) };
    }
  }));
  return settled.map((outcome, index) => (outcome.status === 'fulfilled'
    ? outcome.value
    : { index, providerId: preset.referenceModels[index].providerId, model: null, label: preset.referenceModels[index].providerId, ok: false, runId: null, error: outcome.reason?.message || String(outcome.reason) }));
}

async function tagRuns({ preset, references, aggregatorRunId }) {
  const link = { presetId: preset.id, presetName: preset.name };
  const writes = references.filter((ref) => ref.runId).map((ref) => patchRunMetadata(ref.runId, {
    moa: { ...link, role: 'reference', index: ref.index, parentRunId: aggregatorRunId },
  }));
  if (aggregatorRunId) {
    writes.push(patchRunMetadata(aggregatorRunId, {
      moa: {
        ...link,
        role: 'aggregator',
        privacyFilter: preset.privacyFilter,
        references: references.map(({ index, providerId, model, ok, runId, error }) => ({ index, providerId, model, ok, runId, ...(error ? { error } : {}) })),
      },
    }));
  }
  // Tracking, not the answer: a failed tag must not fail a completed run.
  await Promise.all(writes.map((write) => write.catch((err) => console.error(`❌ MoA run tag failed: ${err.message}`))));
}

/**
 * @param {object} args the `runPromptThroughProvider` arguments, `provider` being the `moa` record
 * @param {{ runPrompt: (args: object) => Promise<object> }} deps `runPromptThroughProvider` itself
 * @returns {Promise<object>} the aggregator's result plus `moa: { presetId, aggregatorRunId, references }`;
 *   `references[].text` is scrubbed unless the preset's `privacyFilter` is `off`
 */
export async function runMoaPreset(args, { runPrompt }) {
  const {
    provider, prompt, source, timeout, signal = null, cwd, completion, onRunCreated, onRunSettled,
    model: _callerModel, allowFallback: _allowFallback, ...streamArgs
  } = args;
  if (streamArgs.screenshots?.length) {
    throw new ServerError('MoA presets do not accept image inputs: their advisors run as text-only completions', { status: 422, code: 'MOA_IMAGES_UNSUPPORTED' });
  }
  const presetId = provider.moaPresetId ?? presetIdFromMoaProviderId(provider.id);
  // The LIVE preset, never the record a resolver built earlier: an edit between
  // selection and execution must run as edited.
  const preset = await getMoaPreset(presetId);
  if (!preset) throw new ServerError(`MoA preset "${presetId}" not found`, { status: 404, code: 'MOA_PRESET_NOT_FOUND' });

  const aggregator = await resolveMember(preset.aggregator);
  if (aggregator.refusal) {
    throw new ServerError(`MoA preset "${preset.name}": aggregator ${aggregator.refusal}`, { status: 422, code: 'MOA_MEMBER_INVALID' });
  }

  const controller = new AbortController();
  const stopped = anyAbortSignal([controller.signal, signal]);
  const startedAt = Date.now();
  const references = preset.enabled
    ? await runReferences({ preset, prompt, source, timeout, cwd, controller, stopped, runPrompt, onRunCreated, onRunSettled })
    : [];
  if (stopped.aborted) {
    await tagRuns({ preset, references, aggregatorRunId: null });
    console.log(`⏹️ MoA ${preset.id} canceled during the advisor phase`);
    throw canceledError('MoA run canceled');
  }

  const answered = references.filter((ref) => ref.ok).length;
  if (references.length) console.log(`🧩 MoA ${preset.id}: ${answered}/${references.length} advisors answered in ${Date.now() - startedAt}ms`);
  const aggregatorPrompt = assembleAggregatorPrompt(prompt, references, { privacyFilter: preset.privacyFilter });

  let result = null;
  let failure = null;
  try {
    result = completion
      ? await runPrompt({
        provider: aggregator.provider, prompt: aggregatorPrompt, source, model: aggregator.model, timeout, signal: stopped, cwd, completion, onRunCreated, onRunSettled,
      })
      : await runPrompt({
        ...streamArgs, provider: aggregator.provider, prompt: aggregatorPrompt, source, model: aggregator.model, timeout, cwd, onRunCreated, onRunSettled, allowFallback: false,
      });
  } catch (err) {
    failure = err;
  }
  const aggregatorRunId = result?.runId ?? failure?.runId ?? null;
  await tagRuns({ preset, references, aggregatorRunId });
  if (failure) throw failure;

  return {
    ...result,
    moa: {
      presetId: preset.id,
      aggregatorRunId,
      references: references.map((ref) => ({
        ...ref,
        ...(typeof ref.text === 'string' && preset.privacyFilter !== 'off' ? { text: scrubAdvisorText(ref.text) } : {}),
      })),
    },
  };
}
