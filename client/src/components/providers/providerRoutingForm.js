/**
 * OpenRouter routing preferences as form fields: seed from a provider record,
 * validate, and fold back into the `providerRouting` payload value. The server
 * (`server/lib/aiToolkit/validation.js (providerRoutingSchema)`) re-validates; this only
 * gives the editor a precise local message.
 */

const ROUTING_FORM_KEYS = ['routingSort', 'routingDataCollection', 'routingRequireParameters', 'routingOnly', 'routingIgnore', 'routingOrder', 'routingModelsText'];

export const isOpenRouterEndpoint = (endpoint) => {
  try {
    return ['openrouter.ai', 'api.openrouter.ai'].includes(new URL(String(endpoint || '')).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const listText = (list) => (Array.isArray(list) ? list.join(', ') : '');
const textList = (text) => String(text || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);

export const routingFormDefaults = (provider) => {
  const routing = provider?.providerRouting || {};
  return {
    routingSort: routing.sort || '',
    routingDataCollection: routing.data_collection || '',
    routingRequireParameters: routing.require_parameters === true,
    routingOnly: listText(routing.only),
    routingIgnore: listText(routing.ignore),
    routingOrder: listText(routing.order),
    routingModelsText: routing.models && Object.keys(routing.models).length ? JSON.stringify(routing.models, null, 2) : '',
  };
};

const parseModels = (text) => {
  if (!String(text || '').trim()) return { models: {} };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return { models: parsed };
  } catch {
    return { error: 'Per-model routing overrides must be a JSON object of { "model-id": { "sort": "price", "only": ["anthropic"] } }' };
  }
};

/** The error message for the generation tab, or null. */
export const findRoutingFormError = (formData) => {
  if (!isOpenRouterEndpoint(formData.endpoint)) return null;
  const { error } = parseModels(formData.routingModelsText);
  return error || null;
};

/** The `providerRouting` value (null clears) from form fields. */
export const buildProviderRouting = (formData) => {
  const routing = {};
  if (formData.routingSort) routing.sort = formData.routingSort;
  if (formData.routingDataCollection) routing.data_collection = formData.routingDataCollection;
  if (formData.routingRequireParameters) routing.require_parameters = true;
  for (const [key, field] of [['only', 'routingOnly'], ['ignore', 'routingIgnore'], ['order', 'routingOrder']]) {
    const list = textList(formData[field]);
    if (list.length) routing[key] = list;
  }
  const { models } = parseModels(formData.routingModelsText);
  if (models && Object.keys(models).length) routing.models = models;
  return Object.keys(routing).length ? routing : null;
};

/** Strip form-only keys from a payload; set `providerRouting` only for an OpenRouter endpoint. */
export const applyRoutingToPayload = (data, formData) => {
  for (const key of ROUTING_FORM_KEYS) delete data[key];
  if (isOpenRouterEndpoint(formData.endpoint)) data.providerRouting = buildProviderRouting(formData);
};
