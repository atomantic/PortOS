/**
 * Zod schemas for the Quota Burn routes.
 *
 * Two layers on purpose: these schemas REJECT a malformed request with a 400,
 * while `normalizeQuotaBurnConfig` (lib/quotaBurnConfig.js) CLAMPS on the way to
 * disk so a plan written by an older PortOS still loads. Both read their numbers
 * from the one `QUOTA_BURN_BOUNDS` table — when the bounds were literals in both
 * files, raising a cap in one meant the PUT 400'd on a plan the normalizer would
 * happily have accepted.
 *
 * Per the domain-validation convention this module must NOT import from
 * `validation.js` (ESM hoisting would put that read in the TDZ); it re-exports
 * from there instead.
 */

import { z } from 'zod';
import { familyForProviderId } from './providerFamilies.js';
import {
  QUOTA_BURN_BOUNDS,
  QUOTA_BURN_FAMILIES,
  QUOTA_BURN_JOB_TYPES,
  QUOTA_BURN_UNLIMITED_DISPATCHES,
} from './quotaBurnConfig.js';
import { QUOTA_BURN_TASK_REF_KIND } from './quotaBurnTaskRef.js';
import { requiresInstallWideTarget, requiresManagedAppTarget } from './taskTargetScope.js';

const B = QUOTA_BURN_BOUNDS;

// A step's run params are per-task-type, so they stay a flat scalar map here —
// the task handler owns which keys it reads. Depth is what's rejected: a nested
// blob in a config file is either a mistake or an attempt to smuggle state past
// the normalizer.
const paramValueSchema = z.union([z.string().max(B.paramLength.max), z.number().finite(), z.boolean(), z.null()]);

const refFieldSchema = z.string().min(1).max(B.idLength.max);

/**
 * What a burn step points at. Discriminated on `kind` rather than sniffed from
 * which field is present, so an ambiguous payload is a 400 instead of a guess.
 *
 * A `custom` reference stores NO `appId` — the job record owns its app scope,
 * and a second copy here could disagree with the job it points at.
 */
const quotaBurnTaskRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal(QUOTA_BURN_TASK_REF_KIND.BUILTIN),
    taskType: refFieldSchema,
    appId: z.string().max(B.idLength.max).nullable().optional(),
  }).strict(),
  z.object({
    kind: z.literal(QUOTA_BURN_TASK_REF_KIND.CUSTOM),
    jobId: refFieldSchema,
  }).strict(),
]).superRefine((ref, ctx) => {
  if (ref.kind !== QUOTA_BURN_TASK_REF_KIND.BUILTIN) return;
  if (requiresManagedAppTarget(ref.taskType) && !ref.appId) {
    ctx.addIssue({ code: 'custom', path: ['appId'], message: `scheduled task "${ref.taskType}" must name a target app` });
  }
  if (requiresInstallWideTarget(ref.taskType) && ref.appId) {
    ctx.addIssue({ code: 'custom', path: ['appId'], message: `scheduled task "${ref.taskType}" runs install-wide and cannot target one app` });
  }
});

/**
 * Per-invocation overrides. Everything is optional — an unset key INHERITS the
 * referenced task's saved setting, and nothing written here ever edits that
 * task. Provider pins are additionally checked against the step's own family in
 * `familySchemaFor` below, which is the only place the family id is known.
 */
const quotaBurnOverridesSchema = z.object({
  providerId: z.string().max(B.labelLength.max).nullable().optional(),
  model: z.string().max(B.labelLength.max).nullable().optional(),
  effort: z.string().max(B.labelLength.max).nullable().optional(),
  params: z.record(paramValueSchema).optional(),
}).strict();

// Derived by the normalizer from the live task catalog, never authored. Accepted
// (and ignored) because the page round-trips whole step objects: rejecting a
// field the GET just handed the client would 400 every save.
const quotaBurnUnavailableSchema = z.object({
  code: z.string().max(B.idLength.max),
  reason: z.string().max(B.labelLength.max * 2).optional(),
}).strict().nullable().optional();

const quotaBurnJobSchema = z.object({
  id: z.string().max(B.idLength.max).optional(),
  enabled: z.boolean().optional(),
  label: z.string().max(B.labelLength.max).optional(),
  taskRef: quotaBurnTaskRefSchema.nullable().optional(),
  // LEGACY, and a compatibility input only: a plan written before the reference
  // model still saves, and the normalizer marks it for migration rather than
  // guessing which scheduled task its copied prompt meant.
  jobType: z.enum(QUOTA_BURN_JOB_TYPES).nullable().optional(),
  overrides: quotaBurnOverridesSchema.optional(),
  unavailable: quotaBurnUnavailableSchema,
  // Compat mirrors of the overrides bag, still written by the shipped editor.
  model: z.string().max(B.labelLength.max).nullable().optional(),
  providerId: z.string().max(B.labelLength.max).nullable().optional(),
  effort: z.string().max(B.labelLength.max).nullable().optional(),
  // One-shot work: dispatch this step at most once, then drop it out of the
  // rotation until the user re-arms it. Absent reads as `false`, so plans
  // written before this field keep repeating.
  runOnce: z.boolean().optional(),
  params: z.record(paramValueSchema).optional(),
}).strict().superRefine((job, ctx) => {
  // Exactly one identity. Both would leave the normalizer choosing between a
  // reference and a copied prompt; neither is a step with no work at all.
  if (job.taskRef && job.jobType) {
    ctx.addIssue({ code: 'custom', path: ['jobType'], message: 'a step referencing a scheduled task must not also carry a legacy jobType' });
  }
  if (!job.taskRef && !job.jobType) {
    ctx.addIssue({ code: 'custom', path: ['taskRef'], message: 'a step must reference a scheduled task' });
  }
});

/**
 * Reject a provider pin that belongs to a DIFFERENT quota family than the plan
 * it sits in — burning the codex window from the claude plan is never what the
 * user meant, and the runner would happily spend it.
 *
 * Only ids that unambiguously name another family are rejected
 * (`familyForProviderId` answers null for anything else): the binary is what
 * really decides a family, and a schema cannot read the provider list. A pin
 * that survives here is still resolved within the family at dispatch time.
 */
const pinnedOutOfFamily = (familyId, pin) => {
  const pinned = familyForProviderId(pin);
  return pinned && pinned !== familyId ? pinned : null;
};

const quotaBurnFamilySchema = z.object({
  enabled: z.boolean().optional(),
  resetWithinHours: z.number().min(B.resetWithinHours.min).max(B.resetWithinHours.max).optional(),
  reservePercent: z.number().min(B.reservePercent.min).max(B.reservePercent.max).optional(),
  // The unlimited sentinel sits below the field's own minimum, so it is spelled
  // as its own branch rather than by widening `min` — which would also let 0
  // through, and 0 would read as "never burn" where the family switch belongs.
  maxDispatchesPerWindow: z.union([
    z.literal(QUOTA_BURN_UNLIMITED_DISPATCHES),
    z.number().int().min(B.maxDispatchesPerWindow.min).max(B.maxDispatchesPerWindow.max),
  ]).optional(),
  priority: z.number().int().min(B.priority.min).max(B.priority.max).optional(),
  // Replaced wholesale, never merged element-wise — it is an ordered list, and
  // a positional merge would make reordering and deletion inexpressible.
  jobs: z.array(quotaBurnJobSchema).max(B.jobsPerFamily.max).optional(),
}).strict();

/**
 * The family schema bound to ONE family id, so a step's provider pin can be
 * checked against the subscription it is actually spending. The id only exists
 * as the key in `families`, so this is the innermost scope that knows it.
 */
const familySchemaFor = (familyId) => quotaBurnFamilySchema.superRefine((family, ctx) => {
  (family.jobs || []).forEach((job, index) => {
    for (const [path, pin] of [
      [['jobs', index, 'providerId'], job.providerId],
      [['jobs', index, 'overrides', 'providerId'], job.overrides?.providerId],
    ]) {
      const other = pinnedOutOfFamily(familyId, pin);
      if (other) {
        ctx.addIssue({ code: 'custom', path, message: `provider "${pin}" belongs to the ${other} family, not ${familyId}` });
      }
    }
  });
});

// Spelled out per family rather than z.record so an unknown family key is a 400
// (a typo'd card id would otherwise round-trip and silently never burn).
export const quotaBurnConfigUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  checkIntervalMinutes: z.number().int().min(B.checkIntervalMinutes.min).max(B.checkIntervalMinutes.max).optional(),
  families: z.object(
    Object.fromEntries(QUOTA_BURN_FAMILIES.map((id) => [id, familySchemaFor(id).optional()])),
  ).strict().optional(),
}).strict();

export const quotaBurnRunSchema = z.object({
  familyId: z.enum(QUOTA_BURN_FAMILIES).optional(),
  jobId: z.string().max(B.idLength.max).optional(),
  // Bypasses the reset-window / reserve / cap gates for ONE named job. Only
  // meaningful with `familyId` — the route rejects it otherwise.
  force: z.boolean().optional(),
}).strict();

/**
 * Re-arm a spent `run once` step. `familyId` is required — a bare "clear
 * everything" would silently re-queue every one-shot job on the install, which
 * is real spend nobody asked for. Omitting `jobId` re-arms that family's whole
 * plan, which is how "run that series again" is expressed.
 */
export const quotaBurnRearmSchema = z.object({
  familyId: z.enum(QUOTA_BURN_FAMILIES),
  jobId: z.string().max(B.idLength.max).optional(),
}).strict();
