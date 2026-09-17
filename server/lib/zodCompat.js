import { z } from 'zod';
import { MAX_PROVIDER_REF_LENGTH, PRESET_ID_RE, PRESET_ONLY_MESSAGE, PROVIDER_REF_MESSAGE, parseProviderRef } from './providerRef.js';

/**
 * Zod 4 compatibility helpers.
 *
 * Zod 4 changed two default-related behaviors that matter for PortOS's
 * "PATCH only the fields you send" update schemas:
 *
 * 1. `.default()` no longer re-parses its input, so a `z.object({...}).default({})`
 *    yields `{}` instead of an object with the nested field defaults filled in.
 *    Use `.prefault({})` (Zod 4) when you want the old "parse the default" behavior.
 *
 * 2. `.partial()` now ONLY marks fields optional — it no longer strips the inner
 *    `.default()`s. In Zod 3, `base.partial()` produced a schema where an omitted
 *    field stayed omitted; in Zod 4 the field's `.default()` still fires, so the
 *    parsed patch is populated with default values for keys the caller never sent.
 *    For an update/PATCH route that merges the parsed patch onto a stored record,
 *    that silently clobbers the stored value of every untouched defaulted field.
 *
 * `partialWithoutDefaults` restores the Zod 3 `.partial()` semantics for case 2:
 * it rebuilds the object shape with every field's default removed, then partials
 * it — so an omitted field is genuinely absent from the parsed result and the
 * merge layer can tell "not sent" from "sent". Field bounds/refinements are
 * preserved; only the default wrapper is unwound.
 */

/**
 * Unwrap a field's default/prefault wrapper(s) while preserving any
 * optional/nullable wrappers (re-applied in their original order) and the inner
 * type's validation rules.
 */
function stripDefault(schema) {
  const type = schema?.def?.type;
  if (type === 'default' || type === 'prefault') return stripDefault(schema.def.innerType);
  if (type === 'optional') return stripDefault(schema.def.innerType).optional();
  if (type === 'nullable') return stripDefault(schema.def.innerType).nullable();
  return schema;
}

/**
 * Like `objectSchema.partial()`, but with every field's `.default()` removed
 * first — so the parsed result contains only the keys the caller actually sent.
 * Use for any PATCH/update schema derived from a base that carries field defaults.
 *
 * The base's strict-mode is preserved: a `.strict()` source produces a strict
 * partial (unknown keys still rejected), matching what `objectSchema.partial()`
 * did. Only the field-level defaults are unwound — field bounds/refinements,
 * optional/nullable wrappers, and the object's unknown-key policy survive.
 *
 * Note this only strips *top-level* field defaults. A field that is itself a
 * defaulted nested object still inflates its own inner defaults when present —
 * if a PATCH route field-merges such a nested object onto stored state, apply
 * `partialWithoutDefaults` to that nested field too (don't rely on the
 * top-level partial to recurse).
 *
 * @param {import('zod').ZodObject} objectSchema
 * @returns {import('zod').ZodObject} partial schema with defaults stripped
 */
export function partialWithoutDefaults(objectSchema) {
  const shape = objectSchema.shape;
  const stripped = Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [key, stripDefault(field)]),
  );
  const rebuilt = z.object(stripped).partial();
  // z.object() rebuild defaults to stripping unknown keys; re-apply .strict()
  // when the source schema rejected them, so the rebuild doesn't loosen the
  // unknown-key contract.
  return objectSchema.def?.catchall?.def?.type === 'never' ? rebuilt.strict() : rebuilt;
}

/**
 * Preprocess helper: treat an empty-string UI sentinel as "not sent" so an
 * optional field's validation doesn't fire on ''. Lives here (not in
 * validation.js) so per-domain schema files can use it without importing
 * validation.js — which re-exports them, and ESM hoists `export * from`, so
 * an import in the other direction would hit a TDZ cycle.
 */
export const emptyToUndefined = (v) => (v === '' ? undefined : v);

/**
 * Build a sparse-map Zod shape from a string array of boolean-typed keys.
 * Returns the raw record so callers can either spread it (...optionalBooleanMap(KEYS))
 * into a larger object schema or wrap it directly (z.object(optionalBooleanMap(KEYS))).
 * Mirrors the `{ field?: boolean }` shape used for per-field lock maps.
 *
 * Lives here (and is re-exported by validation.js for its existing callers) for
 * the same TDZ-cycle reason as `emptyToUndefined` above: per-domain schema files
 * like `brainValidation.js` need it and must not import validation.js.
 */
export const optionalBooleanMap = (keys) =>
  Object.fromEntries(keys.map((k) => [k, z.boolean().optional()]));

/**
 * Preprocess helper: treat an empty-string UI sentinel as an explicit `null`
 * (a *clear*), distinct from `emptyToUndefined`'s "not sent". Use this when an
 * absent key must preserve the existing value on a PATCH/PUT while an empty
 * picker selection actively un-sets it (e.g. a job's appId / provider / model
 * override). Pair with `z.string().nullable().optional()`.
 */
export const emptyToNull = (v) => (v === '' ? null : v);

/**
 * A provider SELECTION reference (#7564): a preset record id OR a composite
 * `<harness>.<method>@<service-slug>[+<bootstrap-slug>]`, as `parseProviderRef`
 * reads it. This is the schema every "which provider runs this?" field takes —
 * CoS task metadata, orchestration roles, feature pins, scheduled prompts —
 * so a `{ providerId, model, effort }` selection keeps its string shape while
 * accepting either spelling.
 *
 * `providerRefFieldSchema` also admits the empty string a picker sends for
 * "use the default"; pair it with the caller's own `emptyToUndefined` /
 * `emptyToNull` preprocess when the field must distinguish clear from absent.
 *
 * `presetProviderIdSchema` is the PRESET-ONLY form for the surfaces a composite
 * must never reach: `PUT /api/providers/active`, a record's `fallbackProvider`,
 * and an app's `taskTypeOverrides` pin — a materialized composite is never a
 * stored record, so nothing keyed on `providers.json` may name one.
 *
 * Here rather than in validation.js for the same TDZ-cycle reason as
 * `emptyToUndefined`: `cosValidation.js` needs it and must not import
 * validation.js.
 */
export const providerRefSchema = z.string().trim().min(1).max(MAX_PROVIDER_REF_LENGTH)
  .refine((value) => parseProviderRef(value) !== null, PROVIDER_REF_MESSAGE);

export const providerRefFieldSchema = z.union([z.literal(''), providerRefSchema]);

export const presetProviderIdSchema = z.string().regex(PRESET_ID_RE, PRESET_ONLY_MESSAGE).max(80);
