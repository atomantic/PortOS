/**
 * Zod 4 compatibility helpers: `partialWithoutDefaults` plus the provider-reference zod forms (#7564).
 *
 * `partialWithoutDefaults(objectSchema)` is like `.partial()` but strips inner field defaults first, so a PATCH/update schema doesn't inject (and clobber) stored values of fields the caller
 * didn't send. Also home to the provider-reference zod forms (#7564), `providerRefSchema` / `providerRefFieldSchema` (a preset id OR a composite `harness.method@service[+bootstrap]`, per `providerRef.js`) and
 * `presetProviderIdSchema` (preset-only), because `cosValidation.js` needs them and must not import another domain validation file.
 *
 * Zod 4 changed two defaults behaviors: (1) `.default()` no longer re-parses its input (use `.prefault({})` for the old "parse the default"); (2) `.partial()` only marks fields optional and no longer strips inner
 * `.default()`s, so a patch schema populates defaults for keys the caller never sent, silently clobbering stored values when merged. `partialWithoutDefaults` restores Zod 3 semantics for (2): it rebuilds the shape with
 * every default removed, then partials it, so an omitted field is genuinely absent. Bounds/refinements are preserved.
 */

import { z } from 'zod';
import { MAX_PROVIDER_REF_LENGTH, PRESET_ID_RE, PRESET_ONLY_MESSAGE, PROVIDER_REF_MESSAGE, parseProviderRef } from './provider/providerRef.js';

function stripDefault(schema) {
  const type = schema?.def?.type;
  if (type === 'default' || type === 'prefault') return stripDefault(schema.def.innerType);
  if (type === 'optional') return stripDefault(schema.def.innerType).optional();
  if (type === 'nullable') return stripDefault(schema.def.innerType).nullable();
  return schema;
}

/**
 * Like `objectSchema.partial()` but with every field's `.default()` removed first, so the parsed result holds only keys the caller sent. The base's strict-mode is preserved (a `.strict()` source yields a strict partial);
 * bounds, refinements, optional/nullable wrappers and the unknown-key policy survive. Only *top-level* defaults are stripped: a defaulted nested object still inflates its inner defaults when present, so a PATCH route that
 * field-merges one onto stored state must apply `partialWithoutDefaults` to that nested field too.
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
  return objectSchema.def?.catchall?.def?.type === 'never' ? rebuilt.strict() : rebuilt;
}

export const emptyToUndefined = (v) => (v === '' ? undefined : v);

export const optionalBooleanMap = (keys) =>
  Object.fromEntries(keys.map((k) => [k, z.boolean().optional()]));
export const emptyToNull = (v) => (v === '' ? null : v);

/**
 * A provider SELECTION reference (#7564): a preset record id OR a composite `<harness>.<method>@<service-slug>[+<bootstrap-slug>]` (as `parseProviderRef` reads it), taken by every "which provider runs this?" field
 * (CoS task metadata, orchestration roles, feature pins, scheduled prompts). `providerRefFieldSchema` also admits the empty string a picker sends for "default"; pair it with `emptyToUndefined` / `emptyToNull` when
 * the field must distinguish clear from absent. `presetProviderIdSchema` is the PRESET-ONLY form for surfaces a composite must never reach (`PUT /api/providers/active`, a record's `fallbackProvider`, an app's `taskTypeOverrides` pin):
 * a materialized composite is never a stored record. Here (not in a domain validation file) for the same TDZ reason.
 */
export const providerRefSchema = z.string().trim().min(1).max(MAX_PROVIDER_REF_LENGTH)
  .refine((value) => parseProviderRef(value) !== null, PROVIDER_REF_MESSAGE);

export const providerRefFieldSchema = z.union([z.literal(''), providerRefSchema]);

export const presetProviderIdSchema = z.string().regex(PRESET_ID_RE, PRESET_ONLY_MESSAGE).max(80);

// Reject a record id that isn't a bare filename segment. Use before a
// peer-supplied / externally-sourced id is interpolated into a filesystem path
// (e.g. the sharing importer's raw `join(bucket, …, `${id}.json`)` reads, or
// the conflict journal's `recordDir(id)`), so a `../`-bearing id can't turn the
// read/delete into a path-traversal oracle. Records persisted through a
// collectionStore are already gated by its `idPattern`; this guards the raw
// path sites that don't go through a store.
export const isSafeRecordId = (id) =>
  typeof id === 'string' && id.length > 0
  && id !== '.' && id !== '..'
  && !id.includes('/') && !id.includes('\\') && !id.includes('\0');
