import { z } from 'zod';

const PREFIX = 'SCANNER_STATUS_JSON:';
const nullableCost = z.number().finite().nonnegative().nullable();

// Bounded diagnostics with explicit provenance at the ingestion boundary. No paths, prompts, findings, credentials,
// or billing claims cross this boundary; null means not established.
export const securityScanEvidenceSchema = z.object({
  version: z.literal(1),
  status: z.enum(['not-run', 'running', 'invalid-input', 'unavailable', 'completed', 'failed', 'interrupted', 'time-limit', 'budget-limit', 'refused']),
  model: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/).nullable(),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable(),
  auth: z.enum(['chatgpt', 'api-key', 'unknown']),
  maxCostUsd: nullableCost,
  estimatedCostUsd: nullableCost,
  timeLimitSeconds: z.number().int().nonnegative().nullable(),
  exitCode: z.number().int().nullable(),
  artifacts: z.object({ findings: z.boolean().nullable(), coverage: z.boolean().nullable() }).strict(),
  cleanup: z.enum(['not-needed', 'confirmed', 'unconfirmed']).optional(),
  preflight: z.object({
    rejectedRequests: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    lastError: z.object({
      field: z.enum(['paths', 'knowledgeBase']),
      index: z.number().int().min(0).max(99),
      code: z.enum(['path-not-found', 'outside-workspace', 'invalid-path']),
    }).strict(),
  }).strict().optional(),
}).strict().refine(value => value.status !== 'completed' || value.exitCode === 0);

// This grant is set once at agent dispatch, never accepted from the model's
// scan request. These ceilings preserve the bounded existing scanner workflow.
export const securityScanGrantSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/).nullable(),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable(),
  auth: z.literal('chatgpt'),
  maxCostUsd: z.literal(2),
  timeLimitSeconds: z.literal(180),
}).strict();

export const securityScanRequestSchema = z.object({
  prompt: z.string().min(1).max(32000),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(100),
  knowledgeBase: z.array(z.string().min(1).max(4096)).max(20).default([]),
}).strict();

export function initialSecurityScanEvidence(grant) {
  return { version: 1, status: 'not-run', ...grant, estimatedCostUsd: null,
    exitCode: null, artifacts: { findings: null, coverage: null }, cleanup: 'not-needed', source: 'runner' };
}

export function parseRunnerSecurityScanEvidence(value) {
  if (value?.source !== 'runner') return null;
  const { source, sequence, ...data } = value;
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  const parsed = securityScanEvidenceSchema.safeParse(data);
  return parsed.success ? { ...parsed.data, source, sequence } : null;
}

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

/** Pin to the effective Codex argv, including saved flags and effort clamping.
 * Implicit defaults or conflicting pins are unavailable, never guessed. */
export function securityScanGrantFromArgs(args = []) {
  const models = new Set();
  const efforts = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' || arg === '-m') models.add(args[++i]);
    else if (/^(?:--model|-m)=/.test(arg)) models.add(arg.slice(arg.indexOf('=') + 1));
    else {
      const config = arg === '-c' || arg === '--config' ? args[++i]
        : arg.startsWith('--config=') ? arg.slice(9) : arg.startsWith('-c') ? arg.slice(2) : null;
      const match = config?.match(/^(model|model_reasoning_effort)\s*=\s*(.*?)\s*$/);
      if (match) {
        const value = match[2].replace(/^(["'])(.*)\1$/, '$2');
        (match[1] === 'model' ? models : efforts).add(value);
      }
    }
  }
  const model = models.size === 1 ? [...models][0] : null;
  const effort = efforts.size === 1 ? [...efforts][0] : null;
  const parsed = securityScanGrantSchema.safeParse({ model, effort, auth: 'chatgpt', maxCostUsd: 2, timeLimitSeconds: 180 });
  return parsed.success ? parsed.data : { model: null, effort: null, auth: 'chatgpt', maxCostUsd: 2, timeLimitSeconds: 180 };
}
