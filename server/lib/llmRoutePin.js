/**
 * The per-record LLM route pin — `{ providerId, model, effort }` saved on a
 * record so an action run against it uses the provider the user picked there
 * instead of the global active provider.
 *
 * Eight subsystems each hand-rolled this shape (series `llm`, FableLoom
 * `playSettings`, CoS job pins, creative-director stage pins, …), and every
 * copy re-derived the same rule from scratch. This module owns it once:
 *
 * **A model id and an effort level belong to the provider they were picked
 * for.** Forwarding either to a different provider fails at run time — a
 * `claude --model gemini-…` spawn, or an effort level the target CLI's ladder
 * has never heard of. So a per-call pick beats the pin outright, and the pin's
 * model/effort are inherited ONLY while the effective provider is still the
 * one they were picked for. A per-call switch that names no model leaves the
 * model blank so the new provider's default resolves.
 *
 * `null` (never `''`) marks an unset dimension, so "fall through to the next
 * layer" stays distinguishable from a deliberate empty choice.
 *
 * That rule has TWO shapes, and picking the wrong one silently crosses
 * providers:
 *
 * - `resolveLlmRoutePin(pin, perCall)` — a saved record pin plus an independent
 *   one-off pick. The two merge per FIELD, guarded by a provider-id comparison.
 * - `pickLlmRoutePinLayer(...layers)` — configuration layers whose provider and
 *   model were chosen together in one control. The winning layer is taken
 *   WHOLE, which enforces the same rule without a comparison.
 */

import { z } from 'zod';
import { EFFORT_LEVELS } from './providerModels.js';
import { trimTo } from './textUtils.js';

/** Field caps for a pin — the one source of truth for both the door check
 *  (`llmRoutePinSchema`) and the sanitizer, so they can never drift. */
export const LLM_ROUTE_PIN_LIMITS = Object.freeze({
  PROVIDER_ID_MAX: 100,
  MODEL_ID_MAX: 200,
  EFFORT_MAX: 20,
});

/**
 * Zod fragment for a pin. Every field is nullable (a cleared select sends
 * `null`) and optional (an unset dimension is simply absent). `effort` is the
 * shared ladder enum rather than a capped free string — the runner clamps an
 * unknown level silently, and the door check is where a typo should surface.
 * Callers add `.nullable()` when the whole pin can be cleared at once.
 */
export const llmRoutePinSchema = z.object({
  providerId: z.string().max(LLM_ROUTE_PIN_LIMITS.PROVIDER_ID_MAX).nullable().optional(),
  model: z.string().max(LLM_ROUTE_PIN_LIMITS.MODEL_ID_MAX).nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
});

/**
 * Trim/cap a raw pin into the stored shape. Returns `null` for a non-object or
 * an all-empty pin, so a record never persists a pin that pins nothing.
 *
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
 *
 * `providerMatchesPin` is `true` when the call is still running on the
 * provider the pin's model/effort were picked for — either because the call
 * named no provider, or because it named the pinned one. Callers surface it
 * when they need to explain why a pinned model was dropped.
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

/** Does this layer pin a route at all? A layer that names no `providerId` pins
 *  nothing the runtime can key on — the model alone is unresolvable, since the
 *  runtime looks the provider up first. */
export function llmRoutePinNamesProvider(layer) {
  return Boolean(layer?.providerId);
}

/**
 * The OTHER precedence rule, for pins arranged in configuration LAYERS rather
 * than pin-plus-per-call: the most specific layer that names a provider wins as
 * a WHOLE, and the least specific layer is the base everything falls through to.
 *
 * Use this — not `resolveLlmRoutePin` — when each layer's provider and model
 * were picked TOGETHER in one control (a drawer's provider + model selects, a
 * settings assignment row). There, a layer that names a provider but no model
 * means "that provider's default model", so merging the next layer's model in
 * per-field would hand one provider a model chosen for another: the same
 * never-cross-providers rule as `resolveLlmRoutePin`, enforced by taking the
 * winning layer whole instead of by comparing provider ids.
 *
 * `resolveLlmRoutePin` stays right where the layers are a saved record pin and a
 * one-off per-call pick, which are independent choices and DO merge per field.
 *
 * The final layer is returned even when it names no provider, so a base layer
 * that carries only a model still reaches the caller. Returns `null` when no
 * layer was supplied at all.
 *
 * @param {...({ providerId?: string|null, model?: string|null, effort?: string|null }|null|undefined)} layers
 *   most specific first, base last
 * @returns {object|null}
 */
export function pickLlmRoutePinLayer(...layers) {
  return layers.find(llmRoutePinNamesProvider) ?? layers[layers.length - 1] ?? null;
}
