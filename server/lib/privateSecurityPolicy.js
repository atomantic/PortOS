import { z } from 'zod';

export const PRIVATE_SECURITY_TASK_TYPE = 'private-security-assessment';
export const PRIVATE_SECURITY_EXECUTION_PROFILE = 'private-security-assessment';
export const PRIVATE_SECURITY_DELIVERY = Object.freeze({
  executionProfile: PRIVATE_SECURITY_EXECUTION_PROFILE,
  readOnly: true, useWorktree: false, openPR: false, fileIssues: false,
  noCodeOutput: true, worktreeChangesExpected: false, simplify: false,
  reviewLoop: false,
});

export function isPrivateSecurityTask(task) {
  return task?.metadata?.analysisType === PRIVATE_SECURITY_TASK_TYPE
    || task?.metadata?.taskAnalysisType === PRIVATE_SECURITY_TASK_TYPE;
}

const text = z.string().trim().min(1).max(12000);
export const privateSecurityReportSchema = z.object({
  summary: text,
  limitations: text,
  findings: z.array(z.object({
    title: z.string().trim().min(1).max(240),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'informational']),
    confidence: z.enum(['high', 'medium', 'low']),
    file: z.string().min(1).max(1000),
    line: z.number().int().positive(),
    evidence: text,
    remediation: text,
    verification: text,
  }).strict()).max(50),
}).strict();
