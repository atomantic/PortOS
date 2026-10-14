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
  maxCostUsd: z.union([nullableCost, z.literal('unlimited')]),
  estimatedCostUsd: nullableCost,
  // Explicit unlimited values survive JSON; null still means unknown, zero is zero.
  timeLimitSeconds: z.union([z.number().int().nonnegative().nullable(), z.literal('unlimited')]),
  exitCode: z.number().int().nullable(),
  artifacts: z.object({ findings: z.boolean().nullable(), coverage: z.boolean().nullable() }).strict(),
  cleanup: z.enum(['not-needed', 'confirmed', 'unconfirmed']).optional(),
  baseline: z.object({
    kind: z.literal('git-commit'),
    commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    tree: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    uncommitted: z.literal('excluded'), submodules: z.literal('excluded'), symlinks: z.literal('link-text'),
  }).strict().optional(),
  preflight: z.object({
    rejectedRequests: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    lastError: z.object({
      field: z.enum(['paths', 'knowledgeBase']),
      index: z.number().int().min(0).max(99),
      code: z.enum(['path-not-found', 'outside-workspace', 'invalid-path', 'not-in-commit', 'submodule-excluded']),
    }).strict(),
  }).strict().optional(),
}).strict().refine(value => value.status !== 'completed' || value.exitCode === 0);

// New dispatches impose neither an estimate cap nor an elapsed-time deadline.
// Provider quota, rate and safety limits remain in force.
const NEW_SCAN_LIMITS = Object.freeze({ maxCostUsd: 'unlimited', timeLimitSeconds: 'unlimited' });
const legacySecurityScanGrantSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/).nullable(),
  effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']).nullable(),
  auth: z.literal('chatgpt'),
  maxCostUsd: z.literal(2),
  timeLimitSeconds: z.literal(180),
}).strict();

// Saved grants retain their original pair of limits; accepting them must never
// upgrade an existing attempt. No policy is accepted from a scan request.
export const securityScanGrantSchema = z.union([
  legacySecurityScanGrantSchema.extend({
    maxCostUsd: z.literal(NEW_SCAN_LIMITS.maxCostUsd),
    timeLimitSeconds: z.literal(NEW_SCAN_LIMITS.timeLimitSeconds),
  }),
  legacySecurityScanGrantSchema.extend({ maxCostUsd: z.literal(25), timeLimitSeconds: z.literal(1200) }),
  legacySecurityScanGrantSchema,
]);

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

/** Fixed-size public disclosure, independent of the bounded assistant summary. */
export function securityScanPRDisclosure(value, control) {
  if (value == null && control == null) return '';
  const scan = parseRunnerSecurityScanEvidence(value);
  if (!scan) return '## Security scanner\n\nRunner evidence unavailable; audit delivery does not establish scanner completion.\n\n';
  const known = value => value ?? 'unknown';
  const artifact = value => value == null ? 'unknown' : value ? 'saved' : 'absent';
  const limit = value => value === 'unlimited' ? 'none' : known(value);
  return [
    '## Security scanner (runner observed)', '',
    `Status: **${scan.status}**. Audit delivery and assessment success are separate from scanner completion.`,
    ...(control?.status === 'interrupted' ? ['Runner connection lost: interrupted; process cleanup unconfirmed. The status above is the last runner observation.'] : []),
    `Model: ${known(scan.model)}; effort: ${known(scan.effort)}; auth: ${scan.auth}.`,
    `API-equivalent estimated USD: ${known(scan.estimatedCostUsd)}; estimate cap: ${limit(scan.maxCostUsd)}; time limit (seconds): ${limit(scan.timeLimitSeconds)}. These estimates do not establish billed charges or subscription usage.`,
    `Exit: ${known(scan.exitCode)}; process cleanup: ${known(scan.cleanup)}; findings artifact: ${artifact(scan.artifacts.findings)}; coverage artifact: ${artifact(scan.artifacts.coverage)}. Artifact presence does not establish a clean scan.`,
    scan.baseline ? `Baseline commit: \`${scan.baseline.commit}\`; tree: \`${scan.baseline.tree}\`. Uncommitted files and submodules excluded; symlinks represented as link text. This does not certify subsequent repairs.` : 'Scanned revision: unknown.',
    ...(scan.preflight ? [`Input rejections: ${scan.preflight.rejectedRequests}; last: ${scan.preflight.lastError.field} item ${scan.preflight.lastError.index + 1}, ${scan.preflight.lastError.code}.`] : []),
    '', '',
  ].join('\n');
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
  const parsed = securityScanGrantSchema.safeParse({ model, effort, auth: 'chatgpt', ...NEW_SCAN_LIMITS });
  return parsed.success ? parsed.data : { model: null, effort: null, auth: 'chatgpt', ...NEW_SCAN_LIMITS };
}
