/** OpenRouter routed price and per-serving-endpoint performance sync. */
import { createHash } from 'crypto';
import { ServerError } from '../lib/errorHandler.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { modelComparisonImportSchema } from '../lib/validation.js';
import { catalogSlugForProviderModel } from '../lib/comparisonModelScope.js';
import { importModelComparison } from './modelComparison.js';
import { parseModelNameAndEffort, slugify } from './artificialAnalysis.js';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_ENDPOINTS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_REQUEST_TIMEOUT_MS = 15_000;
const OPENROUTER_ENDPOINT_CONCURRENCY = 8;
const ENDPOINT_WINDOW = '30m-p50';

const identityHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function validRoutedModelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 300
    && value.includes('/') && !/[\u0000-\u001f\u007f]/.test(value)
    && value.indexOf('/') === value.lastIndexOf('/');
}

function parseRate(value) {
  if (value === null || value === undefined) return null;
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim())) {
    throw new ServerError('OpenRouter returned malformed pricing data; retry sync', { status: 502 });
  }
  const rate = Number(value);
  // OpenRouter's router/meta-model entries use -1 for an unpublished price.
  // It is an absent metric, not a negative charge or a zero-price offer.
  if (rate === -1) return null;
  if (!Number.isFinite(rate) || rate < 0) {
    throw new ServerError('OpenRouter returned malformed pricing data; retry sync', { status: 502 });
  }
  const perMillion = rate * 1_000_000;
  if (!Number.isFinite(perMillion)) {
    throw new ServerError('OpenRouter returned malformed pricing data; retry sync', { status: 502 });
  }
  return perMillion;
}

function parseThreshold(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim())) {
    throw new ServerError('OpenRouter returned an invalid long-context pricing tier; retry sync', { status: 502 });
  }
  const threshold = Number(value);
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    throw new ServerError('OpenRouter returned an invalid long-context pricing tier; retry sync', { status: 502 });
  }
  return threshold;
}

function parseUtcTime(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !value.trim())) {
    throw new ServerError('OpenRouter returned an invalid UTC pricing window; retry sync', { status: 502 });
  }
  const time = Number(value);
  const hour = Math.floor(time / 100);
  const minute = time % 100;
  if (!Number.isSafeInteger(time) || time < 0 || time > 2359 || hour > 23 || minute > 59) {
    throw new ServerError('OpenRouter returned an invalid UTC pricing window; retry sync', { status: 502 });
  }
  return time;
}

function formatUtcTime(value) {
  const hour = String(Math.floor(value / 100)).padStart(2, '0');
  const minute = String(value % 100).padStart(2, '0');
  return hour + ':' + minute;
}

function overrideCondition(override) {
  const parts = [];
  const identity = {};
  if (hasOwn(override, 'min_prompt_tokens')) {
    identity.minPromptTokens = parseThreshold(override.min_prompt_tokens);
    parts.push('minimum ' + identity.minPromptTokens + ' prompt tokens');
  }

  const hasDays = hasOwn(override, 'utc_days');
  const hasStart = hasOwn(override, 'utc_start');
  const hasEnd = hasOwn(override, 'utc_end');
  if (hasDays || hasStart || hasEnd) {
    if (hasDays && (!Array.isArray(override.utc_days) || !override.utc_days.length
      || override.utc_days.some(day => typeof day !== 'string' || !/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(day)))) {
      throw new ServerError('OpenRouter returned invalid UTC pricing days; retry sync', { status: 502 });
    }
    if (hasStart !== hasEnd) {
      throw new ServerError('OpenRouter returned an incomplete UTC pricing window; retry sync', { status: 502 });
    }
    const days = hasDays ? [...new Set(override.utc_days.map(day => day.toLowerCase()))].sort() : [];
    identity.utcDays = days;
    if (hasStart) {
      identity.utcStart = parseUtcTime(override.utc_start);
      identity.utcEnd = parseUtcTime(override.utc_end);
    }
    const dayLabel = days.length ? days.join(', ') : 'every UTC day';
    parts.push(dayLabel + (hasStart ? ' ' + formatUtcTime(identity.utcStart) + '–' + formatUtcTime(identity.utcEnd) : ''));
  }

  return parts.length ? { key: JSON.stringify(identity), label: parts.join('; ') } : null;
}

function sourceMetric(value, url, retrievedAt, methodology) {
  return value === null ? null : { value, source: { url, retrievedAt, methodology } };
}

function routedModel(model) {
  const modelId = model.id;
  const comparableId = modelId.replace(/:(?:free|batch)$/i, '');
  const modelSlug = catalogSlugForProviderModel(comparableId)
    || slugify((model.name || comparableId.slice(comparableId.lastIndexOf('/') + 1)).replace(/\s*\((?:free|batch)\)$/i, ''));
  const parsedName = parseModelNameAndEffort(model.name || comparableId);
  return {
    id: modelId,
    model: modelSlug || slugify(comparableId),
    effort: parsedName.effort || 'unspecified',
  };
}

function validateModels(payload) {
  if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) {
    throw new ServerError('OpenRouter returned no model data; retry sync', { status: 502 });
  }
  const ids = new Set();
  for (const model of payload.data) {
    if (!model || !validRoutedModelId(model.id) || ids.has(model.id)) {
      throw new ServerError('OpenRouter returned malformed or duplicate model data; retry sync', { status: 502 });
    }
    ids.add(model.id);
  }
  return payload.data;
}

async function fetchJson(url, label) {
  let response;
  try {
    response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, OPENROUTER_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (error?.name === 'AbortError') throw new ServerError(label + ' request timed out; retry sync', { status: 502 });
    throw error;
  }
  if (!response.ok) {
    throw new ServerError(label + ' request failed (' + response.status + ')', { status: 502 });
  }
  try {
    return await response.json();
  } catch {
    throw new ServerError(label + ' returned malformed JSON; retry sync', { status: 502 });
  }
}

export async function fetchOpenRouterModels() {
  return validateModels(await fetchJson(OPENROUTER_MODELS_URL, 'OpenRouter models'));
}

export function transformOpenRouterModelsToObservations(models, { retrievedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new ServerError('OpenRouter returned no model data; retry sync', { status: 502 });
  }

  const observations = [];
  for (const model of models) {
    if (!model || !validRoutedModelId(model.id)) {
      throw new ServerError('OpenRouter returned malformed model data; retry sync', { status: 502 });
    }
    if (model.pricing === null || model.pricing === undefined) continue;
    if (typeof model.pricing !== 'object' || Array.isArray(model.pricing)) {
      throw new ServerError('OpenRouter returned malformed pricing data; retry sync', { status: 502 });
    }

    const route = routedModel(model);
    const overrides = model.pricing.overrides;
    if (overrides !== undefined && !Array.isArray(overrides)) {
      throw new ServerError('OpenRouter returned malformed pricing tiers; retry sync', { status: 502 });
    }
    const baseInputRate = parseRate(model.pricing.prompt);
    const baseOutputRate = parseRate(model.pricing.completion);
    const baseReasoningRate = parseRate(model.pricing.internal_reasoning);
    const tiers = [{ key: 'standard', label: 'standard', isLongContext: false, prices: model.pricing }];
    const seenTierKeys = new Set();
    for (const override of overrides || []) {
      if (!override || typeof override !== 'object' || Array.isArray(override)) {
        throw new ServerError('OpenRouter returned malformed pricing tiers; retry sync', { status: 502 });
      }
      const condition = overrideCondition(override);
      // Some OpenRouter overrides describe audio/cache-only rates or publish
      // no scope. Those classes have no matching comparison metric or safe
      // identity in this schema, so leave them out rather than inventing one.
      const hasComparablePrice = ['prompt', 'completion', 'internal_reasoning'].some(key => hasOwn(override, key));
      if (!condition || !hasComparablePrice) continue;
      if (seenTierKeys.has(condition.key)) {
        throw new ServerError('OpenRouter returned duplicate pricing tiers; retry sync', { status: 502 });
      }
      seenTierKeys.add(condition.key);
      tiers.push({
        key: condition.key,
        label: condition.label,
        // An override changes only the fields it publishes; other token classes
        // retain the base rate, with no interpolation between published tiers.
        prices: { ...model.pricing, ...override },
      });
    }

    for (const tier of tiers) {
      const inputRate = parseRate(tier.prices.prompt);
      const outputRate = parseRate(tier.prices.completion);
      const reasoningRate = parseRate(tier.prices.internal_reasoning);
      if (inputRate === null && outputRate === null && reasoningRate === null) continue;
      if (tier.key !== 'standard'
        && inputRate === baseInputRate && outputRate === baseOutputRate && reasoningRate === baseReasoningRate) continue;

      const tierLabel = tier.label;
      const configuration = ('OpenRouter routed model ' + route.id + '; ' + tierLabel + ' pricing tier').slice(0, 500);
      const methodologyBase = 'OpenRouter published routed price for ' + route.id + '; ' + tierLabel + '. Rates are USD per million tokens.';
      observations.push({
        id: 'openrouter-price-' + identityHash([route.id, tier.key]),
        provider: 'OpenRouter',
        model: route.model,
        effort: route.effort,
        configuration,
        billing: 'api',
        benchmark: 'OpenRouter routed API pricing',
        quality: null,
        costPerTask: null,
        inputPerMillion: sourceMetric(inputRate, OPENROUTER_MODELS_URL, retrievedAt, methodologyBase + ' Prompt price is the uncached-input rate.'),
        outputPerMillion: sourceMetric(outputRate, OPENROUTER_MODELS_URL, retrievedAt, methodologyBase + ' Completion price is the output rate.'),
        reasoningPerMillion: sourceMetric(reasoningRate, OPENROUTER_MODELS_URL, retrievedAt, methodologyBase + ' Internal reasoning price is recorded only when OpenRouter publishes it.'),
        responseSeconds: null,
        tokensPerSecond: null,
        quota: null,
        notes: 'OpenRouter routed price, not the model creator first-party price. Cached-token, audio and per-request charges are not represented by this schema; free routes remain subject to upstream limits and terms.',
      });
    }
  }

  if (observations.length === 0) {
    throw new ServerError('OpenRouter returned no usable pricing observations; retry sync', { status: 502 });
  }
  return observations;
}

export async function syncOpenRouterCatalog() {
  const models = await fetchOpenRouterModels();
  const observations = transformOpenRouterModelsToObservations(models);
  const validated = modelComparisonImportSchema.parse({ schemaVersion: 1, observations });
  const updated = await importModelComparison(validated);
  return { success: true, fetched: models.length, observations: observations.length, total: updated.observations.length, catalog: updated };
}

function endpointRequestUrl(modelId) {
  const parts = modelId.split('/');
  return OPENROUTER_ENDPOINTS_URL + '/' + encodeURIComponent(parts[0]) + '/' + encodeURIComponent(parts[1]) + '/endpoints';
}

async function fetchOpenRouterModelEndpoints(model) {
  const url = endpointRequestUrl(model.id);
  let response;
  try {
    response = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, OPENROUTER_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (error?.name === 'AbortError') throw new ServerError('OpenRouter endpoints request timed out; retry sync', { status: 502 });
    throw error;
  }
  if (response.status === 404) return { model, endpoints: [] };
  if (!response.ok) {
    throw new ServerError('OpenRouter endpoints request failed (' + response.status + ')', { status: 502 });
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new ServerError('OpenRouter endpoints returned malformed JSON; retry sync', { status: 502 });
  }
  if (!payload?.data || payload.data.id !== model.id || !Array.isArray(payload.data.endpoints)) {
    throw new ServerError('OpenRouter endpoints returned malformed model data; retry sync', { status: 502 });
  }
  return { model, endpoints: payload.data.endpoints };
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  let failure = null;
  const worker = async () => {
    while (!failure) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  if (failure) throw failure;
  return results;
}

function percentileValue(windowData) {
  if (windowData === null || windowData === undefined) return null;
  if (typeof windowData !== 'object' || Array.isArray(windowData)) {
    throw new ServerError('OpenRouter returned malformed endpoint performance data; retry sync', { status: 502 });
  }
  if (!hasOwn(windowData, 'p50') || windowData.p50 === null || windowData.p50 === undefined) return null;
  if (typeof windowData.p50 !== 'number' || !Number.isFinite(windowData.p50) || windowData.p50 < 0) {
    throw new ServerError('OpenRouter returned malformed endpoint performance data; retry sync', { status: 502 });
  }
  return windowData.p50;
}

export function transformOpenRouterEndpointsToObservations(modelEndpoints, { retrievedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(modelEndpoints) || modelEndpoints.length === 0) {
    throw new ServerError('OpenRouter returned no serving endpoint data; retry sync', { status: 502 });
  }
  const observations = [];
  for (const item of modelEndpoints) {
    if (!item || !item.model || !validRoutedModelId(item.model.id) || !Array.isArray(item.endpoints)) {
      throw new ServerError('OpenRouter returned malformed serving endpoint data; retry sync', { status: 502 });
    }
    const route = routedModel(item.model);
    for (const endpoint of item.endpoints) {
      if (!endpoint || typeof endpoint !== 'object' || Array.isArray(endpoint)) {
        throw new ServerError('OpenRouter returned malformed serving endpoint data; retry sync', { status: 502 });
      }
      const providerName = typeof endpoint.provider_name === 'string' ? endpoint.provider_name.trim() : '';
      const tag = typeof endpoint.tag === 'string' ? endpoint.tag.trim() : '';
      const name = typeof endpoint.name === 'string' ? endpoint.name.trim() : '';
      const providerModelId = typeof endpoint.model_id === 'string' ? endpoint.model_id.trim() : '';
      if (!providerName && !tag && !name && !providerModelId) {
        throw new ServerError('OpenRouter returned an endpoint without an identity; retry sync', { status: 502 });
      }
      const latency = percentileValue(endpoint.latency_last_30m);
      const throughput = percentileValue(endpoint.throughput_last_30m);
      if (latency === null && throughput === null) continue;

      const identity = [
        route.id, providerName, tag, name, providerModelId,
        endpoint.quantization ?? null,
        endpoint.context_length ?? null,
        endpoint.max_prompt_tokens ?? null,
        endpoint.max_completion_tokens ?? null,
        ENDPOINT_WINDOW,
      ];
      const endpointLabel = name || tag || providerName;
      const details = [
        'OpenRouter routed model ' + route.id,
        'serving provider ' + (providerName || 'unspecified'),
        'endpoint ' + endpointLabel,
        'provider model ' + (providerModelId || 'unspecified'),
        'quantization ' + (endpoint.quantization || 'unspecified'),
        'context ' + (endpoint.context_length ?? 'unspecified'),
        'maximum prompt ' + (endpoint.max_prompt_tokens ?? 'unspecified'),
        'maximum completion ' + (endpoint.max_completion_tokens ?? 'unspecified'),
      ].join('; ');
      const sourceUrl = OPENROUTER_ENDPOINTS_URL + '/' + encodeURIComponent(route.id.split('/')[0]) + '/' + encodeURIComponent(route.id.split('/')[1]) + '/endpoints';
      observations.push({
        id: 'openrouter-endpoint-' + identityHash(identity),
        provider: 'OpenRouter',
        model: route.model,
        effort: route.effort,
        configuration: details.slice(0, 500),
        billing: 'api',
        benchmark: 'OpenRouter serving endpoint performance (30m p50)',
        quality: null,
        costPerTask: null,
        inputPerMillion: null,
        outputPerMillion: null,
        reasoningPerMillion: null,
        responseSeconds: sourceMetric(latency, sourceUrl, retrievedAt, 'OpenRouter per-serving-endpoint latency_last_30m p50, in seconds.'),
        tokensPerSecond: sourceMetric(throughput, sourceUrl, retrievedAt, 'OpenRouter per-serving-endpoint throughput_last_30m p50, in output tokens per second.'),
        quota: null,
        notes: 'Performance belongs to this OpenRouter serving endpoint and its 30-minute measurement window; no price or quality is transferred from another endpoint.',
      });
    }
  }
  if (observations.length === 0) {
    throw new ServerError('OpenRouter returned no usable serving endpoint observations; retry sync', { status: 502 });
  }
  return observations;
}
