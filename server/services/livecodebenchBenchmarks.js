/** LiveCodeBench generation-split sync for the model comparison catalog; see docs/MODEL-COMPARISON.md. */
import { ServerError } from '../lib/errorHandler.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { modelComparisonImportSchema } from '../lib/validation.js';
import { importModelComparison } from './modelComparison.js';
import { parseModelNameAndEffort } from './artificialAnalysis.js';

const LCB_LEADERBOARD_URL = 'https://livecodebench.github.io/leaderboard.html';
const LCB_DATA_URL = 'https://livecodebench.github.io/performances_generation.json';
const LCB_REQUEST_TIMEOUT_MS = 30_000;

// model_style is LiveCodeBench's serving-family tag — it names the API family
// that evaluated the model. Families outside this table stay 'Unknown' with
// the style carried in notes; never a guessed org.
const LCB_PROVIDER_BY_STYLE = new Map([
  ['openaichat', 'OpenAI'],
  ['openaireason', 'OpenAI'],
  ['claude3', 'Anthropic'],
  ['claude3thinking', 'Anthropic'],
  ['deepseekapi', 'DeepSeek'],
  ['deepseekr1', 'DeepSeek'],
  ['geminithinking', 'Google'],
  ['grok', 'xAI'],
  ['codeqweninstruct', 'Qwen'],
  ['exaone', 'LG AI'],
]);

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

export async function fetchLiveCodeBenchPerformances() {
  let res;
  try {
    res = await fetchWithTimeout(LCB_DATA_URL, {}, LCB_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new ServerError('LiveCodeBench request timed out; retry sync', { status: 502 });
    }
    throw error;
  }
  if (!res.ok) {
    throw new ServerError(`LiveCodeBench request failed (${res.status}): ${res.statusText || 'request rejected'}`, { status: 502 });
  }
  const payload = await res.json();
  if (!payload || !Array.isArray(payload.performances) || !payload.performances.length || !Array.isArray(payload.models)) {
    throw new ServerError('LiveCodeBench returned invalid performance data; retry sync', { status: 502 });
  }
  return payload;
}

export function transformLiveCodeBenchToObservations(payload, { retrievedAt = new Date().toISOString() } = {}) {
  const dates = payload.performances.map(row => row?.date).filter(Number.isFinite);
  if (!dates.length) {
    throw new ServerError('LiveCodeBench returned no dated problems; retry sync', { status: 502 });
  }
  const start = isoDay(Math.min(...dates));
  const end = isoDay(Math.max(...dates));
  const windowLabel = `${start} to ${end}`;
  const benchmark = `LiveCodeBench (generation, pass@1, ${windowLabel})`;

  const providerByModel = new Map();
  for (const m of payload.models) {
    if (m && typeof m.model_repr === 'string' && !providerByModel.has(m.model_repr)) {
      providerByModel.set(m.model_repr, m);
    }
  }

  // Aggregate per normalized model+effort, not per raw repr — two reprs can
  // normalize to one series, and one observation per series is the contract.
  const groups = new Map();
  for (const row of payload.performances) {
    if (!row || typeof row.model !== 'string' || !row.model) continue;
    const passAt1 = Number.isFinite(row['pass@1']) ? row['pass@1'] : null;
    if (passAt1 === null) continue;
    const { modelSlug, effort, configDetail } = parseModelNameAndEffort(row.model);
    const key = `${modelSlug}::${effort}`;
    if (!groups.has(key)) {
      groups.set(key, { modelSlug, effort, configDetail, repr: row.model, scores: [] });
    }
    groups.get(key).scores.push(passAt1);
  }

  const observations = [];
  for (const { modelSlug, effort, configDetail, repr, scores } of groups.values()) {
    const style = providerByModel.get(repr)?.model_style;
    const provider = LCB_PROVIDER_BY_STYLE.get(String(style || '').toLowerCase()) || 'Unknown';
    const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    observations.push({
      // The window span is part of the benchmark name — LiveCodeBench's
      // date-windowed problems address contamination, so a sync that picks up
      // new problems starts a new series instead of mixing windows.
      id: `lcb-generation-${start}--${end}-${modelSlug}-${effort}`,
      provider,
      model: modelSlug,
      effort,
      configuration: configDetail || 'Full generation split, all difficulties',
      billing: 'api',
      benchmark,
      quality: {
        value: Math.round(mean * 10) / 10,
        source: {
          url: LCB_LEADERBOARD_URL,
          retrievedAt,
          methodology: `LiveCodeBench generation split, pass@1 mean over ${scores.length} problems, full window ${windowLabel}.`,
        },
      },
      costPerTask: null,
      inputPerMillion: null,
      outputPerMillion: null,
      reasoningPerMillion: null,
      responseSeconds: null,
      tokensPerSecond: null,
      quota: null,
      notes: `Sourced from LiveCodeBench (${repr}); serving style ${style || 'unknown'}. Costs, throughput and quota are not published by this source.`,
    });
  }
  return observations;
}

export async function syncLiveCodeBenchCatalog() {
  const payload = await fetchLiveCodeBenchPerformances();
  const observations = transformLiveCodeBenchToObservations(payload);
  const validated = modelComparisonImportSchema.parse({ schemaVersion: 1, observations });
  const updated = await importModelComparison(validated);
  return {
    success: true,
    fetched: payload.performances.length,
    observations: observations.length,
    total: updated.observations.length,
    catalog: updated,
  };
}
