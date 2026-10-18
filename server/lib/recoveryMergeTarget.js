import { isPlainObject } from './objects.js';
import { isTruthyMeta } from './metadataFlags.js';
import { parsePullRequestUrl } from './gitForge.js';
import { PR_COMPLETIONS, explicitPrCompletion } from './prDisposition.js';
import { processAuditRecoveryOriginSchema } from './persistentMindProcessAudit.js';

/**
 * The parent pull request a repository-cleanup recovery was filed to land
 * (#12251), or null. Task metadata is writable through the task API, so this is
 * only the claimed target: merge admission grants it solely when the completed
 * parent carries the server's backlink to this exact task, branch and PR.
 */
export function repositoryCleanupMergeTarget(task) {
  const meta = task?.metadata;
  const target = meta?.recoveryMergeTarget;
  const origin = processAuditRecoveryOriginSchema.safeParse(meta?.recoveryOrigin).data;
  if (!isTruthyMeta(meta?.isRecovery) || origin?.subsystem !== 'repository-cleanup' || !isPlainObject(target)
    || typeof target.branch !== 'string' || !target.branch || !parsePullRequestUrl(target.url)
    || explicitPrCompletion(task) === PR_COMPLETIONS.LEAVE_OPEN) return null;
  return { url: target.url, branch: target.branch };
}
