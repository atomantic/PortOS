/**
 * No-change completion contract.
 *
 * A task may complete successfully with an empty branch only when it opted in
 * (the persisted `noChangeSuccess` metadata marker) and is an autonomous job,
 * investigation, built-in quality audit, or an allow-listed scheduled type;
 * whether the branch really was empty is `branchProvenEmpty`, decided after the
 * run by the forge/branch check in agentFinalization.
 *
 * The prompt builder and finalization both read this one predicate, so the agent
 * is only told a clean no-op exit is allowed where finalize will honour it.
 */
import { isAuditTaskType } from './auditCatalog.js';
import { isTruthyMeta } from './metadataFlags.js';

// Scheduled types outside the audit catalog whose ordinary successful outcome is
// "nothing to change". Admission is by name, not by the marker alone, because
// `noChangeSuccess` survives schedule and per-app metadata edits
// (cosValidation.js allowlist): without the list, flipping it on any
// code-shipping type would let an agent that did nothing report success.
// `taskSchedule.test.js` holds the two in parity: a shipped default that carries
// the marker must be listed here, and every entry must ship the marker.
export const NO_CHANGE_SCHEDULED_TYPES = Object.freeze(new Set(['dependency-updates']));

export function permitsNoChangeCompletion(task) {
  const meta = task?.metadata;
  const scheduledType = meta?.analysisType || meta?.taskAnalysisType;
  return isTruthyMeta(meta?.noChangeSuccess)
    && (isTruthyMeta(meta?.autonomousJob) || isTruthyMeta(meta?.isInvestigation)
      || isAuditTaskType(scheduledType) || NO_CHANGE_SCHEDULED_TYPES.has(scheduledType));
}
