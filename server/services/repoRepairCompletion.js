import { createHash } from 'node:crypto';
import { lstat, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { PATHS } from '../lib/fileUtils.js';
import { PORTOS_APP_ID } from '../lib/appIdentity.js';
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { getInstanceId, UNKNOWN_INSTANCE_ID } from './instanceIdentity.js';
import { matchesCompletionTaskDispatch } from './agentCompletionTaskHandoff.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const contractSchema = z.object({
  version: z.literal(1), taskId: z.string().min(1), instanceId: z.string().min(1),
  repoPath: z.string().min(1), origin: z.string().min(1), head: sha,
  files: z.array(z.object({ path: z.string().min(1), blob: sha.nullable(), mode: z.string().nullable() })),
}).strict();
const git = async (dir, args) => (await execGit(args, dir, { timeout: 15000 })).stdout.trim();
const contains = async (dir, ancestor, head) => (await execGit(['merge-base', '--is-ancestor', ancestor, head], dir,
  { timeout: 15000, ignoreExitCode: true })).exitCode === 0;

/** Capture work before a repair can move it; unreadable input never becomes an empty baseline. */
export async function captureRepoRepairContract(verdict) {
  const dir = resolve(verdict.repoPath);
  if (dir !== resolve(PATHS.root)) throw new Error('Checkout repair must target this installation');
  const instanceId = await getInstanceId();
  if (!instanceId || instanceId === UNKNOWN_INSTANCE_ID) throw new Error('Checkout repair instance is unknown');
  const origin = await git(dir, ['remote', 'get-url', 'origin']);
  const head = await git(dir, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const paths = async args => (await execGit(args, dir)).stdout.split('\0').filter(Boolean);
  const [changed, untracked, staged] = await Promise.all([
    paths(['diff', '--name-only', '-z', 'HEAD']), paths(['ls-files', '--others', '--exclude-standard', '-z']),
    paths(['diff', '--cached', '--name-only', '-z', 'HEAD']),
  ]);
  const ignored = new Set(verdict.lockfilePaths || []);
  const files = [];
  for (const path of [...new Set([...changed, ...untracked])].filter(path => !ignored.has(path))) {
    const info = await lstat(join(dir, path)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && !info.isFile() && !info.isSymbolicLink()) throw new Error('Repair baseline contains unsupported local work');
    const link = info?.isSymbolicLink() ? Buffer.from(await readlink(join(dir, path))) : null;
    const blob = !info ? null : link ? createHash('sha1').update(`blob ${link.length}\0`).update(link).digest('hex')
      : await git(dir, ['hash-object', `--path=${path}`, '--', path]);
    files.push({ path, blob, mode: info ? info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644' : null });
  }
  // Preserve a separately staged version too, rather than silently losing it to an unstaged edit.
  for (const path of staged.filter(path => !ignored.has(path))) {
    const row = await git(dir, ['ls-files', '--stage', '--', path]);
    if (!row) files.push({ path, blob: null, mode: null });
    else for (const entry of row.split('\n')) {
      if (!/^\d+ [a-f0-9]{40} [0-3]\t/.test(entry)) throw new Error('Repair index evidence is unreadable');
      const [mode, blob] = entry.split(' ');
      files.push({ path, blob, mode });
    }
  }
  return contractSchema.parse({ version: 1, taskId: 'pending', instanceId, repoPath: dir, origin, head, files });
}

async function preservesFiles(dir, head, files) {
  for (const file of files) {
    const row = await git(dir, ['ls-tree', head, '--', file.path]);
    if (file.blob === null) { if (row !== '') return false; }
    else if (!row.startsWith(`${file.mode} blob ${file.blob}\t`)) {
      // Separately staged content/modes may live in an earlier preservation tree.
      const history = await git(dir, ['rev-list', '--full-history', head, '--', file.path]);
      let preserved = false;
      for (const commit of history.split('\n').filter(Boolean)) {
        const prior = await git(dir, ['ls-tree', commit, '--', file.path]);
        if (prior.startsWith(`${file.mode} blob ${file.blob}\t`)) { preserved = true; break; }
      }
      if (!preserved) return false;
    }
  }
  return true;
}

/** A remote ref alone is not publication: require the same-repository PR's exact structured head. */
async function preservedWork(contract, defaultBranch) {
  const dir = contract.repoPath;
  const remote = await git(dir, ['rev-parse', '--verify', `refs/remotes/origin/${defaultBranch}^{commit}`]);
  const headIntegrated = await contains(dir, contract.head, remote);
  if (headIntegrated && await preservesFiles(dir, remote, contract.files)) return true;
  const origin = await getOriginInfo(dir);
  if (!origin.isGithub) return false;
  const refs = (await git(dir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/remotes/origin/'])).split('\n');
  const { execGh } = await import('./github.js');
  for (const row of refs) {
    const [head, ref] = row.split(' ');
    const branch = ref?.slice('refs/remotes/origin/'.length);
    if (!sha.safeParse(head).success || !branch || ['HEAD', defaultBranch].includes(branch)
      || !await contains(dir, contract.head, head) || !await preservesFiles(dir, head, contract.files)) continue;
    const endpoint = `repos/${origin.fullName}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${origin.owner}:${branch}`)}`;
    const pages = JSON.parse(await execGh(['api', '--hostname', origin.host, '--paginate', '--slurp', endpoint,
      '--jq', 'map(map({state, merged_at, headSha: .head.sha, headRepo: .head.repo.full_name, base: .base.ref}))'], 15000, { cwd: dir }));
    if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('Preservation PR evidence is unreadable');
    if (pages.flat().some(pr => pr.headSha === head && pr.headRepo?.toLowerCase() === origin.fullName.toLowerCase()
      && pr.base === defaultBranch && (pr.state === 'open' || pr.merged_at))) return true;
  }
  return false;
}

/** Read-only completion proof; never runs the update or changes dispatch/retry accounting. */
export async function verifyRepoRepairCompletion(task, agentId, workspacePath) {
  const { getAgentRecord } = await import('./cosAgentLifecycle.js');
  const { getTaskById } = await import('./cosTaskStore.js');
  const { checkUpdateRepoReadiness } = await import('./updateRepoReadiness.js');
  const { fetchOrigin } = await import('./git.js');
  const contract = contractSchema.parse(task?.metadata?.repoRepairContract);
  const [owner, live, instanceId] = await Promise.all([getAgentRecord(agentId).then(structuredClone), getTaskById(task.id).then(structuredClone), getInstanceId()]);
  const binding = owner?.metadata?.completionTaskDispatch;
  if (contract.taskId !== task.id || task.taskType !== 'internal' || task.metadata?.app !== PORTOS_APP_ID
    || contract.instanceId !== instanceId || instanceId === UNKNOWN_INSTANCE_ID
    || contract.repoPath !== resolve(PATHS.root) || resolve(workspacePath || '') !== contract.repoPath
    || owner?.id !== agentId || owner.status !== 'running' || owner.metadata?.instanceId !== instanceId
    || resolve(owner.metadata?.workspacePath || '') !== contract.repoPath || owner.metadata?.isWorktree
    || live?.status !== 'in_progress' || !matchesCompletionTaskDispatch(owner, task) || !matchesCompletionTaskDispatch(owner, live)
    || !isDeepStrictEqual(live.metadata.repoRepairContract, contract) || !isDeepStrictEqual(binding.repoRepairContract, contract)
    || await git(contract.repoPath, ['remote', 'get-url', 'origin']) !== contract.origin) return false;
  // Completion requires a fresh origin read. The normal UI readiness poll may use cached refs.
  await fetchOrigin(contract.repoPath);
  const ready = await checkUpdateRepoReadiness({ repoPath: contract.repoPath, finishingRepairAgentId: agentId });
  if (!ready.ready || !ready.defaultBranch || ready.branch !== ready.defaultBranch || ready.ahead !== 0
    || ready.interrupted !== null || !Number.isFinite(ready.behind)
    || !await preservedWork(contract, ready.defaultBranch)) return false;
  // Forge/Git reads await I/O: do not lend this proof to a replacement dispatch.
  const after = await checkUpdateRepoReadiness({ repoPath: contract.repoPath, finishingRepairAgentId: agentId });
  return isDeepStrictEqual(after, ready) && isDeepStrictEqual(await getTaskById(task.id), live)
    && isDeepStrictEqual(await getAgentRecord(agentId), owner);
}
