// Git half of the `inputs-unchanged` scheduler gate (#12907): HEAD capture for a
// clean-run baseline and the "did any declared input change since it" question.
import { execGit } from '../lib/execGit.js';

const SHA_RE = /^[0-9a-f]{40}$/;

export async function readHead(repoPath, git = execGit) {
  const head = await git(['rev-parse', 'HEAD'], repoPath).then(r => r.stdout.trim(), () => '');
  return SHA_RE.test(head) ? head : null;
}

/**
 * True only on positive proof that no input changed. Any doubt (no baseline, no
 * repo, an unknown commit after a force-push, a git failure) answers false so
 * the audit runs.
 */
export async function inputsUnchangedSince({ repoPath, lastCleanHead, inputPaths, git = execGit }) {
  if (!repoPath || !SHA_RE.test(lastCleanHead || '') || !inputPaths?.length) return false;
  const changed = await git(['diff', '--name-only', lastCleanHead, 'HEAD', '--', ...inputPaths], repoPath)
    .then(r => r.stdout.trim(), () => null);
  return changed === '';
}
