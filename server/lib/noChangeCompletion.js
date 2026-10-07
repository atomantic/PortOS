/**
 * No-change completion contract.
 *
 * A task may complete successfully with an empty branch only when it opted in
 * (the persisted `noChangeSuccess` metadata marker) and is an autonomous job,
 * investigation or built-in quality audit; whether the branch really was empty is `branchProvenEmpty`,
 * decided after the run by the forge/branch check in agentFinalization.
 *
 * The prompt builder and finalization both read this one predicate, so the agent
 * is only told a clean no-op exit is allowed where finalize will honour it.
 */
import { isAuditTaskType } from './auditCatalog.js';
import { isTruthyMeta } from './metadataFlags.js';

export function permitsNoChangeCompletion(task) {
  const meta = task?.metadata;
  return isTruthyMeta(meta?.noChangeSuccess)
    && (isTruthyMeta(meta?.autonomousJob) || isTruthyMeta(meta?.isInvestigation)
      || isAuditTaskType(meta?.analysisType || meta?.taskAnalysisType));
}
