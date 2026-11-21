/**
 * `isMachineLocalCosTask` excludes private assessments and explicitly machine-local tasks and agent
 * archives from federation.
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { hasStoredPrivacyFacts } from '../privacyPrompt.js';
import { safeJSONParse, tryReadFile } from '../fileUtils.js';
import { isPlainObject } from '../objects.js';
import { isPrivateSecurityTask } from '../privateSecurityPolicy.js';
import { isTruthyMeta } from '../metadataFlags.js';

/** Shared by live task transport and archived agent metadata/byte transport. */
export function isMachineLocalCosTask(task) {
  return isPrivateSecurityTask(task)
    || isTruthyMeta(task?.metadata?.machineLocal);
}

/** Apply the same rule to discovery and direct byte serving, including pre-flag archives. */
export async function isFederatableCosArchive(directory) {
  const metadata = safeJSONParse(await tryReadFile(join(directory, 'metadata.json')), null);
  if (!isPlainObject(metadata) || isMachineLocalCosTask(metadata)) return false;
  const prompt = await readFile(join(directory, 'prompt.txt'), 'utf8')
    .catch(error => error.code === 'ENOENT' ? '' : null);
  return prompt !== null && !hasStoredPrivacyFacts(prompt);
}
