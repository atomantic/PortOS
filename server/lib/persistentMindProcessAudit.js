/** Bounded private process evidence and closed-vocabulary public findings. */
import { z } from 'zod';
import { createHash } from 'node:crypto';

export const PROCESS_AUDIT_LIMITS = Object.freeze({ jobsPerTurn: 3, excerptBytes: 3000, records: 2000, windowDays: 30, scanPage: 100 });
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
export const processAuditRecoveryOriginSchema = z.object({
  parentAgentId: id, parentTaskId: id.nullable(), subsystem: z.enum(['repository-cleanup']),
  attempt: z.number().int().min(1).max(1000), observation: z.string().regex(/^[a-f0-9]{64}$/), noProgress: z.boolean(),
}).strict();
export const processAuditNextSchema = z.object({ appId: id, cursor: z.string().max(200).optional() }).strict();
export const processAuditFixSchema = z.object({ appId: id, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict();
export const processAuditReadSchema = z.object({ appId: id, receiptId: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().min(0).max(100_000_000).default(0) }).strict();
export const PROCESS_AUDIT_TEMPLATES = Object.freeze({
  'misleading-doc': { title: 'Investigate misleading workflow documentation', problem: 'A bounded job audit observed a reported documentation mismatch; reproduction is required before attributing the cause.', fix: 'Compare the documented workflow with its supported interface and correct the owning documentation with a regression.', repro: 'Use an example task and a synthetic obsolete instruction; verify the documented supported workflow completes without a corrective agent.' },
  'wrong-tool': { title: 'Investigate unsupported tool selection in agent workflow', problem: 'A bounded job audit observed an unavailable tool or unsupported command.', fix: 'Align the owning instructions with the supported tool interface and add a workflow regression.', repro: 'Give an example task a tool catalog without the requested operation; verify the agent selects the documented supported operation.' },
  'unchanged-retry': { title: 'Bound unchanged failing retries in agent workflow', problem: 'A bounded job audit observed repeated identical failure lines. This is a suspected retry inefficiency, not proof of a command execution count.', fix: 'Stop unchanged retries after a bounded attempt count and surface the actionable prerequisite.', repro: 'Use a synthetic operation that always returns the same failure; verify repeated failures terminate with an actionable outcome.' },
  'validation-gap': { title: 'Make missing validation evidence explicit in completion workflow', problem: 'A completed job has no recorded validation verdict. This does not prove validation was skipped.', fix: 'Trace the owning completion path and preserve explicit validation outcomes, including not-applicable.', repro: 'Complete an example job with validation evidence and another without it; verify their recorded outcomes remain distinguishable.' },
  'recovery-loop': { title: 'Investigate recurring recovery overhead in completion workflow', problem: 'Typed recovery lineage identifies repeated recovery work without a recorded state improvement.', fix: 'Use an existing deterministic repair when its preconditions are proven; otherwise stop unchanged recovery and retain an actionable hold.', repro: 'Feed a synthetic recovery chain unchanged repository observations; verify no additional healer is dispatched without new evidence.' },
});
export const processAuditOutcomeSchema = z.object({
  appId: id, receiptId: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(['clean', 'insufficient-evidence', 'transient-provider', 'known-issue', 'finding']),
  targetAppId: id.optional(),
  template: z.enum(Object.keys(PROCESS_AUDIT_TEMPLATES)).optional(),
  anchors: z.array(z.string().max(180).regex(/^(?:server|client|scripts|lib|commands|docs)\/[a-zA-Z0-9_./-]+\.(?:js|jsx|ts|tsx|md)$/)).max(3).optional(),
}).strict();
export const processAuditFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Signals are observations, never authority or proof of correctness. */
export function processAuditSignals(record, text = '') {
  const signals = [];
  if (/command not found|unknown tool|unsupported tool|tool.*not available/i.test(text)) signals.push('wrong-tool');
  if (/documentation.{0,60}(?:incorrect|outdated|wrong)|misleading (?:documentation|instructions)/i.test(text)) signals.push('misleading-doc');
  const failures = text.split('\n').map(line => line.trim()).filter(line => /error|failed|not found/i.test(line));
  if (failures.some((line, i) => failures.slice(i + 1).filter(other => other === line).length >= 2)) signals.push('unchanged-retry');
  if (record.result?.validationPassed == null) signals.push('validation-gap');
  const lineage = record.metadata?.recoveryOrigin;
  if (lineage && (lineage.attempt >= 2 || lineage.noProgress === true)) signals.push('recovery-loop');
  return signals;
}

export function processAuditMetrics(records) {
  const recovery = records.filter(record => record.metadata?.isRecovery || record.metadata?.recoveryOrigin);
  const sumKnown = (items, field) => {
    const values = items.map(record => record.result?.[field]).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    return { value: values.length ? values.reduce((a, b) => a + b, 0) : null, measured: values.length, total: items.length };
  };
  const byId = new Map(records.map(record => [record.id, record]));
  const chains = new Map();
  for (const record of recovery) {
    let current = record; let unknown = false; const visited = new Set();
    while (current.metadata?.recoveryOrigin?.parentAgentId && !visited.has(current.id)) {
      visited.add(current.id);
      const parent = current.metadata.recoveryOrigin.parentAgentId;
      if (!byId.has(parent)) { current = { id: parent }; unknown = true; break; }
      current = byId.get(parent);
    }
    const key = processAuditFingerprint(current.id);
    const chain = chains.get(key) || { fingerprint: key, rows: [], partial: unknown || visited.has(current.id) };
    chain.rows.push(record); chains.set(key, chain);
  }
  return { jobs: records.length, deterministicCleanups: records.filter(record => record.metadata?.maintenanceOutcome === 'deterministic-cleanup').length, cleanupOutcomeKnown: records.filter(record => record.metadata?.maintenanceOutcome).length, recovery: recovery.length, recoveryRatio: records.length ? recovery.length / records.length : null,
    lineageKnown: recovery.filter(record => record.metadata?.recoveryOrigin).length,
    noProgress: recovery.filter(record => record.metadata?.recoveryOrigin?.noProgress === true).length,
    maxRecoveryDepth: Math.max(0, ...recovery.map(record => record.metadata?.recoveryOrigin?.attempt || 0)),
    duration: sumKnown(records, 'duration'), recoveryDuration: sumKnown(recovery, 'duration'),
    providerCalls: sumKnown(records, 'providerCalls'), tokens: sumKnown(records, 'tokens'), cost: sumKnown(records, 'cost'),
    chains: [...chains.values()].slice(0, 10).map(chain => ({ fingerprint: chain.fingerprint, recoveryJobs: chain.rows.length, partial: chain.partial, duration: sumKnown(chain.rows, 'duration'), providerCalls: sumKnown(chain.rows, 'providerCalls'), tokens: sumKnown(chain.rows, 'tokens'), cost: sumKnown(chain.rows, 'cost') })),
    interpretation: 'Bounded observed sample; absent metering and lineage are unknown, never zero cost or proof of regression.' };
}

/** No model prose, transcript text, job IDs or machine data enter this renderer. */
export function renderProcessAuditFinding(template, anchors, fingerprint) {
  const spec = PROCESS_AUDIT_TEMPLATES[template];
  return { title: `${spec.title} [${fingerprint.slice(0, 12)}]`, body: `## Problem\n${spec.problem}\n\n## Code anchors\n${anchors.map(path => `- \`${path}\``).join('\n')}\n\n## Synthetic reproduction\n${spec.repro}\n\n## Chosen next step\n${spec.fix}\n\n## Acceptance criteria\n- Reproduce the suspected mechanism with synthetic fixtures before changing behavior.\n- Preserve required approval, review, CI, data-safety and ownership guards.\n- Verify improvement on comparable subsequent jobs; do not infer correctness from a final summary.\n\n<!-- process-audit:${fingerprint} -->` };
}
