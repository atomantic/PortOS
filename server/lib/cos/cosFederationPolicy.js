/**
 * `isMachineLocalCosTask` excludes private assessments and explicitly machine-local tasks and agent
 * archives from federation.
 */

import { isPrivateSecurityTask } from '../privateSecurityPolicy.js';
import { isTruthyMeta } from '../metadataFlags.js';

/** Shared by live task transport and archived agent metadata/byte transport. */
export function isMachineLocalCosTask(task) {
  return isPrivateSecurityTask(task)
    || isTruthyMeta(task?.metadata?.machineLocal);
}
