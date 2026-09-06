import { basename, join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { pathExists, safeJSONParse } from '../lib/fileUtils.js';
import { getOriginInfo, parseGitRemoteUrl, readRemoteUrl } from '../lib/gitRemote.js';
import { githubApiHost, hostToWorkTracker, isGithubHost } from '../lib/workTracker.js';
import { execGitSafe, fetchOrigin, isFetchFresh, resolveForgeForRepo } from './git.js';
import { execGh } from './github.js';

const GH_TIMEOUT_MS = 60_000;

const comparisonState = (ahead, behind) => {
  if (ahead > 0 && behind > 0) return 'diverged';
  if (behind > 0) return 'behind';
  if (ahead > 0) return 'ahead';
  return 'current';
};

function parseRevisionCounts(result) {
  if (result?.exitCode !== 0) return null;
  const [aheadText, behindText] = result.stdout.trim().split(/\s+/);
  const ahead = Number.parseInt(aheadText, 10);
  const behind = Number.parseInt(behindText, 10);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return null;
  return { ahead, behind, state: comparisonState(ahead, behind) };
}

const repositoryIdentity = (fullName, host = 'github.com') => {
  if (typeof fullName !== 'string' || !fullName.trim()) return null;
  const parts = fullName.trim().split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) return null;
  return {
    host: githubApiHost(host),
    owner: parts[0],
    repo: parts[1],
    fullName: `${parts[0]}/${parts[1]}`,
  };
};

function remoteIdentity(url) {
  const parsed = parseGitRemoteUrl(url);
  if (!parsed) return null;
  return {
    host: githubApiHost(parsed.host),
    owner: parsed.owner,
    repo: parsed.repo,
    fullName: `${parsed.owner}/${parsed.repo}`,
  };
}

async function githubRepositoryMetadata(repoPath, origin) {
  if (!origin?.fullName || !isGithubHost(origin.host)) return null;
  const forge = await resolveForgeForRepo(repoPath).catch(() => null);
  const host = githubApiHost(origin.host);
  const raw = await execGh([
    'api', ...(host === 'github.com' ? [] : ['--hostname', host]),
    `repos/${origin.fullName}`, '--jq',
    '{fullName: .full_name, defaultBranch: .default_branch, isFork: .fork, '
      + 'canPush: .permissions.push, '
      + 'parentFullName: .parent.full_name, parentDefaultBranch: .parent.default_branch, '
      + 'sourceFullName: .source.full_name, sourceDefaultBranch: .source.default_branch}',
  ], GH_TIMEOUT_MS, {
    cwd: repoPath,
    env: forge?.env || process.env,
  }).catch(() => null);
  const parsed = safeJSONParse(raw, null);
  return parsed && typeof parsed.fullName === 'string' ? parsed : null;
}

/**
 * Resolve one checkout's origin → canonical-upstream topology. GitHub's own
 * fork metadata is authoritative, so renamed forks work too. An explicit
 * `upstream` remote is the offline/cross-forge fallback; otherwise a repository
 * that GitHub confirms is not a fork is its own canonical source.
 */
export async function resolveRepositoryTopology(repoPath) {
  const origin = await getOriginInfo(repoPath);
  if (!origin.hasOrigin) {
    return {
      origin: { ...origin, canPush: null },
      upstream: null,
      isFork: false,
      available: false,
      error: 'No origin remote configured',
    };
  }

  const [metadata, upstreamUrl] = await Promise.all([
    githubRepositoryMetadata(repoPath, origin),
    readRemoteUrl('upstream', repoPath).catch(() => null),
  ]);

  const apiUpstream = repositoryIdentity(
    metadata?.sourceFullName || metadata?.parentFullName,
    origin.host,
  );
  const explicitUpstream = remoteIdentity(upstreamUrl);
  const upstream = metadata
    ? apiUpstream || repositoryIdentity(origin.fullName, origin.host)
    : explicitUpstream;
  const isFork = Boolean(upstream && origin.fullName
    && upstream.fullName.toLowerCase() !== origin.fullName.toLowerCase());
  const defaultBranch = apiUpstream
    ? (metadata.sourceDefaultBranch || metadata.parentDefaultBranch || metadata.defaultBranch || 'main')
    : metadata?.defaultBranch || null;

  // `canPush` is tri-state on purpose: `false` only when the forge answered and
  // said no, `null` when nothing answered. A fork PortOS cannot push to cannot
  // be fast-forwarded, and an unknown answer must not silently retract a sync
  // PortOS has always offered.
  return {
    origin: {
      ...origin,
      isFork,
      isUpstream: upstream ? !isFork : null,
      canPush: typeof metadata?.canPush === 'boolean' ? metadata.canPush : null,
    },
    upstream: upstream ? { ...upstream, branch: defaultBranch } : null,
    isFork,
    available: Boolean(upstream),
    error: upstream ? null : 'Could not determine the canonical upstream repository',
  };
}

async function compareForkWithUpstream(checkout, repoPath) {
  if (!checkout?.origin?.isFork || !checkout.origin.fullName || !checkout.upstream?.fullName) return null;
  if (!isGithubHost(checkout.origin.host) || checkout.origin.host !== checkout.upstream.host) return null;
  const branch = checkout.upstream.branch || checkout.branch || 'main';
  const upstreamOwner = checkout.upstream.owner;
  const originOwner = checkout.origin.owner;
  const basehead = encodeURIComponent(`${upstreamOwner}:${branch}...${originOwner}:${branch}`);
  const forge = await resolveForgeForRepo(repoPath).catch(() => null);
  const host = githubApiHost(checkout.origin.host);
  const raw = await execGh([
    'api', ...(host === 'github.com' ? [] : ['--hostname', host]),
    `repos/${checkout.upstream.fullName}/compare/${basehead}`, '--jq',
    '{status: .status, ahead: .ahead_by, behind: .behind_by}',
  ], GH_TIMEOUT_MS, {
    cwd: repoPath,
    env: { ...(forge?.env || process.env), GH_HOST: host },
  }).catch(() => null);
  const parsed = safeJSONParse(raw, null);
  if (!parsed || !Number.isInteger(parsed.ahead) || !Number.isInteger(parsed.behind)) {
    return { available: false, ahead: null, behind: null, state: 'unknown', error: 'Could not compare the fork with canonical upstream' };
  }
  return {
    available: true,
    ahead: parsed.ahead,
    behind: parsed.behind,
    state: comparisonState(parsed.ahead, parsed.behind),
    error: null,
  };
}

async function inspectCheckout({ id, label, repoPath }) {
  const present = typeof repoPath === 'string' && repoPath.trim().length > 0
    && await pathExists(join(repoPath, '.git'));
  if (!present) {
    return {
      id, label, present: false, branch: null, head: null, shortHead: null, clean: null,
      origin: null, upstream: null, localVsOrigin: null, forkVsUpstream: null,
      remoteFresh: false, remoteError: 'Checkout not found',
    };
  }

  const [branchResult, headResult, worktreeResult, topology] = await Promise.all([
    execGitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath, { ignoreExitCode: true }),
    execGitSafe(['rev-parse', 'HEAD'], repoPath, { ignoreExitCode: true }),
    execGitSafe(['status', '--porcelain'], repoPath, { ignoreExitCode: true }),
    resolveRepositoryTopology(repoPath),
  ]);
  const branchName = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
  const branch = branchName && branchName !== 'HEAD' ? branchName : null;
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const clean = worktreeResult.exitCode === 0 ? worktreeResult.stdout.trim().length === 0 : null;
  // Skip the network hop when this checkout's remote refs were already
  // refreshed inside the freshness window — the refs really are current, so
  // `fresh: true` stays truthful. This read used to be reachable only from the
  // app's Git tab; the Eidoverse page now runs it on every visit, where an
  // ungated fetch would cost two `git fetch`es per mount (twice that under
  // React StrictMode) for an answer that cannot have changed.
  const fetchResult = !topology.origin.hasOrigin
    ? { fresh: false, error: topology.error }
    : isFetchFresh(repoPath)
      ? { fresh: true, error: topology.error }
      : await fetchOrigin(repoPath).then(
        () => ({ fresh: true, error: topology.error }),
        () => ({ fresh: false, error: 'Could not refresh the origin repository' }),
      );

  const originRef = branch ? `refs/remotes/origin/${branch}` : null;
  const [originHeadResult, countsResult] = originRef
    ? await Promise.all([
      execGitSafe(['rev-parse', '--verify', originRef], repoPath, { ignoreExitCode: true }),
      execGitSafe(['rev-list', '--left-right', '--count', `HEAD...${originRef}`], repoPath, { ignoreExitCode: true }),
    ])
    : [null, null];
  const originHead = originHeadResult?.exitCode === 0 ? originHeadResult.stdout.trim() : null;
  const checkout = {
    id,
    label,
    present: true,
    branch,
    head,
    shortHead: head?.slice(0, 7) || null,
    clean,
    origin: {
      ...topology.origin,
      url: topology.origin.originUrl,
      head: originHead,
      shortHead: originHead?.slice(0, 7) || null,
    },
    upstream: topology.upstream
      ? {
        fullName: topology.upstream.fullName,
        owner: topology.upstream.owner,
        branch: topology.upstream.branch,
        host: topology.upstream.host,
      }
      : null,
    localVsOrigin: countsResult ? parseRevisionCounts(countsResult) : null,
    remoteFresh: fetchResult.fresh,
    remoteError: fetchResult.error,
  };
  return { ...checkout, forkVsUpstream: await compareForkWithUpstream(checkout, repoPath) };
}

/**
 * Can a managed update fast-forward THIS checkout's origin fork from canonical
 * upstream? Only when all three hold:
 *
 * - it is the primary checkout — `syncManagedAppFork` only ever touches
 *   `app.repoPath`, so a companion's fork has no sync path at all;
 * - the credential can push to that fork — cloning someone else's fork of a
 *   third project is normal (Eidoverse's video checkout is `anima-research`'s
 *   fork), and PortOS can never move a repository it can only read;
 * - the fork has not diverged — a diverged fork cannot be fast-forwarded.
 *
 * This is what separates "behind, and one click fixes it" from "behind, and
 * nothing PortOS can do will change that" — an out-of-date advisory raised for
 * the latter is unactionable and never clears (#6321).
 */
const isForkSyncable = (source) => source.id === 'primary'
  && Boolean(source.origin?.isFork)
  && source.origin?.canPush !== false
  && source.forkVsUpstream?.state !== 'diverged';

function sourceDescriptors(app) {
  const companions = Array.isArray(app?.companionRepoPaths)
    ? [...new Set(app.companionRepoPaths)].filter((path) => path && path !== app.repoPath)
    : [];
  return [
    { id: 'primary', label: app.name || 'Application', repoPath: app.repoPath },
    ...companions.map((repoPath, index) => ({
      id: `companion-${index + 1}`,
      label: basename(repoPath) || `Companion repository ${index + 1}`,
      repoPath,
    })),
  ];
}

function publicTarget(repository, role) {
  if (!repository?.fullName) return null;
  const host = repository.host || 'github.com';
  const forge = hostToWorkTracker(host);
  return {
    role,
    forge,
    fullName: repository.fullName,
    repoSpec: isGithubHost(host) ? `${githubApiHost(host)}/${repository.fullName}` : null,
  };
}

export async function getManagedAppRepositorySources(app) {
  const descriptors = sourceDescriptors(app);
  const inspected = await Promise.all(descriptors.map(inspectCheckout));
  const sources = inspected.map((source) => ({ ...source, forkSyncable: isForkSyncable(source) }));
  const primary = sources[0] || null;
  const originTarget = publicTarget(primary?.origin, 'origin');
  const upstreamTarget = publicTarget(primary?.upstream, 'upstream');
  const canChoose = Boolean(primary?.origin?.isFork && originTarget && upstreamTarget);
  return {
    kind: 'managed-app',
    checkedAt: new Date().toISOString(),
    // Only what a managed update can actually pull forward: any checkout behind
    // its own origin, plus a fork behind upstream that PortOS is allowed to
    // fast-forward. A fork PortOS can only read stays visible on the Git tab
    // but never claims an update is available.
    updateAvailable: sources.some((source) => source.localVsOrigin?.behind > 0
      || (source.forkSyncable && (source.forkVsUpstream?.behind || 0) > 0)),
    updatePullsAll: true,
    updateRestartsApp: Array.isArray(app?.pm2ProcessNames) && app.pm2ProcessNames.length > 0,
    issueTargets: {
      default: canChoose || primary?.origin?.isUpstream == null ? 'upstream' : 'origin',
      canChoose,
      origin: originTarget,
      upstream: upstreamTarget,
    },
    sources,
  };
}

export async function resolveManagedAppIssueTarget(app, preference = 'upstream') {
  const topology = await resolveRepositoryTopology(app.repoPath);
  const origin = publicTarget(topology.origin, 'origin');
  if (preference === 'origin') return origin;
  if (!topology.available) return null;
  const upstream = publicTarget(topology.upstream, 'upstream');
  if (!topology.isFork || !upstream) return origin;
  return upstream;
}

/** Fast-forward the primary checkout's GitHub fork without touching local files. */
export async function syncManagedAppFork(app) {
  const topology = await resolveRepositoryTopology(app.repoPath);
  const { origin, upstream } = topology;
  if (!origin?.hasOrigin) {
    throw new ServerError('The app checkout has no Git origin.', { status: 400, code: 'NO_ORIGIN' });
  }
  if (!isGithubHost(origin.host)) {
    throw new ServerError('Fork sync is available only for GitHub origins.', { status: 400, code: 'NOT_GITHUB' });
  }
  if (!topology.available) {
    throw new ServerError('Could not determine the canonical upstream repository.', { status: 502, code: 'UPSTREAM_UNAVAILABLE' });
  }
  if (!topology.isFork) {
    throw new ServerError(`The origin is already the canonical ${origin.fullName} repository.`, { status: 400, code: 'ALREADY_UPSTREAM' });
  }
  if (origin.canPush === false) {
    throw new ServerError(
      `The ${origin.fullName} fork belongs to someone else — PortOS can read it but cannot push to it, `
      + `so it cannot be fast-forwarded from ${upstream.fullName}. Ask its owner to sync it, or point this app at a fork you control.`,
      { status: 403, code: 'FORK_NOT_WRITABLE' },
    );
  }
  const branch = upstream.branch || null;
  const forge = await resolveForgeForRepo(app.repoPath).catch(() => null);
  const args = ['repo', 'sync', origin.fullName, '--source', upstream.fullName];
  if (branch) args.push('--branch', branch);
  const output = await execGh(args, GH_TIMEOUT_MS, {
    cwd: app.repoPath,
    env: { ...(forge?.env || process.env), GH_HOST: githubApiHost(origin.host) },
  }).catch((error) => {
    if (/fast forward|diverge|non-fast/i.test(error.message || '')) {
      throw new ServerError(
        `The ${origin.fullName} fork has commits that cannot be fast-forwarded from ${upstream.fullName}. Reconcile those commits on GitHub before syncing.`,
        { status: 409, code: 'FORK_DIVERGED' },
      );
    }
    throw new ServerError(`Could not sync the app fork: ${error.message}`, { status: 502, code: 'FORK_SYNC_FAILED' });
  });
  return {
    synced: true,
    alreadyUpToDate: /up to date/i.test(output),
    fullName: origin.fullName,
    source: upstream.fullName,
    branch,
    message: output.trim(),
  };
}
