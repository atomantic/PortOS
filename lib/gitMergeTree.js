/** Read-only capability checks shared by setup, merge guards and retirement. */
import { spawnSync } from 'node:child_process';

export const GIT_MERGE_TREE_REMEDY = 'Install Git 2.40 or newer (including current Git for Windows), ensure it is first on PATH for the running process, then rerun node scripts/checkGitVersion.js. Required: git merge-tree --write-tree and --merge-base.';

/** Git short help normally exits 129; only advertised options prove support. */
export function mergeTreeCapability(result) {
  const status = result.status ?? result.exitCode;
  if (result.error || result.signal || ![0, 129].includes(status)) {
    return { ok: false, reason: 'git-capability-probe-failed', detail: `Git capability probe could not run. ${GIT_MERGE_TREE_REMEDY}` };
  }
  const help = `${result.stdout || ''}\n${result.stderr || ''}`;
  const supported = /--write-tree\b/.test(help) && /--(?:\[no-\])?merge-base\b/.test(help);
  return supported ? { ok: true } : { ok: false, reason: 'git-merge-tree-unsupported', detail: `Git lacks required merge-tree capabilities. ${GIT_MERGE_TREE_REMEDY}` };
}

export function probeGitMergeTree(cwd, run = spawnSync) {
  return mergeTreeCapability(run('git', ['merge-tree', '-h'], {
    cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true,
  }));
}

export function assertGitMergeTree(cwd) {
  const result = probeGitMergeTree(cwd);
  if (!result.ok) throw new Error(result.detail);
}
