/** Read-only synchronization verifier. The outbox owns obligations, never a
 * merger, task retry budget, checkout, or authority to retire another owner.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getOriginInfo } from '../lib/gitRemote.js';
import { compareSemver } from '../lib/versionUtils.js';
import { RELEASE_SYNC_FROZEN_METADATA_KEYS, RELEASE_SYNC_OBLIGATIONS, inlineSynchronizationBranch, isInlineReleaseSynchronization } from '../lib/releaseSynchronization.js';
import { execGh } from './github.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';
import { getTaskById } from './cosTaskStore.js';
import { getAppById } from './apps.js';

const sha = value => /^[a-f0-9]{40}$/.test(value || '');
const time = value => Number.isFinite(Date.parse(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hold = reason => { throw Object.assign(new Error(reason), { code: reason }); };
const wait = reason => { throw Object.assign(new Error(reason), { code: reason, pending: true }); };
const ownersOf = (entry, agents) => agents.filter(agent => agent.taskId === entry.task.id);
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const validVersion = value => typeof value === 'string' && versionPattern.test(value)
  && value.split(/[.+-]/, 3).every(part => Number.isSafeInteger(Number(part)));

async function developmentVersionEvidence(ctx, publication) {
  if (!validVersion(publication.version) || !sha(publication.tagTree)) hold('published-version-unverified');
  const readJson = async (path, reason) => {
    const file = await ctx.api(`contents/${path}?ref=${ctx.target.developmentHead}`).catch(() => hold(reason));
    if (file?.encoding !== 'base64' || !sha(file.sha) || typeof file.content !== 'string') hold(reason);
    try { return { value: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')), blob: file.sha }; }
    catch { hold(reason); }
  };
  const manifest = await readJson('package.json', 'development-version-unreadable');
  const current = manifest.value?.version;
  if (!validVersion(current)) hold('development-version-unreadable');
  if (compareSemver(current, publication.version) < 0) hold('development-version-behind-publication');
  // The publication's immutable tree decides whether this project owns an
  // npm lockfile. A missing or inconsistent delivered lock cannot be hidden
  // by a correct package.json; a project without one keeps its old contract.
  const tree = await ctx.api(`git/trees/${publication.tagTree}`).catch(() => hold('published-version-tree-unreadable'));
  if (!Array.isArray(tree?.tree) || tree.truncated !== false) hold('published-version-tree-unreadable');
  const locks = tree.tree.filter(row => row.path === 'package-lock.json');
  if (locks.length > 1 || (locks.length === 1 && (locks[0].type !== 'blob' || !sha(locks[0].sha)))) hold('published-version-tree-unreadable');
  let lockBlob = null;
  if (locks.length) {
    const lock = await readJson('package-lock.json', 'development-lockfile-unreadable');
    if (!lock.value || typeof lock.value !== 'object' || Array.isArray(lock.value) || lock.value.version !== current
      || (Object.hasOwn(lock.value, 'packages') && lock.value.packages?.['']?.version !== current)) {
      hold('development-lockfile-version-conflict');
    }
    lockBlob = lock.blob;
  }
  return { publishedVersion: publication.version, developmentVersion: current, manifestBlob: manifest.blob, lockBlob };
}

async function readSynchronizationForge(origin, forgeExec, path, paginate = false, timeoutMs = undefined) {
  const args = ['api', '--hostname', origin.host, ...(paginate ? ['--paginate', '--slurp'] : []),
    `repos/${origin.fullName}${path ? `/${path}` : ''}`];
  return JSON.parse(await execGh(args, timeoutMs, forgeExec));
}

/** Verify delivery without requiring the original checkout or rewriting its run verdict. */
export async function inspectReleaseDelivery(entry, number) {
  if (!Number.isSafeInteger(number) || number < 1) hold('delivery-pr-unverified');
  const app = await getAppById(entry.task.metadata.app);
  const cwd = app?.repoPath;
  if (!cwd) hold('synchronization-repository-unavailable');
  const origin = await getOriginInfo(cwd);
  if (origin.host !== 'github.com' || origin.fullName !== entry.publication.repository) hold('synchronization-repository-changed');
  const forgeExec = await resolveForgeExecOptions(cwd, { forgeAccount: app.forgeAccount });
  const api = path => readSynchronizationForge(origin, forgeExec, path, false, 10_000);
  const repository = await api('');
  if (repository.full_name !== origin.fullName || typeof repository.default_branch !== 'string') hold('synchronization-default-unreadable');
  const [development, pr] = await Promise.all([api(`git/ref/heads/${encodeURIComponent(repository.default_branch)}`), api(`pulls/${number}`)]);
  const developmentHead = development.object?.sha;
  if (development.object?.type !== 'commit' || !sha(developmentHead)) hold('synchronization-default-unreadable');
  if (pr.number !== number || pr.merged !== true || !time(pr.merged_at) || !sha(pr.merge_commit_sha)
    || pr.base?.ref !== repository.default_branch || pr.base?.repo?.full_name !== origin.fullName
    || pr.head?.repo?.full_name !== origin.fullName || !sha(pr.head?.sha)) hold('delivery-pr-unverified');
  const { candidateHead, promotionMerge } = entry.publication;
  if (!sha(candidateHead) || !sha(promotionMerge)) hold('published-ancestry-unverified');
  const pairs = [[candidateHead, pr.head.sha], [promotionMerge, pr.head.sha], [pr.head.sha, developmentHead],
    [pr.merge_commit_sha, developmentHead], [candidateHead, developmentHead], [promotionMerge, developmentHead]];
  const comparisons = await Promise.all(pairs.map(([base, head]) => api(`compare/${base}...${head}`)));
  if (comparisons.some((value, index) => !['ahead', 'identical'].includes(value.status)
    || value.merge_base_commit?.sha !== pairs[index][0])) hold('delivery-ancestry-unverified');
  const version = await developmentVersionEvidence({ api, target: { developmentHead } }, entry.publication);
  const latest = await api(`git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
  if (latest.object?.type !== 'commit' || latest.object.sha !== developmentHead) hold('delivery-development-head-changed');
  return { status: 'verified', number, prUrl: `https://github.com/${origin.fullName}/pull/${number}`,
    headSha: pr.head.sha, mergeSha: pr.merge_commit_sha, base: repository.default_branch,
    developmentHead, ...version, checkedAt: new Date().toISOString() };
}

/** Branches the continuation's runs delivered from. The release candidate
 * branch targets `release`, never the back-merge. */
function synchronizationBranches(entry, owners) {
  const branches = new Set(isInlineReleaseSynchronization(entry) ? [inlineSynchronizationBranch(entry.identity)] : []);
  for (const agent of owners) {
    for (const seed of agent.metadata?.checkoutSeeds || []) if (seed?.branch) branches.add(seed.branch);
    for (const branch of [agent.metadata?.worktreeBranch, agent.metadata?.releaseSynchronizationCheckout?.branch]) if (branch) branches.add(branch);
  }
  branches.delete(entry.publication.candidateBranch);
  return branches;
}

async function context(entry, agents) {
  const owners = ownersOf(entry, agents);
  if (owners.filter(agent => agent.status !== 'completed').length > 1) hold('continuation-conflicting-live-owners');
  const task = await getTaskById(entry.task.id);
  const expected = { ...entry.task.metadata, idempotencyKey: digest([entry.identity, entry.owner]) };
  if (isInlineReleaseSynchronization(entry)) {
    if (!task || task.id !== entry.owner.taskId || (task.taskType || 'internal') !== entry.task.taskType
      || task.metadata?.app !== entry.task.metadata.app) hold('release-owner-conflict');
  } else if (!task || task.taskType !== 'internal'
    || RELEASE_SYNC_FROZEN_METADATA_KEYS.some(key => !isDeepStrictEqual(task.metadata?.[key], expected[key]))) hold('continuation-owner-conflict');
  const app = await getAppById(task.metadata.app);
  const cwd = app?.repoPath;
  if (!cwd) hold('synchronization-repository-unavailable');
  const origin = await getOriginInfo(cwd);
  if (origin.host !== 'github.com' || origin.fullName !== entry.publication.repository) hold('synchronization-repository-changed');
  const forgeExec = await resolveForgeExecOptions(cwd, { forgeAccount: app.forgeAccount });
  const api = path => readSynchronizationForge(origin, forgeExec, path);
  const repository = await api('');
  if (repository.full_name !== origin.fullName || typeof repository.default_branch !== 'string') hold('synchronization-default-unreadable');
  const development = await api(`git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
  if (development.object?.type !== 'commit' || !sha(development.object.sha)) hold('synchronization-default-unreadable');
  const intoDevelopment = pr => pr?.base?.ref === repository.default_branch && pr.base?.repo?.full_name === origin.fullName
    && pr.head?.repo?.full_name === origin.fullName && sha(pr.head?.sha);
  let number = entry.obligations.synchronizationPr?.evidence?.number;
  if (!number) {
    const branches = synchronizationBranches(entry, owners);
    if (!branches.size) hold('continuation-checkout-unverified');
    const matches = [];
    for (const branch of branches) {
      const result = await readSynchronizationForge(origin, forgeExec,
        `pulls?state=all&head=${encodeURIComponent(`${repository.owner.login}:${branch}`)}&per_page=100`, true);
      if (!Array.isArray(result) || result.some(page => !Array.isArray(page))) hold('synchronization-forge-unreadable');
      matches.push(...result.flat().filter(pr => pr?.head?.ref === branch && intoDevelopment(pr)));
    }
    // A closed attempt beside its replacement is not a conflict; a merged PR wins.
    const merged = matches.filter(pr => pr.merged_at);
    const open = matches.filter(pr => pr.state === 'open');
    const chosen = merged.length ? merged : open;
    if (chosen.length !== 1) hold(chosen.length ? 'synchronization-pr-conflict' : 'synchronization-pr-pending');
    number = chosen[0].number;
  }
  if (!Number.isSafeInteger(number) || number < 1) hold('synchronization-pr-unverified');
  const pr = await api(`pulls/${number}`);
  if (pr.number !== number || !intoDevelopment(pr)) hold('synchronization-pr-identity-changed');
  const target = { number, prUrl: `https://github.com/${origin.fullName}/pull/${number}`, headSha: pr.head.sha,
    branch: pr.head.ref, base: repository.default_branch, developmentHead: development.object.sha, mergeSha: pr.merge_commit_sha };
  const ancestor = async (base, head) => {
    if (!sha(base) || !sha(head)) return false;
    const comparison = await api(`compare/${base}...${head}`);
    return ['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === base;
  };
  return { api, pr, target, ancestor };
}

/** Every accepted result has inspected source evidence and a revision binding.
 * A transport error retains prior successful proof for the SAME PR head and
 * development head only.
 */
export async function inspectReleaseSynchronization(entry, agents) {
  const prior = entry.obligations;
  const obligations = Object.fromEntries(RELEASE_SYNC_OBLIGATIONS.map(key => [key, structuredClone(prior[key] || { status: 'pending' })]));
  let ctx;
  try { ctx = await context(entry, agents); }
  catch (error) {
    const blocker = error.code || 'synchronization-evidence-unavailable';
    return { status: blocker === 'synchronization-pr-pending' && ownersOf(entry, agents).some(agent => agent.status === 'running') ? 'running' : 'blocked', blocker, obligations };
  }
  const { pr, target } = ctx;
  const saved = prior.synchronizationPr?.evidence;
  if (saved?.prUrl !== target.prUrl || saved?.headSha !== target.headSha || saved?.developmentHead !== target.developmentHead) {
    for (const key of RELEASE_SYNC_OBLIGATIONS) obligations[key] = { status: 'pending' };
  }
  const binding = { prUrl: target.prUrl, headSha: target.headSha };
  const check = async (name, inspect) => {
    try {
      const evidence = await inspect();
      obligations[name] = { status: 'verified', verifiedAt: obligations[name].verifiedAt || new Date().toISOString(), evidence: { ...binding, ...evidence } };
    } catch (error) {
      // A negative observation revokes proof; an unreadable source retains the
      // original proof without inventing a fresh inspection timestamp. The
      // binding names the PR the status views are waiting on.
      if (!error.code && obligations[name].status === 'verified') return;
      obligations[name] = { status: error.pending ? 'pending' : 'blocked', blocker: error.code || 'evidence-unavailable', evidence: binding };
    }
  };
  // The provider's merge already applied the repository's review/CI rules.
  await check('synchronizationPr', async () => {
    if (pr.merged !== true) wait('synchronization-pr-not-merged');
    if (!time(pr.merged_at) || !sha(pr.merge_commit_sha)) hold('synchronization-merge-unreadable');
    if (!await ctx.ancestor(pr.merge_commit_sha, target.developmentHead)) hold('synchronization-merge-not-on-development');
    return { ...target, mergedAt: pr.merged_at };
  });
  await check('releaseAncestry', async () => {
    if (pr.merged !== true) wait('release-ancestry-awaits-sync');
    if (!await ctx.ancestor(entry.publication.candidateHead, target.developmentHead)) hold('candidate-head-not-on-development');
    if (!await ctx.ancestor(entry.publication.promotionMerge, target.developmentHead)) hold('published-ancestry-not-on-development');
    const version = isInlineReleaseSynchronization(entry) ? await developmentVersionEvidence(ctx, entry.publication) : {};
    return { candidateHead: entry.publication.candidateHead, promotionMerge: entry.publication.promotionMerge,
      developmentHead: target.developmentHead, ...version };
  });
  const verified = RELEASE_SYNC_OBLIGATIONS.every(key => obligations[key]?.status === 'verified');
  const blocked = RELEASE_SYNC_OBLIGATIONS.find(key => obligations[key]?.status === 'blocked');
  return { obligations, status: verified ? 'verified' : blocked ? 'blocked' : 'running',
    blocker: blocked ? `${blocked}:${obligations[blocked].blocker}` : null };
}
