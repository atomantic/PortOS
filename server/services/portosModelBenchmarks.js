/** User-triggered, deterministic PortOS task benchmark runs. */
import { randomUUID } from 'crypto';
import { estimateTokens } from '../lib/contextBudget.js';
import { estimateCostUsd, isFreeProvider, pricingAsOfForModel, resolveModelRates } from '../lib/modelPricing.js';
import { familyForProvider } from '../lib/providerFamilies.js';
import { commandBasename } from '../lib/providerModels.js';
import { isCodexTextTransportEnabled } from '../lib/codexTurn.js';
import { ServerError } from '../lib/errorHandler.js';
import { callProviderAISimple } from './aiProvider.js';
import { recordPortosModelBenchmark } from './modelComparison.js';

export const PORTOS_BENCHMARK_ID = 'portos-task-bench-v1';
export const PORTOS_BENCHMARK_NAME = 'PortOS Task Bench v1 (deterministic)';

const TASKS = Object.freeze([
  {
    id: 'arithmetic',
    prompt: 'A shipment has 8 crates with 24 units each. 17 units are removed. How many units remain? Return only the integer.',
    answer: /^175$/,
  },
  {
    id: 'formatting',
    prompt: 'Convert the exact text portos-usage to uppercase. Return only the converted text.',
    answer: /^PORTOS-USAGE$/,
  },
  {
    id: 'logic',
    prompt: 'Five switches numbered 1 through 5 start off. Toggle every switch whose number is 2 or a multiple of 3. List the switches that are on, in ascending order, separated by a comma. Return only the list.',
    answer: /^2\s*,\s*3$/,
  },
  {
    id: 'calculation',
    prompt: 'An invoice has 13 items at $7.25 each plus an $11.50 delivery fee. Return the total in dollars with exactly two decimal places and no currency symbol.',
    answer: /^105\.75$/,
  },
  {
    id: 'code-reading',
    prompt: "In JavaScript, what does [2,5,8,11].filter(n => n % 2 === 0).map(n => n / 2).join(',') return? Return only the exact string.",
    answer: /^1\s*,\s*4$/,
  },
]);

const finiteCount = (...values) => {
  const value = values.find(candidate => Number.isFinite(candidate) && candidate >= 0);
  return value === undefined ? null : Math.round(value);
};

export const isLocalProvider = provider => Boolean(provider && (
  provider.servicePlan === 'local'
  || provider.ollamaBacked || provider.lmstudioBacked || provider.mtplxBacked
  || provider.llamaBacked || provider.vllmBacked || provider.sglangBacked
  || /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)(:|\/|$)/i.test(provider.endpoint || '')
  || /^(?:ollama|lm[-_]?studio|mtplx|llama|vllm|sglang)(?:[-_.]|$)/i.test(provider.id || '')
  || /^(?:ollama|lm[-_]?studio|mtplx|llama|vllm|sglang)(?:[-_.]|$)/i.test(commandBasename(provider.command))
));

export function modelComparisonBilling(provider) {
  if (isLocalProvider(provider)) return 'local';
  if (isFreeProvider(provider)) return 'free';
  if (provider?.type === 'api') return 'api';
  if (familyForProvider(provider)) return 'subscription';
  return 'unknown';
}

const sourceFor = (runId, retrievedAt, methodology) => ({
  url: `portos://model-comparison/${runId}`,
  retrievedAt,
  methodology,
});

const metric = (value, source) => ({ value, source });

function usageFor(result, prompt) {
  const usage = result?.usage || {};
  const reportedInput = finiteCount(usage.inputTokens, usage.promptTokens, usage.prompt_tokens);
  const reportedOutput = finiteCount(usage.outputTokens, usage.completionTokens, usage.completion_tokens, result?.tokens);
  // A successful request necessarily had input and emitted non-empty output;
  // reported zero therefore means the provider omitted one side of usage.
  const measuredInput = reportedInput > 0 ? reportedInput : null;
  const measuredOutput = reportedOutput > 0 ? reportedOutput : null;
  const input = measuredInput ?? estimateTokens(prompt);
  const output = measuredOutput ?? estimateTokens(result?.text || '');
  const cachedInput = finiteCount(usage.cachedInputTokens, usage.cached_input_tokens) ?? 0;
  return {
    input,
    output,
    cachedInput: Math.min(input, cachedInput),
    basis: measuredInput !== null && measuredOutput !== null ? 'measured'
      : measuredInput === null && measuredOutput === null ? 'estimated' : 'mixed',
  };
}

function grade(task, text) {
  const answer = String(text || '').trim();
  return task.answer.test(answer);
}

/**
 * Run the fixed short-answer suite serially through the explicitly selected
 * provider/model. API task calls have no tools; Codex uses its isolated text
 * transport. Provider fallback and local model recovery are disabled.
 */
export async function runPortosModelBenchmark({ provider, model, effort = null, signal = null }) {
  const runId = randomUUID();
  const billing = modelComparisonBilling(provider);
  const family = familyForProvider(provider);
  let selectedEffort = effort || (isCodexTextTransportEnabled(provider) ? provider.effort : null) || 'default';
  const runProvider = {
    ...provider,
    fallbackProvider: null,
    ...(effort && isCodexTextTransportEnabled(provider) ? { effort } : {}),
  };
  const startedAt = Date.now();
  const results = [];
  const servedModels = new Set();
  let failureReason = null;

  for (const task of TASKS) {
    if (signal?.aborted) break;
    const prompt = `You are completing one item in ${PORTOS_BENCHMARK_NAME}. Answer with only the requested value. Do not use tools or add an explanation.\n\n${task.prompt}`;
    const result = await callProviderAISimple(runProvider, model, prompt, {
      temperature: 0,
      max_tokens: 32,
      signal,
      allowModelRecovery: false,
    });
    if (result?.error || typeof result?.text !== 'string') {
      if (signal?.aborted || result?.canceled) break;
      failureReason = Number.isInteger(result?.status) ? `Provider returned HTTP ${result.status}` : 'Provider request failed';
      break;
    }
    if (isCodexTextTransportEnabled(provider) && typeof result.effort === 'string' && result.effort) {
      selectedEffort = result.effort;
    }
    if (typeof result.model === 'string' && result.model.trim()) {
      servedModels.add(result.model.trim());
      if (servedModels.size > 1) failureReason = 'Provider changed the served model during the benchmark run';
    }
    const usage = usageFor(result, prompt);
    results.push({ task, correct: grade(task, result.text), ...usage });
    if (failureReason) break;
  }

  if (results.length === 0) {
    const reason = signal?.aborted ? 'Benchmark run cancelled before a task completed.'
      : failureReason ? `Benchmark could not complete its first task. ${failureReason}.`
        : 'The selected provider did not complete a benchmark task.';
    throw new ServerError(reason, { status: 502 });
  }

  const finishedAt = Date.now();
  const elapsedSeconds = Math.max((finishedAt - startedAt) / 1000, 0.001);
  const inputTokens = results.reduce((sum, result) => sum + result.input, 0);
  const outputTokens = results.reduce((sum, result) => sum + result.output, 0);
  const totalTokens = inputTokens + outputTokens;
  const completedTasks = results.length;
  const passedTasks = results.filter(result => result.correct).length;
  const complete = completedTasks === TASKS.length && !signal?.aborted && !failureReason;
  const benchmarkModel = servedModels.size > 1 ? 'Multiple models' : [...servedModels][0] || model;
  const rate = !isLocalProvider(provider) && servedModels.size <= 1
    ? resolveModelRates(family || provider.id, benchmarkModel)
    : null;
  const canPriceEquivalent = rate && ['exact', 'family'].includes(rate.matched);
  const tokenBases = new Set(results.map(result => result.basis));
  const tokenBasis = tokenBases.size === 1 ? [...tokenBases][0] : 'mixed';
  const retrievedAt = new Date(finishedAt).toISOString();
  const methodology = `${PORTOS_BENCHMARK_NAME}; ${completedTasks}/${TASKS.length} tasks completed; token basis ${tokenBasis}; provider-reported counts are used when available, otherwise PortOS estimates tokens as characters divided by four.`;
  const source = sourceFor(runId, retrievedAt, methodology);
  const configuration = [
    PORTOS_BENCHMARK_ID,
    `provider=${provider.id}`,
    `temperature=0`,
    `max_tokens=32`,
    `transport=${isCodexTextTransportEnabled(provider) ? 'codex-text' : 'api-text'}`,
    ...(benchmarkModel !== model ? [`requestedModel=${model}`] : []),
    ...(servedModels.size > 1 ? [`servedModelCount=${servedModels.size}`] : []),
  ].join('; ');
  const cost = canPriceEquivalent
    ? estimateCostUsd(Math.max(0, inputTokens - results.reduce((sum, result) => sum + result.cachedInput, 0)), outputTokens, rate, {
      cacheReadTokens: results.reduce((sum, result) => sum + result.cachedInput, 0),
    })
    : null;
  const observation = {
    id: `portos:${runId}`,
    provider: provider.name || provider.id,
    model: benchmarkModel,
    effort: selectedEffort,
    configuration,
    billing,
    benchmark: PORTOS_BENCHMARK_NAME,
    quality: complete ? metric((passedTasks / TASKS.length) * 100, source) : null,
    costPerTask: null,
    apiEquivalentCost: cost === null ? null : metric(cost, {
      ...source,
      methodology: `Reference only: estimated at published API token rates as of ${pricingAsOfForModel(benchmarkModel)}; this is not subscription allowance burn or a local inference bill. ${methodology}`,
    }),
    inputPerMillion: null,
    outputPerMillion: null,
    reasoningPerMillion: null,
    responseSeconds: metric(elapsedSeconds, source),
    tokensPerSecond: metric(outputTokens / elapsedSeconds, source),
    tokensPerRun: metric(totalTokens, source),
    inputTokens: metric(inputTokens, source),
    outputTokens: metric(outputTokens, source),
    tokenBasis,
    completedTasks,
    totalTasks: TASKS.length,
    quota: null,
    notes: complete
      ? `${passedTasks}/${TASKS.length} deterministic checks passed. No prompt or model response is stored. Subscription quota use is not attributable per task; any API-equivalent amount is a reference estimate only.`
      : `${completedTasks}/${TASKS.length} tasks completed before the run stopped. ${failureReason ? `${failureReason}.` : signal?.aborted ? 'Run cancelled by the user.' : 'Run stopped before all tasks completed.'} No performance score assigned. No prompt or model response is stored.`,
  };

  await recordPortosModelBenchmark(observation);
  return { observation, complete, failureReason };
}

export const PORTOS_BENCHMARK_TASK_COUNT = TASKS.length;
