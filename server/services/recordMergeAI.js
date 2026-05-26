/**
 * AI-assisted field merge for the duplicate-record merge flow. Synthesizes
 * one unified text per conflicting field; the UI ships the result as
 * `fieldOverrides` (consumed by `recordMerge.js#resolveScalars`). Pure
 * preview — no record state is mutated here.
 *
 * Only fields where BOTH sides are non-empty strings are sent to the LLM;
 * non-string conflicts (objects, numbers) fall through to the manual picker.
 */

import { ServerError } from '../lib/errorHandler.js';
import { extractJson as extractJsonShared } from '../lib/jsonExtract.js';
import { assertProvider, resolveProviderAndModel, runPromptThroughProvider } from '../lib/promptRunner.js';
import { stripPromptControlChars, buildUniverseStyleContext } from './universeBuilder.js';

export const ERR_NO_PROVIDER = 'MERGE_AI_NO_PROVIDER';
export const ERR_NO_MERGEABLE_FIELDS = 'MERGE_AI_NO_MERGEABLE_FIELDS';
export const ERR_INVALID_JSON = 'LLM_INVALID_JSON';

const MAX_FIELD_CHARS = 4000;

const isMergeableString = (v) => typeof v === 'string' && v.trim().length > 0;

const buildPrompt = ({ kind, survivor, loser, fields }) => {
  const fieldBlocks = fields.map(({ field, survivorValue, loserValue }) => {
    const a = stripPromptControlChars(String(survivorValue)).slice(0, MAX_FIELD_CHARS);
    const b = stripPromptControlChars(String(loserValue)).slice(0, MAX_FIELD_CHARS);
    return `## ${field}\n### A\n${a}\n\n### B\n${b}`;
  }).join('\n\n');

  const survivorName = stripPromptControlChars(String(survivor?.name || 'Record A'));
  const loserName = stripPromptControlChars(String(loser?.name || 'Record B'));

  // Universe-kind merges include the survivor's style context so the LLM
  // synthesizes in-voice (matches the canonical pattern in
  // universeBuilderAutoSort). Series records have no equivalent helper, so
  // the prompt stays context-free in that branch.
  const styleSection = kind === 'universe' ? buildUniverseStyleContext(survivor, { escape: true }) : '';

  return `You are helping merge two duplicate ${kind} records that share a name but were edited independently. For each conflicting field, produce ONE unified value that preserves the substantive, distinct ideas from both inputs, removes redundancy, and reads naturally. Do NOT invent new facts; only synthesize what is already in A or B.

# Records
- A: "${survivorName}"
- B: "${loserName}"
${styleSection}
# Fields to merge
${fieldBlocks}

# Output contract
Return ONLY a JSON object of the form:
{ "merged": { "<field>": "<unified text>", ... } }
- Include EVERY field listed above as a key under "merged".
- Each value is a plain string — no markdown, no nested objects.
- No commentary, no code fences.`;
};

const isMergedShape = (o, expectedFields) => {
  if (!o || typeof o !== 'object') return false;
  if (!o.merged || typeof o.merged !== 'object') return false;
  return expectedFields.some((f) => typeof o.merged[f] === 'string');
};

/**
 * Run an AI-assisted merge over `fields` (subset of conflicting field names).
 * Returns `{ merged: { [field]: string }, llm: { provider, model }, runId, skipped }`.
 * `skipped` lists fields that were dropped because they weren't both non-empty
 * strings (caller renders them with the regular survivor/loser picker).
 *
 * @param {object} args
 * @param {'universe'|'series'} args.kind
 * @param {object} args.survivor    — full survivor record
 * @param {object} args.loser       — full loser record
 * @param {string[]} args.fields    — conflict field names to attempt to merge
 * @param {string} [args.providerId]
 * @param {string} [args.model]
 */
export async function mergeFieldsWithAI({ kind, survivor, loser, fields, providerId, model }) {
  if (!survivor || !loser) {
    throw new ServerError('survivor and loser records are required', { status: 400, code: 'MERGE_AI_VALIDATION' });
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ServerError('fields[] is required', { status: 400, code: 'MERGE_AI_VALIDATION' });
  }

  const mergeable = [];
  const skipped = [];
  for (const field of fields) {
    if (typeof field !== 'string' || !field) continue;
    const sv = survivor[field];
    const lv = loser[field];
    if (isMergeableString(sv) && isMergeableString(lv)) {
      mergeable.push({ field, survivorValue: sv, loserValue: lv });
    } else {
      skipped.push(field);
    }
  }
  if (mergeable.length === 0) {
    throw new ServerError(
      'No mergeable text fields — AI merge only handles non-empty string conflicts',
      { status: 422, code: ERR_NO_MERGEABLE_FIELDS },
    );
  }

  const { provider, selectedModel } = await resolveProviderAndModel({ providerId, model });
  assertProvider(provider, {
    message: 'No AI provider available for AI-assisted merge',
    code: ERR_NO_PROVIDER,
  });

  const prompt = buildPrompt({ kind, survivor, loser, fields: mergeable });
  console.log(`🧬 mergeFieldsWithAI — kind=${kind} fields=${mergeable.map((f) => f.field).join(',')} via ${provider.name}/${selectedModel || 'default'}`);

  const expectedFields = mergeable.map((f) => f.field);
  const { text: raw, runId } = await runPromptThroughProvider({
    provider,
    model: selectedModel,
    prompt,
    source: 'record-merge-ai',
  });

  // Empty / non-string LLM responses route through the same typed error as
  // malformed JSON so the UI shows a single actionable message instead of a
  // generic 500. extractJson would also throw, but the message would be a
  // less useful "no matching JSON found".
  if (!raw || typeof raw !== 'string') {
    throw new ServerError(
      'LLM returned an empty response for AI merge. Try a different model or rerun.',
      { status: 502, code: ERR_INVALID_JSON },
    );
  }

  const { value, lastError, lastPreview } = extractJsonShared(raw, {
    shapePredicate: (o) => isMergedShape(o, expectedFields),
  });
  if (!value || !value.merged || typeof value.merged !== 'object') {
    throw new ServerError(
      'LLM returned invalid JSON for AI merge',
      {
        status: 502,
        code: ERR_INVALID_JSON,
        context: {
          details: {
            reason: lastError?.message || 'no matching JSON found',
            preview: lastPreview || '',
          },
        },
      },
    );
  }

  const merged = {};
  for (const field of expectedFields) {
    const v = value.merged[field];
    if (typeof v === 'string') merged[field] = v;
  }

  return {
    merged,
    skipped,
    llm: { provider: provider.id, model: selectedModel || null },
    runId,
  };
}
