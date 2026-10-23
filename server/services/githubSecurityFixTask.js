/**
 * The `security-fix` lane for the GitHub notifications inbox: a security alert
 * in a repo of yours that no PortOS app manages, or a global advisory that
 * names no single repo, queues one CoS task that clones the repo into a scratch
 * directory, fixes the alerts, opens a pull request and merges it when checks
 * pass. A managed app's alerts go to its own `dependency-updates` lane instead.
 *
 * The prompt carries only values the forge and the account config vouch for:
 * the account's host and login, a repo name matching REPO_RE and GHSA ids
 * matching their fixed format. No notification title or body reaches it.
 */
import { GHSA_RE } from '../lib/githubNotificationParse.js';
import { addTask } from './cosTaskStore.js';

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

const SCRATCH_STEPS = (cloneTarget) => [
  `Clone it into a new scratch directory outside the PortOS checkout you start in: \`dir=$(mktemp -d) && gh repo clone ${cloneTarget} "$dir/repo"\`. Make every change in that clone; never edit, commit or push anything in the PortOS checkout.`,
  'If Dependabot already opened a pull request that fixes an alert (author login exactly `dependabot[bot]`, head branch in this same repo, not a fork) and its checks pass, merge that pull request instead of writing your own. Never merge any other pull request you did not open.',
  'Otherwise update each vulnerable dependency to a patched version (lockfiles included), run the repo\'s tests, and open one pull request from a new branch with all the fixes.',
  'Wait for the checks. When they pass, squash-merge the pull request. If a fix needs a breaking upgrade you cannot make safely, or a check fails for a reason you cannot fix, leave the pull request open and say why in it.',
  'Delete the scratch directory when you are done.',
];

function buildPrompt({ host, login, repo, advisories }) {
  const gh = `gh api --hostname ${host}`;
  const as = login ? ` gh is signed in as ${login} on ${host}.` : '';
  if (repo) {
    const steps = [
      `List the open Dependabot alerts: \`${gh} "repos/${repo}/dependabot/alerts?state=open&per_page=100"\`. If there are none, stop and report that.`,
      ...SCRATCH_STEPS(host === 'github.com' ? repo : `${host}/${repo}`),
    ];
    return [
      `Fix the open security alerts in ${host}/${repo}`,
      '',
      `GitHub reported security vulnerabilities in the dependencies of ${repo}, a repository of yours that no PortOS app manages.${as}`,
      '',
      ...steps.map((step, index) => `${index + 1}. ${step}`),
      '',
      'Finish by reporting each pull request link and any alert you could not fix.',
    ].join('\n');
  }
  const ids = advisories.join(', ');
  const select = advisories.map((id) => `.security_advisory.ghsa_id == "${id}"`).join(' or ');
  const steps = [
    `Find the repositories these advisories affect: list your repositories with \`${gh} "user/repos?affiliation=owner&per_page=100" --paginate --jq '.[] | select(.archived | not) | .full_name'\`, then for each one \`${gh} "repos/<repo>/dependabot/alerts?state=open&per_page=100" --jq '[.[] | select(${select})] | length'\`. Skip a repo whose alerts are not readable. If none is affected, stop and report that.`,
    'For each affected repository, in turn:',
    ...SCRATCH_STEPS(host === 'github.com' ? '<repo>' : `${host}/<repo>`).map((step) => `   - ${step}`),
  ];
  return [
    `Fix security advisories ${ids} across your ${host} repositories`,
    '',
    `GitHub reported that ${advisories.length === 1 ? 'a security advisory affects' : 'security advisories affect'} at least one of your repositories: ${ids}.${as}`,
    '',
    ...steps.map((step, index) => (step.startsWith('   ') ? step : `${index + 1}. ${step}`)),
    '',
    'Finish by reporting each pull request link and any affected repository you could not fix.',
  ].join('\n');
}

/**
 * Queue one security-fix run for a repo (`repo`) or for a set of global
 * advisories (`advisories`), optionally pinned to a provider/model/effort. Returns `{ taskId }`, `{ duplicate: true, taskId }`
 * when the same run is already queued or running, or `{ error }`.
 */
export async function queueSecurityFixTask({ account, repo = null, advisories = [], origin = 'automation', provider, model, effort }) {
  if (!HOST_RE.test(account?.host || '')) return { error: 'Invalid account host' };
  const login = LOGIN_RE.test(account.login || '') ? account.login : null;
  if (repo !== null && !REPO_RE.test(repo)) return { error: 'Invalid repository name' };
  const ids = [...new Set(advisories.filter((id) => GHSA_RE.test(id)))].sort();
  if (!repo && !ids.length) return { error: 'No repository or advisory to fix' };
  const task = await addTask({
    description: buildPrompt({ host: account.host, login, repo, advisories: ids }),
    priority: 'HIGH',
    provider, model, effort,
    // The deliverable is a pull request on another repo, made from a scratch
    // clone during the run: no PortOS worktree, and a clean PortOS tree is success.
    useWorktree: false,
    openPR: false,
    worktreeChangesExpected: false,
    metadata: { externalRepositoryOutput: true, githubSecurityFix: { host: account.host, repo, advisories: ids, origin } },
  }, 'user');
  if (!task?.id) return { error: 'The task could not be queued' };
  return task.duplicate ? { duplicate: true, taskId: task.id } : { taskId: task.id };
}
