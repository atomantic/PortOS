import { z } from 'zod';

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
