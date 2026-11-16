/**
 * Custom configuration fields for a scheduled agent job.
 *
 * A job may declare its own small form (subject, extra instructions, a variant,
 * a flag) so one prompt can be re-aimed without rewriting it, including right
 * before each on-demand trigger.
 *
 * Two halves travel on the job, deliberately separate:
 *   - `formFields`: the DEFINITIONS (key, label, type, options); editing one
 *     changes the job's design.
 *   - `formValues`: the filled-in VALUES keyed by field key; editing one just
 *     re-aims the next run.
 * That split lets `formatJobFormValues` render in declared order and ignore a
 * stale value whose field was removed.
 *
 * Pure: the vocabulary, its Zod schemas, and the prompt projection. No I/O, so
 * `cosValidation.js` can validate against it without a lib → services inversion.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

/** The field vocabulary: small and presentational; anything richer (a file, a repeating group) belongs in the prompt or a data input. */
export const JOB_FORM_FIELD_TYPES = Object.freeze(['text', 'textarea', 'number', 'select', 'checkbox']);

/** Whether a field's value is chosen from a declared option list. */
const isChoiceField = (type) => type === 'select';

// Bounds keep a malformed client from pushing an unbounded blob into every
// prompt; generous because pasted briefs are real (the assembler budgets total size).
const MAX_FIELDS = 40;
const MAX_OPTIONS = 60;
const MAX_VALUE_CHARS = 20000;

const jobFormFieldOptionSchema = z.object({
  value: z.string().min(1).max(200),
  // Absent label renders as the value — the common case where they're the same.
  label: z.string().max(200).optional(),
});

const jobFormFieldSchema = z.object({
  // The map key for `formValues`, never interpolated into the prompt.
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'Key must start with a letter and use only letters, numbers, _ or -').max(64),
  // The agent reads the label (`formatJobFormValues` prints it, not the key).
  label: z.string().min(1).max(120),
  type: z.enum(JOB_FORM_FIELD_TYPES),
  // UI-only help text; never reaches the prompt.
  description: z.string().max(500).optional(),
  placeholder: z.string().max(200).optional(),
  // Enforced by the collecting form, not this schema: a job is routinely saved
  // before it is aimed, and refusing a half-filled config would block adding a
  // field to an existing job.
  required: z.boolean().optional(),
  options: z.array(jobFormFieldOptionSchema).max(MAX_OPTIONS).optional(),
}).superRefine((field, ctx) => {
  const needsOptions = isChoiceField(field.type);
  if (needsOptions && !(field.options?.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: `A ${field.type} field needs at least one option` });
  }
  if (!needsOptions && field.options?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: `A ${field.type} field must not declare options` });
  }
  const values = field.options?.map((option) => option.value) || [];
  if (new Set(values).size !== values.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Option values must be unique' });
  }
});

export const jobFormFieldsSchema = z.array(jobFormFieldSchema).max(MAX_FIELDS).superRefine((fields, ctx) => {
  const keys = fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Field keys must be unique' });
  }
});

/**
 * The filled-in values, a loose record on purpose: a number input hands back a
 * string, a checkbox a boolean, a cleared field an empty string. Values for
 * removed fields are harmless — the projection iterates DEFINITIONS.
 */
export const jobFormValuesSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(MAX_VALUE_CHARS), z.number(), z.boolean(), z.null()])
);

/**
 * Whether a raw value counts as supplied. Absent, null and blank mean unfilled
 * and the field is OMITTED (an empty `Topic:` reads as a topic of ""). A
 * boolean is always kept: `false` is a real answer.
 */
function isSupplied(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return true;
  return String(value).trim().length > 0;
}

/** Render one value as the agent should read it. */
function renderValue(field, value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const raw = String(value).trim();
  if (field.type !== 'select') return raw;
  // Print the option's LABEL: the value is often a terse storage slug.
  const option = field.options?.find((candidate) => candidate.value === raw);
  return option?.label?.trim() || raw;
}

/**
 * Project a job's declared fields + filled values into the prompt section the
 * agent reads, or `''` when nothing was supplied.
 *
 * Single-line values become bullets; a multi-line value gets its own heading so
 * a pasted brief keeps its structure.
 */
export function formatJobFormValues(fields, values) {
  if (!Array.isArray(fields) || fields.length === 0) return '';
  const supplied = fields
    .filter((field) => field?.key && isSupplied(values?.[field.key]))
    .map((field) => ({ label: String(field.label || field.key).trim(), text: renderValue(field, values[field.key]) }))
    .filter(({ text }) => text.length > 0);
  if (supplied.length === 0) return '';

  const inline = supplied.filter(({ text }) => !text.includes('\n'));
  const blocks = supplied.filter(({ text }) => text.includes('\n'));

  const parts = [
    '## Run configuration',
    'These values were set for this run in the task\'s own configuration form. They are the parameters for THIS run: where one of them narrows or contradicts a general instruction above, the value here wins. A field the user left blank is omitted rather than passed as empty, so treat anything absent as unconstrained.',
  ];
  if (inline.length > 0) {
    parts.push(inline.map(({ label, text }) => `- ${label}: ${text}`).join('\n'));
  }
  for (const { label, text } of blocks) {
    parts.push(`### ${label}\n\n${text}`);
  }
  return parts.join('\n\n');
}

// Bounds for the re-aim tag below; a description is a one-line label, so briefs are clipped.
const REAIM_MAX_FIELDS = 3;
const REAIM_VALUE_CHARS = 40;

/** The comparable form of a value: absent, null, and blank all read the same. */
const comparableValue = (field, value) => (isSupplied(value) ? renderValue(field, value) : '');

/**
 * Name the run-configuration values that differ from the job's stored ones, as a
 * one-line suffix for the task description. Returns `''` when nothing differs.
 *
 * `addTask` rejects a task whose FIRST DESCRIPTION LINE and target app match one
 * already pending/in_progress/blocked, while `formatJobFormValues` appends the
 * configuration to the END of the prompt. Without a discriminator, two
 * differently-aimed runs of one on-demand job share a first line and the second
 * is silently rejected while the caller is told it was queued.
 *
 * `''` for an unchanged configuration is deliberate: a job run exactly as saved
 * keeps its plain description and still dedupes against a queued twin (a
 * double-clicked "Run now" is one piece of work).
 */
export function describeReaimedValues(fields, savedValues, runValues) {
  if (!Array.isArray(fields) || fields.length === 0) return '';
  const changed = fields.filter((field) => field?.key
    && comparableValue(field, runValues?.[field.key]) !== comparableValue(field, savedValues?.[field.key]));
  if (changed.length === 0) return '';

  const parts = changed.slice(0, REAIM_MAX_FIELDS).map((field) => {
    // Newlines are collapsed in label and value: the tag rides on the description's
    // FIRST line, and a newline would push the digest onto line 2, where
    // firstLine() drops it from the dedupe key.
    const label = String(field.label || field.key).replace(/\s+/g, ' ').trim();
    const raw = comparableValue(field, runValues?.[field.key]).trim();
    const text = raw.replace(/\s+/g, ' ');
    if (!text) return `${label}: (cleared)`;
    if (text.length > REAIM_VALUE_CHARS) return `${label}: ${text.slice(0, REAIM_VALUE_CHARS)}…`;
    return `${label}: ${text}`;
  });
  if (changed.length > REAIM_MAX_FIELDS) parts.push(`+${changed.length - REAIM_MAX_FIELDS} more`);

  // ALWAYS carry a digest of the WHOLE effective configuration: the readable part
  // is for the human, this is the identity. Not just the delta, because the
  // baseline itself moves (editing a different saved field can yield an identical
  // changed set for two different runs). The dedupe key is
  // `firstLine(description).toLowerCase()` and the readable form is lossy
  // (case-folded, separator-ambiguous, clipped), so any collision would silently
  // drop a run; the digest is unconditional rather than gated on guessing which
  // renderings lose information. JSON, not a joined string, since any separator
  // can occur inside a value.
  const full = JSON.stringify(fields.filter((field) => field?.key).map((field) => [field.key, comparableValue(field, runValues?.[field.key])]));
  parts.push(createHash('sha1').update(full).digest('hex').slice(0, 8));
  return parts.join(', ');
}

/**
 * Append the run configuration to a prompt; unchanged when the job declares no
 * fields or none were filled in.
 */
export function appendJobFormValues(job, prompt) {
  const section = formatJobFormValues(job?.formFields, job?.formValues);
  if (!section) return prompt;
  // No stored template: the configuration alone is the instruction (avoids stringifying `undefined`).
  return prompt ? `${prompt}\n\n---\n\n${section}` : section;
}
