import { describe, it, expect, vi, beforeEach } from 'vitest';

// gitRemote is the ONLY effectful dependency of the async resolvers below, so
// mocking it lets `resolveAppForgeTarget` run its real composition (tracker
// resolution + forge-target pin) rather than a re-implementation.
vi.mock('./gitRemote.js', () => ({
  getOriginInfo: vi.fn(async () => null),
  readOriginRemoteUrl: vi.fn(async () => null),
}));

import { getOriginInfo, readOriginRemoteUrl } from './gitRemote.js';
import { resolveAppForgeTarget } from './workTracker.js';
import {
  WORK_TRACKERS,
  CONCRETE_WORK_TRACKERS,
  DEFAULT_WORK_TRACKER,
  workTrackerLabel,
  hostToWorkTracker,
  isGithubHost,
  githubRepoSpec,
  githubApiHost,
  forgeCliForTracker,
  isFileTracker,
  trackerToClaimTaskType,
  resolveWorkTracker,
  hostFromOriginUrl,
} from './workTracker.js';

describe('workTracker constants', () => {
  it('auto is the default and the only non-concrete value', () => {
    expect(DEFAULT_WORK_TRACKER).toBe('auto');
    expect(WORK_TRACKERS).toContain('auto');
    expect(CONCRETE_WORK_TRACKERS).not.toContain('auto');
    expect(WORK_TRACKERS).toEqual(['auto', ...CONCRETE_WORK_TRACKERS]);
  });
});

describe('hostToWorkTracker', () => {
  it('maps github hosts (incl. enterprise) to github', () => {
    expect(hostToWorkTracker('github.com')).toBe('github');
    expect(hostToWorkTracker('GitHub.com')).toBe('github');
    expect(hostToWorkTracker('github.mycorp.com')).toBe('github');
  });
  it('maps gitlab hosts (incl. self-hosted) to gitlab', () => {
    expect(hostToWorkTracker('gitlab.com')).toBe('gitlab');
    expect(hostToWorkTracker('gitlab.example.com')).toBe('gitlab');
  });
  it('returns null for unknown / empty hosts', () => {
    expect(hostToWorkTracker('bitbucket.org')).toBeNull();
    expect(hostToWorkTracker('')).toBeNull();
    expect(hostToWorkTracker(null)).toBeNull();
    expect(hostToWorkTracker(undefined)).toBeNull();
  });
});

describe('isGithubHost', () => {
  it('is true for github.com AND enterprise github.* hosts', () => {
    expect(isGithubHost('github.com')).toBe(true);
    expect(isGithubHost('GitHub.com')).toBe(true);
    expect(isGithubHost('github.mycorp.com')).toBe(true);
    expect(isGithubHost('github.acme.example')).toBe(true);
  });
  it('is false for gitlab, other forges, and empty/invalid hosts', () => {
    expect(isGithubHost('gitlab.com')).toBe(false);
    expect(isGithubHost('gitlab.example.com')).toBe(false);
    expect(isGithubHost('bitbucket.org')).toBe(false);
    expect(isGithubHost('')).toBe(false);
    expect(isGithubHost(null)).toBe(false);
    expect(isGithubHost(undefined)).toBe(false);
  });
});

describe('githubRepoSpec', () => {
  it('builds a host-qualified selector for github.com and enterprise hosts', () => {
    expect(githubRepoSpec({ host: 'github.com', fullName: 'atomantic/PortOS' }))
      .toBe('github.com/atomantic/PortOS');
    expect(githubRepoSpec({ host: 'github.acme.example', fullName: 'acme/app' }))
      .toBe('github.acme.example/acme/app');
  });
  it('canonicalizes only the documented github.com SSH-over-443 alias', () => {
    // git@ssh.github.com:443/owner/repo → getOriginInfo host 'ssh.github.com';
    // gh --repo reads the HOST/ prefix as the API host, so it must be github.com.
    expect(githubRepoSpec({ host: 'ssh.github.com', fullName: 'atomantic/PortOS' }))
      .toBe('github.com/atomantic/PortOS');
    expect(githubRepoSpec({ host: 'SSH.GitHub.com', fullName: 'atomantic/PortOS' }))
      .toBe('github.com/atomantic/PortOS');
  });
  it('preserves a genuine enterprise host that legitimately begins with ssh.', () => {
    // Not the documented alias — its real API host IS ssh.github.acme.example,
    // so stripping ssh. would misroute to a different/nonexistent server.
    expect(githubRepoSpec({ host: 'ssh.github.acme.example', fullName: 'acme/app' }))
      .toBe('ssh.github.acme.example/acme/app');
  });
  it('returns null for a non-GitHub host, a missing owner/repo, or no origin', () => {
    expect(githubRepoSpec({ host: 'gitlab.com', fullName: 'group/proj' })).toBeNull();
    expect(githubRepoSpec({ host: 'bitbucket.org', fullName: 'team/proj' })).toBeNull();
    expect(githubRepoSpec({ host: 'github.com', fullName: null })).toBeNull();
    expect(githubRepoSpec({ host: null, fullName: null })).toBeNull();
    expect(githubRepoSpec(null)).toBeNull();
  });
});

describe('githubApiHost', () => {
  it('canonicalizes the documented github.com SSH-over-443 alias to github.com (#2650)', () => {
    // prWatcher hands this host to getSelfLogin's `gh --hostname`; a raw
    // ssh.github.com would query the SSH endpoint and always return null,
    // wedging every self/others PR gate into self-login-unavailable.
    expect(githubApiHost('ssh.github.com')).toBe('github.com');
    expect(githubApiHost('SSH.GitHub.com')).toBe('github.com');
  });
  it('passes github.com and enterprise hosts (including a genuine ssh.* one) through unchanged', () => {
    expect(githubApiHost('github.com')).toBe('github.com');
    expect(githubApiHost('github.acme.example')).toBe('github.acme.example');
    expect(githubApiHost('ssh.github.acme.example')).toBe('ssh.github.acme.example');
  });
  it('returns null for a falsy host', () => {
    expect(githubApiHost(null)).toBeNull();
    expect(githubApiHost(undefined)).toBeNull();
    expect(githubApiHost('')).toBeNull();
  });
});

describe('forgeCliForTracker', () => {
  it('maps forge trackers to their CLI, others to null', () => {
    expect(forgeCliForTracker('github')).toBe('gh');
    expect(forgeCliForTracker('gitlab')).toBe('glab');
    expect(forgeCliForTracker('plan')).toBeNull();
    expect(forgeCliForTracker('jira')).toBeNull();
    expect(forgeCliForTracker('auto')).toBeNull();
  });
});

describe('isFileTracker', () => {
  it('is true only for trackers whose work product is a repo file (#3102)', () => {
    // PLAN.md work lands as a committed file → a run necessarily dirties the tree.
    expect(isFileTracker('plan')).toBe(true);
    // Forge/ticket trackers take the work out-of-band → a clean tree is success.
    expect(isFileTracker('github')).toBe(false);
    expect(isFileTracker('gitlab')).toBe(false);
    expect(isFileTracker('jira')).toBe(false);
  });

  it('treats an unknown/absent tracker as file-based, matching the PLAN.md fallback', () => {
    // formatTrackerInstructions falls back to the PLAN.md block for anything
    // unrecognized, so the flag must agree or it drifts from the prompt.
    expect(isFileTracker('auto')).toBe(true);
    expect(isFileTracker('nonsense')).toBe(true);
    expect(isFileTracker(undefined)).toBe(true);
    expect(isFileTracker(null)).toBe(true);
  });
});

describe('trackerToClaimTaskType', () => {
  it('routes each concrete tracker to its claim prompt task type', () => {
    expect(trackerToClaimTaskType('plan')).toBe('plan-task');
    expect(trackerToClaimTaskType('github')).toBe('claim-issue');
    expect(trackerToClaimTaskType('gitlab')).toBe('claim-issue-gitlab');
    expect(trackerToClaimTaskType('jira')).toBe('claim-issue-jira');
    expect(trackerToClaimTaskType('auto')).toBeNull();
    expect(trackerToClaimTaskType('nonsense')).toBeNull();
  });
});

describe('resolveWorkTracker (pure)', () => {
  it('honors an explicit concrete choice regardless of host', () => {
    expect(resolveWorkTracker({ configured: 'jira', host: 'github.com' }))
      .toEqual({ configured: 'jira', resolved: 'jira', source: 'configured' });
    expect(resolveWorkTracker({ configured: 'plan', host: 'gitlab.com' }))
      .toEqual({ configured: 'plan', resolved: 'plan', source: 'configured' });
  });

  it('auto resolves from the origin host', () => {
    expect(resolveWorkTracker({ configured: 'auto', host: 'github.com' }))
      .toEqual({ configured: 'auto', resolved: 'github', source: 'origin' });
    expect(resolveWorkTracker({ configured: 'auto', host: 'gitlab.example.com' }))
      .toEqual({ configured: 'auto', resolved: 'gitlab', source: 'origin' });
  });

  it('auto with an unrecognized / missing host falls back to PLAN.md', () => {
    expect(resolveWorkTracker({ configured: 'auto', host: 'bitbucket.org' }))
      .toEqual({ configured: 'auto', resolved: 'plan', source: 'fallback' });
    expect(resolveWorkTracker({ configured: 'auto', host: null }))
      .toEqual({ configured: 'auto', resolved: 'plan', source: 'fallback' });
  });

  it('treats absent / invalid configured values as auto', () => {
    expect(resolveWorkTracker({ host: 'github.com' }).resolved).toBe('github');
    expect(resolveWorkTracker({ configured: 'garbage', host: 'gitlab.com' }))
      .toEqual({ configured: 'auto', resolved: 'gitlab', source: 'origin' });
    expect(resolveWorkTracker({}).resolved).toBe('plan');
  });
});

describe('hostFromOriginUrl', () => {
  it('extracts the host from standard owner/repo remotes (ssh, scp, https)', () => {
    expect(hostFromOriginUrl('git@github.com:atomantic/PortOS.git')).toBe('github.com');
    expect(hostFromOriginUrl('https://github.com/atomantic/PortOS.git')).toBe('github.com');
    expect(hostFromOriginUrl('ssh://git@github.com:22/atomantic/PortOS.git')).toBe('github.com');
  });

  it('resolves the host for GitLab subgroup remotes across every URL form', () => {
    // owner/repo-only parsers reject these; host extraction must still surface
    // the host so auto → GitLab (not PLAN.md). Covers scp, https, and ssh://.
    expect(hostFromOriginUrl('git@gitlab.com:group/subgroup/repo.git')).toBe('gitlab.com');
    expect(hostFromOriginUrl('https://gitlab.example.com/group/sub/deep/repo.git')).toBe('gitlab.example.com');
    expect(hostFromOriginUrl('ssh://git@gitlab.com/group/subgroup/repo.git')).toBe('gitlab.com');
    expect(hostFromOriginUrl('ssh://git@gitlab.com:2222/group/subgroup/repo.git')).toBe('gitlab.com');
  });

  it('returns null for empty / unparseable input', () => {
    expect(hostFromOriginUrl('')).toBeNull();
    expect(hostFromOriginUrl(null)).toBeNull();
    expect(hostFromOriginUrl('not a url')).toBeNull();
  });

  it('strips embedded credentials so a PAT never surfaces as the host', () => {
    // A token in an https remote must not leak through the host field — even on
    // the subgroup fallback path where the strict parser bails. The host must be
    // clean AND correct (so auto still resolves to GitLab).
    expect(hostFromOriginUrl('https://oauth2:TOKEN@gitlab.com/group/sub/repo.git')).toBe('gitlab.com');
    expect(hostFromOriginUrl('https://user:pat@github.com/owner/repo.git')).toBe('github.com');
    // SCP-style git@host carries only an ssh user (no secret) — host unaffected.
    expect(hostFromOriginUrl('git@gitlab.com:group/sub/repo.git')).toBe('gitlab.com');
  });

  it('a subgroup GitLab remote resolves to the gitlab tracker end-to-end', () => {
    const host = hostFromOriginUrl('git@gitlab.com:group/subgroup/repo.git');
    expect(resolveWorkTracker({ configured: 'auto', host }).resolved).toBe('gitlab');
  });
});

describe('workTrackerLabel', () => {
  it('returns a human label for every value, falling back to the raw value', () => {
    for (const t of WORK_TRACKERS) {
      expect(typeof workTrackerLabel(t)).toBe('string');
      expect(workTrackerLabel(t).length).toBeGreaterThan(0);
    }
    expect(workTrackerLabel('github')).toBe('GitHub Issues');
    expect(workTrackerLabel('unmapped-value')).toBe('unmapped-value');
  });
});

// The composed helper exists so no caller has to remember to thread the pin
// through by hand — the failure mode it prevents (issue #3767) is invisible on
// an ordinary github.com/gitlab.com origin and only bites self-hosted hosts.
describe('resolveAppForgeTarget', () => {
  const CUSTOM = { host: 'git.example-corp.com', fullName: 'acme/widget', url: 'git@git.example-corp.com:acme/widget.git' };

  const useOrigin = ({ host, fullName, url, isGithub = false }) => {
    getOriginInfo.mockResolvedValue({ isGithub, host, fullName });
    readOriginRemoteUrl.mockResolvedValue(url);
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useOrigin({ host: 'github.com', fullName: 'acme/widget', url: 'git@github.com:acme/widget.git', isGithub: true });
  });

  it('resolves an auto-tracked github.com app the same as the two-step call', async () => {
    const { tracker, target } = await resolveAppForgeTarget({ repoPath: '/repo', workTracker: 'auto' });
    expect(tracker).toBe('github');
    expect(target).toMatchObject({ forge: 'github', fullName: 'acme/widget', repoSpec: 'github.com/acme/widget' });
  });

  it('honors a github pin on a custom-hostname enterprise origin the host regex misses', async () => {
    useOrigin(CUSTOM);
    // Without the pin this origin is "not a forge" — the whole point of the helper.
    const { tracker, target } = await resolveAppForgeTarget({ repoPath: '/repo', workTracker: 'github' });
    expect(tracker).toBe('github');
    expect(target).toMatchObject({
      forge: 'github',
      fullName: 'acme/widget',
      repoSpec: 'git.example-corp.com/acme/widget',
      apiHost: 'git.example-corp.com',
    });
  });

  it('honors a gitlab pin on a custom-hostname self-hosted origin', async () => {
    useOrigin(CUSTOM);
    const { tracker, target } = await resolveAppForgeTarget({ repoPath: '/repo', workTracker: 'gitlab' });
    expect(tracker).toBe('gitlab');
    // `glab` targets the project from its cwd, so there is no repoSpec.
    expect(target).toMatchObject({ forge: 'gitlab', repoSpec: null });
  });

  it('passes NO pin for a plan/jira tracker, so a custom host stays unresolved', async () => {
    useOrigin(CUSTOM);
    for (const workTracker of ['plan', 'jira']) {
      const { tracker, target } = await resolveAppForgeTarget({ repoPath: '/repo', workTracker });
      expect(tracker).toBe(workTracker);
      expect(target).toBeNull();
    }
  });

  it('still resolves the forge target for a plan/jira app on a real forge origin (caller gates on tracker)', async () => {
    const { tracker, target } = await resolveAppForgeTarget({ repoPath: '/repo', workTracker: 'jira' });
    expect(tracker).toBe('jira');
    expect(target).toMatchObject({ forge: 'github' });
  });

  it('takes the pin from the app but scans the repoPath override', async () => {
    useOrigin(CUSTOM);
    await resolveAppForgeTarget({ repoPath: '/app-repo', workTracker: 'github' }, { repoPath: '/scanned-repo' });
    expect(getOriginInfo).toHaveBeenCalledWith('/scanned-repo');
    // The tracker read still comes from the app record's own checkout.
    expect(readOriginRemoteUrl).toHaveBeenCalledWith('/app-repo');
  });

  it('degrades to plan + null target when the app has no repo at all', async () => {
    const { tracker, target } = await resolveAppForgeTarget({});
    expect(tracker).toBe('plan');
    expect(target).toBeNull();
  });
});
