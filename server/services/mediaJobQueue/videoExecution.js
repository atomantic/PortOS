/** Durable video execution receipts contain settings and numeric evidence, never worker paths. */
import { z } from 'zod';

const bytes = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional();
const positive = z.number().finite().positive();
const identifier = z.string().min(1).max(128);
const seed = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const videoExecutionParametersSchema = z.object({
  modelId: identifier,
  batchSize: z.number().int().min(1).max(20).optional(),
  mode: identifier.optional(),
  width: positive,
  height: positive,
  numFrames: positive,
  fps: positive,
  steps: positive,
  guidanceScale: z.number().finite().nonnegative().optional(),
  tiling: identifier.optional(),
  disableAudio: z.boolean().optional(),
  textEncoderId: identifier.optional(),
  speedProfileId: identifier.optional(),
  draftDecode: identifier.optional(),
  streamingMode: identifier.optional(),
});

const memorySchema = z.object({
  profileId: identifier.optional(),
  requirementBasis: z.literal('declared-profile-minus-reserve').optional(),
  totalBytes: bytes,
  availableBytes: bytes,
  budgetBytes: bytes,
  requiredBytes: bytes,
  reserveBytes: bytes,
  allocatorLimitBytes: bytes,
  allocatorApplied: z.boolean().nullable().optional(),
  peakAllocatedBytes: bytes,
  peakRssBytes: bytes,
  pressureLevel: z.number().int().min(0).max(4).nullable().optional(),
});
const terminationSchema = z.object({
  exitCode: z.number().int().min(-2147483648).max(2147483647).nullable(),
  signal: z.string().regex(/^SIG[A-Z0-9]{1,16}$/).nullable(),
  reason: z.enum(['completed', 'failed', 'canceled', 'refused', 'unknown']),
  observedAt: z.string().datetime(),
});

export const videoExecutionDiagnosticsSchema = z.object({
  memory: memorySchema.optional(),
  termination: terminationSchema.optional(),
});

export const videoExecutionSchema = z.object({
  version: z.literal(1),
  preparedAt: z.string().datetime(),
  seed,
  batchSeeds: z.array(seed).min(2).max(20).optional(),
  parameters: videoExecutionParametersSchema,
  diagnostics: videoExecutionDiagnosticsSchema.optional(),
});

export function mergeVideoExecutionDiagnostics(receipt, patch) {
  const diagnostics = videoExecutionDiagnosticsSchema.parse(patch);
  const previous = receipt.diagnostics || {};
  const memory = { ...(previous.memory || {}), ...(diagnostics.memory || {}) };
  // Later partial snapshots may not erase an earlier observed peak.
  for (const key of ['peakAllocatedBytes', 'peakRssBytes']) {
    if (Number.isFinite(previous.memory?.[key])) memory[key] = Math.max(previous.memory[key], memory[key] || 0);
  }
  return videoExecutionSchema.parse({ ...receipt, diagnostics: {
    ...previous,
    ...diagnostics,
    ...(previous.memory || diagnostics.memory ? { memory } : {}),
  } });
}
