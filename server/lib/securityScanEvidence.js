import { z } from 'zod';

const PREFIX = 'SCANNER_STATUS_JSON:';
const nullableCost = z.number().finite().nonnegative().nullable();

// Bounded, agent-reported diagnostics. No paths, prompts, findings, credentials,
// or billing claims cross this boundary; null means not established.
export const securityScanEvidenceSchema = z.object({
  version: z.literal(1),
  status: z.enum(['not-run', 'unavailable', 'completed', 'failed', 'time-limit', 'budget-limit', 'refused']),
  model: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/).nullable(),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable(),
  auth: z.enum(['chatgpt', 'api-key', 'unknown']),
  maxCostUsd: nullableCost,
  estimatedCostUsd: nullableCost,
  timeLimitSeconds: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  artifacts: z.object({ findings: z.boolean().nullable(), coverage: z.boolean().nullable() }).strict(),
}).strict().refine(value => value.status !== 'completed' || value.exitCode === 0);

/** Invalid/absent evidence stays unreported; delivery success cannot fill it in. */
export function parseSecurityScanEvidence(summary) {
  if (typeof summary !== 'string') return null;
  const lines = summary.split(/\r?\n/).filter(line => line.startsWith(PREFIX));
  if (lines.length !== 1) return null;
  let raw;
  try { raw = JSON.parse(lines[0].slice(PREFIX.length)); } catch { return null; }
  const result = securityScanEvidenceSchema.safeParse(raw);
  return result.success ? { ...result.data, source: 'agent-report' } : null;
}
