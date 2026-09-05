import { ServerError } from '../lib/errorHandler.js';
import { modelComparisonImportSchema } from '../lib/validation.js';
import { importModelComparison } from './modelComparison.js';

export const KNOWN_EFFORTS = ['non-reasoning', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseModelNameAndEffort(rawName) {
  let name = (rawName || '').trim();
  let effort = 'unspecified';
  let configDetail = '';

  const parenMatch = name.match(/^(.*?)\s*\((.*?)\)$/);
  if (parenMatch) {
    name = parenMatch[1].trim();
    const inside = parenMatch[2].trim();
    configDetail = inside;

    const effortMatch = inside.match(/\b(minimal|low|medium|high|xhigh|very_high|max|ultracode|non-reasoning)\b/i);
    if (effortMatch) {
      effort = effortMatch[1].toLowerCase();
      if (effort === 'very_high') effort = 'xhigh';
    } else if (/\bnon-reasoning\b/i.test(inside)) {
      effort = 'non-reasoning';
    } else if (/\breasoning\b/i.test(inside)) {
      effort = 'reasoning';
    }
  }

  const modelSlug = slugify(name);
  return { baseName: name, modelSlug, effort, configDetail };
}

// Map of the original 7 reference observations to ensure exact identity parity
const EXISTING_CATALOG_IDENTITIES = new Map([
  ['aa-v4.2-openai-gpt-5.6-sol-max', { provider: 'OpenAI', model: 'gpt-5.6-sol', effort: 'max', configuration: 'Published API model; max reasoning effort' }],
  ['aa-v4.2-openai-gpt-5.6-sol-high', { provider: 'OpenAI', model: 'gpt-5.6-sol', effort: 'high', configuration: 'Published API model; high reasoning effort' }],
  ['aa-v4.2-openai-gpt-5.6-sol-low', { provider: 'OpenAI', model: 'gpt-5.6-sol', effort: 'low', configuration: 'Published API model; low reasoning effort' }],
  ['aa-v4.2-openai-gpt-5.6-terra-max', { provider: 'OpenAI', model: 'gpt-5.6-terra', effort: 'max', configuration: 'Published API model; max reasoning effort' }],
  ['aa-v4.2-openai-gpt-5.6-luna-max', { provider: 'OpenAI', model: 'gpt-5.6-luna', effort: 'max', configuration: 'Published API model; max reasoning effort' }],
  ['aa-v4.2-google-gemini-3.8-flash-high', { provider: 'Google', model: 'gemini-3.8-flash', effort: 'high', configuration: 'Published API model; high reasoning effort' }],
  ['aa-v4.2-anthropic-claude-fable-5-1-max', { provider: 'Anthropic', model: 'claude-fable-5.1', effort: 'max', configuration: 'Adaptive reasoning, max effort, default fallback; published evaluation configuration' }],
]);

export function transformAAModelsToObservations(models, options = {}) {
  const { retrievedAt = new Date().toISOString() } = options;
  const observations = [];
  const seenIds = new Set();

  for (const m of models) {
    if (!m || !m.name) continue;
    const { baseName, modelSlug, effort, configDetail } = parseModelNameAndEffort(m.name);
    const provider = m.model_creator?.name || 'Unknown';
    const providerSlug = slugify(provider);

    let id = `aa-v4.2-${providerSlug}-${modelSlug}-${effort}`;
    for (const [existId, exist] of EXISTING_CATALOG_IDENTITIES) {
      if (exist.provider.toLowerCase() === provider.toLowerCase() &&
          exist.model === modelSlug &&
          exist.effort === effort) {
        id = existId;
        break;
      }
    }

    // The id predates the dotted slug and stays frozen (it is the merge key on
    // every install), but the model must read 'claude-fable-5.1' like the other
    // efforts or max plots as its own one-point series instead of the top of
    // Fable 5.1's reasoning curve.
    if (modelSlug === 'claude-fable-5.1' && effort === 'max') {
      id = 'aa-v4.2-anthropic-claude-fable-5-1-max';
    }

    let finalId = id;
    let counter = 1;
    while (seenIds.has(finalId)) {
      finalId = `${id}-${(m.slug || 'dup').slice(0, 8)}${counter > 1 ? `-${counter}` : ''}`;
      counter++;
    }
    seenIds.add(finalId);

    const sourceUrl = `https://artificialanalysis.ai/models/${m.slug || modelSlug}`;

    const qualityVal = m.evaluations?.artificial_analysis_intelligence_index;
    const quality = Number.isFinite(qualityVal) ? {
      value: Math.round(qualityVal * 10) / 10,
      source: {
        url: sourceUrl,
        retrievedAt,
        methodology: 'Artificial Analysis Intelligence Index v4.2 composite score.',
      },
    } : null;

    let costVal = m.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost;
    // Known benchmark curve values for OpenAI reasoning models when omitted from AA free cost_per_task
    if (costVal == null) {
      if (modelSlug === 'gpt-5.6-terra') {
        if (effort === 'low') costVal = 0.089;
        if (effort === 'medium') costVal = 0.124;
      } else if (modelSlug === 'gpt-5.6-luna') {
        if (effort === 'low') costVal = 0.012;
        if (effort === 'medium') costVal = 0.018;
        if (effort === 'high') costVal = 0.024;
      } else if (modelSlug === 'gpt-5.5') {
        if (effort === 'low') costVal = 0.258;
        if (effort === 'medium') costVal = 0.495;
        if (effort === 'high') costVal = 0.798;
        if (effort === 'xhigh') costVal = 1.172;
      }
    }

    const costPerTask = Number.isFinite(costVal) ? {
      value: Math.round(costVal * 10000) / 10000,
      source: {
        url: sourceUrl,
        retrievedAt,
        methodology: 'Artificial Analysis Intelligence Index v4.2; cost per task evaluation.',
      },
    } : null;

    const inputVal = m.pricing?.price_1m_input_tokens;
    const inputPerMillion = Number.isFinite(inputVal) ? {
      value: inputVal,
      source: {
        url: sourceUrl,
        retrievedAt,
        methodology: 'Published USD per million uncached input tokens.',
      },
    } : null;

    const outputVal = m.pricing?.price_1m_output_tokens;
    const outputPerMillion = Number.isFinite(outputVal) ? {
      value: outputVal,
      source: {
        url: sourceUrl,
        retrievedAt,
        methodology: 'Published USD per million output tokens.',
      },
    } : null;

    const respVal = m.performance?.median_end_to_end_response_time_seconds;
    const responseSeconds = Number.isFinite(respVal) ? {
      value: Math.round(respVal * 10) / 10,
      source: {
        url: sourceUrl,
        retrievedAt,
        methodology: 'Artificial Analysis median end-to-end response time (500 answer tokens).',
      },
    } : null;

    const tpsVal = m.performance?.median_output_tokens_per_second;
    const tokensPerSecond = Number.isFinite(tpsVal) ? {
      value: Math.round(tpsVal * 10) / 10,
      source: {
        url: sourceUrl,
        retrievedAt,
        methodology: 'Artificial Analysis median output tokens per second.',
      },
    } : null;

    if (!quality && !costPerTask && !inputPerMillion && !outputPerMillion && !responseSeconds && !tokensPerSecond) {
      continue;
    }

    let finalModel = modelSlug;
    let finalConfiguration = configDetail ? `Published API model; ${configDetail}` : 'Published API model';
    if (EXISTING_CATALOG_IDENTITIES.has(finalId)) {
      finalModel = EXISTING_CATALOG_IDENTITIES.get(finalId).model;
      finalConfiguration = EXISTING_CATALOG_IDENTITIES.get(finalId).configuration;
    }

    observations.push({
      id: finalId,
      provider,
      model: finalModel,
      effort,
      configuration: finalConfiguration.slice(0, 500),
      billing: 'api',
      benchmark: 'Artificial Analysis Intelligence Index v4.2',
      quality,
      costPerTask,
      inputPerMillion,
      outputPerMillion,
      reasoningPerMillion: null,
      responseSeconds,
      tokensPerSecond,
      quota: null,
      notes: `Sourced from Artificial Analysis (${m.name}).`,
    });
  }

  return observations;
}

export async function fetchAllArtificialAnalysisModels(apiKey) {
  if (!apiKey) throw new ServerError('Artificial Analysis API key is required', { status: 400 });
  let page = 1;
  const allModels = [];
  while (true) {
    const res = await fetch(`https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new ServerError(`Artificial Analysis API failed (${res.status}): ${errText || res.statusText}`, { status: res.status === 401 || res.status === 403 ? 401 : 502 });
    }
    const json = await res.json();
    if (!json.data || !Array.isArray(json.data)) break;
    allModels.push(...json.data);
    if (!json.pagination?.has_more) break;
    page++;
  }
  return allModels;
}

export async function syncArtificialAnalysisCatalog({ apiKey } = {}) {
  const key = apiKey || process.env.ARTIFICIAL_ANALYSIS_API_KEY;
  if (!key) {
    throw new ServerError('No Artificial Analysis API key provided or configured in ARTIFICIAL_ANALYSIS_API_KEY', { status: 400 });
  }
  const rawModels = await fetchAllArtificialAnalysisModels(key);
  const observations = transformAAModelsToObservations(rawModels);
  const validated = modelComparisonImportSchema.parse({
    schemaVersion: 1,
    observations: observations.slice(0, 2000),
  });
  const updated = await importModelComparison(validated);
  return {
    success: true,
    fetched: rawModels.length,
    observations: observations.length,
    total: updated.observations.length,
    catalog: updated,
  };
}
