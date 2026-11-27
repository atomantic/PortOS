/** Validates and repairs structured provider output and retries the same provider with a corrected prompt. */

import { extractJson } from '../../lib/jsonExtract.js';
import { isSchemaTypeCategory } from '../../lib/provider/providerCooldown.js';
import { executeProviderRunOnce } from './providerExecution.js';

// Appended on a schema/type re-request when the caller gave no `repair`; names the failure modes
// coercion couldn't fix (fenced/prose-wrapped output).
const SCHEMA_RETRY_INSTRUCTION = '\n\n---\nIMPORTANT: Your previous response could not be parsed into the required structured format. Respond with ONLY the raw JSON value that satisfies the required schema — no markdown code fences, and no explanatory text before or after the JSON.';

/**
 * Normalize a caller `responseSchema` into a predicate over a PARSED JSON value (#2350). Accepts a
 * Zod-style schema (duck-typed; no zod dependency), a bare predicate, or null/undefined (⇒ null,
 * feature off). An unrecognized truthy value degrades to "any JSON parses". Pure.
 * @returns {((value:unknown)=>boolean)|null}
 */
export function normalizeResponseSchema(schema) {
  if (!schema) return null;
  if (typeof schema === 'function') return (value) => { try { return !!schema(value); } catch { return false; } };
  if (typeof schema.safeParse === 'function') return (value) => schema.safeParse(value).success;
  if (typeof schema.parse === 'function') return (value) => { try { schema.parse(value); return true; } catch { return false; } };
  return () => true;
}

// Discriminated JSON parse: `{ ok:true, value }` (value may legitimately be
// `null`) vs `{ ok:false }`, so a top-level `null` response isn't conflated with
// a parse failure.
const safeJsonParse = (text) => { try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; } };

/**
 * True when `text` already parses as JSON that satisfies the schema predicate —
 * i.e. no correction is needed. A non-JSON or off-shape response returns false.
 */
function responseSatisfiesSchema(text, predicate) {
  if (typeof text !== 'string' || !text) return false;
  const parsed = safeJsonParse(text);
  return parsed.ok && (!predicate || predicate(parsed.value));
}

// Pick which top-level JSON shape to try first from the first structural char so an array isn't
// mis-picked as its first inner object. Both types are still tried.
function detectBlockOrder(text) {
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) return ['array', 'object'];
  return ['object', 'array'];
}

/**
 * Deterministic Tier-2 JSON coercion keyed on the caller's schema (#2350): jsonExtract.extractJson
 * strips fences/prose and pulls the first balanced block satisfying the schema predicate. Returns the
 * coerced value plus its canonical `JSON.stringify` text. Pure.
 * @param {string} text — raw response text
 * @param {*} schema — a responseSchema (see normalizeResponseSchema)
 * @returns {{ ok:true, value:unknown, text:string } | { ok:false }}
 */
export function coerceResponseToSchema(text, schema) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false };
  const predicate = normalizeResponseSchema(schema);
  for (const blockType of detectBlockOrder(text)) {
    // extractJson's fallback returns the first PARSEABLE block even if off-shape, so re-check the predicate.
    const { value } = extractJson(text, { shapePredicate: predicate || undefined, blockType });
    if (value !== undefined && (!predicate || predicate(value))) {
      return { ok: true, value, text: JSON.stringify(value) };
    }
  }
  return { ok: false };
}

// Best-effort call to a caller `repair` normalizer for a given phase. Never
// throws (a repair-callback error is logged + treated as a decline); returns the
// corrected string for the requested field, or null.
async function callRepair(repair, payload, field) {
  if (typeof repair !== 'function') return null;
  let out = null;
  try { out = await repair(payload); } catch (e) {
    console.error(`❌ Tier 2 ${payload.phase} repair callback threw: ${e.message}`);
    return null;
  }
  const v = out?.[field];
  return typeof v === 'string' && v ? v : null;
}

/**
 * Validate a run RESULT against `responseSchema` (#2350); on mismatch try, IN PLACE, the caller's
 * `repair({ phase:'response' })` then the schema-keyed JSON coercion. Never throws. Returns:
 *   { ok:true, result }                — no schema declared, or already valid
 *   { ok:true, result, coerced:true }  — recovered in place (⇒ mark Tier-2)
 *   { ok:false }                        — response is off-shape and uncoercible
 */
export async function correctResponseToSchema(result, { responseSchema, repair, prompt }) {
  const predicate = normalizeResponseSchema(responseSchema);
  // Needs a declared schema: a `repair`-only caller gives no way to know a response is malformed.
  if (!predicate) return { ok: true, result };
  const text = typeof result?.text === 'string' ? result.text : '';
  if (responseSatisfiesSchema(text, predicate)) return { ok: true, result };

  const repaired = await callRepair(repair, { phase: 'response', text, prompt }, 'text');
  if (repaired && responseSatisfiesSchema(repaired, predicate)) {
    return { ok: true, result: { ...result, text: repaired }, coerced: true };
  }
  const coerced = coerceResponseToSchema(text, responseSchema);
  if (coerced.ok) return { ok: true, result: { ...result, text: coerced.text }, coerced: true };
  return { ok: false };
}

/**
 * Build the Tier-2 corrected REQUEST: the caller's `repair({ phase:'request' })`, else (with a
 * `responseSchema`) the prompt plus a schema-conformance instruction. Returns null (Tier-2 declines)
 * when no correction exists or it wouldn't change the prompt.
 */
async function buildSchemaCorrectedPrompt({ prompt, responseSchema, repair, category, error }) {
  const repaired = await callRepair(repair, { phase: 'request', prompt, category, error }, 'prompt');
  if (repaired && repaired !== prompt) return repaired;
  if (responseSchema) {
    const corrected = `${prompt}${SCHEMA_RETRY_INSTRUCTION}`;
    if (corrected !== prompt) return corrected;
  }
  return null;
}

/**
 * Synthesize a schema/type failure Error so an uncoercible response re-enters the same fallback
 * cascade as a transport failure. Carries `effectiveProvider`/`effectiveModel`, a 'parse-error'
 * category (schema-type, so a healthy provider isn't benched for one off-shape response), and a
 * `schemaFailure` marker.
 */
export function buildSchemaFailureError(result) {
  const err = new Error('AI response did not match the declared schema and could not be coerced');
  err.errorAnalysis = { category: 'parse-error' };
  err.effectiveProvider = result?.provider;
  err.effectiveModel = result?.model ?? null;
  err.schemaFailure = true;
  return err;
}

export async function attemptSchemaCorrection({ args, rawArgs, failed, failedModel, category, firstError, investigation, primaryKey, stopOnTerminalRequest }) {
  if (!isSchemaTypeCategory(category)) return null;
  const correctedPrompt = await buildSchemaCorrectedPrompt({
    prompt: rawArgs.prompt,
    responseSchema: args.responseSchema,
    repair: args.repair,
    category,
    error: firstError,
  });
  if (!correctedPrompt) return null;
  console.log(`🧩 Tier 2 (schema/type) retry: ${rawArgs.source} on ${failed.name} (category ${category})`);
  await investigation.suppress(primaryKey);
  let tier2Result;
  try {
    tier2Result = await executeProviderRunOnce({
      ...args,
      provider: failed,
      prompt: correctedPrompt,
      runId: undefined, // fresh run so the failed primary's record stays intact
    });
  } catch (tier2Error) {
    await stopOnTerminalRequest(tier2Error);
    // Same bookkeeping as Tier 1's failed corrected retry: a retry that
    // reached the execution layer queued its own task keyed on the
    // EFFECTIVE provider/model — record + suppress it so a slow Tier-3
    // recovery can't let its backstop fire. A pre-execution throw queued
    // no task, so leave ownership with the primary for explicit escalation.
    if (tier2Error?.effectiveProvider) {
      await investigation.suppress({
        provider: tier2Error.effectiveProvider.name || tier2Error.effectiveProvider.id,
        model: tier2Error.effectiveModel || failedModel,
      });
    }
    console.log(`↪️ Tier 2 correction failed on ${failed.name}: ${tier2Error.message} — escalating to constrained-agent-retry`);
  }
  if (tier2Result) {
    // The re-requested response must ALSO satisfy the schema (or coerce)
    // — a retry that returns fresh-but-still-malformed output is not a
    // recovery. On success cancel the primary task; otherwise fall
    // through to the Tier-3 fallback provider.
    const revalidated = await correctResponseToSchema(tier2Result, args);
    if (revalidated.ok) {
      await investigation.recoverAll();
      return {
        ...revalidated.result,
        usedFallback: true,
        fixTier: 2, // FIX_TIERS.SCHEMA_TYPE (mirrored; kept decoupled from the lazy autoFixer import)
        fixStrategy: 'schema/type',
        fallbackFrom: { id: failed.id, name: failed.name },
        fallbackProvider: failed,
      };
    }
    console.log(`↪️ Tier 2 re-request still off-schema on ${failed.name} — escalating to constrained-agent-retry`);
  }
  return null;
}
