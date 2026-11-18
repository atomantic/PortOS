/** Git/GitHub own release activity. Historical recovery metadata is not a lock. */
import { execGit } from '../lib/execGit.js';
import { getOriginInfo } from '../lib/gitRemote.js';
import { currentTaskTypeName } from '../lib/taskTypeRenames.js';
import { execGh } from './github.js';
import { resolveForgeExecOptions } from './forgeExecOptions.js';

const releaseTypes = new Set(['do-release', 'release-sync']);
const unfinished = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const repository = agent => agent.sourceWorkspace || agent.metadata?.sourceWorkspace || agent.workspacePath || agent.metadata?.workspacePath;
const commonDirectory = async cwd => (await execGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)).stdout.trim();

const HOLD_DESCRIPTIONS = {
  'release-repository-unavailable': 'the release repository could not be resolved',
  'release-forge-unavailable': 'the repository has no readable GitHub origin',
  'release-ownership-unavailable': 'CoS agent ownership could not be verified',
  'release-agent-active': 'another release or release-sync agent is running in this repository',
  'release-promotion-active': 'a pull request targeting the release branch is still open',
  'release-tag-present': 'the proposed version is already tagged',
  'release-workflow-active': 'a release.yml workflow run is unfinished',
  'release-preflight-unavailable': 'publication activity could not be read from Git or GitHub',
};

/** One log-ready sentence naming a refusal and what clears it; dispatch retries on its own. */
export function describeReleasePreflightHold({ reason, detail } = {}) {
  const description = HOLD_DESCRIPTIONS[reason] || 'release pre-flight refused';
  return `${reason}: ${description}${detail ? ` (${detail})` : ''}`;
}

/** Called at dispatch and again when reserving a candidate. Read failures refuse
 * this attempt; they never persist a hold requiring an operator to retire it.
 * Only an explicitly proposed `version` is checked against existing tags: the
 * development head's package.json carries the version that was last published
 * (release synchronization lands it on main), so before the coordinator chooses
 * the next version that tag is expected to exist (#16177). */
export async function releasePreflight({ repoPath, agentId, agents, version, forgeAccount = null }) {
  if (!repoPath) return { ok: false, reason: 'release-repository-unavailable' };
  const common = await commonDirectory(repoPath);
  const origin = await getOriginInfo(repoPath);
  if (!origin.isGithub || !origin.fullName) return { ok: false, reason: 'release-forge-unavailable' };
  if (!agents) {
    const { readClaimOwnershipAgents } = await import('./cosClaimOwnershipState.js');
    agents = await readClaimOwnershipAgents();
  }
  if (!agents) return { ok: false, reason: 'release-ownership-unavailable' };
  const { getActiveAgentIds } = await import('./agent/agentState.js');
  const active = new Set(getActiveAgentIds());
  if ([...active].some(id => id !== agentId && !agents.some(agent => agent.id === id))) {
    return { ok: false, reason: 'release-ownership-unavailable' };
  }
  for (const agent of agents) {
    if (agent.id === agentId || !releaseTypes.has(currentTaskTypeName(agent.metadata?.taskAnalysisType || agent.metadata?.analysisType))
      || (agent.status === 'completed' && !active.has(agent.id))) continue;
    const path = repository(agent);
    if (!path) return { ok: false, reason: 'release-ownership-unavailable' };
    const other = await getOriginInfo(path);
    if (await commonDirectory(path) === common || (other.host === origin.host && other.fullName?.toLowerCase() === origin.fullName.toLowerCase())) {
      return { ok: false, reason: 'release-agent-active' };
    }
  }
  const options = await resolveForgeExecOptions(repoPath, { forgeAccount });
  const api = async path => JSON.parse(await execGh(['api', '--hostname', origin.host, `repos/${origin.fullName}/${path}`], undefined, options));
  const pulls = await api('pulls?state=open&base=release&per_page=1');
  if (!Array.isArray(pulls)) throw new Error('Invalid release promotion response');
  if (pulls.length) return { ok: false, reason: 'release-promotion-active' };
  if (version !== undefined) {
    if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Invalid proposed release version');
    const tag = `refs/tags/v${version}`;
    const tags = await api(`git/matching-refs/tags/v${version}`);
    if (!Array.isArray(tags)) throw new Error('Invalid release tag response');
    if (tags.some(row => row.ref === tag)) return { ok: false, reason: 'release-tag-present' };
  }
  // Status queries cover old workflow re-runs too, regardless of creation order.
  for (const status of unfinished) {
    const runs = await api(`actions/workflows/release.yml/runs?status=${status}&per_page=1`);
    if (!Number.isSafeInteger(runs.total_count) || runs.total_count < 0) throw new Error('Invalid release workflow response');
    if (runs.total_count) return { ok: false, reason: 'release-workflow-active' };
  }
  return { ok: true };
}
