/** Fresh forge facts for an operator's checkout-retirement review. No fetch,
 * policy write or saved grant: missing local objects require a separate fetch.
 */
import { createHash } from 'node:crypto';
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';

const oid = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
const safePath = value => typeof value === 'string' && value.length > 0 && !value.includes('\0') && !value.startsWith('/') && !value.split('/').some(part => part === '..' || part === '.');
const git = (args, cwd) => execGit(args, cwd, { maxBuffer: 4 * 1024 * 1024 }).then(r => r.stdout);

export async function readRetirementForgeEvidence(repoPath, branch, prUrl, { forgeAccount = null, exactAliasHead = null } = {}) {
  const origin = await getOriginInfo(repoPath);
  const parsed = parsePullRequestUrl(prUrl);
  if (!origin || !parsed || parsed.host !== origin.host || `${parsed.owner}/${parsed.repo}` !== origin.fullName) {
    throw new Error('retirement-pr-repository-mismatch');
  }
  const [{ execGh }, { resolveForgeExecOptions }] = await Promise.all([import('./github.js'), import('./forgeExecOptions.js')]);
  const options = await resolveForgeExecOptions(repoPath, { forgeAccount });
  const read = args => execGh(args, undefined, options).then(JSON.parse).catch(() => { throw new Error('retirement-forge-unavailable'); });
  const api = path => read(['api', '--hostname', origin.host, path]);
  const remote = await read(['pr', 'view', prUrl, '--json', 'url,state,headRefName,headRefOid,isCrossRepository,mergeCommit,baseRefName']);
  const repository = await api(`repos/${origin.fullName}`);
  const defaultBranch = repository.default_branch;
  // Explicit whole-checkout review may name a local repair alias, but only
  // when its exact tip is the merged PR head. Similar names are never evidence.
  const alias = remote.headRefName !== branch && oid(exactAliasHead) && exactAliasHead === remote.headRefOid;
  if (remote.url !== prUrl || remote.state !== 'MERGED' || (remote.headRefName !== branch && !alias)
    || remote.isCrossRepository !== false || remote.baseRefName !== defaultBranch || !oid(remote.headRefOid) || !oid(remote.mergeCommit?.oid)) {
    throw new Error('retirement-pr-not-matching-merged');
  }
  // A current-main merge base loses the original scope after a normal merge.
  // Use complete original PR metadata, and refuse API caps or ambiguous roots.
  const pullPath = `repos/${origin.fullName}/pulls/${parsed.number}`;
  const detail = await api(pullPath);
  if (detail.head?.sha !== remote.headRefOid || detail.base?.ref !== defaultBranch || detail.merged !== true
    || !Number.isInteger(detail.changed_files) || detail.changed_files < 1 || detail.changed_files > 3000
    || !Number.isInteger(detail.commits) || detail.commits < 1 || detail.commits > 250) {
    throw new Error('retirement-original-scope-unavailable');
  }
  const pages = async suffix => {
    const value = await read(['api', '--hostname', origin.host, '--paginate', '--slurp', `${pullPath}/${suffix}?per_page=100`]);
    if (!Array.isArray(value) || !value.every(Array.isArray)) throw new Error('retirement-original-scope-unavailable');
    return value.flat();
  };
  const files = await pages('files');
  const commits = await pages('commits');
  if (files.length !== detail.changed_files || commits.length !== detail.commits
    || new Set(files.map(file => file.filename)).size !== files.length
    || new Set(commits.map(commit => commit.sha)).size !== commits.length
    || !commits.every(commit => oid(commit.sha)) || commits.at(-1)?.sha !== remote.headRefOid
    || commits[0]?.parents?.length !== 1 || !oid(commits[0].parents[0].sha)
    || files.some(file => !safePath(file.filename) || (file.status === 'renamed' && !safePath(file.previous_filename)))) {
    throw new Error('retirement-original-scope-unavailable');
  }
  const changedPaths = [...new Set(files.flatMap(file => file.status === 'renamed' ? [file.filename, file.previous_filename] : [file.filename]))].sort();
  const changeBase = commits[0].parents[0].sha;
  const firstCommit = commits[0].sha;
  const target = await api(`repos/${origin.fullName}/git/ref/heads/${encodeURIComponent(defaultBranch)}`);
  if (!oid(target.object?.sha)) throw new Error('retirement-default-unreadable');
  // ls-remote returns an empty successful result only for actual ref absence.
  const remoteHead = (await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], repoPath)
    .catch(() => { throw new Error('retirement-remote-ref-unreadable'); })).trim();
  if (remoteHead && remoteHead !== `${remote.headRefOid}\trefs/heads/${branch}`) throw new Error('retirement-remote-head-changed');
  const publishedRemoteHead = alias ? (await git(['ls-remote', '--heads', 'origin', `refs/heads/${remote.headRefName}`], repoPath)
    .catch(() => { throw new Error('retirement-remote-ref-unreadable'); })).trim() : null;
  if (publishedRemoteHead && publishedRemoteHead !== `${remote.headRefOid}\trefs/heads/${remote.headRefName}`) throw new Error('retirement-remote-head-changed');
  return { repository: `${origin.host}/${origin.fullName}`, prUrl, prHead: remote.headRefOid,
    mergeCommit: remote.mergeCommit.oid, changedPaths, changeBase, firstCommit, defaultBranch, defaultHead: target.object.sha, remoteHead: remoteHead || null,
    ...(alias ? { exactAliasHead, publishedBranch: remote.headRefName, publishedRemoteHead: publishedRemoteHead || null } : {}) };
}

/** Returned differences are review material, not executable instructions or an
 * automated supersession verdict. Every byte and identity participates in digest.
 */
export async function buildCheckoutRetirementReview({ repoPath, release, prUrl, contentFingerprint, administrationFingerprint, policy }, {
  readForge = readRetirementForgeEvidence, forgeAccount = null,
} = {}) {
  const forge = await readForge(repoPath, release.branch, prUrl, { forgeAccount });
  if (!forge || !oid(forge.prHead) || !oid(forge.mergeCommit) || !oid(forge.defaultHead)) throw new Error('retirement-forge-unreadable');
  if (release.branch === forge.defaultBranch) throw new Error('protected-branch');
  if (!oid(forge.changeBase) || !oid(forge.firstCommit) || !Array.isArray(forge.changedPaths)
    || !forge.changedPaths.length || !forge.changedPaths.every(safePath)) throw new Error('retirement-original-scope-unavailable');
  // Independent reads run together (each Git spawn is mostly launch latency);
  // the verdicts keep their original precedence.
  await Promise.all([...new Set([forge.prHead, forge.mergeCommit, forge.defaultHead, forge.changeBase, forge.firstCommit])]
    .map(head => git(['cat-file', '-e', `${head}^{commit}`], repoPath).catch(() => { throw new Error('retirement-local-objects-missing'); })));
  const [inDefault, parents, inPr] = await Promise.allSettled([
    git(['merge-base', '--is-ancestor', forge.mergeCommit, forge.defaultHead], repoPath),
    git(['rev-list', '--parents', '-n', '1', forge.firstCommit], repoPath),
    git(['merge-base', '--is-ancestor', forge.firstCommit, forge.prHead], repoPath),
  ]);
  if (inDefault.status === 'rejected') throw new Error('retirement-merge-not-in-default');
  if (parents.status === 'rejected') throw parents.reason;
  const parent = parents.value.trim().split(/\s+/);
  if (parent.length !== 2 || parent[1] !== forge.changeBase) throw new Error('retirement-original-scope-unavailable');
  if (inPr.status === 'rejected') throw new Error('retirement-original-scope-unavailable');
  const base = (await git(['merge-base', release.head, forge.changeBase], repoPath)).trim();
  if (base === release.head) throw new Error('retirement-original-scope-unavailable');
  const [localPathsOut, localPatch] = await Promise.all([
    git(['diff', '--name-only', '-z', base, release.head], repoPath),
    git(['diff', '--binary', '--no-ext-diff', '--no-textconv', base, release.head], repoPath),
  ]);
  const localPaths = localPathsOut.split('\0').filter(Boolean);
  const paths = [...new Set([...forge.changedPaths, ...localPaths])].sort();
  const difference = paths.length ? await git(['--literal-pathspecs', 'diff', '--binary', '--no-ext-diff', '--no-textconv', release.head, forge.defaultHead, '--', ...paths], repoPath) : '';
  // Historical ancestry/cherry equivalence does not establish that current
  // code still implements the original work (it may have been strengthened or
  // reverted). Exact affected-file equality is the mechanical case; differences
  // require the operator's explicit supersession judgment on the displayed diff.
  const mechanicallyEquivalent = difference === '';
  const evidence = { repoPath, release, forge, contentFingerprint, administrationFingerprint, policy,
    comparison: { base, paths, localPatch, difference, disposition: mechanicallyEquivalent ? 'integrated' : 'review-supersession' } };
  return { digest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'), ...evidence };
}
