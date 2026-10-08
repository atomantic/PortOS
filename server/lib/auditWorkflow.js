/** Deep execution policy; absent markers on saved Deep records remain historical. */
export const EXTENDED_AUDIT_WORKFLOW = 'extended-v1';

export function auditWorkflow(meta = {}) {
  meta ??= {};
  if (meta.auditWorkflow != null && meta.auditWorkflow !== EXTENDED_AUDIT_WORKFLOW) throw new Error('Unsupported audit workflow version');
  if (meta.auditDepth !== 'deep') {
    if (meta.auditWorkflow != null) throw new Error('Audit workflow requires Deep depth');
    return 'quick';
  }
  if (meta.auditWorkflow === EXTENDED_AUDIT_WORKFLOW) {
    if (meta.deepAuditId) throw new Error('Extended Deep cannot reuse a historical certification checkpoint');
    return EXTENDED_AUDIT_WORKFLOW;
  }
  return 'legacy';
}
export const isLegacyDeepAudit = (meta) => auditWorkflow(meta) === 'legacy';
export const isExtendedDeepAudit = (meta) => auditWorkflow(meta) === EXTENDED_AUDIT_WORKFLOW;

/** Only call at creation boundaries, never when loading or resuming saved work. */
export function newAuditMetadata(meta = {}) {
  auditWorkflow(meta);
  if (meta.auditDepth !== 'deep') return meta;
  if (meta.deepAuditId) throw new Error('Historical Deep checkpoints are read-only; start a new Deep audit');
  return { ...meta, auditWorkflow: EXTENDED_AUDIT_WORKFLOW };
}

export const EXTENDED_AUDIT_INSTRUCTIONS = `## Deep audit — extended regular audit
This execution policy takes precedence over conflicting investigation limits in the category or saved/custom prompt below. Keep its category, safety, resource, validation, review and delivery requirements.
Spend extra effort on a useful risk-based audit in this run: orient broadly, prioritize current runtime paths and high-impact failure modes, trace callers and dependencies, challenge plausible findings, and verify concrete behavior. Follow evidence into adjacent code where needed. Do not divide the repository into exhaustive file batches or require separate static/trace/challenge invocations.
Replace quick-mode caps such as investigating only five candidates, stopping after the first finding/fix, or an arbitrary short investigation window. In audit-and-fix mode, fix multiple worthwhile issues when supported by evidence; keep changes coherent and reviewable. Do not invent findings, force unrelated fixes into one PR, or exceed the configured resource limits. In file-issues mode, retain that delivery policy and report supported findings without silently switching to code changes.
Use normal test, independent-review and PR requirements for the work actually changed. Finish this run when the worthwhile investigation and authorized delivery are done, or report a concrete blocker or resource limit. Do not automatically queue another run or launch other categories.
Write a final completion summary stating scope investigated, findings and fixes, validation actually run, delivery status, and remaining risks or untested areas. Record the usual QUALITY_AUDIT_JSON assessment honestly: partial coverage is valid, a successful run does not certify every file, and a scan count does not prove substantive review. Preserve a checkpoint of unfinished work when interrupted. No exhaustive coverage ledger or four-pass completion gate is required for this workflow.`;
