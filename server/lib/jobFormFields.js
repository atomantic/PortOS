/**
 * Custom configuration fields for a scheduled agent job.
 *
 * A job's prompt says what to do; these say what to do it *with*. A job may
 * declare its own small form — a subject line, extra instructions, a variant to
 * pick, a flag to set — so one prompt can be re-aimed without rewriting it, and
 * an on-demand job can be re-aimed right before each trigger.
 *
 * Two halves travel on the job and are deliberately separate:
 *   - `formFields`: the DEFINITIONS (key, label, type, options). The shape of
 *     the form. Changing one is an edit to the job's design.
 *   - `formValues`: the filled-in VALUES, keyed by field key. Changing one is
 *     just re-aiming the next run.
 * Splitting them is what lets `formatJobFormValues` render in the author's
 * declared order and silently ignore a stale value whose field was removed.
 *
 * Pure: the vocabulary, its Zod schemas, and the prompt projection. No I/O, so
 * `cosValidation.js` can validate against it without a lib → services inversion.
 */

import { z } from 'zod';

/**
 * The field vocabulary. Deliberately small and presentational — each entry is a
 * widget the UI can render and a value shape the prompt can state in one line.
 * Anything richer (a file, a repeating group) belongs in the prompt itself or a
 * data input, not here.
 */
export const JOB_FORM_FIELD_TYPES = Object.freeze(['text', 'textarea', 'number', 'select', 'checkbox']);

/** Whether a field's value is chosen from a declared option list. */
const isChoiceField = (type) => type === 'select';

// Bounds exist so a malformed client can't push an unbounded blob into every
// generated prompt. They are generous: the textarea case is a real one (pasted
// source, a long brief), and the prompt assembler is what budgets total size.
const MAX_FIELDS = 40;
const MAX_OPTIONS = 60;
const MAX_VALUE_CHARS = 20000;

const jobFormFieldOptionSchema = z.object({
  value: z.string().min(1).max(200),
  // Absent label renders as the value — the common case where they're the same.
  label: z.string().max(200).optional(),
});

const jobFormFieldSchema = z.object({
  // The key is the map key for `formValues`, never interpolated into the prompt,
  // so it only has to be stable and comparable. Restricted anyway: a key with
  // whitespace or punctuation reads as a bug when it surfaces in a stored job.
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'Key must start with a letter and use only letters, numbers, _ or -').max(64),
  // The label is what the agent actually reads — `formatJobFormValues` prints it,
  // not the key — so it carries the meaning and is required.
  label: z.string().min(1).max(120),
  type: z.enum(JOB_FORM_FIELD_TYPES),
  // Help text under the input. UI-only; never reaches the prompt, because it
  // explains the field to the human filling it, not the work to the agent.
  description: z.string().max(500).optional(),
  placeholder: z.string().max(200).optional(),
  // Enforced by the form that collects the values, not by this schema: a job is
  // routinely saved before it is aimed, and refusing to persist a half-filled
  // config would make the field impossible to add to an existing job.
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
 * The filled-in values. Kept as a loose record on purpose: a number input hands
 * back a string, a checkbox a boolean, and a cleared field an empty string, and
 * the projection below reads all three the same way. Values for fields that no
 * longer exist are harmless — the projection iterates DEFINITIONS.
 */
export const jobFormValuesSchema = z.record(
  z.string().max(64),
  z.union([z.string().max(MAX_VALUE_CHARS), z.number(), z.boolean(), z.null()])
);

/**
 * Whether a raw value counts as supplied.
 *
 * Absent, null, and blank all mean "the user did not fill this in", and an
 * unfilled field must be OMITTED rather than sent as an empty line — `Topic:`
 * with nothing after it reads to the agent as a topic of "", which is a worse
 * instruction than no topic at all. A boolean is different: `false` is a real
 * answer to a yes/no question, so it is always kept once the key exists.
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
  // Print the option's LABEL when it has one: the value is often a terse slug
  // chosen for storage, and the label is the words the author meant.
  const option = field.options?.find((candidate) => candidate.value === raw);
  return option?.label?.trim() || raw;
}

/**
 * Project a job's declared fields + filled values into the prompt section the
 * agent reads, or `''` when nothing was supplied.
 *
 * Single-line values become a bullet list so a handful of small knobs stay
 * compact; a multi-line value gets its own heading, because folding a pasted
 * brief into a bullet destroys the structure the user typed.
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

// Bounds for the re-aim tag below. A description is a one-line human label, so a
// pasted brief has to be clipped rather than inlined whole.
const REAIM_MAX_FIELDS = 3;
const REAIM_VALUE_CHARS = 40;

/** The comparable form of a value: absent, null, and blank all read the same. */
const comparableValue = (field, value) => (isSupplied(value) ? renderValue(field, value) : '');

/**
 * Name the run-configuration values that differ from the job's stored ones, as a
 * one-line suffix for the task description. Returns `''` when nothing differs.
 *
 * This exists because `addTask` rejects a task whose FIRST DESCRIPTION LINE and
 * target app match one already pending/in_progress/blocked, while
 * `formatJobFormValues` appends the configuration to the END of the prompt — and
 * the description is the prompt's first line. Without a discriminator, two
 * differently-aimed manual runs of one on-demand job produce an identical first
 * line, so the second is silently rejected as a duplicate of the first and the
 * caller is told the run was queued. Re-aiming per trigger is the whole point of
 * an on-demand job, so a re-aimed run is genuinely different work and its
 * identity has to say so — the same reason that dedupe scopes on the target app.
 *
 * Returning `''` for an unchanged configuration is deliberate: running a job
 * exactly as saved keeps the plain description it has always had, and so still
 * dedupes against a queued twin (a double-clicked "Run now" is one piece of work).
 */
export function describeReaimedValues(fields, savedValues, runValues) {
  if (!Array.isArray(fields) || fields.length === 0) return '';
  const changed = fields.filter((field) => field?.key
    && comparableValue(field, runValues?.[field.key]) !== comparableValue(field, savedValues?.[field.key]));
  if (changed.length === 0) return '';

  const parts = changed.slice(0, REAIM_MAX_FIELDS).map((field) => {
    const label = String(field.label || field.key).trim();
    // Collapse newlines: this rides on the description's FIRST line, and a
    // multi-line value would push the rest out of the dedupe key entirely.
    const text = comparableValue(field, runValues?.[field.key]).replace(/\s+/g, ' ').trim();
    if (!text) return `${label}: (cleared)`;
    return `${label}: ${text.length > REAIM_VALUE_CHARS ? `${text.slice(0, REAIM_VALUE_CHARS)}…` : text}`;
  });
  if (changed.length > REAIM_MAX_FIELDS) parts.push(`+${changed.length - REAIM_MAX_FIELDS} more`);
  return parts.join(', ');
}

/**
 * Append the run configuration to a prompt. Returns the prompt unchanged when
 * the job declares no fields or none were filled in, so a job that never uses
 * the feature produces a byte-identical prompt to before it existed.
 */
export function appendJobFormValues(job, prompt) {
  const section = formatJobFormValues(job?.formFields, job?.formValues);
  if (!section) return prompt;
  // A job with no stored template would otherwise stringify `undefined` into the
  // dispatched prompt. The configuration alone is still the whole instruction.
  return prompt ? `${prompt}\n\n---\n\n${section}` : section;
}
