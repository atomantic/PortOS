/**
 * The per-record LLM route pin (`{ providerId, model, effort }`) saved on a record so actions run against it use the provider the user picked there.
 *
 * A model id and effort level belong to the provider they were picked for; forwarding either to another provider fails at run time.
 * So a per-call pick beats the pin, and the pin's model/effort are inherited only while the effective provider is the pinned one.
 * `null` (never `''`) marks an unset dimension. Two shapes enforce the rule: `resolveLlmRoutePin` (pin + independent per-call pick,
 * merged per field behind a provider-id comparison) and `pickLlmRoutePinLayer` (layers chosen together; the winner is taken whole).
 */

import { z } from 'zod';
import { EFFORT_LEVELS } from './providerModels.js';
import { trimTo } from './textUtils.js';

// Single source for the door check (`llmRoutePinSchema`) and the sanitizer.
export const LLM_ROUTE_PIN_LIMITS = Object.freeze({
  PROVIDER_ID_MAX: 100,
  MODEL_ID_MAX: 200,
  EFFORT_MAX: 20,
});

// Fields are nullable (cleared select) and optional (unset). `effort` is the shared enum so a typo surfaces at the door instead of being silently clamped by the runner.
export const llmRoutePinSchema = z.object({
  providerId: z.string().max(LLM_ROUTE_PIN_LIMITS.PROVIDER_ID_MAX).nullable().optional(),
  model: z.string().max(LLM_ROUTE_PIN_LIMITS.MODEL_ID_MAX).nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
});

/**
 * Trim/cap a raw pin into the stored shape. Null for a non-object or all-empty pin, so a record never persists a pin that pins nothing.
 * @param {unknown} raw
 * @returns {{ providerId: string|null, model: string|null, effort: string|null }|null}
 */
export function sanitizeLlmRoutePin(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (value, max) => trimTo(value, max) || null;
  const pin = {
    providerId: pick(raw.providerId, LLM_ROUTE_PIN_LIMITS.PROVIDER_ID_MAX),
    model: pick(raw.model, LLM_ROUTE_PIN_LIMITS.MODEL_ID_MAX),
    effort: pick(raw.effort, LLM_ROUTE_PIN_LIMITS.EFFORT_MAX),
  };
  return Object.values(pin).some(Boolean) ? pin : null;
}

/**
 * Resolve the effective route for one call against a saved pin.
 * `providerMatchesPin` is true when the call runs on the provider the pin's model/effort were picked for.
 *
 * @param {{ providerId?: string|null, model?: string|null, effort?: string|null }|null|undefined} pin
 * @param {{ providerId?: string|null, model?: string|null, effort?: string|null }} [perCall]
 * @returns {{ providerId: string|null, model: string|null, effort: string|null, providerMatchesPin: boolean }}
 */
export function resolveLlmRoutePin(pin, perCall = {}) {
  const pinned = pin || {};
  const providerMatchesPin = !perCall.providerId || perCall.providerId === pinned.providerId;
  return {
    providerId: perCall.providerId || pinned.providerId || null,
    model: perCall.model || (providerMatchesPin ? pinned.model : null) || null,
    effort: perCall.effort || (providerMatchesPin ? pinned.effort : null) || null,
    providerMatchesPin,
  };
}

// A layer without `providerId` pins nothing: the runtime looks the provider up before the model.
export function llmRoutePinNamesProvider(layer) {
  return Boolean(layer?.providerId);
}

/**
 * For layers whose provider and model were picked TOGETHER in one control: the most specific layer naming a provider wins WHOLE,
 * since merging the next layer's model per field would hand one provider another's model. The last layer is returned even without
 * a provider; null when no layer was supplied.
 *
 * @param {...({ providerId?: string|null, model?: string|null, effort?: string|null }|null|undefined)} layers most specific first, base last
 * @returns {object|null}
 */
export function pickLlmRoutePinLayer(...layers) {
  return layers.find(llmRoutePinNamesProvider) ?? layers[layers.length - 1] ?? null;
}
